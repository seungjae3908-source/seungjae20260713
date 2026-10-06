#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

ROOT=Path(__file__).resolve().parents[2]

def load_module(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

miner=load_module(
    "kr_miner",
    "market-prediction-lab/scripts/run-kr-recent-all-session-opportunity-miner-v1.py",
)
trainer=load_module(
    "kr_ai",
    "market-prediction-lab/scripts/train-kr-recent-all-session-opportunity-ai-v1.py",
)
always_on=load_module(
    "always_on",
    "market-prediction-lab/scripts/always_on_portfolio_replay.py",
)

TARGET=0.03
STOP=0.015
HORIZON_MINUTES=60
ROUND_TRIP_COST=0.003
MAX_WORKERS=16


def fit_frozen_model(events:pd.DataFrame):
    data=trainer.prepare(events)
    data=trainer.add_clusters(data)
    dates=sorted(d for d in data["date"].dropna().unique())
    if len(dates)<4:
        raise RuntimeError(f"KR_REPLAY_TOO_FEW_DATES:{len(dates)}")
    n=len(dates)
    train_end=max(1,n-3)
    train_dates=dates[:train_end]
    cal_date=dates[train_end]
    val_date=dates[train_end+1] if train_end+1<n-1 else cal_date
    diag_date=dates[-1]

    train=data[data["date"].isin(train_dates)].copy()
    cal=data[data["date"]==cal_date].copy()
    label="labelClose3"
    y=pd.to_numeric(train[label],errors="coerce").fillna(0).astype(int)
    model=LGBMClassifier(
        objective="binary",
        n_estimators=400,
        learning_rate=0.035,
        num_leaves=31,
        min_child_samples=80,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.15,
        reg_lambda=1.5,
        random_state=57,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(
        train[trainer.FEATURES],
        y,
        sample_weight=trainer.sample_weight(train),
    )
    cal_score=model.predict_proba(cal[trainer.FEATURES])[:,1]
    chosen=trainer.select_threshold(
        cal,
        label,
        cal_score,
        float(trainer.TARGETS["CLOSE3"]["recallFloor"]),
    )
    threshold=float(chosen["winner"]["threshold"])
    return model,threshold,{
        "allDates":[str(x) for x in dates],
        "trainDates":[str(x) for x in train_dates],
        "calibrationDate":str(cal_date),
        "validationDate":str(val_date),
        "lastDayDiagnosticDate":str(diag_date),
        "threshold":threshold,
        "selectionMode":chosen["selectionMode"],
    },val_date,diag_date


def market_code(market:str)->float:
    return float(trainer.MARKET_CODE.get(str(market),3.0))


def simulate_close_path(
    day_grid:pd.DataFrame,
    signal_time:pd.Timestamp,
    score:float,
    symbol:str,
    exchange_market:str,
):
    z=day_grid.copy()
    if z.empty:
        return None
    z["timestamp"]=pd.to_datetime(z["timestamp"],errors="coerce")
    idxs=np.flatnonzero(z["timestamp"].to_numpy()==np.datetime64(signal_time.to_datetime64()))
    if len(idxs)==0:
        return None
    i=int(idxs[0])
    if i+1>=len(z):
        return None
    entry_i=i+1
    entry=float(z["close"].iloc[entry_i])
    if not np.isfinite(entry) or entry<=0:
        return None
    end_i=min(len(z)-1,entry_i+HORIZON_MINUTES-1)
    tp=entry*(1.0+TARGET)
    sl=entry*(1.0-STOP)
    exit_i=end_i
    exit_px=float(z["close"].iloc[end_i])
    reason="TIME"
    closes=pd.to_numeric(z["close"].iloc[entry_i:end_i+1],errors="coerce").to_numpy(float)
    for off,px in enumerate(closes):
        if not np.isfinite(px):
            continue
        j=entry_i+off
        if px<=sl:
            exit_i=j
            exit_px=float(px)
            reason="STOP_CLOSE"
            break
        if px>=tp:
            exit_i=j
            exit_px=float(px)
            reason="TARGET_CLOSE"
            break
    valid=closes[np.isfinite(closes)]
    if len(valid)==0:
        return None
    gross=exit_px/entry-1.0
    mfe=float(valid.max()/entry-1.0)
    mae=float(1.0-valid.min()/entry)
    return {
        "market":"KR_STOCK",
        "exchangeMarket":str(exchange_market),
        "timestamp":pd.Timestamp(signal_time),
        "symbol":str(symbol),
        "direction":"LONG",
        "score":float(score),
        "entryTime":pd.Timestamp(z["timestamp"].iloc[entry_i]),
        "exitTime":pd.Timestamp(z["timestamp"].iloc[exit_i]),
        "entryPrice":entry,
        "exitPrice":exit_px,
        "grossReturn":gross,
        "roundTripCost":ROUND_TRIP_COST,
        "netReturn":gross-ROUND_TRIP_COST,
        "MFE":mfe,
        "MAE":mae,
        "exitReason":reason,
    }


def process_symbol(
    symbol:str,
    exchange_market:str,
    model,
    threshold:float,
    eval_dates:set,
):
    raw,err=miner.fetch_rows(symbol)
    if raw is None:
        return [],{
            "symbol":symbol,
            "market":exchange_market,
            "ok":False,
            "error":err,
        }
    raw["date"]=raw["timestamp"].dt.date
    history_tail=None
    trades=[]
    scanner_states=0
    selected_states=0
    selected_by_date={}
    for day,g in raw.groupby("date",sort=True):
        f,history_tail=miner.feature_day(g,history_tail)
        if f.empty or day not in eval_dates:
            continue
        f=f[(f["close"]>=500)&(f["priorDollar60"]>=100000)].copy()
        if f.empty:
            continue
        scanner_states+=len(f)
        f["logClose"]=np.log(pd.to_numeric(f["close"],errors="coerce").clip(lower=1.0))
        f["logPriorDollar"]=np.log(pd.to_numeric(f["priorDollar60"],errors="coerce").clip(lower=1.0))
        f["marketCode"]=market_code(exchange_market)
        for c in trainer.FEATURES:
            f[c]=pd.to_numeric(f[c],errors="coerce")
        f=f.replace([np.inf,-np.inf],np.nan).dropna(subset=trainer.FEATURES)
        if f.empty:
            continue
        scores=model.predict_proba(f[trainer.FEATURES])[:,1]
        f["score"]=scores
        selected=f[f["score"]>=threshold].copy()
        selected_states+=len(selected)
        selected_by_date[str(day)]=int(len(selected))
        if selected.empty:
            continue
        grid=miner.grid_day(g)
        for _,row in selected.iterrows():
            tr=simulate_close_path(
                grid,
                pd.Timestamp(row["timestamp"]),
                float(row["score"]),
                symbol,
                exchange_market,
            )
            if tr is not None:
                trades.append(tr)
    return trades,{
        "symbol":symbol,
        "market":exchange_market,
        "ok":True,
        "rawRows":int(len(raw)),
        "scannerStates":int(scanner_states),
        "selectedStates":int(selected_states),
        "selectedByDate":selected_by_date,
    }


def trade_stats(df:pd.DataFrame)->dict:
    if df.empty:
        return {
            "tradeCount":0,
            "winRate":None,
            "profitFactor":0.0,
            "meanNetReturn":None,
            "netReturnSum":0.0,
            "targetCloseRate":None,
            "stopCloseRate":None,
            "mfe3Rate":None,
        }
    net=pd.to_numeric(df["netReturn"],errors="coerce").fillna(0.0)
    pos=float(net[net>0].sum())
    neg=float(-net[net<0].sum())
    return {
        "tradeCount":int(len(df)),
        "winRate":float((net>0).mean()),
        "profitFactor":pos/max(neg,1e-12),
        "meanNetReturn":float(net.mean()),
        "netReturnSum":float(net.sum()),
        "targetCloseRate":float((df["exitReason"]=="TARGET_CLOSE").mean()),
        "stopCloseRate":float((df["exitReason"]=="STOP_CLOSE").mean()),
        "mfe3Rate":float((pd.to_numeric(df["MFE"],errors="coerce")>=TARGET).mean()),
    }


def replay_capacity(df:pd.DataFrame):
    rows=[]
    for cap in (1,3,5,10,20,None):
        r=always_on.replay_always_on(
            df[[
                "market","timestamp","symbol","direction","score",
                "entryTime","exitTime","netReturn","MFE","MAE",
            ]],
            max_positions=cap,
            opportunity_target=TARGET,
        )
        rows.append({
            "maxPositions":"UNLIMITED" if cap is None else cap,
            "entries":r["positions"]["entries"],
            "reentries":r["positions"]["reentriesAfterPriorExit"],
            "maxConcurrent":r["positions"]["maxConcurrent"],
            "detected3pct":r["opportunities"]["detected"],
            "executed3pct":r["opportunities"]["executed"],
            "executionRecall":r["opportunities"]["executionRecall"],
            "bookedNetReturnSum":r["positions"]["bookedNetReturnSum"],
        })
    return rows


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir)
    out.mkdir(parents=True,exist_ok=True)

    source=pd.read_parquet(args.events)
    model,threshold,split,val_date,diag_date=fit_frozen_model(source)
    sym_market=(
        source[["symbol","exchangeMarket"]]
        .dropna()
        .drop_duplicates("symbol")
        .set_index("symbol")["exchangeMarket"]
        .astype(str)
        .to_dict()
    )
    symbols=sorted(sym_market)
    eval_dates={val_date,diag_date}

    all_trades=[]
    audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={
            pool.submit(
                process_symbol,
                s,
                sym_market[s],
                model,
                threshold,
                eval_dates,
            ):s
            for s in symbols
        }
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            s=futs[fut]
            try:
                trades,audit=fut.result()
            except Exception as exc:
                trades=[]
                audit={"symbol":s,"market":sym_market[s],"ok":False,"error":repr(exc)}
            audits.append(audit)
            if trades:
                all_trades.extend(trades)
            if idx%100==0 or idx==len(futs):
                print(json.dumps({
                    "symbolsComplete":idx,
                    "symbols":len(futs),
                    "usable":sum(1 for x in audits if x.get("ok")),
                    "trades":len(all_trades),
                }),flush=True)

    trades=pd.DataFrame(all_trades)
    if trades.empty:
        raise RuntimeError("KR_EXACT_REPLAY_NO_TRADES")
    trades["date"]=pd.to_datetime(trades["timestamp"]).dt.date
    trades.to_csv(out/"selected-trades.csv",index=False)
    pd.DataFrame(audits).to_json(
        out/"symbol-audit.jsonl",
        orient="records",
        lines=True,
        force_ascii=False,
    )

    by_date={}
    for d in (val_date,diag_date):
        sub=trades[trades["date"]==d].copy()
        by_date[str(d)]={
            "tradeStats":trade_stats(sub),
            "capacityGrid":replay_capacity(sub) if len(sub) else [],
        }

    result={
        "schemaVersion":1,
        "contract":"kr-recent-all-session-ai-exact-close-replay-v2",
        "sourceRun":37431510636,
        "split":split,
        "requestedSymbols":len(symbols),
        "usableSymbols":sum(1 for x in audits if x.get("ok")),
        "failedSymbols":sum(1 for x in audits if not x.get("ok")),
        "selectedTradeRows":int(len(trades)),
        "byDate":by_date,
        "combinedTradeStats":trade_stats(trades),
        "combinedCapacityGrid":replay_capacity(trades),
        "truthBoundary":{
            "fullMinuteScannerRebuiltForValidationAndLastDay":True,
            "scannerWindow0900To1630":True,
            "modelFitUsesEarlierDatesOnly":True,
            "thresholdUsesCalibrationDateOnly":True,
            "validationAndLastDayExcludedFromFitAndThreshold":True,
            "entryUsesNextClockMinuteCloseProxy":True,
            "exitUsesMinuteClosePathOnly":True,
            "noTrueIntrabarHighLowAvailable":True,
            "target3Stop1p5AndRoundTripCost0p3pctApplied":True,
            "alwaysOnPortfolioReplayApplied":True,
            "recentTwoDayEconomicDiagnosticOnly":True,
            "notThreeYearProfitabilityProof":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8",
    )
    pd.DataFrame(result["combinedCapacityGrid"]).to_csv(
        out/"capacity-grid.csv",
        index=False,
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)


if __name__=="__main__":
    main()
