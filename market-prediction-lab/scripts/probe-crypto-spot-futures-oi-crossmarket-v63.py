#!/usr/bin/env python3
from __future__ import annotations

import argparse, json
from pathlib import Path
import pandas as pd

RET60_MAX=-0.015
RVOL_MIN=1.5

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--selected",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    x=pd.read_csv(args.selected)
    req={"date","day","month","symbol","activityScore","baseRvol","ret60"}
    miss=req-set(x.columns)
    if miss: raise RuntimeError(f"V63_PROBE_COLUMNS_MISSING:{sorted(miss)}")
    x["date"]=pd.to_datetime(x["date"],utc=True,errors="coerce")
    x["baseRvol"]=pd.to_numeric(x["baseRvol"],errors="coerce")
    x["ret60"]=pd.to_numeric(x["ret60"],errors="coerce")
    x=x.dropna(subset=["date","symbol","baseRvol","ret60"]).copy()

    z=x[(x["ret60"]<=RET60_MAX)&(x["baseRvol"]>=RVOL_MIN)].copy()
    z=z.sort_values(["date","activityScore","symbol"],ascending=[True,False,True])
    if z.empty: raise RuntimeError("V63_PROBE_NO_ROWS")

    z["day"]=z["date"].dt.strftime("%Y-%m-%d")
    z["month"]=z["date"].dt.strftime("%Y-%m")
    tasks=z[["month","symbol"]].drop_duplicates().sort_values(["month","symbol"])
    symbol_days=z[["day","symbol"]].drop_duplicates()
    per_period=pd.cut(
        z["date"],
        bins=[
            pd.Timestamp("2023-05-01",tz="UTC"),
            pd.Timestamp("2024-10-01",tz="UTC"),
            pd.Timestamp("2025-04-01",tz="UTC"),
            pd.Timestamp("2026-04-01",tz="UTC"),
            pd.Timestamp("2026-10-01",tz="UTC"),
            pd.Timestamp("2026-11-01",tz="UTC"),
        ],
        labels=["train","calibration","validation","fresh_oos","forward"],
        right=False,
    )
    counts=per_period.value_counts(dropna=False).to_dict()

    z.to_csv(out/"structural-candidates.csv",index=False)
    tasks.to_csv(out/"raw-month-tasks.csv",index=False)

    result={
      "schemaVersion":1,
      "contract":"crypto-spot-futures-oi-crossmarket-v63-probe",
      "sourceRunV60":37468226538,
      "sourceRows":int(len(x)),
      "candidateRows":int(len(z)),
      "candidateSymbols":int(z["symbol"].nunique()),
      "candidateTimestamps":int(z["date"].nunique()),
      "symbolDays":int(len(symbol_days)),
      "rawSymbolMonthTasks":int(len(tasks)),
      "fixedStructuralRule":{
        "ret60Max":RET60_MAX,
        "baseRvolMin":RVOL_MIN,
        "causalTop50Source":True,
      },
      "periodRows":{str(k):int(v) for k,v in counts.items()},
      "truthBoundary":{
        "ruleFrozenBeforeAnyOutcomeOrPnlInspection":True,
        "noOutcomeColumnsLoaded":True,
        "sourceTop50RankingUsesSameCompletedTimestampOnly":True,
        "probeOnly":True,
        "profitabilityProven":False,
        "executionAuthority":"NONE",
      }
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":main()
