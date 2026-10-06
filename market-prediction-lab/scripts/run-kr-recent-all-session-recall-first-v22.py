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

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

pathminer=load(
    "kr_path_miner",
    "market-prediction-lab/scripts/run-kr-recent-all-session-path-miner-v2.py",
)
trainer=load(
    "kr_path_ai_v21",
    "market-prediction-lab/scripts/train-kr-recent-all-session-path-ai-v21.py",
)
replay=load(
    "kr_exact_replay_v2",
    "market-prediction-lab/scripts/run-kr-recent-all-session-ai-exact-close-replay-v2.py",
)
miner=load(
    "kr_opportunity_miner",
    "market-prediction-lab/scripts/run-kr-recent-all-session-opportunity-miner-v1.py",
)

MIN_RECALL=0.40
MIN_CLUSTER_RECALL=0.50
MIN_PRECISION=0.15
MAX_SELECTED_SHARE=0.25
MAX_WORKERS=16

def recall_first_threshold(cal:pd.DataFrame,score:np.ndarray)->dict:
    qs=np.unique(np.concatenate([
        np.linspace(0.25,0.90,14),
        np.linspace(0.91,0.99,9),
        np.array([0.9925,0.995,0.9975,0.999]),
    ]))
    thresholds=np.unique(np.quantile(score,qs))
    rows=[trainer.metrics(cal,score,float(t)) for t in thresholds]
    eligible=[
        r for r in rows
        if r["sampleSelected"]>=100
        and r["recall"]>=MIN_RECALL
        and float(r.get("eventClusterRecall") or 0)>=MIN_CLUSTER_RECALL
        and r["populationWeightedPrecision"]>=MIN_PRECISION
        and r["populationWeightedSelectedShare"]<=MAX_SELECTED_SHARE
    ]
    if eligible:
        winner=max(
            eligible,
            key=lambda r:(
                float(r.get("eventClusterRecall") or 0),
                r["recall"],
                r["populationWeightedPrecision"],
                -r["populationWeightedSelectedShare"],
            ),
        )
        mode="RECALL_FIRST_CLUSTER_GATE"
    else:
        candidates=[
            r for r in rows
            if r["sampleSelected"]>=100
            and r["populationWeightedSelectedShare"]<=MAX_SELECTED_SHARE
        ] or rows
        winner=max(
            candidates,
            key=lambda r:(
                float(r.get("eventClusterRecall") or 0),
                r["recall"],
                r["populationWeightedPrecision"],
            ),
        )
        mode="RECALL_FIRST_DIAGNOSTIC"
    return {
        "selectionMode":mode,
        "constraints":{
            "rowRecallAtLeast":MIN_RECALL,
            "eventClusterRecallAtLeast":MIN_CLUSTER_RECALL,
            "precisionAtLeast":MIN_PRECISION,
            "selectedShareAtMost":MAX_SELECTED_SHARE,
        },
        "winner":winner,
        "grid":rows,
    }

def fit(events:pd.DataFrame):
    data=trainer.add_clusters(trainer.prepare(events))
    dates=sorted(d for d in data["date"].dropna().unique())
    if len(dates)<4:
        raise RuntimeError(f"KR_V22_TOO_FEW_DATES:{len(dates)}")
    n=len(dates)
    train_end=max(1,n-3)
    train_dates=dates[:train_end]
    cal_date=dates[train_end]
    val_date=dates[train_end+1] if train_end+1<n-1 else cal_date
    fresh_date=dates[-1]
    train=data[data["date"].isin(train_dates)].copy()
    cal=data[data["date"]==cal_date].copy()
    val=data[data["date"]==val_date].copy()
    fresh=data[data["date"]==fresh_date].copy()
    if min(len(train),len(cal),len(val),len(fresh))==0:
        raise RuntimeError(
            f"KR_V22_EMPTY_SPLIT:{len(train)}:{len(cal)}:{len(val)}:{len(fresh)}"
        )
    y=train["labelPath3"].astype(int)
    model=LGBMClassifier(
        objective="binary",
        n_estimators=450,
        learning_rate=0.035,
        num_leaves=31,
        min_child_samples=80,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.20,
        reg_lambda=1.5,
        random_state=79,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(train[trainer.FEATURES],y,sample_weight=trainer.sample_weight(train))
    cal_score=model.predict_proba(cal[trainer.FEATURES])[:,1]
    selection=recall_first_threshold(cal,cal_score)
    threshold=float(selection["winner"]["threshold"])
    val_score=model.predict_proba(val[trainer.FEATURES])[:,1]
    fresh_score=model.predict_proba(fresh[trainer.FEATURES])[:,1]
    return model,threshold,selection,{
        "allDates":[str(x) for x in dates],
        "trainDates":[str(x) for x in train_dates],
        "calibrationDate":str(cal_date),
        "validationDate":str(val_date),
        "freshDate":str(fresh_date),
    },val_date,fresh_date,trainer.metrics(val,val_score,threshold),trainer.metrics(fresh,fresh_score,threshold)

def prepare_features(f:pd.DataFrame,exchange_market:str)->pd.DataFrame:
    z=f.copy()
    z["logClose"]=np.log(pd.to_numeric(z["close"],errors="coerce").clip(lower=1.0))
    z["logPriorDollar"]=np.log(
        pd.to_numeric(z["priorDollar60"],errors="coerce").clip(lower=1.0)
    )
    z["marketCode"]=float(trainer.MARKET_CODE.get(str(exchange_market),3.0))
    for c in trainer.FEATURES:
        z[c]=pd.to_numeric(z[c],errors="coerce")
    return z.replace([np.inf,-np.inf],np.nan).dropna(subset=trainer.FEATURES)

def process_symbol(symbol,exchange_market,model,threshold,eval_dates):
    raw,err=miner.fetch_rows(symbol)
    if raw is None:
        return [],{"symbol":symbol,"market":exchange_market,"ok":False,"error":err}
    raw["date"]=raw["timestamp"].dt.date
    history_tail=None
    trades=[]
    scanner_states=0
    selected_states=0
    selected_by_date={}
    for day,g in raw.groupby("date",sort=True):
        f,history_tail=pathminer.feature_day(g,history_tail)
        if f.empty or day not in eval_dates:
            continue
        f=f[(f["close"]>=500)&(f["priorDollar60"]>=100000)].copy()
        if f.empty:
            continue
        scanner_states+=len(f)
        f=prepare_features(f,exchange_market)
        if f.empty:
            continue
        f["score"]=model.predict_proba(f[trainer.FEATURES])[:,1]
        selected=f[f["score"]>=threshold].copy()
        selected_states+=len(selected)
        selected_by_date[str(day)]=int(len(selected))
        if selected.empty:
            continue
        grid=miner.grid_day(g)
        for _,row in selected.iterrows():
            tr=replay.simulate_close_path(
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

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    source=pd.read_parquet(args.events)
    model,threshold,selection,split,val_date,fresh_date,val_sample,fresh_sample=fit(source)
    sym_market=(
        source[["symbol","exchangeMarket"]]
        .dropna().drop_duplicates("symbol")
        .set_index("symbol")["exchangeMarket"].astype(str).to_dict()
    )
    symbols=sorted(sym_market)
    eval_dates={val_date,fresh_date}

    all_trades=[];audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={
            pool.submit(process_symbol,s,sym_market[s],model,threshold,eval_dates):s
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
            all_trades.extend(trades)
            if idx%100==0 or idx==len(futs):
                print(json.dumps({
                    "symbolsComplete":idx,
                    "symbols":len(futs),
                    "usable":sum(1 for x in audits if x.get("ok")),
                    "trades":len(all_trades),
                },ensure_ascii=False),flush=True)

    trades=pd.DataFrame(all_trades)
    if trades.empty:
        raise RuntimeError("KR_V22_NO_EXACT_TRADES")
    trades["date"]=pd.to_datetime(trades["timestamp"]).dt.date
    trades.to_csv(out/"selected-trades.csv",index=False)
    pd.DataFrame(audits).to_json(
        out/"symbol-audit.jsonl",orient="records",lines=True,force_ascii=False
    )
    pd.DataFrame(selection["grid"]).to_csv(out/"threshold-grid.csv",index=False)

    by_date={}
    for d in (val_date,fresh_date):
        sub=trades[trades["date"]==d].copy()
        by_date[str(d)]={
            "tradeStats":replay.trade_stats(sub),
            "capacityGrid":replay.replay_capacity(sub) if len(sub) else [],
        }

    val_stats=by_date[str(val_date)]["tradeStats"]
    fresh_stats=by_date[str(fresh_date)]["tradeStats"]
    diagnostic={
        "validation":{
            "positiveMeanNet":float(val_stats.get("meanNetReturn") or 0)>0,
            "profitFactorAbove1":float(val_stats.get("profitFactor") or 0)>1,
            "minimumTrades":int(val_stats.get("tradeCount") or 0)>=100,
        },
        "fresh":{
            "positiveMeanNet":float(fresh_stats.get("meanNetReturn") or 0)>0,
            "profitFactorAbove1":float(fresh_stats.get("profitFactor") or 0)>1,
            "minimumTrades":int(fresh_stats.get("tradeCount") or 0)>=100,
        },
    }

    result={
        "schemaVersion":1,
        "contract":"kr-recent-all-session-recall-first-v22",
        "threshold":threshold,
        "selection":selection,
        "split":split,
        "sampleValidation":val_sample,
        "sampleFresh":fresh_sample,
        "requestedSymbols":len(symbols),
        "usableSymbols":sum(1 for x in audits if x.get("ok")),
        "selectedTradeRows":int(len(trades)),
        "byDate":by_date,
        "combinedTradeStats":replay.trade_stats(trades),
        "combinedCapacityGrid":replay.replay_capacity(trades),
        "diagnosticGate":diagnostic,
        "diagnosticPass":all(all(v.values()) for v in diagnostic.values()),
        "truthBoundary":{
            "recallFirstThresholdUsesCalibrationOnly":True,
            "validationAndFreshExcludedFromThresholdSelection":True,
            "scannerCoversEntire0900To1630Window":True,
            "openingFiveMinutesNotRequired":True,
            "modelHasNoClockTimeFeature":True,
            "exactReplayUsesMinuteClosePath":True,
            "entryUsesNextMinuteCloseProxy":True,
            "target3Stop1p5RoundTripCost0p3pctApplied":True,
            "alwaysOnPortfolioReplayApplied":True,
            "sourceRecentSevenTradingDaysOnly":True,
            "notThreeYearProfitabilityProof":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
