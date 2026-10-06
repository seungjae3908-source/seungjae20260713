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

flow=load_module("flow_v3","market-prediction-lab/scripts/run-full-universe-3pct-hunter-crypto-flow-v3.py")
v1=flow.v1

DATASET="rogerdehe/klines-binance"
START=pd.Timestamp("2023-05-01",tz="UTC")
TRAIN_END=pd.Timestamp("2025-04-01").date()
VALID_END=pd.Timestamp("2026-04-01").date()
OOS_END=pd.Timestamp("2026-10-01").date()
PRESCREEN_TOP_PER_DAY=50
PRESCREEN_RVOL_MIN=1.20
FLOW_THRESHOLDS=(0.08,0.15)
RVOL_THRESHOLDS=(1.5,2.5)
RET_THRESHOLDS=(0.00,0.01)
TAKER_LONG=(0.55,0.60)
TAKER_SHORT=(0.45,0.40)
CVD_THRESHOLDS=(0.05,0.10)
TAKER_ACCEL_THRESHOLDS=(0.05,0.08)
TOP_NS=(1,3,5)
TARGETS=(0.03,0.05)
STOPS=(0.015,0.025)
HOLDS=(16,32)
COSTS=flow.COSTS


def market_cfg(market):
    return ("spot","_USDT") if market=="CRYPTO_SPOT" else ("futures","_USDT_USDT")


def raw_symbol_from_path(p:Path,sub:str):
    stem=p.stem
    if sub=="spot" and stem.endswith("_USDT"):
        return stem[:-5]+"USDT"
    if sub=="futures" and stem.endswith("_USDT_USDT"):
        return stem[:-10]+"USDT"
    return stem.replace("_","")


def load_hf_15m(path:Path):
    try:
        x=pl.read_parquet(path,columns=["date","open","high","low","close","volume"])
    except Exception:
        return None
    if x.is_empty():
        return None
    return (
        x.with_columns([
            pl.col("date").cast(pl.Datetime(time_zone="UTC")),
            pl.col("open").cast(pl.Float64),
            pl.col("high").cast(pl.Float64),
            pl.col("low").cast(pl.Float64),
            pl.col("close").cast(pl.Float64),
            pl.col("volume").cast(pl.Float64),
        ])
        .filter((pl.col("date")>=pl.lit(START))&(pl.col("open")>0)&(pl.col("close")>0))
        .sort("date")
    )


def prescreen_file(path:Path,sub:str):
    x=load_hf_15m(path)
    if x is None or x.height<100:
        return None
    symbol=raw_symbol_from_path(path,sub)
    x=x.with_columns([
        pl.col("volume").shift(1).rolling_mean(96,min_samples=48).alias("priorVol96"),
        (pl.col("close")/pl.col("close").shift(4)-1.0).alias("ret60"),
        (pl.col("high").shift(1).rolling_max(16,min_samples=8)).alias("priorHigh4h"),
        (pl.col("low").shift(1).rolling_min(16,min_samples=8)).alias("priorLow4h"),
    ]).with_columns([
        (pl.col("volume")/pl.col("priorVol96")).alias("baseRvol"),
        (pl.col("close")/pl.col("priorHigh4h")-1.0).alias("nearHigh4h"),
        (pl.col("close")/pl.col("priorLow4h")-1.0).alias("nearLow4h"),
    ]).with_columns([
        (
            pl.col("baseRvol").clip(0,20)
            +pl.col("ret60").abs().clip(0,0.20)*30
            +(pl.col("nearHigh4h")>=-0.01).cast(pl.Int8)*0.5
            +(pl.col("nearLow4h")<=0.01).cast(pl.Int8)*0.5
        ).alias("activityScore"),
        pl.col("date").dt.date().alias("day"),
        pl.col("date").dt.strftime("%Y-%m").alias("month"),
        pl.lit(symbol).alias("symbol"),
    ])
    # Every pair is inspected. Only its strongest intraday activity is promoted
    # to the cross-sectional raw-flow stage.
    return (
        x.filter(pl.col("baseRvol")>=PRESCREEN_RVOL_MIN)
        .sort(["day","activityScore"],descending=[False,True])
        .group_by("day",maintain_order=True).head(2)
        .select(["date","day","month","symbol","activityScore","baseRvol","ret60"])
    )


def full_universe_prescreen(folder:Path,sub:str):
    files=sorted(folder.glob("*.parquet"))
    frames=[]
    failed=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs={pool.submit(prescreen_file,p,sub):p for p in files}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            p=futs[fut]
            try:x=fut.result()
            except Exception as exc:
                failed.append({"file":p.name,"error":repr(exc)});continue
            if x is not None and x.height:frames.append(x)
            if idx%100==0 or idx==len(files):
                print(json.dumps({"flowV4PrescreenFiles":idx,"files":len(files),"usableFrames":len(frames),"failed":len(failed)}),flush=True)
    if not frames:
        raise RuntimeError("FLOW_V4_NO_PRESCREEN_ROWS")
    x=pl.concat(frames,how="vertical")
    selected=(
        x.sort(["day","activityScore"],descending=[False,True])
        .group_by("day",maintain_order=True).head(PRESCREEN_TOP_PER_DAY)
    )
    tasks=selected.select(["month","symbol"]).unique().sort(["month","symbol"])
    return files,selected,tasks,failed


def fetch_raw_tasks(market:str,tasks:pl.DataFrame):
    rows=tasks.iter_rows(named=True)
    task_list=[(str(r["month"]),str(r["symbol"])) for r in rows]
    frames=[]
    failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
        futs={pool.submit(flow.fetch_month_symbol,market,s,m):(m,s) for m,s in task_list}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            m,s=futs[fut]
            mm,ss,df,status=fut.result()
            if df is not None and not df.empty:
                frames.append((m,s,df))
            else:
                failures.append({"month":m,"symbol":s,"status":status})
            if idx%100==0 or idx==len(task_list):
                print(json.dumps({"flowV4RawFiles":idx,"tasks":len(task_list),"usable":len(frames),"failed":len(failures),"market":market}),flush=True)
    coverage=len(frames)/max(len(task_list),1)
    if coverage<0.80:
        raise RuntimeError(f"FLOW_V4_RAW_FILE_COVERAGE_LOW:{len(frames)}/{len(task_list)}")
    return frames,failures,coverage


def augment_features(pdf:pd.DataFrame):
    x=flow.add_features(pdf)
    out=[]
    for symbol,g0 in x.groupby("symbol",sort=False):
        g=g0.sort_values("timestamp").copy()
        q=g["quote_volume"].astype(float)
        tq=g["taker_buy_quote"].astype(float)
        delta=(2.0*tq-q)
        g["flow1"]=np.where(q>0,delta/q,np.nan)
        g["cvd12"]=delta.rolling(12,min_periods=8).sum()/q.rolling(12,min_periods=8).sum().replace(0,np.nan)
        g["ret12"]=g["close"]/g["close"].shift(12)-1.0
        prior_taker=g["takerRatio"].shift(1).rolling(8,min_periods=4).mean()
        g["takerAccel"]=g["takerRatio"]-prior_taker
        out.append(g)
    return pd.concat(out,ignore_index=True).dropna(subset=["cvd12","ret12","takerAccel"])


def broad_exact_mask(features:pl.DataFrame,market:str):
    long_mask=(
        ((pl.col("flow4")>=min(FLOW_THRESHOLDS))&(pl.col("rvol")>=min(RVOL_THRESHOLDS))&(pl.col("ret4")>=min(RET_THRESHOLDS))&(pl.col("close")>pl.col("vwap96")))
        |((pl.col("takerRatio")>=min(TAKER_LONG))&(pl.col("rvol")>=min(RVOL_THRESHOLDS))&(pl.col("prevClose")<=pl.col("prevVwap"))&(pl.col("close")>pl.col("vwap96")))
        |((pl.col("cvd12")>=min(CVD_THRESHOLDS))&(pl.col("rvol")>=min(RVOL_THRESHOLDS)))
        |((pl.col("takerAccel")>=min(TAKER_ACCEL_THRESHOLDS))&(pl.col("takerRatio")>=0.52)&(pl.col("rvol")>=min(RVOL_THRESHOLDS)))
    )
    if market!="CRYPTO_FUTURES":
        return long_mask
    short_mask=(
        ((pl.col("flow4")<=-min(FLOW_THRESHOLDS))&(pl.col("rvol")>=min(RVOL_THRESHOLDS))&(pl.col("ret4")<=-min(RET_THRESHOLDS))&(pl.col("close")<pl.col("vwap96")))
        |((pl.col("takerRatio")<=max(TAKER_SHORT))&(pl.col("rvol")>=min(RVOL_THRESHOLDS))&(pl.col("prevClose")>=pl.col("prevVwap"))&(pl.col("close")<pl.col("vwap96")))
        |((pl.col("cvd12")<=-min(CVD_THRESHOLDS))&(pl.col("rvol")>=min(RVOL_THRESHOLDS)))
        |((pl.col("takerAccel")<=-min(TAKER_ACCEL_THRESHOLDS))&(pl.col("takerRatio")<=0.48)&(pl.col("rvol")>=min(RVOL_THRESHOLDS)))
    )
    return long_mask|short_mask


def process_raw_files(frames,market):
    feature_frames=[]
    outcome_frames=[]
    failures=[]
    for idx,(month,symbol,pdf) in enumerate(frames,1):
        try:
            fp=augment_features(pdf)
            fpl=pl.from_pandas(fp).with_columns([
                pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")),
                pl.col("date").cast(pl.Date),
            ])
            broad=fpl.filter(broad_exact_mask(fpl,market))
            if broad.height:
                feature_frames.append(broad)
                union=broad.select(["timestamp","symbol","date"]).unique()
                outcome_frames.append(flow.simulate_union(fp,union,market))
        except Exception as exc:
            failures.append({"month":month,"symbol":symbol,"error":repr(exc)})
        if idx%100==0 or idx==len(frames):
            print(json.dumps({"flowV4ProcessedRaw":idx,"files":len(frames),"featureFrames":len(feature_frames),"outcomeFrames":len(outcome_frames),"failed":len(failures)}),flush=True)
    if not feature_frames or not outcome_frames:
        raise RuntimeError("FLOW_V4_NO_EXACT_FEATURES_OR_OUTCOMES")
    # Binance archives can infer integer dtypes for all-integer monthly columns; relax to a common numeric supertype before cross-symbol concat.\n    features=pl.concat(feature_frames,how="vertical_relaxed").unique(subset=["timestamp","symbol"])
    outcomes=pl.concat(outcome_frames,how="vertical_relaxed")
    return features,outcomes,failures


def signal_custom(features:pl.DataFrame,family:str,direction:str,a:float,rv:float,top_n:int):
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
    x=features.filter(mask).with_columns([score.alias("score"),pl.lit(direction).alias("direction")])
    if x.is_empty():return x
    return (
        x.sort(["date","symbol","timestamp"])
        .group_by(["date","symbol"],maintain_order=True).head(1)
        .sort(["timestamp","score"],descending=[False,True])
        .group_by("timestamp",maintain_order=True).head(top_n)
    )


def definitions(market):
    dirs=["LONG","SHORT"] if market=="CRYPTO_FUTURES" else ["LONG"]
    defs=[]
    for direction in dirs:
        for f in FLOW_THRESHOLDS:
            for rv in RVOL_THRESHOLDS:
                for ret in RET_THRESHOLDS:
                    for top in TOP_NS:
                        defs.append((f"FLOW_TREND_{direction}_F{f:g}_RV{rv:g}_R{ret:g}_TOP{top}","FLOW_TREND",direction,f,rv,ret,top))
        ratios=TAKER_LONG if direction=="LONG" else TAKER_SHORT
        for ratio in ratios:
            for rv in RVOL_THRESHOLDS:
                for top in TOP_NS:
                    defs.append((f"FLOW_RECLAIM_{direction}_T{ratio:g}_RV{rv:g}_TOP{top}","FLOW_RECLAIM",direction,ratio,rv,None,top))
        for cvd in CVD_THRESHOLDS:
            for rv in RVOL_THRESHOLDS:
                for top in TOP_NS:
                    defs.append((f"CVD_LEAD_{direction}_C{cvd:g}_RV{rv:g}_TOP{top}","CVD_LEAD",direction,cvd,rv,None,top))
        for acc in TAKER_ACCEL_THRESHOLDS:
            for rv in RVOL_THRESHOLDS:
                for top in TOP_NS:
                    defs.append((f"TAKER_ACCEL_{direction}_A{acc:g}_RV{rv:g}_TOP{top}","TAKER_ACCEL",direction,acc,rv,None,top))
    return defs


def get_signal(features,market,family,direction,a,rv,ret,top):
    if family in ("FLOW_TREND","FLOW_RECLAIM"):
        return flow.signal_frame(features,market,family,direction,a,rv,ret,top)
    return signal_custom(features,family,direction,a,rv,top)


def evaluate(features,outcomes,market):
    train_dates=[d.date() for d in pd.date_range("2023-05-01","2025-03-31",freq="D")]
    valid_dates=[d.date() for d in pd.date_range("2025-04-01","2026-03-31",freq="D")]
    oos_dates=[d.date() for d in pd.date_range("2026-04-01","2026-09-30",freq="D")]
    grid=[];reports={}
    for key,family,direction,a,rv,ret,top in definitions(market):
        sig=get_signal(features,market,family,direction,a,rv,ret,top)
        if sig.is_empty():continue
        for target in TARGETS:
            for stop in STOPS:
                for hold in HOLDS:
                    name=f"{key}_TP{int(target*100)}_SL{stop:g}_H{hold}"
                    oc=outcomes.filter((pl.col("targetPct")==target)&(pl.col("stopPct")==stop)&(pl.col("holdBars")==hold))
                    joined=sig.join(oc,on=["timestamp","symbol"],how="inner")
                    if direction=="LONG":
                        trades=joined.with_columns([
                            pl.lit(market).alias("market"),pl.lit("LONG").alias("direction"),pl.lit(name).alias("candidate"),
                            pl.col("timestamp").dt.date().alias("date"),pl.col("entryPrice"),
                            pl.col("longExitPrice").alias("exitPrice"),pl.col("longGross").alias("grossReturn"),pl.col("longNet").alias("netReturn"),
                            pl.col("longMFE").alias("MFE"),pl.col("longMAE").alias("MAE"),pl.col("longExitReason").alias("exitReason"),
                            pl.lit(COSTS[market]).alias("roundTripCost"),
                        ])
                    else:
                        trades=joined.with_columns([
                            pl.lit(market).alias("market"),pl.lit("SHORT").alias("direction"),pl.lit(name).alias("candidate"),
                            pl.col("timestamp").dt.date().alias("date"),pl.col("entryPrice"),
                            pl.col("shortExitPrice").alias("exitPrice"),pl.col("shortGross").alias("grossReturn"),pl.col("shortNet").alias("netReturn"),
                            pl.col("shortMFE").alias("MFE"),pl.col("shortMAE").alias("MAE"),pl.col("shortExitReason").alias("exitReason"),
                            pl.lit(COSTS[market]).alias("roundTripCost"),
                        ])
                    train=trades.filter(pl.col("date")<pl.lit(TRAIN_END))
                    valid=trades.filter((pl.col("date")>=pl.lit(TRAIN_END))&(pl.col("date")<pl.lit(VALID_END)))
                    oos=trades.filter((pl.col("date")>=pl.lit(VALID_END))&(pl.col("date")<pl.lit(OOS_END)))
                    mt=v1.metrics(train,market,train_dates);mv=v1.metrics(valid,market,valid_dates);mo=v1.metrics(oos,market,oos_dates)
                    gt,gv,go=flow.gate(mt,100),flow.gate(mv,50),flow.gate(mo,25)
                    reports[name]={"direction":direction,"family":family,"train":mt,"validation":mv,"freshOos":mo,"trainGate":gt,"validationGate":gv,"freshOosGate":go,"trades":trades}
                    grid.append({
                        "candidate":name,"direction":direction,"family":family,
                        "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                        "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                        "freshOosPass":go["pass"],"freshOosReturn":mo.get("totalReturn"),"freshOosPF":mo.get("profitFactor"),"freshOosMDD":mo.get("mdd"),"freshOosPosMonthRate":mo.get("positiveMonthRate"),"freshOosTrades":mo.get("tradeCount"),
                    })
    train_pass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    val_pass=[n for n in train_pass if reports[n]["validationGate"]["pass"]]
    full_pass=[n for n in val_pass if reports[n]["freshOosGate"]["pass"]]
    winner=sorted(val_pass,key=lambda n:flow.rank_key(reports[n]["validation"],n),reverse=True)[0] if val_pass else None
    return grid,reports,train_pass,val_pass,full_pass,winner


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    sub,_=market_cfg(market)

    folder=Path(snapshot_download(
        repo_id=DATASET,repo_type="dataset",allow_patterns=[f"{sub}/15m/*.parquet"]
    ))/sub/"15m"
    files,selected,tasks,prescreen_failures=full_universe_prescreen(folder,sub)
    frames,raw_failures,raw_coverage=fetch_raw_tasks(market,tasks)
    features,outcomes,process_failures=process_raw_files(frames,market)

    grid,reports,train_pass,val_pass,full_pass,winner=evaluate(features,outcomes,market)
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    selected.write_csv(out/"prescreen-selected.csv")
    tasks.write_csv(out/"raw-month-tasks.csv")
    if winner:
        reports[winner]["trades"].write_csv(out/"winner-ledger.csv")

    summary={
        "schemaVersion":1,"contract":"crypto-full-universe-flow-v4","market":market,
        "dataset":DATASET,"source15mFilesScanned":len(files),
        "prescreenRows":selected.height,"rawMonthTasks":tasks.height,
        "rawMonthCoverage":raw_coverage,"exactFeatureRows":features.height,"outcomeRows":outcomes.height,
        "candidateCount":len(grid),"trainPassCount":len(train_pass),"validationPassCount":len(val_pass),
        "freshOosPassCount":len(full_pass),"winner":winner,
        "validationPassCandidates":val_pass,"freshOosPassCandidates":full_pass,
        "winnerResults":({k:v for k,v in reports[winner].items() if k!="trades"} if winner else None),
        "audits":{
            "prescreenFailures":len(prescreen_failures),"rawFailures":len(raw_failures),"processFailures":len(process_failures),
            "rawFailurePreview":raw_failures[:30],"processFailurePreview":process_failures[:30],
        },
        "truthBoundary":{
            "allAvailable15mPairsScannedInPrescreen":True,
            "topActivityPromotionOccursOnlyAfterEveryPairWasScanned":True,
            "rawTakerBuyQuoteFromBinancePublicMonthlyKlines":True,
            "signalUsesCompleted15mBars":True,
            "entryUsesNext15mOpen":True,
            "stopFirstConservativeWithin15mBar":True,
            "trainAndValidationFollowOriginalFlowV3Boundary":True,
            "freshOosExcludedFromSelection":True,
            "profitabilityProven":False,"executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
