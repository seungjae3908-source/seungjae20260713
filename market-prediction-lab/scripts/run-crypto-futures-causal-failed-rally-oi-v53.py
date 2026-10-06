#!/usr/bin/env python3
from __future__ import annotations

# Workflow trigger after registration.

import argparse, importlib.util, json
from pathlib import Path
import numpy as np
import pandas as pd
import polars as pl

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None: raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

oi=load("oi_v4","market-prediction-lab/scripts/run-full-universe-3pct-hunter-futures-oi-v4.py")

EXTRA_STRESS=0.0010
FAMILY="FAILED_RALLY"

def family_mask(x):
    return (
        (x["ret12"]>=0.015)&
        (x["flow4"]<=-0.05)&
        (x["takerRatio"]<=0.49)&
        (x["vwapDist"]<=0.005)
    )

RULES={
  "OI1H_UP":lambda x:(x["oi1h"]>=0.005),
  "OI4H_UP":lambda x:(x["oi4h"]>=0.010),
  "OI1H_UP_CROWD_LONG":lambda x:(x["oi1h"]>=0.005)&(x["count_long_short_ratio"]>=1.0),
  "OI1H_UP_TAKER_SHORT":lambda x:(x["oi1h"]>=0.005)&(x["sum_taker_long_short_vol_ratio"]<=1.0),
}

def metrics(x,stress=0.0):
    if x.empty:
        return {"rows":0,"meanNet":0.0,"profitFactor":0.0,"targetFirstRate":0.0,
                "positiveMonths":0,"negativeMonths":0,"positiveActiveMonthRate":0.0}
    net=pd.to_numeric(x["netReturn"],errors="coerce").to_numpy(float)-stress
    y=pd.to_numeric(x["labelTargetFirst3"],errors="coerce").fillna(0).astype(int).to_numpy()
    gp=float(np.maximum(net,0).sum()); gl=float(np.maximum(-net,0).sum())
    z=pd.DataFrame({"month":x["month"].astype(str).to_numpy(),"net":net})
    ms=z.groupby("month")["net"].sum()
    pm=int((ms>0).sum());nm=int((ms<0).sum())
    return {"rows":int(len(x)),"meanNet":float(net.mean()),"profitFactor":float(gp/max(gl,1e-12)),
            "targetFirstRate":float((y==1).mean()),"positiveMonths":pm,"negativeMonths":nm,
            "positiveActiveMonthRate":float(pm/max(pm+nm,1))}

def train_gate(m):
    c={"rowsAtLeast100":m["rows"]>=100,"positiveEV":m["meanNet"]>0,
       "pfAtLeast1p1":m["profitFactor"]>=1.10,"positiveMonthsAtLeast50pct":m["positiveActiveMonthRate"]>=0.50}
    return {"pass":all(c.values()),"checks":c}

def calibration_gate(m):
    c={"rowsAtLeast30":m["rows"]>=30,"meanNetAtLeast15bp":m["meanNet"]>=0.0015,
       "pfAtLeast1p3":m["profitFactor"]>=1.30,"targetFirstAtLeast40pct":m["targetFirstRate"]>=0.40,
       "positiveMonthsAtLeast67pct":m["positiveActiveMonthRate"]>=0.67}
    return {"pass":all(c.values()),"checks":c}

def s_gate(m,min_rows):
    c={"minimumRows":m["rows"]>=min_rows,"meanNetAtLeast20bp":m["meanNet"]>=0.0020,
       "pfAtLeast1p5":m["profitFactor"]>=1.50,"targetFirstAtLeast42pct":m["targetFirstRate"]>=0.42,
       "positiveMonthsAtLeast67pct":m["positiveActiveMonthRate"]>=0.67}
    return {"pass":all(c.values()),"checks":c}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    x=pd.read_parquet(args.events)
    x["timestamp"]=pd.to_datetime(x["timestamp"],utc=True)
    x["entryTime"]=pd.to_datetime(x["entryTime"],utc=True)
    x["exitTime"]=pd.to_datetime(x["exitTime"],utc=True)
    x["symbol"]=x["symbol"].astype(str)
    x=x.loc[family_mask(x).fillna(False)].copy()
    if x.empty: raise RuntimeError("V53_NO_FAILED_RALLY_EVENTS")

    signals=x.copy()
    signals["signalEnd"]=signals["timestamp"]+pd.Timedelta(minutes=15)
    met,meta=oi.load_metrics_for_signals(signals[["symbol","signalEnd"]].copy())

    attached=oi.attach_metrics(pl.from_pandas(x),met)
    if attached.empty: raise RuntimeError("V53_NO_OI_ATTACHED_EVENTS")
    attached["month"]=attached["timestamp"].dt.strftime("%Y-%m")
    attached.to_parquet(out/"failed-rally-oi-events.parquet",index=False)

    reports={}
    for name,fn in RULES.items():
        z=attached.loc[fn(attached).fillna(False)].copy()
        splits={p:z[z["period"].astype(str)==p].copy() for p in ("train","calibration","validation","fresh_oos")}
        mm={p:metrics(v,0.0) for p,v in splits.items()}
        stress={p:metrics(v,EXTRA_STRESS) for p,v in splits.items()}
        reports[name]={
          "train":mm["train"],"calibration":mm["calibration"],"validation":mm["validation"],"freshOos":mm["fresh_oos"],
          "validationPlus10bp":stress["validation"],"freshOosPlus10bp":stress["fresh_oos"],
          "trainGate":train_gate(mm["train"]),"calibrationGate":calibration_gate(mm["calibration"]),
          "validationGate":s_gate(mm["validation"],75),"freshOosGate":s_gate(mm["fresh_oos"],40),
          "validationStressGate":s_gate(stress["validation"],75),"freshOosStressGate":s_gate(stress["fresh_oos"],40),
        }
        reports[name]["eligibleAfterCalibration"]=bool(reports[name]["trainGate"]["pass"] and reports[name]["calibrationGate"]["pass"])

    eligible=[k for k,v in reports.items() if v["eligibleAfterCalibration"]]
    selected=max(eligible,key=lambda k:(reports[k]["calibration"]["profitFactor"],reports[k]["calibration"]["meanNet"],reports[k]["calibration"]["targetFirstRate"])) if eligible else None
    s_pass=False
    if selected:
        v=reports[selected]
        s_pass=bool(v["validationGate"]["pass"] and v["freshOosGate"]["pass"] and
                    v["validationStressGate"]["pass"] and v["freshOosStressGate"]["pass"])

    result={"schemaVersion":1,"contract":"crypto-futures-causal-failed-rally-oi-v53",
            "sourceRunV51":37467915233,"family":FAMILY,"sourceFamilyRows":int(len(x)),
            "oiAttachedRows":int(len(attached)),"oiSource":meta,"rules":reports,
            "eligibleAfterCalibration":eligible,"selectedByCalibration":selected,"S_PASS":s_pass,
            "truthBoundary":{"sourceEventsAreCausalV51":True,"failedRallyDefinitionFrozenBeforeOutcomeUse":True,
              "oiRulesPredefinedBeforeValidation":True,"oiUsesMostRecentEffective5mMetricAtOrBeforeSignalEnd":True,
              "metricsLabelShiftAfter2026_06_25HandledByImportedOIReader":True,
              "trainAndCalibrationOnlySelectRule":True,"validationAndFreshNeverSelectRule":True,
              "plus10bpStressRequiredForS":True,"fundingNotYetAppliedAndWouldBeRequiredAfterPass":True,
              "profitabilityProven":False,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__": main()
