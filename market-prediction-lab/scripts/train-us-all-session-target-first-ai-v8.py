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
    "distHigh30","distLow30","vwapDist","logPrice","logPriorDollar",
]
NEGATIVE_SAMPLE_PCT=3.0

def sampling_weight(df:pd.DataFrame)->np.ndarray:
    mfe3=pd.to_numeric(df["labelMfe3"],errors="coerce").fillna(0).astype(int)
    return np.where(mfe3.to_numpy()==0,100.0/NEGATIVE_SAMPLE_PCT,1.0)

def clean_x(df:pd.DataFrame)->pd.DataFrame:
    return df[FEATURES].replace([np.inf,-np.inf],np.nan).astype(float)

def metrics(df:pd.DataFrame,score:np.ndarray,threshold:float)->dict:
    y=pd.to_numeric(df["labelTargetFirst3"],errors="coerce").fillna(0).astype(int).to_numpy()
    net=pd.to_numeric(df["exactNetReturn"],errors="coerce").fillna(-1.0).to_numpy(float)
    pred=score>=threshold
    w=sampling_weight(df)

    tp=float(w[pred&(y==1)].sum())
    fp=float(w[pred&(y==0)].sum())
    fn=float(w[(~pred)&(y==1)].sum())
    tn=float(w[(~pred)&(y==0)].sum())
    precision=tp/max(tp+fp,1e-12)
    recall=float(((pred)&(y==1)).sum()/max((y==1).sum(),1))
    selected_weight=float(w[pred].sum())
    population_weight=float(w.sum())
    selected_share=selected_weight/max(population_weight,1e-12)
    mean_net=float((w[pred]*net[pred]).sum()/max(selected_weight,1e-12)) if pred.any() else 0.0
    pos_sum=float((w[pred]*np.maximum(net[pred],0)).sum()) if pred.any() else 0.0
    neg_sum=float((w[pred]*np.maximum(-net[pred],0)).sum()) if pred.any() else 0.0
    pf=pos_sum/max(neg_sum,1e-12) if pred.any() else 0.0

    pos_months=0;neg_months=0
    if pred.any() and "month" in df.columns:
        z=pd.DataFrame({
            "month":df["month"].astype(str).to_numpy()[pred],
            "weightedNet":w[pred]*net[pred],
        })
        sums=z.groupby("month",sort=True)["weightedNet"].sum()
        pos_months=int((sums>0).sum())
        neg_months=int((sums<0).sum())
    active_months=pos_months+neg_months
    positive_month_rate=pos_months/max(active_months,1)

    cluster_total=0;cluster_detected=0;cluster_recall=None
    if "eventCluster" in df.columns and "month" in df.columns:
        z=df.loc[y==1,["month","eventCluster"]].copy()
        z["pred"]=pred[y==1]
        z=z.dropna(subset=["eventCluster"])
        if len(z):
            z["clusterKey"]=z["month"].astype(str)+":"+z["eventCluster"].astype(str)
            agg=z.groupby("clusterKey",sort=False)["pred"].max()
            cluster_total=int(len(agg))
            cluster_detected=int(agg.sum())
            cluster_recall=float(cluster_detected/max(cluster_total,1))

    return {
        "threshold":float(threshold),
        "rows":int(len(df)),
        "sampleSelected":int(pred.sum()),
        "positiveTargetFirstRows":int((y==1).sum()),
        "selectedPositiveRows":int(((pred)&(y==1)).sum()),
        "populationWeightedPrecision":float(precision),
        "recall":float(recall),
        "populationWeightedSelectedShare":float(selected_share),
        "populationWeightedMeanNetReturn":float(mean_net),
        "populationWeightedProfitFactor":float(pf),
        "positiveMonths":pos_months,
        "negativeMonths":neg_months,
        "positiveActiveMonthRate":float(positive_month_rate),
        "targetFirstEventClusters":cluster_total,
        "detectedTargetFirstEventClusters":cluster_detected,
        "eventClusterRecall":cluster_recall,
        "weightedConfusion":{"tp":tp,"fp":fp,"fn":fn,"tn":tn},
    }

def threshold_grid(cal:pd.DataFrame,score:np.ndarray)->dict:
    qs=np.unique(np.concatenate([
        np.linspace(0.50,0.90,17),
        np.linspace(0.91,0.99,17),
        np.array([0.9925,0.995,0.9975,0.999]),
    ]))
    thresholds=np.unique(np.quantile(score,qs))
    rows=[metrics(cal,score,float(t)) for t in thresholds]
    eligible=[
        r for r in rows
        if r["sampleSelected"]>=100
        and r["populationWeightedMeanNetReturn"]>0
        and r["populationWeightedProfitFactor"]>1
        and r["populationWeightedPrecision"]>=0.35
        and r["recall"]>=0.10
        and r["populationWeightedSelectedShare"]<=0.15
        and r["positiveActiveMonthRate"]>=0.50
    ]
    if eligible:
        winner=max(
            eligible,
            key=lambda r:(
                r["populationWeightedMeanNetReturn"],
                r["populationWeightedProfitFactor"],
                r["recall"],
                r["populationWeightedPrecision"],
            ),
        )
        mode="ECONOMIC_GATE"
    else:
        candidates=[r for r in rows if r["sampleSelected"]>=100] or rows
        winner=max(
            candidates,
            key=lambda r:(
                r["populationWeightedMeanNetReturn"],
                r["populationWeightedProfitFactor"],
                r["recall"],
            ),
        )
        mode="BEST_EV_DIAGNOSTIC"
    return {"selectionMode":mode,"winner":winner,"grid":rows}

def promotion(m:dict)->dict:
    checks={
        "positiveWeightedEV":m["populationWeightedMeanNetReturn"]>0,
        "profitFactorAbove1":m["populationWeightedProfitFactor"]>1,
        "precisionAtLeast35pct":m["populationWeightedPrecision"]>=0.35,
        "recallAtLeast10pct":m["recall"]>=0.10,
        "selectedShareAtMost15pct":m["populationWeightedSelectedShare"]<=0.15,
        "positiveActiveMonthRateAtLeast50pct":m["positiveActiveMonthRate"]>=0.50,
    }
    return {"pass":all(checks.values()),"checks":checks}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    data=pd.read_parquet(args.events)
    required=FEATURES+[
        "period","month","labelMfe3","labelTargetFirst3","exactNetReturn"
    ]
    missing=[c for c in required if c not in data.columns]
    if missing:
        raise RuntimeError("TARGET_FIRST_EVENTS_MISSING:"+",".join(missing))
    for c in FEATURES:
        data[c]=pd.to_numeric(data[c],errors="coerce")
    data=data.replace([np.inf,-np.inf],np.nan)
    data=data.dropna(subset=["period","exactNetReturn"]).copy()

    train=data[data["period"]=="train"].copy()
    cal=data[data["period"]=="calibration"].copy()
    val=data[data["period"]=="validation"].copy()
    fresh=data[data["period"]=="fresh_oos"].copy()
    if min(len(train),len(cal),len(val),len(fresh))==0:
        raise RuntimeError(
            f"TARGET_FIRST_EMPTY_PERIOD:{len(train)}:{len(cal)}:{len(val)}:{len(fresh)}"
        )

    y=pd.to_numeric(
        train["labelTargetFirst3"],errors="coerce"
    ).fillna(0).astype(int)
    model=LGBMClassifier(
        objective="binary",
        n_estimators=700,
        learning_rate=0.025,
        num_leaves=31,
        min_child_samples=160,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.25,
        reg_lambda=2.0,
        random_state=97,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(clean_x(train),y,sample_weight=sampling_weight(train))
    cal_score=model.predict_proba(clean_x(cal))[:,1]
    selection=threshold_grid(cal,cal_score)
    threshold=float(selection["winner"]["threshold"])
    train_score=model.predict_proba(clean_x(train))[:,1]
    val_score=model.predict_proba(clean_x(val))[:,1]
    fresh_score=model.predict_proba(clean_x(fresh))[:,1]

    train_m=metrics(train,train_score,threshold)
    val_m=metrics(val,val_score,threshold)
    fresh_m=metrics(fresh,fresh_score,threshold)
    val_gate=promotion(val_m)
    fresh_gate=promotion(fresh_m)

    importance=sorted(
        [{"feature":f,"importance":float(v)} for f,v in zip(FEATURES,model.feature_importances_)],
        key=lambda z:z["importance"],reverse=True,
    )
    result={
        "schemaVersion":1,
        "contract":"us-all-session-target-first-ai-v8",
        "features":FEATURES,
        "periodRows":{
            "train":int(len(train)),
            "calibration":int(len(cal)),
            "validation":int(len(val)),
            "freshOos":int(len(fresh)),
        },
        "trainPositiveRate":float(y.mean()),
        "calibrationSelection":selection,
        "trainDiagnostic":train_m,
        "validation":val_m,
        "freshOos":fresh_m,
        "validationGate":val_gate,
        "freshOosGate":fresh_gate,
        "promotionPass":bool(val_gate["pass"] and fresh_gate["pass"]),
        "featureImportance":importance,
        "truthBoundary":{
            "modelFitUsesTrainOnly":True,
            "thresholdSelectionUsesCalibrationOnly":True,
            "validationAndFreshOosUntouched":True,
            "labelIsExactTargetBeforeStop":True,
            "sameMinuteTargetStopUsesStopFirst":True,
            "entrySlippageAndRoundTripCostIncludedInEconomicOutcome":True,
            "clockFeaturesExcluded":True,
            "negativeSamplingRestoredByPopulationWeights":True,
            "openingTimeNotRequired":True,
            "preRegularPostAllEligible":True,
            "requiresPortfolioReplayIfPromotionPasses":True,
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
