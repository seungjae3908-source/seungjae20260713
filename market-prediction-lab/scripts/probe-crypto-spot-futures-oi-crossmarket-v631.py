#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path
import pandas as pd

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    cols=["timestamp","symbol","period","month","activityScore","baseRvol","ret60",
          "flow4","flowAccel4","takerRatio","vwapDist"]
    x=pd.read_parquet(args.events,columns=cols)
    x["timestamp"]=pd.to_datetime(x["timestamp"],utc=True)
    for c in ["baseRvol","ret60","flow4","flowAccel4","takerRatio","vwapDist"]:
        x[c]=pd.to_numeric(x[c],errors="coerce")
    x=x.dropna(subset=cols).copy()

    mask=(
        (x["ret60"]<=-0.015)&
        (x["baseRvol"]>=1.5)&
        (x["flow4"]>=0.03)&
        (x["flowAccel4"]>=0.0)&
        (x["takerRatio"]>=0.51)&
        (x["vwapDist"]>=-0.005)
    )
    z=x.loc[mask].copy()
    if z.empty: raise RuntimeError("V631_NO_FLOW_RECOVERY_ROWS")
    z=z.sort_values(["timestamp","activityScore","symbol"],ascending=[True,False,True])
    z["day"]=z["timestamp"].dt.strftime("%Y-%m-%d")
    z["month"]=z["timestamp"].dt.strftime("%Y-%m")
    tasks=z[["month","symbol"]].drop_duplicates().sort_values(["month","symbol"])
    sd=z[["day","symbol"]].drop_duplicates()
    period=z["period"].astype(str).value_counts().to_dict()

    z.to_parquet(out/"flow-recovery-candidates.parquet",index=False)
    tasks.to_csv(out/"oi-month-tasks.csv",index=False)

    result={
      "schemaVersion":1,
      "contract":"crypto-spot-futures-oi-crossmarket-v631-probe",
      "sourceRunV61":37471171237,
      "sourceRows":int(len(x)),
      "candidateRows":int(len(z)),
      "candidateSymbols":int(z["symbol"].nunique()),
      "candidateTimestamps":int(z["timestamp"].nunique()),
      "symbolDays":int(len(sd)),
      "symbolMonthTasks":int(len(tasks)),
      "periodRows":{str(k):int(v) for k,v in period.items()},
      "fixedRule":{
        "ret60Max":-0.015,"baseRvolMin":1.5,"flow4Min":0.03,
        "flowAccel4Min":0.0,"takerRatioMin":0.51,"vwapDistMin":-0.005
      },
      "truthBoundary":{
        "onlyFeatureColumnsLoaded":True,
        "outcomeAndPnlColumnsNotLoaded":True,
        "ruleFrozenBeforeThisProbe":True,
        "sourceEventsCausalSameTimestampTop10":True,
        "probeOnly":True,
        "profitabilityProven":False,
        "executionAuthority":"NONE"
      }
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False),flush=True)

if __name__=="__main__":main()
