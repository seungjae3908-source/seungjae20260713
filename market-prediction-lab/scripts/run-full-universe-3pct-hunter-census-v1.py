#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import pandas as pd
import polars as pl
from huggingface_hub import hf_hub_download, snapshot_download

START = pd.Timestamp("2023-06-01", tz="UTC")
END_EXCLUSIVE = pd.Timestamp("2026-06-01", tz="UTC")
THRESHOLDS = [0.03, 0.05, 0.10, 0.20, 0.50, 1.00]
STOCK_DATASET = "Ngseo/zi-gemini"
CRYPTO_DATASET = "rogerdehe/klines-binance"

def pct(x):
    return None if x is None else float(x)

def normalize_stock_frame(exchange: str) -> pl.DataFrame:
    file = hf_hub_download(
        repo_id=STOCK_DATASET,
        repo_type="dataset",
        filename=f"data/{exchange}/eod.parquet",
    )
    return (
        pl.scan_parquet(file)
        .filter((pl.col("date") >= pl.lit(START.date())) & (pl.col("date") < pl.lit(END_EXCLUSIVE.date())))
        .select([
            pl.col("code").cast(pl.Utf8).alias("symbol"),
            pl.col("date").cast(pl.Date).alias("date"),
            pl.col("open").cast(pl.Float64),
            pl.col("high").cast(pl.Float64),
            pl.col("low").cast(pl.Float64),
            pl.col("close").cast(pl.Float64),
            pl.col("volume").cast(pl.Float64),
        ])
        .filter(
            (pl.col("open") > 0) & (pl.col("high") > 0) &
            (pl.col("low") > 0) & (pl.col("close") > 0) &
            (pl.col("high") >= pl.max_horizontal("open", "close")) &
            (pl.col("low") <= pl.min_horizontal("open", "close"))
        )
        .collect()
    )

def load_us() -> pl.DataFrame:
    return normalize_stock_frame("US")

def load_kr() -> pl.DataFrame:
    return pl.concat([normalize_stock_frame("KO"), normalize_stock_frame("KQ")], how="vertical")

def load_crypto(market: str) -> pl.DataFrame:
    pattern = "spot/1d/*.parquet" if market == "CRYPTO_SPOT" else "futures/1d/*.parquet"
    root = Path(snapshot_download(
        repo_id=CRYPTO_DATASET,
        repo_type="dataset",
        allow_patterns=[pattern, "coverage.csv"],
    ))
    folder = root / ("spot/1d" if market == "CRYPTO_SPOT" else "futures/1d")
    rows = []
    for idx, file in enumerate(sorted(folder.glob("*.parquet")), 1):
        name = file.stem
        if name.endswith("-mark") or name.endswith("-funding_rate") or name.endswith("-index"):
            continue
        symbol = name.replace("_USDT_USDT", "USDT").replace("_USDT", "USDT")
        try:
            df = (
                pl.scan_parquet(file)
                .filter((pl.col("date") >= pl.lit(START.to_pydatetime())) & (pl.col("date") < pl.lit(END_EXCLUSIVE.to_pydatetime())))
                .select([
                    pl.lit(symbol).alias("symbol"),
                    pl.col("date").dt.date().alias("date"),
                    pl.col("open").cast(pl.Float64),
                    pl.col("high").cast(pl.Float64),
                    pl.col("low").cast(pl.Float64),
                    pl.col("close").cast(pl.Float64),
                    pl.col("volume").cast(pl.Float64),
                ])
                .filter(
                    (pl.col("open") > 0) & (pl.col("high") > 0) &
                    (pl.col("low") > 0) & (pl.col("close") > 0)
                )
                .collect()
            )
            if df.height:
                rows.append(df)
        except Exception as exc:
            print(json.dumps({"cryptoReadFailure": str(file), "error": str(exc)[:180]}), flush=True)
        if idx % 100 == 0:
            print(json.dumps({"market": market, "files": idx, "usableFiles": len(rows)}), flush=True)
    if not rows:
        raise RuntimeError(f"{market}_NO_DATA")
    return pl.concat(rows, how="vertical")

def add_features(df: pl.DataFrame, market: str) -> pl.DataFrame:
    df = df.sort(["symbol", "date"])
    # Features below are known by today's open except current-day OHLC-derived opportunity labels.
    df = df.with_columns([
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("close").shift(2).over("symbol").alias("prev2_close"),
        pl.col("volume").shift(1).over("symbol").alias("prev_volume"),
        pl.col("volume").shift(2).over("symbol").alias("prev2_volume"),
        pl.col("high").shift(1).rolling_max(window_size=20, min_samples=5).over("symbol").alias("prior_high20"),
        pl.col("low").shift(1).rolling_min(window_size=20, min_samples=5).over("symbol").alias("prior_low20"),
        pl.col("close").shift(1).rolling_mean(window_size=20, min_samples=5).over("symbol").alias("prior_close_ma20"),
        pl.col("volume").shift(1).rolling_mean(window_size=20, min_samples=5).over("symbol").alias("prior_volume_ma20"),
        (pl.col("close").shift(1) * pl.col("volume").shift(1))
            .rolling_mean(window_size=20, min_samples=5).over("symbol").alias("prior_dollar_volume20"),
    ])
    df = df.with_columns([
        (pl.col("open") / pl.col("prev_close") - 1.0).alias("gap"),
        (pl.col("close").shift(1).over("symbol") / pl.col("close").shift(6).over("symbol") - 1.0).alias("ret5_prev"),
        (pl.col("close").shift(1).over("symbol") / pl.col("close").shift(21).over("symbol") - 1.0).alias("ret20_prev"),
        (pl.col("prev_volume") / pl.col("prior_volume_ma20")).alias("prior_rvol"),
        (pl.col("prev_close") / pl.col("prior_high20") - 1.0).alias("distance_prior_high20"),
        (pl.col("high") / pl.col("open") - 1.0).alias("long_move_from_open"),
        (pl.col("close") / pl.col("prev_close") - 1.0).alias("close_to_close_return"),
    ])
    if market == "CRYPTO_FUTURES":
        df = df.with_columns((1.0 - pl.col("low") / pl.col("open")).alias("short_move_from_open"))
    else:
        df = df.with_columns(pl.lit(None, dtype=pl.Float64).alias("short_move_from_open"))
    return df

def opportunity_rows(df: pl.DataFrame, market: str) -> pl.DataFrame:
    long_rows = (
        df.filter(pl.col("long_move_from_open") >= 0.03)
        .select([
            pl.lit(market).alias("market"),
            "date", "symbol",
            pl.lit("LONG").alias("direction"),
            pl.col("long_move_from_open").alias("max_move"),
            "close_to_close_return", "gap", "ret5_prev", "ret20_prev", "prior_rvol",
            "distance_prior_high20", "prior_dollar_volume20", "open", "high", "low", "close", "volume",
        ])
    )
    if market != "CRYPTO_FUTURES":
        return long_rows
    short_rows = (
        df.filter(pl.col("short_move_from_open") >= 0.03)
        .select([
            pl.lit(market).alias("market"),
            "date", "symbol",
            pl.lit("SHORT").alias("direction"),
            pl.col("short_move_from_open").alias("max_move"),
            "close_to_close_return", "gap", "ret5_prev", "ret20_prev", "prior_rvol",
            "distance_prior_high20", "prior_dollar_volume20", "open", "high", "low", "close", "volume",
        ])
    )
    return pl.concat([long_rows, short_rows], how="vertical")

def market_summary(raw: pl.DataFrame, opp: pl.DataFrame, market: str) -> dict:
    dates = raw.select("date").unique().height
    symbols = raw.select("symbol").unique().height
    out = {
        "market": market,
        "period": {"start": str(START.date()), "endExclusive": str(END_EXCLUSIVE.date())},
        "rawRows": raw.height,
        "symbolsWithAnyData": symbols,
        "tradingDates": dates,
        "opportunities": {},
    }
    for t in THRESHOLDS:
        rows = opp.filter(pl.col("max_move") >= t)
        out["opportunities"][f"{int(t*100)}pct"] = {
            "count": rows.height,
            "distinctSymbols": rows.select("symbol").unique().height,
            "activeDates": rows.select("date").unique().height,
            "averagePerMarketDay": rows.height / max(dates, 1),
        }
    return out

def causal_pressure_baseline(raw: pl.DataFrame, market: str, top_n: int) -> dict:
    # This is intentionally a broad causal pre-open baseline, NOT the final strategy.
    # It is used only to measure whether prior-day/gap information can pre-capture later movers.
    direction_long = True
    x = raw.filter(
        pl.col("prev_close").is_not_null() &
        pl.col("prior_dollar_volume20").is_not_null() &
        pl.col("prior_rvol").is_not_null()
    )
    # cross-sectional percentile ranks per date avoid market-scale dependence.
    x = x.with_columns([
        pl.col("gap").rank("average", descending=True).over("date").alias("gap_rank"),
        pl.col("prior_rvol").rank("average", descending=True).over("date").alias("rvol_rank"),
        pl.col("ret5_prev").rank("average", descending=True).over("date").alias("ret5_rank"),
        pl.col("prior_dollar_volume20").rank("average", descending=True).over("date").alias("liq_rank"),
        pl.col("distance_prior_high20").rank("average", descending=True).over("date").alias("near_high_rank"),
    ])
    x = x.with_columns(
        (
            -pl.col("gap_rank")
            -pl.col("rvol_rank")
            -pl.col("ret5_rank")
            -pl.col("liq_rank")
            -pl.col("near_high_rank")
        ).alias("score")
    )
    picks = (
        x.sort(["date", "score"], descending=[False, True])
        .group_by("date", maintain_order=True)
        .head(top_n)
    )
    long_hits = picks.filter(pl.col("long_move_from_open") >= 0.03).height
    total_long_opp = x.filter(pl.col("long_move_from_open") >= 0.03).height
    result = {
        "topNPerDate": top_n,
        "selectedRows": picks.height,
        "long3pctHits": long_hits,
        "long3pctUniverseOpportunities": total_long_opp,
        "long3pctRecall": long_hits / max(total_long_opp, 1),
        "precisionAmongSelected": long_hits / max(picks.height, 1),
    }
    if market == "CRYPTO_FUTURES":
        # Symmetric short pre-capture diagnostic with negative gap/momentum ranks.
        s = x.with_columns([
            (-pl.col("gap")).rank("average", descending=True).over("date").alias("sgap_rank"),
            (-pl.col("ret5_prev")).rank("average", descending=True).over("date").alias("sret_rank"),
        ]).with_columns(
            (-pl.col("sgap_rank") - pl.col("rvol_rank") - pl.col("sret_rank") - pl.col("liq_rank")).alias("short_score")
        )
        sp = s.sort(["date", "short_score"], descending=[False, True]).group_by("date", maintain_order=True).head(top_n)
        sh = sp.filter(pl.col("short_move_from_open") >= 0.03).height
        st = s.filter(pl.col("short_move_from_open") >= 0.03).height
        result.update({
            "short3pctHits": sh,
            "short3pctUniverseOpportunities": st,
            "short3pctRecall": sh / max(st, 1),
            "shortPrecisionAmongSelected": sh / max(sp.height, 1),
        })
    return result

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default="market-prediction-lab/docs/full-universe-3pct-hunter-v1")
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    loaders = {
        "US_STOCK": load_us,
        "KR_STOCK": load_kr,
        "CRYPTO_SPOT": lambda: load_crypto("CRYPTO_SPOT"),
        "CRYPTO_FUTURES": lambda: load_crypto("CRYPTO_FUTURES"),
    }

    summaries = {}
    opp_frames = []
    daily_frames = []

    for market, loader in loaders.items():
        print(json.dumps({"marketStart": market}), flush=True)
        raw = add_features(loader(), market)
        opp = opportunity_rows(raw, market)
        summary = market_summary(raw, opp, market)
        summary["causalBaselineTop20"] = causal_pressure_baseline(raw, market, 20)
        summary["causalBaselineTop50"] = causal_pressure_baseline(raw, market, 50)
        summaries[market] = summary
        opp_frames.append(opp)

        daily = (
            opp.group_by(["market", "date", "direction"])
            .agg([
                pl.len().alias("opportunities3pct"),
                pl.col("max_move").max().alias("maxMove"),
                pl.col("max_move").mean().alias("meanMove"),
                (pl.col("max_move") >= 0.05).sum().alias("count5pct"),
                (pl.col("max_move") >= 0.10).sum().alias("count10pct"),
                (pl.col("max_move") >= 0.20).sum().alias("count20pct"),
                (pl.col("max_move") >= 0.50).sum().alias("count50pct"),
                (pl.col("max_move") >= 1.00).sum().alias("count100pct"),
            ])
            .sort(["date", "market", "direction"])
        )
        daily_frames.append(daily)
        print(json.dumps({"marketDone": market, **summary}), flush=True)

    all_opp = pl.concat(opp_frames, how="vertical").sort(["date", "market", "max_move"], descending=[False, False, True])
    all_daily = pl.concat(daily_frames, how="vertical").sort(["date", "market", "direction"])
    all_opp.write_parquet(out / "all-opportunities-3pct-plus.parquet", compression="zstd")
    all_opp.write_csv(out / "all-opportunities-3pct-plus.csv")
    all_daily.write_csv(out / "daily-opportunity-counts.csv")
    all_opp.sort("max_move", descending=True).head(5000).write_csv(out / "top-5000-movers.csv")

    report = {
        "schemaVersion": 1,
        "contract": "full-universe-3pct-hunter-census-v1",
        "period": {"start": str(START.date()), "endExclusive": str(END_EXCLUSIVE.date())},
        "definition": {
            "longOpportunity": "daily high / daily open - 1 >= threshold",
            "shortOpportunity": "1 - daily low / daily open >= threshold; futures only",
            "thresholds": [f"{int(t*100)}%" for t in THRESHOLDS],
            "tradeDirectionPolicy": {
                "US_STOCK": "LONG_ONLY",
                "KR_STOCK": "LONG_ONLY",
                "CRYPTO_SPOT": "LONG_ONLY",
                "CRYPTO_FUTURES": "LONG_SHORT",
            },
            "selectionLimitForOpportunityCensus": None,
            "note": "Every observed >=3% opportunity is retained; Top20/Top50 appears only in separate causal pre-capture diagnostics.",
        },
        "sources": {
            "stocks": "Ngseo/zi-gemini EOD parquet",
            "crypto": "rogerdehe/klines-binance 1d parquet",
        },
        "truthBoundary": {
            "dailyMoverCensus": True,
            "intradayTMinusSignalsProven": False,
            "causalBaselineIsFinalStrategy": False,
            "profitabilityProven": False,
            "economicCredit": 0,
            "executionAuthority": "NONE",
        },
        "markets": summaries,
        "totalOpportunityRows3pctPlus": all_opp.height,
    }
    (out / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"FINAL": report}, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
