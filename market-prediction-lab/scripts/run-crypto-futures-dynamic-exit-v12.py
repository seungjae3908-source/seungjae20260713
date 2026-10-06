#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
BASE_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-crypto-futures-dynamic-exit-v1.py"
SPEC = importlib.util.spec_from_file_location("dynamic_exit_v1", BASE_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("DYNAMIC_EXIT_V1_IMPORT_FAILED")
base = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(base)

AI_ENABLE_LEVELS = (0.035, 0.040, 0.045)
AI_THRESHOLDS = (0.45, 0.55, 0.65)
TRAIL_START = 0.05
TRAIL_GAPS = (0.008, 0.010)
PROFIT_FLOOR = 0.02


def policies():
    out=[]
    for enable in AI_ENABLE_LEVELS:
        for threshold in AI_THRESHOLDS:
            for gap in TRAIL_GAPS:
                out.append({
                    "name":f"STAGED_A{enable*100:.1f}_T{threshold:.2f}_G{gap*100:.1f}",
                    "aiEnable":enable,
                    "threshold":threshold,
                    "trailGap":gap,
                })
    return out


def simulate(g: pd.DataFrame, proba: np.ndarray, policy: dict):
    entry=float(g["open"].iloc[0])
    hard_stop=entry*(1.0+base.HARD_STOP)
    armed=False
    peak_profit=0.0
    pending_ai=False
    exit_i=len(g)-1
    exit_price=float(g["close"].iloc[-1])
    reason="MAX_HOLD"

    for i in range(len(g)):
        op=float(g["open"].iloc[i])
        hi=float(g["high"].iloc[i])
        lo=float(g["low"].iloc[i])

        if pending_ai:
            exit_i=i
            exit_price=op
            reason="AI_TREND_DIED"
            break

        if not armed and hi>=hard_stop:
            exit_i=i
            exit_price=hard_stop
            reason="HARD_STOP"
            break

        if armed:
            lock=PROFIT_FLOOR
            if peak_profit>=TRAIL_START:
                lock=max(lock,peak_profit-float(policy["trailGap"]))
            floor_price=entry*(1.0-lock)
            if hi>=floor_price:
                exit_i=i
                exit_price=floor_price
                reason="TRAIL_PROTECT" if peak_profit>=TRAIL_START else "PROFIT_FLOOR"
                break

        minute_peak=1.0-lo/entry
        peak_profit=max(peak_profit,minute_peak)
        if not armed and minute_peak>=base.ARM_PROFIT:
            armed=True

        # Exact intended behavior:
        # +3% arms a hard profit floor, but AI does not force an exit yet.
        # AI starts judging only after the trade has reached the configured
        # 3.5-4.5% profit zone. If trend remains strong, it may hold beyond 5%.
        if armed and peak_profit>=float(policy["aiEnable"]):
            if float(proba[i])<float(policy["threshold"]):
                pending_ai=True

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
        "armed3pct":bool(armed),
        "peakProfit":peak_profit,
    }


def replay(signals,paths,probas,policy):
    rows=[]
    for r in signals.itertuples(index=False):
        key=(str(r.symbol),pd.Timestamp(r.timestamp))
        g=paths.get(key)
        if g is None:
            continue
        res=simulate(g,probas[key],policy)
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


def split(trades):
    d=pd.to_datetime(trades["date"]).dt.date
    return {
        "fit":trades[d<base.FIT_END].copy(),
        "calibration":trades[(d>=base.FIT_END)&(d<base.CAL_END)].copy(),
        "validation":trades[(d>=base.CAL_END)&(d<base.VALID_END)].copy(),
        "postHocBenchmark":trades[(d>=base.VALID_END)&(d<base.BENCH_END)].copy(),
    }


def metrics(parts):
    return {
        "fit":base.calc_metrics(parts["fit"],"2023-05-01",str(base.FIT_END)),
        "calibration":base.calc_metrics(parts["calibration"],str(base.FIT_END),str(base.CAL_END)),
        "validation":base.calc_metrics(parts["validation"],str(base.CAL_END),str(base.VALID_END)),
        "postHocBenchmark":base.calc_metrics(parts["postHocBenchmark"],str(base.VALID_END),str(base.BENCH_END)),
    }


def capture(pdf):
    if pdf.empty:
        return {"trades":0}
    return {
        "trades":int(len(pdf)),
        "armed3pctTrades":int(pdf["armed3pct"].sum()),
        "medianHoldMinutes":float(pd.to_numeric(pdf["holdMinutes"],errors="coerce").median()),
        "exitReasons":{str(k):int(v) for k,v in pdf["exitReason"].value_counts().to_dict().items()},
        "meanNet":float(pd.to_numeric(pdf["netReturn"],errors="coerce").mean()),
    }


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input-root",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

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
        paths[key]=g
    coverage=len(paths)/max(len(signals),1)
    if coverage<0.95:
        raise RuntimeError(f"V12_PATH_COVERAGE_TOO_LOW:{len(paths)}/{len(signals)}")

    fit_signals=signals[signals["date"]<base.FIT_END].copy()
    x,y,_=base.make_model_rows(fit_signals,paths)
    model=base.fit_model(x,y)
    probas={key:base.predict_proba(model,g) for key,g in paths.items()}

    reports={}
    grid=[]
    for policy in policies():
        trades=replay(signals,paths,probas,policy)
        parts=split(trades)
        mm=metrics(parts)
        gc=base.gate(mm["calibration"],30)
        gv=base.gate(mm["validation"],30)
        gb=base.gate(mm["postHocBenchmark"],15)
        reports[policy["name"]]={
            "policy":policy,"trades":trades,"metrics":mm,
            "calibrationGate":gc,"validationGate":gv,"postHocBenchmarkGate":gb,
            "capture":{k:capture(v) for k,v in parts.items()},
        }
        grid.append({
            "policy":policy["name"],
            "aiEnable":policy["aiEnable"],
            "aiThreshold":policy["threshold"],
            "trailGap":policy["trailGap"],
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

    eligible=[n for n,d in reports.items() if d["calibrationGate"]["pass"]]
    winner=sorted(
        eligible,
        key=lambda n:base.rank_key(reports[n]["metrics"]["calibration"],n),
        reverse=True,
    )[0] if eligible else None

    pd.DataFrame(grid).to_csv(out/"policy-grid.csv",index=False)
    summary={
        "schemaVersion":1,
        "contract":"crypto-futures-dynamic-exit-v12",
        "sourceContract":source_summary.get("contract"),
        "sourceWinner":source_summary.get("winner"),
        "sourceLedger":ledger_path,
        "signalCount":int(len(signals)),
        "replayedSignals":int(len(paths)),
        "replayCoverage":coverage,
        "modelFitStates":int(len(x)),
        "modelFitPositiveRate":float(y.mean()),
        "candidatePolicies":len(reports),
        "winner":winner,
        "fileAudit":file_audit,
        "pathFailures":len(failures),
        "truthBoundary":{
            "entrySignalUnchangedFromFundingV32Winner":True,
            "exitReplayResolution":"1m",
            "hardStopAlwaysActiveBeforeProfitArm":True,
            "profitFloorArmsAt3pct":True,
            "aiDoesNotForceExitBeforeConfiguredProfitZone":True,
            "aiProfitZoneCandidates":[0.035,0.040,0.045],
            "aiDecisionUsesOnlyCompletedOneMinuteBars":True,
            "aiExitExecutesNextMinuteOpen":True,
            "trailingBeginsOnlyAfter5pctPeak":True,
            "modelFitOnlyBefore2024_07_01":True,
            "policySelectedOnlyOn2024_07_to_2025_03Calibration":True,
            "validationNotUsedForPolicySelection":True,
            "entryStrategyWasPreviouslySelectedUsing2025_04_to_2026_03Validation":True,
            "combinedSystemValidationFullyIndependent":False,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    if winner:
        d=reports[winner]
        summary["winnerResults"]={
            **d["metrics"],
            "calibrationGate":d["calibrationGate"],
            "validationGate":d["validationGate"],
            "postHocBenchmarkGate":d["postHocBenchmarkGate"],
            "capture":d["capture"],
            "policy":d["policy"],
        }
        d["trades"].to_csv(out/"winner-ledger.csv",index=False)

    (out/"summary.json").write_text(
        json.dumps(summary,ensure_ascii=False,indent=2)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
