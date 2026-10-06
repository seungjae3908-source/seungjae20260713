#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import polars as pl

ROOT = Path(__file__).resolve().parents[2]
V1_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC = importlib.util.spec_from_file_location("hunter_v1", V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v1)
census = v1.census

GAP_MINS = (0.02, 0.04, 0.06)
RVOL_MINS = (2.0, 3.0, 5.0)
TOP_NS = (1, 3, 5)
TARGETS = (0.03, 0.05)
BOUNDARY = pd.Timestamp("2025-04-01").date()
COST = 0.0020


def daily_summary(path: Path) -> pl.DataFrame:
    con = duckdb.connect()
    query = f"""
    WITH bars AS (
      SELECT
        upper(ticker) AS symbol,
        timezone('America/New_York', timestamp) AS local_ts,
        CAST(open AS DOUBLE) AS open,
        CAST(high AS DOUBLE) AS high,
        CAST(low AS DOUBLE) AS low,
        CAST(close AS DOUBLE) AS close,
        CAST(volume AS DOUBLE) AS volume
      FROM read_parquet('{path.as_posix()}')
    ),
    regular AS (
      SELECT
        *,
        CAST(local_ts AS DATE) AS date,
        CAST(local_ts AS TIME) AS local_time
      FROM bars
      WHERE CAST(local_ts AS TIME) >= TIME '09:30:00'
        AND CAST(local_ts AS TIME) < TIME '16:00:00'
        AND regexp_matches(symbol, '^[A-Z][A-Z0-9.\\-]{{0,9}}$')
    )
    SELECT
      symbol,
      date,
      arg_min(open, local_ts) AS open,
      max(high) AS high,
      min(low) AS low,
      arg_max(close, local_ts) AS close,
      sum(volume) AS volume,
      max(CASE WHEN local_time >= TIME '09:30:00' AND local_time < TIME '09:35:00' THEN high ELSE NULL END) AS first5_high,
      min(CASE WHEN local_time >= TIME '09:30:00' AND local_time < TIME '09:35:00' THEN low ELSE NULL END) AS first5_low,
      sum(CASE WHEN local_time >= TIME '09:30:00' AND local_time < TIME '09:35:00' THEN volume ELSE 0 END) AS first5_volume
    FROM regular
    GROUP BY symbol, date
    """
    out = pl.from_arrow(con.execute(query).fetch_arrow_table())
    con.close()
    return out


def add_daily_features(df: pl.DataFrame) -> pl.DataFrame:
    x = df.sort(["symbol", "date"])
    x = x.with_columns([
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("close").shift(6).over("symbol").alias("close_6ago"),
        pl.col("volume").shift(1).over("symbol").alias("prev_volume"),
        pl.col("high").shift(1).over("symbol").alias("prev_high"),
        pl.col("low").shift(1).over("symbol").alias("prev_low"),
        pl.col("close").shift(2).over("symbol").alias("close_2ago"),
        pl.col("first5_volume").shift(1).rolling_mean(window_size=20, min_samples=5).over("symbol").alias("prior_first5_volume20"),
        (pl.col("close").shift(1) * pl.col("volume").shift(1))
          .rolling_mean(window_size=20, min_samples=5).over("symbol").alias("prior_dollar_volume20"),
    ])
    x = x.with_columns([
        (pl.col("open") / pl.col("prev_close") - 1.0).alias("gap"),
        (pl.col("prev_close") / pl.col("close_6ago") - 1.0).alias("ret5_prev"),
        (pl.col("first5_volume") / pl.col("prior_first5_volume20")).alias("earlyRvol"),
        pl.max_horizontal(
            (pl.col("prev_high") - pl.col("prev_low")).abs(),
            (pl.col("prev_high") - pl.col("close_2ago")).abs(),
            (pl.col("prev_low") - pl.col("close_2ago")).abs(),
        ).alias("prev_true_range"),
    ])
    x = x.with_columns(
        pl.col("prev_true_range")
        .rolling_mean(window_size=14, min_samples=10)
        .over("symbol")
        .truediv(pl.col("prev_close"))
        .alias("prior_atr_pct")
    )
    return x


def pct_rank(col_name: str) -> pl.Expr:
    rank = pl.col(col_name).rank("average", descending=True).over("date").cast(pl.Float64)
    count = pl.len().over("date").cast(pl.Float64)
    return pl.when(count > 1).then(1.0 - (rank - 1.0) / (count - 1.0)).otherwise(1.0)


def broad_candidates(df: pl.DataFrame) -> pl.DataFrame:
    x = df.filter(
        pl.col("prev_close").is_not_null()
        & pl.col("prior_dollar_volume20").is_not_null()
        & pl.col("prior_first5_volume20").is_not_null()
        & pl.col("prior_atr_pct").is_not_null()
        & (pl.col("open") >= 2.0)
        & (pl.col("prior_dollar_volume20") >= 10_000_000)
        & (pl.col("gap") >= 0.02)
        & (pl.col("gap") <= 0.30)
        & (pl.col("earlyRvol") >= 2.0)
        & (pl.col("first5_high") > 0)
        & (pl.col("first5_low") > 0)
    )
    x = x.with_columns([
        pct_rank("gap").alias("r_gap"),
        pct_rank("earlyRvol").alias("r_rvol"),
        pct_rank("prior_dollar_volume20").alias("r_liq"),
        pct_rank("ret5_prev").alias("r_mom"),
    ])
    return x.with_columns(
        (
            pl.col("r_gap") * 0.35
            + pl.col("r_rvol") * 0.35
            + pl.col("r_liq") * 0.15
            + pl.col("r_mom") * 0.15
        ).alias("candidateScore")
    )


def replay_month(path: Path, month_candidates: pl.DataFrame) -> list[dict]:
    if month_candidates.is_empty():
        return []
    keys = month_candidates.select(["symbol", "date"]).unique()
    con = duckdb.connect()
    con.register("candidate_keys", keys.to_arrow())
    query = f"""
    WITH bars AS (
      SELECT
        upper(ticker) AS symbol,
        timezone('America/New_York', timestamp) AS local_ts,
        CAST(open AS DOUBLE) AS open,
        CAST(high AS DOUBLE) AS high,
        CAST(low AS DOUBLE) AS low,
        CAST(close AS DOUBLE) AS close,
        CAST(volume AS DOUBLE) AS volume
      FROM read_parquet('{path.as_posix()}')
    ),
    regular AS (
      SELECT
        *,
        CAST(local_ts AS DATE) AS date,
        CAST(local_ts AS TIME) AS local_time
      FROM bars
      WHERE CAST(local_ts AS TIME) >= TIME '09:35:00'
        AND CAST(local_ts AS TIME) < TIME '16:00:00'
    )
    SELECT r.*
    FROM regular r
    INNER JOIN candidate_keys c
      ON r.symbol = c.symbol AND r.date = c.date
    ORDER BY r.symbol, r.date, r.local_ts
    """
    bars = pl.from_arrow(con.execute(query).fetch_arrow_table())
    con.close()
    if bars.is_empty():
        return []

    meta = {
        (str(row["symbol"]), row["date"]): row
        for row in month_candidates.to_dicts()
    }
    records: list[dict] = []
    pdf = bars.to_pandas()
    for (symbol, dt), group in pdf.groupby(["symbol", "date"], sort=False):
        key = (str(symbol), pd.Timestamp(dt).date())
        m = meta.get(key)
        if not m:
            continue
        g = group.sort_values("local_ts").reset_index(drop=True)
        first5_high = float(m["first5_high"])
        trigger_idx = g.index[g["high"] >= first5_high].tolist()
        if not trigger_idx:
            continue
        i = int(trigger_idx[0])
        if i + 1 >= len(g):
            continue
        entry_time = pd.Timestamp(g.loc[i, "local_ts"])
        entry_price = first5_high
        path_after = g.iloc[i + 1 :].copy()
        if path_after.empty:
            continue

        stop_pct = min(max(float(m["prior_atr_pct"]) * 0.50, 0.01), 0.04)
        mfe = float(path_after["high"].max() / entry_price - 1.0)
        mae = float(1.0 - path_after["low"].min() / entry_price)

        for target in TARGETS:
            stop_price = entry_price * (1.0 - stop_pct)
            target_price = entry_price * (1.0 + target)
            exit_price = float(path_after.iloc[-1]["close"])
            exit_time = pd.Timestamp(path_after.iloc[-1]["local_ts"])
            exit_reason = "EOD_CLOSE"

            for row in path_after.itertuples(index=False):
                stop_hit = float(row.low) <= stop_price
                target_hit = float(row.high) >= target_price
                if stop_hit:
                    exit_price = stop_price
                    exit_time = pd.Timestamp(row.local_ts)
                    exit_reason = "ATR_STOP"
                    break
                if target_hit:
                    exit_price = target_price
                    exit_time = pd.Timestamp(row.local_ts)
                    exit_reason = f"TP_{int(target * 100)}"
                    break

            gross = exit_price / entry_price - 1.0
            records.append({
                "date": key[1],
                "symbol": key[0],
                "targetPct": target,
                "entryTime": entry_time.isoformat(),
                "entryPrice": entry_price,
                "exitTime": exit_time.isoformat(),
                "exitPrice": exit_price,
                "exitReason": exit_reason,
                "grossReturn": gross,
                "netReturn": gross - COST,
                "MFE": mfe,
                "MAE": mae,
                "gap": float(m["gap"]),
                "earlyRvol": float(m["earlyRvol"]),
                "prior_dollar_volume20": float(m["prior_dollar_volume20"]),
                "ret5_prev": float(m["ret5_prev"]) if m["ret5_prev"] is not None else None,
                "prior_atr_pct": float(m["prior_atr_pct"]),
                "first5_high": first5_high,
                "first5_low": float(m["first5_low"]),
                "candidateScore": float(m["candidateScore"]),
            })
    return records


def name_for(gap_min: float, rvol_min: float, top_n: int, target: float) -> str:
    return f"GAP{int(gap_min*100)}_RVOL{int(rvol_min)}_TOP{top_n}_TP{int(target*100)}"


def select_pairs(candidates: pl.DataFrame, gap_min: float, rvol_min: float, top_n: int) -> pl.DataFrame:
    return (
        candidates.filter(
            (pl.col("gap") >= gap_min)
            & (pl.col("earlyRvol") >= rvol_min)
        )
        .sort(["date", "candidateScore"], descending=[False, True])
        .group_by("date", maintain_order=True)
        .head(top_n)
        .select(["date", "symbol"])
        .unique()
    )


def selection_key(metrics: dict, name: str) -> tuple:
    months_total = max(int(metrics.get("monthsTotal") or 0), 1)
    return (
        float(metrics.get("monthsPositive") or 0) / months_total,
        float(metrics.get("months3pctPlus") or 0) / months_total,
        float(metrics.get("totalReturn") or 0.0),
        float(metrics.get("profitFactor") or 0.0),
        -float(metrics.get("mdd") or 0.0),
        int(metrics.get("tradeCount") or 0),
        name,
    )


def pass_gate(metrics: dict) -> dict:
    checks = {
        "positiveReturn": float(metrics.get("totalReturn") or 0.0) > 0,
        "profitFactorAbove1": float(metrics.get("profitFactor") or 0.0) > 1.0,
        "positiveMonthRateAtLeast50pct": float(metrics.get("positiveMonthRate") or 0.0) >= 0.50,
        "mddAtMost35pct": float(metrics.get("mdd") or 1.0) <= 0.35,
        "atLeast50Trades": int(metrics.get("tradeCount") or 0) >= 50,
    }
    return {"pass": all(checks.values()), "checks": checks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    daily_frames = []
    with tempfile.TemporaryDirectory() as td:
        temp = Path(td)
        for idx, month in enumerate(census._month_iter(census.START, census.END_EXCLUSIVE), 1):
            path = temp / f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            census._download_us_month(month, path)
            frame = daily_summary(path)
            if frame.height:
                daily_frames.append(frame)
            print(json.dumps({"dailyMonthDone": month.strftime("%Y-%m"), "rows": frame.height, "index": idx}), flush=True)
            path.unlink(missing_ok=True)

        daily = add_daily_features(pl.concat(daily_frames, how="vertical"))
        candidates = broad_candidates(daily)
        market_dates = daily.select("date").unique().sort("date").get_column("date").to_list()
        pre_dates = [d for d in market_dates if d < BOUNDARY]
        test_dates = [d for d in market_dates if d >= BOUNDARY]

        print(json.dumps({
            "broadCandidates": candidates.height,
            "candidateSymbols": candidates.select("symbol").n_unique(),
            "candidateDates": candidates.select("date").n_unique(),
        }), flush=True)

        replay_records = []
        for idx, month in enumerate(census._month_iter(census.START, census.END_EXCLUSIVE), 1):
            month_start = month.date()
            month_end = (month + pd.offsets.MonthBegin(1)).date()
            month_candidates = candidates.filter(
                (pl.col("date") >= pl.lit(month_start))
                & (pl.col("date") < pl.lit(month_end))
            )
            if month_candidates.is_empty():
                continue
            path = temp / f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            census._download_us_month(month, path)
            records = replay_month(path, month_candidates)
            replay_records.extend(records)
            print(json.dumps({
                "replayMonthDone": month.strftime("%Y-%m"),
                "candidateRows": month_candidates.height,
                "tradeTargetRows": len(records),
                "totalTradeTargetRows": len(replay_records),
                "index": idx,
            }), flush=True)
            path.unlink(missing_ok=True)

    replay = pl.DataFrame(replay_records) if replay_records else pl.DataFrame()
    if replay.is_empty():
        raise RuntimeError("NO_US_INTRADAY_REPLAY_TRADES")

    grid = []
    ledgers = {}
    reports = {}
    for gap_min in GAP_MINS:
        for rvol_min in RVOL_MINS:
            for top_n in TOP_NS:
                pairs = select_pairs(candidates, gap_min, rvol_min, top_n)
                for target in TARGETS:
                    name = name_for(gap_min, rvol_min, top_n, target)
                    trades = (
                        replay.filter(pl.col("targetPct") == target)
                        .join(pairs, on=["date", "symbol"], how="inner")
                        .with_columns([
                            pl.lit("US_STOCK").alias("market"),
                            pl.lit("LONG").alias("direction"),
                            pl.lit(name).alias("candidate"),
                            pl.lit(COST).alias("roundTripCost"),
                        ])
                        .sort(["date", "symbol"])
                    )
                    train = trades.filter(pl.col("date") < pl.lit(BOUNDARY))
                    held = trades.filter(pl.col("date") >= pl.lit(BOUNDARY))
                    tm = v1.metrics(train, "US_STOCK", pre_dates)
                    hm = v1.metrics(held, "US_STOCK", test_dates)
                    fm = v1.metrics(trades, "US_STOCK", market_dates)
                    eligible = int(tm.get("tradeCount") or 0) >= 100 and int(tm.get("activeDays") or 0) >= 60
                    ledgers[name] = trades
                    reports[name] = {
                        "candidate": name,
                        "gapMin": gap_min,
                        "earlyRvolMin": rvol_min,
                        "topN": top_n,
                        "targetPct": target,
                        "eligibleForSelection": eligible,
                        "trainFirstTwoYears": tm,
                        "heldoutLastYear": hm,
                        "observedThreeYear": fm,
                    }
                    grid.append({
                        "candidate": name,
                        "gapMin": gap_min,
                        "earlyRvolMin": rvol_min,
                        "topN": top_n,
                        "targetPct": target,
                        "eligibleForSelection": eligible,
                        "trainReturn": tm.get("totalReturn"),
                        "trainMdd": tm.get("mdd"),
                        "trainProfitFactor": tm.get("profitFactor"),
                        "trainPositiveMonthRate": tm.get("positiveMonthRate"),
                        "trainTrades": tm.get("tradeCount"),
                        "heldoutReturn": hm.get("totalReturn"),
                        "heldoutMdd": hm.get("mdd"),
                        "heldoutProfitFactor": hm.get("profitFactor"),
                        "heldoutPositiveMonthRate": hm.get("positiveMonthRate"),
                        "heldoutTrades": hm.get("tradeCount"),
                    })

    eligible_names = [r["candidate"] for r in grid if r["eligibleForSelection"]]
    if not eligible_names:
        raise RuntimeError("NO_ELIGIBLE_US_V3_CANDIDATES")
    winner = sorted(
        eligible_names,
        key=lambda n: selection_key(reports[n]["trainFirstTwoYears"], n),
        reverse=True,
    )[0]
    selected = reports[winner]
    selected["heldoutGate"] = pass_gate(selected["heldoutLastYear"])
    trades = ledgers[winner]

    pd.DataFrame(grid).sort_values(
        ["trainPositiveMonthRate", "trainReturn"],
        ascending=[False, False],
    ).to_csv(out / "candidate-grid.csv", index=False)

    ledger_cols = [
        "date", "symbol", "direction", "candidate",
        "entryTime", "entryPrice", "exitTime", "exitPrice", "exitReason",
        "grossReturn", "roundTripCost", "netReturn", "MFE", "MAE",
        "gap", "earlyRvol", "prior_dollar_volume20", "ret5_prev",
        "prior_atr_pct", "first5_high", "first5_low", "candidateScore",
    ]
    trades.select(ledger_cols).write_csv(out / "selected-ledger.csv")
    trades.select(ledger_cols).write_parquet(out / "selected-ledger.parquet", compression="zstd")
    v1.write_portfolio_series(trades, market_dates, out)

    report = {
        "schemaVersion": 1,
        "contract": "us-intraday-gap-rvol-orb-v3",
        "period": {
            "start": str(census.START.date()),
            "endExclusive": str(census.END_EXCLUSIVE.date()),
            "selectionHistoryEndExclusive": str(BOUNDARY),
            "heldoutStart": str(BOUNDARY),
        },
        "strategy": {
            "market": "US_STOCK",
            "direction": "LONG_ONLY",
            "signal": "gap up + first-5-minute RVOL + first-5-minute high breakout",
            "gapGrid": list(GAP_MINS),
            "earlyRvolGrid": list(RVOL_MINS),
            "topNGrid": list(TOP_NS),
            "targetGrid": list(TARGETS),
            "liquidity": "prior 20-session average dollar volume >= $10M",
            "price": "open >= $2",
            "entry": "breakout stop at first-5-minute high; exit evaluation begins next minute",
            "stop": "0.5x prior daily ATR%, clipped 1-4%",
            "ambiguity": "STOP_FIRST within each one-minute bar",
            "roundTripCost": COST,
            "leverage": "NONE",
        },
        "broadCandidateRows": candidates.height,
        "selected": selected,
        "truthBoundary": {
            "lookaheadInSignal": False,
            "entryAfterFiveMinutes": True,
            "oneMinuteReplay": True,
            "triggerMinuteExcludedFromExitEvaluation": True,
            "heldoutUsedForSelection": False,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "summary.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": report}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
