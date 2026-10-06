#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v84=load("us_v84","market-prediction-lab/scripts/run-us-v82-event-onset-portfolio-v84.py")
v83=load("us_v83","market-prediction-lab/scripts/run-us-v82-fullstate-portfolio-v83.py")
census=load("census_v2","market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")

TOP_KS=(1,3,5,10,20)

def exact_metrics(path:Path)->dict:
    x=pd.read_parquet(path)
    net=pd.to_numeric(x["netReturn"],errors="coerce").dropna()
    pos=net[net>0].sum()
    neg=-net[net<0].sum()
    pf=float(pos/neg) if neg>0 else (float("inf") if pos>0 else 0.0)
    return {
        "rows":int(len(x)),
        "symbols":int(x["symbol"].astype(str).nunique()) if len(x) else 0,
        "meanNet":float(net.mean()) if len(net) else 0.0,
        "profitFactor":pf,
        "positiveRate":float((net>0).mean()) if len(net) else None,
        "targetFirst3":int(pd.to_numeric(x.get("targetFirst3"),errors="coerce").fillna(0).sum()) if len(x) else 0,
        "targetFirstRate":float(pd.to_numeric(x.get("targetFirst3"),errors="coerce").fillna(0).mean()) if len(x) else 0.0,
    }

def select_topk(onsets_path:Path,out_path:Path,k:int)->dict:
    x=pd.read_parquet(onsets_path)
    if x.empty:
        raise RuntimeError("V85_ONSETS_EMPTY")
    x["timestamp"]=pd.to_datetime(x["timestamp"],errors="coerce")
    x["score"]=pd.to_numeric(x["score"],errors="coerce")
    x=x.dropna(subset=["timestamp","score"]).copy()
    y=(
        x.sort_values(["timestamp","score","symbol"],ascending=[True,False,True])
         .groupby("timestamp",group_keys=False)
         .head(k)
         .reset_index(drop=True)
    )
    y.to_parquet(out_path,index=False)
    mins=y["timestamp"].dt.hour*60+y["timestamp"].dt.minute
    op=(mins>=9*60+30)&(mins<9*60+35)
    return {
        "topK":k,
        "sourceOnsets":int(len(x)),
        "selectedEvents":int(len(y)),
        "selectedShare":float(len(y)/max(len(x),1)),
        "timestamps":int(y["timestamp"].nunique()),
        "symbols":int(y["symbol"].astype(str).nunique()),
        "opening5Events":int(op.sum()),
        "outsideOpening5Events":int((~op).sum()),
        "outsideOpening5Share":float((~op).sum()/max(len(y),1)),
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--frozen-events",required=True)
    ap.add_argument("--v82-summary",required=True)
    ap.add_argument("--month",default="2026-03")
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    v82=json.loads(Path(args.v82_summary).read_text(encoding="utf-8"))
    if v82.get("contract")!="us-all-session-target-first-ai-v82-recall":
        raise RuntimeError("V85_WRONG_SOURCE_SUMMARY")
    if not bool(v82.get("candidatePass")):
        raise RuntimeError("V85_SOURCE_NOT_PASS")

    threshold=float(v82["calibrationSelection"]["winner"]["threshold"])
    model,train_rows=v83.frozen_model(Path(args.frozen_events))

    rows=[]
    details={}
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        raw=root/f"ohlcv_{args.month}.parquet"
        onsets=root/"event-onsets.parquet"
        census._download_us_month(pd.Timestamp(args.month+"-01",tz="UTC"),raw)
        onset_audit=v84.score_event_onsets(raw,onsets,model,threshold)

        for k in TOP_KS:
            selected=root/f"top{k}.parquet"
            exact=root/f"top{k}-exact.parquet"
            selection=select_topk(onsets,selected,k)
            v83.exact_outcomes(raw,selected,exact)
            metrics=exact_metrics(exact)
            capacity_grid,capacity_detail=v83.portfolio_grid(exact)
            rows.append({
                "topK":k,
                **selection,
                **metrics,
            })
            details[str(k)]={
                "selection":selection,
                "exactMetrics":metrics,
                "capacityGrid":capacity_grid,
                "capacityDetails":capacity_detail,
            }

    pd.DataFrame(rows).to_csv(out/"topk-grid.csv",index=False)
    result={
        "schemaVersion":1,
        "contract":"us-v82-event-onset-topk-v85",
        "month":args.month,
        "fixedThreshold":threshold,
        "frozenTrainRows":train_rows,
        "topKs":list(TOP_KS),
        "sourceEventOnsetAudit":onset_audit,
        "topKGrid":rows,
        "details":details,
        "promotionPass":False,
        "truthBoundary":{
            "sameFrozenModelAsV82V84":True,
            "thresholdFrozenFromCalibrationOnly":True,
            "eventOnsetDefinitionUnchangedFromV84":True,
            "topKUsesOnlyTimestampAndFrozenScore":True,
            "noOutcomeUsedToSelectTopKBeforeReplay":True,
            "marchAlreadyExposedDiagnosticOnly":True,
            "noWinnerFrozenFromMarch":True,
            "noOpeningClockRequirement":True,
            "preRegularPostAllEligible":True,
            "portfolioReplayAlwaysOn":True,
            "nextFreshMonthRequiredForPromotion":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
