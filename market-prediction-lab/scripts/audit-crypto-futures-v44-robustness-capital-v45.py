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

v44=load(
    "v44",
    "market-prediction-lab/scripts/run-crypto-futures-v43-short-exact1m-v44.py",
)

TARGET=0.03

def concentration(df:pd.DataFrame)->dict:
    if df.empty:
        return {"distinctSymbols":0}
    z=df.copy()
    z["netReturn"]=pd.to_numeric(z["netReturn"],errors="coerce").fillna(0.0)
    g=z.groupby("symbol",as_index=False).agg(
        trades=("symbol","size"),
        netSum=("netReturn","sum"),
        positiveNet=("netReturn",lambda s: float(np.maximum(pd.to_numeric(s,errors="coerce").fillna(0).to_numpy(float),0).sum())),
    )
    g_trade=g.sort_values("trades",ascending=False)
    total_trades=max(int(len(z)),1)
    positive_total=float(g["positiveNet"].sum())
    g_pos=g.sort_values("positiveNet",ascending=False)
    return {
        "distinctSymbols":int(len(g)),
        "top1TradeShare":float(g_trade.head(1)["trades"].sum()/total_trades),
        "top5TradeShare":float(g_trade.head(5)["trades"].sum()/total_trades),
        "top10TradeShare":float(g_trade.head(10)["trades"].sum()/total_trades),
        "top1PositivePnlShare":float(g_pos.head(1)["positiveNet"].sum()/max(positive_total,1e-12)),
        "top5PositivePnlShare":float(g_pos.head(5)["positiveNet"].sum()/max(positive_total,1e-12)),
        "top10PositivePnlShare":float(g_pos.head(10)["positiveNet"].sum()/max(positive_total,1e-12)),
        "topPositiveSymbols":g_pos.head(10)[["symbol","trades","netSum","positiveNet"]].to_dict("records"),
        "bestSymbolNetSum":float(g["netSum"].max()),
        "worstSymbolNetSum":float(g["netSum"].min()),
    }

def remove_top_positive(df:pd.DataFrame,n:int)->tuple[pd.DataFrame,list[str]]:
    if df.empty:
        return df.copy(),[]
    g=df.groupby("symbol")["netReturn"].sum().sort_values(ascending=False)
    top=[str(x) for x in g.head(n).index]
    return df[~df["symbol"].astype(str).isin(top)].copy(),top

def slot_capital(df:pd.DataFrame,max_positions:int)->dict:
    if df.empty:
        return {
            "maxPositions":max_positions,"entries":0,"finalEquity":1.0,
            "totalReturn":0.0,"mdd":0.0,"positiveActiveMonthRate":0.0,
        }
    x=df.copy()
    x["entryTime"]=pd.to_datetime(x["entryTime"],utc=True)
    x["exitTime"]=pd.to_datetime(x["exitTime"],utc=True)
    x["score"]=pd.to_numeric(x["score"],errors="coerce").fillna(-np.inf)
    x["netReturn"]=pd.to_numeric(x["netReturn"],errors="coerce")
    x=x.dropna(subset=["entryTime","exitTime","netReturn"]).sort_values(
        ["entryTime","score","symbol"],ascending=[True,False,True]
    )

    slots=[
        {"capital":1.0/max_positions,"active":None}
        for _ in range(max_positions)
    ]
    active_symbol={}
    equity_curve=[1.0]
    realized=[]
    entries=0
    capacity_blocked=0
    already_open=0
    opp_total=int((pd.to_numeric(x["MFE"],errors="coerce")>=TARGET).sum())
    opp_entered=0
    max_concurrent=0

    def release_until(t):
        nonlocal active_symbol
        due=[]
        for i,s in enumerate(slots):
            a=s["active"]
            if a is not None and a["exitTime"]<=t:
                due.append((a["exitTime"],i))
        for _,i in sorted(due):
            a=slots[i]["active"]
            before=float(slots[i]["capital"])
            r=float(a["netReturn"])
            after=before*(1.0+r)
            slots[i]["capital"]=after
            slots[i]["active"]=None
            active_symbol.pop(a["symbol"],None)
            pnl=after-before
            realized.append({"exitTime":a["exitTime"],"pnl":pnl})
            equity_curve.append(float(sum(s["capital"] for s in slots)))

    for t,batch in x.groupby("entryTime",sort=True):
        t=pd.Timestamp(t)
        release_until(t)
        for _,row in batch.sort_values("score",ascending=False).iterrows():
            symbol=str(row["symbol"])
            if symbol in active_symbol:
                already_open+=1
                continue
            free=next((i for i,s in enumerate(slots) if s["active"] is None),None)
            if free is None:
                capacity_blocked+=1
                continue
            a={
                "symbol":symbol,
                "exitTime":pd.Timestamp(row["exitTime"]),
                "netReturn":float(row["netReturn"]),
            }
            slots[free]["active"]=a
            active_symbol[symbol]=free
            entries+=1
            if float(row["MFE"])>=TARGET:
                opp_entered+=1
            max_concurrent=max(max_concurrent,len(active_symbol))

    # realize every remaining accepted position in chronological exit order
    while any(s["active"] is not None for s in slots):
        nxt=min(s["active"]["exitTime"] for s in slots if s["active"] is not None)
        release_until(pd.Timestamp(nxt))

    curve=np.array(equity_curve,dtype=float)
    peak=np.maximum.accumulate(curve)
    dd=np.where(peak>0,(peak-curve)/peak,0.0)
    final=float(curve[-1])
    rpdf=pd.DataFrame(realized)
    p=n=0
    if len(rpdf):
        rpdf["month"]=pd.to_datetime(rpdf["exitTime"],utc=True).dt.strftime("%Y-%m")
        ms=rpdf.groupby("month")["pnl"].sum()
        p=int((ms>0).sum());n=int((ms<0).sum())
    return {
        "maxPositions":int(max_positions),
        "entries":int(entries),
        "capacityBlocked":int(capacity_blocked),
        "alreadyOpenSuppressed":int(already_open),
        "maxConcurrent":int(max_concurrent),
        "opportunities3pct":int(opp_total),
        "executedOpportunities3pct":int(opp_entered),
        "executionRecall":float(opp_entered/max(opp_total,1)),
        "initialEquity":1.0,
        "finalEquity":final,
        "totalReturn":float(final-1.0),
        "mdd":float(dd.max()) if len(dd) else 0.0,
        "positiveMonths":p,
        "negativeMonths":n,
        "positiveActiveMonthRate":float(p/max(p+n,1)),
        "slotCapitalMethod":"independent_equal_initial_slots_compound_on_exit",
    }

def period_audit(df:pd.DataFrame)->dict:
    base=v44.exact_metrics(df)
    conc=concentration(df)
    removed={}
    for n in (1,5,10):
        sub,syms=remove_top_positive(df,n)
        removed[str(n)]={
            "removedSymbols":syms,
            "metrics":v44.exact_metrics(sub),
        }
    caps=[slot_capital(df,n) for n in (1,3,5)]
    cap3=next(x for x in caps if x["maxPositions"]==3)
    checks={
        "exactPositiveEV":base["meanNet"]>0,
        "exactProfitFactorAbove1":base["profitFactor"]>1,
        "positiveActiveMonthRateAtLeast50pct":base["positiveActiveMonthRate"]>=0.50,
        "distinctSymbolsAtLeast20":int(conc.get("distinctSymbols",0))>=20,
        "top1TradeShareBelow20pct":float(conc.get("top1TradeShare",1))<0.20,
        "top5RemovedStillPositiveEV":removed["5"]["metrics"]["meanNet"]>0,
        "top5RemovedStillPfAbove1":removed["5"]["metrics"]["profitFactor"]>1,
        "threeSlotCapitalPositive":cap3["totalReturn"]>0,
        "threeSlotMddAtMost35pct":cap3["mdd"]<=0.35,
        "threeSlotPositiveMonthRateAtLeast50pct":cap3["positiveActiveMonthRate"]>=0.50,
    }
    return {
        "exactMetrics":base,
        "concentration":conc,
        "removeTopContributorDiagnostics":removed,
        "slotCapital":caps,
        "robustnessGate":{"pass":all(checks.values()),"checks":checks},
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--exact-events",required=True)
    ap.add_argument("--source-summary",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    source=json.loads(Path(args.source_summary).read_text(encoding="utf-8"))
    if source.get("contract")!="crypto-futures-v43-short-exact1m-v44":
        raise RuntimeError("V45_WRONG_SOURCE")
    if not bool(source.get("promotionPass")):
        raise RuntimeError("V45_SOURCE_NOT_PROMOTED")

    df=pd.read_parquet(args.exact_events)
    val=df[df["period"].astype(str)=="validation"].copy()
    fresh=df[df["period"].astype(str)=="fresh_oos"].copy()
    va=period_audit(val);fa=period_audit(fresh)

    pd.DataFrame(va["slotCapital"]).to_csv(out/"validation-slot-capital.csv",index=False)
    pd.DataFrame(fa["slotCapital"]).to_csv(out/"fresh-slot-capital.csv",index=False)

    result={
        "schemaVersion":1,
        "contract":"crypto-futures-v44-robustness-capital-v45",
        "sourceRun":37453972448,
        "sourceThreshold":source["threshold"],
        "validation":va,
        "freshOos":fa,
        "robustnessPass":bool(
            va["robustnessGate"]["pass"] and fa["robustnessGate"]["pass"]
        ),
        "truthBoundary":{
            "frozenV44Exact1mEventsOnly":True,
            "noThresholdRetuning":True,
            "noCandidateReselection":True,
            "topContributorRemovalIsDiagnosticOnly":True,
            "slotCapitalReturnIsNormalizedNotUserAccountBacktest":True,
            "validationAndFreshAuditedSeparately":True,
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
