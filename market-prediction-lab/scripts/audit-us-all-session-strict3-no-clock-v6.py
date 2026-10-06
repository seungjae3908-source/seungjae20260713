#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[2]
TRAINER_PATH=ROOT/"market-prediction-lab/scripts/train-us-all-session-opportunity-ai-v4.py"
SPEC=importlib.util.spec_from_file_location("trainer",TRAINER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("TRAINER_IMPORT_FAILED")
trainer=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trainer)

NO_CLOCK_FEATURES=[
    f for f in trainer.FEATURES
    if f not in {"minuteOfSession","sessionCode"}
]

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    data=pd.read_parquet(args.events)
    trainer.FEATURES=list(NO_CLOCK_FEATURES)
    for c in trainer.FEATURES:
        data[c]=pd.to_numeric(data[c],errors="coerce")
    data=data.replace([np.inf,-np.inf],np.nan)

    train=data[data["period"]=="train"].copy()
    cal=data[data["period"]=="calibration"].copy()
    val=data[data["period"]=="validation"].copy()
    fresh=data[data["period"]=="fresh_oos"].copy()
    if min(len(train),len(cal),len(val),len(fresh))==0:
        raise RuntimeError("STRICT3_NO_CLOCK_EMPTY_PERIOD")

    result_model=trainer.fit_one(
        train,cal,val,fresh,
        "STRICT3_NO_CLOCK",
        trainer.TARGETS["STRICT3"],
    )
    calw=result_model["calibrationSelection"]["winner"]
    result={
        "schemaVersion":1,
        "contract":"us-all-session-strict3-no-clock-v6",
        "removedFeatures":["minuteOfSession","sessionCode"],
        "featureColumns":trainer.FEATURES,
        "calibration":calw,
        "validation":result_model["validation"],
        "freshOos":result_model["freshOos"],
        "featureImportance":result_model["featureImportance"],
        "promotionDiagnostic":{
            "calibrationPrecisionAtLeast40pct":float(calw["populationWeightedPrecision"])>=0.40,
            "validationPrecisionAtLeast35pct":float(result_model["validation"]["populationWeightedPrecision"])>=0.35,
            "freshPrecisionAtLeast35pct":float(result_model["freshOos"]["populationWeightedPrecision"])>=0.35,
            "validationRecallAtLeast40pct":float(result_model["validation"]["recall"])>=0.40,
            "freshRecallAtLeast40pct":float(result_model["freshOos"]["recall"])>=0.40,
        },
        "truthBoundary":{
            "sameFrozenEventDatasetAsUSV4":True,
            "timeOfDayFeaturesRemoved":True,
            "targetIsStrict3NoStopAnywhereWithin60m":True,
            "strict3IsMoreConservativeThanExactTargetBeforeStop":True,
            "modelFitUsesTrainOnly":True,
            "thresholdUsesCalibrationOnly":True,
            "validationAndFreshOosUntouched":True,
            "thisStageMeasuresPathAwareDetectionNotTradingPnl":True,
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
