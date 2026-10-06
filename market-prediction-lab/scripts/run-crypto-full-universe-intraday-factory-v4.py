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
V1_SCRIPT=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC=importlib.util.spec_from_file_location("hunter_v1",V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v1)

DATASET="rogerdehe/klines-binance"
START=pd.Timestamp("2023-04-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01",tz="UTC")
CAL_END=pd.Timestamp("2025-04-01",tz="UTC")
VAL_END=pd.Timestamp("2026-04-01",tz="UTC")
OOS_END=pd.Timestamp("2026-10-01",tz="UTC")
TOP_NS=(5,10,20)
HOLDS=(4,8,16)
TARGETS=(0.03,0.05)
STOP=0.015
COSTS={"CRYPTO_SPOT":0.0020,"CRYPTO_FUTURES":0.0012}
STABLE_OR_NONDIR={"USDC","BUSD","TUSD","FDUSD","USDP","DAI","USDS","UST","USTC","EUR","EURT","AEUR","PAX","PAXG","WBTC","WBETH"}


def market_cfg(market):
    return ("spot",["LONG"]) if market=="CRYPTO_SPOT" else ("futures",["LONG","SHORT"])


def base_symbol(path:Path,sub:str):
    name=path.stem
    return name[:-5] if sub=="spot" and name.endswith("_USDT") else (name[:-10] if sub=="futures" and name.endswith("_USDT_USDT") else name)


def allowed_symbol(sym:str):
    u=sym.upper()
    return u not in STABLE_OR_NONDIR and not u.endswith(("UP","DOWN","BULL","BEAR"))


def load_file(path:Path):
    try:
        x=pl.read_parquet(path,columns=["date","open","high","low","close","volume"])
    except Exception:
        return None
    if x.is_empty():return None
    return (
        x.with_columns([
            pl.col("date").cast(pl.Datetime(time_zone="UTC")),
            pl.col("open").cast(pl.Float64),pl.col("high").cast(pl.Float64),
            pl.col("low").cast(pl.Float64),pl.col("close").cast(pl.Float64),
            pl.col("volume").cast(pl.Float64),
        ])
        .filter((pl.col("date")>=pl.lit(START))&(pl.col("date")<pl.lit(OOS_END))&(pl.col("open")>0)&(pl.col("close")>0))
        .sort("date")
    )


def features(x:pl.DataFrame):
    y=x.with_columns(
        (pl.col("close")*pl.col("volume")).alias("dollar")
    )
    y=y.with_columns([
        pl.col("high").shift(1).rolling_max(16,min_samples=8).alias("priorHigh16"),
        pl.col("low").shift(1).rolling_min(16,min_samples=8).alias("priorLow16"),
        pl.col("high").shift(1).rolling_max(8,min_samples=4).alias("priorHigh8"),
        pl.col("low").shift(1).rolling_min(8,min_samples=4).alias("priorLow8"),
        pl.col("close").shift(4).alias("close4"),
        pl.col("close").shift(8).alias("close8"),
        pl.col("close").shift(16).alias("close16"),
        pl.col("close").shift(1).alias("prevClose"),
        pl.col("volume").shift(1).rolling_mean(96,min_samples=48).alias("priorVol96"),
        pl.col("dollar").shift(1).rolling_sum(96,min_samples=48).alias("priorDollar24h"),
    ])
    y=y.with_columns([
        (pl.col("close")/pl.col("open")-1.0).alias("retBar"),
        (pl.col("close")/pl.col("close4")-1.0).alias("ret4"),
        (pl.col("close")/pl.col("close8")-1.0).alias("ret8"),
        (pl.col("close")/pl.col("close16")-1.0).alias("ret16"),
        (pl.col("volume")/pl.col("priorVol96")).alias("rvol"),
        ((pl.col("high")-pl.col("low"))/pl.col("open")).alias("rangePct"),
        ((pl.col("close")-pl.col("low"))/(pl.col("high")-pl.col("low")).replace(0,None)).alias("closeLoc"),
        ((pl.col("priorHigh8")-pl.col("priorLow8"))/pl.col("prevClose")).alias("priorRange8"),
    ])
    y=y.with_columns([
        (pl.col("close")*pl.col("volume")).rolling_sum(32,min_samples=8).truediv(
            pl.col("volume").rolling_sum(32,min_samples=8).replace(0,None)
        ).alias("vwap32"),
        (pl.col("ret4")-pl.col("ret16")*0.25).alias("waveAccel"),
    ])
    return y.drop_nulls(["priorHigh16","priorLow16","ret4","ret8","ret16","rvol","priorDollar24h","closeLoc","priorRange8","vwap32"])


def defs(direction):
    if direction=="LONG":
        return [
            ("MOM_CONT", (pl.col("ret4")>=0.025)&(pl.col("rvol")>=1.5)&(pl.col("closeLoc")>=0.70), pl.col("ret4")+pl.col("rvol")*0.003),
            ("VOL_BREAK", (pl.col("close")>pl.col("priorHigh16"))&(pl.col("rvol")>=2.0)&(pl.col("retBar")>0), (pl.col("close")/pl.col("priorHigh16")-1.0)+pl.col("rvol")*0.003),
            ("COMP_EXP", (pl.col("priorRange8")<=0.025)&(pl.col("close")>pl.col("priorHigh8"))&(pl.col("rvol")>=1.5), (0.03-pl.col("priorRange8"))+pl.col("rvol")*0.003),
            ("PULLBACK_RECLAIM", (pl.col("ret16")>=0.05)&(pl.col("ret4")<=-0.01)&(pl.col("ret4")>=-0.06)&(pl.col("close")>pl.col("vwap32"))&(pl.col("retBar")>0), pl.col("ret16")-pl.col("ret4")),
            ("REVERSAL", (pl.col("ret4")<=-0.05)&(pl.col("rvol")>=1.8)&(pl.col("closeLoc")>=0.75)&(pl.col("retBar")>0), -pl.col("ret4")+pl.col("rvol")*0.002),
            ("WAVE_ACCEL", (pl.col("waveAccel")>=0.025)&(pl.col("retBar")>0)&(pl.col("rvol")>=1.2), pl.col("waveAccel")+pl.col("rvol")*0.002),
        ]
    return [
        ("MOM_CONT", (pl.col("ret4")<=-0.025)&(pl.col("rvol")>=1.5)&(pl.col("closeLoc")<=0.30), -pl.col("ret4")+pl.col("rvol")*0.003),
        ("VOL_BREAK", (pl.col("close")<pl.col("priorLow16"))&(pl.col("rvol")>=2.0)&(pl.col("retBar")<0), (pl.col("priorLow16")/pl.col("close")-1.0)+pl.col("rvol")*0.003),
        ("COMP_EXP", (pl.col("priorRange8")<=0.025)&(pl.col("close")<pl.col("priorLow8"))&(pl.col("rvol")>=1.5), (0.03-pl.col("priorRange8"))+pl.col("rvol")*0.003),
        ("BOUNCE_REJECT", (pl.col("ret16")<=-0.05)&(pl.col("ret4")>=0.01)&(pl.col("ret4")<=0.06)&(pl.col("close")<pl.col("vwap32"))&(pl.col("retBar")<0), -pl.col("ret16")+pl.col("ret4")),
        ("REVERSAL", (pl.col("ret4")>=0.05)&(pl.col("rvol")>=1.8)&(pl.col("closeLoc")<=0.25)&(pl.col("retBar")<0), pl.col("ret4")+pl.col("rvol")*0.002),
        ("WAVE_ACCEL", (pl.col("waveAccel")<=-0.025)&(pl.col("retBar")<0)&(pl.col("rvol")>=1.2), -pl.col("waveAccel")+pl.col("rvol")*0.002),
    ]


def simulate_one(pdf:pd.DataFrame,i:int,direction:str,target:float,hold:int,cost:float):
    if i+1>=len(pdf):return None
    entry_i=i+1
    entry=float(pdf["open"].iloc[entry_i])
    if entry<=0:return None
    end_i=min(len(pdf)-1,entry_i+hold-1)
    exit_i=end_i;exit_px=float(pdf["close"].iloc[end_i]);reason="TIME"
    if direction=="LONG":
        tp=entry*(1+target);sl=entry*(1-STOP)
        for j in range(entry_i,end_i+1):
            if float(pdf["low"].iloc[j])<=sl:
                exit_i=j;exit_px=sl;reason="STOP";break
            if float(pdf["high"].iloc[j])>=tp:
                exit_i=j;exit_px=tp;reason="TARGET";break
        gross=exit_px/entry-1.0
        mfe=float(pdf["high"].iloc[entry_i:end_i+1].max())/entry-1.0
        mae=1.0-float(pdf["low"].iloc[entry_i:end_i+1].min())/entry
    else:
        tp=entry*(1-target);sl=entry*(1+STOP)
        for j in range(entry_i,end_i+1):
            if float(pdf["high"].iloc[j])>=sl:
                exit_i=j;exit_px=sl;reason="STOP";break
            if float(pdf["low"].iloc[j])<=tp:
                exit_i=j;exit_px=tp;reason="TARGET";break
        gross=1.0-exit_px/entry
        mfe=1.0-float(pdf["low"].iloc[entry_i:end_i+1].min())/entry
        mae=float(pdf["high"].iloc[entry_i:end_i+1].max())/entry-1.0
    return {
        "entryPrice":entry,"exitPrice":exit_px,"grossReturn":gross,"roundTripCost":cost,"netReturn":gross-cost,
        "MFE":mfe,"MAE":mae,"exitReason":reason,"exitTime":str(pdf["date"].iloc[exit_i])
    }


def scan(files,sub,market):
    rows=[]
    source={"plannedFiles":len(files),"usableFiles":0,"failedFiles":0,"failurePreview":[]}
    min_liq=5_000_000 if market=="CRYPTO_SPOT" else 10_000_000
    directions=market_cfg(market)[1]
    cost=COSTS[market]
    for idx,p in enumerate(files,1):
        sym=base_symbol(p,sub)
        if not allowed_symbol(sym):continue
        x=load_file(p)
        if x is None or x.is_empty():
            source["failedFiles"]+=1
            if len(source["failurePreview"])<30:source["failurePreview"].append({"symbol":sym,"error":"NO_ROWS"})
            continue
        source["usableFiles"]+=1
        f=features(x).filter(pl.col("priorDollar24h")>=min_liq)
        if f.is_empty():continue
        pdf=x.to_pandas()
        pdf["date"]=pd.to_datetime(pdf["date"],utc=True)
        idxmap={pd.Timestamp(t):i for i,t in enumerate(pdf["date"])}
        for direction in directions:
            for family,mask,score in defs(direction):
                sig=f.filter(mask).with_columns(score.alias("score"))
                for r in sig.select(["date","score","retBar","ret4","ret8","ret16","rvol","priorDollar24h","priorRange8","waveAccel","closeLoc"]).iter_rows(named=True):
                    i=idxmap.get(pd.Timestamp(r["date"]))
                    if i is None:continue
                    for target in TARGETS:
                        for hold in HOLDS:
                            res=simulate_one(pdf,i,direction,target,hold,cost)
                            if res is None:continue
                            rows.append({
                                "market":market,"timestamp":pd.Timestamp(r["date"]),"date":pd.Timestamp(r["date"]).date(),
                                "symbol":sym,"direction":direction,"family":family,"score":float(r["score"]),
                                "targetPct":target,"stopPct":STOP,"holdBars":hold,
                                "retBar":r["retBar"],"ret4":r["ret4"],"ret8":r["ret8"],"ret16":r["ret16"],
                                "rvol":r["rvol"],"priorDollar24h":r["priorDollar24h"],"priorRange8":r["priorRange8"],
                                "waveAccel":r["waveAccel"],"closeLoc":r["closeLoc"],**res
                            })
        if idx%50==0:
            print(json.dumps({"intradayFactoryFiles":idx,"files":len(files),"usable":source["usableFiles"],"rows":len(rows),"market":market}),flush=True)
    if not rows:raise RuntimeError(f"NO_INTRADAY_FACTORY_ROWS:{market}")
    return pd.DataFrame(rows),source


def to_pl(pdf):
    if pdf.empty:return pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    return pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))


def calc(pdf,market,start,end):
    d=pd.to_datetime(pdf["date"]).dt.date if len(pdf) else pd.Series([],dtype=object)
    sub=pdf[(d>=pd.Timestamp(start).date())&(d<pd.Timestamp(end).date())] if len(pdf) else pdf
    dates=[x.date() for x in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]
    return v1.metrics(to_pl(sub),market,dates)


def gate(m,min_trades):
    checks={"positiveReturn":float(m.get("totalReturn") or 0)>0,"profitFactorAbove1":float(m.get("profitFactor") or 0)>1.0,
            "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,"mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
            "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades}
    return {"pass":all(checks.values()),"checks":checks}


def main():
    ap=argparse.ArgumentParser();ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"]);ap.add_argument("--out-dir",required=True)
    args=ap.parse_args();market=args.market;sub,_=market_cfg(market);out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    folder=Path(snapshot_download(repo_id=DATASET,repo_type="dataset",allow_patterns=[f"{sub}/15m/*.parquet"]))/sub/"15m"
    files=sorted(folder.glob("*.parquet"))
    if len(files)<500:raise RuntimeError(f"TOO_FEW_15M_FILES:{market}:{len(files)}")
    raw,source=scan(files,sub,market)

    reports={};grid=[];ledgers={}
    for direction in sorted(raw["direction"].unique()):
        for family in sorted(raw[raw["direction"]==direction]["family"].unique()):
            base_rows=raw[(raw["direction"]==direction)&(raw["family"]==family)]
            for target in TARGETS:
                for hold in HOLDS:
                    pool=base_rows[(base_rows["targetPct"]==target)&(base_rows["holdBars"]==hold)].copy()
                    for top_n in TOP_NS:
                        selected=(pool.sort_values(["timestamp","score","priorDollar24h"],ascending=[True,False,False]).groupby("timestamp",group_keys=False).head(top_n))
                        name=f"{direction}_{family}_TOP{top_n}_TP{int(target*100)}_H{hold}"
                        selected["candidate"]=name
                        mt=calc(selected,market,"2023-04-01","2024-10-01");mc=calc(selected,market,"2024-10-01","2025-04-01");mv=calc(selected,market,"2025-04-01","2026-04-01");mo=calc(selected,market,"2026-04-01","2026-10-01")
                        gt,gc,gv,go=gate(mt,100),gate(mc,30),gate(mv,50),gate(mo,15)
                        eligible=gt["pass"] and gc["pass"]
                        reports[name]={"direction":direction,"family":family,"train":mt,"calibration":mc,"validation":mv,"freshOos":mo,
                                       "trainGate":gt,"calibrationGate":gc,"validationGate":gv,"freshOosGate":go,"eligibleAfterCalibration":eligible}
                        if eligible:ledgers[name]=selected
                        grid.append({"candidate":name,"direction":direction,"family":family,"topN":top_n,"target":target,"hold":hold,
                                     "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainTrades":mt.get("tradeCount"),
                                     "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                                     "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                                     "freshOosPass":go["pass"],"freshOosReturn":mo.get("totalReturn"),"freshOosPF":mo.get("profitFactor"),"freshOosMDD":mo.get("mdd"),"freshOosPosMonthRate":mo.get("positiveMonthRate"),"freshOosTrades":mo.get("tradeCount"),
                                     "distinctSymbols":int(selected["symbol"].nunique()),"activeTimes":int(selected["timestamp"].nunique())})
    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    valpass=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    fullpass=[n for n in valpass if reports[n]["freshOosGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:(reports[n]["calibration"].get("positiveMonthRate") or 0,reports[n]["calibration"].get("totalReturn") or 0,reports[n]["calibration"].get("profitFactor") or 0,n),reverse=True)[0] if eligible else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)
    summary={"schemaVersion":1,"contract":"crypto-full-universe-intraday-factory-v4","market":market,"source15mFiles":len(files),"sourceAudit":source,
             "rawSignalOutcomeRows":len(raw),"candidateCount":len(reports),"eligibleAfterCalibrationCount":len(eligible),"validationPassCount":len(valpass),"freshOosPassCount":len(fullpass),
             "validationPassCandidates":valpass,"freshOosPassCandidates":fullpass,"selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,
             "truthBoundary":{"allAvailable15mPairsScanned":True,"topNAppliedOnlyAfterFullUniverseSignalScan":True,"signalUsesCompleted15mBar":True,"entryNext15mOpen":True,
                              "stopFirstConservative":True,"candidateSelectionUsesTrainAndCalibrationOnly":True,"validationExcludedFromSelection":True,"freshOosExcludedFromSelection":True,
                              "profitabilityProven":False,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":main()
