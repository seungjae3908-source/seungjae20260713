#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

FEATURES=[
    "ret1","ret5","ret15","rvol60","dollarAccel5",
    "distHigh30","distLow30","closeRangeLoc","vwapDist",
    "minuteOfSession","logClose","logPriorDollar","marketCode",
]
TARGETS={
    "CLOSE3":{"label":"labelClose3","recallFloor":0.70},
    "CLOSE5":{"label":"labelClose5","recallFloor":0.60},
    "CLOSE10":{"label":"labelClose10","recallFloor":0.45},
}
NEGATIVE_SAMPLE_PCT=2.0
MARKET_CODE={"KOSPI":0.0,"KOSDAQ":1.0,"KONEX":2.0,"UNKNOWN":3.0}

def prepare(df:pd.DataFrame)->pd.DataFrame:
    x=df.copy()
    x["timestamp"]=pd.to_datetime(x["timestamp"],errors="coerce")
    x["date"]=pd.to_datetime(x["date"],errors="coerce").dt.date
    x["logClose"]=np.log(pd.to_numeric(x["close"],errors="coerce").clip(lower=1.0))
    x["logPriorDollar"]=np.log(pd.to_numeric(x["priorDollar60"],errors="coerce").clip(lower=1.0))
    x["marketCode"]=x["exchangeMarket"].astype(str).map(MARKET_CODE).fillna(3.0)
    for c in FEATURES:
        x[c]=pd.to_numeric(x[c],errors="coerce")
    return x.replace([np.inf,-np.inf],np.nan).dropna(subset=["timestamp","date"])

def sample_weight(df:pd.DataFrame)->np.ndarray:
    base=pd.to_numeric(df["labelClose3"],errors="coerce").fillna(0).astype(int).to_numpy()
    return np.where(base==0,100.0/NEGATIVE_SAMPLE_PCT,1.0)

def add_clusters(df:pd.DataFrame)->pd.DataFrame:
    x=df.copy()
    x["eventCluster"]=pd.NA
    pos=x[pd.to_numeric(x["labelClose3"],errors="coerce").fillna(0).astype(int)==1].copy()
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

def weighted_metrics(df:pd.DataFrame,label:str,score:np.ndarray,threshold:float)->dict:
    y=pd.to_numeric(df[label],errors="coerce").fillna(0).astype(int).to_numpy()
    pred=score>=threshold
    w=sample_weight(df)
    tp=float(w[(pred)&(y==1)].sum())
    fp=float(w[(pred)&(y==0)].sum())
    fn=float(w[(~pred)&(y==1)].sum())
    tn=float(w[(~pred)&(y==0)].sum())
    precision=tp/max(tp+fp,1e-12)
    recall=float(((pred)&(y==1)).sum()/max((y==1).sum(),1))
    f1=2*precision*recall/max(precision+recall,1e-12)

    cluster_total=0
    cluster_detected=0
    cluster_recall=None
    if "eventCluster" in df.columns:
        z=df.loc[y==1,["eventCluster"]].copy()
        z["pred"]=pred[y==1]
        z=z.dropna(subset=["eventCluster"])
        if len(z):
            agg=z.groupby("eventCluster",sort=False)["pred"].max()
            cluster_total=int(len(agg))
            cluster_detected=int(agg.sum())
            cluster_recall=cluster_detected/max(cluster_total,1)

    opening=(pd.to_numeric(df["minuteOfSession"],errors="coerce").fillna(-1).to_numpy()>=0)&(
        pd.to_numeric(df["minuteOfSession"],errors="coerce").fillna(-1).to_numpy()<5
    )
    outside=~opening
    pos=y==1
    opening_total=int((pos&opening).sum())
    outside_total=int((pos&outside).sum())
    opening_detected=int((pos&opening&pred).sum())
    outside_detected=int((pos&outside&pred).sum())

    return {
        "threshold":float(threshold),
        "rows":int(len(df)),
        "positiveBuckets":int(pos.sum()),
        "detectedPositiveBuckets":int((pos&pred).sum()),
        "recall":recall,
        "populationWeightedPrecision":float(precision),
        "populationWeightedF1":float(f1),
        "populationWeightedSelectedShare":float((tp+fp)/max(tp+fp+tn+fn,1e-12)),
        "eventClusters":cluster_total,
        "detectedEventClusters":cluster_detected,
        "eventClusterRecall":None if cluster_recall is None else float(cluster_recall),
        "opening5PositiveBuckets":opening_total,
        "opening5Recall":opening_detected/max(opening_total,1),
        "outsideOpening5PositiveBuckets":outside_total,
        "outsideOpening5Recall":outside_detected/max(outside_total,1),
        "weightedConfusion":{"tp":tp,"fp":fp,"fn":fn,"tn":tn},
    }

def select_threshold(cal:pd.DataFrame,label:str,score:np.ndarray,recall_floor:float)->dict:
    qs=np.unique(np.concatenate([
        np.linspace(0.25,0.85,13),
        np.linspace(0.875,0.975,5),
        np.array([0.985,0.99,0.995]),
    ]))
    thresholds=np.unique(np.quantile(score,qs))
    rows=[weighted_metrics(cal,label,score,float(t)) for t in thresholds]
    eligible=[
        r for r in rows
        if r["recall"]>=recall_floor
        and (r["eventClusterRecall"] is None or r["eventClusterRecall"]>=recall_floor)
    ]
    if eligible:
        winner=max(eligible,key=lambda r:(
            r["populationWeightedPrecision"],
            r["eventClusterRecall"] if r["eventClusterRecall"] is not None else -1,
            r["outsideOpening5Recall"],
            -r["populationWeightedSelectedShare"],
        ))
        mode="RECALL_FLOOR"
    else:
        winner=max(rows,key=lambda r:(
            r["populationWeightedF1"],r["recall"],r["populationWeightedPrecision"]
        ))
        mode="F1_FALLBACK"
    return {"selectionMode":mode,"recallFloor":recall_floor,"winner":winner,"grid":rows}

def fit_one(train:pd.DataFrame,cal:pd.DataFrame,val:pd.DataFrame,diag:pd.DataFrame,name:str,spec:dict)->dict:
    label=spec["label"]
    y=pd.to_numeric(train[label],errors="coerce").fillna(0).astype(int)
    if len(train)<5000 or y.nunique()<2:
        raise RuntimeError(f"KR_AI_INSUFFICIENT_TRAIN:{name}:{len(train)}:{y.nunique()}")
    model=LGBMClassifier(
        objective="binary",
        n_estimators=400,
        learning_rate=0.035,
        num_leaves=31,
        min_child_samples=80,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.15,
        reg_lambda=1.5,
        random_state=57,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(train[FEATURES],y,sample_weight=sample_weight(train))
    cal_score=model.predict_proba(cal[FEATURES])[:,1]
    chosen=select_threshold(cal,label,cal_score,float(spec["recallFloor"]))
    threshold=float(chosen["winner"]["threshold"])
    val_score=model.predict_proba(val[FEATURES])[:,1]
    diag_score=model.predict_proba(diag[FEATURES])[:,1]
    importance=sorted(
        [{"feature":f,"importance":float(v)} for f,v in zip(FEATURES,model.feature_importances_)],
        key=lambda z:z["importance"],reverse=True,
    )
    return {
        "target":name,
        "label":label,
        "trainRows":int(len(train)),
        "trainPositiveBuckets":int(y.sum()),
        "calibrationSelection":chosen,
        "validation":weighted_metrics(val,label,val_score,threshold),
        "lastDayDiagnostic":weighted_metrics(diag,label,diag_score,threshold),
        "featureImportance":importance,
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    data=prepare(pd.read_parquet(args.events))
    data=add_clusters(data)
    dates=sorted(d for d in data["date"].dropna().unique())
    if len(dates)<4:
        raise RuntimeError(f"KR_AI_TOO_FEW_DATES:{len(dates)}")

    # Recent-only diagnostic split. Keep the last date completely untouched.
    n=len(dates)
    train_end=max(1,n-3)
    train_dates=dates[:train_end]
    cal_date=dates[train_end]
    val_date=dates[train_end+1] if train_end+1<n-1 else cal_date
    diag_date=dates[-1]

    train=data[data["date"].isin(train_dates)].copy()
    cal=data[data["date"]==cal_date].copy()
    val=data[data["date"]==val_date].copy()
    diag=data[data["date"]==diag_date].copy()
    if min(len(train),len(cal),len(val),len(diag))==0:
        raise RuntimeError(f"KR_AI_EMPTY_SPLIT:{len(train)}:{len(cal)}:{len(val)}:{len(diag)}")

    models={}
    for name,spec in TARGETS.items():
        models[name]=fit_one(train,cal,val,diag,name,spec)
        print(json.dumps({
            "target":name,
            "validationRecall":models[name]["validation"]["recall"],
            "validationPrecision":models[name]["validation"]["populationWeightedPrecision"],
            "lastDayRecall":models[name]["lastDayDiagnostic"]["recall"],
            "lastDayPrecision":models[name]["lastDayDiagnostic"]["populationWeightedPrecision"],
        },ensure_ascii=False),flush=True)

    primary=models["CLOSE3"]
    result={
        "schemaVersion":1,
        "contract":"kr-recent-all-session-opportunity-ai-v1",
        "dateSplit":{
            "allDates":[str(x) for x in dates],
            "trainDates":[str(x) for x in train_dates],
            "calibrationDate":str(cal_date),
            "validationDate":str(val_date),
            "lastDayDiagnosticDate":str(diag_date),
        },
        "models":models,
        "primaryClose3":{
            "validationRecall":primary["validation"]["recall"],
            "validationEventClusterRecall":primary["validation"]["eventClusterRecall"],
            "validationPrecision":primary["validation"]["populationWeightedPrecision"],
            "validationOutsideOpening5Recall":primary["validation"]["outsideOpening5Recall"],
            "lastDayRecall":primary["lastDayDiagnostic"]["recall"],
            "lastDayEventClusterRecall":primary["lastDayDiagnostic"]["eventClusterRecall"],
            "lastDayPrecision":primary["lastDayDiagnostic"]["populationWeightedPrecision"],
            "lastDayOutsideOpening5Recall":primary["lastDayDiagnostic"]["outsideOpening5Recall"],
        },
        "truthBoundary":{
            "sourceIsRecentSevenTradingDaysOnly":True,
            "modelFitUsesEarlierDatesOnly":True,
            "thresholdSelectionUsesCalibrationDateOnly":True,
            "validationDateExcludedFromFitAndThresholdSelection":True,
            "lastDayCompletelyExcludedFromFitAndThresholdSelection":True,
            "negativeSamplingCorrectedWithPopulationWeights":True,
            "openingFiveMinutesNotRequired":True,
            "thisStageMeasuresRecentDetectionNotThreeYearProfitability":True,
            "labelsUseFutureCloseProxyNotIntrabarHigh":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    pd.DataFrame([
        {"target":name,"split":split,**r[split]}
        for name,r in models.items()
        for split in ("validation","lastDayDiagnostic")
    ]).to_csv(out/"evaluation.csv",index=False)
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
