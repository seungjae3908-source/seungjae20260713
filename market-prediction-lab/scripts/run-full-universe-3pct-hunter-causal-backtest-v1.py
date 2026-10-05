#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl

ROOT = Path(__file__).resolve().parents[2]
CENSUS_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-census-v2.py"
SPEC = importlib.util.spec_from_file_location("full_universe_census_v2", CENSUS_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("CENSUS_IMPORT_FAILED")
census = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(census)

MARKETS = ("US_STOCK", "KR_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES")
COSTS = {
    "US_STOCK": 0.0020,
    "KR_STOCK": 0.0030,
    "CRYPTO_SPOT": 0.0020,
    "CRYPTO_FUTURES": 0.0012,
}
WINDOWS = {
    "US_STOCK": [("1D",1),("1W",5),("1M",21),("3M",63),("6M",126),("1Y",252),("3Y",None)],
    "KR_STOCK": [("1D",1),("1W",5),("1M",21),("3M",63),("6M",126),("1Y",252),("3Y",None)],
    "CRYPTO_SPOT": [("1D",1),("1W",7),("1M",30),("3M",90),("6M",183),("1Y",365),("3Y",None)],
    "CRYPTO_FUTURES": [("1D",1),("1W",7),("1M",30),("3M",90),("6M",183),("1Y",365),("3Y",None)],
}

def load_kr_fast() -> tuple[pl.DataFrame, dict]:
    from pykrx import stock

    dates = pd.date_range(census.START.date(), (census.END_EXCLUSIVE - pd.Timedelta(days=1)).date(), freq="B")

    def fetch_day(dt):
        key = dt.strftime("%Y%m%d")
        last = None
        for attempt in range(4):
            try:
                frame = stock.get_market_ohlcv_by_ticker(key, market="ALL")
                if frame is None or frame.empty:
                    return key, [], None
                frame = frame.reset_index()
                ticker_col = frame.columns[0]
                required = ["시가", "고가", "저가", "종가", "거래량"]
                if not all(col in frame.columns for col in required):
                    return key, [], f"schema:{list(frame.columns)[:12]}"
                rows = []
                for r in frame[[ticker_col, *required]].itertuples(index=False, name=None):
                    sym, o, h, l, close, v = r
                    try:
                        o, h, l, close, v = float(o), float(h), float(l), float(close), float(v)
                    except Exception:
                        continue
                    if min(o, h, l, close) <= 0 or v < 0:
                        continue
                    rows.append((str(sym).zfill(6), dt.date(), o, h, l, close, v))
                return key, rows, None
            except Exception as exc:
                last = exc
                time.sleep(0.8 * (attempt + 1))
        return key, [], str(last)[:180]

    all_rows = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch_day, dt): dt for dt in dates}
        for idx, future in enumerate(concurrent.futures.as_completed(futures), 1):
            key, rows, error = future.result()
            if rows:
                all_rows.extend(rows)
            if error:
                failures.append({"date": key, "error": error})
            if idx % 50 == 0:
                print(json.dumps({
                    "krFastDatesComplete": idx,
                    "rows": len(all_rows),
                    "failures": len(failures),
                }), flush=True)

    if len(all_rows) < 300_000:
        print(json.dumps({
            "krFastFallback": True,
            "rows": len(all_rows),
            "failures": len(failures),
        }), flush=True)
        return census.load_kr()

    return (
        pl.DataFrame(
            all_rows,
            schema=["symbol","date","open","high","low","close","volume"],
            orient="row",
        ),
        {
            "provider": "pykrx/KRX",
            "coverageMode": "DAILY_ALL_MARKET_KOSPI_KOSDAQ_KONEX_PARALLEL4",
            "failedBusinessDates": len(failures),
            "failurePreview": failures[:10],
        },
    )


def add_preopen_features(df: pl.DataFrame) -> pl.DataFrame:
    x = df.sort(["symbol","date"])
    x = x.with_columns([
        pl.col("high").shift(1).over("symbol").alias("prev_high"),
        pl.col("low").shift(1).over("symbol").alias("prev_low"),
        pl.col("close").shift(2).over("symbol").alias("close_2ago"),
        pl.col("low").shift(1).rolling_min(window_size=20, min_samples=5).over("symbol").alias("prior_low20"),
    ])
    x = x.with_columns([
        pl.max_horizontal(
            (pl.col("prev_high") - pl.col("prev_low")).abs(),
            (pl.col("prev_high") - pl.col("close_2ago")).abs(),
            (pl.col("prev_low") - pl.col("close_2ago")).abs(),
        ).alias("prev_true_range"),
        ((pl.col("prev_high") - pl.col("prev_low")) / pl.col("prev_close")).alias("prev_range_pct"),
        (pl.col("prev_close") / pl.col("prior_low20") - 1.0).alias("distance_prior_low20"),
    ])
    x = x.with_columns(
        pl.col("prev_true_range")
        .rolling_mean(window_size=14, min_samples=10)
        .over("symbol")
        .truediv(pl.col("prev_close"))
        .alias("prior_atr_pct")
    )
    return x

def tradable_mask(market: str) -> pl.Expr:
    common = (
        pl.col("ret5_prev").is_not_null()
        & pl.col("ret20_prev").is_not_null()
        & pl.col("prior_rvol").is_not_null()
        & pl.col("prior_atr_pct").is_not_null()
        & pl.col("prior_dollar_volume20").is_not_null()
    )
    if market == "US_STOCK":
        return (
            common
            & ~pl.col("symbol").str.contains(r"^(ZVZZ|ZWZZ)")
            & (pl.col("open") >= 2.0)
            & (pl.col("prior_dollar_volume20") >= 10_000_000)
        )
    if market == "KR_STOCK":
        return common & (pl.col("open") >= 1_000.0) & (pl.col("prior_dollar_volume20") >= 1_000_000_000)
    return common & (pl.col("prior_dollar_volume20") >= 5_000_000)

def add_scores(df: pl.DataFrame, market: str) -> pl.DataFrame:
    gap_long = (
        (pl.col("gap") >= 0.0) & (pl.col("gap") <= 0.15)
        if market in ("US_STOCK","KR_STOCK")
        else (pl.col("gap") >= -0.01)
    )
    long_score = (
        (pl.col("prior_rvol") >= 1.20).cast(pl.Int8)
        + (pl.col("ret5_prev") >= 0.02).cast(pl.Int8)
        + (pl.col("ret20_prev") >= 0.05).cast(pl.Int8)
        + (pl.col("distance_prior_high20") >= -0.05).cast(pl.Int8)
        + (pl.col("prev_range_pct") <= pl.col("prior_atr_pct") * 0.90).cast(pl.Int8)
        + gap_long.cast(pl.Int8)
    )
    if market in ("US_STOCK","KR_STOCK"):
        event_long = (pl.col("gap") >= 0.03) & (pl.col("gap") <= 0.30)
    else:
        event_long = (pl.col("prior_rvol") >= 2.0) & (pl.col("ret5_prev") >= 0.03)
    x = df.with_columns([
        long_score.alias("long_score"),
        event_long.alias("event_long"),
    ])
    if market == "CRYPTO_FUTURES":
        short_score = (
            (pl.col("prior_rvol") >= 1.20).cast(pl.Int8)
            + (pl.col("ret5_prev") <= -0.02).cast(pl.Int8)
            + (pl.col("ret20_prev") <= -0.05).cast(pl.Int8)
            + (pl.col("distance_prior_low20") <= 0.05).cast(pl.Int8)
            + (pl.col("prev_range_pct") <= pl.col("prior_atr_pct") * 0.90).cast(pl.Int8)
            + (pl.col("gap") <= 0.01).cast(pl.Int8)
        )
        x = x.with_columns([
            short_score.alias("short_score"),
            ((pl.col("prior_rvol") >= 2.0) & (pl.col("ret5_prev") <= -0.03)).alias("event_short"),
        ])
    return x

def variant_rows(df: pl.DataFrame, market: str, variant: str) -> pl.DataFrame:
    if variant == "PRESSURE4":
        long_mask = pl.col("long_score") >= 4
    elif variant == "PRESSURE5":
        long_mask = pl.col("long_score") >= 5
    elif variant == "PRESSURE4_EVENT":
        long_mask = (pl.col("long_score") >= 4) | pl.col("event_long")
    else:
        raise ValueError(variant)

    longs = (
        df.filter(long_mask)
        .with_columns([
            pl.lit("LONG").alias("direction"),
            pl.col("long_score").cast(pl.Int16).alias("score"),
            pl.col("event_long").alias("eventLane"),
        ])
    )
    if market != "CRYPTO_FUTURES":
        return longs

    if variant == "PRESSURE4":
        short_mask = pl.col("short_score") >= 4
    elif variant == "PRESSURE5":
        short_mask = pl.col("short_score") >= 5
    else:
        short_mask = (pl.col("short_score") >= 4) | pl.col("event_short")

    shorts = (
        df.filter(short_mask)
        .with_columns([
            pl.lit("SHORT").alias("direction"),
            pl.col("short_score").cast(pl.Int16).alias("score"),
            pl.col("event_short").alias("eventLane"),
        ])
    )
    return pl.concat([longs, shorts], how="vertical")

def simulate(rows: pl.DataFrame, market: str) -> pl.DataFrame:
    if rows.is_empty():
        return rows
    cost = COSTS[market]
    stop_pct = pl.col("prior_atr_pct").mul(0.50).clip(0.01, 0.04)
    if market == "CRYPTO_FUTURES":
        stop_pct = pl.col("prior_atr_pct").mul(0.45).clip(0.01, 0.035)

    long_return = pl.when(pl.col("low") <= pl.col("open") * (1.0 - stop_pct)).then(-stop_pct).otherwise(
        pl.col("close") / pl.col("open") - 1.0
    )
    short_return = pl.when(pl.col("high") >= pl.col("open") * (1.0 + stop_pct)).then(-stop_pct).otherwise(
        1.0 - pl.col("close") / pl.col("open")
    )
    raw_return = pl.when(pl.col("direction") == "LONG").then(long_return).otherwise(short_return)
    mfe = pl.when(pl.col("direction") == "LONG").then(
        pl.col("high") / pl.col("open") - 1.0
    ).otherwise(
        1.0 - pl.col("low") / pl.col("open")
    )
    mae = pl.when(pl.col("direction") == "LONG").then(
        1.0 - pl.col("low") / pl.col("open")
    ).otherwise(
        pl.col("high") / pl.col("open") - 1.0
    )
    stop_hit = pl.when(pl.col("direction") == "LONG").then(
        pl.col("low") <= pl.col("open") * (1.0 - stop_pct)
    ).otherwise(
        pl.col("high") >= pl.col("open") * (1.0 + stop_pct)
    )
    return rows.with_columns([
        stop_pct.alias("stopPct"),
        stop_hit.alias("stopHit"),
        raw_return.alias("grossReturn"),
        (raw_return - cost).alias("netReturn"),
        mfe.alias("MFE"),
        mae.alias("MAE"),
    ])

def compound(values: list[float]) -> float:
    wealth = 1.0
    for value in values:
        wealth *= 1.0 + float(value)
    return wealth - 1.0

def metrics(trades: pl.DataFrame, market: str, all_dates: list | None = None) -> dict:
    if trades.is_empty():
        return {
            "tradeCount":0,"activeDays":0,"totalReturn":0.0,"mdd":0.0,
            "winRate":None,"profitFactor":None,"monthsPositive":0,"months3pctPlus":0,
            "days3pctPlus":0,"windows":{},
        }

    daily = (
        trades.group_by("date")
        .agg([
            pl.col("netReturn").mean().alias("portfolioReturn"),
            pl.len().alias("trades"),
            (pl.col("MFE") >= 0.03).sum().alias("mfe3Hits"),
            (pl.col("MFE") >= 0.05).sum().alias("mfe5Hits"),
            (pl.col("MFE") >= 0.10).sum().alias("mfe10Hits"),
            (pl.col("MFE") >= 0.20).sum().alias("mfe20Hits"),
        ])
        .sort("date")
    )
    returns = daily.get_column("portfolioReturn").to_list()
    wealth = []
    v = 1.0
    peak = 1.0
    mdd = 0.0
    for r in returns:
        v *= 1.0 + float(r)
        wealth.append(v)
        peak = max(peak, v)
        mdd = max(mdd, (peak - v) / peak)

    tnet = trades.get_column("netReturn").to_numpy()
    pos = float(tnet[tnet > 0].sum()) if np.any(tnet > 0) else 0.0
    neg = float(-tnet[tnet < 0].sum()) if np.any(tnet < 0) else 0.0

    pdaily = daily.to_pandas()
    pdaily["date"] = pd.to_datetime(pdaily["date"])
    if all_dates is not None:
        calendar = pd.DatetimeIndex(pd.to_datetime(sorted(all_dates)))
        pdaily = (
            pdaily.set_index("date")
            .reindex(calendar)
            .rename_axis("date")
            .reset_index()
        )
        for col in ["portfolioReturn","trades","mfe3Hits","mfe5Hits","mfe10Hits","mfe20Hits"]:
            pdaily[col] = pdaily[col].fillna(0)
    pdaily["month"] = pdaily["date"].dt.to_period("M")
    monthly = pdaily.groupby("month")["portfolioReturn"].apply(lambda s: np.prod(1.0 + s.to_numpy()) - 1.0)

    dates = [d.date() for d in pdaily["date"].tolist()]
    windows = {}
    for label, n in WINDOWS[market]:
        selected = dates if n is None else dates[-n:]
        start = pd.Timestamp(selected[0]) if selected else None
        end = pd.Timestamp(selected[-1]) if selected else None
        if selected:
            mask = (pdaily["date"] >= start) & (pdaily["date"] <= end)
            sub = pdaily.loc[mask]
        else:
            sub = pdaily.iloc[0:0]
        windows[label] = {
            "startDate": str(selected[0]) if selected else None,
            "endDate": str(selected[-1]) if selected else None,
            "marketDays": len(selected),
            "return": compound(sub["portfolioReturn"].tolist()) if len(sub) else 0.0,
            "tradeCount": int(sub["trades"].sum()) if len(sub) else 0,
        }

    return {
        "tradeCount": trades.height,
        "activeDays": int((pdaily["trades"] > 0).sum()),
        "marketDays": int(len(pdaily)),
        "totalReturn": wealth[-1] - 1.0,
        "mdd": mdd,
        "winRate": float((tnet > 0).mean()),
        "profitFactor": (pos / neg if neg > 0 else (999.0 if pos > 0 else 0.0)),
        "monthsPositive": int((monthly > 0).sum()),
        "monthsTotal": int(len(monthly)),
        "months3pctPlus": int((monthly >= 0.03).sum()),
        "months5pctPlus": int((monthly >= 0.05).sum()),
        "months10pctPlus": int((monthly >= 0.10).sum()),
        "days3pctPlus": int((pdaily["portfolioReturn"] >= 0.03).sum()),
        "days5pctPlus": int((pdaily["portfolioReturn"] >= 0.05).sum()),
        "days10pctPlus": int((pdaily["portfolioReturn"] >= 0.10).sum()),
        "windows": windows,
    }

def write_portfolio_series(trades: pl.DataFrame, market_dates: list, out: Path) -> None:
    if trades.is_empty():
        pd.DataFrame(columns=["date","portfolioReturn","trades","wealth"]).to_csv(out / "daily-portfolio.csv", index=False)
        pd.DataFrame(columns=["month","return","trades"]).to_csv(out / "monthly-portfolio.csv", index=False)
        return
    daily = (
        trades.group_by("date")
        .agg([
            pl.col("netReturn").mean().alias("portfolioReturn"),
            pl.len().alias("trades"),
        ])
        .sort("date")
        .to_pandas()
    )
    daily["date"] = pd.to_datetime(daily["date"])
    calendar = pd.DatetimeIndex(pd.to_datetime(sorted(market_dates)))
    daily = daily.set_index("date").reindex(calendar).rename_axis("date").reset_index()
    daily["portfolioReturn"] = daily["portfolioReturn"].fillna(0.0)
    daily["trades"] = daily["trades"].fillna(0).astype(int)
    daily["wealth"] = (1.0 + daily["portfolioReturn"]).cumprod()
    daily.to_csv(out / "daily-portfolio.csv", index=False)

    monthly = (
        daily.assign(month=daily["date"].dt.to_period("M").astype(str))
        .groupby("month", as_index=False)
        .agg(
            return_=("portfolioReturn", lambda s: float(np.prod(1.0 + s.to_numpy()) - 1.0)),
            trades=("trades","sum"),
        )
        .rename(columns={"return_":"return"})
    )
    monthly.to_csv(out / "monthly-portfolio.csv", index=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", required=True, choices=MARKETS)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    market = args.market
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    if market == "US_STOCK":
        loaded, source_meta = census.load_us()
    elif market == "KR_STOCK":
        loaded, source_meta = load_kr_fast()
    elif market == "CRYPTO_SPOT":
        loaded, source_meta = census.load_crypto("CRYPTO_SPOT")
    else:
        loaded, source_meta = census.load_crypto("CRYPTO_FUTURES")

    raw = census.add_features(loaded, market)
    raw = add_preopen_features(raw).filter(tradable_mask(market))
    raw = add_scores(raw, market)

    market_dates = raw.select("date").unique().sort("date").get_column("date").to_list()
    variants = {}
    ledgers = {}
    for variant in ("PRESSURE4","PRESSURE5","PRESSURE4_EVENT"):
        trades = simulate(variant_rows(raw, market, variant), market)
        variants[variant] = metrics(trades, market, market_dates)
        ledgers[variant] = trades

    # Freeze the variant using only the first two years, prioritizing monthly consistency.
    boundary = pd.Timestamp("2025-04-01").date()
    pre_dates = [d for d in market_dates if d < boundary]
    test_dates = [d for d in market_dates if d >= boundary]
    selection_rows = []
    for variant, trades in ledgers.items():
        pre = trades.filter(pl.col("date") < pl.lit(boundary))
        m = metrics(pre, market, pre_dates)
        months_total = max(int(m.get("monthsTotal") or 0), 1)
        selection_rows.append((
            variant,
            float(m.get("monthsPositive") or 0) / months_total,
            float(m.get("months3pctPlus") or 0) / months_total,
            float(m.get("totalReturn") or 0.0),
            -float(m.get("mdd") or 0.0),
            int(m.get("tradeCount") or 0),
        ))
    selected = sorted(selection_rows, key=lambda x: (x[1],x[2],x[3],x[4],x[5],x[0]), reverse=True)[0][0]
    selected_trades = ledgers[selected].sort(["date","symbol","direction"])

    # Held-out last year.
    test_trades = selected_trades.filter(pl.col("date") >= pl.lit(boundary))
    heldout = metrics(test_trades, market, test_dates)

    ledger_columns = [
        "date","symbol","direction","score","eventLane","open","high","low","close",
        "gap","ret5_prev","ret20_prev","prior_rvol","prior_dollar_volume20",
        "distance_prior_high20","distance_prior_low20","prior_atr_pct",
        "stopPct","stopHit","grossReturn","netReturn","MFE","MAE",
    ]
    selected_trades.select(ledger_columns).write_csv(out / "selected-ledger.csv")
    selected_trades.select(ledger_columns).write_parquet(out / "selected-ledger.parquet", compression="zstd")
    write_portfolio_series(selected_trades, market_dates, out)

    report = {
        "schemaVersion": 1,
        "contract": "full-universe-3pct-hunter-causal-backtest-v1",
        "market": market,
        "directionPolicy": (
            "LONG_SHORT" if market == "CRYPTO_FUTURES" else "LONG_ONLY"
        ),
        "source": source_meta,
        "period": {
            "start": str(census.START.date()),
            "endExclusive": str(census.END_EXCLUSIVE.date()),
            "selectionHistoryEndExclusive": str(boundary),
            "heldoutStart": str(boundary),
        },
        "execution": {
            "entry": "daily open after all features are known",
            "stop": "0.5x prior ATR%, clipped 1-4%; futures 0.45x clipped 1-3.5%",
            "ambiguity": "STOP_FIRST_CONSERVATIVE",
            "exit": "same-day close if stop not touched",
            "portfolio": "all qualifying signals, equal-weight gross exposure 100% per day; no fixed Top-N",
            "leverage": "NONE; futures results are unlevered underlying-return diagnostics",
            "roundTripCost": COSTS[market],
        },
        "variants": variants,
        "selectedVariantFromFirstTwoYears": selected,
        "selectedObservedThreeYear": variants[selected],
        "heldoutLastYear": heldout,
        "truthBoundary": {
            "lookaheadInEntryFeatures": False,
            "dailyOHLCOrderKnown": False,
            "stopFirstUsed": True,
            "intradayTMinusSignalsProven": False,
            "independentOos": False,
            "heldoutLastYearWithinSameObservedDataset": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"FINAL": report}, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
