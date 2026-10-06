#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

ROOT=Path(__file__).resolve().parents[2]

def load(name:str,rel:str):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

trainer=load("us_ai_v4","market-prediction-lab/scripts/train-us-all-session-opportunity-ai-v4.py")
probe=load("us_probe","market-prediction-lab/scripts/run-us-all-session-opportunity-probe-v1.py")
census=load("census","market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")

FRESH_MONTHS=["2025-10","2025-11","2025-12","2026-01","2026-02"]
TARGET=0.03
STOP=0.015
HOLD_MINUTES=60
ENTRY_SLIPPAGE=0.0005
ROUND_TRIP_COST=0.0020
CAPACITIES=(1,3,5,10,20)
BATCH_ROWS=250_000

def fit_mfe3(events:pd.DataFrame):
    data=events.copy()
    for c in trainer.FEATURES:
        data[c]=pd.to_numeric(data[c],errors="coerce")
    data=data.replace([np.inf,-np.inf],np.nan)
    train=data[data["period"]=="train"].copy()
    cal=data[data["period"]=="calibration"].copy()
    y=pd.to_numeric(train["labelMfe3"],errors="coerce").fillna(0).astype(int)
    model=LGBMClassifier(
        objective="binary",
        n_estimators=500,
        learning_rate=0.035,
        num_leaves=31,
        max_depth=-1,
        min_child_samples=120,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.15,
        reg_lambda=1.5,
        random_state=41,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(
        trainer.clean_x(train),
        y,
        sample_weight=trainer.sampling_weight(train),
    )
    cal_score=model.predict_proba(trainer.clean_x(cal))[:,1]
    selected=trainer.select_threshold(
        cal,"labelMfe3",cal_score,trainer.TARGETS["MFE3"]["recallFloor"]
    )
    threshold=float(selected["winner"]["threshold"])
    return model,threshold,selected

def score_query(path:Path)->str:
    base=probe.query_sql(path)
    return base+"""
    SELECT
      symbol,
      ts AS timestamp,
      date,
      tm,
      sessionPart,
      entryTime,
      entryPrice,
      ret1,ret5,ret15,rvol60,dollarAccel5,rangePct,closeLoc,
      distHigh30,distLow30,vwapDist,
      date_diff('minute', CAST(date AS TIMESTAMP)+INTERVAL '4 hours', ts) AS minuteOfSession,
      ln(greatest(close,0.000001)) AS logPrice,
      ln(greatest(priorDollar60,1.0)) AS logPriorDollar,
      CASE
        WHEN sessionPart='PRE' THEN 0
        WHEN sessionPart='REG' THEN 1
        ELSE 2
      END AS sessionCode
    FROM f
    WHERE close>=1.0
      AND priorDollar60>=100000
    ORDER BY symbol,date,ts
    """

def threshold_crossings(path:Path,model,threshold:float)->tuple[pd.DataFrame,dict]:
    con=duckdb.connect()
    reader=con.execute(score_query(path)).fetch_record_batch(BATCH_ROWS)
    rows=[]
    total=0
    selected_states=0
    prev_state={}
    for batch in reader:
        df=batch.to_pandas()
        if df.empty:
            continue
        total+=len(df)
        X=df[trainer.FEATURES].replace([np.inf,-np.inf],np.nan).astype(float)
        score=model.predict_proba(X)[:,1]
        df["score"]=score
        df["above"]=score>=threshold
        selected_states+=int(df["above"].sum())

        for (symbol,date),g in df.groupby(["symbol","date"],sort=False):
            g=g.sort_values("timestamp").copy()
            key=(str(symbol),str(date))
            times=pd.to_datetime(g["timestamp"],errors="coerce")
            above=g["above"].to_numpy(bool)
            prev=np.empty(len(g),dtype=bool)
            gaps=np.ones(len(g),dtype=bool)
            if len(g)>1:
                gaps[1:]=(times.iloc[1:].to_numpy()-times.iloc[:-1].to_numpy())>np.timedelta64(2,"m")
            old=prev_state.get(key)
            if old is not None:
                old_time,old_above=old
                gap0=(pd.Timestamp(times.iloc[0])-pd.Timestamp(old_time))>pd.Timedelta(minutes=2)
                prev[0]=False if gap0 else bool(old_above)
                gaps[0]=gap0
            else:
                prev[0]=False
                gaps[0]=True
            if len(g)>1:
                prev[1:]=above[:-1]
            crossing=above & ((~prev)|gaps)
            if crossing.any():
                hit=g.loc[crossing,[
                    "symbol","timestamp","date","sessionPart","entryTime","entryPrice","score"
                ]].copy()
                rows.append(hit)
            prev_state[key]=(pd.Timestamp(times.iloc[-1]),bool(above[-1]))
    con.close()
    out=pd.concat(rows,ignore_index=True) if rows else pd.DataFrame()
    if len(out):
        out["timestamp"]=pd.to_datetime(out["timestamp"],errors="coerce")
        out["entryTime"]=pd.to_datetime(out["entryTime"],errors="coerce")
        out=out.dropna(subset=["timestamp","entryTime","entryPrice","score"])
        out=out.sort_values(["timestamp","score"],ascending=[True,False]).reset_index(drop=True)
    return out,{
        "scannerStates":int(total),
        "aboveThresholdStates":int(selected_states),
        "thresholdCrossingEvents":int(len(out)),
    }

def exact_outcomes(path:Path,candidates:pd.DataFrame)->pd.DataFrame:
    if candidates.empty:
        return candidates.copy()
    c=candidates.copy().reset_index(drop=True)
    c["candidateId"]=np.arange(len(c),dtype=np.int64)
    c["entryPrice"]=pd.to_numeric(c["entryPrice"],errors="coerce")
    c["fillPrice"]=c["entryPrice"]*(1.0+ENTRY_SLIPPAGE)
    c["entryTime"]=pd.to_datetime(c["entryTime"],errors="coerce")
    c["timestamp"]=pd.to_datetime(c["timestamp"],errors="coerce")

    con=duckdb.connect()
    con.register("cand",c[[
        "candidateId","symbol","timestamp","date","sessionPart",
        "entryTime","entryPrice","fillPrice","score"
    ]])
    q=f"""
    WITH raw AS (
      SELECT
        upper(ticker) AS symbol,
        timezone('America/New_York', timestamp) AS ts,
        CAST(high AS DOUBLE) AS high,
        CAST(low AS DOUBLE) AS low,
        CAST(close AS DOUBLE) AS close
      FROM read_parquet('{path.as_posix()}')
    ),
    bars AS (
      SELECT *
      FROM raw
      WHERE CAST(ts AS TIME)>=TIME '04:00:00'
        AND CAST(ts AS TIME)<TIME '20:00:00'
    ),
    agg AS (
      SELECT
        c.candidateId,
        min(b.ts) FILTER(WHERE b.low<=c.fillPrice*(1.0-{STOP})) AS stopTime,
        min(b.ts) FILTER(WHERE b.high>=c.fillPrice*(1.0+{TARGET})) AS targetTime,
        max(b.high) AS maxHigh,
        min(b.low) AS minLow,
        arg_max(b.close,b.ts) AS lastClose,
        max(b.ts) AS lastTime,
        count(b.ts) AS futureBars
      FROM cand c
      LEFT JOIN bars b
        ON b.symbol=c.symbol
       AND b.ts>=c.entryTime
       AND b.ts<c.entryTime+INTERVAL '{HOLD_MINUTES} minutes'
      GROUP BY c.candidateId
    )
    SELECT c.*,a.stopTime,a.targetTime,a.maxHigh,a.minLow,a.lastClose,a.lastTime,a.futureBars
    FROM cand c
    JOIN agg a USING(candidateId)
    ORDER BY c.timestamp,c.score DESC
    """
    out=con.execute(q).fetchdf()
    con.close()

    if out.empty:
        return out
    stop_time=pd.to_datetime(out["stopTime"],errors="coerce")
    target_time=pd.to_datetime(out["targetTime"],errors="coerce")
    last_time=pd.to_datetime(out["lastTime"],errors="coerce")
    stop_hit=stop_time.notna()
    target_hit=target_time.notna()
    stop_first=stop_hit & (~target_hit | (stop_time<=target_time))
    target_first=target_hit & (~stop_hit | (target_time<stop_time))
    fill=pd.to_numeric(out["fillPrice"],errors="coerce")
    last_close=pd.to_numeric(out["lastClose"],errors="coerce")
    gross=np.where(
        stop_first,-STOP,
        np.where(target_first,TARGET,last_close/fill-1.0)
    )
    out["grossReturn"]=gross
    out["netReturn"]=out["grossReturn"]-ROUND_TRIP_COST
    out["exitTime"]=np.where(
        stop_first,stop_time,
        np.where(target_first,target_time,last_time)
    )
    out["exitReason"]=np.where(
        stop_first,"STOP",
        np.where(target_first,"TARGET","TIME")
    )
    out["MFE"]=pd.to_numeric(out["maxHigh"],errors="coerce")/fill-1.0
    out["MAE"]=1.0-pd.to_numeric(out["minLow"],errors="coerce")/fill
    out["market"]="US_STOCK"
    out["direction"]="LONG"
    out=out[
        (pd.to_numeric(out["futureBars"],errors="coerce").fillna(0)>0)
        &pd.to_datetime(out["exitTime"],errors="coerce").notna()
        &pd.to_numeric(out["netReturn"],errors="coerce").notna()
    ].copy()
    return out

def portfolio_slot_metrics(events:pd.DataFrame,capacity:int)->tuple[dict,pd.DataFrame]:
    if events.empty:
        return {
            "capacity":capacity,"entries":0,"totalReturn":0.0,"profitFactor":0.0,
            "winRate":None,"realizedMdd":0.0,"maxTradeMAE":None,
            "positiveMonthRate":0.0,"months":0,
        },events.copy()

    x=events.copy()
    x["timestamp"]=pd.to_datetime(x["timestamp"],errors="coerce")
    x["entryTime"]=pd.to_datetime(x["entryTime"],errors="coerce")
    x["exitTime"]=pd.to_datetime(x["exitTime"],errors="coerce")
    x=x.sort_values(["timestamp","score"],ascending=[True,False])

    slots=[{"equity":1.0,"available":pd.Timestamp.min,"symbol":None} for _ in range(capacity)]
    active_by_symbol={}
    selected=[]
    events_by_time=list(x.groupby("timestamp",sort=True))
    realized_points=[]

    for signal_time,batch in events_by_time:
        signal_time=pd.Timestamp(signal_time)
        for sym,idx in list(active_by_symbol.items()):
            if slots[idx]["available"]<=signal_time:
                active_by_symbol.pop(sym,None)

        for _,r in batch.iterrows():
            symbol=str(r["symbol"])
            if symbol in active_by_symbol:
                continue
            free=[
                i for i,s in enumerate(slots)
                if s["available"]<=pd.Timestamp(r["entryTime"])
            ]
            if not free:
                continue
            i=max(free,key=lambda z:slots[z]["equity"])
            before=slots[i]["equity"]
            net=float(r["netReturn"])
            slots[i]["equity"]=before*(1.0+net)
            slots[i]["available"]=pd.Timestamp(r["exitTime"])
            slots[i]["symbol"]=symbol
            active_by_symbol[symbol]=i
            row=r.to_dict()
            row["slot"]=i
            row["slotEquityBefore"]=before
            row["slotEquityAfter"]=slots[i]["equity"]
            selected.append(row)
            realized_points.append((pd.Timestamp(r["exitTime"]),float(np.mean([s["equity"] for s in slots]))))

    sel=pd.DataFrame(selected)
    total=float(np.mean([s["equity"] for s in slots])-1.0)
    if len(sel):
        net=pd.to_numeric(sel["netReturn"],errors="coerce").fillna(0.0)
        gains=float(net[net>0].sum())
        losses=float(-net[net<0].sum())
        pf=gains/losses if losses>0 else (math.inf if gains>0 else 0.0)
        win=float((net>0).mean())
        max_mae=float(pd.to_numeric(sel["MAE"],errors="coerce").max())
        sel["exitMonth"]=pd.to_datetime(sel["exitTime"]).dt.to_period("M").astype(str)
        month_returns=[]
        for month,g in sel.groupby("exitMonth",sort=True):
            slot_mult=[]
            for _,sg in g.groupby("slot"):
                slot_mult.append(float(np.prod(1.0+pd.to_numeric(sg["netReturn"],errors="coerce").fillna(0.0))-1.0))
            month_returns.append(float(np.mean(slot_mult)) if slot_mult else 0.0)
        pos_month=float(np.mean(np.array(month_returns)>0)) if month_returns else 0.0
    else:
        pf=0.0;win=None;max_mae=None;month_returns=[];pos_month=0.0

    realized_points=sorted(realized_points,key=lambda z:z[0])
    peak=1.0
    mdd=0.0
    for _,eq in realized_points:
        peak=max(peak,eq)
        if peak>0:
            mdd=max(mdd,(peak-eq)/peak)

    metrics={
        "capacity":capacity,
        "entries":int(len(sel)),
        "totalReturn":total,
        "profitFactor":pf,
        "winRate":win,
        "realizedMdd":float(mdd),
        "maxTradeMAE":max_mae,
        "positiveMonthRate":pos_month,
        "months":int(len(month_returns)),
    }
    return metrics,sel

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    events=pd.read_parquet(args.events)
    model,threshold,cal_selection=fit_mfe3(events)

    month_audits=[]
    ledgers=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for month in FRESH_MONTHS:
            p=root/f"ohlcv_{month}.parquet"
            census._download_us_month(pd.Timestamp(month+"-01",tz="UTC"),p)
            crossings,audit=threshold_crossings(p,model,threshold)
            exact=exact_outcomes(p,crossings)
            audit.update({
                "month":month,
                "exactOutcomeEvents":int(len(exact)),
                "targetExits":int((exact["exitReason"]=="TARGET").sum()) if len(exact) else 0,
                "stopExits":int((exact["exitReason"]=="STOP").sum()) if len(exact) else 0,
                "timeExits":int((exact["exitReason"]=="TIME").sum()) if len(exact) else 0,
            })
            month_audits.append(audit)
            if len(exact):
                ledgers.append(exact)
            print(json.dumps({"monthAudit":audit},ensure_ascii=False),flush=True)
            p.unlink(missing_ok=True)

    ledger=pd.concat(ledgers,ignore_index=True) if ledgers else pd.DataFrame()
    if ledger.empty:
        raise RuntimeError("US_EXACT_REPLAY_NO_EVENTS")
    ledger.to_parquet(out/"exact-signal-ledger.parquet",index=False)

    capacity_rows=[]
    selected_ledgers={}
    for cap in CAPACITIES:
        met,sel=portfolio_slot_metrics(ledger,cap)
        capacity_rows.append(met)
        selected_ledgers[cap]=sel
    pd.DataFrame(capacity_rows).to_csv(out/"capacity-metrics.csv",index=False)

    best=max(
        capacity_rows,
        key=lambda r:(
            bool(r["totalReturn"]>0),
            bool(r["profitFactor"]>1),
            bool(r["positiveMonthRate"]>=0.5),
            -float(r["realizedMdd"]),
            float(r["totalReturn"]),
        )
    )
    best_cap=int(best["capacity"])
    selected_ledgers[best_cap].to_parquet(out/"selected-ledger.parquet",index=False)

    result={
        "schemaVersion":1,
        "contract":"us-all-session-ai-exact-replay-v5",
        "sourceOpportunityRun":37432285496,
        "freshMonths":FRESH_MONTHS,
        "mfe3Threshold":threshold,
        "calibrationSelection":{
            "selectionMode":cal_selection["selectionMode"],
            "recallFloor":cal_selection["recallFloor"],
            "winner":cal_selection["winner"],
        },
        "execution":{
            "entry":"NEXT_1M_OPEN",
            "entrySlippage":ENTRY_SLIPPAGE,
            "targetPct":TARGET,
            "stopPct":STOP,
            "maxHoldMinutes":HOLD_MINUTES,
            "roundTripCost":ROUND_TRIP_COST,
            "sameBarStopFirst":True,
            "direction":"LONG_ONLY",
        },
        "monthAudits":month_audits,
        "rawThresholdCrossingEvents":int(len(ledger)),
        "capacityMetrics":capacity_rows,
        "bestCapacityDiagnostic":best_cap,
        "bestCapacityMetrics":best,
        "truthBoundary":{
            "modelFitUsesTrainOnly":True,
            "thresholdSelectionUsesCalibrationOnly":True,
            "freshOosMonthsExcludedFromFitAndThresholdSelection":True,
            "fullFreshOosMinuteStatesScoredNotNegativeSampleOnly":True,
            "signalIsCausalThresholdCrossingFromBelow":True,
            "entryUsesNextObservedMinuteOpen":True,
            "entrySlippageAppliedBeforeTargetStop":True,
            "stopFirstWhenSameMinuteHitsBoth":True,
            "allSessionPreRegularPostEligible":True,
            "scannerDoesNotPauseForOpenPositions":True,
            "sameSymbolBlockedOnlyWhileItsPositionIsOpen":True,
            "realizedMddDoesNotIncludeIntratradeMarkToMarket":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8"
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
