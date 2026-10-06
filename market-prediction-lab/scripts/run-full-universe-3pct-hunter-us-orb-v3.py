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

TRAIN_END = pd.Timestamp("2024-10-01").date()
VALID_END = pd.Timestamp("2025-04-01").date()
END = pd.Timestamp("2026-04-01").date()

GAPS = (0.02, 0.04, 0.06)
FIRST5_RVOLS = (1.5, 2.5, 4.0)
FIRST5_RETURNS = (0.00, 0.01)
TOP_NS = (1, 3, 5)
TARGETS = (0.03, 0.05)
STOPS = (0.015, 0.025)
BREAKOUT_CONFIRM = 0.0005
ENTRY_SLIPPAGE = 0.0005
COST = 0.002


def aggregate_month(path: Path) -> pl.DataFrame:
    con = duckdb.connect()
    q = f"""
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
      SELECT *, CAST(local_ts AS DATE) AS date, CAST(local_ts AS TIME) AS local_time
      FROM bars
      WHERE CAST(local_ts AS TIME) >= TIME '09:30:00'
        AND CAST(local_ts AS TIME) < TIME '16:00:00'
        AND regexp_matches(symbol, '^[A-Z][A-Z0-9.\\-]{{0,9}}$')
    )
    SELECT
      symbol,
      date,
      arg_min(open, local_ts) AS open,
      arg_max(close, local_ts) AS close,
      sum(volume) AS volume,
      sum(close * volume) AS dollar_volume,
      max(high) FILTER (WHERE local_time < TIME '09:35:00') AS first5_high,
      min(low) FILTER (WHERE local_time < TIME '09:35:00') AS first5_low,
      arg_max(close, local_ts) FILTER (WHERE local_time < TIME '09:35:00') AS first5_close,
      sum(volume) FILTER (WHERE local_time < TIME '09:35:00') AS first5_volume
    FROM regular
    GROUP BY symbol, date
    """
    out = pl.from_arrow(con.execute(q).fetch_arrow_table())
    con.close()
    return out


def build_daily_features() -> pl.DataFrame:
    frames = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        for idx, month in enumerate(census._month_iter(census.START, census.END_EXCLUSIVE), 1):
            path = root / f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            census._download_us_month(month, path)
            frame = aggregate_month(path)
            if frame.height:
                frames.append(frame)
            print(json.dumps({"usOrbPhase1Month":month.strftime("%Y-%m"),"rows":frame.height,"index":idx}), flush=True)
            path.unlink(missing_ok=True)
    if len(frames) < 34:
        raise RuntimeError(f"US_ORB_MONTH_COVERAGE_TOO_LOW:{len(frames)}")

    x = pl.concat(frames, how="vertical").sort(["symbol","date"])
    x = x.with_columns([
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("dollar_volume").shift(1).rolling_mean(20, min_samples=10).over("symbol").alias("priorDollar20"),
        pl.col("first5_volume").shift(1).rolling_mean(20, min_samples=10).over("symbol").alias("priorFirst5Vol20"),
    ])
    x = x.with_columns([
        (pl.col("open") / pl.col("prev_close") - 1.0).alias("gap"),
        (pl.col("first5_volume") / pl.col("priorFirst5Vol20")).alias("first5Rvol"),
        (pl.col("first5_close") / pl.col("open") - 1.0).alias("first5Return"),
        ((pl.col("first5_high") - pl.col("first5_low")) / pl.col("open")).alias("first5RangePct"),
    ])
    return x.filter(
        pl.col("gap").is_not_null()
        & pl.col("first5Rvol").is_not_null()
        & pl.col("first5Return").is_not_null()
        & (pl.col("open") >= 2.0)
        & (pl.col("priorDollar20") >= 10_000_000)
    )


def broad_candidates(daily: pl.DataFrame) -> pl.DataFrame:
    x = daily.filter(
        (pl.col("gap") >= min(GAPS))
        & (pl.col("gap") <= 0.30)
        & (pl.col("first5Rvol") >= min(FIRST5_RVOLS))
        & (pl.col("first5Return") >= min(FIRST5_RETURNS))
    )
    return x.with_columns(pl.col("date").dt.strftime("%Y-%m").alias("month"))


def replay_month(path: Path, cand: pl.DataFrame) -> list[dict]:
    if cand.is_empty():
        return []
    join = cand.select(["symbol","date","first5_high"]).unique()
    con = duckdb.connect()
    con.register("candidate_days", join.to_arrow())
    q = f"""
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
      SELECT *, CAST(local_ts AS DATE) AS date, CAST(local_ts AS TIME) AS local_time
      FROM bars
      WHERE CAST(local_ts AS TIME) >= TIME '09:35:00'
        AND CAST(local_ts AS TIME) < TIME '16:00:00'
    )
    SELECT r.symbol,r.date,r.local_ts,r.open,r.high,r.low,r.close,c.first5_high
    FROM regular r
    INNER JOIN candidate_days c
      ON r.symbol=c.symbol AND r.date=c.date
    ORDER BY r.symbol,r.date,r.local_ts
    """
    pdf = con.execute(q).df()
    con.close()
    if pdf.empty:
        return []

    out = []
    for (symbol, date), g in pdf.groupby(["symbol","date"], sort=False):
        g = g.sort_values("local_ts").reset_index(drop=True)
        threshold = float(g["first5_high"].iloc[0]) * (1.0 + BREAKOUT_CONFIRM)
        trigger_idx = None
        for i, row in g.iterrows():
            if float(row["close"]) >= threshold:
                trigger_idx = i
                break
        if trigger_idx is None or trigger_idx + 1 >= len(g):
            continue

        entry_idx = trigger_idx + 1
        entry_row = g.iloc[entry_idx]
        entry = float(entry_row["open"]) * (1.0 + ENTRY_SLIPPAGE)
        if entry <= 0:
            continue
        future = g.iloc[entry_idx:]
        mfe = float(future["high"].max()) / entry - 1.0
        mae = 1.0 - float(future["low"].min()) / entry

        for target in TARGETS:
            for stop in STOPS:
                stop_price = entry * (1.0 - stop)
                target_price = entry * (1.0 + target)
                exit_price = float(future["close"].iloc[-1])
                exit_reason = "EOD"
                exit_time = future["local_ts"].iloc[-1]
                for _, bar in future.iterrows():
                    if float(bar["low"]) <= stop_price:
                        exit_price = stop_price
                        exit_reason = "STOP"
                        exit_time = bar["local_ts"]
                        break
                    if float(bar["high"]) >= target_price:
                        exit_price = target_price
                        exit_reason = "TARGET"
                        exit_time = bar["local_ts"]
                        break
                gross = exit_price / entry - 1.0
                out.append({
                    "date": pd.Timestamp(date).date(),
                    "symbol": symbol,
                    "targetPct": target,
                    "stopPct": stop,
                    "entryPrice": entry,
                    "exitPrice": exit_price,
                    "grossReturn": gross,
                    "netReturn": gross - COST,
                    "MFE": mfe,
                    "MAE": mae,
                    "triggerTime": str(g.iloc[trigger_idx]["local_ts"]),
                    "entryTime": str(entry_row["local_ts"]),
                    "exitTime": str(exit_time),
                    "exitReason": exit_reason,
                })
    return out


def build_outcomes(broad: pl.DataFrame) -> pl.DataFrame:
    rows = []
    by_month = {m: x for m, x in broad.partition_by("month", as_dict=True).items()}
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        for idx, month in enumerate(census._month_iter(census.START, census.END_EXCLUSIVE), 1):
            key = (month.strftime("%Y-%m"),)
            cand = by_month.get(key)
            if cand is None or cand.is_empty():
                continue
            path = root / f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            census._download_us_month(month, path)
            month_rows = replay_month(path, cand)
            rows.extend(month_rows)
            print(json.dumps({"usOrbPhase2Month":month.strftime("%Y-%m"),"candidateDays":cand.height,"outcomes":len(month_rows),"totalOutcomes":len(rows),"index":idx}), flush=True)
            path.unlink(missing_ok=True)
    if not rows:
        raise RuntimeError("US_ORB_NO_REPLAY_OUTCOMES")
    return pl.DataFrame(rows).with_columns(pl.col("date").cast(pl.Date))


def rank_daily(x: pl.DataFrame, top_n: int) -> pl.DataFrame:
    if x.is_empty():
        return x
    return (
        x.with_columns([
            pl.col("gap").rank("average", descending=True).over("date").alias("r1"),
            pl.col("first5Rvol").rank("average", descending=True).over("date").alias("r2"),
            pl.col("first5Return").rank("average", descending=True).over("date").alias("r3"),
            pl.col("priorDollar20").rank("average", descending=True).over("date").alias("r4"),
        ])
        .with_columns((-(pl.col("r1")+pl.col("r2")+pl.col("r3")+pl.col("r4"))).alias("score"))
        .sort(["date","score"], descending=[False,True])
        .group_by("date", maintain_order=True)
        .head(top_n)
    )


def gate(m: dict, min_trades: int) -> dict:
    checks = {
        "positiveReturn": float(m.get("totalReturn") or 0.0) > 0,
        "profitFactorAbove1": float(m.get("profitFactor") or 0.0) > 1,
        "positiveMonthRateAtLeast50pct": float(m.get("positiveMonthRate") or 0.0) >= 0.50,
        "mddAtMost35pct": float(m.get("mdd") or 1.0) <= 0.35,
        "minimumTrades": int(m.get("tradeCount") or 0) >= min_trades,
    }
    return {"pass": all(checks.values()), "checks": checks}


def rank_key(m: dict, name: str):
    return (
        float(m.get("positiveMonthRate") or 0.0),
        float(m.get("totalReturn") or 0.0),
        float(m.get("profitFactor") or 0.0),
        -float(m.get("mdd") or 0.0),
        int(m.get("tradeCount") or 0),
        name,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    daily = build_daily_features()
    broad = broad_candidates(daily)
    outcomes = build_outcomes(broad)
    all_dates = daily.select("date").unique().sort("date").get_column("date").to_list()
    train_dates = [d for d in all_dates if d < TRAIN_END]
    valid_dates = [d for d in all_dates if TRAIN_END <= d < VALID_END]
    bench_dates = [d for d in all_dates if VALID_END <= d < END]

    grid = []
    reports = {}
    for gap in GAPS:
        for rv in FIRST5_RVOLS:
            for strength in FIRST5_RETURNS:
                base = daily.filter(
                    (pl.col("gap") >= gap)
                    & (pl.col("gap") <= 0.30)
                    & (pl.col("first5Rvol") >= rv)
                    & (pl.col("first5Return") >= strength)
                )
                for top_n in TOP_NS:
                    selected = rank_daily(base, top_n)
                    for target in TARGETS:
                        for stop in STOPS:
                            name = f"US_ORB_G{int(gap*100)}_RV{rv:g}_F5{int(strength*100)}_TOP{top_n}_TP{int(target*100)}_SL{int(stop*1000)/10:g}"
                            trades = (
                                selected.join(
                                    outcomes.filter((pl.col("targetPct")==target) & (pl.col("stopPct")==stop)),
                                    on=["date","symbol"],
                                    how="inner",
                                )
                                .with_columns([
                                    pl.lit("US_STOCK").alias("market"),
                                    pl.lit("LONG").alias("direction"),
                                    pl.lit(name).alias("candidate"),
                                    pl.lit(COST).alias("roundTripCost"),
                                ])
                            )
                            train = trades.filter(pl.col("date") < pl.lit(TRAIN_END))
                            valid = trades.filter((pl.col("date") >= pl.lit(TRAIN_END)) & (pl.col("date") < pl.lit(VALID_END)))
                            bench = trades.filter((pl.col("date") >= pl.lit(VALID_END)) & (pl.col("date") < pl.lit(END)))
                            mt = v1.metrics(train, "US_STOCK", train_dates)
                            mv = v1.metrics(valid, "US_STOCK", valid_dates)
                            mb = v1.metrics(bench, "US_STOCK", bench_dates)
                            gt, gv = gate(mt,40), gate(mv,15)
                            reports[name]={"trades":trades,"train":mt,"validation":mv,"benchmark":mb,"trainGate":gt,"validationGate":gv}
                            grid.append({
                                "candidate":name,"gapMin":gap,"first5RvolMin":rv,"first5ReturnMin":strength,"topN":top_n,"target":target,"stop":stop,
                                "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                                "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                                "benchmarkReturn":mb.get("totalReturn"),"benchmarkPF":mb.get("profitFactor"),"benchmarkMDD":mb.get("mdd"),"benchmarkPosMonthRate":mb.get("positiveMonthRate"),"benchmarkTrades":mb.get("tradeCount"),
                            })

    train_pass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    valid_pass=[n for n in train_pass if reports[n]["validationGate"]["pass"]]
    winner=None
    if valid_pass:
        winner=sorted(valid_pass,key=lambda n:rank_key(reports[n]["validation"],n),reverse=True)[0]

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    summary={
        "schemaVersion":1,
        "contract":"full-universe-3pct-hunter-us-orb-v3",
        "periods":{"train":["2023-04-01",str(TRAIN_END)],"validation":[str(TRAIN_END),str(VALID_END)],"benchmarkReusedObservedDataset":[str(VALID_END),str(END)]},
        "candidateCount":len(grid),
        "broadCandidateDays":broad.height,
        "replayedOutcomeRows":outcomes.height,
        "trainPassCount":len(train_pass),
        "validationPassCount":len(valid_pass),
        "winner":winner,
        "truthBoundary":{
            "entryAfterFiveMinuteWindow":True,
            "breakoutConfirmedOnOneMinuteClose":True,
            "entryNextMinuteOpen":True,
            "minuteOrderUsedAfterEntry":True,
            "freshPost2026MarchIntradayOosAvailable":False,
            "benchmarkLastYearPreviouslyObservedInEarlierResearch":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    if winner:
        d=reports[winner]
        summary["winnerResults"]={"train":d["train"],"trainGate":d["trainGate"],"validation":d["validation"],"validationGate":d["validationGate"],"benchmark":d["benchmark"]}
        cols=["market","date","symbol","direction","candidate","entryPrice","exitPrice","grossReturn","roundTripCost","netReturn","MFE","MAE","triggerTime","entryTime","exitTime","exitReason","gap","first5Rvol","first5Return","first5RangePct","priorDollar20"]
        d["trades"].select(cols).write_csv(out/"winner-ledger.csv")
        d["trades"].select(cols).write_parquet(out/"winner-ledger.parquet",compression="zstd")

    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
