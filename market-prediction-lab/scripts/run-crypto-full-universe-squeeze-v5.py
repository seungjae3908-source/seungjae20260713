#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from huggingface_hub import snapshot_download

ROOT=Path(__file__).resolve().parents[2]

def load_module(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

lead=load_module("lead_v3","market-prediction-lab/scripts/run-crypto-full-universe-leadlag-v3.py")
v1=load_module("hunter_v1","market-prediction-lab/scripts/run-full-universe-3pct-hunter-causal-backtest-v1.py")

DATASET="rogerdehe/klines-binance"
TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()
OOS_END=pd.Timestamp("2026-08-01").date()
LOOKBACKS=(8,16)
COMP_MAX=(0.75,0.90)
RVOLS=(1.5,2.5)
TOP_NS=(5,10,20)
EXITS=(("TP3_SL1p5",0.03,0.015),("TP5_SL1p5",0.05,0.015))
HOLDS=(8,16,32)
COSTS={"CRYPTO_SPOT":0.0020,"CRYPTO_FUTURES":0.0012}


def feature_frame(x:pl.DataFrame,lookback:int):
    z=x.sort("date").with_columns([
        pl.col("high").shift(1).rolling_max(lookback,min_samples=lookback).alias("priorHigh"),
        pl.col("low").shift(1).rolling_min(lookback,min_samples=lookback).alias("priorLow"),
        pl.col("close").shift(1).alias("prevClose"),
        (pl.col("close")*pl.col("volume")).alias("dollar"),
    ])
    z=z.with_columns([
        ((pl.col("priorHigh")-pl.col("priorLow"))/pl.col("prevClose")).alias("priorRangePct"),
        pl.col("dollar").shift(1).rolling_mean(96,min_samples=48).alias("priorDollar96"),
    ])
    z=z.with_columns([
        pl.col("priorRangePct").shift(1).rolling_mean(96,min_samples=48).alias("rangeMean96"),
        (pl.col("dollar")/pl.col("priorDollar96")).alias("rvol"),
        ((pl.col("close")-pl.col("low"))/(pl.col("high")-pl.col("low")).replace(0,None)).alias("closeLoc"),
    ])
    return z.with_columns(
        (pl.col("priorRangePct")/pl.col("rangeMean96").replace(0,None)).alias("compression")
    )


def collect_signals(files,sub,market):
    rows=[]
    usable=0
    min_liq=300_000.0 if market=="CRYPTO_SPOT" else 750_000.0
    directions=["LONG","SHORT"] if market=="CRYPTO_FUTURES" else ["LONG"]
    for idx,p in enumerate(files,1):
        sym=lead.base_symbol(p,sub)
        if sym=="BTC" or not lead.allowed_symbol(sym):
            continue
        x=lead.load_15m(p)
        if x is None: continue
        usable+=1
        for lb in LOOKBACKS:
            z=feature_frame(x,lb).filter(
                (pl.col("priorDollar96")>=min_liq)
                &pl.col("compression").is_not_null()
                &pl.col("rvol").is_not_null()
            )
            for comp in COMP_MAX:
                for rv in RVOLS:
                    long_mask=(
                        (pl.col("compression")<=comp)
                        &(pl.col("rvol")>=rv)
                        &(pl.col("close")>=pl.col("priorHigh")*1.001)
                        &(pl.col("closeLoc")>=0.65)
                    )
                    s=z.filter(long_mask).select([
                        "date",pl.lit(sym).alias("symbol"),pl.lit("LONG").alias("direction"),
                        pl.lit(lb).alias("lookback"),pl.lit(comp).alias("compMax"),pl.lit(rv).alias("rvolMin"),
                        (pl.col("rvol")+(1.0-pl.col("compression"))*2+pl.col("closeLoc")).alias("score"),
                    ])
                    if s.height: rows.append(s)
                    if "SHORT" in directions:
                        short_mask=(
                            (pl.col("compression")<=comp)
                            &(pl.col("rvol")>=rv)
                            &(pl.col("close")<=pl.col("priorLow")*0.999)
                            &(pl.col("closeLoc")<=0.35)
                        )
                        q=z.filter(short_mask).select([
                            "date",pl.lit(sym).alias("symbol"),pl.lit("SHORT").alias("direction"),
                            pl.lit(lb).alias("lookback"),pl.lit(comp).alias("compMax"),pl.lit(rv).alias("rvolMin"),
                            (pl.col("rvol")+(1.0-pl.col("compression"))*2+(1.0-pl.col("closeLoc"))).alias("score"),
                        ])
                        if q.height: rows.append(q)
        if idx%50==0:
            print(json.dumps({"squeezeFiles":idx,"files":len(files),"usable":usable,"frames":len(rows),"market":market}),flush=True)
    if not rows:
        raise RuntimeError(f"SQUEEZE_NO_SIGNALS:{market}")
    return pl.concat(rows,how="vertical"),usable


def select_top(sig,top_n):
    return (
        sig.sort(["date","direction","lookback","compMax","rvolMin","score"],descending=[False,False,False,False,False,True])
        .group_by(["date","direction","lookback","compMax","rvolMin"],maintain_order=True)
        .head(top_n)
    )


def simulate_group(selected:pl.DataFrame,file_map:dict,sub:str,market:str,target:float,stop:float,hold:int,name:str):
    rows=[]
    cost=COSTS[market]
    for key,sig in selected.partition_by("symbol",as_dict=True).items():
        sym=key[0] if isinstance(key,tuple) else key
        p=file_map.get(str(sym))
        if p is None: continue
        x=lead.load_15m(p)
        if x is None: continue
        pdf=x.to_pandas()
        pdf["date"]=pd.to_datetime(pdf["date"],utc=True)
        imap={pd.Timestamp(t):i for i,t in enumerate(pdf["date"])}
        for r in sig.iter_rows(named=True):
            t=pd.Timestamp(r["date"]); i=imap.get(t)
            if i is None or i+1>=len(pdf): continue
            ei=i+1; entry=float(pdf["open"].iloc[ei])
            if entry<=0:continue
            end=min(len(pdf)-1,ei+hold-1)
            direction=str(r["direction"])
            exit_i=end; exit_px=float(pdf["close"].iloc[end]); reason="TIME"
            if direction=="LONG":
                tp=entry*(1+target);sl=entry*(1-stop)
                for j in range(ei,end+1):
                    if float(pdf["low"].iloc[j])<=sl:
                        exit_i=j;exit_px=sl;reason="STOP";break
                    if float(pdf["high"].iloc[j])>=tp:
                        exit_i=j;exit_px=tp;reason="TARGET";break
                gross=exit_px/entry-1
                mfe=float(pdf["high"].iloc[ei:end+1].max())/entry-1
                mae=1-float(pdf["low"].iloc[ei:end+1].min())/entry
            else:
                tp=entry*(1-target);sl=entry*(1+stop)
                for j in range(ei,end+1):
                    if float(pdf["high"].iloc[j])>=sl:
                        exit_i=j;exit_px=sl;reason="STOP";break
                    if float(pdf["low"].iloc[j])<=tp:
                        exit_i=j;exit_px=tp;reason="TARGET";break
                gross=1-exit_px/entry
                mfe=1-float(pdf["low"].iloc[ei:end+1].min())/entry
                mae=float(pdf["high"].iloc[ei:end+1].max())/entry-1
            rows.append({
                "market":market,"date":t.date(),"timestamp":t,"symbol":str(sym),"direction":direction,"candidate":name,
                "entryPrice":entry,"exitPrice":exit_px,"grossReturn":gross,"roundTripCost":cost,"netReturn":gross-cost,
                "MFE":mfe,"MAE":mae,"exitReason":reason,"exitTime":str(pdf["date"].iloc[exit_i])
            })
    return pd.DataFrame(rows)


def to_pl(pdf):
    if pdf.empty:return pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    return pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))


def calc(pdf,market,start,end):
    dates=[d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]
    return v1.metrics(to_pl(pdf),market,dates)


def splits(pdf,market):
    d=pd.to_datetime(pdf["date"]).dt.date if len(pdf) else pd.Series([],dtype=object)
    return {
        "train":calc(pdf[d<TRAIN_END] if len(pdf) else pdf,market,"2023-05-01","2024-10-01"),
        "calibration":calc(pdf[(d>=TRAIN_END)&(d<CAL_END)] if len(pdf) else pdf,market,"2024-10-01","2025-04-01"),
        "validation":calc(pdf[(d>=CAL_END)&(d<VAL_END)] if len(pdf) else pdf,market,"2025-04-01","2026-04-01"),
        "freshOos":calc(pdf[(d>=VAL_END)&(d<OOS_END)] if len(pdf) else pdf,market,"2026-04-01","2026-08-01"),
    }


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
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 1),name)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args();market=args.market
    sub=lead.market_cfg(market)[0]
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    folder=Path(snapshot_download(repo_id=DATASET,repo_type="dataset",allow_patterns=[f"{sub}/15m/*.parquet"]))/sub/"15m"
    files=sorted(folder.glob("*.parquet"))
    if len(files)<500:raise RuntimeError(f"SQUEEZE_TOO_FEW_FILES:{len(files)}")
    file_map={lead.base_symbol(p,sub):p for p in files if lead.allowed_symbol(lead.base_symbol(p,sub))}
    sig,usable=collect_signals(files,sub,market)

    reports={};grid=[];ledgers={}
    for direction in (["LONG","SHORT"] if market=="CRYPTO_FUTURES" else ["LONG"]):
        for lb in LOOKBACKS:
            for comp in COMP_MAX:
                for rv in RVOLS:
                    base_sig=sig.filter(
                        (pl.col("direction")==direction)&(pl.col("lookback")==lb)
                        &(pl.col("compMax")==comp)&(pl.col("rvolMin")==rv)
                    )
                    if base_sig.is_empty():continue
                    for top_n in TOP_NS:
                        selected=select_top(base_sig,top_n)
                        for exit_name,target,stop in EXITS:
                            for hold in HOLDS:
                                name=f"{direction}_SQ_L{lb}_C{comp:g}_RV{rv:g}_TOP{top_n}_{exit_name}_H{hold}"
                                pdf=simulate_group(selected,file_map,sub,market,target,stop,hold,name)
                                mm=splits(pdf,market)
                                gt,gc,gv,go=gate(mm["train"],100),gate(mm["calibration"],30),gate(mm["validation"],50),gate(mm["freshOos"],15)
                                eligible=gt["pass"] and gc["pass"]
                                reports[name]={**mm,"trainGate":gt,"calibrationGate":gc,"validationGate":gv,"freshOosGate":go,"eligibleAfterCalibration":eligible}
                                if eligible:ledgers[name]=pdf
                                grid.append({
                                    "candidate":name,"direction":direction,"lookback":lb,"compMax":comp,"rvolMin":rv,"topN":top_n,"exit":exit_name,"hold":hold,
                                    "trainPass":gt["pass"],"trainReturn":mm["train"].get("totalReturn"),"trainPF":mm["train"].get("profitFactor"),"trainMDD":mm["train"].get("mdd"),"trainPosMonthRate":mm["train"].get("positiveMonthRate"),"trainTrades":mm["train"].get("tradeCount"),
                                    "calibrationPass":gc["pass"],"calibrationReturn":mm["calibration"].get("totalReturn"),"calibrationPF":mm["calibration"].get("profitFactor"),"calibrationMDD":mm["calibration"].get("mdd"),"calibrationPosMonthRate":mm["calibration"].get("positiveMonthRate"),"calibrationTrades":mm["calibration"].get("tradeCount"),
                                    "validationPass":gv["pass"],"validationReturn":mm["validation"].get("totalReturn"),"validationPF":mm["validation"].get("profitFactor"),"validationMDD":mm["validation"].get("mdd"),"validationPosMonthRate":mm["validation"].get("positiveMonthRate"),"validationTrades":mm["validation"].get("tradeCount"),
                                    "freshOosPass":go["pass"],"freshOosReturn":mm["freshOos"].get("totalReturn"),"freshOosPF":mm["freshOos"].get("profitFactor"),"freshOosMDD":mm["freshOos"].get("mdd"),"freshOosPosMonthRate":mm["freshOos"].get("positiveMonthRate"),"freshOosTrades":mm["freshOos"].get("tradeCount"),
                                    "distinctSymbols":int(pdf["symbol"].nunique()) if len(pdf) else 0,
                                })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    fresh=[n for n in val if reports[n]["freshOosGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)
    summary={
        "schemaVersion":1,"contract":"crypto-full-universe-squeeze-v5","market":market,
        "source15mFiles":len(files),"usableDirectionalFiles":usable,"signalRows":sig.height,
        "candidateCount":len(reports),"eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(val),"freshOosPassCount":len(fresh),
        "validationPassCandidates":val,"freshOosPassCandidates":fresh,
        "selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "allAvailable15mPairsScanned":True,
            "topNAppliedAfterFullUniverseSignalScan":True,
            "signalUsesCompleted15mBar":True,
            "entryNext15mOpen":True,
            "stopFirstConservativeWithin15mBar":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "freshOosExcludedFromSelection":True,
            "profitabilityProven":False,"executionAuthority":"NONE",
        }
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
