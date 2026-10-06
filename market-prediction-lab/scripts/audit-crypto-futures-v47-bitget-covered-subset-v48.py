#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v46=load(
    "v46",
    "market-prediction-lab/scripts/audit-crypto-futures-v45-fullcost-funding-v46.py",
)
v45=load(
    "v45",
    "market-prediction-lab/scripts/audit-crypto-futures-v44-robustness-capital-v45.py",
)

MIN_ROWS=100
MIN_SYMBOLS=20
MIN_EVENT_COVERAGE=0.50

def month_key(s:pd.Series)->pd.Series:
    return pd.to_datetime(s,utc=True).dt.strftime("%Y-%m")

def summarize_coverage(all_df:pd.DataFrame,covered:pd.DataFrame)->dict:
    all_symbols=int(all_df["symbol"].astype(str).nunique()) if len(all_df) else 0
    cov_symbols=int(covered["symbol"].astype(str).nunique()) if len(covered) else 0
    return {
        "allRows":int(len(all_df)),
        "coveredRows":int(len(covered)),
        "eventCoverage":float(len(covered)/max(len(all_df),1)),
        "allSymbols":all_symbols,
        "coveredSymbols":cov_symbols,
        "symbolCoverage":float(cov_symbols/max(all_symbols,1)),
    }

def audit_period(df:pd.DataFrame)->dict:
    scenarios={}
    for name,extra in v46.STRESS_EXTRA_COSTS.items():
        z=df.copy()
        z["netReturn"]=pd.to_numeric(z["netReturnWithFunding"],errors="coerce")-float(extra)
        scenarios[name]=v45.period_audit(z)
    actual=scenarios["actualFunding"]
    plus10=scenarios["actualFundingPlus10bp"]
    cap3_actual=next(x for x in actual["slotCapital"] if x["maxPositions"]==3)
    cap3_plus10=next(x for x in plus10["slotCapital"] if x["maxPositions"]==3)
    checks={
        "minimumRows":len(df)>=MIN_ROWS,
        "minimumSymbols":int(df["symbol"].astype(str).nunique())>=MIN_SYMBOLS,
        "actualFundingRobustnessPass":bool(actual["robustnessGate"]["pass"]),
        "plus10bpPositiveEV":float(plus10["exactMetrics"]["meanNet"])>0,
        "plus10bpProfitFactorAbove1":float(plus10["exactMetrics"]["profitFactor"])>1,
        "plus10bpThreeSlotPositive":float(cap3_plus10["totalReturn"])>0,
        "plus10bpThreeSlotMddAtMost35pct":float(cap3_plus10["mdd"])<=0.35,
        "actualThreeSlotPositive":float(cap3_actual["totalReturn"])>0,
    }
    compact={}
    for k,v in scenarios.items():
        compact[k]={
            "exactMetrics":v["exactMetrics"],
            "slotCapital":v["slotCapital"],
            "robustnessGate":v["robustnessGate"],
        }
    return {
        "rows":int(len(df)),
        "symbols":int(df["symbol"].astype(str).nunique()),
        "scenarios":compact,
        "coveredSubsetGate":{"pass":all(checks.values()),"checks":checks},
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--fullcost-events",required=True)
    ap.add_argument("--probe-rows",required=True)
    ap.add_argument("--v46-summary",required=True)
    ap.add_argument("--v47-summary",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    s46=json.loads(Path(args.v46_summary).read_text(encoding="utf-8"))
    s47=json.loads(Path(args.v47_summary).read_text(encoding="utf-8"))
    if s46.get("contract")!="crypto-futures-v45-fullcost-funding-v46":
        raise RuntimeError("V48_WRONG_V46_SOURCE")
    if not bool(s46.get("fullCostPass")):
        raise RuntimeError("V48_V46_NOT_FULLCOST_PASS")
    if s47.get("contract")!="crypto-futures-v46-bitget-portability-v47":
        raise RuntimeError("V48_WRONG_V47_SOURCE")

    events=pd.read_parquet(args.fullcost_events)
    events["entryTime"]=pd.to_datetime(events["entryTime"],utc=True)
    events["month"]=month_key(events["entryTime"])
    events["symbol"]=events["symbol"].astype(str)

    probes=pd.read_csv(args.probe_rows)
    probes["symbol"]=probes["symbol"].astype(str)
    probes["entryTime"]=pd.to_datetime(probes["entryTime"],utc=True,errors="coerce")
    probes["month"]=month_key(probes["entryTime"])
    probes["ok"]=probes["ok"].astype(str).str.lower().isin(["true","1","yes"])
    covered_months=(
        probes[probes["ok"]]
        .sort_values(["symbol","month","entryTime"])
        .drop_duplicates(["symbol","month"])
        [["symbol","month","openBasis"]]
        .copy()
    )
    covered_keys=set(zip(covered_months["symbol"],covered_months["month"]))
    events["bitgetCoveredSymbolMonth"]=[
        (str(s),str(m)) in covered_keys
        for s,m in zip(events["symbol"],events["month"])
    ]

    covered=events[events["bitgetCoveredSymbolMonth"]].copy()
    covered.to_parquet(out/"bitget-covered-fullcost-events.parquet",index=False)

    by_period={}
    overall_cov=summarize_coverage(events,covered)
    for period in ("validation","fresh_oos"):
        all_p=events[events["period"].astype(str)==period].copy()
        cov_p=covered[covered["period"].astype(str)==period].copy()
        cov=summarize_coverage(all_p,cov_p)
        audit=audit_period(cov_p)
        by_period[period]={"coverage":cov,"audit":audit}

    val=by_period["validation"]
    fresh=by_period["fresh_oos"]
    coverage_checks={
        "overallEventCoverageAtLeast50pct":overall_cov["eventCoverage"]>=MIN_EVENT_COVERAGE,
        "validationEventCoverageAtLeast50pct":val["coverage"]["eventCoverage"]>=MIN_EVENT_COVERAGE,
        "freshEventCoverageAtLeast50pct":fresh["coverage"]["eventCoverage"]>=MIN_EVENT_COVERAGE,
        "validationCoveredSubsetPass":bool(val["audit"]["coveredSubsetGate"]["pass"]),
        "freshCoveredSubsetPass":bool(fresh["audit"]["coveredSubsetGate"]["pass"]),
    }

    # Price basis is diagnostic only. We deliberately do not rewrite returns from
    # one sampled Bitget candle because V4.7 did not fetch full Bitget paths.
    basis=pd.to_numeric(covered_months.get("openBasis"),errors="coerce").dropna().abs()

    result={
        "schemaVersion":1,
        "contract":"crypto-futures-v47-bitget-covered-subset-v48",
        "sourceRunV46":37455166769,
        "sourceRunV47":37455634805,
        "overallCoverage":overall_cov,
        "bitgetCoveredSymbolMonths":int(len(covered_months)),
        "bitgetBasisDiagnostic":{
            "medianAbsOpenBasis":float(basis.median()) if len(basis) else None,
            "p95AbsOpenBasis":float(basis.quantile(0.95)) if len(basis) else None,
        },
        "periods":by_period,
        "coveredSubsetPass":bool(all(coverage_checks.values())),
        "coveredSubsetChecks":coverage_checks,
        "truthBoundary":{
            "filtersOnlyByHistoricallyObservedBitgetTradabilityAtSymbolMonthLevel":True,
            "noSignalThresholdRetuning":True,
            "noCandidateReselection":True,
            "usesFrozenV46FundingAndFullCostReturns":True,
            "bitgetOpenBasisDiagnosticNotAppliedAsSyntheticPnl":True,
            "doesNotClaimMissingBinanceSymbolsAreTradableOnBitget":True,
            "liveEquivalentWouldUseCurrentBitgetInstrumentListBeforeSignalExecution":True,
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
