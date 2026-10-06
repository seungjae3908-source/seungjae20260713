#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import io
import json
import time
import zipfile
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import requests

ROOT = Path(__file__).resolve().parents[2]
FLOW_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-crypto-flow-v3.py"
SPEC = importlib.util.spec_from_file_location("crypto_flow_v3", FLOW_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("CRYPTO_FLOW_V3_IMPORT_FAILED")
flow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(flow)
v1 = flow.v1

MARKET = "CRYPTO_FUTURES"
TRAIN_END = flow.TRAIN_END
VALID_END = flow.VALID_END
OOS_END = flow.OOS_END

BASES = [
    {"name":"BASE_TOP1","topN":1},
    {"name":"BASE_TOP3","topN":3},
]
TARGET = 0.05
STOP = 0.015
HOLD = 32

FILTERS = {
    "TAKER_SELL": lambda x: x["metricTakerRatio"] <= 0.90,
    "OI_UP": lambda x: x["oi1h"] >= 0.005,
    "OI_DOWN": lambda x: x["oi1h"] <= -0.005,
    "CROWDED_LONG": lambda x: x["countLS"] >= 1.05,
    "TOP_LONG": lambda x: x["sumTopLS"] >= 1.05,
    "OI_UP_TAKER_SELL": lambda x: (x["oi1h"] >= 0.005) & (x["metricTakerRatio"] <= 0.90),
    "OI_DOWN_TAKER_SELL": lambda x: (x["oi1h"] <= -0.005) & (x["metricTakerRatio"] <= 0.90),
    "OI_UP_CROWDED_LONG": lambda x: (x["oi1h"] >= 0.005) & (x["countLS"] >= 1.05),
    "OI_UP_CROWDED_LONG_TAKER_SELL": lambda x: (x["oi1h"] >= 0.005) & (x["countLS"] >= 1.05) & (x["metricTakerRatio"] <= 0.90),
    "OI_DOWN_CROWDED_LONG_TAKER_SELL": lambda x: (x["oi1h"] <= -0.005) & (x["countLS"] >= 1.05) & (x["metricTakerRatio"] <= 0.90),
    "OI_UP_TOP_LONG_TAKER_SELL": lambda x: (x["oi1h"] >= 0.005) & (x["sumTopLS"] >= 1.05) & (x["metricTakerRatio"] <= 0.90),
}

def metrics_url(symbol: str, day: str) -> str:
    return f"https://data.binance.vision/data/futures/um/daily/metrics/{symbol}/{symbol}-metrics-{day}.zip"

def fetch_metrics(args):
    symbol, day = args
    url = metrics_url(symbol, day)
    last = None
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=45, headers={"User-Agent":"market-prediction-lab/oi-overlay"})
            if r.status_code == 404:
                return symbol, day, None, "404"
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            z = zipfile.ZipFile(io.BytesIO(r.content))
            name = z.namelist()[0]
            df = pd.read_csv(z.open(name))
            required = [
                "create_time","symbol","sum_open_interest","sum_open_interest_value",
                "count_toptrader_long_short_ratio","sum_toptrader_long_short_ratio",
                "count_long_short_ratio","sum_taker_long_short_vol_ratio",
            ]
            if not all(c in df.columns for c in required):
                return symbol, day, None, f"SCHEMA:{list(df.columns)}"
            df = df[required].copy()
            df["create_time"] = pd.to_datetime(df["create_time"], utc=True, errors="coerce")
            for c in required[2:]:
                df[c] = pd.to_numeric(df[c], errors="coerce")
            df = df.dropna()
            if df.empty:
                return symbol, day, None, "EMPTY"
            # UM archive convention changed on 2026-06-25: row T became data for T+5m.
            cutoff = pd.Timestamp("2026-06-25", tz="UTC")
            df["effective_time"] = df["create_time"]
            m = df["create_time"] >= cutoff
            df.loc[m, "effective_time"] = df.loc[m, "create_time"] + pd.Timedelta("5min")
            df["symbol"] = symbol
            return symbol, day, df, "OK"
        except Exception as exc:
            last = exc
            time.sleep(min(2 + attempt*2,8))
    return symbol, day, None, repr(last)

def download_metrics(signal_pdf: pd.DataFrame):
    pairs = set()
    for r in signal_pdf.itertuples(index=False):
        d = pd.Timestamp(r.timestamp).date()
        pairs.add((str(r.symbol), str(d)))
        pairs.add((str(r.symbol), str(d - timedelta(days=1))))
    frames = []
    failures = []
    tasks = sorted(pairs)
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futs = {pool.submit(fetch_metrics,t):t for t in tasks}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            s,d = futs[fut]
            _,_,df,status = fut.result()
            if df is not None and not df.empty:
                frames.append(df)
            else:
                failures.append({"symbol":s,"day":d,"status":status})
            if idx % 100 == 0 or idx == len(tasks):
                print(json.dumps({"oiFilesComplete":idx,"tasks":len(tasks),"usable":len(frames),"failures":len(failures)}), flush=True)
    if not frames:
        raise RuntimeError("NO_OI_METRICS")
    metrics = pd.concat(frames, ignore_index=True).sort_values(["symbol","effective_time"])
    metrics = metrics.drop_duplicates(["symbol","effective_time"], keep="last")
    return metrics, failures, len(tasks)

def add_oi_features(metrics: pd.DataFrame) -> pd.DataFrame:
    out=[]
    for symbol,g in metrics.groupby("symbol",sort=False):
        g=g.sort_values("effective_time").copy()
        g["oi1h"] = g["sum_open_interest"] / g["sum_open_interest"].shift(12) - 1.0
        g["oi15m"] = g["sum_open_interest"] / g["sum_open_interest"].shift(3) - 1.0
        g["countLS"] = g["count_long_short_ratio"]
        g["sumTopLS"] = g["sum_toptrader_long_short_ratio"]
        g["countTopLS"] = g["count_toptrader_long_short_ratio"]
        g["metricTakerRatio"] = g["sum_taker_long_short_vol_ratio"]
        out.append(g)
    return pd.concat(out,ignore_index=True).replace([np.inf,-np.inf],np.nan).dropna(
        subset=["oi1h","oi15m","countLS","sumTopLS","metricTakerRatio"]
    )

def _utc_ns(series: pd.Series) -> pd.Series:
    parsed = pd.to_datetime(series, utc=True, errors="coerce")
    return parsed.astype("datetime64[ns, UTC]")


def asof_join_signals(signal_pdf: pd.DataFrame, metrics: pd.DataFrame) -> pd.DataFrame:
    pieces=[]
    for symbol,g in signal_pdf.groupby("symbol",sort=False):
        mg=metrics[metrics["symbol"]==symbol].sort_values("effective_time").copy()
        if mg.empty: continue
        sg=g.sort_values("timestamp").copy()
        sg["timestamp"] = _utc_ns(sg["timestamp"])
        mg["effective_time"] = _utc_ns(mg["effective_time"])
        sg = sg.dropna(subset=["timestamp"]).sort_values("timestamp")
        mg = mg.dropna(subset=["effective_time"]).sort_values("effective_time")
        if sg.empty or mg.empty:
            continue
        j=pd.merge_asof(
            sg, mg,
            left_on="timestamp", right_on="effective_time",
            direction="backward",
            tolerance=pd.Timedelta("30min"),
            suffixes=("","_metric"),
        )
        pieces.append(j)
    if not pieces:
        raise RuntimeError("NO_SIGNAL_OI_JOINS")
    x=pd.concat(pieces,ignore_index=True)
    return x.dropna(subset=["oi1h","countLS","sumTopLS","metricTakerRatio"])

def gate(m: dict,min_trades:int):
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}

def rank_key(m:dict,name:str):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 0),
        int(m.get("tradeCount") or 0),
        name,
    )

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    raw,source=flow.load_bars(MARKET)
    features_pd=flow.add_features(raw)
    features=pl.from_pandas(features_pd).with_columns([
        pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")),
        pl.col("date").cast(pl.Date),
    ])

    base_frames=[]
    base_defs=[]
    for b in BASES:
        s=flow.signal_frame(features,MARKET,"FLOW_RECLAIM","SHORT",0.4,2.5,None,b["topN"])
        if s.is_empty():
            raise RuntimeError(f"EMPTY_BASE:{b['name']}")
        base_frames.append(s.select(["timestamp","symbol","date"]).with_columns(pl.lit(b["name"]).alias("base")))
        base_defs.append((b["name"],b["topN"],s))
    union=pl.concat(base_frames,how="vertical").unique(subset=["timestamp","symbol"])
    outcomes=flow.simulate_union(features_pd,union,MARKET)
    oc=outcomes.filter(
        (pl.col("targetPct")==TARGET)&(pl.col("stopPct")==STOP)&(pl.col("holdBars")==HOLD)
    )

    signal_pdf=union.to_pandas()
    signal_pdf["timestamp"]=pd.to_datetime(signal_pdf["timestamp"],utc=True)
    metrics_raw,failures,planned=download_metrics(signal_pdf)
    metrics=add_oi_features(metrics_raw)
    joined_oi=asof_join_signals(signal_pdf,metrics)

    train_dates=[d.date() for d in pd.date_range("2023-05-01","2025-03-31",freq="D")]
    valid_dates=[d.date() for d in pd.date_range("2025-04-01","2026-03-31",freq="D")]
    oos_dates=[d.date() for d in pd.date_range("2026-04-01","2026-09-30",freq="D")]

    reports={}; grid=[]
    for base_name,top_n,sig in base_defs:
        base_pdf=sig.select(["timestamp","symbol","date"]).to_pandas()
        base_pdf["timestamp"]=pd.to_datetime(base_pdf["timestamp"],utc=True)
        base_oi=asof_join_signals(base_pdf,metrics)
        for fname,ffn in FILTERS.items():
            filt=base_oi[ffn(base_oi)].copy()
            if filt.empty: continue
            fpl=pl.from_pandas(filt[["timestamp","symbol","date","oi1h","oi15m","countLS","sumTopLS","countTopLS","metricTakerRatio"]]).with_columns([
                pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")),
                pl.col("date").cast(pl.Date),
            ])
            trades=fpl.join(oc,on=["timestamp","symbol"],how="inner").with_columns([
                pl.lit(MARKET).alias("market"),
                pl.lit("SHORT").alias("direction"),
                pl.lit(f"{base_name}_{fname}").alias("candidate"),
                pl.col("timestamp").dt.date().alias("date"),
                pl.col("shortExitPrice").alias("exitPrice"),
                pl.col("shortGross").alias("grossReturn"),
                pl.col("shortNet").alias("netReturn"),
                pl.col("shortMFE").alias("MFE"),
                pl.col("shortMAE").alias("MAE"),
                pl.col("shortExitReason").alias("exitReason"),
                pl.lit(flow.COSTS[MARKET]).alias("roundTripCost"),
            ])
            train=trades.filter(pl.col("date")<pl.lit(TRAIN_END))
            valid=trades.filter((pl.col("date")>=pl.lit(TRAIN_END))&(pl.col("date")<pl.lit(VALID_END)))
            oos=trades.filter((pl.col("date")>=pl.lit(VALID_END))&(pl.col("date")<pl.lit(OOS_END)))
            mt=v1.metrics(train,MARKET,train_dates); mv=v1.metrics(valid,MARKET,valid_dates); mo=v1.metrics(oos,MARKET,oos_dates)
            gt,gv,go=gate(mt,100),gate(mv,50),gate(mo,25)
            name=f"{base_name}_{fname}"
            reports[name]={"train":mt,"validation":mv,"freshOos":mo,"trainGate":gt,"validationGate":gv,"freshOosGate":go,"trades":trades}
            grid.append({
                "candidate":name,"baseTopN":top_n,"filter":fname,
                "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                "freshOosReturn":mo.get("totalReturn"),"freshOosPF":mo.get("profitFactor"),"freshOosMDD":mo.get("mdd"),"freshOosPosMonthRate":mo.get("positiveMonthRate"),"freshOosTrades":mo.get("tradeCount"),
            })

    train_pass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    valid_pass=[n for n in train_pass if reports[n]["validationGate"]["pass"]]
    winner=sorted(valid_pass,key=lambda n:rank_key(reports[n]["validation"],n),reverse=True)[0] if valid_pass else None

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    summary={
        "schemaVersion":1,
        "contract":"crypto-v3-short-oi-overlay",
        "baseCandidates":[b["name"] for b in BASES],
        "plannedMetricFiles":planned,
        "failedMetricFiles":len(failures),
        "failurePreview":failures[:30],
        "trainPassCount":len(train_pass),
        "validationPassCount":len(valid_pass),
        "winner":winner,
        "truthBoundary":{
            "freshOosUsedForSelection":False,
            "post2026June25MetricRowsShiftedBy5m":True,
            "metricsJoinedOnlyAtOrBeforeSignalTime":True,
            "executionAuthority":"NONE",
        },
    }
    if winner:
        d=reports[winner]
        summary["winnerResults"]={"train":d["train"],"validation":d["validation"],"freshOos":d["freshOos"],"freshOosGate":d["freshOosGate"]}
        cols=["market","date","timestamp","symbol","direction","candidate","entryPrice","exitPrice","grossReturn","roundTripCost","netReturn","MFE","MAE","exitReason","oi1h","oi15m","countLS","sumTopLS","countTopLS","metricTakerRatio"]
        d["trades"].select(cols).write_csv(out/"winner-ledger.csv")
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
