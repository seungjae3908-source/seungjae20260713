#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v22=load(
    "kr_v22",
    "market-prediction-lab/scripts/run-kr-recent-all-session-recall-first-v22.py",
)
pathminer=v22.pathminer
trainer=v22.trainer
replay=v22.replay
miner=v22.miner

MAX_WORKERS=16
MAX_STATE_GAP=pd.Timedelta(minutes=2)

def process_symbol(symbol,exchange_market,model,threshold,eval_dates):
    raw,err=miner.fetch_rows(symbol)
    if raw is None:
        return [],{
            "symbol":symbol,"market":exchange_market,
            "ok":False,"error":err,
        }

    raw["date"]=raw["timestamp"].dt.date
    history_tail=None
    trades=[]
    scanner_states=0
    above_threshold_states=0
    event_onsets=0
    onsets_by_date={}

    for day,g in raw.groupby("date",sort=True):
        f,history_tail=pathminer.feature_day(g,history_tail)
        if f.empty or day not in eval_dates:
            continue
        f=f[(f["close"]>=500)&(f["priorDollar60"]>=100000)].copy()
        if f.empty:
            continue
        scanner_states+=len(f)
        f=v22.prepare_features(f,exchange_market)
        if f.empty:
            continue
        f=f.sort_values("timestamp").reset_index(drop=True)
        f["score"]=model.predict_proba(f[trainer.FEATURES])[:,1]
        above=f["score"]>=threshold
        above_threshold_states+=int(above.sum())

        prev_score=f["score"].shift(1)
        prev_ts=pd.to_datetime(f["timestamp"].shift(1),errors="coerce")
        ts=pd.to_datetime(f["timestamp"],errors="coerce")
        gap=ts-prev_ts
        onset=above & (
            prev_score.isna()
            | (prev_score<threshold)
            | (gap>MAX_STATE_GAP)
        )
        selected=f.loc[onset].copy()
        event_onsets+=len(selected)
        onsets_by_date[str(day)]=int(len(selected))
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
        "aboveThresholdStates":int(above_threshold_states),
        "eventOnsets":int(event_onsets),
        "onsetsByDate":onsets_by_date,
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    source=pd.read_parquet(args.events)
    (
        model,threshold,selection,split,
        val_date,fresh_date,val_sample,fresh_sample,
    )=v22.fit(source)

    sym_market=(
        source[["symbol","exchangeMarket"]]
        .dropna().drop_duplicates("symbol")
        .set_index("symbol")["exchangeMarket"].astype(str).to_dict()
    )
    symbols=sorted(sym_market)
    eval_dates={val_date,fresh_date}

    all_trades=[]
    audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={
            pool.submit(
                process_symbol,s,sym_market[s],model,threshold,eval_dates
            ):s
            for s in symbols
        }
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            s=futs[fut]
            try:
                trades,audit=fut.result()
            except Exception as exc:
                trades=[]
                audit={
                    "symbol":s,"market":sym_market[s],
                    "ok":False,"error":repr(exc),
                }
            audits.append(audit)
            all_trades.extend(trades)
            if idx%100==0 or idx==len(futs):
                print(json.dumps({
                    "symbolsComplete":idx,
                    "symbols":len(futs),
                    "usable":sum(1 for x in audits if x.get("ok")),
                    "eventOnsets":sum(int(x.get("eventOnsets") or 0) for x in audits),
                    "trades":len(all_trades),
                },ensure_ascii=False),flush=True)

    trades=pd.DataFrame(all_trades)
    if trades.empty:
        raise RuntimeError("KR_V23_NO_EVENT_ONSET_TRADES")
    trades["date"]=pd.to_datetime(trades["timestamp"]).dt.date
    trades.to_csv(out/"event-onset-trades.csv",index=False)
    pd.DataFrame(audits).to_json(
        out/"symbol-audit.jsonl",
        orient="records",lines=True,force_ascii=False,
    )

    total_scanner=sum(int(x.get("scannerStates") or 0) for x in audits)
    total_above=sum(int(x.get("aboveThresholdStates") or 0) for x in audits)
    total_onsets=sum(int(x.get("eventOnsets") or 0) for x in audits)

    by_date={}
    for d in (val_date,fresh_date):
        sub=trades[trades["date"]==d].copy()
        by_date[str(d)]={
            "tradeStats":replay.trade_stats(sub),
            "capacityGrid":replay.replay_capacity(sub) if len(sub) else [],
        }

    val_stats=by_date[str(val_date)]["tradeStats"]
    fresh_stats=by_date[str(fresh_date)]["tradeStats"]
    checks={
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
        "contract":"kr-recent-all-session-event-onset-v23",
        "sourceV22Threshold":threshold,
        "sourceV22SelectionMode":selection["selectionMode"],
        "split":split,
        "requestedSymbols":len(symbols),
        "usableSymbols":sum(1 for x in audits if x.get("ok")),
        "scannerStates":int(total_scanner),
        "aboveThresholdStates":int(total_above),
        "eventOnsets":int(total_onsets),
        "onsetShareOfAboveThreshold":float(total_onsets/max(total_above,1)),
        "exactTradeRows":int(len(trades)),
        "byDate":by_date,
        "combinedTradeStats":replay.trade_stats(trades),
        "combinedCapacityGrid":replay.replay_capacity(trades),
        "diagnosticGate":checks,
        "diagnosticPass":all(all(v.values()) for v in checks.values()),
        "truthBoundary":{
            "thresholdFrozenFromV22CalibrationOnly":True,
            "noThresholdRetuning":True,
            "validationAndFreshExcludedFromSelection":True,
            "scannerCoversEntire0900To1630Window":True,
            "scannerNeverStopsForOpenPosition":True,
            "entryCandidateOnlyOnThresholdCrossFromBelowOrGapOverTwoMinutes":True,
            "sameSymbolCanCreateNewEventAfterSignalFallsBelowThreshold":True,
            "openingFiveMinutesNotRequired":True,
            "modelHasNoClockTimeFeature":True,
            "exactReplayUsesMinuteClosePath":True,
            "target3Stop1p5RoundTripCost0p3pctApplied":True,
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
