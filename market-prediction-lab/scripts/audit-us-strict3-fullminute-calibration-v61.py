#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

trainer=load("trainer","market-prediction-lab/scripts/train-us-all-session-opportunity-ai-v4.py")
probe=load("probe","market-prediction-lab/scripts/run-us-all-session-opportunity-probe-v1.py")
census=load("census","market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")

FEATURES=[f for f in trainer.FEATURES if f not in {"minuteOfSession","sessionCode"}]
CAL_MONTHS=["2024-10","2024-11","2024-12","2025-01","2025-02","2025-03"]
BATCH_ROWS=250_000
THRESHOLDS=np.unique(np.concatenate([
    np.linspace(0.02,0.20,19),
    np.linspace(0.225,0.50,12),
    np.linspace(0.55,0.90,8),
    np.array([0.925,0.95,0.975,0.99]),
]))

def fit_model(events:pd.DataFrame):
    data=events.copy()
    trainer.FEATURES=list(FEATURES)
    for c in FEATURES:
        data[c]=pd.to_numeric(data[c],errors="coerce")
    data=data.replace([np.inf,-np.inf],np.nan)
    train=data[data["period"]=="train"].copy()
    y=pd.to_numeric(train["labelStrict3"],errors="coerce").fillna(0).astype(int)
    model=LGBMClassifier(
        objective="binary",
        n_estimators=500,
        learning_rate=0.035,
        num_leaves=31,
        max_depth=-1,
        min_child_samples=120,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.15,
        reg_lambda=1.5,
        random_state=41,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(
        train[FEATURES],
        y,
        sample_weight=trainer.sampling_weight(train),
    )
    return model,int(len(train)),int(y.sum())

def score_query(path:Path)->str:
    base=probe.query_sql(path)
    return base+"""
    SELECT
      ret1,ret5,ret15,rvol60,dollarAccel5,rangePct,closeLoc,
      distHigh30,distLow30,vwapDist,
      ln(greatest(close,0.000001)) AS logPrice,
      ln(greatest(priorDollar60,1.0)) AS logPriorDollar,
      CASE
        WHEN futureHigh>=entryPrice*1.03
         AND futureLow>entryPrice*0.985
        THEN 1 ELSE 0
      END AS labelStrict3
    FROM f
    WHERE close>=1.0
      AND priorDollar60>=100000
    """

def scan_month(path:Path,model,counts):
    con=duckdb.connect()
    reader=con.execute(score_query(path)).fetch_record_batch(BATCH_ROWS)
    rows=0;positives=0
    for batch in reader:
        df=batch.to_pandas()
        if df.empty:continue
        y=pd.to_numeric(df["labelStrict3"],errors="coerce").fillna(0).astype(int).to_numpy()
        X=df[FEATURES].replace([np.inf,-np.inf],np.nan).astype(float)
        score=model.predict_proba(X)[:,1]
        rows+=len(df);positives+=int(y.sum())
        for i,t in enumerate(THRESHOLDS):
            pred=score>=float(t)
            counts[i]["tp"]+=int((pred&(y==1)).sum())
            counts[i]["fp"]+=int((pred&(y==0)).sum())
            counts[i]["fn"]+=int(((~pred)&(y==1)).sum())
            counts[i]["tn"]+=int(((~pred)&(y==0)).sum())
    con.close()
    return {"rows":rows,"positives":positives}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    events=pd.read_parquet(args.events)
    model,train_rows,train_pos=fit_model(events)
    counts=[{"tp":0,"fp":0,"fn":0,"tn":0} for _ in THRESHOLDS]
    audits=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for month in CAL_MONTHS:
            p=root/f"ohlcv_{month}.parquet"
            census._download_us_month(pd.Timestamp(month+"-01",tz="UTC"),p)
            a=scan_month(p,model,counts)
            a["month"]=month
            audits.append(a)
            p.unlink(missing_ok=True)
            print(json.dumps({"calibrationMonth":a},ensure_ascii=False),flush=True)

    grid=[]
    for t,c in zip(THRESHOLDS,counts):
        tp=float(c["tp"]);fp=float(c["fp"]);fn=float(c["fn"]);tn=float(c["tn"])
        precision=tp/max(tp+fp,1.0)
        recall=tp/max(tp+fn,1.0)
        selected=(tp+fp)/max(tp+fp+fn+tn,1.0)
        grid.append({
            "threshold":float(t),
            "tp":int(tp),"fp":int(fp),"fn":int(fn),"tn":int(tn),
            "precision":precision,
            "recall":recall,
            "selectedShare":selected,
        })
    eligible=[r for r in grid if r["recall"]>=0.20]
    winner=max(eligible,key=lambda r:(r["precision"],r["recall"],-r["selectedShare"])) if eligible else max(grid,key=lambda r:r["precision"])
    promotion={
        "precisionAtLeast40pct":winner["precision"]>=0.40,
        "recallAtLeast20pct":winner["recall"]>=0.20,
        "selectedShareAtMost10pct":winner["selectedShare"]<=0.10,
    }
    result={
        "schemaVersion":1,
        "contract":"us-strict3-fullminute-calibration-v61",
        "features":FEATURES,
        "trainRows":train_rows,
        "trainPositiveStrict3":train_pos,
        "calibrationMonths":CAL_MONTHS,
        "calibrationAudits":audits,
        "thresholdGrid":grid,
        "winner":winner,
        "promotionDiagnostic":promotion,
        "promotionPass":all(promotion.values()),
        "truthBoundary":{
            "modelFitUsesFrozenTrainSampleOnly":True,
            "clockFeaturesRemoved":True,
            "thresholdSelectionUsesEveryEligibleCalibrationMinuteState":True,
            "noNegativeSamplingInFullMinuteCalibration":True,
            "strict3LabelUsesFutureHighAndNoStopBreach":True,
            "validationAndFreshOosNotUsed":True,
            "thisStageDoesNotClaimTradingPnl":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    pd.DataFrame(grid).to_csv(out/"threshold-grid.csv",index=False)
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
