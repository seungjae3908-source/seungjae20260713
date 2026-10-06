#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

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
START=pd.Timestamp("2023-04-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()
OOS_END=pd.Timestamp("2026-08-01").date()

OBS_BARS=(1,4,16)
MOM_THRESHOLDS=(0.00,0.03,0.05)
TARGETS=(0.03,0.05,0.10)
STOPS=(0.015,0.025)
HOLDS=(4,16,32)
COSTS={"CRYPTO_SPOT":0.0020,"CRYPTO_FUTURES":0.0012}


def event_rows(path:Path,sub:str,market:str):
    sym=lead.base_symbol(path,sub)
    if not lead.allowed_symbol(sym):
        return []
    try:
        raw=pl.read_parquet(path,columns=["date","open","high","low","close","volume"]).sort("date")
    except Exception:
        return []
    if raw.is_empty() or raw.height<64:
        return []
    raw=raw.with_columns([
        pl.col("date").cast(pl.Datetime(time_zone="UTC")),
        pl.col("open").cast(pl.Float64),
        pl.col("high").cast(pl.Float64),
        pl.col("low").cast(pl.Float64),
        pl.col("close").cast(pl.Float64),
        pl.col("volume").cast(pl.Float64),
    ]).filter((pl.col("open")>0)&(pl.col("close")>0))
    if raw.is_empty(): return []
    first=raw.get_column("date")[0]
    if not (START<=first<pd.Timestamp(OOS_END,tz="UTC")):
        return []
    pdf=raw.to_pandas()
    pdf["date"]=pd.to_datetime(pdf["date"],utc=True)
    rows=[]
    directions=["LONG","SHORT"] if market=="CRYPTO_FUTURES" else ["LONG"]
    for obs in OBS_BARS:
        if len(pdf)<=obs: continue
        start_open=float(pdf["open"].iloc[0])
        sig_close=float(pdf["close"].iloc[obs-1])
        move=sig_close/start_open-1.0
        entry_i=obs
        entry=float(pdf["open"].iloc[entry_i])
        if entry<=0:continue
        for direction in directions:
            for thr in MOM_THRESHOLDS:
                if direction=="LONG" and move<thr: continue
                if direction=="SHORT" and move>-thr: continue
                for target in TARGETS:
                    for stop in STOPS:
                        for hold in HOLDS:
                            end=min(len(pdf)-1,entry_i+hold-1)
                            exit_i=end
                            exit_px=float(pdf["close"].iloc[end])
                            reason="TIME"
                            if direction=="LONG":
                                tp=entry*(1+target);sl=entry*(1-stop)
                                for j in range(entry_i,end+1):
                                    if float(pdf["low"].iloc[j])<=sl:
                                        exit_i=j;exit_px=sl;reason="STOP";break
                                    if float(pdf["high"].iloc[j])>=tp:
                                        exit_i=j;exit_px=tp;reason="TARGET";break
                                gross=exit_px/entry-1.0
                                mfe=float(pdf["high"].iloc[entry_i:end+1].max())/entry-1.0
                                mae=1.0-float(pdf["low"].iloc[entry_i:end+1].min())/entry
                            else:
                                tp=entry*(1-target);sl=entry*(1+stop)
                                for j in range(entry_i,end+1):
                                    if float(pdf["high"].iloc[j])>=sl:
                                        exit_i=j;exit_px=sl;reason="STOP";break
                                    if float(pdf["low"].iloc[j])<=tp:
                                        exit_i=j;exit_px=tp;reason="TARGET";break
                                gross=1.0-exit_px/entry
                                mfe=1.0-float(pdf["low"].iloc[entry_i:end+1].min())/entry
                                mae=float(pdf["high"].iloc[entry_i:end+1].max())/entry-1.0
                            name=f"{direction}_LIST_OBS{obs}_M{thr:.2f}_TP{int(target*100)}_SL{stop:g}_H{hold}"
                            rows.append({
                                "market":market,"date":first.date(),"timestamp":first,"symbol":sym,
                                "direction":direction,"candidate":name,"obsBars":obs,"signalMove":move,
                                "targetPct":target,"stopPct":stop,"holdBars":hold,
                                "entryTime":str(pdf["date"].iloc[entry_i]),"exitTime":str(pdf["date"].iloc[exit_i]),
                                "entryPrice":entry,"exitPrice":exit_px,"grossReturn":gross,
                                "roundTripCost":COSTS[market],"netReturn":gross-COSTS[market],
                                "MFE":mfe,"MAE":mae,"exitReason":reason,
                            })
    return rows


def calc(pdf,market,start,end):
    dates=[d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]
    if pdf.empty:
        x=pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    else:
        x=pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))
    return v1.metrics(x,market,dates)


def split(pdf,market):
    d=pd.to_datetime(pdf["date"]).dt.date if len(pdf) else pd.Series([],dtype=object)
    return {
        "train":calc(pdf[d<TRAIN_END] if len(pdf) else pdf,market,"2023-04-01","2024-10-01"),
        "calibration":calc(pdf[(d>=TRAIN_END)&(d<CAL_END)] if len(pdf) else pdf,market,"2024-10-01","2025-04-01"),
        "validation":calc(pdf[(d>=CAL_END)&(d<VAL_END)] if len(pdf) else pdf,market,"2025-04-01","2026-04-01"),
        "freshOos":calc(pdf[(d>=VAL_END)&(d<OOS_END)] if len(pdf) else pdf,market,"2026-04-01","2026-08-01"),
    }


def gate(m,min_trades):
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,
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
    all_rows=[]
    listing_symbols=0
    for idx,p in enumerate(files,1):
        rows=event_rows(p,sub,market)
        if rows:
            listing_symbols+=1
            all_rows.extend(rows)
        if idx%50==0:
            print(json.dumps({"listingFiles":idx,"files":len(files),"listingSymbols":listing_symbols,"rows":len(all_rows),"market":market}),flush=True)
    if not all_rows:
        raise RuntimeError(f"NO_LISTING_EVENTS:{market}")
    trades=pd.DataFrame(all_rows)

    reports={};grid=[];ledgers={}
    for name,g in trades.groupby("candidate",sort=False):
        mm=split(g.copy(),market)
        gt,gc,gv,go=gate(mm["train"],20),gate(mm["calibration"],6),gate(mm["validation"],8),gate(mm["freshOos"],4)
        eligible=gt["pass"] and gc["pass"]
        reports[name]={**mm,"trainGate":gt,"calibrationGate":gc,"validationGate":gv,"freshOosGate":go,"eligibleAfterCalibration":eligible}
        if eligible:ledgers[name]=g.copy()
        first=g.iloc[0]
        grid.append({
            "candidate":name,"direction":first["direction"],"obsBars":first["obsBars"],
            "targetPct":first["targetPct"],"stopPct":first["stopPct"],"holdBars":first["holdBars"],
            "trainPass":gt["pass"],"trainReturn":mm["train"].get("totalReturn"),"trainPF":mm["train"].get("profitFactor"),"trainMDD":mm["train"].get("mdd"),"trainPosMonthRate":mm["train"].get("positiveMonthRate"),"trainTrades":mm["train"].get("tradeCount"),
            "calibrationPass":gc["pass"],"calibrationReturn":mm["calibration"].get("totalReturn"),"calibrationPF":mm["calibration"].get("profitFactor"),"calibrationMDD":mm["calibration"].get("mdd"),"calibrationPosMonthRate":mm["calibration"].get("positiveMonthRate"),"calibrationTrades":mm["calibration"].get("tradeCount"),
            "validationPass":gv["pass"],"validationReturn":mm["validation"].get("totalReturn"),"validationPF":mm["validation"].get("profitFactor"),"validationMDD":mm["validation"].get("mdd"),"validationPosMonthRate":mm["validation"].get("positiveMonthRate"),"validationTrades":mm["validation"].get("tradeCount"),
            "freshOosPass":go["pass"],"freshOosReturn":mm["freshOos"].get("totalReturn"),"freshOosPF":mm["freshOos"].get("profitFactor"),"freshOosMDD":mm["freshOos"].get("mdd"),"freshOosPosMonthRate":mm["freshOos"].get("positiveMonthRate"),"freshOosTrades":mm["freshOos"].get("tradeCount"),
        })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    fresh=[n for n in val if reports[n]["freshOosGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)
    summary={
        "schemaVersion":1,"contract":"crypto-listing-event-v6","market":market,
        "source15mFiles":len(files),"listingSymbolsInPeriod":listing_symbols,
        "tradeRowsAcrossConfigs":len(trades),"candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),"validationPassCount":len(val),"freshOosPassCount":len(fresh),
        "validationPassCandidates":val,"freshOosPassCandidates":fresh,
        "selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "firstFileTimestampUsedAsTradingStartProxy":True,
            "announcementTimeNotUsed":True,
            "onlyPairsWhoseFirstTimestampFallsInsideResearchPeriodIncluded":True,
            "signalUsesCompletedInitial15mBars":True,
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
