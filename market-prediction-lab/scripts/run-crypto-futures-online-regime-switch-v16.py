#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
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

WINDOWS=(20,30,40)
PF_MINS=(0.90,1.00,1.10)
MEAN_MINS=(0.0,0.0005)


def find_summary(root:Path):
    for p in root.glob("**/summary.json"):
        try: x=json.loads(p.read_text(encoding="utf-8"))
        except Exception: continue
        if x.get("contract")=="crypto-futures-overextension-guard-v15":
            return x
    raise RuntimeError("V15_SUMMARY_NOT_FOUND")


def find_ledger(root:Path):
    xs=list(root.glob("**/winner-ledger.csv"))
    if not xs:
        raise RuntimeError("V15_WINNER_LEDGER_NOT_FOUND")
    return xs[0]


def pf(arr):
    x=np.asarray(arr,dtype=float)
    pos=x[x>0].sum()
    neg=-x[x<0].sum()
    if neg<=1e-12:
        return float("inf") if pos>0 else 0.0
    return float(pos/neg)


def apply_switch(df:pd.DataFrame,window:int,pf_min:float,mean_min:float):
    x=df.sort_values(["timestamp","symbol"]).copy().reset_index(drop=True)
    nets=pd.to_numeric(x["netReturn"],errors="coerce").fillna(0.0).to_numpy(float)
    enabled=[]
    trail_pf=[]
    trail_mean=[]
    for i in range(len(x)):
        if i<window:
            enabled.append(True)
            trail_pf.append(None)
            trail_mean.append(None)
            continue
        hist=nets[i-window:i]
        p=pf(hist)
        m=float(np.mean(hist))
        enabled.append(bool(p>=pf_min and m>=mean_min))
        trail_pf.append(p)
        trail_mean.append(m)
    x["onlineEnabled"]=enabled
    x["priorShadowPF"]=trail_pf
    x["priorShadowMean"]=trail_mean
    return x


def calc(pdf,start,end):
    return base.calc_metrics(pdf,start,end)


def period_slice(df,start,end):
    a=pd.Timestamp(start).date(); b=pd.Timestamp(end).date()
    return df[(df["date"]>=a)&(df["date"]<b)].copy()


def eval_periods(executed):
    return {
        "selection":calc(period_slice(executed,"2023-05-01",str(SELECT_END)),"2023-05-01",str(SELECT_END)),
        "validation1":calc(period_slice(executed,str(SELECT_END),str(VAL1_END)),str(SELECT_END),str(VAL1_END)),
        "validation2":calc(period_slice(executed,str(VAL1_END),str(VAL2_END)),str(VAL1_END),str(VAL2_END)),
        "reused":calc(period_slice(executed,str(VAL2_END),str(REUSED_END)),str(VAL2_END),str(REUSED_END)),
        "postHocBenchmark":calc(period_slice(executed,str(REUSED_END),str(POST_END)),str(REUSED_END),str(POST_END)),
    }


def total_counts(df):
    return {
        "selection":len(period_slice(df,"2023-05-01",str(SELECT_END))),
        "validation1":len(period_slice(df,str(SELECT_END),str(VAL1_END))),
        "validation2":len(period_slice(df,str(VAL1_END),str(VAL2_END))),
        "reused":len(period_slice(df,str(VAL2_END),str(REUSED_END))),
        "postHocBenchmark":len(period_slice(df,str(REUSED_END),str(POST_END))),
    }


def rank_key(d,name):
    v1=d["metrics"]["validation1"]; v2=d["metrics"]["validation2"]
    return (
        float(v1.get("positiveMonthRate") or 0)+float(v2.get("positiveMonthRate") or 0),
        float(v1.get("totalReturn") or 0)+float(v2.get("totalReturn") or 0),
        float(v1.get("profitFactor") or 0)+float(v2.get("profitFactor") or 0),
        -max(float(v1.get("mdd") or 1),float(v2.get("mdd") or 1)),
        d["combinedValidationRetention"],
        name,
    )


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input-root",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    summary=find_summary(Path(args.input_root))
    if summary.get("winner")!="GUARD_RV7p5_FINF_Rm0p015":
        raise RuntimeError(f"UNEXPECTED_V15_WINNER:{summary.get('winner')}")
    df=pd.read_csv(find_ledger(Path(args.input_root)))
    df["timestamp"]=pd.to_datetime(df["timestamp"],utc=True,errors="coerce")
    df["date"]=pd.to_datetime(df["date"],errors="coerce").dt.date
    df["netReturn"]=pd.to_numeric(df["netReturn"],errors="coerce")
    df=df.dropna(subset=["timestamp","date","netReturn","symbol"]).sort_values(["timestamp","symbol"]).reset_index(drop=True)
    totals=total_counts(df)
    baseline=eval_periods(df)

    reports={}; grid=[]
    for window in WINDOWS:
        for pf_min in PF_MINS:
            for mean_min in MEAN_MINS:
                name=f"ONLINE_W{window}_PF{pf_min:.2f}_M{mean_min:.4f}"
                shadow=apply_switch(df,window,pf_min,mean_min)
                executed=shadow[shadow["onlineEnabled"]].copy()
                mm=eval_periods(executed)
                r1=(int(mm["validation1"].get("tradeCount") or 0)/max(totals["validation1"],1))
                r2=(int(mm["validation2"].get("tradeCount") or 0)/max(totals["validation2"],1))
                combined_retention=(r1+r2)/2.0
                gs=base.gate(mm["selection"],20)
                g1=base.gate(mm["validation1"],8)
                g2=base.gate(mm["validation2"],8)
                robust=gs["pass"] and g1["pass"] and g2["pass"] and combined_retention>=0.25
                reports[name]={
                    "window":window,"pfMin":pf_min,"meanMin":mean_min,
                    "validation1Retention":r1,"validation2Retention":r2,
                    "combinedValidationRetention":combined_retention,
                    "selectionGate":gs,"validation1Gate":g1,"validation2Gate":g2,
                    "robustPreLaterData":robust,
                    "metrics":mm,
                }
                grid.append({
                    "candidate":name,"window":window,"pfMin":pf_min,"meanMin":mean_min,
                    "robustPreLaterData":robust,
                    "validation1Retention":r1,"validation2Retention":r2,
                    "selectionReturn":mm["selection"].get("totalReturn"),"selectionPF":mm["selection"].get("profitFactor"),
                    "validation1Return":mm["validation1"].get("totalReturn"),"validation1PF":mm["validation1"].get("profitFactor"),"validation1PosMonthRate":mm["validation1"].get("positiveMonthRate"),"validation1Trades":mm["validation1"].get("tradeCount"),
                    "validation2Return":mm["validation2"].get("totalReturn"),"validation2PF":mm["validation2"].get("profitFactor"),"validation2PosMonthRate":mm["validation2"].get("positiveMonthRate"),"validation2Trades":mm["validation2"].get("tradeCount"),
                    "reusedReturn":mm["reused"].get("totalReturn"),"reusedPF":mm["reused"].get("profitFactor"),"reusedTrades":mm["reused"].get("tradeCount"),
                    "postHocReturn":mm["postHocBenchmark"].get("totalReturn"),"postHocPF":mm["postHocBenchmark"].get("profitFactor"),"postHocMDD":mm["postHocBenchmark"].get("mdd"),"postHocPosMonthRate":mm["postHocBenchmark"].get("positiveMonthRate"),"postHocTrades":mm["postHocBenchmark"].get("tradeCount"),
                })

    robust=[n for n,d in reports.items() if d["robustPreLaterData"]]
    winner=sorted(robust,key=lambda n:rank_key(reports[n],n),reverse=True)[0] if robust else None

    pd.DataFrame(grid).to_csv(out/"online-switch-grid.csv",index=False)
    summary_out={
        "schemaVersion":1,
        "contract":"crypto-futures-online-regime-switch-v16",
        "sourceWinner":summary.get("winner"),
        "sourceTrades":int(len(df)),
        "sourcePeriodCounts":totals,
        "candidateCount":len(reports),
        "robustPreLaterDataCount":len(robust),
        "winner":winner,
        "baseline":baseline,
        "truthBoundary":{
            "onlineGateUsesOnlyPriorClosedShadowTradeOutcomes":True,
            "disabledPeriodsStillProducePaperShadowOutcomesForFutureGateState":True,
            "noCurrentOrFutureTradeOutcomeUsedInGate":True,
            "thresholdsSelectedWithout2025_04_orLaterData":True,
            "both2024_04_to_09And2024_10_to_2025_03MustPass":True,
            "minimumAverageValidationRetention25pct":True,
            "sourceStaticGuardWasSelectedUsingPre2025Periods":True,
            "sourceEntryStrategyWasPreviouslySelectedUsingLaterValidation":True,
            "combinedSystemValidationFullyIndependent":False,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    if winner:
        w=reports[winner]
        summary_out["winnerResults"]=w
        shadow=apply_switch(df,w["window"],w["pfMin"],w["meanMin"])
        shadow.to_csv(out/"winner-shadow-ledger.csv",index=False)

    (out/"summary.json").write_text(json.dumps(summary_out,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary_out},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
