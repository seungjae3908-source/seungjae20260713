#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v83=load("us_v83","market-prediction-lab/scripts/run-us-v82-fullstate-portfolio-v83.py")
v8=load("us_v8","market-prediction-lab/scripts/train-us-all-session-target-first-ai-v8.py")
census=load("census_v2","market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")

BATCH_ROWS=250_000
MAX_STATE_GAP=pd.Timedelta(minutes=2)

def score_event_onsets(raw_path:Path,selected_path:Path,model,threshold:float)->dict:
    con=v83.duckdb.connect()
    reader=con.execute(v83.full_state_query(raw_path)).fetch_record_batch(BATCH_ROWS)
    writer=None
    scanned=0
    above=0
    onsets=0
    by_session={"PRE":0,"REG":0,"POST":0}
    opening5=0
    outside5=0
    last_score={}
    last_ts={}

    try:
        for batch in reader:
            df=batch.to_pandas()
            if df.empty:
                continue
            scanned+=len(df)
            score=model.predict_proba(v8.clean_x(df))[:,1]
            df["score"]=score
            above+=int((score>=threshold).sum())

            prev_score=df.groupby("symbol",sort=False)["score"].shift(1)
            prev_ts=df.groupby("symbol",sort=False)["timestamp"].shift(1)
            first=~df["symbol"].duplicated()
            if first.any():
                first_idx=df.index[first]
                syms=df.loc[first_idx,"symbol"].astype(str)
                prev_score.loc[first_idx]=[last_score.get(s,np.nan) for s in syms]
                prev_ts.loc[first_idx]=[last_ts.get(s,pd.NaT) for s in syms]

            ts=pd.to_datetime(df["timestamp"],errors="coerce")
            pts=pd.to_datetime(prev_ts,errors="coerce")
            gap=ts-pts
            onset=(df["score"]>=threshold) & (
                prev_score.isna() | (prev_score<threshold) | (gap>MAX_STATE_GAP)
            )
            s=df.loc[onset].copy()
            onsets+=len(s)

            if len(s):
                counts=s["sessionPart"].astype(str).value_counts()
                for k,val in counts.items():
                    by_session[str(k)]=by_session.get(str(k),0)+int(val)
                stm=pd.to_datetime(s["timestamp"],errors="coerce")
                mins=stm.dt.hour*60+stm.dt.minute
                op=(mins>=9*60+30)&(mins<9*60+35)
                opening5+=int(op.sum())
                outside5+=int((~op).sum())

                table=pa.Table.from_pandas(
                    s[["symbol","timestamp","date","sessionPart","entryTime","entryPrice","score"]],
                    preserve_index=False,
                )
                if writer is None:
                    writer=pq.ParquetWriter(selected_path,table.schema,compression="zstd")
                writer.write_table(table)

            tail=df.groupby("symbol",sort=False).tail(1)
            for sym,sc,t in zip(
                tail["symbol"].astype(str),
                tail["score"].astype(float),
                pd.to_datetime(tail["timestamp"],errors="coerce"),
            ):
                last_score[sym]=float(sc)
                last_ts[sym]=pd.Timestamp(t)
    finally:
        if writer is not None:
            writer.close()
        con.close()

    if not selected_path.exists() or onsets==0:
        raise RuntimeError("V84_NO_EVENT_ONSETS")
    return {
        "scannerStates":int(scanned),
        "aboveThresholdStates":int(above),
        "eventOnsets":int(onsets),
        "onsetShareOfAboveThreshold":float(onsets/max(above,1)),
        "onsetsBySession":by_session,
        "opening5EventOnsets":int(opening5),
        "outsideOpening5EventOnsets":int(outside5),
        "outsideOpening5Share":float(outside5/max(onsets,1)),
        "definition":"threshold_cross_from_below_or_gap_gt_2m",
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
        raise RuntimeError("V84_WRONG_SOURCE_SUMMARY")
    if not bool(v82.get("candidatePass")):
        raise RuntimeError("V84_SOURCE_NOT_PASS")
    threshold=float(v82["calibrationSelection"]["winner"]["threshold"])
    model,train_rows=v83.frozen_model(Path(args.frozen_events))

    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        raw=root/f"ohlcv_{args.month}.parquet"
        onsets=root/"event-onsets.parquet"
        exact=root/"event-onsets-exact.parquet"
        census._download_us_month(pd.Timestamp(args.month+"-01",tz="UTC"),raw)
        onset_audit=score_event_onsets(raw,onsets,model,threshold)
        exact_audit=v83.exact_outcomes(raw,onsets,exact)
        grid,detail=v83.portfolio_grid(exact)

    pd.DataFrame(grid).to_csv(out/"capacity-grid.csv",index=False)
    result={
        "schemaVersion":1,
        "contract":"us-v82-event-onset-portfolio-v84",
        "month":args.month,
        "fixedThreshold":threshold,
        "frozenTrainRows":train_rows,
        "sourceV82Holdout":{
            "rowRecall":v82["newHoldout2026_03"]["recall"],
            "eventClusterRecall":v82["newHoldout2026_03"]["eventClusterRecall"],
            "precision":v82["newHoldout2026_03"]["populationWeightedPrecision"],
            "meanNet":v82["newHoldout2026_03"]["populationWeightedMeanNetReturn"],
            "profitFactor":v82["newHoldout2026_03"]["populationWeightedProfitFactor"],
        },
        "eventOnsetSelection":onset_audit,
        "exactOutcome":exact_audit,
        "capacityGrid":grid,
        "capacityDetails":detail,
        "truthBoundary":{
            "scannerStillScoresEveryEligibleMinuteState":True,
            "entryEventOnlyOnThresholdOnsetOrDataGap":True,
            "noOpeningClockRequirement":True,
            "preRegularPostAllEligible":True,
            "thresholdFrozenFromV82CalibrationOnly":True,
            "marchNotUsedForModelOrThresholdSelection":True,
            "entryUsesNextMinuteOpenPlusSlippage":True,
            "exactOneMinuteTargetStopPathUsed":True,
            "sameMinuteTargetStopUsesStopFirst":True,
            "roundTripCostIncluded":True,
            "portfolioReplayAlwaysOn":True,
            "oneMonthReplayCannotProveLongRunProfitability":True,
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
