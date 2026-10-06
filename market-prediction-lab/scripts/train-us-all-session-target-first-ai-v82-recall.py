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
v81=load(
    "target_first_v81",
    "market-prediction-lab/scripts/train-us-all-session-target-first-ai-v81.py",
)

# User objective: keep full-session scanning always on and avoid throwing away
# economically viable opportunities merely to maximize precision.
MAX_SELECTED_SHARE=0.15
MIN_CAL_POSITIVE_MONTH_RATE=0.50
MIN_HOLDOUT_RECALL=0.50
MIN_HOLDOUT_CLUSTER_RECALL=0.50
MIN_HOLDOUT_PRECISION=0.20

def recall_first_threshold_grid(cal:pd.DataFrame,score:np.ndarray)->dict:
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
        and r["populationWeightedSelectedShare"]<=MAX_SELECTED_SHARE
        and r["positiveActiveMonthRate"]>=MIN_CAL_POSITIVE_MONTH_RATE
    ]

    if eligible:
        winner=max(
            eligible,
            key=lambda r:(
                float(r.get("eventClusterRecall") or 0),
                r["recall"],
                r["populationWeightedMeanNetReturn"],
                r["populationWeightedProfitFactor"],
                r["populationWeightedPrecision"],
            ),
        )
        mode="RECALL_FIRST_POSITIVE_EV"
    else:
        candidates=[
            r for r in rows
            if r["sampleSelected"]>=100
            and r["populationWeightedSelectedShare"]<=MAX_SELECTED_SHARE
        ] or rows
        winner=max(
            candidates,
            key=lambda r:(
                float(r.get("eventClusterRecall") or 0),
                r["recall"],
                r["populationWeightedMeanNetReturn"],
            ),
        )
        mode="RECALL_FIRST_DIAGNOSTIC_ONLY"

    return {
        "selectionMode":mode,
        "objective":"MAX_EVENT_CLUSTER_RECALL_THEN_ROW_RECALL_SUBJECT_TO_POSITIVE_EV",
        "constraints":{
            "positiveWeightedMeanNetReturn":True,
            "profitFactorAbove1":True,
            "positiveActiveMonthRateAtLeast":MIN_CAL_POSITIVE_MONTH_RATE,
            "selectedShareAtMost":MAX_SELECTED_SHARE,
        },
        "winner":winner,
        "grid":rows,
    }

def holdout_gate(m:dict)->dict:
    cluster_recall=float(m.get("eventClusterRecall") or 0)
    checks={
        "minimumSelectedRows":int(m.get("sampleSelected") or 0)>=500,
        "positiveWeightedEV":float(m.get("populationWeightedMeanNetReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("populationWeightedProfitFactor") or 0)>1,
        "precisionAtLeast20pct":float(m.get("populationWeightedPrecision") or 0)>=MIN_HOLDOUT_PRECISION,
        "rowRecallAtLeast50pct":float(m.get("recall") or 0)>=MIN_HOLDOUT_RECALL,
        "eventClusterRecallAtLeast50pct":cluster_recall>=MIN_HOLDOUT_CLUSTER_RECALL,
        "selectedShareAtMost20pct":float(m.get("populationWeightedSelectedShare") or 1)<=0.20,
    }
    return {"pass":all(checks.values()),"checks":checks}

def prepare(data:pd.DataFrame)->pd.DataFrame:
    x=data.copy()
    for c in v8.FEATURES:
        x[c]=pd.to_numeric(x[c],errors="coerce")
    x=x.replace([np.inf,-np.inf],np.nan)
    return x.dropna(
        subset=["labelMfe3","labelTargetFirst3","exactNetReturn"]
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
            "V82_EMPTY_SPLIT:"
            +":".join(str(x) for x in [
                len(train),len(cal),len(old_val),len(old_fresh),len(diagnostic)
            ])
        )

    y=pd.to_numeric(
        train["labelTargetFirst3"],errors="coerce"
    ).fillna(0).astype(int)

    # Same frozen model specification as V8/V8.1. Only threshold selection
    # objective changes from EV/precision-first to opportunity-recall-first.
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
    selection=recall_first_threshold_grid(cal,cal_score)
    threshold=float(selection["winner"]["threshold"])

    old_val_m=v8.metrics(
        old_val,model.predict_proba(v8.clean_x(old_val))[:,1],threshold
    )
    old_fresh_m=v8.metrics(
        old_fresh,model.predict_proba(v8.clean_x(old_fresh))[:,1],threshold
    )
    holdout=v8.metrics(
        diagnostic,model.predict_proba(v8.clean_x(diagnostic))[:,1],threshold
    )
    gate=holdout_gate(holdout)

    result={
        "schemaVersion":1,
        "contract":"us-all-session-target-first-ai-v82-recall",
        "userObjective":"ALWAYS_ON_HIGH_OPPORTUNITY_RECALL_WITH_POSITIVE_NET_EXPECTANCY",
        "features":v8.FEATURES,
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
        "newHoldoutRecallGate":gate,
        "candidatePass":bool(gate["pass"]),
        "featureImportance":sorted(
            [
                {"feature":f,"importance":float(v)}
                for f,v in zip(v8.FEATURES,model.feature_importances_)
            ],
            key=lambda z:z["importance"],reverse=True,
        ),
        "truthBoundary":{
            "sameFrozenTrainAsV8AndV81":True,
            "sameModelHyperparametersAsV8AndV81":True,
            "thresholdUsesCalibrationOnly":True,
            "selectionObjectiveChangedAfterUserClarifiedRecallPriority":True,
            "marchHoldoutNotUsedForThresholdSelection":True,
            "oldValidationAndFreshAlreadyExposedDiagnosticOnly":True,
            "labelIsExactTargetBeforeStop":True,
            "clockFeaturesExcluded":True,
            "entrySlippageAndRoundTripCostIncluded":True,
            "openingTimeNotRequired":True,
            "preRegularPostAllEligible":True,
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
