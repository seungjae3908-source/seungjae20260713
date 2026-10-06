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

def load_module(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

flow=load_module(
    "crypto_flow_v3",
    "market-prediction-lab/scripts/run-full-universe-3pct-hunter-crypto-flow-v3.py",
)
lead=load_module(
    "crypto_leadlag_v3",
    "market-prediction-lab/scripts/run-crypto-full-universe-leadlag-v3.py",
)
v1=flow.v1

DATASET="rogerdehe/klines-binance"
START=pd.Timestamp("2023-05-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()
OOS_END=pd.Timestamp("2026-08-01").date()

TOP_NS=(5,10,20)
FLOW_THRESHOLDS=(0.08,0.15)
RVOL_THRESHOLDS=(1.5,2.5)
RET_THRESHOLDS=(0.00,0.01)
TAKER_LONG=(0.55,0.60)
TAKER_SHORT=(0.45,0.40)

COSTS=flow.COSTS


def stage_a_months(path:Path,market:str):
    x=lead.load_15m(path)
    if x is None or x.height<100:
        return set()
    z=(
        x.with_columns([
            (pl.col("close")*pl.col("volume")).alias("dollarProxy"),
            (pl.col("close")/pl.col("close").shift(4)-1.0).alias("ret4Proxy"),
        ])
        .with_columns([
            pl.col("dollarProxy").shift(1).rolling_mean(96,min_samples=48).alias("priorDollar96"),
            (pl.col("close")*pl.col("volume")).rolling_sum(96,min_samples=48).alias("quoteProxy96"),
            pl.col("volume").rolling_sum(96,min_samples=48).alias("vol96"),
        ])
        .with_columns([
            (pl.col("dollarProxy")/pl.col("priorDollar96")).alias("rvolProxy"),
            (pl.col("quoteProxy96")/pl.col("vol96").replace(0,None)).alias("vwapProxy"),
        ])
        .with_columns([
            pl.col("close").shift(1).alias("prevCloseProxy"),
            pl.col("vwapProxy").shift(1).alias("prevVwapProxy"),
            pl.col("date").dt.strftime("%Y-%m").alias("month"),
        ])
    )
    min_liq=300_000.0 if market=="CRYPTO_SPOT" else 750_000.0
    common=(
        (pl.col("priorDollar96")>=min_liq)
        &(pl.col("rvolProxy")>=1.20)
        &pl.col("vwapProxy").is_not_null()
        &pl.col("prevVwapProxy").is_not_null()
    )
    long_broad=common & (
        ((pl.col("prevCloseProxy")<=pl.col("prevVwapProxy")*1.002)&(pl.col("close")>=pl.col("vwapProxy")*0.998))
        |((pl.col("ret4Proxy")>=-0.002)&(pl.col("close")>=pl.col("vwapProxy")))
    )
    if market=="CRYPTO_FUTURES":
        short_broad=common & (
            ((pl.col("prevCloseProxy")>=pl.col("prevVwapProxy")*0.998)&(pl.col("close")<=pl.col("vwapProxy")*1.002))
            |((pl.col("ret4Proxy")<=0.002)&(pl.col("close")<=pl.col("vwapProxy")))
        )
        hit=z.filter(long_broad|short_broad)
    else:
        hit=z.filter(long_broad)
    return set(hit.get_column("month").unique().to_list()) if hit.height else set()


def previous_month(m:str)->str:
    return str(pd.Period(m,freq="M")-1)


def discover_tasks(folder:Path,sub:str,market:str):
    files=sorted(folder.glob("*.parquet"))
    required=set()
    symbol_files=0
    screened=0
    failures=[]
    for idx,p in enumerate(files,1):
        sym=lead.base_symbol(p,sub)
        if sym=="BTC" or not lead.allowed_symbol(sym):
            continue
        symbol_files+=1
        try:
            months=stage_a_months(p,market)
        except Exception as exc:
            failures.append({"symbol":sym,"error":repr(exc)})
            continue
        if months:
            screened+=1
            binance_symbol=f"{sym}USDT"
            for m in months:
                if "2023-05"<=m<"2026-08":
                    required.add((m,binance_symbol))
        if idx%50==0:
            print(json.dumps({
                "orderflowStageAFiles":idx,"files":len(files),
                "eligibleSymbols":symbol_files,"symbolsWithCandidateMonths":screened,
                "requiredSymbolMonths":len(required),"market":market,
            }),flush=True)
    if not required:
        raise RuntimeError(f"ORDERFLOW_STAGE_A_EMPTY:{market}")
    context=set()
    for m,s in required:
        pm=previous_month(m)
        if pm>="2023-04":
            context.add((pm,s))
    tasks=sorted(required|context)
    return files,required,tasks,{
        "source15mFiles":len(files),
        "eligibleDirectionalSymbols":symbol_files,
        "symbolsWithCandidateMonths":screened,
        "requiredCandidateSymbolMonths":len(required),
        "contextPlusRequiredTasks":len(tasks),
        "stageAFailures":len(failures),
        "stageAFailurePreview":failures[:30],
    }


def download_microstructure(market:str,required:set,tasks:list):
    frames=[]
    failures=[]
    usable_required=set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=18) as pool:
        futs={pool.submit(flow.fetch_month_symbol,market,s,m):(m,s) for m,s in tasks}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            m,s=futs[fut]
            mm,ss,df,status=fut.result()
            if df is not None and not df.empty:
                frames.append(df)
                if (m,s) in required:
                    usable_required.add((m,s))
            else:
                failures.append({"month":m,"symbol":s,"status":status,"required":(m,s) in required})
            if idx%100==0 or idx==len(tasks):
                print(json.dumps({
                    "orderflowMicrostructureFiles":idx,"tasks":len(tasks),
                    "usableFiles":len(frames),"usableRequired":len(usable_required),
                    "failures":len(failures),"market":market,
                }),flush=True)
    req_cov=len(usable_required)/max(len(required),1)
    if req_cov<0.95:
        raise RuntimeError(f"ORDERFLOW_REQUIRED_COVERAGE_LOW:{market}:{len(usable_required)}/{len(required)}")
    if not frames:
        raise RuntimeError(f"ORDERFLOW_NO_MICROSTRUCTURE:{market}")
    raw=pd.concat(frames,ignore_index=True).sort_values(["symbol","timestamp"])
    feat=flow.add_features(raw)
    feat=feat[(feat["timestamp"]>=START)&(feat["timestamp"]<pd.Timestamp(OOS_END,tz="UTC"))].copy()
    if feat.empty:
        raise RuntimeError(f"ORDERFLOW_FEATURES_EMPTY:{market}")
    return feat,{
        "requestedTasks":len(tasks),
        "requiredTasks":len(required),
        "usableRequiredTasks":len(usable_required),
        "requiredCoverage":req_cov,
        "usableFiles":len(frames),
        "failedFiles":len(failures),
        "failurePreview":failures[:40],
    }


def definitions(features:pl.DataFrame,market:str):
    dirs=["LONG","SHORT"] if market=="CRYPTO_FUTURES" else ["LONG"]
    defs=[]
    signals={}
    for direction in dirs:
        for flow_thr in FLOW_THRESHOLDS:
            for rv in RVOL_THRESHOLDS:
                for ret in RET_THRESHOLDS:
                    for top_n in TOP_NS:
                        name=f"FLOW_TREND_{direction}_F{flow_thr:g}_RV{rv:g}_R{ret:g}_TOP{top_n}"
                        sig=flow.signal_frame(features,market,"FLOW_TREND",direction,flow_thr,rv,ret,top_n)
                        defs.append((name,"FLOW_TREND",direction,flow_thr,rv,ret,top_n))
                        signals[name]=sig
        ratios=TAKER_LONG if direction=="LONG" else TAKER_SHORT
        for ratio in ratios:
            for rv in RVOL_THRESHOLDS:
                for top_n in TOP_NS:
                    name=f"FLOW_RECLAIM_{direction}_T{ratio:g}_RV{rv:g}_TOP{top_n}"
                    sig=flow.signal_frame(features,market,"FLOW_RECLAIM",direction,ratio,rv,None,top_n)
                    defs.append((name,"FLOW_RECLAIM",direction,ratio,rv,None,top_n))
                    signals[name]=sig
    return defs,signals


def union_from(signals:dict):
    frames=[]
    for name,s in signals.items():
        if s is None or s.is_empty():
            continue
        frames.append(s.select(["timestamp","symbol","date"]).with_columns(pl.lit(name).alias("baseCandidate")))
    if not frames:
        raise RuntimeError("ORDERFLOW_NO_SIGNALS")
    return pl.concat(frames,how="vertical").unique(subset=["timestamp","symbol"])


def period_dates(start,end):
    return [d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]


def metric_period(trades,market,start,end):
    a=pd.Timestamp(start).date(); b=pd.Timestamp(end).date()
    sub=trades.filter((pl.col("date")>=pl.lit(a))&(pl.col("date")<pl.lit(b)))
    return v1.metrics(sub,market,period_dates(start,end))


def gate(m,min_trades):
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1.0,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def rank_key(m,name):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 1),
        int(m.get("tradeCount") or 0),
        name,
    )


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    sub=lead.market_cfg(market)[0]
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    folder=Path(snapshot_download(
        repo_id=DATASET,repo_type="dataset",
        allow_patterns=[f"{sub}/15m/*.parquet"],
    ))/sub/"15m"

    files,required,tasks,screen_audit=discover_tasks(folder,sub,market)
    feat_pd,micro_audit=download_microstructure(market,required,tasks)
    features=pl.from_pandas(feat_pd).with_columns([
        pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")),
        pl.col("date").cast(pl.Date),
    ])

    defs,signals=definitions(features,market)
    union=union_from(signals)
    outcomes=flow.simulate_union(feat_pd,union,market)

    grid=[]
    reports={}
    ledgers={}
    for key,family,direction,a,rv,ret,top_n in defs:
        sig=signals.get(key)
        if sig is None or sig.is_empty():
            continue
        for target in flow.TARGETS:
            for stop in flow.STOPS:
                for hold in flow.HOLDS:
                    name=f"{key}_TP{int(target*100)}_SL{stop:g}_H{hold}"
                    oc=outcomes.filter(
                        (pl.col("targetPct")==target)
                        &(pl.col("stopPct")==stop)
                        &(pl.col("holdBars")==hold)
                    )
                    joined=sig.join(oc,on=["timestamp","symbol"],how="inner")
                    if direction=="LONG":
                        trades=joined.with_columns([
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
                    else:
                        trades=joined.with_columns([
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

                    mt=metric_period(trades,market,"2023-05-01","2024-10-01")
                    mc=metric_period(trades,market,"2024-10-01","2025-04-01")
                    mv=metric_period(trades,market,"2025-04-01","2026-04-01")
                    mo=metric_period(trades,market,"2026-04-01","2026-08-01")
                    gt,gc,gv,go=gate(mt,100),gate(mc,30),gate(mv,50),gate(mo,15)
                    eligible=gt["pass"] and gc["pass"]
                    reports[name]={
                        "direction":direction,"family":family,"topN":top_n,
                        "train":mt,"calibration":mc,"validation":mv,"freshOos":mo,
                        "trainGate":gt,"calibrationGate":gc,"validationGate":gv,"freshOosGate":go,
                        "eligibleAfterCalibration":eligible,
                    }
                    if eligible:
                        ledgers[name]=trades
                    grid.append({
                        "candidate":name,"direction":direction,"family":family,"topN":top_n,
                        "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                        "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                        "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                        "freshOosPass":go["pass"],"freshOosReturn":mo.get("totalReturn"),"freshOosPF":mo.get("profitFactor"),"freshOosMDD":mo.get("mdd"),"freshOosPosMonthRate":mo.get("positiveMonthRate"),"freshOosTrades":mo.get("tradeCount"),
                        "distinctSymbols":trades.select("symbol").unique().height,
                    })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val_pass=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    fresh_pass=[n for n in val_pass if reports[n]["freshOosGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:
        ledgers[selected].select([
            "market","date","timestamp","symbol","direction","candidate",
            "entryPrice","exitPrice","grossReturn","roundTripCost","netReturn",
            "MFE","MAE","exitReason","flow4","rvol","ret4","takerRatio","vwap96"
        ]).write_csv(out/"selected-ledger.csv")

    summary={
        "schemaVersion":1,
        "contract":"crypto-full-universe-orderflow-v4",
        "market":market,
        "stageAScreen":screen_audit,
        "microstructureAudit":micro_audit,
        "featureBars":len(feat_pd),
        "unionSignals":union.height,
        "candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(val_pass),
        "freshOosPassCount":len(fresh_pass),
        "validationPassCandidates":val_pass,
        "freshOosPassCandidates":fresh_pass,
        "selectedByCalibration":selected,
        "selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "allAvailable15mPairsScannedInStageA":True,
            "stageAUsesOnlyOhlcvBroadMonthScreen":True,
            "microstructureDownloadedOnlyForCandidateMonthsPlusPriorContext":True,
            "stageAMonthScreenCanOmitMicrostructureOnlySignals":True,
            "takerAndFlowUseBinancePublicMonthlyKlineArchives":True,
            "signalUsesCompleted15mBar":True,
            "entryNext15mOpen":True,
            "stopFirstConservativeWithin15mBar":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "freshOosExcludedFromSelection":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
