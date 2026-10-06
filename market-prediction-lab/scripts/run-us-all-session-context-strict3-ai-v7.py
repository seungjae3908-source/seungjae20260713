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
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

trainer=load("trainer","market-prediction-lab/scripts/train-us-all-session-opportunity-ai-v4.py")
probe=load("probe","market-prediction-lab/scripts/run-us-all-session-opportunity-probe-v1.py")
census=load("census","market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")

BASE_FEATURES=[
    f for f in trainer.FEATURES if f not in {"minuteOfSession","sessionCode"}
]
CONTEXT_FEATURES=[
    "breadthRet1Pos","breadthRet5Pos","breadthRet15Pos",
    "marketMedianRet1","marketMedianRet5",
    "csRet1Pct","csRet5Pct","csRvolPct","csDollarAccelPct",
    "spyRet1Ctx","spyRet5Ctx","qqqRet1Ctx","qqqRet5Ctx",
    "iwmRet1Ctx","iwmRet5Ctx","rsVsSpy5","rsVsQqq5",
]
FEATURES=BASE_FEATURES+CONTEXT_FEATURES


def context_query(path:Path)->str:
    base=probe.query_sql(path)
    return base+"""
    , eligible_ctx AS (
      SELECT *
      FROM f
      WHERE close>=1.0
        AND priorDollar60>=100000
    ),
    ctx0 AS (
      SELECT
        *,
        avg(CASE WHEN ret1>0 THEN 1.0 ELSE 0.0 END)
          OVER (PARTITION BY ts) AS breadthRet1Pos,
        avg(CASE WHEN ret5>0 THEN 1.0 ELSE 0.0 END)
          OVER (PARTITION BY ts) AS breadthRet5Pos,
        avg(CASE WHEN ret15>0 THEN 1.0 ELSE 0.0 END)
          OVER (PARTITION BY ts) AS breadthRet15Pos,
        median(ret1) OVER (PARTITION BY ts) AS marketMedianRet1,
        median(ret5) OVER (PARTITION BY ts) AS marketMedianRet5,
        percent_rank() OVER (PARTITION BY ts ORDER BY ret1) AS csRet1Pct,
        percent_rank() OVER (PARTITION BY ts ORDER BY ret5) AS csRet5Pct,
        percent_rank() OVER (PARTITION BY ts ORDER BY rvol60) AS csRvolPct,
        percent_rank() OVER (PARTITION BY ts ORDER BY dollarAccel5) AS csDollarAccelPct,
        max(CASE WHEN symbol='SPY' THEN ret1 END) OVER (PARTITION BY ts) AS spyRet1Raw,
        max(CASE WHEN symbol='SPY' THEN ret5 END) OVER (PARTITION BY ts) AS spyRet5Raw,
        max(CASE WHEN symbol='QQQ' THEN ret1 END) OVER (PARTITION BY ts) AS qqqRet1Raw,
        max(CASE WHEN symbol='QQQ' THEN ret5 END) OVER (PARTITION BY ts) AS qqqRet5Raw,
        max(CASE WHEN symbol='IWM' THEN ret1 END) OVER (PARTITION BY ts) AS iwmRet1Raw,
        max(CASE WHEN symbol='IWM' THEN ret5 END) OVER (PARTITION BY ts) AS iwmRet5Raw
      FROM eligible_ctx
    ),
    ctx AS (
      SELECT
        *,
        coalesce(spyRet1Raw,marketMedianRet1) AS spyRet1Ctx,
        coalesce(spyRet5Raw,marketMedianRet5) AS spyRet5Ctx,
        coalesce(qqqRet1Raw,marketMedianRet1) AS qqqRet1Ctx,
        coalesce(qqqRet5Raw,marketMedianRet5) AS qqqRet5Ctx,
        coalesce(iwmRet1Raw,marketMedianRet1) AS iwmRet1Ctx,
        coalesce(iwmRet5Raw,marketMedianRet5) AS iwmRet5Ctx,
        ret5-coalesce(spyRet5Raw,marketMedianRet5) AS rsVsSpy5,
        ret5-coalesce(qqqRet5Raw,marketMedianRet5) AS rsVsQqq5
      FROM ctx0
    )
    SELECT
      e.eventId,
      c.breadthRet1Pos,c.breadthRet5Pos,c.breadthRet15Pos,
      c.marketMedianRet1,c.marketMedianRet5,
      c.csRet1Pct,c.csRet5Pct,c.csRvolPct,c.csDollarAccelPct,
      c.spyRet1Ctx,c.spyRet5Ctx,c.qqqRet1Ctx,c.qqqRet5Ctx,
      c.iwmRet1Ctx,c.iwmRet5Ctx,c.rsVsSpy5,c.rsVsQqq5
    FROM sample_events e
    LEFT JOIN ctx c
      ON c.symbol=e.symbol
     AND c.ts=e.timestamp
    ORDER BY e.eventId
    """


def augment_month(raw_path:Path,month_df:pd.DataFrame)->pd.DataFrame:
    x=month_df.copy().reset_index(drop=False).rename(columns={"index":"eventId"})
    x["eventId"]=np.arange(len(x),dtype=np.int64)
    keys=x[["eventId","symbol","timestamp"]].copy()
    keys["symbol"]=keys["symbol"].astype(str).str.upper()
    keys["timestamp"]=pd.to_datetime(keys["timestamp"],errors="coerce")
    con=duckdb.connect()
    con.register("sample_events",keys)
    ctx=con.execute(context_query(raw_path)).fetchdf()
    con.close()
    out=x.merge(ctx,on="eventId",how="left")
    return out


def fit_and_eval(data:pd.DataFrame)->dict:
    trainer.FEATURES=list(FEATURES)
    for c in FEATURES:
        data[c]=pd.to_numeric(data[c],errors="coerce")
    data=data.replace([np.inf,-np.inf],np.nan)
    train=data[data["period"]=="train"].copy()
    cal=data[data["period"]=="calibration"].copy()
    val=data[data["period"]=="validation"].copy()
    fresh=data[data["period"]=="fresh_oos"].copy()
    if min(len(train),len(cal),len(val),len(fresh))==0:
        raise RuntimeError(
            f"CONTEXT_EMPTY_PERIOD:{len(train)}:{len(cal)}:{len(val)}:{len(fresh)}"
        )
    y=pd.to_numeric(train["labelStrict3"],errors="coerce").fillna(0).astype(int)
    model=LGBMClassifier(
        objective="binary",
        n_estimators=600,
        learning_rate=0.03,
        num_leaves=31,
        min_child_samples=120,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.20,
        reg_lambda=1.75,
        random_state=83,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(
        train[FEATURES],
        y,
        sample_weight=trainer.sampling_weight(train),
    )
    cal_score=model.predict_proba(cal[FEATURES])[:,1]
    selected=trainer.select_threshold(
        cal,"labelStrict3",cal_score,0.30
    )
    threshold=float(selected["winner"]["threshold"])
    val_score=model.predict_proba(val[FEATURES])[:,1]
    fresh_score=model.predict_proba(fresh[FEATURES])[:,1]
    return {
        "rowCounts":{
            "train":len(train),"calibration":len(cal),
            "validation":len(val),"freshOos":len(fresh),
        },
        "calibrationSelection":selected,
        "validation":trainer.weighted_metrics(
            val,"labelStrict3",val_score,threshold
        ),
        "freshOos":trainer.weighted_metrics(
            fresh,"labelStrict3",fresh_score,threshold
        ),
        "featureImportance":sorted(
            [
                {"feature":f,"importance":float(v)}
                for f,v in zip(FEATURES,model.feature_importances_)
            ],
            key=lambda z:z["importance"],reverse=True,
        ),
    }


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    events=pd.read_parquet(args.events)
    events["month"]=events["month"].astype(str)
    months=sorted(events["month"].unique())
    frames=[];audits=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for month in months:
            p=root/f"ohlcv_{month}.parquet"
            census._download_us_month(pd.Timestamp(month+"-01",tz="UTC"),p)
            src=events[events["month"]==month].copy()
            aug=augment_month(p,src)
            matched=int(aug[CONTEXT_FEATURES].notna().all(axis=1).sum())
            audits.append({
                "month":month,
                "rows":len(aug),
                "completeContextRows":matched,
                "coverage":matched/max(len(aug),1),
            })
            frames.append(aug)
            p.unlink(missing_ok=True)
            print(json.dumps({"contextMonth":audits[-1]},ensure_ascii=False),flush=True)

    data=pd.concat(frames,ignore_index=True)
    model_result=fit_and_eval(data)
    cal=model_result["calibrationSelection"]["winner"]
    val=model_result["validation"]
    fresh=model_result["freshOos"]
    promotion={
        "calibrationPrecisionAtLeast30pct":cal["populationWeightedPrecision"]>=0.30,
        "validationPrecisionAtLeast30pct":val["populationWeightedPrecision"]>=0.30,
        "freshPrecisionAtLeast30pct":fresh["populationWeightedPrecision"]>=0.30,
        "validationRecallAtLeast20pct":val["recall"]>=0.20,
        "freshRecallAtLeast20pct":fresh["recall"]>=0.20,
    }
    result={
        "schemaVersion":1,
        "contract":"us-all-session-context-strict3-ai-v7",
        "features":FEATURES,
        "contextFeatures":CONTEXT_FEATURES,
        "contextAudits":audits,
        **model_result,
        "promotionDiagnostic":promotion,
        "promotionPass":all(promotion.values()),
        "truthBoundary":{
            "sameFrozenEventDatasetAsV4":True,
            "clockFeaturesExcluded":True,
            "marketBreadthComputedFromFullEligibleMinuteUniverse":True,
            "crossSectionalRanksComputedBeforeSampleJoin":True,
            "spyQqqIwmContextUsesSameCompletedMinute":True,
            "strict3PathAwareLabel":True,
            "modelFitUsesTrainOnly":True,
            "thresholdUsesCalibrationOnly":True,
            "validationAndFreshOosUntouched":True,
            "requiresFullMinuteCalibrationBeforeExactReplay":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    pd.DataFrame(audits).to_csv(out/"context-audit.csv",index=False)
    pd.DataFrame(model_result["calibrationSelection"]["grid"]).to_csv(
        out/"threshold-grid.csv",index=False
    )
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
