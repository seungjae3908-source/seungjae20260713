#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import math
from pathlib import Path

import pandas as pd

ROOT=Path(__file__).resolve().parents[2]
BASE_SCRIPT=ROOT/"market-prediction-lab"/"scripts"/"run-crypto-futures-dynamic-exit-v1.py"
SPEC=importlib.util.spec_from_file_location("dynamic_exit_v1",BASE_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("BASE_IMPORT_FAILED")
base=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(base)

SELECT_END=pd.Timestamp("2024-04-01").date()
VAL1_END=pd.Timestamp("2024-10-01").date()
VAL2_END=pd.Timestamp("2025-04-01").date()
REUSED_END=pd.Timestamp("2026-04-01").date()
POST_END=pd.Timestamp("2026-10-01").date()

RVOL_MAX=(3.5,5.0,7.5,None)
ABS_FLOW_MAX=(0.15,0.22,0.30,None)
RET4_MIN=(-0.015,-0.025,-0.040,None)


def find_summary(root:Path,contract:str):
    for p in root.glob("**/summary.json"):
        try: x=json.loads(p.read_text(encoding="utf-8"))
        except Exception: continue
        if x.get("contract")==contract:
            return x
    raise RuntimeError(f"SUMMARY_NOT_FOUND:{contract}")


def find_ledger(root:Path):
    xs=list(root.glob("**/winner-ledger.csv"))
    if not xs:
        raise RuntimeError(f"WINNER_LEDGER_NOT_FOUND:{root}")
    return xs[0]


def load_join(source_root:Path,exit_root:Path):
    source_summary=find_summary(source_root,"full-universe-3pct-hunter-futures-funding-v32")
    exit_summary=find_summary(exit_root,"crypto-futures-dynamic-exit-v12")
    if exit_summary.get("winner")!="STAGED_A3.5_T0.55_G0.8":
        raise RuntimeError(f"UNEXPECTED_EXIT_WINNER:{exit_summary.get('winner')}")

    s=pd.read_csv(find_ledger(source_root))
    e=pd.read_csv(find_ledger(exit_root))
    for df in (s,e):
        df["timestamp"]=pd.to_datetime(df["timestamp"],utc=True,errors="coerce")
        df["symbol"]=df["symbol"].astype(str)
    s=s.dropna(subset=["timestamp","symbol"]).drop_duplicates(["timestamp","symbol"])
    e=e.dropna(subset=["timestamp","symbol","netReturn"]).drop_duplicates(["timestamp","symbol"])
    needed=["timestamp","symbol","rvol","flow4","ret4"]
    missing=[c for c in needed if c not in s.columns]
    if missing:
        raise RuntimeError(f"SOURCE_COLUMNS_MISSING:{missing}")
    x=e.merge(s[needed],on=["timestamp","symbol"],how="inner",validate="one_to_one")
    if len(x)<int(len(e)*0.98):
        raise RuntimeError(f"JOIN_COVERAGE_LOW:{len(x)}/{len(e)}")
    x["date"]=pd.to_datetime(x["date"],errors="coerce").dt.date
    for c in ["rvol","flow4","ret4","netReturn"]:
        x[c]=pd.to_numeric(x[c],errors="coerce")
    x=x.dropna(subset=["date","rvol","flow4","ret4","netReturn"]).copy()
    x["absFlow4"]=x["flow4"].abs()
    return source_summary,exit_summary,x


def calc(pdf,start,end):
    return base.calc_metrics(pdf,start,end)


def periods(pdf):
    d=pdf["date"]
    return {
        "selection":calc(pdf[d<SELECT_END],"2023-05-01",str(SELECT_END)),
        "validation1":calc(pdf[(d>=SELECT_END)&(d<VAL1_END)],str(SELECT_END),str(VAL1_END)),
        "validation2":calc(pdf[(d>=VAL1_END)&(d<VAL2_END)],str(VAL1_END),str(VAL2_END)),
        "reused":calc(pdf[(d>=VAL2_END)&(d<REUSED_END)],str(VAL2_END),str(REUSED_END)),
        "postHocBenchmark":calc(pdf[(d>=REUSED_END)&(d<POST_END)],str(REUSED_END),str(POST_END)),
    }


def fmt(x):
    return "INF" if x is None else str(x).replace(".","p").replace("-","m")


def key(rv,flow,ret):
    return f"GUARD_RV{fmt(rv)}_F{fmt(flow)}_R{fmt(ret)}"


def mask(df,rv,flow,ret):
    m=pd.Series(True,index=df.index)
    if rv is not None: m &= df["rvol"]<=rv
    if flow is not None: m &= df["absFlow4"]<=flow
    if ret is not None: m &= df["ret4"]>=ret
    return m


def rank_key(d,name):
    v1=d["metrics"]["validation1"]
    v2=d["metrics"]["validation2"]
    return (
        float(v1.get("positiveMonthRate") or 0)+float(v2.get("positiveMonthRate") or 0),
        float(v1.get("totalReturn") or 0)+float(v2.get("totalReturn") or 0),
        float(v1.get("profitFactor") or 0)+float(v2.get("profitFactor") or 0),
        -max(float(v1.get("mdd") or 1),float(v2.get("mdd") or 1)),
        d["selectionRetention"],
        name,
    )


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--source-root",required=True)
    ap.add_argument("--exit-root",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    source_summary,exit_summary,df=load_join(Path(args.source_root),Path(args.exit_root))
    base_metrics=periods(df)
    selection_total=int(base_metrics["selection"].get("tradeCount") or 0)

    reports={}
    grid=[]
    for rv in RVOL_MAX:
        for flow in ABS_FLOW_MAX:
            for ret in RET4_MIN:
                name=key(rv,flow,ret)
                y=df[mask(df,rv,flow,ret)].copy()
                mm=periods(y)
                retention=(int(mm["selection"].get("tradeCount") or 0)/max(selection_total,1))
                gs=base.gate(mm["selection"],20)
                g1=base.gate(mm["validation1"],10)
                g2=base.gate(mm["validation2"],10)
                robust=gs["pass"] and retention>=0.25 and g1["pass"] and g2["pass"]
                reports[name]={
                    "rvolMax":rv,"absFlowMax":flow,"ret4Min":ret,
                    "selectionRetention":retention,
                    "selectionGate":gs,"validation1Gate":g1,"validation2Gate":g2,
                    "robustPreLaterData":robust,
                    "metrics":mm,
                }
                grid.append({
                    "candidate":name,"rvolMax":rv,"absFlowMax":flow,"ret4Min":ret,
                    "selectionRetention":retention,
                    "selectionPass":gs["pass"],"validation1Pass":g1["pass"],"validation2Pass":g2["pass"],
                    "robustPreLaterData":robust,
                    "selectionReturn":mm["selection"].get("totalReturn"),"selectionPF":mm["selection"].get("profitFactor"),
                    "validation1Return":mm["validation1"].get("totalReturn"),"validation1PF":mm["validation1"].get("profitFactor"),"validation1PosMonthRate":mm["validation1"].get("positiveMonthRate"),"validation1Trades":mm["validation1"].get("tradeCount"),
                    "validation2Return":mm["validation2"].get("totalReturn"),"validation2PF":mm["validation2"].get("profitFactor"),"validation2PosMonthRate":mm["validation2"].get("positiveMonthRate"),"validation2Trades":mm["validation2"].get("tradeCount"),
                    "reusedReturn":mm["reused"].get("totalReturn"),"reusedPF":mm["reused"].get("profitFactor"),
                    "postHocReturn":mm["postHocBenchmark"].get("totalReturn"),"postHocPF":mm["postHocBenchmark"].get("profitFactor"),"postHocMDD":mm["postHocBenchmark"].get("mdd"),"postHocPosMonthRate":mm["postHocBenchmark"].get("positiveMonthRate"),"postHocTrades":mm["postHocBenchmark"].get("tradeCount"),
                })

    robust=[n for n,d in reports.items() if d["robustPreLaterData"]]
    winner=sorted(robust,key=lambda n:rank_key(reports[n],n),reverse=True)[0] if robust else None

    pd.DataFrame(grid).to_csv(out/"guard-grid.csv",index=False)
    summary={
        "schemaVersion":1,
        "contract":"crypto-futures-overextension-guard-v15",
        "sourceWinner":source_summary.get("winner"),
        "exitWinner":exit_summary.get("winner"),
        "joinedTrades":int(len(df)),
        "candidateCount":len(reports),
        "robustPreLaterDataCount":len(robust),
        "winner":winner,
        "baseline":base_metrics,
        "truthBoundary":{
            "guardUsesOnlyPreEntryCompleted15mFeatures":True,
            "dynamicExitFrozenFromV12":True,
            "guardThresholdsSelectedWithout2025_04_orLaterData":True,
            "both2024_04_to_09And2024_10_to_2025_03MustPass":True,
            "minimumSelectionRetention25pct":True,
            "sourceEntryStrategyWasPreviouslySelectedUsingLaterValidation":True,
            "combinedSystemValidationFullyIndependent":False,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    if winner:
        summary["winnerResults"]=reports[winner]
        w=reports[winner]
        df[mask(df,w["rvolMax"],w["absFlowMax"],w["ret4Min"])].to_csv(out/"winner-ledger.csv",index=False)

    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
