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

v84=load("us_v84","market-prediction-lab/scripts/run-us-v82-event-onset-portfolio-v84.py")
v83=load("us_v83","market-prediction-lab/scripts/run-us-v82-fullstate-portfolio-v83.py")
v8=load("us_v8","market-prediction-lab/scripts/train-us-all-session-target-first-ai-v8.py")
census=load("census_v2","market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")

BATCH_ROWS=250_000
MAX_STATE_GAP=pd.Timedelta(minutes=2)
CONFIRM_DELAY=pd.Timedelta(minutes=2)
MAX_CONFIRM_LAG=pd.Timedelta(minutes=2)

def score_confirmed_events(raw_path:Path,out_path:Path,model,threshold:float)->dict:
    con=v83.duckdb.connect()
    reader=con.execute(v83.full_state_query(raw_path)).fetch_record_batch(BATCH_ROWS)
    writer=None

    last_score={}
    last_ts={}
    pending={}

    scanned=0
    onset_count=0
    confirmed_count=0
    rejected_score=0
    expired_no_state=0
    opening5=0
    outside5=0
    by_session={"PRE":0,"REG":0,"POST":0}

    try:
        for batch in reader:
            df=batch.to_pandas()
            if df.empty:continue
            scanned+=len(df)
            df["score"]=model.predict_proba(v8.clean_x(df))[:,1]

            confirmed_rows=[]
            for row in df.itertuples(index=False):
                sym=str(row.symbol)
                ts=pd.Timestamp(row.timestamp)
                score=float(row.score)

                p=pending.get(sym)
                if p is not None and ts>=p["confirmAt"]:
                    lag=ts-p["confirmAt"]
                    if lag<=MAX_CONFIRM_LAG:
                        if score>=threshold and score>=p["onsetScore"]:
                            confirmed_rows.append({
                                "symbol":sym,
                                "timestamp":ts,
                                "date":row.date,
                                "sessionPart":str(row.sessionPart),
                                "entryTime":pd.Timestamp(row.entryTime),
                                "entryPrice":float(row.entryPrice),
                                "score":score,
                                "onsetTime":p["onsetTime"],
                                "onsetScore":p["onsetScore"],
                                "confirmDelayMinutes":float(
                                    (ts-p["onsetTime"]).total_seconds()/60.0
                                ),
                                "scoreDelta":score-p["onsetScore"],
                            })
                            confirmed_count+=1
                        else:
                            rejected_score+=1
                    else:
                        expired_no_state+=1
                    del pending[sym]

                ps=last_score.get(sym,np.nan)
                pt=last_ts.get(sym,pd.NaT)
                gap=ts-pd.Timestamp(pt) if pd.notna(pt) else pd.NaT
                onset=(
                    score>=threshold and (
                        not np.isfinite(ps)
                        or ps<threshold
                        or (pd.notna(gap) and gap>MAX_STATE_GAP)
                    )
                )
                if onset:
                    onset_count+=1
                    pending[sym]={
                        "onsetTime":ts,
                        "onsetScore":score,
                        "confirmAt":ts+CONFIRM_DELAY,
                    }

                last_score[sym]=score
                last_ts[sym]=ts

            if confirmed_rows:
                cdf=pd.DataFrame(confirmed_rows)
                mins=cdf["timestamp"].dt.hour*60+cdf["timestamp"].dt.minute
                op=(mins>=9*60+30)&(mins<9*60+35)
                opening5+=int(op.sum())
                outside5+=int((~op).sum())
                counts=cdf["sessionPart"].astype(str).value_counts()
                for k,v in counts.items():
                    by_session[str(k)]=by_session.get(str(k),0)+int(v)

                table=pa.Table.from_pandas(cdf,preserve_index=False)
                if writer is None:
                    writer=pq.ParquetWriter(out_path,table.schema,compression="zstd")
                writer.write_table(table)
    finally:
        if writer is not None:writer.close()
        con.close()

    if not out_path.exists() or confirmed_count==0:
        raise RuntimeError("V86_NO_CONFIRMED_EVENTS")

    return {
        "scannerStates":int(scanned),
        "eventOnsets":int(onset_count),
        "confirmedEvents":int(confirmed_count),
        "confirmationRate":float(confirmed_count/max(onset_count,1)),
        "rejectedByScoreWeakening":int(rejected_score),
        "expiredWithoutTimelyState":int(expired_no_state),
        "pendingAtEnd":int(len(pending)),
        "confirmedBySession":by_session,
        "opening5Confirmed":int(opening5),
        "outsideOpening5Confirmed":int(outside5),
        "outsideOpening5Share":float(outside5/max(confirmed_count,1)),
        "confirmationContract":{
            "delayMinutes":2,
            "maxStateLagAfterConfirmTimeMinutes":2,
            "confirmScoreAtLeastFrozenThreshold":True,
            "confirmScoreNotBelowOnsetScore":True,
        },
    }

def exact_metrics(path:Path)->dict:
    x=pd.read_parquet(path)
    net=pd.to_numeric(x["netReturn"],errors="coerce").dropna()
    pos=float(net[net>0].sum());neg=float(-net[net<0].sum())
    return {
        "rows":int(len(x)),
        "symbols":int(x["symbol"].astype(str).nunique()) if len(x) else 0,
        "meanNet":float(net.mean()) if len(net) else 0.0,
        "profitFactor":float(pos/neg) if neg>0 else (float("inf") if pos>0 else 0.0),
        "positiveRate":float((net>0).mean()) if len(net) else None,
        "targetFirst3":int(pd.to_numeric(x["targetFirst3"],errors="coerce").fillna(0).sum()) if len(x) else 0,
        "targetFirstRate":float(pd.to_numeric(x["targetFirst3"],errors="coerce").fillna(0).mean()) if len(x) else 0.0,
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
        raise RuntimeError("V86_WRONG_SOURCE")
    if not bool(v82.get("candidatePass")):
        raise RuntimeError("V86_SOURCE_NOT_PASS")

    threshold=float(v82["calibrationSelection"]["winner"]["threshold"])
    model,train_rows=v83.frozen_model(Path(args.frozen_events))

    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        raw=root/f"ohlcv_{args.month}.parquet"
        confirmed=root/"confirmed.parquet"
        exact=root/"confirmed-exact.parquet"
        census._download_us_month(pd.Timestamp(args.month+"-01",tz="UTC"),raw)
        confirm_audit=score_confirmed_events(raw,confirmed,model,threshold)
        exact_audit=v83.exact_outcomes(raw,confirmed,exact)
        metrics=exact_metrics(exact)
        grid,detail=v83.portfolio_grid(exact)

    pd.DataFrame(grid).to_csv(out/"capacity-grid.csv",index=False)
    result={
        "schemaVersion":1,
        "contract":"us-v82-onset-confirm-v86",
        "month":args.month,
        "fixedThreshold":threshold,
        "frozenTrainRows":train_rows,
        "confirmation":confirm_audit,
        "exactOutcomeAudit":exact_audit,
        "exactMetrics":metrics,
        "capacityGrid":grid,
        "capacityDetails":detail,
        "promotionPass":False,
        "truthBoundary":{
            "sameFrozenModelAndThresholdAsV82":True,
            "scannerScoresEveryEligibleMinuteState":True,
            "onsetCreatesWatchlistCandidateNotImmediateEntry":True,
            "confirmationUsesOnlyNewCompletedMinuteState":True,
            "fixedTwoMinuteConfirmationChosenBeforeReplay":True,
            "noMarchOutcomeUsedToSetConfirmationRule":True,
            "marchAlreadyExposedDiagnosticOnly":True,
            "noOpeningClockRequirement":True,
            "preRegularPostAllEligible":True,
            "entryUsesNextMinuteOpenPlusSlippage":True,
            "exactOneMinuteTargetStopPathUsed":True,
            "sameMinuteTargetStopUsesStopFirst":True,
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
