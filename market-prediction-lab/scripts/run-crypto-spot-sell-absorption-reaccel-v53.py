#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from huggingface_hub import snapshot_download

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

flow=load(
    "flow_v3",
    "market-prediction-lab/scripts/run-full-universe-3pct-hunter-crypto-flow-v3.py",
)
lead=load(
    "lead_v3",
    "market-prediction-lab/scripts/run-crypto-full-universe-leadlag-v3.py",
)
v1=flow.v1

DATASET="rogerdehe/klines-binance"
MARKET="CRYPTO_SPOT"
SUB="spot"
START=pd.Timestamp("2023-05-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()
OOS_END=pd.Timestamp("2026-08-01").date()
TARGETS=(0.03,0.05)
HOLDS=(8,16,32)
STOP=0.015
COST=flow.COSTS[MARKET]
TOP_NS=(5,10,20)
MAX_WORKERS=10

# Fixed structural contract chosen before seeing this family's outcomes.
PREV_SELL_FLOW=-0.10
PREV_RVOL=1.25
PREV_RET_FLOOR=-0.0075
PREV_CLOSE_LOC=0.40
FLIP_FLOW=0.05
FLIP_TAKER=0.525
CURRENT_RVOL=1.20

def previous_month(m:str)->str:
    return str(pd.Period(m,freq="M")-1)

def stage_a(path:Path):
    x=lead.load_15m(path)
    if x is None or x.height<100:
        return set()
    z=(
        x.with_columns((pl.col("close")*pl.col("volume")).alias("dollar"))
         .with_columns([
            pl.col("dollar").shift(1).rolling_mean(96,min_samples=48).alias("priorDollar96"),
            pl.col("date").dt.strftime("%Y-%m").alias("month"),
         ])
         .with_columns(
            (pl.col("dollar")/pl.col("priorDollar96")).alias("rvolProxy")
         )
    )
    hit=z.filter(
        (pl.col("priorDollar96")>=300_000)
        &(pl.col("rvolProxy")>=1.10)
    )
    return set(hit["month"].unique().to_list()) if hit.height else set()

def fetch_symbol(symbol:str,months:list[str]):
    frames=[];failed=[]
    for m in months:
        _,_,df,status=flow.fetch_month_symbol(MARKET,f"{symbol}USDT",m)
        if df is not None and not df.empty:
            frames.append(df)
        else:
            failed.append({"month":m,"status":status})
    if not frames:
        return None,failed
    raw=pd.concat(frames,ignore_index=True).sort_values("timestamp")
    return raw,failed

def prepare_features(raw:pd.DataFrame):
    x=flow.add_features(raw).sort_values(["symbol","timestamp"]).copy()
    q=pd.to_numeric(x["quote_volume"],errors="coerce")
    delta=pd.to_numeric(x["deltaQuote"],errors="coerce")
    x["flow1"]=np.where(q>0,delta/q,np.nan)
    rng=(pd.to_numeric(x["high"],errors="coerce")-pd.to_numeric(x["low"],errors="coerce"))
    x["retBar"]=pd.to_numeric(x["close"],errors="coerce")/pd.to_numeric(x["open"],errors="coerce")-1.0
    x["closeLoc"]=(pd.to_numeric(x["close"],errors="coerce")-pd.to_numeric(x["low"],errors="coerce"))/rng.replace(0,np.nan)
    x["prevFlow1"]=x.groupby("symbol",sort=False)["flow1"].shift(1)
    x["prevRvol"]=x.groupby("symbol",sort=False)["rvol"].shift(1)
    x["prevRetBar"]=x.groupby("symbol",sort=False)["retBar"].shift(1)
    x["prevCloseLoc"]=x.groupby("symbol",sort=False)["closeLoc"].shift(1)
    x["prevHigh"]=x.groupby("symbol",sort=False)["high"].shift(1)
    prior_taker=(
        x.groupby("symbol",sort=False)["takerRatio"]
         .shift(1).rolling(8,min_periods=4).mean()
    )
    x["takerAccel"]=x["takerRatio"]-prior_taker
    return x.replace([np.inf,-np.inf],np.nan)

def signal_rows(feat:pd.DataFrame,symbol:str):
    mask=(
        (feat["prevFlow1"]<=PREV_SELL_FLOW)
        &(feat["prevRvol"]>=PREV_RVOL)
        &(feat["prevRetBar"]>=PREV_RET_FLOOR)
        &(feat["prevCloseLoc"]>=PREV_CLOSE_LOC)
        &(feat["flow1"]>=FLIP_FLOW)
        &(feat["takerRatio"]>=FLIP_TAKER)
        &(feat["rvol"]>=CURRENT_RVOL)
        &(feat["close"]>feat["prevClose"])
        &(feat["close"]>=feat["vwap96"]*0.998)
    )
    # Independent event onset: repeated consecutive true states are one opportunity.
    prev_mask=mask.shift(1).fillna(False)
    sig=feat.loc[mask & ~prev_mask].copy()
    if sig.empty:return sig
    sig["score"]=(
        (-sig["prevFlow1"])*2.0
        +sig["flow1"]*2.0
        +sig["takerAccel"].clip(lower=-0.5,upper=0.5)
        +sig["rvol"].clip(lower=0,upper=10)*0.05
        +(sig["close"]/sig["vwap96"]-1.0).clip(lower=-0.05,upper=0.05)
    )
    sig["baseSymbol"]=symbol
    return sig

def simulate(pdf:pd.DataFrame,i:int,target:float,hold:int):
    if i+1>=len(pdf):return None
    ei=i+1
    entry=float(pdf["open"].iloc[ei])
    if not np.isfinite(entry) or entry<=0:return None
    end=min(len(pdf)-1,ei+hold-1)
    highs=pdf["high"].iloc[ei:end+1].to_numpy(float)
    lows=pdf["low"].iloc[ei:end+1].to_numpy(float)
    closes=pdf["close"].iloc[ei:end+1].to_numpy(float)
    tp=entry*(1+target);sl=entry*(1-STOP)
    exit_px=float(closes[-1]);reason="TIME";exit_i=end
    for off,(hi,lo) in enumerate(zip(highs,lows)):
        j=ei+off
        if lo<=sl:
            exit_px=sl;reason="STOP";exit_i=j;break
        if hi>=tp:
            exit_px=tp;reason="TARGET";exit_i=j;break
    gross=exit_px/entry-1.0
    return {
        "entryPrice":entry,"exitPrice":exit_px,
        "grossReturn":gross,"netReturn":gross-COST,
        "MFE":float(np.max(highs))/entry-1.0,
        "MAE":1.0-float(np.min(lows))/entry,
        "exitReason":reason,
        "exitTime":pd.Timestamp(pdf["timestamp"].iloc[exit_i]),
    }

def process_symbol(path:Path):
    symbol=lead.base_symbol(path,SUB)
    if symbol=="BTC" or not lead.allowed_symbol(symbol):
        return [],{"symbol":symbol,"skipped":True}
    months=stage_a(path)
    required={m for m in months if "2023-05"<=m<"2026-08"}
    context={previous_month(m) for m in required if previous_month(m)>="2023-04"}
    tasks=sorted(required|context)
    if not tasks:
        return [],{"symbol":symbol,"ok":True,"requiredMonths":0,"signals":0}
    raw,failed=fetch_symbol(symbol,tasks)
    if raw is None:
        return [],{"symbol":symbol,"ok":False,"error":"NO_RAW","failures":failed[:10]}
    feat=prepare_features(raw)
    feat=feat[
        (feat["timestamp"]>=START)
        &(feat["timestamp"]<pd.Timestamp(OOS_END,tz="UTC"))
    ].copy()
    sig=signal_rows(feat,symbol)
    if sig.empty:
        return [],{
            "symbol":symbol,"ok":True,
            "requiredMonths":len(required),"rawRows":len(raw),"signals":0,
            "failures":failed[:10],
        }
    pdf=feat.sort_values("timestamp").reset_index(drop=True)
    imap={pd.Timestamp(t):i for i,t in enumerate(pdf["timestamp"])}
    rows=[]
    for r in sig.itertuples(index=False):
        ts=pd.Timestamp(r.timestamp)
        i=imap.get(ts)
        if i is None:continue
        for target in TARGETS:
            for hold in HOLDS:
                res=simulate(pdf,i,target,hold)
                if res is None:continue
                rows.append({
                    "market":MARKET,
                    "timestamp":ts,"date":ts.date(),
                    "symbol":symbol,"direction":"LONG",
                    "score":float(r.score),
                    "target":target,"hold":hold,
                    "prevFlow1":float(r.prevFlow1),
                    "prevRvol":float(r.prevRvol),
                    "prevRetBar":float(r.prevRetBar),
                    "flow1":float(r.flow1),
                    "takerRatio":float(r.takerRatio),
                    "takerAccel":float(r.takerAccel),
                    "rvol":float(r.rvol),
                    "vwapDist":float(r.close/r.vwap96-1.0),
                    **res,
                })
    return rows,{
        "symbol":symbol,"ok":True,
        "requiredMonths":len(required),
        "rawRows":int(len(raw)),
        "signals":int(len(sig)),
        "signalOutcomeRows":int(len(rows)),
        "failedFiles":len(failed),
        "failurePreview":failed[:10],
    }

def calc(pdf,start,end):
    if pdf.empty:
        p=pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64,"MFE":pl.Float64,"MAE":pl.Float64})
    else:
        p=pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))
    dates=[d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]
    return v1.metrics(p,MARKET,dates)

def split(pdf):
    d=pd.to_datetime(pdf["date"]).dt.date if len(pdf) else pd.Series([],dtype=object)
    return {
        "train":calc(pdf[d<TRAIN_END] if len(pdf) else pdf,"2023-05-01","2024-10-01"),
        "calibration":calc(pdf[(d>=TRAIN_END)&(d<CAL_END)] if len(pdf) else pdf,"2024-10-01","2025-04-01"),
        "validation":calc(pdf[(d>=CAL_END)&(d<VAL_END)] if len(pdf) else pdf,"2025-04-01","2026-04-01"),
        "freshOos":calc(pdf[(d>=VAL_END)&(d<OOS_END)] if len(pdf) else pdf,"2026-04-01","2026-08-01"),
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

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    folder=Path(snapshot_download(
        repo_id=DATASET,repo_type="dataset",
        allow_patterns=["spot/15m/*.parquet"],
    ))/"spot"/"15m"
    files=sorted(folder.glob("*.parquet"))
    if len(files)<500:
        raise RuntimeError(f"V53_TOO_FEW_FILES:{len(files)}")

    rows=[];audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={pool.submit(process_symbol,p):p for p in files}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            p=futs[fut]
            try:r,a=fut.result()
            except Exception as exc:
                r=[];a={"symbol":lead.base_symbol(p,SUB),"ok":False,"error":repr(exc)}
            rows.extend(r);audits.append(a)
            if idx%25==0 or idx==len(futs):
                print(json.dumps({
                    "absorptionSymbolsComplete":idx,
                    "symbols":len(futs),
                    "usable":sum(1 for x in audits if x.get("ok")),
                    "eventOutcomeRows":len(rows),
                }),flush=True)

    raw=pd.DataFrame(rows)
    if raw.empty:
        raise RuntimeError("V53_NO_ABSORPTION_EVENTS")
    raw.to_parquet(out/"all-event-outcomes.parquet",index=False)
    pd.DataFrame(audits).to_json(out/"source-audit.jsonl",orient="records",lines=True,force_ascii=False)

    reports={};grid=[];ledgers={}
    for target in TARGETS:
        for hold in HOLDS:
            pool=raw[(raw["target"]==target)&(raw["hold"]==hold)].copy()
            for topn in TOP_NS:
                selected=(
                    pool.sort_values(["timestamp","score","symbol"],ascending=[True,False,True])
                        .groupby("timestamp",group_keys=False).head(topn)
                        .reset_index(drop=True)
                )
                name=f"LONG_SELL_ABSORB_FLIP_TOP{topn}_TP{int(target*100)}_H{hold}"
                mm=split(selected)
                gt=gate(mm["train"],80)
                gc=gate(mm["calibration"],25)
                gv=gate(mm["validation"],40)
                go=gate(mm["freshOos"],12)
                eligible=gt["pass"] and gc["pass"]
                reports[name]={
                    **mm,
                    "trainGate":gt,"calibrationGate":gc,
                    "validationGate":gv,"freshOosGate":go,
                    "eligibleAfterCalibration":eligible,
                }
                if eligible:ledgers[name]=selected
                grid.append({
                    "candidate":name,"topN":topn,"target":target,"hold":hold,
                    "trainPass":gt["pass"],"trainReturn":mm["train"].get("totalReturn"),"trainPF":mm["train"].get("profitFactor"),"trainTrades":mm["train"].get("tradeCount"),
                    "calibrationPass":gc["pass"],"calibrationReturn":mm["calibration"].get("totalReturn"),"calibrationPF":mm["calibration"].get("profitFactor"),"calibrationTrades":mm["calibration"].get("tradeCount"),
                    "validationPass":gv["pass"],"validationReturn":mm["validation"].get("totalReturn"),"validationPF":mm["validation"].get("profitFactor"),"validationTrades":mm["validation"].get("tradeCount"),
                    "freshOosPass":go["pass"],"freshOosReturn":mm["freshOos"].get("totalReturn"),"freshOosPF":mm["freshOos"].get("profitFactor"),"freshOosTrades":mm["freshOos"].get("tradeCount"),
                    "distinctSymbols":int(selected["symbol"].nunique()) if len(selected) else 0,
                })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    fresh=[n for n in val if reports[n]["freshOosGate"]["pass"]]
    selected=max(
        eligible,
        key=lambda n:(
            float(reports[n]["calibration"].get("positiveMonthRate") or 0),
            float(reports[n]["calibration"].get("totalReturn") or 0),
            float(reports[n]["calibration"].get("profitFactor") or 0),
            n,
        ),
    ) if eligible else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)

    result={
        "schemaVersion":1,
        "contract":"crypto-spot-sell-absorption-reaccel-v53",
        "source15mFiles":len(files),
        "usableSymbols":sum(1 for x in audits if x.get("ok")),
        "eventOutcomeRows":int(len(raw)),
        "candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(val),
        "freshOosPassCount":len(fresh),
        "validationPassCandidates":val,
        "freshOosPassCandidates":fresh,
        "selectedByCalibration":selected,
        "selectedResults":reports.get(selected) if selected else None,
        "signalContract":{
            "priorAggressiveSellFlowAtMost":PREV_SELL_FLOW,
            "priorRvolAtLeast":PREV_RVOL,
            "priorReturnFloor":PREV_RET_FLOOR,
            "priorCloseLocationAtLeast":PREV_CLOSE_LOC,
            "currentFlowFlipAtLeast":FLIP_FLOW,
            "currentTakerRatioAtLeast":FLIP_TAKER,
            "currentRvolAtLeast":CURRENT_RVOL,
            "requiresCurrentCloseAbovePreviousClose":True,
            "requiresCurrentCloseAtOrAboveVwapTolerance":True,
            "independentEventOnsetOnly":True,
        },
        "truthBoundary":{
            "independentFamilyNotRetunedV43OrV52":True,
            "allAvailableSpotPairsScannedBeforeCrossSectionalTopN":True,
            "rawTakerBuyQuoteFromBinancePublicMonthlyArchives":True,
            "signalSequenceUsesCompletedBarsAndPastOnly":True,
            "entryNext15mOpen":True,
            "stopFirstConservativeWithin15mBar":True,
            "spotLongOnly":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "freshOosExcludedFromSelection":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
