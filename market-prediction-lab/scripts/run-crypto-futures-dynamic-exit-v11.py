#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[2]
BASE_PATH = ROOT / "market-prediction-lab" / "scripts" / "run-crypto-futures-dynamic-exit-v1.py"
SPEC = importlib.util.spec_from_file_location("dynamic_exit_v1", BASE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("DYNAMIC_EXIT_V1_IMPORT_FAILED")
base = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(base)

EARLY_FEATURES = base.FEATURES + [
    "adverseFromEntry",
    "distanceToArm",
    "profitSlope5",
]
EARLY_THRESHOLDS = (0.20, 0.30, 0.40, 0.50)
EARLY_MIN_HOLDS = (5, 10, 15)
EARLY_CONFIRM_BARS = (2, 3)
EARLY_HORIZON = 60

POST_AI_THRESHOLD = 0.55
POST_TRAIL_GAP = 0.008


def enrich_early_features(g: pd.DataFrame):
    x = g.copy()
    entry = float(x["open"].iloc[0])
    x["adverseFromEntry"] = np.maximum.accumulate(x["high"].astype(float) / entry - 1.0)
    x["distanceToArm"] = np.maximum(0.0, base.ARM_PROFIT - x["peakProfit"].astype(float))
    x["profitSlope5"] = x["profitClose"].astype(float) - x["profitClose"].astype(float).shift(5)
    for c in EARLY_FEATURES:
        x[c] = pd.to_numeric(x[c], errors="coerce")
    return x


def early_label(g: pd.DataFrame, i: int):
    entry = float(g["open"].iloc[0])
    stop = entry * (1.0 + base.HARD_STOP)
    arm = entry * (1.0 - base.ARM_PROFIT)
    end = min(len(g) - 1, i + EARLY_HORIZON)
    for j in range(i + 1, end + 1):
        # Conservative minute ordering.
        if float(g["high"].iloc[j]) >= stop:
            return 0
        if float(g["low"].iloc[j]) <= arm:
            return 1
    return 0


def early_model_rows(signals: pd.DataFrame, paths: dict):
    rows, labels = [], []
    for r in signals.itertuples(index=False):
        key = (str(r.symbol), pd.Timestamp(r.timestamp))
        g = paths.get(key)
        if g is None:
            continue
        entry = float(g["open"].iloc[0])
        stop = entry * (1.0 + base.HARD_STOP)
        arm = entry * (1.0 - base.ARM_PROFIT)
        for i in range(len(g) - 1):
            if float(g["high"].iloc[i]) >= stop:
                break
            if float(g["low"].iloc[i]) <= arm:
                break
            if i < min(EARLY_MIN_HOLDS):
                continue
            rows.append([
                float(g[c].iloc[i]) if pd.notna(g[c].iloc[i]) else np.nan
                for c in EARLY_FEATURES
            ])
            labels.append(early_label(g, i))
    if not rows:
        raise RuntimeError("NO_EARLY_MODEL_STATES")
    return np.asarray(rows, dtype=float), np.asarray(labels, dtype=int)


def fit_early_model(x: np.ndarray, y: np.ndarray):
    if len(x) < 200:
        raise RuntimeError(f"TOO_FEW_EARLY_STATES:{len(x)}")
    if len(np.unique(y)) < 2:
        raise RuntimeError("EARLY_LABEL_SINGLE_CLASS")
    model = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
        ("model", LogisticRegression(
            C=0.7,
            class_weight="balanced",
            max_iter=1200,
            random_state=11,
        )),
    ])
    model.fit(x, y)
    return model


def predict_early(model, g: pd.DataFrame):
    return model.predict_proba(g[EARLY_FEATURES].astype(float).to_numpy())[:,1]


def policy_defs():
    out = [
        {"name":"BASE_FIXED_TP3","early":False,"post":"fixed3"},
        {"name":"BASE_AI_TRAIL","early":False,"post":"ai_trail"},
    ]
    for t in EARLY_THRESHOLDS:
        for min_hold in EARLY_MIN_HOLDS:
            for confirm in EARLY_CONFIRM_BARS:
                out.append({
                    "name":f"EARLY_T{t:.2f}_H{min_hold}_C{confirm}_TP3",
                    "early":True,
                    "threshold":t,
                    "minHold":min_hold,
                    "confirm":confirm,
                    "post":"fixed3",
                })
                out.append({
                    "name":f"EARLY_T{t:.2f}_H{min_hold}_C{confirm}_AI_TRAIL",
                    "early":True,
                    "threshold":t,
                    "minHold":min_hold,
                    "confirm":confirm,
                    "post":"ai_trail",
                })
    return out


def simulate(g: pd.DataFrame, continuation_proba: np.ndarray, early_proba: np.ndarray, policy: dict):
    entry = float(g["open"].iloc[0])
    hard_stop = entry * (1.0 + base.HARD_STOP)
    arm_price = entry * (1.0 - base.ARM_PROFIT)

    armed = False
    peak_profit = 0.0
    low_prob_streak = 0
    pending_early_exit = False
    pending_post_ai_exit = False

    exit_i = len(g)-1
    exit_price = float(g["close"].iloc[-1])
    reason = "MAX_HOLD"

    for i in range(len(g)):
        op = float(g["open"].iloc[i])
        hi = float(g["high"].iloc[i])
        lo = float(g["low"].iloc[i])

        if pending_early_exit:
            exit_i=i; exit_price=op; reason="AI_ENTRY_INVALIDATED"; break
        if pending_post_ai_exit:
            exit_i=i; exit_price=op; reason="AI_TREND_DIED"; break

        if not armed and hi >= hard_stop:
            exit_i=i; exit_price=hard_stop; reason="HARD_STOP"; break

        if armed:
            lock = max(base.LOCK_PROFIT, peak_profit - POST_TRAIL_GAP)
            floor_price = entry * (1.0 - lock)
            if hi >= floor_price:
                exit_i=i; exit_price=floor_price; reason="TRAIL_PROTECT"; break

        minute_peak = 1.0 - lo / entry
        peak_profit = max(peak_profit, minute_peak)

        if not armed and lo <= arm_price:
            if policy["post"] == "fixed3":
                exit_i=i; exit_price=arm_price; reason="TP3"; break
            armed=True
            low_prob_streak=0

        if not armed and policy.get("early") and i >= int(policy["minHold"]):
            if float(early_proba[i]) < float(policy["threshold"]):
                low_prob_streak += 1
            else:
                low_prob_streak = 0
            if low_prob_streak >= int(policy["confirm"]):
                pending_early_exit=True

        if armed and policy["post"] == "ai_trail":
            if float(continuation_proba[i]) < POST_AI_THRESHOLD:
                pending_post_ai_exit=True

    used=g.iloc[:exit_i+1]
    gross=1.0-exit_price/entry
    net=gross-base.ROUND_TRIP_COST
    mfe=1.0-float(used["low"].min())/entry
    mae=float(used["high"].max())/entry-1.0
    return {
        "entryPrice":entry,
        "exitPrice":exit_price,
        "grossReturn":gross,
        "roundTripCost":base.ROUND_TRIP_COST,
        "netReturn":net,
        "MFE":mfe,
        "MAE":mae,
        "exitReason":reason,
        "exitTime":str(g["timestamp"].iloc[exit_i]),
        "holdMinutes":int(exit_i+1),
        "armed3pct":bool(armed or reason=="TP3"),
        "peakProfit":peak_profit,
    }


def replay(signals, paths, cont_probs, early_probs, policy):
    rows=[]
    for r in signals.itertuples(index=False):
        key=(str(r.symbol),pd.Timestamp(r.timestamp))
        g=paths.get(key)
        if g is None:
            continue
        res=simulate(g,cont_probs[key],early_probs[key],policy)
        rows.append({
            "market":"CRYPTO_FUTURES",
            "direction":"SHORT",
            "candidate":policy["name"],
            "date":pd.Timestamp(r.timestamp).date(),
            "timestamp":pd.Timestamp(r.timestamp),
            "symbol":str(r.symbol),
            **res,
        })
    return pd.DataFrame(rows)


def to_pl(pdf):
    if pdf.empty:
        return pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    return pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))


def metrics(pdf,start,end):
    dates=[d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]
    return base.v1.metrics(to_pl(pdf),"CRYPTO_FUTURES",dates)


def gate(m,min_trades):
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def rank_key(m,name):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 0),
        name,
    )


def split(pdf,start,end):
    d=pd.to_datetime(pdf["date"]).dt.date
    return pdf[(d>=pd.Timestamp(start).date())&(d<pd.Timestamp(end).date())].copy()


def exit_reason_counts(pdf):
    return {str(k):int(v) for k,v in pdf["exitReason"].value_counts().to_dict().items()} if len(pdf) else {}


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input-root",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()

    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    (out/"run-started.json").write_text(json.dumps({
        "contract":"crypto-futures-dynamic-exit-v11",
        "status":"STARTED",
        "executionAuthority":"NONE",
    },indent=2)+"\n",encoding="utf-8")

    source_summary,signals,ledger_path=base.load_source(Path(args.input_root))
    cache,file_audit=base.download_paths(signals)

    paths={}
    failures=[]
    for r in signals.itertuples(index=False):
        key=(str(r.symbol),pd.Timestamp(r.timestamp))
        g,err=base.build_path(cache,str(r.symbol),pd.Timestamp(r.timestamp),float(r.entryPrice))
        if g is None:
            failures.append({"symbol":str(r.symbol),"timestamp":str(r.timestamp),"error":err})
            continue
        paths[key]=enrich_early_features(g)

    coverage=len(paths)/max(len(signals),1)
    if coverage<0.95:
        raise RuntimeError(f"V11_PATH_COVERAGE_LOW:{len(paths)}/{len(signals)}")

    fit_signals=signals[signals["date"]<base.FIT_END].copy()

    cont_x,cont_y,_=base.make_model_rows(fit_signals,paths)
    cont_model=base.fit_model(cont_x,cont_y)
    early_x,early_y=early_model_rows(fit_signals,paths)
    early_model=fit_early_model(early_x,early_y)

    cont_probs={k:base.predict_proba(cont_model,g) for k,g in paths.items()}
    early_probs={k:predict_early(early_model,g) for k,g in paths.items()}

    reports={}; grid=[]
    for policy in policy_defs():
        trades=replay(signals,paths,cont_probs,early_probs,policy)
        fit=split(trades,"2023-05-01",str(base.FIT_END))
        cal=split(trades,str(base.FIT_END),str(base.CAL_END))
        val=split(trades,str(base.CAL_END),str(base.VALID_END))
        bench=split(trades,str(base.VALID_END),str(base.BENCH_END))

        mf=metrics(fit,"2023-05-01",str(base.FIT_END))
        mc=metrics(cal,str(base.FIT_END),str(base.CAL_END))
        mv=metrics(val,str(base.CAL_END),str(base.VALID_END))
        mb=metrics(bench,str(base.VALID_END),str(base.BENCH_END))
        gc,gv,gb=gate(mc,30),gate(mv,30),gate(mb,15)

        reports[policy["name"]]={
            "policy":policy,"trades":trades,
            "fit":mf,"calibration":mc,"validation":mv,"postHocBenchmark":mb,
            "calibrationGate":gc,"validationGate":gv,"postHocBenchmarkGate":gb,
            "exitReasons":{
                "fit":exit_reason_counts(fit),
                "calibration":exit_reason_counts(cal),
                "validation":exit_reason_counts(val),
                "postHocBenchmark":exit_reason_counts(bench),
            },
        }
        grid.append({
            "policy":policy["name"],
            "early":policy.get("early",False),
            "post":policy["post"],
            "threshold":policy.get("threshold"),
            "minHold":policy.get("minHold"),
            "confirm":policy.get("confirm"),
            "calibrationPass":gc["pass"],
            "calibrationReturn":mc.get("totalReturn"),
            "calibrationPF":mc.get("profitFactor"),
            "calibrationMDD":mc.get("mdd"),
            "calibrationPosMonthRate":mc.get("positiveMonthRate"),
            "validationPass":gv["pass"],
            "validationReturn":mv.get("totalReturn"),
            "validationPF":mv.get("profitFactor"),
            "validationMDD":mv.get("mdd"),
            "validationPosMonthRate":mv.get("positiveMonthRate"),
            "benchmarkReturn":mb.get("totalReturn"),
            "benchmarkPF":mb.get("profitFactor"),
            "benchmarkMDD":mb.get("mdd"),
            "benchmarkPosMonthRate":mb.get("positiveMonthRate"),
        })

    selectable=[
        n for n,d in reports.items()
        if d["policy"].get("early") and d["calibrationGate"]["pass"]
    ]
    winner=sorted(selectable,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if selectable else None

    pd.DataFrame(grid).to_csv(out/"policy-grid.csv",index=False)

    lr=early_model.named_steps["model"]
    early_coef=[
        {"feature":f,"coefficient":float(c)}
        for f,c in sorted(zip(EARLY_FEATURES,lr.coef_[0]),key=lambda z:abs(z[1]),reverse=True)
    ]

    summary={
        "schemaVersion":1,
        "contract":"crypto-futures-dynamic-exit-v11",
        "sourceContract":source_summary.get("contract"),
        "sourceWinner":source_summary.get("winner"),
        "sourceLedger":ledger_path,
        "signalCount":int(len(signals)),
        "replayedSignals":int(len(paths)),
        "replayCoverage":coverage,
        "continuationFitStates":int(len(cont_x)),
        "continuationPositiveRate":float(cont_y.mean()),
        "earlyFitStates":int(len(early_x)),
        "earlyPositiveRate":float(early_y.mean()),
        "candidatePolicies":len(grid),
        "selectableCalibrationPassCount":len(selectable),
        "winner":winner,
        "fileAudit":file_audit,
        "pathFailures":failures[:40],
        "earlyModelTopCoefficients":early_coef[:12],
        "truthBoundary":{
            "entrySignalUnchangedFromFundingV32Winner":True,
            "oneMinuteReplay":True,
            "hardStopRemainsEmergencyBackstop":True,
            "earlyInvalidationDecisionUsesOnlyCompleted1mBars":True,
            "earlyInvalidationExecutesNextMinuteOpen":True,
            "profitArmAt3pct":True,
            "postProfitAiTrailUsesV1FrozenRule":True,
            "modelsFitOnlyBefore2024_07_01":True,
            "policySelectedOnlyOn2024_07_to_2025_03Calibration":True,
            "validationNotUsedForSelection":True,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }

    baseline_names=["BASE_FIXED_TP3","BASE_AI_TRAIL"]
    summary["baselineResults"]={
        n:{
            "fit":reports[n]["fit"],"calibration":reports[n]["calibration"],
            "validation":reports[n]["validation"],"postHocBenchmark":reports[n]["postHocBenchmark"],
            "exitReasons":reports[n]["exitReasons"],
        } for n in baseline_names
    }
    if winner:
        d=reports[winner]
        summary["winnerResults"]={
            "policy":d["policy"],
            "fit":d["fit"],
            "calibration":d["calibration"],
            "calibrationGate":d["calibrationGate"],
            "validation":d["validation"],
            "validationGate":d["validationGate"],
            "postHocBenchmark":d["postHocBenchmark"],
            "postHocBenchmarkGate":d["postHocBenchmarkGate"],
            "exitReasons":d["exitReasons"],
        }
        d["trades"].to_csv(out/"winner-ledger.csv",index=False)

    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
