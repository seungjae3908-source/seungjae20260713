#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT=Path(__file__).resolve().parents[2]
BASE_SCRIPT=ROOT/"market-prediction-lab"/"scripts"/"run-crypto-futures-dynamic-exit-v1.py"
SPEC=importlib.util.spec_from_file_location("dynamic_exit_v1",BASE_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("BASE_IMPORT_FAILED")
base=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(base)

GATE_FIT_END=pd.Timestamp("2024-01-01").date()
GATE_CAL_END=pd.Timestamp("2024-07-01").date()
EXIT_CAL_END=base.CAL_END
VALID_END=base.VALID_END
BENCH_END=base.BENCH_END

THRESHOLDS=(0.35,0.40,0.45,0.50,0.55,0.60,0.65)
FEATURES=[
    "fundingPrev","fundingMean3",
    "oi15","oi60",
    "topPosRatio","allAccountRatio",
    "flow4","rvol","ret4","takerRatio",
]


def find_summary(root:Path, contract:str):
    for p in root.glob("**/summary.json"):
        try:
            x=json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if x.get("contract")==contract:
            return x,p
    raise RuntimeError(f"SUMMARY_NOT_FOUND:{contract}")


def find_ledger(root:Path, name="winner-ledger.csv"):
    files=list(root.glob(f"**/{name}"))
    if not files:
        raise RuntimeError(f"LEDGER_NOT_FOUND:{name}")
    return files[0]


def load_inputs(source_root:Path, exit_root:Path):
    source_summary,_=find_summary(source_root,"full-universe-3pct-hunter-futures-funding-v32")
    exit_summary,_=find_summary(exit_root,"crypto-futures-dynamic-exit-v12")
    if exit_summary.get("winner")!="STAGED_A3.5_T0.55_G0.8":
        raise RuntimeError(f"UNEXPECTED_EXIT_WINNER:{exit_summary.get('winner')}")

    s=pd.read_csv(find_ledger(source_root))
    e=pd.read_csv(find_ledger(exit_root))

    for df in (s,e):
        df["timestamp"]=pd.to_datetime(df["timestamp"],utc=True,errors="coerce")
        df["symbol"]=df["symbol"].astype(str)
    s=s.dropna(subset=["timestamp","symbol"]).copy()
    e=e.dropna(subset=["timestamp","symbol","netReturn"]).copy()
    s=s.drop_duplicates(["timestamp","symbol"],keep="first")
    e=e.drop_duplicates(["timestamp","symbol"],keep="first")

    missing=[c for c in FEATURES if c not in s.columns]
    if missing:
        raise RuntimeError(f"SOURCE_FEATURES_MISSING:{missing}")

    cols=["timestamp","symbol"]+FEATURES
    x=e.merge(s[cols],on=["timestamp","symbol"],how="inner",validate="one_to_one")
    if len(x)<int(len(e)*0.98):
        raise RuntimeError(f"JOIN_COVERAGE_LOW:{len(x)}/{len(e)}")

    x["date"]=pd.to_datetime(x["date"],errors="coerce").dt.date
    x=x.dropna(subset=["date","netReturn"]).copy()
    for c in FEATURES:
        x[c]=pd.to_numeric(x[c],errors="coerce")

    x["absFlow4"]=x["flow4"].abs()
    x["absOi15"]=x["oi15"].abs()
    x["crowdGap"]=x["allAccountRatio"]-x["topPosRatio"]
    x["flowRvol"]=x["absFlow4"]*x["rvol"]
    x["fundingBp"]=x["fundingPrev"]*10000.0
    feats=FEATURES+["absFlow4","absOi15","crowdGap","flowRvol","fundingBp"]
    return source_summary,exit_summary,x,feats


def fit_model(df,feats):
    train=df[df["date"]<GATE_FIT_END].copy()
    y=(pd.to_numeric(train["netReturn"],errors="coerce")>0).astype(int).to_numpy()
    if len(train)<80 or len(np.unique(y))<2:
        raise RuntimeError(f"GATE_TRAIN_INSUFFICIENT:{len(train)}:{len(np.unique(y))}")
    model=Pipeline([
        ("imputer",SimpleImputer(strategy="median")),
        ("scaler",StandardScaler()),
        ("model",LogisticRegression(C=0.7,class_weight="balanced",max_iter=1500,random_state=17)),
    ])
    model.fit(train[feats].to_numpy(float),y)
    return model,train,y


def period_metrics(df,start,end):
    d=df[(df["date"]>=pd.Timestamp(start).date())&(df["date"]<pd.Timestamp(end).date())].copy()
    return base.calc_metrics(d,start,end),d


def gate(m,min_trades):
    return base.gate(m,min_trades)


def rank_key(m,name,retention):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("profitFactor") or 0),
        float(m.get("totalReturn") or 0),
        -float(m.get("mdd") or 1),
        retention,
        name,
    )


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--source-root",required=True)
    ap.add_argument("--exit-root",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()

    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    source_summary,exit_summary,df,feats=load_inputs(Path(args.source_root),Path(args.exit_root))
    model,train,y=fit_model(df,feats)
    df["gateProb"]=model.predict_proba(df[feats].to_numpy(float))[:,1]

    periods={
        "gateFit":("2023-05-01",str(GATE_FIT_END)),
        "gateCalibration":(str(GATE_FIT_END),str(GATE_CAL_END)),
        "exitPolicyCalibration":(str(GATE_CAL_END),str(EXIT_CAL_END)),
        "validation":(str(EXIT_CAL_END),str(VALID_END)),
        "postHocBenchmark":(str(VALID_END),str(BENCH_END)),
    }

    baseline={}
    for name,(a,b) in periods.items():
        m,d=period_metrics(df,a,b)
        baseline[name]={"metrics":m,"trades":len(d)}

    reports={}
    grid=[]
    cal_total=baseline["gateCalibration"]["trades"]
    for t in THRESHOLDS:
        gated=df[df["gateProb"]>=t].copy()
        item={}
        for name,(a,b) in periods.items():
            m,d=period_metrics(gated,a,b)
            item[name]={"metrics":m,"trades":len(d)}
        cal_m=item["gateCalibration"]["metrics"]
        cal_n=item["gateCalibration"]["trades"]
        retention=(cal_n/cal_total) if cal_total else 0.0
        gcal=gate(cal_m,20)
        # Require enough breadth; no tiny-sample winner.
        eligible=gcal["pass"] and retention>=0.20
        item["threshold"]=t
        item["gateCalibrationGate"]=gcal
        item["gateCalibrationRetention"]=retention
        item["eligible"]=eligible
        reports[f"GATE_T{t:.2f}"]=item
        grid.append({
            "policy":f"GATE_T{t:.2f}",
            "threshold":t,
            "eligible":eligible,
            "gateCalRetention":retention,
            "gateCalReturn":cal_m.get("totalReturn"),
            "gateCalPF":cal_m.get("profitFactor"),
            "gateCalMDD":cal_m.get("mdd"),
            "gateCalPosMonthRate":cal_m.get("positiveMonthRate"),
            "gateCalTrades":cal_m.get("tradeCount"),
            "exitCalReturn":item["exitPolicyCalibration"]["metrics"].get("totalReturn"),
            "exitCalPF":item["exitPolicyCalibration"]["metrics"].get("profitFactor"),
            "validationReturn":item["validation"]["metrics"].get("totalReturn"),
            "validationPF":item["validation"]["metrics"].get("profitFactor"),
            "validationMDD":item["validation"]["metrics"].get("mdd"),
            "validationPosMonthRate":item["validation"]["metrics"].get("positiveMonthRate"),
            "validationTrades":item["validation"]["metrics"].get("tradeCount"),
            "benchmarkReturn":item["postHocBenchmark"]["metrics"].get("totalReturn"),
            "benchmarkPF":item["postHocBenchmark"]["metrics"].get("profitFactor"),
            "benchmarkMDD":item["postHocBenchmark"]["metrics"].get("mdd"),
            "benchmarkPosMonthRate":item["postHocBenchmark"]["metrics"].get("positiveMonthRate"),
            "benchmarkTrades":item["postHocBenchmark"]["metrics"].get("tradeCount"),
        })

    eligible=[n for n,d in reports.items() if d["eligible"]]
    winner=sorted(
        eligible,
        key=lambda n:rank_key(
            reports[n]["gateCalibration"]["metrics"],
            n,
            reports[n]["gateCalibrationRetention"],
        ),
        reverse=True,
    )[0] if eligible else None

    lr=model.named_steps["model"]
    coef=[
        {"feature":f,"coefficient":float(c)}
        for f,c in sorted(zip(feats,lr.coef_[0]),key=lambda z:abs(z[1]),reverse=True)
    ]

    pd.DataFrame(grid).to_csv(out/"gate-grid.csv",index=False)
    summary={
        "schemaVersion":1,
        "contract":"crypto-futures-regime-gate-v13",
        "sourceWinner":source_summary.get("winner"),
        "exitWinner":exit_summary.get("winner"),
        "joinedTrades":int(len(df)),
        "gateFitTrades":int(len(train)),
        "gateFitPositiveRate":float(y.mean()),
        "features":feats,
        "candidateThresholds":len(THRESHOLDS),
        "winner":winner,
        "baseline":baseline,
        "modelTopCoefficients":coef[:12],
        "truthBoundary":{
            "gateUsesOnlyPreEntrySignalCloseFeatures":True,
            "oiAvailabilityShiftAfter2026_06_25InheritedFromSource":True,
            "fundingUsesLastKnownRateAtOrBeforeSignalCloseInheritedFromSource":True,
            "dynamicExitPolicyFrozenFromV12":True,
            "gateModelFitOnlyBefore2024_01_01":True,
            "gateThresholdSelectedOnlyOn2024_01_to_2024_06":True,
            "exitPolicyWasSelectedOn2024_07_to_2025_03":True,
            "validationNotUsedForGateThresholdSelection":True,
            "entryStrategyWasPreviouslySelectedUsing2025_04_to_2026_03Validation":True,
            "combinedSystemValidationFullyIndependent":False,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    if winner:
        w=reports[winner]
        summary["winnerResults"]=w
        threshold=w["threshold"]
        df[df["gateProb"]>=threshold].to_csv(out/"winner-ledger.csv",index=False)

    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
