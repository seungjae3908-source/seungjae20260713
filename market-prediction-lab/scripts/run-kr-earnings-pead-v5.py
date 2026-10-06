#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl

ROOT=Path(__file__).resolve().parents[2]

def load_module(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v4=load_module("kr_dart_v4","market-prediction-lab/scripts/run-full-universe-3pct-hunter-kr-dart-event-v4.py")
krv3=v4.krv3
v1=v4.v1

START=pd.Timestamp("2023-04-01").date()
TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()
OOS_END=pd.Timestamp("2026-10-01").date()

RET_MINS=(0.02,0.04,0.06)
RVOL_MINS=(1.2,2.0)
NEAR52_MINS=(-0.10,-0.05,-0.02)
TOP_NS=(5,10,20)
TARGETS=(0.03,0.05)
STOPS=(0.015,0.025)
HOLDS=(1,3,5,10)
COST=v4.COST

POS_WORDS=("증가","흑자전환","사상최대","최대실적","호실적","개선")
NEG_WORDS=("감소","적자전환","적자지속","손실","악화")


def classify_earnings(report:str,text:str):
    r=str(report or "").strip()
    t=str(text or "")
    if any(r.startswith(p) for p in v4.CORRECTION_PREFIXES):
        return None
    if "영업(잠정)실적" in r or "잠정실적" in r:
        fam="PRELIM"
    elif "매출액또는손익구조" in r or "매출액 또는 손익구조" in r:
        fam="STRUCTURE_CHANGE"
    else:
        return None
    pos=sum(1 for w in POS_WORDS if w in t)
    neg=sum(1 for w in NEG_WORDS if w in t)
    sentiment="POS_TEXT" if pos>neg and pos>0 else ("NEG_TEXT" if neg>pos and neg>0 else "TEXT_UNKNOWN")
    return f"{fam}_{sentiment}"


def prepare_events():
    raw=v4.load_filing_catalog()
    raw["family"]=[classify_earnings(r,t) for r,t in zip(raw["reportName"],raw["searchText"])]
    x=raw[raw["family"].notna()].copy()
    x=x.sort_values(["eventDate","stockCode","rceptNo"]).drop_duplicates(["eventDate","stockCode","family"],keep="first")
    counts=(x.groupby("family").agg(events=("stockCode","size"),symbols=("stockCode","nunique")).reset_index().to_dict("records"))
    return x,{"rawFilings":len(raw),"earningsEvents":len(x),"familyCounts":counts}


def add_price_features(raw:pl.DataFrame):
    x=raw.sort(["symbol","date"]).with_columns([
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("close").shift(5).over("symbol").alias("close_5ago"),
        pl.col("volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorVol20"),
        (pl.col("close").shift(1)*pl.col("volume").shift(1)).rolling_mean(20,min_samples=10).over("symbol").alias("priorDollar20"),
        pl.col("high").shift(1).rolling_max(252,min_samples=100).over("symbol").alias("priorHigh252"),
    ]).with_columns([
        (pl.col("close")/pl.col("prev_close")-1.0).alias("eventDayReturn"),
        (pl.col("volume")/pl.col("priorVol20")).alias("eventRvol"),
        (pl.col("close")/pl.col("close_5ago")-1.0).alias("mom5"),
        (pl.col("close")/pl.col("priorHigh252")-1.0).alias("eventCloseVsPrior52wHigh"),
    ])
    pdf=x.to_pandas()
    pdf["date"]=pd.to_datetime(pdf["date"]).dt.date
    return pdf


def attach(events,price):
    groups={}
    rows=[]
    for sym,g in price.groupby("symbol",sort=False):
        groups[str(sym)]=g.sort_values("date").reset_index(drop=True)
    for e in events.itertuples(index=False):
        sym=str(e.stockCode)
        g=groups.get(sym)
        if g is None or g.empty: continue
        dates=np.array(g["date"].tolist(),dtype=object)
        cutoff_i=int(np.searchsorted(dates,e.eventDate,side="right")-1)
        entry_i=int(np.searchsorted(dates,e.eventDate,side="right"))
        if cutoff_i<252 or entry_i>=len(g): continue
        cutoff=g.iloc[cutoff_i]; entry=g.iloc[entry_i]
        # Use announcement-day market reaction only when the filing date is a trading day.
        if cutoff["date"]!=e.eventDate: continue
        if (entry["date"]-e.eventDate).days>7: continue
        vals=[cutoff.get("eventDayReturn"),cutoff.get("eventRvol"),cutoff.get("mom5"),cutoff.get("priorDollar20"),cutoff.get("eventCloseVsPrior52wHigh")]
        if any(pd.isna(v) for v in vals): continue
        if float(entry["open"])<1000 or float(cutoff["priorDollar20"])<500_000_000: continue
        rows.append({
            "stockCode":sym,"family":e.family,"eventDate":e.eventDate,"reportName":e.reportName,"rceptNo":e.rceptNo,
            "entryDate":entry["date"],"entryIndex":entry_i,
            "eventDayReturn":float(cutoff["eventDayReturn"]),"eventRvol":float(cutoff["eventRvol"]),
            "mom5":float(cutoff["mom5"]),"priorDollar20":float(cutoff["priorDollar20"]),
            "near52":float(cutoff["eventCloseVsPrior52wHigh"]),
        })
    if not rows:
        raise RuntimeError("KR_PEAD_V5_NO_TRADABLE_EVENTS")
    return pd.DataFrame(rows),groups


def rank_top(x,top_n):
    if x.empty:return x
    y=x.copy()
    y["r1"]=y.groupby("entryDate")["eventDayReturn"].rank(method="average",ascending=False)
    y["r2"]=y.groupby("entryDate")["eventRvol"].rank(method="average",ascending=False)
    y["r3"]=y.groupby("entryDate")["near52"].rank(method="average",ascending=False)
    y["r4"]=y.groupby("entryDate")["priorDollar20"].rank(method="average",ascending=False)
    y["score"]=-(y["r1"]+y["r2"]+y["r3"]+0.5*y["r4"])
    return y.sort_values(["entryDate","score","stockCode"],ascending=[True,False,True]).groupby("entryDate",group_keys=False).head(top_n)


def simulate(row,groups,target,stop,hold,name):
    g=groups.get(row.stockCode)
    if g is None:return None
    i=int(row.entryIndex); end=min(i+hold-1,len(g)-1)
    future=g.iloc[i:end+1]
    if future.empty:return None
    entry=float(future.iloc[0]["open"])
    sl=entry*(1-stop); tp=entry*(1+target)
    exit_px=float(future.iloc[-1]["close"]); reason="MAX_HOLD"; exit_date=future.iloc[-1]["date"]
    for _,bar in future.iterrows():
        if float(bar["low"])<=sl:
            exit_px=sl;reason="STOP";exit_date=bar["date"];break
        if float(bar["high"])>=tp:
            exit_px=tp;reason="TARGET";exit_date=bar["date"];break
    gross=exit_px/entry-1.0
    return {
        "market":"KR_STOCK","direction":"LONG","candidate":name,"date":row.entryDate,"symbol":row.stockCode,
        "family":row.family,"eventDate":row.eventDate,"reportName":row.reportName,"rceptNo":row.rceptNo,
        "entryPrice":entry,"exitPrice":exit_px,"grossReturn":gross,"roundTripCost":COST,"netReturn":gross-COST,
        "MFE":float(future["high"].max())/entry-1.0,"MAE":1.0-float(future["low"].min())/entry,
        "exitDate":exit_date,"exitReason":reason,"eventDayReturn":row.eventDayReturn,"eventRvol":row.eventRvol,
        "near52":row.near52,"mom5":row.mom5,"priorDollar20":row.priorDollar20,
    }


def calc(trades,dates):
    if not trades:
        empty=pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
        return v1.metrics(empty,"KR_STOCK",dates)
    return v1.metrics(pl.DataFrame(trades).with_columns(pl.col("date").cast(pl.Date)),"KR_STOCK",dates)


def gate(m,min_trades):
    return v4.gate(m,min_trades)


def rank_key(m,name):
    return v4.rank_key(m,name)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    events,event_audit=prepare_events()
    raw,source=krv3.load_kr_extended()
    price=add_price_features(raw)
    base,groups=attach(events,price)
    dates=sorted(price["date"].drop_duplicates().tolist())
    train_dates=[d for d in dates if START<=d<TRAIN_END]
    cal_dates=[d for d in dates if TRAIN_END<=d<CAL_END]
    val_dates=[d for d in dates if CAL_END<=d<VAL_END]
    oos_dates=[d for d in dates if VAL_END<=d<OOS_END]

    reports={};grid=[]
    for family in sorted(base["family"].unique()):
        fam=base[base["family"]==family]
        for ret_min in RET_MINS:
            for rv in RVOL_MINS:
                for near in NEAR52_MINS:
                    filt=fam[(fam["eventDayReturn"]>=ret_min)&(fam["eventRvol"]>=rv)&(fam["near52"]>=near)]
                    for top_n in TOP_NS:
                        selected=rank_top(filt,top_n)
                        for target in TARGETS:
                            for stop in STOPS:
                                for hold in HOLDS:
                                    name=f"KR_PEAD_{family}_R{ret_min:.2f}_RV{rv:g}_N52{near:.2f}_TOP{top_n}_TP{int(target*100)}_SL{stop:g}_H{hold}"
                                    trades=[]
                                    for row in selected.itertuples(index=False):
                                        t=simulate(row,groups,target,stop,hold,name)
                                        if t is not None:trades.append(t)
                                    train=[t for t in trades if t["date"]<TRAIN_END]
                                    cal=[t for t in trades if TRAIN_END<=t["date"]<CAL_END]
                                    val=[t for t in trades if CAL_END<=t["date"]<VAL_END]
                                    oos=[t for t in trades if VAL_END<=t["date"]<OOS_END]
                                    mt=calc(train,train_dates);mc=calc(cal,cal_dates);mv=calc(val,val_dates);mo=calc(oos,oos_dates)
                                    gt,gc,gv,go=gate(mt,20),gate(mc,8),gate(mv,12),gate(mo,6)
                                    eligible=gt["pass"] and gc["pass"]
                                    reports[name]={"family":family,"train":mt,"calibration":mc,"validation":mv,"freshOos":mo,"trainGate":gt,"calibrationGate":gc,"validationGate":gv,"freshOosGate":go,"eligibleAfterCalibration":eligible,"trades":trades}
                                    grid.append({
                                        "candidate":name,"family":family,"eventReturnMin":ret_min,"rvolMin":rv,"near52Min":near,"topN":top_n,"target":target,"stop":stop,"hold":hold,
                                        "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainTrades":mt.get("tradeCount"),
                                        "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationTrades":mc.get("tradeCount"),
                                        "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                                        "freshOosPass":go["pass"],"freshOosReturn":mo.get("totalReturn"),"freshOosPF":mo.get("profitFactor"),"freshOosMDD":mo.get("mdd"),"freshOosPosMonthRate":mo.get("positiveMonthRate"),"freshOosTrades":mo.get("tradeCount"),
                                    })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val_pass=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    fresh_pass=[n for n in val_pass if reports[n]["freshOosGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected:
        pd.DataFrame(reports[selected]["trades"]).to_csv(out/"selected-ledger.csv",index=False)
    summary={
        "schemaVersion":1,"contract":"kr-earnings-pead-v5",
        "eventAudit":event_audit,"tradableEventRows":len(base),"candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),"validationPassCount":len(val_pass),"freshOosPassCount":len(fresh_pass),
        "validationPassCandidates":val_pass,"freshOosPassCandidates":fresh_pass,
        "selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,
        "source":source,
        "truthBoundary":{
            "allKrxSymbolsConsidered":True,
            "earningsFilingsOnly":True,
            "entryFirstTradingDayAfterFilingDate":True,
            "eventDayReactionUsedOnlyWhenFilingDateIsTradingDay":True,
            "filingTimeUnavailable":True,
            "eventDayReactionKnownBeforeNextDayEntry":True,
            "near52UsesPrior252DayHigh":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "freshOosExcludedFromSelection":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
