#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

NEGATIVE_SAMPLE_PCT=2.0
MARKET_CODE={"KOSPI":0.0,"KOSDAQ":1.0,"KONEX":2.0,"UNKNOWN":3.0}
FEATURES=[
    "ret1","ret5","ret15","rvol60","dollarAccel5",
    "distHigh30","distLow30","closeRangeLoc","vwapDist",
    "logClose","logPriorDollar","marketCode",
]


def prepare(df:pd.DataFrame)->pd.DataFrame:
    x=df.copy()
    x["timestamp"]=pd.to_datetime(x["timestamp"],errors="coerce")
    x["date"]=pd.to_datetime(x["date"],errors="coerce").dt.date
    x["logClose"]=np.log(pd.to_numeric(x["close"],errors="coerce").clip(lower=1.0))
    x["logPriorDollar"]=np.log(
        pd.to_numeric(x["priorDollar60"],errors="coerce").clip(lower=1.0)
    )
    x["marketCode"]=x["exchangeMarket"].astype(str).map(MARKET_CODE).fillna(3.0)
    for c in FEATURES:
        x[c]=pd.to_numeric(x[c],errors="coerce")
    x["labelPath3"]=pd.to_numeric(x["labelPath3"],errors="coerce").fillna(0).astype(int)
    return x.replace([np.inf,-np.inf],np.nan).dropna(
        subset=FEATURES+["timestamp","date","labelPath3"]
    )


def sample_weight(df:pd.DataFrame)->np.ndarray:
    y=df["labelPath3"].to_numpy(int)
    return np.where(y==0,100.0/NEGATIVE_SAMPLE_PCT,1.0)


def add_clusters(df:pd.DataFrame)->pd.DataFrame:
    x=df.copy()
    x["eventCluster"]=pd.NA
    pos=x[x["labelPath3"]==1].copy()
    cid=0
    for symbol,g in pos.sort_values("timestamp").groupby("symbol",sort=False):
        last=None
        for idx,row in g.iterrows():
            t=pd.Timestamp(row["timestamp"])
            if last is None or (t-last)>pd.Timedelta(minutes=60):
                cid+=1
            x.at[idx,"eventCluster"]=cid
            last=t
    return x


def metrics(df:pd.DataFrame,score:np.ndarray,threshold:float)->dict:
    y=df["labelPath3"].to_numpy(int)
    pred=score>=threshold
    w=sample_weight(df)
    tp=float(w[pred&(y==1)].sum())
    fp=float(w[pred&(y==0)].sum())
    fn=float(w[(~pred)&(y==1)].sum())
    tn=float(w[(~pred)&(y==0)].sum())
    precision=tp/max(tp+fp,1e-12)
    recall=float((pred&(y==1)).sum()/max((y==1).sum(),1))
    selected_share=float((tp+fp)/max(tp+fp+fn+tn,1e-12))

    cluster_recall=None
    clusters=0
    detected_clusters=0
    z=df.loc[y==1,["eventCluster"]].copy()
    z["pred"]=pred[y==1]
    z=z.dropna(subset=["eventCluster"])
    if len(z):
        agg=z.groupby("eventCluster",sort=False)["pred"].max()
        clusters=int(len(agg))
        detected_clusters=int(agg.sum())
        cluster_recall=detected_clusters/max(clusters,1)

    return {
        "threshold":float(threshold),
        "rows":int(len(df)),
        "sampleSelected":int(pred.sum()),
        "positiveBuckets":int((y==1).sum()),
        "detectedPositiveBuckets":int((pred&(y==1)).sum()),
        "recall":recall,
        "populationWeightedPrecision":float(precision),
        "populationWeightedSelectedShare":selected_share,
        "eventClusters":clusters,
        "detectedEventClusters":detected_clusters,
        "eventClusterRecall":None if cluster_recall is None else float(cluster_recall),
        "weightedConfusion":{"tp":tp,"fp":fp,"fn":fn,"tn":tn},
    }


def choose_threshold(cal:pd.DataFrame,score:np.ndarray)->dict:
    qs=np.unique(np.concatenate([
        np.linspace(0.40,0.90,11),
        np.linspace(0.91,0.99,9),
        np.array([0.9925,0.995,0.9975,0.999]),
    ]))
    thresholds=np.unique(np.quantile(score,qs))
    rows=[metrics(cal,score,float(t)) for t in thresholds]
    eligible=[
        r for r in rows
        if r["sampleSelected"]>=50
        and r["recall"]>=0.20
        and r["populationWeightedPrecision"]>=0.40
        and r["populationWeightedSelectedShare"]<=0.20
        and (
            r["eventClusterRecall"] is None
            or r["eventClusterRecall"]>=0.30
        )
    ]
    if eligible:
        winner=max(
            eligible,
            key=lambda r:(
                r["populationWeightedPrecision"],
                r["eventClusterRecall"] if r["eventClusterRecall"] is not None else -1,
                r["recall"],
                -r["populationWeightedSelectedShare"],
            ),
        )
        mode="PATH_PRECISION_RECALL_GATE"
    else:
        diagnostic=[r for r in rows if r["sampleSelected"]>=50] or rows
        winner=max(
            diagnostic,
            key=lambda r:(
                r["populationWeightedPrecision"],
                r["recall"],
                -r["populationWeightedSelectedShare"],
            ),
        )
        mode="BEST_DIAGNOSTIC"
    return {"selectionMode":mode,"winner":winner,"grid":rows}


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    data=add_clusters(prepare(pd.read_parquet(args.events)))
    dates=sorted(d for d in data["date"].dropna().unique())
    if len(dates)<4:
        raise RuntimeError(f"KR_PATH_AI_TOO_FEW_DATES:{len(dates)}")
    n=len(dates)
    train_end=max(1,n-3)
    train_dates=dates[:train_end]
    cal_date=dates[train_end]
    val_date=dates[train_end+1] if train_end+1<n-1 else cal_date
    fresh_date=dates[-1]

    train=data[data["date"].isin(train_dates)].copy()
    cal=data[data["date"]==cal_date].copy()
    val=data[data["date"]==val_date].copy()
    fresh=data[data["date"]==fresh_date].copy()
    if min(len(train),len(cal),len(val),len(fresh))==0:
        raise RuntimeError(
            f"KR_PATH_AI_EMPTY_SPLIT:{len(train)}:{len(cal)}:{len(val)}:{len(fresh)}"
        )

    y=train["labelPath3"].astype(int)
    model=LGBMClassifier(
        objective="binary",
        n_estimators=450,
        learning_rate=0.035,
        num_leaves=31,
        min_child_samples=80,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.20,
        reg_lambda=1.5,
        random_state=79,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(train[FEATURES],y,sample_weight=sample_weight(train))
    cal_score=model.predict_proba(cal[FEATURES])[:,1]
    selection=choose_threshold(cal,cal_score)
    threshold=float(selection["winner"]["threshold"])
    val_score=model.predict_proba(val[FEATURES])[:,1]
    fresh_score=model.predict_proba(fresh[FEATURES])[:,1]
    val_metrics=metrics(val,val_score,threshold)
    fresh_metrics=metrics(fresh,fresh_score,threshold)

    promotion={
        "validation":{
            "precisionAtLeast40pct":val_metrics["populationWeightedPrecision"]>=0.40,
            "recallAtLeast20pct":val_metrics["recall"]>=0.20,
            "clusterRecallAtLeast30pct":(
                val_metrics["eventClusterRecall"] is not None
                and val_metrics["eventClusterRecall"]>=0.30
            ),
        },
        "fresh":{
            "precisionAtLeast40pct":fresh_metrics["populationWeightedPrecision"]>=0.40,
            "recallAtLeast20pct":fresh_metrics["recall"]>=0.20,
            "clusterRecallAtLeast30pct":(
                fresh_metrics["eventClusterRecall"] is not None
                and fresh_metrics["eventClusterRecall"]>=0.30
            ),
        },
    }
    result={
        "schemaVersion":1,
        "contract":"kr-recent-all-session-path-ai-v21",
        "features":FEATURES,
        "removedClockFeature":"minuteOfSession",
        "dateSplit":{
            "allDates":[str(x) for x in dates],
            "trainDates":[str(x) for x in train_dates],
            "calibrationDate":str(cal_date),
            "validationDate":str(val_date),
            "freshDiagnosticDate":str(fresh_date),
        },
        "rowCounts":{
            "train":len(train),"calibration":len(cal),
            "validation":len(val),"fresh":len(fresh),
        },
        "calibrationSelection":selection,
        "validation":val_metrics,
        "fresh":fresh_metrics,
        "featureImportance":sorted(
            [
                {"feature":f,"importance":float(v)}
                for f,v in zip(FEATURES,model.feature_importances_)
            ],
            key=lambda z:z["importance"],
            reverse=True,
        ),
        "promotionDiagnostic":promotion,
        "promotionPass":all(
            all(v.values()) for v in promotion.values()
        ),
        "truthBoundary":{
            "sourceRecentSevenTradingDaysOnly":True,
            "labelIsTargetBeforeStopOnMinuteClosePath":True,
            "modelFitUsesEarlierDatesOnly":True,
            "thresholdUsesCalibrationDateOnly":True,
            "validationAndFreshDatesUntouched":True,
            "clockTimeFeatureRemoved":True,
            "negativeSamplingCorrectedWithPopulationWeights":True,
            "requiresExactReplayBeforeAnyEconomicClaim":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    pd.DataFrame(selection["grid"]).to_csv(out/"threshold-grid.csv",index=False)
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)


if __name__=="__main__":
    main()
