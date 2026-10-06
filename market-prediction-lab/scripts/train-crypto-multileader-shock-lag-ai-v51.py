#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

NEGATIVE_SAMPLE_PCT=2.0
COSTS={"CRYPTO_SPOT":0.0020,"CRYPTO_FUTURES":0.0012}
ENTRY_SLIPPAGE=0.0005

BASE_FEATURES=[
    "compositeSigned","leaderAgreement","leaderShockZ",
    "btcSigned","ethSigned","solSigned",
    "btcZSigned","ethZSigned","solZSigned",
    "altSigned","ret4Signed","ret16Signed",
    "rvol","logPriorDollar","vwapSigned","closeLocSigned",
    "responseRatio","lagGap",
]

def prepare(df:pd.DataFrame)->pd.DataFrame:
    x=df.copy()
    x["direction"]=x["direction"].astype(str).str.upper()
    sign=np.where(x["direction"].eq("SHORT"),-1.0,1.0)
    x["compositeSigned"]=pd.to_numeric(x["compositeRet1"],errors="coerce")*sign
    x["btcSigned"]=pd.to_numeric(x["btcRet1"],errors="coerce")*sign
    x["ethSigned"]=pd.to_numeric(x["ethRet1"],errors="coerce")*sign
    x["solSigned"]=pd.to_numeric(x["solRet1"],errors="coerce")*sign
    x["btcZSigned"]=pd.to_numeric(x["btcZ1"],errors="coerce")*sign
    x["ethZSigned"]=pd.to_numeric(x["ethZ1"],errors="coerce")*sign
    x["solZSigned"]=pd.to_numeric(x["solZ1"],errors="coerce")*sign
    x["altSigned"]=pd.to_numeric(x["altRet1"],errors="coerce")*sign
    x["ret4Signed"]=pd.to_numeric(x["ret4"],errors="coerce")*sign
    x["ret16Signed"]=pd.to_numeric(x["ret16"],errors="coerce")*sign
    x["vwapSigned"]=pd.to_numeric(x["vwapDist"],errors="coerce")*sign
    loc=pd.to_numeric(x["closeLoc"],errors="coerce")
    x["closeLocSigned"]=np.where(sign>0,loc,1.0-loc)
    x["rvol"]=pd.to_numeric(x["rvol"],errors="coerce")
    x["logPriorDollar"]=np.log(
        pd.to_numeric(x["priorDollar24h"],errors="coerce").clip(lower=1.0)
    )
    x["responseRatio"]=pd.to_numeric(x["responseRatio"],errors="coerce")
    x["lagGap"]=pd.to_numeric(x["lagGap"],errors="coerce")
    x["leaderAgreement"]=pd.to_numeric(x["leaderAgreement"],errors="coerce")
    x["leaderShockZ"]=pd.to_numeric(x["leaderShockZ"],errors="coerce")
    x["label"]=pd.to_numeric(x["label"],errors="coerce").fillna(0).astype(int)
    x["grossReturn"]=pd.to_numeric(x["netReturn"],errors="coerce")
    x["period"]=x["period"].astype(str)
    x=x.replace([np.inf,-np.inf],np.nan)
    return x.dropna(subset=BASE_FEATURES+["label","grossReturn","period"]).copy()

def weights(df:pd.DataFrame)->np.ndarray:
    y=df["label"].to_numpy(int)
    return np.where(y==0,100.0/NEGATIVE_SAMPLE_PCT,1.0)

def fit_model(train:pd.DataFrame):
    y=train["label"].astype(int)
    if len(train)<5000 or y.nunique()<2:
        raise RuntimeError(f"MULTILEADER_AI_INSUFFICIENT_TRAIN:{len(train)}:{y.nunique()}")
    model=LGBMClassifier(
        objective="binary",
        n_estimators=650,
        learning_rate=0.03,
        num_leaves=31,
        min_child_samples=120,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.20,
        reg_lambda=1.5,
        random_state=73,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(
        train[BASE_FEATURES],
        y,
        sample_weight=weights(train),
    )
    return model

def metrics(df:pd.DataFrame,score:np.ndarray,threshold:float,cost:float)->dict:
    y=df["label"].to_numpy(int)
    pred=score>=threshold
    w=weights(df)
    selected=pred
    tp=float(w[selected&(y==1)].sum())
    fp=float(w[selected&(y==0)].sum())
    fn=float(w[(~selected)&(y==1)].sum())
    tn=float(w[(~selected)&(y==0)].sum())
    precision=tp/max(tp+fp,1e-12)
    recall=float((selected&(y==1)).sum()/max((y==1).sum(),1))
    selected_share=float((tp+fp)/max(tp+fp+fn+tn,1e-12))
    if selected.any():
        gross=df["grossReturn"].to_numpy(float)[selected]
        sw=w[selected]
        net=gross-cost-ENTRY_SLIPPAGE
        mean_net=float(np.average(net,weights=sw))
        positive_net=float(np.average((net>0).astype(float),weights=sw))
    else:
        mean_net=0.0
        positive_net=0.0
    return {
        "threshold":float(threshold),
        "rows":int(len(df)),
        "sampleSelected":int(selected.sum()),
        "positiveRows":int((y==1).sum()),
        "precision":float(precision),
        "recall":float(recall),
        "populationSelectedShare":selected_share,
        "populationWeightedMeanNetReturn":mean_net,
        "populationWeightedPositiveNetRate":positive_net,
        "weightedConfusion":{"tp":tp,"fp":fp,"fn":fn,"tn":tn},
    }

def choose_threshold(cal:pd.DataFrame,score:np.ndarray,cost:float)->dict:
    qs=np.unique(np.concatenate([
        np.linspace(0.50,0.90,9),
        np.linspace(0.91,0.99,9),
        np.array([0.9925,0.995,0.9975,0.999]),
    ]))
    thresholds=np.unique(np.quantile(score,qs))
    rows=[metrics(cal,score,float(t),cost) for t in thresholds]
    eligible=[
        r for r in rows
        if r["recall"]>=0.10
        and r["populationSelectedShare"]<=0.20
        and r["populationWeightedMeanNetReturn"]>0
    ]
    if eligible:
        winner=max(
            eligible,
            key=lambda r:(
                r["populationWeightedMeanNetReturn"],
                r["precision"],
                r["recall"],
                -r["populationSelectedShare"],
            ),
        )
        mode="POSITIVE_EV_RECALL_FLOOR"
    else:
        winner=max(
            rows,
            key=lambda r:(
                r["populationWeightedMeanNetReturn"],
                r["precision"],
                r["recall"],
            ),
        )
        mode="BEST_EV_DIAGNOSTIC"
    return {"selectionMode":mode,"winner":winner,"grid":rows}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--states",required=True)
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    data=prepare(pd.read_parquet(args.states))
    data=data[data["market"].astype(str)==args.market].copy()
    train=data[data["period"]=="train"].copy()
    cal=data[data["period"]=="calibration"].copy()
    val=data[data["period"]=="validation"].copy()
    fresh=data[data["period"]=="freshOos"].copy()
    if min(len(train),len(cal),len(val),len(fresh))==0:
        raise RuntimeError(
            f"MULTILEADER_EMPTY_PERIOD:{len(train)}:{len(cal)}:{len(val)}:{len(fresh)}"
        )

    model=fit_model(train)
    cal_score=model.predict_proba(cal[BASE_FEATURES])[:,1]
    cost=COSTS[args.market]
    selection=choose_threshold(cal,cal_score,cost)
    threshold=float(selection["winner"]["threshold"])
    train_score=model.predict_proba(train[BASE_FEATURES])[:,1]
    val_score=model.predict_proba(val[BASE_FEATURES])[:,1]
    fresh_score=model.predict_proba(fresh[BASE_FEATURES])[:,1]

    result={
        "schemaVersion":1,
        "contract":"crypto-multileader-shock-lag-ai-v51",
        "market":args.market,
        "features":BASE_FEATURES,
        "sampling":{
            "allPositiveRowsRetained":True,
            "negativeSamplePct":NEGATIVE_SAMPLE_PCT,
            "negativePopulationWeight":100.0/NEGATIVE_SAMPLE_PCT,
        },
        "economicAssumptions":{
            "roundTripCost":cost,
            "entrySlippage":ENTRY_SLIPPAGE,
            "targetPct":0.03,
            "stopPct":0.015,
        },
        "rowCounts":{
            "train":len(train),"calibration":len(cal),
            "validation":len(val),"freshOos":len(fresh),
        },
        "trainPositiveRateSample":float(train["label"].mean()),
        "calibrationSelection":selection,
        "trainDiagnostic":metrics(train,train_score,threshold,cost),
        "validation":metrics(val,val_score,threshold,cost),
        "freshOos":metrics(fresh,fresh_score,threshold,cost),
        "featureImportance":sorted(
            [
                {"feature":f,"importance":float(v)}
                for f,v in zip(BASE_FEATURES,model.feature_importances_)
            ],
            key=lambda z:z["importance"],
            reverse=True,
        ),
        "promotionDiagnostic":{},
        "truthBoundary":{
            "modelFitUsesTrainOnly":True,
            "thresholdSelectionUsesCalibrationOnly":True,
            "validationAndFreshOosUntouched":True,
            "labelIsTargetBeforeStop":True,
            "noClockTimeFeatures":True,
            "negativeSamplingCorrectedByPopulationWeights":True,
            "costAndEntrySlippageAppliedToThresholdEconomics":True,
            "thisStageIs15mScreeningBefore1mReplay":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    for split in ("validation","freshOos"):
        m=result[split]
        result["promotionDiagnostic"][split]={
            "positiveWeightedEV":m["populationWeightedMeanNetReturn"]>0,
            "precisionAtLeast40pct":m["precision"]>=0.40,
            "recallAtLeast10pct":m["recall"]>=0.10,
            "selectedShareAtMost20pct":m["populationSelectedShare"]<=0.20,
        }
    result["promotionPass"]=all(
        all(v.values()) for v in result["promotionDiagnostic"].values()
    )

    pd.DataFrame(selection["grid"]).to_csv(out/"threshold-grid.csv",index=False)
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
