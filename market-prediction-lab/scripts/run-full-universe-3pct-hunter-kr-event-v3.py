#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import re
import time
from io import StringIO
from pathlib import Path

import pandas as pd
import polars as pl
import requests

ROOT = Path(__file__).resolve().parents[2]
V1_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC = importlib.util.spec_from_file_location("hunter_v1", V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v1)

START = pd.Timestamp("2023-04-01").date()
TRAIN_END = pd.Timestamp("2025-04-01").date()
VALID_END = pd.Timestamp("2026-04-01").date()
OOS_END = pd.Timestamp("2026-10-01").date()
NAVER_URL = "https://fchart.stock.naver.com/sise.nhn?timeframe=day&count=6000&requestType=0&symbol="

EVENT_RETURNS = (0.05, 0.10, 0.15)
RVOLS = (1.5, 2.5, 4.0)
CLOSE_POSITIONS = (0.80, 0.90)
TOP_NS = (1, 3, 5)
TARGETS = (0.03, 0.05)
STOPS = (0.02, 0.03)
COST = 0.003


def fetch_symbol(symbol: str):
    last = None
    for attempt in range(4):
        try:
            r = requests.get(
                NAVER_URL + symbol,
                timeout=30,
                headers={"User-Agent": "market-prediction-lab/kr-event-v3"},
            )
            r.raise_for_status()
            items = re.findall(r'<item data="(.*?)" />', r.text, re.DOTALL)
            if not items:
                return symbol, []
            df = pd.read_csv(
                StringIO("\n".join(items)),
                delimiter="|",
                header=None,
                names=["Date","Open","High","Low","Close","Volume"],
                dtype={"Date": str},
            )
            df["date"] = pd.to_datetime(df["Date"], format="%Y%m%d", errors="coerce").dt.date
            for c in ["Open","High","Low","Close","Volume"]:
                df[c] = pd.to_numeric(df[c], errors="coerce")
            df = df.dropna()
            df = df[
                (df["date"] >= START) & (df["date"] < OOS_END)
                & (df["Open"] > 0) & (df["High"] > 0) & (df["Low"] > 0)
                & (df["Close"] > 0) & (df["Volume"] >= 0)
            ]
            rows = [
                (symbol, x.date, float(x.Open), float(x.High), float(x.Low), float(x.Close), float(x.Volume))
                for x in df[["date","Open","High","Low","Close","Volume"]].itertuples(index=False)
            ]
            return symbol, rows
        except Exception as exc:
            last = exc
            time.sleep(min(1.5 * (attempt + 1), 6))
    raise RuntimeError(f"NAVER_FETCH_FAILED:{symbol}:{last}")


def load_kr_extended() -> tuple[pl.DataFrame, dict]:
    universe, delisted, market_map, meta = v1.census._build_kr_frozen_universe()
    all_rows = []
    failed = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_symbol, s): s for s in universe}
        for idx, fut in enumerate(concurrent.futures.as_completed(futures), 1):
            sym = futures[fut]
            try:
                _, rows = fut.result()
            except Exception as exc:
                rows = []
                failed.append({"symbol": sym, "error": str(exc)[:240]})
            if rows:
                all_rows.extend(rows)
            elif not any(x["symbol"] == sym for x in failed):
                failed.append({"symbol": sym, "error": "NO_ROWS"})
            if idx % 250 == 0 or idx == len(universe):
                print(json.dumps({
                    "krV3FetchComplete": idx,
                    "universe": len(universe),
                    "rows": len(all_rows),
                    "failed": len(failed),
                }), flush=True)

    frame = pl.DataFrame(
        all_rows,
        schema=["symbol","date","open","high","low","close","volume"],
        orient="row",
    ).unique(subset=["symbol","date"], keep="last").sort(["symbol","date"])
    usable = frame.select("symbol").n_unique()
    if usable < 2950:
        raise RuntimeError(f"KR_V3_PRICE_COVERAGE_TOO_LOW:{usable}/{len(universe)}")
    if frame.filter(pl.col("date") >= pl.lit(VALID_END)).select("date").n_unique() < 115:
        raise RuntimeError("KR_V3_OOS_DATE_COVERAGE_TOO_LOW")
    return frame, {
        **meta,
        "provider": "frozen KRX 2026-03-31 universe + NAVER daily",
        "coverageMode": "KR_EVENT_V3_RESEARCH_PLUS_FRESH_2026_04_TO_09_OOS",
        "usableSymbols": usable,
        "failedSymbols": len(failed),
        "failurePreview": failed[:20],
    }


def add_event_features(df: pl.DataFrame) -> pl.DataFrame:
    x = df.sort(["symbol","date"])
    x = x.with_columns([
        pl.col("open").shift(1).over("symbol").alias("prev_open"),
        pl.col("high").shift(1).over("symbol").alias("prev_high"),
        pl.col("low").shift(1).over("symbol").alias("prev_low"),
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("volume").shift(1).over("symbol").alias("prev_volume"),
        pl.col("volume").shift(2).rolling_mean(20, min_samples=10).over("symbol").alias("pre_event_vol20"),
        (pl.col("close").shift(2) * pl.col("volume").shift(2))
            .rolling_mean(20, min_samples=10).over("symbol").alias("pre_event_dollar20"),
    ])
    x = x.with_columns([
        (pl.col("prev_close") / pl.col("prev_open") - 1.0).alias("eventReturn"),
        (pl.col("prev_volume") / pl.col("pre_event_vol20")).alias("eventRvol"),
        ((pl.col("prev_close") - pl.col("prev_low")) /
         (pl.col("prev_high") - pl.col("prev_low")).clip(1e-9, None)).alias("closePosition"),
        (pl.col("prev_close") * pl.col("prev_volume")).alias("eventDollarVolume"),
    ])
    return x.filter(
        pl.col("eventReturn").is_not_null()
        & pl.col("eventRvol").is_not_null()
        & pl.col("closePosition").is_not_null()
        & (pl.col("open") >= 1000)
        & (pl.col("pre_event_dollar20") >= 1_000_000_000)
    )


def rank_candidates(x: pl.DataFrame, top_n: int) -> pl.DataFrame:
    if x.is_empty():
        return x
    return (
        x.with_columns([
            pl.col("eventReturn").rank("average", descending=True).over("date").alias("r1"),
            pl.col("eventRvol").rank("average", descending=True).over("date").alias("r2"),
            pl.col("closePosition").rank("average", descending=True).over("date").alias("r3"),
            pl.col("eventDollarVolume").rank("average", descending=True).over("date").alias("r4"),
        ])
        .with_columns((-(pl.col("r1")+pl.col("r2")+pl.col("r3")+pl.col("r4"))).alias("score"))
        .sort(["date","score"], descending=[False,True])
        .group_by("date", maintain_order=True)
        .head(top_n)
    )


def simulate(rows: pl.DataFrame, target: float, stop: float, name: str) -> pl.DataFrame:
    if rows.is_empty():
        return rows
    stop_hit = pl.col("low") <= pl.col("open") * (1.0 - stop)
    target_hit = pl.col("high") >= pl.col("open") * (1.0 + target)
    exit_price = (
        pl.when(stop_hit).then(pl.col("open") * (1.0 - stop))
        .when(target_hit).then(pl.col("open") * (1.0 + target))
        .otherwise(pl.col("close"))
    )
    gross = exit_price / pl.col("open") - 1.0
    return rows.with_columns([
        pl.lit("KR_STOCK").alias("market"),
        pl.lit("LONG").alias("direction"),
        pl.lit(name).alias("candidate"),
        pl.col("open").alias("entryPrice"),
        exit_price.alias("exitPrice"),
        pl.lit(target).alias("targetPct"),
        pl.lit(stop).alias("stopPct"),
        stop_hit.alias("stopHit"),
        target_hit.alias("targetHit"),
        pl.when(stop_hit).then(pl.lit("STOP"))
          .when(target_hit).then(pl.lit("TARGET"))
          .otherwise(pl.lit("EOD")).alias("exitReason"),
        pl.lit(COST).alias("roundTripCost"),
        gross.alias("grossReturn"),
        (gross - COST).alias("netReturn"),
        (pl.col("high") / pl.col("open") - 1.0).alias("MFE"),
        (1.0 - pl.col("low") / pl.col("open")).alias("MAE"),
    ])


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

    raw, source = load_kr_extended()
    x = add_event_features(raw)
    all_dates = x.select("date").unique().sort("date").get_column("date").to_list()
    train_dates = [d for d in all_dates if d < TRAIN_END]
    valid_dates = [d for d in all_dates if TRAIN_END <= d < VALID_END]
    oos_dates = [d for d in all_dates if VALID_END <= d < OOS_END]

    candidates = {}
    grid = []
    for er in EVENT_RETURNS:
        for rv in RVOLS:
            for cp in CLOSE_POSITIONS:
                base = x.filter(
                    (pl.col("eventReturn") >= er)
                    & (pl.col("eventRvol") >= rv)
                    & (pl.col("closePosition") >= cp)
                )
                for top_n in TOP_NS:
                    selected = rank_candidates(base, top_n)
                    for target in TARGETS:
                        for stop in STOPS:
                            name = f"KR_EVENT_ER{int(er*100)}_RV{rv:g}_CP{int(cp*100)}_TOP{top_n}_TP{int(target*100)}_SL{int(stop*100)}"
                            trades = simulate(selected, target, stop, name)
                            train = trades.filter(pl.col("date") < pl.lit(TRAIN_END))
                            valid = trades.filter((pl.col("date") >= pl.lit(TRAIN_END)) & (pl.col("date") < pl.lit(VALID_END)))
                            oos = trades.filter((pl.col("date") >= pl.lit(VALID_END)) & (pl.col("date") < pl.lit(OOS_END)))
                            mt = v1.metrics(train, "KR_STOCK", train_dates)
                            mv = v1.metrics(valid, "KR_STOCK", valid_dates)
                            mo = v1.metrics(oos, "KR_STOCK", oos_dates)
                            gt = gate(mt, 50)
                            gv = gate(mv, 25)
                            go = gate(mo, 12)
                            candidates[name] = {"trades":trades,"train":mt,"validation":mv,"oos":mo,"trainGate":gt,"validationGate":gv,"oosGate":go}
                            grid.append({
                                "candidate":name,"eventReturn":er,"eventRvol":rv,"closePosition":cp,"topN":top_n,"target":target,"stop":stop,
                                "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                                "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                                "oosReturn":mo.get("totalReturn"),"oosPF":mo.get("profitFactor"),"oosMDD":mo.get("mdd"),"oosPosMonthRate":mo.get("positiveMonthRate"),"oosTrades":mo.get("tradeCount"),
                            })

    train_pass = [n for n,d in candidates.items() if d["trainGate"]["pass"]]
    valid_pass = [n for n in train_pass if candidates[n]["validationGate"]["pass"]]
    winner = None
    if valid_pass:
        winner = sorted(valid_pass, key=lambda n: rank_key(candidates[n]["validation"], n), reverse=True)[0]

    pd.DataFrame(grid).to_csv(out / "candidate-grid.csv", index=False)

    summary = {
        "schemaVersion":1,
        "contract":"full-universe-3pct-hunter-kr-event-v3",
        "source":source,
        "periods":{"train":[str(START),str(TRAIN_END)],"validation":[str(TRAIN_END),str(VALID_END)],"freshOos":[str(VALID_END),str(OOS_END)]},
        "candidateCount":len(grid),
        "trainPassCount":len(train_pass),
        "validationPassCount":len(valid_pass),
        "winner":winner,
        "profitabilityProven":False,
        "executionAuthority":"NONE",
    }
    if winner:
        d = candidates[winner]
        summary["winnerResults"] = {
            "train":d["train"],"trainGate":d["trainGate"],
            "validation":d["validation"],"validationGate":d["validationGate"],
            "freshOos":d["oos"],"freshOosGate":d["oosGate"],
        }
        cols=["market","date","symbol","direction","candidate","entryPrice","exitPrice","targetPct","stopPct","roundTripCost","grossReturn","netReturn","MFE","MAE","eventReturn","eventRvol","closePosition","eventDollarVolume","exitReason"]
        d["trades"].select(cols).write_csv(out / "winner-ledger.csv")
        d["trades"].select(cols).write_parquet(out / "winner-ledger.parquet", compression="zstd")

    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({"FINAL":summary}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
