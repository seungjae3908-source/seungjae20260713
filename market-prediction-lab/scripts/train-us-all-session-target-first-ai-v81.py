#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

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

v8=load(
    "target_first_v8",
    "market-prediction-lab/scripts/train-us-all-session-target-first-ai-v8.py",
)

CALIBRATION_RECALL_BUFFER=0.12

def robust_threshold_grid(cal:pd.DataFrame,score:np.ndarray)->dict:
    qs=np.unique(np.concatenate([
        np.linspace(0.50,0.90,17),
        np.linspace(0.91,0.99,17),
        np.array([0.9925,0.995,0.9975,0.999]),
    ]))
    thresholds=np.unique(np.quantile(score,qs))
    rows=[v8.metrics(cal,score,float(t)) for t in thresholds]
    eligible=[
        r for r in rows
        if r["sampleSelected"]>=100
        and r["populationWeightedMeanNetReturn"]>0
        and r["populationWeightedProfitFactor"]>1
        and r["populationWeightedPrecision"]>=0.35
        and r["recall"]>=CALIBRATION_RECALL_BUFFER
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
        mode="ROBUST_ECONOMIC_GATE"
    else:
        candidates=[
            r for r in rows
            if r["sampleSelected"]>=100
            and r["recall"]>=CALIBRATION_RECALL_BUFFER
        ] or [r for r in rows if r["sampleSelected"]>=100] or rows
        winner=max(
            candidates,
            key=lambda r:(
                r["populationWeightedMeanNetReturn"],
                r["populationWeightedProfitFactor"],
                r["recall"],
            ),
        )
        mode="ROBUST_BEST_EV_DIAGNOSTIC"
    return {
        "selectionMode":mode,
        "calibrationRecallBuffer":CALIBRATION_RECALL_BUFFER,
        "winner":winner,
        "grid":rows,
    }

def holdout_gate(m:dict)->dict:
    checks={
        "minimumSelectedRows":m["sampleSelected"]>=200,
        "positiveWeightedEV":m["populationWeightedMeanNetReturn"]>0,
        "profitFactorAbove1":m["populationWeightedProfitFactor"]>1,
        "precisionAtLeast35pct":m["populationWeightedPrecision"]>=0.35,
        "recallAtLeast10pct":m["recall"]>=0.10,
        "selectedShareAtMost15pct":m["populationWeightedSelectedShare"]<=0.15,
    }
    return {"pass":all(checks.values()),"checks":checks}

def prepare(data:pd.DataFrame)->pd.DataFrame:
    x=data.copy()
    for c in v8.FEATURES:
        x[c]=pd.to_numeric(x[c],errors="coerce")
    x=x.replace([np.inf,-np.inf],np.nan)
    return x.dropna(
        subset=v8.FEATURES+[
            "labelMfe3","labelTargetFirst3","exactNetReturn"
        ]
    ).copy()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--diagnostic",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    data=prepare(pd.read_parquet(args.events))
    diagnostic=prepare(pd.read_parquet(args.diagnostic))
    train=data[data["period"]=="train"].copy()
    cal=data[data["period"]=="calibration"].copy()
    old_val=data[data["period"]=="validation"].copy()
    old_fresh=data[data["period"]=="fresh_oos"].copy()
    if min(len(train),len(cal),len(old_val),len(old_fresh),len(diagnostic))==0:
        raise RuntimeError(
            "V81_EMPTY_SPLIT:"
            +":".join(str(x) for x in [
                len(train),len(cal),len(old_val),len(old_fresh),len(diagnostic)
            ])
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
    model.fit(v8.clean_x(train),y,sample_weight=v8.sampling_weight(train))

    cal_score=model.predict_proba(v8.clean_x(cal))[:,1]
    selection=robust_threshold_grid(cal,cal_score)
    threshold=float(selection["winner"]["threshold"])

    old_val_m=v8.metrics(
        old_val,model.predict_proba(v8.clean_x(old_val))[:,1],threshold
    )
    old_fresh_m=v8.metrics(
        old_fresh,model.predict_proba(v8.clean_x(old_fresh))[:,1],threshold
    )
    diagnostic_score=model.predict_proba(v8.clean_x(diagnostic))[:,1]
    holdout=v8.metrics(diagnostic,diagnostic_score,threshold)
    gate=holdout_gate(holdout)

    result={
        "schemaVersion":1,
        "contract":"us-all-session-target-first-ai-v81",
        "features":v8.FEATURES,
        "calibrationRecallBuffer":CALIBRATION_RECALL_BUFFER,
        "periodRows":{
            "train":int(len(train)),
            "calibration":int(len(cal)),
            "exposedValidationDiagnostic":int(len(old_val)),
            "exposedFreshDiagnostic":int(len(old_fresh)),
            "newHoldout2026_03":int(len(diagnostic)),
        },
        "calibrationSelection":selection,
        "exposedValidationDiagnostic":old_val_m,
        "exposedFreshDiagnostic":old_fresh_m,
        "newHoldout2026_03":holdout,
        "newHoldoutGate":gate,
        "promotionPass":bool(gate["pass"]),
        "featureImportance":sorted(
            [
                {"feature":f,"importance":float(v)}
                for f,v in zip(v8.FEATURES,model.feature_importances_)
            ],
            key=lambda z:z["importance"],reverse=True,
        ),
        "truthBoundary":{
            "modelFitUsesOriginalTrainOnly":True,
            "thresholdUsesOriginalCalibrationOnly":True,
            "calibrationRecallBufferPrecommittedAt12pct":True,
            "oldValidationAndFreshWereAlreadyExposedAndAreDiagnosticOnly":True,
            "new2026MarchHoldoutExcludedFromFitAndThresholdSelection":True,
            "labelIsExactTargetBeforeStop":True,
            "sameMinuteTargetStopUsesStopFirst":True,
            "clockFeaturesExcluded":True,
            "entrySlippageAndRoundTripCostIncludedInEconomicOutcome":True,
            "oneMonthHoldoutCannotProveLongRunProfitability":True,
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
