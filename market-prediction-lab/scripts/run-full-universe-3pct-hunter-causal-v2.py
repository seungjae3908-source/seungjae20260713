#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import pandas as pd
import polars as pl

ROOT = Path(__file__).resolve().parents[2]
V1_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC = importlib.util.spec_from_file_location("hunter_causal_v1", V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v1)

MARKETS = ("US_STOCK", "KR_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES")
FAMILIES = ("MOMENTUM", "COMPRESSION", "PRESSURE")
TOP_NS = (1, 3, 5, 10, 20)
TARGETS = (0.03, 0.05)
BOUNDARY = pd.Timestamp("2025-04-01").date()
MIN_TRAIN_TRADES = 100
MIN_TRAIN_ACTIVE_DAYS = 60


def load_market(market: str) -> tuple[pl.DataFrame, dict]:
    if market == "US_STOCK":
        return v1.census.load_us()
    if market == "KR_STOCK":
        return v1.census.load_kr()
    if market == "CRYPTO_SPOT":
        return v1.census.load_crypto("CRYPTO_SPOT")
    return v1.census.load_crypto("CRYPTO_FUTURES")


def pct_rank(name: str) -> pl.Expr:
    rank = pl.col(name).rank("average", descending=True).over("date").cast(pl.Float64)
    count = pl.len().over("date").cast(pl.Float64)
    return (
        pl.when(count > 1)
        .then(1.0 - ((rank - 1.0) / (count - 1.0)))
        .otherwise(1.0)
    )


def prepare_features(loaded: pl.DataFrame, market: str) -> pl.DataFrame:
    x = v1.census.add_features(loaded, market)
    x = v1.add_preopen_features(x).filter(v1.tradable_mask(market))
    x = x.with_columns([
        (pl.col("prev_range_pct") / pl.col("prior_atr_pct")).alias("compressionRatio"),
        (-pl.col("ret5_prev")).alias("_shortRet5"),
        (-pl.col("ret20_prev")).alias("_shortRet20"),
        (-pl.col("distance_prior_low20")).alias("_shortNearLow"),
        (-pl.col("compressionRatio")).alias("_compressionGood"),
    ])
    x = x.with_columns([
        pct_rank("prior_rvol").alias("r_rvol"),
        pct_rank("ret5_prev").alias("r_ret5_long"),
        pct_rank("ret20_prev").alias("r_ret20_long"),
        pct_rank("distance_prior_high20").alias("r_near_high"),
        pct_rank("_shortRet5").alias("r_ret5_short"),
        pct_rank("_shortRet20").alias("r_ret20_short"),
        pct_rank("_shortNearLow").alias("r_near_low"),
        pct_rank("_compressionGood").alias("r_compression"),
        pct_rank("prior_atr_pct").alias("r_atr"),
        pct_rank("prior_dollar_volume20").alias("r_liq"),
    ])
    return x


def score_expr(family: str, direction: str) -> pl.Expr:
    if direction == "LONG":
        momentum = [pl.col("r_rvol"), pl.col("r_ret5_long"), pl.col("r_ret20_long"),
                    pl.col("r_near_high"), pl.col("r_atr"), pl.col("r_liq")]
        compression = [pl.col("r_rvol"), pl.col("r_near_high"), pl.col("r_compression"),
                       pl.col("r_atr"), pl.col("r_liq"), pl.col("r_ret5_long")]
        pressure = [pl.col("r_rvol"), pl.col("r_ret5_long"), pl.col("r_ret20_long"),
                    pl.col("r_near_high"), pl.col("r_compression"), pl.col("r_atr"),
                    pl.col("r_liq")]
    else:
        momentum = [pl.col("r_rvol"), pl.col("r_ret5_short"), pl.col("r_ret20_short"),
                    pl.col("r_near_low"), pl.col("r_atr"), pl.col("r_liq")]
        compression = [pl.col("r_rvol"), pl.col("r_near_low"), pl.col("r_compression"),
                       pl.col("r_atr"), pl.col("r_liq"), pl.col("r_ret5_short")]
        pressure = [pl.col("r_rvol"), pl.col("r_ret5_short"), pl.col("r_ret20_short"),
                    pl.col("r_near_low"), pl.col("r_compression"), pl.col("r_atr"),
                    pl.col("r_liq")]
    cols = momentum if family == "MOMENTUM" else compression if family == "COMPRESSION" else pressure
    return sum(cols) / float(len(cols))


def base_mask(market: str, family: str, direction: str) -> pl.Expr:
    atr_floor = 0.015 if market in ("US_STOCK", "KR_STOCK") else 0.020
    common = pl.col("prior_atr_pct") >= atr_floor
    if direction == "LONG":
        mask = (
            common
            & (pl.col("prior_rvol") >= 1.0)
            & (pl.col("ret5_prev") >= 0.0)
            & (pl.col("distance_prior_high20") >= -0.10)
        )
        if family == "MOMENTUM":
            mask = mask & (pl.col("ret20_prev") >= 0.0)
        elif family == "COMPRESSION":
            mask = mask & (pl.col("compressionRatio") <= 1.10)
        else:
            mask = mask & (pl.col("prior_rvol") >= 1.20) & (pl.col("compressionRatio") <= 1.20)
        return mask

    mask = (
        common
        & (pl.col("prior_rvol") >= 1.0)
        & (pl.col("ret5_prev") <= 0.0)
        & (pl.col("distance_prior_low20") <= 0.10)
    )
    if family == "MOMENTUM":
        mask = mask & (pl.col("ret20_prev") <= 0.0)
    elif family == "COMPRESSION":
        mask = mask & (pl.col("compressionRatio") <= 1.10)
    else:
        mask = mask & (pl.col("prior_rvol") >= 1.20) & (pl.col("compressionRatio") <= 1.20)
    return mask


def select_candidate_rows(
    raw: pl.DataFrame,
    market: str,
    family: str,
    direction: str,
    top_n: int,
) -> pl.DataFrame:
    score_name = "_candidateScore"
    x = (
        raw.filter(base_mask(market, family, direction))
        .with_columns(score_expr(family, direction).alias(score_name))
        .sort(["date", score_name], descending=[False, True])
        .group_by("date", maintain_order=True)
        .head(top_n)
        .with_columns([
            pl.lit(direction).alias("direction"),
            pl.lit(family).alias("family"),
            pl.lit(top_n).alias("topN"),
            pl.col(score_name).alias("candidateScore"),
        ])
    )
    return x


def simulate_target(rows: pl.DataFrame, market: str, target: float) -> pl.DataFrame:
    if rows.is_empty():
        return rows

    cost = v1.COSTS[market]
    stop_pct = pl.col("prior_atr_pct").mul(0.50).clip(0.01, 0.04)
    if market == "CRYPTO_FUTURES":
        stop_pct = pl.col("prior_atr_pct").mul(0.45).clip(0.01, 0.035)

    long_stop = pl.col("low") <= pl.col("open") * (1.0 - stop_pct)
    short_stop = pl.col("high") >= pl.col("open") * (1.0 + stop_pct)
    long_target = pl.col("high") >= pl.col("open") * (1.0 + target)
    short_target = pl.col("low") <= pl.col("open") * (1.0 - target)

    stop_hit = pl.when(pl.col("direction") == "LONG").then(long_stop).otherwise(short_stop)
    target_hit = pl.when(pl.col("direction") == "LONG").then(long_target).otherwise(short_target)

    exit_price = (
        pl.when(pl.col("direction") == "LONG")
        .then(
            pl.when(long_stop)
            .then(pl.col("open") * (1.0 - stop_pct))
            .when(long_target)
            .then(pl.col("open") * (1.0 + target))
            .otherwise(pl.col("close"))
        )
        .otherwise(
            pl.when(short_stop)
            .then(pl.col("open") * (1.0 + stop_pct))
            .when(short_target)
            .then(pl.col("open") * (1.0 - target))
            .otherwise(pl.col("close"))
        )
    )

    gross_return = (
        pl.when(pl.col("direction") == "LONG")
        .then(exit_price / pl.col("open") - 1.0)
        .otherwise(1.0 - exit_price / pl.col("open"))
    )
    mfe = (
        pl.when(pl.col("direction") == "LONG")
        .then(pl.col("high") / pl.col("open") - 1.0)
        .otherwise(1.0 - pl.col("low") / pl.col("open"))
    )
    mae = (
        pl.when(pl.col("direction") == "LONG")
        .then(1.0 - pl.col("low") / pl.col("open"))
        .otherwise(pl.col("high") / pl.col("open") - 1.0)
    )

    return rows.with_columns([
        pl.lit(market).alias("market"),
        pl.lit(target).alias("targetPct"),
        pl.col("open").alias("entryPrice"),
        exit_price.alias("exitPrice"),
        stop_pct.alias("stopPct"),
        stop_hit.alias("stopHit"),
        target_hit.alias("targetHit"),
        pl.when(stop_hit)
        .then(pl.lit("ATR_STOP"))
        .when(target_hit)
        .then(pl.lit(f"TP_{int(target * 100)}"))
        .otherwise(pl.lit("EOD_CLOSE"))
        .alias("exitReason"),
        pl.lit(cost).alias("roundTripCost"),
        gross_return.alias("grossReturn"),
        (gross_return - cost).alias("netReturn"),
        mfe.alias("MFE"),
        mae.alias("MAE"),
    ])


def candidate_name(family: str, direction: str, top_n: int, target: float) -> str:
    return f"{family}_{direction}_TOP{top_n}_TP{int(target * 100)}"


def selection_tuple(metrics: dict, name: str) -> tuple:
    months_total = max(int(metrics.get("monthsTotal") or 0), 1)
    positive_month_ratio = float(metrics.get("monthsPositive") or 0) / months_total
    month3_ratio = float(metrics.get("months3pctPlus") or 0) / months_total
    return (
        positive_month_ratio,
        month3_ratio,
        float(metrics.get("totalReturn") or 0.0),
        float(metrics.get("profitFactor") or 0.0),
        -float(metrics.get("mdd") or 0.0),
        int(metrics.get("tradeCount") or 0),
        name,
    )


def heldout_pass(metrics: dict) -> dict:
    checks = {
        "positiveReturn": float(metrics.get("totalReturn") or 0.0) > 0.0,
        "profitFactorAbove1": float(metrics.get("profitFactor") or 0.0) > 1.0,
        "positiveMonthRateAtLeast50pct": float(metrics.get("positiveMonthRate") or 0.0) >= 0.50,
        "mddAtMost35pct": float(metrics.get("mdd") or 1.0) <= 0.35,
        "atLeast50Trades": int(metrics.get("tradeCount") or 0) >= 50,
    }
    return {"pass": all(checks.values()), "checks": checks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", required=True, choices=MARKETS)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    market = args.market
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    loaded, source_meta = load_market(market)
    v1.assert_source_coverage(market, source_meta)
    raw = prepare_features(loaded, market)
    market_dates = raw.select("date").unique().sort("date").get_column("date").to_list()
    pre_dates = [d for d in market_dates if d < BOUNDARY]
    test_dates = [d for d in market_dates if d >= BOUNDARY]

    directions = ["LONG", "SHORT"] if market == "CRYPTO_FUTURES" else ["LONG"]
    grid_rows = []
    candidate_ledgers: dict[str, pl.DataFrame] = {}
    candidate_reports: dict[str, dict] = {}

    for direction in directions:
        for family in FAMILIES:
            for top_n in TOP_NS:
                selected_rows = select_candidate_rows(raw, market, family, direction, top_n)
                for target in TARGETS:
                    name = candidate_name(family, direction, top_n, target)
                    trades = simulate_target(selected_rows, market, target).with_columns(
                        pl.lit(name).alias("candidate")
                    )
                    train = trades.filter(pl.col("date") < pl.lit(BOUNDARY))
                    heldout = trades.filter(pl.col("date") >= pl.lit(BOUNDARY))
                    train_metrics = v1.metrics(train, market, pre_dates)
                    heldout_metrics = v1.metrics(heldout, market, test_dates)
                    full_metrics = v1.metrics(trades, market, market_dates)
                    eligible = (
                        int(train_metrics.get("tradeCount") or 0) >= MIN_TRAIN_TRADES
                        and int(train_metrics.get("activeDays") or 0) >= MIN_TRAIN_ACTIVE_DAYS
                    )
                    candidate_ledgers[name] = trades
                    candidate_reports[name] = {
                        "candidate": name,
                        "direction": direction,
                        "family": family,
                        "topN": top_n,
                        "targetPct": target,
                        "eligibleForSelection": eligible,
                        "trainFirstTwoYears": train_metrics,
                        "heldoutLastYear": heldout_metrics,
                        "observedThreeYear": full_metrics,
                    }
                    grid_rows.append({
                        "candidate": name,
                        "direction": direction,
                        "family": family,
                        "topN": top_n,
                        "targetPct": target,
                        "eligibleForSelection": eligible,
                        "trainTrades": train_metrics.get("tradeCount"),
                        "trainActiveDays": train_metrics.get("activeDays"),
                        "trainReturn": train_metrics.get("totalReturn"),
                        "trainMdd": train_metrics.get("mdd"),
                        "trainProfitFactor": train_metrics.get("profitFactor"),
                        "trainPositiveMonthRate": train_metrics.get("positiveMonthRate"),
                        "trainMonths3pctPlus": train_metrics.get("months3pctPlus"),
                        "heldoutReturn": heldout_metrics.get("totalReturn"),
                        "heldoutMdd": heldout_metrics.get("mdd"),
                        "heldoutProfitFactor": heldout_metrics.get("profitFactor"),
                        "heldoutPositiveMonthRate": heldout_metrics.get("positiveMonthRate"),
                        "heldoutTrades": heldout_metrics.get("tradeCount"),
                        "threeYearReturn": full_metrics.get("totalReturn"),
                        "threeYearMdd": full_metrics.get("mdd"),
                        "threeYearProfitFactor": full_metrics.get("profitFactor"),
                    })

    selected_by_direction = {}
    selected_ledgers = []
    for direction in directions:
        names = [
            row["candidate"] for row in grid_rows
            if row["direction"] == direction and row["eligibleForSelection"]
        ]
        if not names:
            raise RuntimeError(f"NO_ELIGIBLE_V2_CANDIDATES:{market}:{direction}")
        winner = sorted(
            names,
            key=lambda name: selection_tuple(
                candidate_reports[name]["trainFirstTwoYears"],
                name,
            ),
            reverse=True,
        )[0]
        report = candidate_reports[winner]
        report["heldoutGate"] = heldout_pass(report["heldoutLastYear"])
        selected_by_direction[direction] = report
        selected_ledgers.append(candidate_ledgers[winner])

    selected_all = pl.concat(selected_ledgers, how="vertical").sort(["date", "symbol", "direction"])
    selected_direction_audit = v1.assert_direction_policy(selected_all, market)
    market_full = v1.metrics(selected_all, market, market_dates)
    market_heldout = v1.metrics(
        selected_all.filter(pl.col("date") >= pl.lit(BOUNDARY)),
        market,
        test_dates,
    )
    market_gate = heldout_pass(market_heldout)

    pd.DataFrame(grid_rows).sort_values(
        ["direction", "trainPositiveMonthRate", "trainReturn"],
        ascending=[True, False, False],
    ).to_csv(out / "candidate-grid.csv", index=False)

    ledger_cols = [
        "market", "date", "symbol", "direction", "candidate", "family", "topN",
        "candidateScore", "targetPct", "entryPrice", "exitPrice", "grossReturn",
        "roundTripCost", "netReturn", "MFE", "MAE", "stopPct", "stopHit",
        "targetHit", "exitReason", "ret5_prev", "ret20_prev", "prior_rvol",
        "prior_dollar_volume20", "distance_prior_high20", "distance_prior_low20",
        "prior_atr_pct", "compressionRatio",
    ]
    selected_all.select(ledger_cols).write_csv(out / "selected-ledger.csv")
    selected_all.select(ledger_cols).write_parquet(out / "selected-ledger.parquet", compression="zstd")
    v1.write_portfolio_series(selected_all, market_dates, out)

    summary = {
        "schemaVersion": 1,
        "contract": "full-universe-3pct-hunter-causal-v2",
        "market": market,
        "source": source_meta,
        "period": {
            "start": str(v1.census.START.date()),
            "endExclusive": str(v1.census.END_EXCLUSIVE.date()),
            "selectionHistoryEndExclusive": str(BOUNDARY),
            "heldoutStart": str(BOUNDARY),
        },
        "design": {
            "families": list(FAMILIES),
            "topNGrid": list(TOP_NS),
            "targetGrid": list(TARGETS),
            "signalData": "prior-session-only",
            "ranking": "cross-sectional prior-feature percentile ranks",
            "entry": "same-day open fill proxy after prior-session ranking",
            "exit": "3% or 5% target, ATR stop, otherwise EOD close",
            "ambiguity": "STOP_FIRST_CONSERVATIVE",
            "selection": "first two years only; heldout last year never used for winner choice",
            "leverage": "NONE",
        },
        "selectedDirectionPolicyAudit": selected_direction_audit,
        "selectedByDirection": selected_by_direction,
        "marketSelectedObservedThreeYear": market_full,
        "marketHeldoutLastYear": market_heldout,
        "marketHeldoutGate": market_gate,
        "truthBoundary": {
            "lookaheadInEntryFeatures": False,
            "sameDayOpenUsedOnlyAsFillProxy": True,
            "heldoutUsedForSelection": False,
            "dailyOHLCOrderKnown": False,
            "stopFirstUsed": True,
            "intradayTMinusSignalsProven": False,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": summary}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
