#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

FEATURES=[
    "ret1","ret5","ret15","rvol60","dollarAccel5","rangePct","closeLoc",
    "distHigh30","distLow30","vwapDist","minuteOfSession","logPrice",
    "logPriorDollar","sessionCode",
]
TARGETS={
    "MFE3":{"label":"labelMfe3","recallFloor":0.70},
    "MFE5":{"label":"labelMfe5","recallFloor":0.60},
    "MFE10":{"label":"labelMfe10","recallFloor":0.50},
    "STRICT3":{"label":"labelStrict3","recallFloor":0.60},
}
NEGATIVE_SAMPLE_PCT=3.0


def clean_x(df:pd.DataFrame)->pd.DataFrame:
    return df[FEATURES].replace([np.inf,-np.inf],np.nan).astype(float)


def sampling_weight(df:pd.DataFrame)->np.ndarray:
    # Every +3% 15m bucket is retained; only buckets with no +3% opportunity
    # are downsampled to 3%. Restore their approximate population weight.
    sampled_negative=(pd.to_numeric(df["labelMfe3"],errors="coerce").fillna(0).astype(int)==0)
    return np.where(sampled_negative,100.0/NEGATIVE_SAMPLE_PCT,1.0)


def weighted_metrics(df:pd.DataFrame,label:str,score:np.ndarray,threshold:float)->dict:
    y=pd.to_numeric(df[label],errors="coerce").fillna(0).astype(int).to_numpy()
    pred=score>=threshold
    w=sampling_weight(df)
    tp=float(w[(pred)&(y==1)].sum())
    fp=float(w[(pred)&(y==0)].sum())
    fn=float(w[(~pred)&(y==1)].sum())
    tn=float(w[(~pred)&(y==0)].sum())
    positives=int((y==1).sum())
    detected=int(((pred)&(y==1)).sum())
    precision=tp/max(tp+fp,1e-12)
    recall=detected/max(positives,1)
    specificity=tn/max(tn+fp,1e-12)
    f1=2*precision*recall/max(precision+recall,1e-12)
    weighted_selected=(tp+fp)/max(tp+fp+tn+fn,1e-12)
    raw_selected=float(pred.mean()) if len(pred) else 0.0

    cluster_recall=None
    cluster_total=0
    cluster_detected=0
    if "eventCluster" in df.columns and "month" in df.columns:
        z=df.loc[y==1,["month","eventCluster"]].copy()
        z["pred"]=pred[y==1]
        z=z.dropna(subset=["eventCluster"])
        if len(z):
            z["clusterKey"]=z["month"].astype(str)+":"+z["eventCluster"].astype(str)
            agg=z.groupby("clusterKey",sort=False)["pred"].max()
            cluster_total=int(len(agg))
            cluster_detected=int(agg.sum())
            cluster_recall=cluster_detected/max(cluster_total,1)

    return {
        "threshold":float(threshold),
        "rows":int(len(df)),
        "positiveBuckets":positives,
        "detectedPositiveBuckets":detected,
        "recall":float(recall),
        "populationWeightedPrecision":float(precision),
        "populationWeightedSpecificity":float(specificity),
        "populationWeightedF1":float(f1),
        "populationWeightedSelectedShare":float(weighted_selected),
        "sampleSelectedShare":float(raw_selected),
        "positiveEventClusters":cluster_total,
        "detectedPositiveEventClusters":cluster_detected,
        "eventClusterRecall":None if cluster_recall is None else float(cluster_recall),
        "weightedConfusion":{"tp":tp,"fp":fp,"fn":fn,"tn":tn},
    }


def select_threshold(cal:pd.DataFrame,label:str,score:np.ndarray,recall_floor:float)->dict:
    qs=np.unique(np.concatenate([
        np.linspace(0.50,0.90,9),
        np.linspace(0.91,0.99,9),
        np.array([0.9925,0.995,0.9975,0.999]),
    ]))
    thresholds=np.unique(np.quantile(score,qs))
    rows=[weighted_metrics(cal,label,score,float(t)) for t in thresholds]
    eligible=[r for r in rows if r["recall"]>=recall_floor]
    if eligible:
        winner=max(
            eligible,
            key=lambda r:(
                r["populationWeightedPrecision"],
                r["eventClusterRecall"] if r["eventClusterRecall"] is not None else -1,
                -r["populationWeightedSelectedShare"],
                r["recall"],
            ),
        )
        mode="RECALL_FLOOR"
    else:
        winner=max(
            rows,
            key=lambda r:(
                r["populationWeightedF1"],
                r["recall"],
                r["populationWeightedPrecision"],
            ),
        )
        mode="F1_FALLBACK"
    return {"selectionMode":mode,"recallFloor":recall_floor,"winner":winner,"grid":rows}


def fit_one(train:pd.DataFrame,cal:pd.DataFrame,val:pd.DataFrame,fresh:pd.DataFrame,name:str,spec:dict)->dict:
    label=spec["label"]
    y=pd.to_numeric(train[label],errors="coerce").fillna(0).astype(int)
    if len(train)<5000 or y.nunique()<2:
        raise RuntimeError(f"INSUFFICIENT_TRAIN:{name}:{len(train)}:{y.nunique()}")

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
    model.fit(clean_x(train),y,sample_weight=sampling_weight(train))

    cal_score=model.predict_proba(clean_x(cal))[:,1]
    selected=select_threshold(cal,label,cal_score,float(spec["recallFloor"]))
    threshold=float(selected["winner"]["threshold"])
    val_score=model.predict_proba(clean_x(val))[:,1]
    fresh_score=model.predict_proba(clean_x(fresh))[:,1]

    importance=sorted(
        [{"feature":f,"importance":float(v)} for f,v in zip(FEATURES,model.feature_importances_)],
        key=lambda z:z["importance"],reverse=True,
    )
    return {
        "target":name,
        "label":label,
        "trainRows":int(len(train)),
        "trainPositiveBuckets":int(y.sum()),
        "calibrationSelection":selected,
        "validation":weighted_metrics(val,label,val_score,threshold),
        "freshOos":weighted_metrics(fresh,label,fresh_score,threshold),
        "featureImportance":importance,
    }


def main()->None:
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    data=pd.read_parquet(args.events)
    missing=[c for c in FEATURES+["period","labelMfe3","labelMfe5","labelMfe10","labelStrict3"] if c not in data.columns]
    if missing:
        raise RuntimeError("AI_EVENTS_MISSING:"+",".join(missing))

    for c in FEATURES:
        data[c]=pd.to_numeric(data[c],errors="coerce")
    data=data.replace([np.inf,-np.inf],np.nan)
    data=data.dropna(subset=["period"]).copy()

    train=data[data["period"]=="train"].copy()
    cal=data[data["period"]=="calibration"].copy()
    val=data[data["period"]=="validation"].copy()
    fresh=data[data["period"]=="fresh_oos"].copy()
    if min(len(train),len(cal),len(val),len(fresh))==0:
        raise RuntimeError(f"PERIOD_EMPTY:{len(train)}:{len(cal)}:{len(val)}:{len(fresh)}")

    models={}
    for name,spec in TARGETS.items():
        models[name]=fit_one(train,cal,val,fresh,name,spec)
        print(json.dumps({
            "target":name,
            "selectedThreshold":models[name]["calibrationSelection"]["winner"]["threshold"],
            "validationRecall":models[name]["validation"]["recall"],
            "validationPrecision":models[name]["validation"]["populationWeightedPrecision"],
            "freshRecall":models[name]["freshOos"]["recall"],
            "freshPrecision":models[name]["freshOos"]["populationWeightedPrecision"],
        },ensure_ascii=False),flush=True)

    primary=models["MFE3"]
    result={
        "schemaVersion":1,
        "contract":"us-all-session-opportunity-ai-v4",
        "featureColumns":FEATURES,
        "negativeBucketSamplePct":NEGATIVE_SAMPLE_PCT,
        "periodRows":{
            "train":int(len(train)),"calibration":int(len(cal)),
            "validation":int(len(val)),"freshOos":int(len(fresh)),
        },
        "models":models,
        "primaryMfe3":{
            "validationRecall":primary["validation"]["recall"],
            "validationEventClusterRecall":primary["validation"]["eventClusterRecall"],
            "validationPopulationWeightedPrecision":primary["validation"]["populationWeightedPrecision"],
            "freshOosRecall":primary["freshOos"]["recall"],
            "freshOosEventClusterRecall":primary["freshOos"]["eventClusterRecall"],
            "freshOosPopulationWeightedPrecision":primary["freshOos"]["populationWeightedPrecision"],
        },
        "truthBoundary":{
            "modelFitUsesTrainOnly":True,
            "thresholdSelectionUsesCalibrationOnly":True,
            "validationExcludedFromFitAndThresholdSelection":True,
            "freshOosExcludedFromFitAndThresholdSelection":True,
            "negativeSamplingCorrectedWithPopulationWeights":True,
            "allPositiveMfe3BucketsWereRetainedByExtractor":True,
            "featuresUseCurrentAndPastOnly":True,
            "openingTimeNotRequired":True,
            "preRegularPostAllEligible":True,
            "thisStageMeasuresDetectionNotTradingPnl":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    rows=[]
    for name,r in models.items():
        for split in ("validation","freshOos"):
            rows.append({"target":name,"split":split,**r[split]})
    pd.DataFrame(rows).to_csv(out/"evaluation.csv",index=False)
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)


if __name__=="__main__":
    main()
