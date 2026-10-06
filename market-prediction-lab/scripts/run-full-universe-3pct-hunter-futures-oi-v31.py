#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import io
import json
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import requests

ROOT = Path(__file__).resolve().parents[2]
FLOW_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-crypto-flow-v3.py"
SPEC = importlib.util.spec_from_file_location("crypto_flow_v3", FLOW_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("FLOW_V3_IMPORT_FAILED")
flow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(flow)
v1 = flow.v1

MARKET = "CRYPTO_FUTURES"
BASE_TOP_NS = (1, 3)
TARGET = 0.05
STOP = 0.015
HOLD = 32
TRAIN_END = flow.TRAIN_END
VALID_END = flow.VALID_END
OOS_END = flow.OOS_END

OVERLAYS = {
    "OI15_NONNEG": lambda x: x["oi15"] >= 0.0,
    "OI15_GT_0_3": lambda x: x["oi15"] >= 0.003,
    "OI60_NONNEG": lambda x: x["oi60"] >= 0.0,
    "OI60_GT_0_5": lambda x: x["oi60"] >= 0.005,
    "OI15_LT_NEG_0_3": lambda x: x["oi15"] <= -0.003,
    "OI60_LT_NEG_0_5": lambda x: x["oi60"] <= -0.005,
    "TOP_POS_SHORT": lambda x: x["topPosRatio"] <= 1.0,
    "CROWD_LONG_TOP_SHORT": lambda x: (x["allAccountRatio"] >= 1.0) & (x["topPosRatio"] <= 1.0),
    "OI60_NONNEG_TOP_SHORT": lambda x: (x["oi60"] >= 0.0) & (x["topPosRatio"] <= 1.0),
    "OI60_GT_0_5_TOP_SHORT": lambda x: (x["oi60"] >= 0.005) & (x["topPosRatio"] <= 1.0),
    "OI15_GT_0_3_CROWD_LONG": lambda x: (x["oi15"] >= 0.003) & (x["allAccountRatio"] >= 1.0),
}


def metrics_url(symbol: str, date) -> str:
    d = pd.Timestamp(date).strftime("%Y-%m-%d")
    return f"https://data.binance.vision/data/futures/um/daily/metrics/{symbol}/{symbol}-metrics-{d}.zip"


def fetch_metrics(symbol: str, date):
    url = metrics_url(symbol, date)
    last = None
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=45, headers={"User-Agent":"market-prediction-lab/futures-oi-v31"})
            if r.status_code == 404:
                return (symbol, str(date)), None, "404"
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
                names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
                if not names:
                    return (symbol, str(date)), None, "NO_CSV"
                df = pd.read_csv(zf.open(names[0]))
            needed = [
                "create_time","sum_open_interest","sum_open_interest_value",
                "count_toptrader_long_short_ratio","sum_toptrader_long_short_ratio",
                "count_long_short_ratio","sum_taker_long_short_vol_ratio",
            ]
            if not all(c in df.columns for c in needed):
                return (symbol, str(date)), None, f"BAD_SCHEMA:{list(df.columns)}"
            df["create_time"] = pd.to_datetime(df["create_time"], utc=True, errors="coerce")
            for c in needed[1:]:
                df[c] = pd.to_numeric(df[c], errors="coerce")
            df = df.dropna(subset=needed).sort_values("create_time").reset_index(drop=True)
            return (symbol, str(date)), df, None
        except Exception as exc:
            last = exc
            time.sleep(min(2 + 2 * attempt, 8))
    return (symbol, str(date)), None, repr(last)


def enrich_oi(trades: pl.DataFrame) -> tuple[pl.DataFrame, dict]:
    if trades.is_empty():
        return trades, {"requestedFiles":0,"usableFiles":0,"failedFiles":0}

    base = trades.with_columns(
        (pl.col("timestamp") + pl.duration(minutes=15)).alias("signalCloseTime")
    )
    keys = (
        base.select(["symbol","date"]).unique()
        .to_dicts()
    )

    cache = {}
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futs = {
            pool.submit(fetch_metrics, str(k["symbol"]), k["date"]):(str(k["symbol"]),str(k["date"]))
            for k in keys
        }
        for idx, fut in enumerate(concurrent.futures.as_completed(futs),1):
            key, df, err = fut.result()
            if df is not None and not df.empty:
                cache[key] = df
            else:
                failures.append({"symbol":key[0],"date":key[1],"error":err})
            if idx % 250 == 0 or idx == len(futs):
                print(json.dumps({
                    "oiFilesComplete":idx,
                    "requested":len(futs),
                    "usable":len(cache),
                    "failed":len(failures),
                }),flush=True)

    rows = []
    for row in base.to_dicts():
        key = (str(row["symbol"]), str(row["date"]))
        df = cache.get(key)
        if df is None or df.empty:
            continue
        t = pd.Timestamp(row["signalCloseTime"])
        if t.tzinfo is None:
            t = t.tz_localize("UTC")
        else:
            t = t.tz_convert("UTC")

        times = df["create_time"].to_numpy(dtype="datetime64[ns]")
        target = np.datetime64(t.tz_localize(None).to_datetime64())
        pos = int(np.searchsorted(times, target, side="right") - 1)
        if pos < 12:
            continue

        cur = df.iloc[pos]
        p15 = df.iloc[pos-3]
        p60 = df.iloc[pos-12]
        oi = float(cur["sum_open_interest"])
        oi15base = float(p15["sum_open_interest"])
        oi60base = float(p60["sum_open_interest"])
        if oi15base <= 0 or oi60base <= 0:
            continue

        row.update({
            "oi": oi,
            "oiValue": float(cur["sum_open_interest_value"]),
            "oi15": oi / oi15base - 1.0,
            "oi60": oi / oi60base - 1.0,
            "topAccountRatio": float(cur["count_toptrader_long_short_ratio"]),
            "topPosRatio": float(cur["sum_toptrader_long_short_ratio"]),
            "allAccountRatio": float(cur["count_long_short_ratio"]),
            "metricTakerLongShortRatio": float(cur["sum_taker_long_short_vol_ratio"]),
        })
        rows.append(row)

    if not rows:
        raise RuntimeError("OI_ENRICHMENT_EMPTY")
    out = pl.DataFrame(rows)
    coverage = len(rows) / max(base.height,1)
    if coverage < 0.80:
        raise RuntimeError(f"OI_SIGNAL_COVERAGE_TOO_LOW:{len(rows)}/{base.height}")
    return out, {
        "requestedFiles":len(keys),
        "usableFiles":len(cache),
        "failedFiles":len(failures),
        "failurePreview":failures[:30],
        "tradeRowsBeforeOi":base.height,
        "tradeRowsWithOi":len(rows),
        "rowCoverage":coverage,
    }


def build_base_trades() -> tuple[dict[int,pl.DataFrame], dict]:
    daily = flow.load_daily_extended(MARKET)
    universe, universe_audit = flow.build_monthly_universe(daily, MARKET)
    raw, failures, requested = flow.load_intraday(MARKET, universe)
    features_pd = flow.add_features(raw)
    features = pl.from_pandas(features_pd).with_columns([
        pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")),
        pl.col("date").cast(pl.Date),
    ])

    sigs = {}
    union_frames = []
    for top_n in BASE_TOP_NS:
        s = flow.signal_frame(
            features, MARKET, "FLOW_RECLAIM", "SHORT",
            0.4, 2.5, None, top_n
        )
        if s.is_empty():
            raise RuntimeError(f"BASE_SIGNAL_EMPTY:TOP{top_n}")
        sigs[top_n] = s
        union_frames.append(s.select(["timestamp","symbol","date"]))
    union = pl.concat(union_frames,how="vertical").unique(subset=["timestamp","symbol"])
    outcomes = flow.simulate_union(features_pd, union, MARKET).filter(
        (pl.col("targetPct")==TARGET)
        & (pl.col("stopPct")==STOP)
        & (pl.col("holdBars")==HOLD)
    )

    result = {}
    for top_n,s in sigs.items():
        joined = s.join(outcomes,on=["timestamp","symbol"],how="inner")
        trades = joined.with_columns([
            pl.lit(MARKET).alias("market"),
            pl.lit("SHORT").alias("direction"),
            pl.lit(f"FLOW_RECLAIM_SHORT_T0.4_RV2.5_TOP{top_n}_TP5_SL0.015_H32").alias("baseCandidate"),
            pl.col("timestamp").dt.date().alias("date"),
            pl.col("entryPrice"),
            pl.col("shortExitPrice").alias("exitPrice"),
            pl.col("shortGross").alias("grossReturn"),
            pl.col("shortNet").alias("netReturn"),
            pl.col("shortMFE").alias("MFE"),
            pl.col("shortMAE").alias("MAE"),
            pl.col("shortExitReason").alias("exitReason"),
            pl.lit(flow.COSTS[MARKET]).alias("roundTripCost"),
        ])
        result[top_n] = trades

    return result, {
        "monthlyUniverseAudit":universe_audit,
        "requestedIntradayFiles":requested,
        "failedIntradayFiles":len(failures),
        "intradayFailurePreview":failures[:20],
        "featureRows":len(features_pd),
    }


def gate(m: dict, min_trades: int):
    checks = {
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def rank_key(m: dict, name: str):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 0),
        int(m.get("tradeCount") or 0),
        name,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True,exist_ok=True)

    base_by_top, source = build_base_trades()
    all_base = pl.concat(list(base_by_top.values()),how="vertical")
    enriched, oi_audit = enrich_oi(all_base)

    train_dates=[d.date() for d in pd.date_range("2023-05-01","2025-03-31",freq="D")]
    valid_dates=[d.date() for d in pd.date_range("2025-04-01","2026-03-31",freq="D")]
    oos_dates=[d.date() for d in pd.date_range("2026-04-01","2026-09-30",freq="D")]

    grid=[]
    reports={}
    for top_n in BASE_TOP_NS:
        base_name=f"FLOW_RECLAIM_SHORT_T0.4_RV2.5_TOP{top_n}_TP5_SL0.015_H32"
        base=enriched.filter(pl.col("baseCandidate")==base_name)
        for overlay,fn in OVERLAYS.items():
            pdf=base.to_pandas()
            mask=fn(pdf).fillna(False)
            selected=pl.from_pandas(pdf.loc[mask].copy())
            name=f"{base_name}__{overlay}"
            train=selected.filter(pl.col("date")<pl.lit(TRAIN_END))
            valid=selected.filter((pl.col("date")>=pl.lit(TRAIN_END))&(pl.col("date")<pl.lit(VALID_END)))
            mt=v1.metrics(train,MARKET,train_dates)
            mv=v1.metrics(valid,MARKET,valid_dates)
            gt,gv=gate(mt,80),gate(mv,40)
            reports[name]={"trades":selected,"train":mt,"validation":mv,"trainGate":gt,"validationGate":gv}
            grid.append({
                "candidate":name,"baseTopN":top_n,"overlay":overlay,
                "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
            })

    train_pass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    valid_pass=[n for n in train_pass if reports[n]["validationGate"]["pass"]]
    winner=sorted(valid_pass,key=lambda n:rank_key(reports[n]["validation"],n),reverse=True)[0] if valid_pass else None

    summary={
        "schemaVersion":1,
        "contract":"full-universe-3pct-hunter-futures-oi-v31",
        "periods":{"train":["2023-05-01","2025-04-01"],"validation":["2025-04-01","2026-04-01"],"freshOos":["2026-04-01","2026-10-01"]},
        "baseCandidates":[f"FLOW_RECLAIM_SHORT_T0.4_RV2.5_TOP{n}_TP5_SL0.015_H32" for n in BASE_TOP_NS],
        "overlayCount":len(OVERLAYS),
        "candidateCount":len(grid),
        "source":source,
        "oiAudit":oi_audit,
        "trainPassCount":len(train_pass),
        "validationPassCount":len(valid_pass),
        "winner":winner,
        "freshOosEvaluated":False,
        "truthBoundary":{
            "oiJoinedAtOrBeforeSignalBarClose":True,
            "oi15AndOi60UseOnlyPastMetrics":True,
            "freshOosUsedForOverlaySelection":False,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)

    if winner:
        d=reports[winner]
        oos=d["trades"].filter((pl.col("date")>=pl.lit(VALID_END))&(pl.col("date")<pl.lit(OOS_END)))
        mo=v1.metrics(oos,MARKET,oos_dates)
        go=gate(mo,20)
        summary["freshOosEvaluated"]=True
        summary["winnerResults"]={
            "train":d["train"],"trainGate":d["trainGate"],
            "validation":d["validation"],"validationGate":d["validationGate"],
            "freshOos":mo,"freshOosGate":go,
        }
        cols=["market","date","timestamp","symbol","direction","baseCandidate","entryPrice","exitPrice","grossReturn","roundTripCost","netReturn","MFE","MAE","exitReason",
              "flow4","rvol","ret4","takerRatio","vwap96","oi","oiValue","oi15","oi60","topAccountRatio","topPosRatio","allAccountRatio","metricTakerLongShortRatio"]
        d["trades"].select(cols).write_csv(out/"winner-ledger.csv")
        d["trades"].select(cols).write_parquet(out/"winner-ledger.parquet",compression="zstd")

    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
