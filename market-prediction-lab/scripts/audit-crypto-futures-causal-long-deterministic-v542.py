#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from huggingface_hub import HfApi, snapshot_download
from lightgbm import LGBMClassifier

import importlib.util

ROOT = Path(__file__).resolve().parents[2]

def load(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v54 = load(
    "futures_long_v54",
    "market-prediction-lab/scripts/run-crypto-futures-causal-long-opportunity-ranker-v54.py",
)

FORWARD_START = pd.Timestamp("2026-10-01T00:00:00Z")
EXTRA_STRESS = 0.0010

def build_model():
    return LGBMClassifier(
        objective="binary",
        n_estimators=500,
        learning_rate=0.03,
        num_leaves=31,
        max_depth=10,
        min_child_samples=150,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.75,
        reg_lambda=2.5,
        random_state=540,
        n_jobs=1,
        deterministic=True,
        force_col_wise=True,
        verbosity=-1,
    )

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    api=HfApi()
    info=api.dataset_info(v54.DATASET)
    dataset_sha=str(info.sha)
    folder=(
        Path(snapshot_download(
            repo_id=v54.DATASET,
            repo_type="dataset",
            revision=dataset_sha,
            allow_patterns=[f"{v54.SUB}/15m/*.parquet"],
        )) / v54.SUB / "15m"
    )
    files=sorted(folder.glob("*.parquet"))
    frames=[];audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs={pool.submit(v54.process_file,p):p for p in files}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            p=futs[fut]
            try:
                rows,audit=fut.result()
            except Exception as exc:
                rows=None;audit={"symbolFile":p.name,"error":repr(exc),"events":0}
            audits.append(audit)
            if rows is not None and len(rows):
                frames.append(pl.from_pandas(rows))
            if idx%100==0 or idx==len(futs):
                print(json.dumps({
                    "filesComplete":idx,"files":len(futs),"usableFrames":len(frames),
                    "eventRows":int(sum(f.height for f in frames)),
                    "datasetSha":dataset_sha,
                }),flush=True)
    if not frames:
        raise RuntimeError("V542_NO_EVENT_ROWS")

    events=v54.add_cross_section(pl.concat(frames,how="vertical_relaxed"))
    pdf=events.to_pandas()
    pdf["timestamp"]=pd.to_datetime(pdf["timestamp"],utc=True)
    pdf["entryTime"]=pd.to_datetime(pdf["entryTime"],utc=True)
    pdf["period"]=v54.period_for(pdf["timestamp"])
    pdf=pdf.replace([np.inf,-np.inf],np.nan).dropna(
        subset=v54.FEATURES+["netReturn","labelTargetFirst3"]
    )
    for f in v54.FEATURES:
        pdf[f]=pd.to_numeric(pdf[f],errors="coerce").astype("float32")

    train=pdf[pdf["period"].eq("train")].copy()
    cal=pdf[pdf["period"].eq("calibration")].copy()
    validation=pdf[pdf["period"].eq("validation")].copy()
    fresh=pdf[pdf["period"].eq("fresh_oos")].copy()
    forward=pdf[pdf["timestamp"]>=FORWARD_START].copy()

    if min(len(train),len(cal))<1000:
        raise RuntimeError(f"V542_BASE_TOO_SMALL:{len(train)}:{len(cal)}")
    if forward.empty:
        raise RuntimeError("V542_FORWARD_EMPTY")

    model1=build_model()
    model1.fit(train[v54.FEATURES],train["labelTargetFirst3"].astype(int))
    cal_score1=model1.predict_proba(cal[v54.FEATURES])[:,1]
    mode1,winner1,grid1=v54.select_threshold(cal,cal_score1)

    model2=build_model()
    model2.fit(train[v54.FEATURES],train["labelTargetFirst3"].astype(int))
    cal_score2=model2.predict_proba(cal[v54.FEATURES])[:,1]
    mode2,winner2,_=v54.select_threshold(cal,cal_score2)

    max_abs=float(np.max(np.abs(cal_score1-cal_score2)))
    threshold1=float(winner1["threshold"])
    threshold2=float(winner2["threshold"])
    reproducible=bool(
        mode1==mode2
        and threshold1==threshold2
        and max_abs==0.0
    )
    if not reproducible:
        raise RuntimeError(
            f"V542_DETERMINISM_FAILED:{mode1}:{mode2}:{threshold1}:{threshold2}:{max_abs}"
        )

    def eval_split(df):
        score=model1.predict_proba(df[v54.FEATURES])[:,1]
        return (
            v54.score_metrics(df,score,threshold1,0.0),
            v54.score_metrics(df,score,threshold1,EXTRA_STRESS),
        )

    val_base,val_stress=eval_split(validation)
    fresh_base,fresh_stress=eval_split(fresh)
    forward_base,forward_stress=eval_split(forward)

    fscore=model1.predict_proba(forward[v54.FEATURES])[:,1]
    selected=forward.loc[fscore>=threshold1].copy()
    selected["score"]=fscore[fscore>=threshold1]
    selected.to_parquet(out/"selected-forward-events.parquet",index=False)

    day_rows=[]
    if len(selected):
        for day,g in selected.groupby(selected["timestamp"].dt.strftime("%Y-%m-%d")):
            net=pd.to_numeric(g["netReturn"],errors="coerce").dropna()
            day_rows.append({
                "day":day,"selected":int(len(g)),
                "symbols":int(g["symbol"].astype(str).nunique()),
                "meanNet":float(net.mean()) if len(net) else None,
                "netSum":float(net.sum()) if len(net) else None,
                "targetFirstRate":float(pd.to_numeric(
                    g["labelTargetFirst3"],errors="coerce"
                ).fillna(0).mean()),
            })
    pd.DataFrame(day_rows).to_csv(out/"forward-by-day.csv",index=False)
    pd.DataFrame(audits).to_json(
        out/"source-audit.jsonl",orient="records",lines=True,force_ascii=False
    )

    result={
        "schemaVersion":1,
        "contract":"crypto-futures-causal-long-deterministic-v542",
        "dataset":v54.DATASET,
        "datasetRevision":dataset_sha,
        "sourceFiles":len(files),
        "eventRows":int(len(pdf)),
        "rowCounts":{
            "train":int(len(train)),"calibration":int(len(cal)),
            "validation":int(len(validation)),"freshOos":int(len(fresh)),
            "forward":int(len(forward)),
        },
        "reproducibility":{
            "pass":reproducible,
            "selectionMode1":mode1,"selectionMode2":mode2,
            "threshold1":threshold1,"threshold2":threshold2,
            "maxAbsCalibrationScoreDiff":max_abs,
            "nJobs":1,"deterministic":True,"forceColWise":True,
        },
        "calibrationSelection":{"mode":mode1,"winner":winner1,"grid":grid1},
        "diagnosticOnlyBecausePreviouslyExposed":{
            "validation":val_base,"validationPlus10bp":val_stress,
            "freshOos":fresh_base,"freshOosPlus10bp":fresh_stress,
        },
        "forwardStart":str(FORWARD_START),
        "forwardEnd":str(forward["timestamp"].max()),
        "forward":forward_base,
        "forwardPlus10bp":forward_stress,
        "selectedForwardRows":int(len(selected)),
        "selectedForwardSymbols":int(selected["symbol"].astype(str).nunique()) if len(selected) else 0,
        "byDay":day_rows,
        "truthBoundary":{
            "datasetRevisionPinned":True,
            "deterministicLightGbmRequired":True,
            "modelFitRepeatedTwiceAndMustMatchExactly":True,
            "trainOnlyFitsModel":True,
            "calibrationOnlySelectsThreshold":True,
            "validationAndFreshAreDiagnosticOnlyBecausePreviouslyExposed":True,
            "post2026Oct01ForwardNeverSelectsModelOrThreshold":True,
            "noForwardRetuning":True,
            "plus10bpForwardStressReported":True,
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
