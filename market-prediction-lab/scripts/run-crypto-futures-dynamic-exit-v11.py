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
BASE_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-crypto-futures-dynamic-exit-v1.py"
SPEC = importlib.util.spec_from_file_location("dynamic_exit_v1", BASE_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("DYNAMIC_EXIT_V1_IMPORT_FAILED")
base = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(base)

PREARM_MINUTE = 5
PREARM_HORIZON = 60
PREARM_THRESHOLDS = (0.15, 0.25, 0.35, 0.45, 0.55)
PREARM_CONSECUTIVE = 2
POSTARM_POLICY = {"name":"AI_TRAIL3_T0.55_G0.8","kind":"hybrid","threshold":0.55,"gap":0.008}

PREARM_FEATURES = base.FEATURES + [
    "adverseClose",
    "maeToNow",
    "distanceToArm",
]


def add_prearm_features(g: pd.DataFrame) -> pd.DataFrame:
    x = g.copy()
    entry = float(x["open"].iloc[0])
    close = x["close"].astype(float)
    high = x["high"].astype(float)
    x["adverseClose"] = close / entry - 1.0
    x["maeToNow"] = np.maximum.accumulate(high / entry - 1.0)
    x["distanceToArm"] = np.maximum(0.0, base.ARM_PROFIT - x["peakProfit"].astype(float))
    for c in PREARM_FEATURES:
        x[c] = pd.to_numeric(x[c], errors="coerce")
    return x


def prearm_label(g: pd.DataFrame, i: int):
    entry = float(g["open"].iloc[0])
    arm_px = entry * (1.0 - base.ARM_PROFIT)
    stop_px = entry * (1.0 + base.HARD_STOP)
    end = min(len(g) - 1, i + PREARM_HORIZON)
    for j in range(i + 1, end + 1):
        # Conservative intraminute ordering: adverse hard stop wins ties.
        if float(g["high"].iloc[j]) >= stop_px:
            return 0
        if float(g["low"].iloc[j]) <= arm_px:
            return 1
    return 0


def make_prearm_rows(signals: pd.DataFrame, paths: dict):
    rows, labels = [], []
    for r in signals.itertuples(index=False):
        key = (str(r.symbol), pd.Timestamp(r.timestamp))
        g0 = paths.get(key)
        if g0 is None:
            continue
        g = add_prearm_features(g0)
        entry = float(g["open"].iloc[0])
        stop_px = entry * (1.0 + base.HARD_STOP)
        arm_px = entry * (1.0 - base.ARM_PROFIT)
        for i in range(len(g)):
            if float(g["high"].iloc[i]) >= stop_px:
                break
            if float(g["low"].iloc[i]) <= arm_px:
                break
            if i + 1 < PREARM_MINUTE:
                continue
            y = prearm_label(g, i)
            rows.append([
                float(g[c].iloc[i]) if pd.notna(g[c].iloc[i]) else np.nan
                for c in PREARM_FEATURES
            ])
            labels.append(int(y))
    if not rows:
        raise RuntimeError("NO_PREARM_MODEL_STATES")
    return np.asarray(rows, dtype=float), np.asarray(labels, dtype=int)


def fit_prearm_model(x: np.ndarray, y: np.ndarray):
    if len(x) < 100:
        raise RuntimeError(f"TOO_FEW_PREARM_STATES:{len(x)}")
    if len(np.unique(y)) < 2:
        raise RuntimeError("PREARM_LABEL_SINGLE_CLASS")
    model = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
        ("model", LogisticRegression(
            C=1.0,
            class_weight="balanced",
            max_iter=1200,
            random_state=11,
        )),
    ])
    model.fit(x, y)
    return model


def predict_prearm(model, g: pd.DataFrame):
    x = add_prearm_features(g)
    return model.predict_proba(x[PREARM_FEATURES].astype(float).to_numpy())[:, 1]


def simulate_v11(
    g: pd.DataFrame,
    continuation_proba: np.ndarray,
    arm_proba: np.ndarray,
    prearm_threshold: float | None,
):
    entry = float(g["open"].iloc[0])
    hard_stop = entry * (1.0 + base.HARD_STOP)
    armed = False
    peak_profit = 0.0
    pending_exit_reason = None
    low_prob_streak = 0
    exit_i = len(g) - 1
    exit_price = float(g["close"].iloc[-1])
    reason = "MAX_HOLD"

    for i in range(len(g)):
        op = float(g["open"].iloc[i])
        hi = float(g["high"].iloc[i])
        lo = float(g["low"].iloc[i])

        if pending_exit_reason is not None:
            exit_i = i
            exit_price = op
            reason = pending_exit_reason
            break

        # Hard stop is always the maximum-loss backstop before +3% protection arms.
        if not armed and hi >= hard_stop:
            exit_i = i
            exit_price = hard_stop
            reason = "HARD_STOP"
            break

        if armed:
            lock = max(base.LOCK_PROFIT, peak_profit - float(POSTARM_POLICY["gap"]))
            floor_price = entry * (1.0 - max(0.0, lock))
            if hi >= floor_price:
                exit_i = i
                exit_price = floor_price
                reason = "TRAIL_PROTECT"
                break

        minute_peak = 1.0 - lo / entry
        peak_profit = max(peak_profit, minute_peak)

        if not armed and minute_peak >= base.ARM_PROFIT:
            armed = True
            low_prob_streak = 0

        if armed:
            if float(continuation_proba[i]) < float(POSTARM_POLICY["threshold"]):
                pending_exit_reason = "AI_TREND_DIED"
            continue

        if prearm_threshold is not None and i + 1 >= PREARM_MINUTE:
            if float(arm_proba[i]) < float(prearm_threshold):
                low_prob_streak += 1
            else:
                low_prob_streak = 0
            if low_prob_streak >= PREARM_CONSECUTIVE:
                pending_exit_reason = "AI_ENTRY_THESIS_FAILED"

    used = g.iloc[:exit_i+1]
    gross = 1.0 - exit_price / entry
    net = gross - base.ROUND_TRIP_COST
    mfe = 1.0 - float(used["low"].min()) / entry
    mae = float(used["high"].max()) / entry - 1.0
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
        "holdMinutes":int(exit_i + 1),
        "armed3pct":bool(armed),
        "peakProfit":peak_profit,
    }


def replay(
    signals: pd.DataFrame,
    paths: dict,
    continuation_probas: dict,
    arm_probas: dict,
    threshold: float | None,
    name: str,
):
    rows=[]
    for r in signals.itertuples(index=False):
        key=(str(r.symbol),pd.Timestamp(r.timestamp))
        g=paths.get(key)
        if g is None:
            continue
        res=simulate_v11(
            g,
            continuation_probas[key],
            arm_probas[key],
            threshold,
        )
        rows.append({
            "market":"CRYPTO_FUTURES",
            "direction":"SHORT",
            "candidate":name,
            "date":pd.Timestamp(r.timestamp).date(),
            "timestamp":pd.Timestamp(r.timestamp),
            "symbol":str(r.symbol),
            **res,
        })
    return pd.DataFrame(rows)


def slim_capture(pdf: pd.DataFrame):
    if pdf.empty:
        return {"trades":0}
    return {
        "trades":int(len(pdf)),
        "armed3pctTrades":int(pdf["armed3pct"].sum()),
        "medianHoldMinutes":float(pd.to_numeric(pdf["holdMinutes"],errors="coerce").median()),
        "exitReasons":{str(k):int(v) for k,v in pdf["exitReason"].value_counts().to_dict().items()},
        "meanNet":float(pd.to_numeric(pdf["netReturn"],errors="coerce").mean()),
    }


def period_split(trades: pd.DataFrame):
    d=pd.to_datetime(trades["date"]).dt.date
    return {
        "fit":trades[d < base.FIT_END].copy(),
        "calibration":trades[(d >= base.FIT_END)&(d < base.CAL_END)].copy(),
        "validation":trades[(d >= base.CAL_END)&(d < base.VALID_END)].copy(),
        "postHocBenchmark":trades[(d >= base.VALID_END)&(d < base.BENCH_END)].copy(),
    }


def metrics_for(parts: dict):
    return {
        "fit":base.calc_metrics(parts["fit"],"2023-05-01",str(base.FIT_END)),
        "calibration":base.calc_metrics(parts["calibration"],str(base.FIT_END),str(base.CAL_END)),
        "validation":base.calc_metrics(parts["validation"],str(base.CAL_END),str(base.VALID_END)),
        "postHocBenchmark":base.calc_metrics(parts["postHocBenchmark"],str(base.VALID_END),str(base.BENCH_END)),
    }


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input-root",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    source_summary, signals, ledger_path=base.load_source(Path(args.input_root))
    cache,file_audit=base.download_paths(signals)

    paths={}
    failures=[]
    for r in signals.itertuples(index=False):
        key=(str(r.symbol),pd.Timestamp(r.timestamp))
        g,err=base.build_path(cache,str(r.symbol),pd.Timestamp(r.timestamp),float(r.entryPrice))
        if g is None:
            failures.append({"symbol":str(r.symbol),"timestamp":str(r.timestamp),"error":err})
            continue
        paths[key]=g
    coverage=len(paths)/max(len(signals),1)
    if coverage < 0.95:
        raise RuntimeError(f"V11_PATH_COVERAGE_TOO_LOW:{len(paths)}/{len(signals)}")

    fit_signals=signals[signals["date"] < base.FIT_END].copy()

    x_cont,y_cont,_=base.make_model_rows(fit_signals,paths)
    continuation_model=base.fit_model(x_cont,y_cont)
    continuation_probas={key:base.predict_proba(continuation_model,g) for key,g in paths.items()}

    x_pre,y_pre=make_prearm_rows(fit_signals,paths)
    prearm_model=fit_prearm_model(x_pre,y_pre)
    arm_probas={key:predict_prearm(prearm_model,g) for key,g in paths.items()}

    candidates=[("NO_PREARM_EXIT",None)] + [
        (f"PREARM_T{t:.2f}",t) for t in PREARM_THRESHOLDS
    ]
    reports={}
    grid=[]
    for name,t in candidates:
        trades=replay(signals,paths,continuation_probas,arm_probas,t,name)
        parts=period_split(trades)
        mm=metrics_for(parts)
        gc=base.gate(mm["calibration"],30)
        gv=base.gate(mm["validation"],30)
        gb=base.gate(mm["postHocBenchmark"],15)
        reports[name]={
            "threshold":t,
            "trades":trades,
            "metrics":mm,
            "calibrationGate":gc,
            "validationGate":gv,
            "postHocBenchmarkGate":gb,
            "capture":{k:slim_capture(v) for k,v in parts.items()},
        }
        grid.append({
            "policy":name,
            "threshold":t,
            "calibrationPass":gc["pass"],
            "calibrationReturn":mm["calibration"].get("totalReturn"),
            "calibrationPF":mm["calibration"].get("profitFactor"),
            "calibrationMDD":mm["calibration"].get("mdd"),
            "calibrationPosMonthRate":mm["calibration"].get("positiveMonthRate"),
            "validationPass":gv["pass"],
            "validationReturn":mm["validation"].get("totalReturn"),
            "validationPF":mm["validation"].get("profitFactor"),
            "validationMDD":mm["validation"].get("mdd"),
            "validationPosMonthRate":mm["validation"].get("positiveMonthRate"),
            "benchmarkReturn":mm["postHocBenchmark"].get("totalReturn"),
            "benchmarkPF":mm["postHocBenchmark"].get("profitFactor"),
            "benchmarkMDD":mm["postHocBenchmark"].get("mdd"),
            "benchmarkPosMonthRate":mm["postHocBenchmark"].get("positiveMonthRate"),
        })

    eligible=[n for n,d in reports.items() if n!="NO_PREARM_EXIT" and d["calibrationGate"]["pass"]]
    winner=sorted(
        eligible,
        key=lambda n:base.rank_key(reports[n]["metrics"]["calibration"],n),
        reverse=True,
    )[0] if eligible else None

    pd.DataFrame(grid).to_csv(out/"policy-grid.csv",index=False)
    summary={
        "schemaVersion":1,
        "contract":"crypto-futures-dynamic-exit-v11",
        "sourceContract":source_summary.get("contract"),
        "sourceWinner":source_summary.get("winner"),
        "sourceLedger":ledger_path,
        "signalCount":int(len(signals)),
        "replayedSignals":int(len(paths)),
        "replayCoverage":coverage,
        "postArmPolicy":POSTARM_POLICY,
        "prearmModelStates":int(len(x_pre)),
        "prearmPositiveRate":float(y_pre.mean()),
        "continuationModelStates":int(len(x_cont)),
        "candidatePolicies":len(candidates),
        "winner":winner,
        "fileAudit":file_audit,
        "pathFailures":len(failures),
        "truthBoundary":{
            "entrySignalUnchangedFromFundingV32Winner":True,
            "hardStopRemainsMaximumLossBackstop":True,
            "prearmAiBeginsAfterFiveCompletedOneMinuteBars":True,
            "prearmExitRequiresTwoConsecutiveWeakProbabilities":True,
            "prearmAiExitExecutesNextMinuteOpen":True,
            "profitProtectionArmsAt3pct":True,
            "postArmAiAndTrailingFrozenFromDynamicExitV1":True,
            "allAiModelsFitOnlyBefore2024_07_01":True,
            "prearmThresholdSelectedOnlyOn2024_07_to_2025_03Calibration":True,
            "validationNotUsedForPrearmThresholdSelection":True,
            "entryStrategyWasPreviouslySelectedUsing2025_04_to_2026_03Validation":True,
            "combinedSystemValidationFullyIndependent":False,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }

    base_report=reports["NO_PREARM_EXIT"]
    summary["baselineNoPrearm"]={
        **base_report["metrics"],
        "capture":base_report["capture"],
    }
    if winner:
        d=reports[winner]
        summary["winnerResults"]={
            **d["metrics"],
            "calibrationGate":d["calibrationGate"],
            "validationGate":d["validationGate"],
            "postHocBenchmarkGate":d["postHocBenchmarkGate"],
            "capture":d["capture"],
        }
        d["trades"].to_csv(out/"winner-ledger.csv",index=False)

    (out/"summary.json").write_text(
        json.dumps(summary,ensure_ascii=False,indent=2)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
