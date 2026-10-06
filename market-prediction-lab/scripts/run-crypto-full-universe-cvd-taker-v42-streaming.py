#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from collections import defaultdict
from pathlib import Path

import pandas as pd
import polars as pl
from huggingface_hub import snapshot_download

ROOT=Path(__file__).resolve().parents[2]

def load_module(name:str,rel:str):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

flow=load_module("flow_v3","market-prediction-lab/scripts/run-full-universe-3pct-hunter-crypto-flow-v3.py")
v4=load_module("flow_v4","market-prediction-lab/scripts/run-crypto-full-universe-flow-v4.py")
v1=flow.v1

DATASET=v4.DATASET
START=v4.START
TRAIN_END=v4.TRAIN_END
VALID_END=v4.VALID_END
OOS_END=v4.OOS_END
TOP_NS=v4.TOP_NS
TARGETS=v4.TARGETS
STOPS=v4.STOPS
HOLDS=v4.HOLDS
CVD_THRESHOLDS=v4.CVD_THRESHOLDS
TAKER_ACCEL_THRESHOLDS=v4.TAKER_ACCEL_THRESHOLDS
RVOL_THRESHOLDS=v4.RVOL_THRESHOLDS
COSTS=v4.COSTS

def base_defs(market:str):
    dirs=["LONG"] if market=="CRYPTO_SPOT" else ["LONG","SHORT"]
    rows=[]
    for direction in dirs:
        for cvd in CVD_THRESHOLDS:
            for rv in RVOL_THRESHOLDS:
                rows.append((f"CVD_LEAD_{direction}_C{cvd:g}_RV{rv:g}","CVD_LEAD",direction,cvd,rv))
        for acc in TAKER_ACCEL_THRESHOLDS:
            for rv in RVOL_THRESHOLDS:
                rows.append((f"TAKER_ACCEL_{direction}_A{acc:g}_RV{rv:g}","TAKER_ACCEL",direction,acc,rv))
    return rows

def raw_signal(features:pl.DataFrame,family:str,direction:str,a:float,rv:float):
    if family=="CVD_LEAD":
        if direction=="LONG":
            mask=(pl.col("cvd12")>=a)&(pl.col("rvol")>=rv)&(pl.col("ret12")<=0.03)
            score=pl.col("cvd12")*3+pl.col("rvol").clip(0,10)/10-pl.col("ret12").clip(-0.1,0.1)
        else:
            mask=(pl.col("cvd12")<=-a)&(pl.col("rvol")>=rv)&(pl.col("ret12")>=-0.03)
            score=(-pl.col("cvd12"))*3+pl.col("rvol").clip(0,10)/10+pl.col("ret12").clip(-0.1,0.1)
    else:
        if direction=="LONG":
            mask=(pl.col("takerAccel")>=a)&(pl.col("takerRatio")>=0.52)&(pl.col("rvol")>=rv)
            score=pl.col("takerAccel")*4+(pl.col("takerRatio")-0.5)*2+pl.col("rvol").clip(0,10)/10
        else:
            mask=(pl.col("takerAccel")<=-a)&(pl.col("takerRatio")<=0.48)&(pl.col("rvol")>=rv)
            score=(-pl.col("takerAccel"))*4+(0.5-pl.col("takerRatio"))*2+pl.col("rvol").clip(0,10)/10
    x=features.filter(mask).with_columns(score.alias("score"))
    if x.is_empty():
        return x
    return (
        x.sort(["date","symbol","timestamp"])
        .group_by(["date","symbol"],maintain_order=True).head(1)
    )

def process_symbol(market:str,symbol:str,months:list[str]):
    frames=[]
    failures=[]
    for month in months:
        mm,ss,df,status=flow.fetch_month_symbol(market,symbol,month)
        if df is not None and not df.empty:
            frames.append(df)
        else:
            failures.append({"month":month,"status":status})
    if not frames:
        return symbol,None,None,{"rawFiles":0,"failed":failures[:10]}

    raw=pd.concat(frames,ignore_index=True).sort_values("timestamp")
    try:
        feat_pd=v4.augment_features(raw)
    except Exception as exc:
        return symbol,None,None,{"rawFiles":len(frames),"featureError":repr(exc),"failed":failures[:10]}

    feat_pd=feat_pd[
        (feat_pd["timestamp"]>=START)
        &(feat_pd["timestamp"]<pd.Timestamp(OOS_END,tz="UTC"))
    ].copy()
    if feat_pd.empty:
        return symbol,None,None,{"rawFiles":len(frames),"failed":failures[:10]}

    features=pl.from_pandas(feat_pd).with_columns([
        pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")),
        pl.col("date").cast(pl.Date),
    ])

    sig_frames=[]
    for key,family,direction,a,rv in base_defs(market):
        s=raw_signal(features,family,direction,a,rv)
        if s.is_empty():
            continue
        sig_frames.append(
            s.select([
                "timestamp","symbol","date","score",
                "cvd12","ret12","takerAccel","takerRatio","rvol","flow4","ret4","vwap96",
            ]).with_columns([
                pl.lit(key).alias("baseKey"),
                pl.lit(family).alias("family"),
                pl.lit(direction).alias("signalDirection"),
            ])
        )
    if not sig_frames:
        return symbol,None,None,{
            "rawFiles":len(frames),"featureRows":len(feat_pd),"signals":0,"failed":failures[:10]
        }

    signals=pl.concat(sig_frames,how="vertical_relaxed")
    union=signals.select(["timestamp","symbol","date"]).unique().with_columns(
        pl.lit("UNION").alias("baseCandidate")
    )
    outcomes=flow.simulate_union(feat_pd,union,market)
    return symbol,signals,outcomes,{
        "rawFiles":len(frames),
        "featureRows":len(feat_pd),
        "signals":signals.height,
        "unionSignals":union.height,
        "failed":failures[:10],
    }

def topn(signals:pl.DataFrame,key:str,n:int):
    x=signals.filter(pl.col("baseKey")==key)
    if x.is_empty():
        return x
    return (
        x.sort(["timestamp","score"],descending=[False,True])
        .group_by("timestamp",maintain_order=True).head(n)
    )

def dates(start:str,end:str):
    return [x.date() for x in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]

def metric(trades:pl.DataFrame,market:str,start:str,end:str):
    a=pd.Timestamp(start).date()
    b=pd.Timestamp(end).date()
    sub=trades.filter((pl.col("date")>=pl.lit(a))&(pl.col("date")<pl.lit(b)))
    return v1.metrics(sub,market,dates(start,end))

def gate(m:dict,min_trades:int):
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1.0,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}

def rank_key(m:dict,name:str):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 1),
        int(m.get("tradeCount") or 0),
        name,
    )

def make_trades(joined:pl.DataFrame,market:str,direction:str,name:str):
    if direction=="LONG":
        return joined.with_columns([
            pl.lit(market).alias("market"),
            pl.lit("LONG").alias("direction"),
            pl.lit(name).alias("candidate"),
            pl.col("timestamp").dt.date().alias("date"),
            pl.col("entryPrice"),
            pl.col("longExitPrice").alias("exitPrice"),
            pl.col("longGross").alias("grossReturn"),
            pl.col("longNet").alias("netReturn"),
            pl.col("longMFE").alias("MFE"),
            pl.col("longMAE").alias("MAE"),
            pl.col("longExitReason").alias("exitReason"),
            pl.lit(COSTS[market]).alias("roundTripCost"),
        ])
    return joined.with_columns([
        pl.lit(market).alias("market"),
        pl.lit("SHORT").alias("direction"),
        pl.lit(name).alias("candidate"),
        pl.col("timestamp").dt.date().alias("date"),
        pl.col("entryPrice"),
        pl.col("shortExitPrice").alias("exitPrice"),
        pl.col("shortGross").alias("grossReturn"),
        pl.col("shortNet").alias("netReturn"),
        pl.col("shortMFE").alias("MFE"),
        pl.col("shortMAE").alias("MAE"),
        pl.col("shortExitReason").alias("exitReason"),
        pl.lit(COSTS[market]).alias("roundTripCost"),
    ])

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    out=Path(args.out_dir)
    out.mkdir(parents=True,exist_ok=True)
    sub,_=v4.market_cfg(market)

    folder=Path(snapshot_download(
        repo_id=DATASET,repo_type="dataset",allow_patterns=[f"{sub}/15m/*.parquet"]
    ))/sub/"15m"
    files,prescreen,tasks,prescreen_failures=v4.full_universe_prescreen(folder,sub)

    months_by_symbol=defaultdict(set)
    for r in tasks.iter_rows(named=True):
        months_by_symbol[str(r["symbol"])].add(str(r["month"]))
    symbols=sorted(months_by_symbol)

    signals_all=[]
    outcomes_all=[]
    audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futs={
            pool.submit(process_symbol,market,s,sorted(months_by_symbol[s])):s
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
            if sig is not None and not sig.is_empty():
                signals_all.append(sig)
            if oc is not None and not oc.is_empty():
                outcomes_all.append(oc)
            if idx%25==0 or idx==len(futs):
                print(json.dumps({
                    "streamSymbolsComplete":idx,
                    "symbols":len(futs),
                    "signalFrames":len(signals_all),
                    "outcomeFrames":len(outcomes_all),
                    "market":market,
                }),flush=True)

    if not signals_all or not outcomes_all:
        raise RuntimeError(f"CVD_TAKER_NO_SIGNALS_OR_OUTCOMES:{market}")
    signals=pl.concat(signals_all,how="vertical_relaxed")
    outcomes=pl.concat(outcomes_all,how="vertical_relaxed")

    reports={}
    grid=[]
    ledgers={}
    for key,family,direction,a,rv in base_defs(market):
        for n in TOP_NS:
            sig=topn(signals,key,n)
            if sig.is_empty():
                continue
            for target in TARGETS:
                for stop in STOPS:
                    for hold in HOLDS:
                        name=f"{key}_TOP{n}_TP{int(target*100)}_SL{stop:g}_H{hold}"
                        oc=outcomes.filter(
                            (pl.col("targetPct")==target)
                            &(pl.col("stopPct")==stop)
                            &(pl.col("holdBars")==hold)
                        )
                        joined=sig.join(oc,on=["timestamp","symbol"],how="inner")
                        trades=make_trades(joined,market,direction,name)

                        mt=metric(trades,market,"2023-05-01","2025-04-01")
                        mv=metric(trades,market,"2025-04-01","2026-04-01")
                        mo=metric(trades,market,"2026-04-01","2026-10-01")
                        gt=gate(mt,100)
                        gv=gate(mv,50)
                        go=gate(mo,25)
                        reports[name]={
                            "family":family,"direction":direction,"topN":n,
                            "train":mt,"validation":mv,"freshOos":mo,
                            "trainGate":gt,"validationGate":gv,"freshOosGate":go,
                        }
                        if gt["pass"] and gv["pass"]:
                            ledgers[name]=trades
                        grid.append({
                            "candidate":name,"family":family,"direction":direction,"topN":n,
                            "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),
                            "trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),
                            "trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                            "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),
                            "validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),
                            "validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                            "freshOosPass":go["pass"],"freshOosReturn":mo.get("totalReturn"),
                            "freshOosPF":mo.get("profitFactor"),"freshOosMDD":mo.get("mdd"),
                            "freshOosPosMonthRate":mo.get("positiveMonthRate"),"freshOosTrades":mo.get("tradeCount"),
                        })

    train_pass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    validation_pass=[n for n in train_pass if reports[n]["validationGate"]["pass"]]
    full_pass=[n for n in validation_pass if reports[n]["freshOosGate"]["pass"]]
    selected=max(
        validation_pass,
        key=lambda n:rank_key(reports[n]["validation"],n),
        default=None,
    )

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:
        ledgers[selected].write_csv(out/"selected-ledger.csv")

    source_feature_rows=sum(int(a.get("featureRows") or 0) for a in audits)
    source_signal_rows=sum(int(a.get("signals") or 0) for a in audits)
    result={
        "schemaVersion":1,
        "contract":"crypto-full-universe-cvd-taker-v42-streaming",
        "market":market,
        "source15mFiles":len(files),
        "prescreenRows":prescreen.height,
        "prescreenTaskRows":tasks.height,
        "symbolsProcessed":len(symbols),
        "featureRowsProcessedStreaming":source_feature_rows,
        "signalRowsBeforeCrossSectionalTopN":source_signal_rows,
        "candidateCount":len(reports),
        "trainPassCount":len(train_pass),
        "validationPassCount":len(validation_pass),
        "freshOosPassCount":len(full_pass),
        "validationPassCandidates":validation_pass,
        "freshOosPassCandidates":full_pass,
        "selectedByValidationDiagnostic":selected,
        "selectedResults":reports.get(selected) if selected else None,
        "audits":{
            "prescreenFailures":len(prescreen_failures),
            "symbolFailures":sum(1 for a in audits if a.get("error") or a.get("featureError")),
            "symbolFailurePreview":[a for a in audits if a.get("error") or a.get("featureError")][:30],
        },
        "truthBoundary":{
            "allAvailable15mPairsScannedInPrescreen":True,
            "onlyPreviouslyUntestedCvdLeadAndTakerAccelFamilies":True,
            "knownFailedFlowTrendAndReclaimFamiliesNotRepeated":True,
            "microstructureProcessedPerSymbolStreaming":True,
            "noFullRawUniverseFrameHeldInMemory":True,
            "rawTakerBuyQuoteFromBinancePublicMonthlyKlines":True,
            "signalUsesCompleted15mBars":True,
            "entryUsesNext15mOpen":True,
            "stopFirstConservativeWithin15mBar":True,
            "freshOosExcludedFromCandidateConstruction":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8"
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
