#!/usr/bin/env python3
from __future__ import annotations

import argparse, json
from pathlib import Path
import numpy as np
import pandas as pd

FAMILIES = {
    "SELL_BREAKDOWN": lambda x: (
        (x["flow4"] <= -0.08) &
        (x["takerRatio"] <= 0.48) &
        (x["rvol"] >= 1.5) &
        (x["vwapDist"] <= 0.0) &
        (x["ret4"] <= 0.0)
    ),
    "SELL_ACCEL": lambda x: (
        (x["flowAccel4"] <= -0.05) &
        (x["takerAccel"] <= -0.03) &
        (x["rvol"] >= 1.5) &
        (x["closeLoc"] <= 0.50)
    ),
    "FAILED_RALLY": lambda x: (
        (x["ret12"] >= 0.015) &
        (x["flow4"] <= -0.05) &
        (x["takerRatio"] <= 0.49) &
        (x["vwapDist"] <= 0.005)
    ),
    "FLOW_PRICE_DIVERGENCE": lambda x: (
        (x["flow4"] <= -0.10) &
        (x["cvd12"] <= -0.05) &
        (x["ret4"] >= -0.005) &
        (x["ret4"] <= 0.015) &
        (x["rvol"] >= 1.25)
    ),
}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    x=pd.read_parquet(args.events)
    req={"timestamp","symbol","period","flow4","takerRatio","rvol","vwapDist","ret4",
         "flowAccel4","takerAccel","closeLoc","ret12","cvd12"}
    miss=req-set(x.columns)
    if miss: raise RuntimeError(f"V52_PROBE_COLUMNS_MISSING:{sorted(miss)}")
    x["timestamp"]=pd.to_datetime(x["timestamp"],utc=True)
    x["symbol"]=x["symbol"].astype(str)
    x["day"]=x["timestamp"].dt.date.astype(str)

    reports={}
    union=[]
    for name,fn in FAMILIES.items():
        m=fn(x).fillna(False)
        z=x.loc[m,["timestamp","symbol","period","rankAtTimestamp"]].copy()
        z["family"]=name
        union.append(z)
        reports[name]={
            "rows":int(len(z)),
            "symbols":int(z["symbol"].nunique()),
            "timestamps":int(z["timestamp"].nunique()),
            "symbolDays":int(z.assign(day=z["timestamp"].dt.date).drop_duplicates(["symbol","day"]).shape[0]),
            "periodRows":{str(k):int(v) for k,v in z["period"].astype(str).value_counts().to_dict().items()},
        }
    u=pd.concat(union,ignore_index=True) if union else pd.DataFrame()
    if u.empty: raise RuntimeError("V52_PROBE_NO_STRUCTURAL_EVENTS")
    u=u.sort_values(["timestamp","rankAtTimestamp","symbol"]).drop_duplicates(["timestamp","symbol","family"])
    u.to_parquet(out/"structural-events.parquet",index=False)
    result={
      "schemaVersion":1,
      "contract":"crypto-futures-causal-oi-family-v52-probe",
      "sourceContract":"crypto-futures-causal-targetfirst-ai-v51",
      "sourceRun":37467915233,
      "families":reports,
      "unionRows":int(len(u)),
      "unionSymbols":int(u["symbol"].nunique()),
      "unionTimestamps":int(u["timestamp"].nunique()),
      "unionSymbolDays":int(u.assign(day=u["timestamp"].dt.date).drop_duplicates(["symbol","day"]).shape[0]),
      "truthBoundary":{
        "familiesFrozenBeforeOutcomeInspectionForThisProbe":True,
        "noOutcomeColumnsUsed":True,
        "sourceEventsAreCausalV51":True,
        "validationAndFreshNotUsedForFamilyDefinition":True,
        "probeOnlyNoProfitabilityClaim":True,
        "profitabilityProven":False,
        "executionAuthority":"NONE",
      },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False),flush=True)

if __name__=="__main__": main()
