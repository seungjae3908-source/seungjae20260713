#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from collections import defaultdict
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

flow=load_module("flow_v3","market-prediction-lab/scripts/run-full-universe-3pct-hunter-crypto-flow-v3.py")
lead=load_module("lead_v3","market-prediction-lab/scripts/run-crypto-full-universe-leadlag-v3.py")
v4=load_module("orderflow_v4","market-prediction-lab/scripts/run-crypto-full-universe-orderflow-v4.py")
v1=flow.v1

MARKET="CRYPTO_FUTURES"
DATASET="rogerdehe/klines-binance"
START=pd.Timestamp("2023-05-01",tz="UTC")
END=pd.Timestamp("2026-08-01",tz="UTC")
TOP_NS=(5,10,20)


def base_defs():
    out=[]
    for direction in ("LONG","SHORT"):
        for f in v4.FLOW_THRESHOLDS:
            for rv in v4.RVOL_THRESHOLDS:
                for ret in v4.RET_THRESHOLDS:
                    out.append((f"FLOW_TREND_{direction}_F{f:g}_RV{rv:g}_R{ret:g}","FLOW_TREND",direction,f,rv,ret))
        ratios=v4.TAKER_LONG if direction=="LONG" else v4.TAKER_SHORT
        for ratio in ratios:
            for rv in v4.RVOL_THRESHOLDS:
                out.append((f"FLOW_RECLAIM_{direction}_T{ratio:g}_RV{rv:g}","FLOW_RECLAIM",direction,ratio,rv,None))
    return out


def raw_signal(features:pl.DataFrame,family:str,direction:str,a:float,rv:float,ret):
    if direction=="LONG":
        if family=="FLOW_TREND":
            mask=(pl.col("flow4")>=a)&(pl.col("rvol")>=rv)&(pl.col("ret4")>=float(ret))&(pl.col("close")>pl.col("vwap96"))
            score=pl.col("flow4")*3+pl.col("rvol").clip(0,10)/10+pl.col("ret4").clip(-0.2,0.2)
        else:
            mask=(pl.col("takerRatio")>=a)&(pl.col("rvol")>=rv)&(pl.col("prevClose")<=pl.col("prevVwap"))&(pl.col("close")>pl.col("vwap96"))
            score=(pl.col("takerRatio")-0.5)*4+pl.col("rvol").clip(0,10)/10
    else:
        if family=="FLOW_TREND":
            mask=(pl.col("flow4")<=-a)&(pl.col("rvol")>=rv)&(pl.col("ret4")<=-float(ret))&(pl.col("close")<pl.col("vwap96"))
            score=(-pl.col("flow4"))*3+pl.col("rvol").clip(0,10)/10+(-pl.col("ret4")).clip(-0.2,0.2)
        else:
            mask=(pl.col("takerRatio")<=a)&(pl.col("rvol")>=rv)&(pl.col("prevClose")>=pl.col("prevVwap"))&(pl.col("close")<pl.col("vwap96"))
            score=(0.5-pl.col("takerRatio"))*4+pl.col("rvol").clip(0,10)/10
    x=features.filter(mask).with_columns(score.alias("score"))
    if x.is_empty():return x
    return (
        x.sort(["date","timestamp"])
        .group_by("date",maintain_order=True).head(1)
    )


def process_symbol(symbol:str,months:list[str],required_months:set[str]):
    frames=[]
    failed=[]
    usable_required=0
    for m in months:
        mm,ss,df,status=flow.fetch_month_symbol(MARKET,symbol,m)
        if df is not None and not df.empty:
            frames.append(df)
            if m in required_months:
                usable_required+=1
        else:
            failed.append({"month":m,"status":status,"required":m in required_months})
    if not frames:
        return symbol,None,None,{
            "required":len(required_months),"usableRequired":0,"failed":failed[:10]
        }
    raw=pd.concat(frames,ignore_index=True).sort_values("timestamp")
    try:
        feat_pd=flow.add_features(raw)
    except Exception as exc:
        return symbol,None,None,{
            "required":len(required_months),"usableRequired":usable_required,
            "failed":failed[:10],"featureError":repr(exc)
        }
    feat_pd=feat_pd[(feat_pd["timestamp"]>=START)&(feat_pd["timestamp"]<END)].copy()
    if feat_pd.empty:
        return symbol,None,None,{
            "required":len(required_months),"usableRequired":usable_required,"failed":failed[:10]
        }
    features=pl.from_pandas(feat_pd).with_columns([
        pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")),
        pl.col("date").cast(pl.Date),
    ])

    sig_frames=[]
    for key,family,direction,a,rv,ret in base_defs():
        s=raw_signal(features,family,direction,a,rv,ret)
        if s.is_empty():continue
        sig_frames.append(s.select([
            "timestamp","symbol","date","score","flow4","rvol","ret4","takerRatio","vwap96"
        ]).with_columns([
            pl.lit(key).alias("baseKey"),
            pl.lit(direction).alias("signalDirection"),
            pl.lit(family).alias("family"),
        ]))
    if not sig_frames:
        return symbol,None,None,{
            "required":len(required_months),"usableRequired":usable_required,"failed":failed[:10],
            "featureRows":len(feat_pd),"signals":0
        }
    sig=pl.concat(sig_frames,how="vertical")
    union=sig.select(["timestamp","symbol","date"]).unique().with_columns(pl.lit("UNION").alias("baseCandidate"))
    outcomes=flow.simulate_union(feat_pd,union,MARKET)
    return symbol,sig,outcomes,{
        "required":len(required_months),"usableRequired":usable_required,"failed":failed[:10],
        "featureRows":len(feat_pd),"signals":sig.height,"unionSignals":union.height
    }


def topn(sig:pl.DataFrame,key:str,n:int):
    x=sig.filter(pl.col("baseKey")==key)
    if x.is_empty():return x
    return (
        x.sort(["timestamp","score"],descending=[False,True])
        .group_by("timestamp",maintain_order=True).head(n)
    )


def dates(start,end):
    return [d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]


def metric(trades,start,end):
    a=pd.Timestamp(start).date();b=pd.Timestamp(end).date()
    sub=trades.filter((pl.col("date")>=pl.lit(a))&(pl.col("date")<pl.lit(b)))
    return v1.metrics(sub,MARKET,dates(start,end))


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
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    folder=Path(snapshot_download(
        repo_id=DATASET,repo_type="dataset",allow_patterns=["futures/15m/*.parquet"]
    ))/"futures"/"15m"
    files,required,tasks,screen=v4.discover_tasks(folder,"futures",MARKET)

    months_by_symbol=defaultdict(set)
    required_by_symbol=defaultdict(set)
    for m,s in tasks:months_by_symbol[s].add(m)
    for m,s in required:required_by_symbol[s].add(m)
    symbols=sorted(months_by_symbol)

    sigs=[];outs=[];audits=[]
    req_total=0;req_usable=0
    feature_rows=0
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futs={
            pool.submit(process_symbol,s,sorted(months_by_symbol[s]),required_by_symbol[s]):s
            for s in symbols
        }
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            s=futs[fut]
            try:
                sym,sig,oc,audit=fut.result()
            except Exception as exc:
                audits.append({"symbol":s,"error":repr(exc)})
                continue
            audit["symbol"]=sym
            audits.append(audit)
            req_total+=int(audit.get("required") or 0)
            req_usable+=int(audit.get("usableRequired") or 0)
            feature_rows+=int(audit.get("featureRows") or 0)
            if sig is not None and not sig.is_empty():sigs.append(sig)
            if oc is not None and not oc.is_empty():outs.append(oc)
            if idx%25==0 or idx==len(futs):
                print(json.dumps({
                    "streamSymbolsComplete":idx,"symbols":len(futs),
                    "requiredCoverage":req_usable/max(req_total,1),
                    "signalFrames":len(sigs),"outcomeFrames":len(outs),
                    "featureRowsProcessed":feature_rows,
                }),flush=True)
    req_cov=req_usable/max(req_total,1)
    if req_cov<0.95:
        raise RuntimeError(f"V41_REQUIRED_COVERAGE_LOW:{req_usable}/{req_total}")
    if not sigs or not outs:
        raise RuntimeError("V41_NO_SIGNAL_OR_OUTCOME_FRAMES")
    signals=pl.concat(sigs,how="vertical")
    outcomes=pl.concat(outs,how="vertical")

    grid=[];reports={};ledgers={}
    for key,family,direction,a,rv,ret in base_defs():
        for n in TOP_NS:
            sig=topn(signals,key,n)
            if sig.is_empty():continue
            for target in flow.TARGETS:
                for stop in flow.STOPS:
                    for hold in flow.HOLDS:
                        name=f"{key}_TOP{n}_TP{int(target*100)}_SL{stop:g}_H{hold}"
                        oc=outcomes.filter(
                            (pl.col("targetPct")==target)&(pl.col("stopPct")==stop)&(pl.col("holdBars")==hold)
                        )
                        joined=sig.join(oc,on=["timestamp","symbol"],how="inner")
                        if direction=="LONG":
                            trades=joined.with_columns([
                                pl.lit(MARKET).alias("market"),pl.lit("LONG").alias("direction"),pl.lit(name).alias("candidate"),
                                pl.col("timestamp").dt.date().alias("date"),pl.col("entryPrice"),
                                pl.col("longExitPrice").alias("exitPrice"),pl.col("longGross").alias("grossReturn"),pl.col("longNet").alias("netReturn"),
                                pl.col("longMFE").alias("MFE"),pl.col("longMAE").alias("MAE"),pl.col("longExitReason").alias("exitReason"),
                                pl.lit(flow.COSTS[MARKET]).alias("roundTripCost"),
                            ])
                        else:
                            trades=joined.with_columns([
                                pl.lit(MARKET).alias("market"),pl.lit("SHORT").alias("direction"),pl.lit(name).alias("candidate"),
                                pl.col("timestamp").dt.date().alias("date"),pl.col("entryPrice"),
                                pl.col("shortExitPrice").alias("exitPrice"),pl.col("shortGross").alias("grossReturn"),pl.col("shortNet").alias("netReturn"),
                                pl.col("shortMFE").alias("MFE"),pl.col("shortMAE").alias("MAE"),pl.col("shortExitReason").alias("exitReason"),
                                pl.lit(flow.COSTS[MARKET]).alias("roundTripCost"),
                            ])
                        mt=metric(trades,"2023-05-01","2024-10-01")
                        mc=metric(trades,"2024-10-01","2025-04-01")
                        mv=metric(trades,"2025-04-01","2026-04-01")
                        mo=metric(trades,"2026-04-01","2026-08-01")
                        gt,gc,gv,go=gate(mt,100),gate(mc,30),gate(mv,50),gate(mo,15)
                        eligible=gt["pass"] and gc["pass"]
                        reports[name]={
                            "direction":direction,"family":family,"topN":n,
                            "train":mt,"calibration":mc,"validation":mv,"freshOos":mo,
                            "trainGate":gt,"calibrationGate":gc,"validationGate":gv,"freshOosGate":go,
                            "eligibleAfterCalibration":eligible,
                        }
                        if eligible:ledgers[name]=trades
                        grid.append({
                            "candidate":name,"direction":direction,"family":family,"topN":n,
                            "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                            "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                            "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                            "freshOosPass":go["pass"],"freshOosReturn":mo.get("totalReturn"),"freshOosPF":mo.get("profitFactor"),"freshOosMDD":mo.get("mdd"),"freshOosPosMonthRate":mo.get("positiveMonthRate"),"freshOosTrades":mo.get("tradeCount"),
                            "distinctSymbols":trades.select("symbol").unique().height,
                        })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    fresh=[n for n in val if reports[n]["freshOosGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:
        ledgers[selected].select([
            "market","date","timestamp","symbol","direction","candidate","entryPrice","exitPrice",
            "grossReturn","roundTripCost","netReturn","MFE","MAE","exitReason",
            "flow4","rvol","ret4","takerRatio","vwap96"
        ]).write_csv(out/"selected-ledger.csv")

    summary={
        "schemaVersion":1,"contract":"crypto-futures-orderflow-v41-streaming",
        "stageAScreen":screen,
        "symbolsProcessed":len(symbols),"requiredCoverage":req_cov,
        "featureRowsProcessedStreaming":feature_rows,
        "signalRows":signals.height,"outcomeRows":outcomes.height,
        "candidateCount":len(reports),"eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(val),"freshOosPassCount":len(fresh),
        "validationPassCandidates":val,"freshOosPassCandidates":fresh,
        "selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,
        "symbolAuditFailurePreview":[x for x in audits if x.get("error") or x.get("featureError")][:30],
        "truthBoundary":{
            "allAvailableFutures15mPairsScannedInStageA":True,
            "microstructureProcessedPerSymbolAndReleased":True,
            "noFullUniverseFeatureFrameHeldInMemory":True,
            "stageAMonthScreenCanOmitMicrostructureOnlySignals":True,
            "takerAndFlowUseBinancePublicMonthlyKlineArchives":True,
            "signalUsesCompleted15mBar":True,"entryNext15mOpen":True,
            "stopFirstConservativeWithin15mBar":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,"freshOosExcludedFromSelection":True,
            "profitabilityProven":False,"executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
