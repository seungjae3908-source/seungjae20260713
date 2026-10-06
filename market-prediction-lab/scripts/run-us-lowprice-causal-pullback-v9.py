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

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None: raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

census=load("census_v2","market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")

START=pd.Timestamp("2023-04-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01",tz="UTC")
CAL_END=pd.Timestamp("2025-04-01",tz="UTC")
VAL_END=pd.Timestamp("2026-01-01",tz="UTC")
END=pd.Timestamp("2026-04-01",tz="UTC")

TARGET=0.03
STOP=0.015
ENTRY_SLIPPAGE=0.0025
ROUND_TRIP_COST=0.0030
EXTRA_STRESS=0.0010
HOLD_MINUTES=60

PRIOR_DOLLAR=(1_000_000.0,5_000_000.0)
GAPS=(0.10,0.20)
VOL_ACCEL=(1.10,1.50)
PULLBACK_DEPTH=(0.03,0.05)
CUM_DOLLAR=(100_000.0,500_000.0)
TOP_NS=(1,3,5)

def period_of(ts):
    t=pd.to_datetime(ts,utc=True)
    return np.select(
        [t<TRAIN_END,t<CAL_END,t<VAL_END,t<END],
        ["train","calibration","validation","fresh_oos"],
        default="outside",
    )

def daily_current(path:Path)->pd.DataFrame:
    con=duckdb.connect()
    q=f"""
    WITH b AS (
      SELECT
        upper(ticker) symbol,
        timezone('America/New_York',timestamp) local_ts,
        CAST(open AS DOUBLE) AS px_open,
        CAST(close AS DOUBLE) AS px_close,
        CAST(volume AS DOUBLE) AS px_volume
      FROM read_parquet('{path.as_posix()}')
      WHERE open>0 AND close>0 AND volume>=0
    ),
    r AS (
      SELECT *,CAST(local_ts AS DATE) date,CAST(local_ts AS TIME) tm
      FROM b
      WHERE CAST(local_ts AS TIME)>=TIME '09:30:00'
        AND CAST(local_ts AS TIME)<TIME '16:00:00'
        AND regexp_matches(symbol,'^[A-Z][A-Z0-9.\\-]{{0,9}}$')
    )
    SELECT symbol,date,
      arg_max(px_close,local_ts) AS close_px,
      sum(px_close*px_volume) AS dollar
    FROM r GROUP BY symbol,date
    ORDER BY symbol,date
    """
    df=con.execute(q).df();con.close()
    return df.rename(columns={"close_px":"close"})

def attach_previous(daily:pd.DataFrame,last_by_symbol:dict[str,tuple[float,float]]):
    x=daily.sort_values(["symbol","date"]).copy()
    x["prevClose"]=x.groupby("symbol")["close"].shift(1)
    x["prevDollar"]=x.groupby("symbol")["dollar"].shift(1)
    first=x.groupby("symbol",sort=False).head(1).index
    for idx in first:
        sym=str(x.at[idx,"symbol"])
        prev=last_by_symbol.get(sym)
        if prev is not None:
            x.at[idx,"prevClose"]=float(prev[0])
            x.at[idx,"prevDollar"]=float(prev[1])
    x=x.dropna(subset=["prevClose","prevDollar"])
    return x[["symbol","date","prevClose","prevDollar"]]

def update_last(daily:pd.DataFrame,last_by_symbol:dict[str,tuple[float,float]]):
    if daily.empty:return
    for r in daily.sort_values(["symbol","date"]).groupby("symbol",sort=False).tail(1).itertuples(index=False):
        last_by_symbol[str(r.symbol)]=(float(r.close),float(r.dollar))

def month_events(path:Path, prev_daily:pd.DataFrame, month:str)->pd.DataFrame:
    con=duckdb.connect()
    con.register("prev_daily",prev_daily)
    q=f"""
    WITH raw0 AS (
      SELECT
        upper(ticker) symbol,
        timezone('America/New_York',timestamp) ts,
        CAST(open AS DOUBLE) AS px_open,
        CAST(high AS DOUBLE) AS px_high,
        CAST(low AS DOUBLE) AS px_low,
        CAST(close AS DOUBLE) AS px_close,
        CAST(volume AS DOUBLE) AS px_volume
      FROM read_parquet('{path.as_posix()}')
      WHERE open>0 AND high>0 AND low>0 AND close>0 AND volume>=0
    ),
    raw AS (
      SELECT *,
        CAST(ts AS DATE) date,
        CAST(ts AS TIME) tm,
        CASE
          WHEN CAST(ts AS TIME)>=TIME '04:00:00' AND CAST(ts AS TIME)<TIME '09:30:00' THEN 'PRE'
          WHEN CAST(ts AS TIME)>=TIME '09:30:00' AND CAST(ts AS TIME)<TIME '16:00:00' THEN 'REG'
          WHEN CAST(ts AS TIME)>=TIME '16:00:00' AND CAST(ts AS TIME)<TIME '20:00:00' THEN 'POST'
          ELSE NULL
        END sessionPart
      FROM raw0
      WHERE CAST(ts AS TIME)>=TIME '04:00:00' AND CAST(ts AS TIME)<TIME '20:00:00'
        AND regexp_matches(symbol,'^[A-Z][A-Z0-9.\\-]{{0,9}}$')
    ),
    j AS (
      SELECT r.*,p.prevClose,p.prevDollar,
        sum(r.px_close*r.px_volume) OVER (PARTITION BY r.symbol,r.date ORDER BY r.ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) cumDollar,
        max(r.px_high) OVER (PARTITION BY r.symbol,r.date ORDER BY r.ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) runningHigh,
        sum(((r.px_high+r.px_low+r.px_close)/3.0)*r.px_volume) OVER (PARTITION BY r.symbol,r.date ORDER BY r.ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
          / nullif(sum(r.px_volume) OVER (PARTITION BY r.symbol,r.date ORDER BY r.ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),0) vwap,
        max(r.px_high) OVER (PARTITION BY r.symbol,r.date ORDER BY r.ts ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING) prior3High,
        avg(r.px_volume) OVER (PARTITION BY r.symbol,r.date ORDER BY r.ts ROWS BETWEEN 10 PRECEDING AND 1 PRECEDING) prior10Vol,
        avg(r.px_close*r.px_volume) OVER (PARTITION BY r.symbol,r.date ORDER BY r.ts ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) prior20DollarPerMin,
        lead(r.px_open) OVER (PARTITION BY r.symbol,r.date ORDER BY r.ts) nextOpen,
        lead(r.ts) OVER (PARTITION BY r.symbol,r.date ORDER BY r.ts) nextTs
      FROM raw r
      JOIN prev_daily p ON p.symbol=r.symbol AND p.date=r.date
    ),
    state0 AS (
      SELECT *,
        px_close/prevClose-1.0 gapPct,
        px_close/runningHigh-1.0 drawdown,
        px_volume/nullif(prior10Vol,0) volumeAccel,
        (px_close*px_volume)/nullif(prior20DollarPerMin,0) dollarAccel,
        (px_close-px_low)/nullif(px_high-px_low,0) closeLoc
      FROM j
      WHERE prevClose BETWEEN 0.50 AND 20.0
        AND prevDollar>=1000000
    ),
    state AS (
      SELECT *,
        min(drawdown) OVER (PARTITION BY symbol,date ORDER BY ts ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) recentMinDrawdown
      FROM state0
    ),
    broad AS (
      SELECT *,
        (
          gapPct*2.0
          +ln(1+greatest(cumDollar,0)/100000.0)*0.20
          +ln(1+greatest(volumeAccel,0))*0.20
          +greatest(-recentMinDrawdown,0)*2.0
          +coalesce(closeLoc,0.5)*0.20
        ) score
      FROM state
      WHERE gapPct>=0.10
        AND cumDollar>=100000
        AND recentMinDrawdown<=-0.03
        AND recentMinDrawdown>=-0.15
        AND px_close>prior3High
        AND px_close>=vwap
        AND volumeAccel>=1.10
        AND px_close>=runningHigh*0.97
        AND nextOpen>0 AND nextTs IS NOT NULL
    ),
    onset AS (
      SELECT *
      FROM broad
      QUALIFY row_number() OVER(PARTITION BY symbol,date ORDER BY ts)=1
    ),
    e AS (
      SELECT
        row_number() OVER(ORDER BY ts,symbol)-1 eventId,
        symbol,date,ts signalTime,sessionPart,
        prevClose,prevDollar,gapPct,cumDollar,volumeAccel,dollarAccel,
        -recentMinDrawdown pullbackDepth,closeLoc,score,
        nextTs entryTime,nextOpen*(1.0+{ENTRY_SLIPPAGE}) entryPrice
      FROM onset
    ),
    f AS (
      SELECT
        e.eventId,
        min(r.ts) FILTER(WHERE r.px_high>=e.entryPrice*(1.0+{TARGET})) firstTargetTs,
        min(r.ts) FILTER(WHERE r.px_low<=e.entryPrice*(1.0-{STOP})) firstStopTs,
        arg_max(r.px_close,r.ts) lastClose,
        max(r.ts) lastTs,
        max(r.px_high) futureHigh,
        min(r.px_low) futureLow,
        count(r.ts) futureBars
      FROM e
      LEFT JOIN raw r
        ON r.symbol=e.symbol AND r.date=e.date
       AND r.ts>=e.entryTime
       AND r.ts<e.entryTime+INTERVAL '{HOLD_MINUTES} minutes'
      GROUP BY e.eventId
    )
    SELECT
      e.*,
      '{month}' month,
      CASE
        WHEN f.firstStopTs IS NOT NULL AND (f.firstTargetTs IS NULL OR f.firstStopTs<=f.firstTargetTs)
        THEN -{STOP}-{ROUND_TRIP_COST}
        WHEN f.firstTargetTs IS NOT NULL THEN {TARGET}-{ROUND_TRIP_COST}
        ELSE f.lastClose/e.entryPrice-1.0-{ROUND_TRIP_COST}
      END netReturn,
      f.futureHigh/e.entryPrice-1.0 MFE,
      1.0-f.futureLow/e.entryPrice MAE,
      CASE WHEN f.firstTargetTs IS NOT NULL AND (f.firstStopTs IS NULL OR f.firstTargetTs<f.firstStopTs) THEN 1 ELSE 0 END labelTargetFirst3,
      CASE
        WHEN f.firstStopTs IS NOT NULL AND (f.firstTargetTs IS NULL OR f.firstStopTs<=f.firstTargetTs) THEN 'STOP'
        WHEN f.firstTargetTs IS NOT NULL THEN 'TARGET'
        ELSE 'TIME'
      END exitReason
    FROM e JOIN f USING(eventId)
    WHERE f.futureBars>0 AND f.lastTs IS NOT NULL
    ORDER BY signalTime,symbol
    """
    df=con.execute(q).df();con.close()
    return df

def metrics(df:pd.DataFrame,stress=0.0):
    if df.empty:
        return {"rows":0,"meanNet":0.0,"profitFactor":0.0,"targetFirstRate":0.0,
                "positiveMonths":0,"negativeMonths":0,"positiveActiveMonthRate":0.0}
    net=pd.to_numeric(df["netReturn"],errors="coerce").to_numpy(float)-stress
    y=pd.to_numeric(df["labelTargetFirst3"],errors="coerce").fillna(0).astype(int).to_numpy()
    gp=float(np.maximum(net,0).sum());gl=float(np.maximum(-net,0).sum())
    ms=pd.DataFrame({"month":df["month"].astype(str).to_numpy(),"net":net}).groupby("month")["net"].sum()
    pm=int((ms>0).sum());nm=int((ms<0).sum())
    return {"rows":int(len(df)),"meanNet":float(net.mean()),"profitFactor":float(gp/max(gl,1e-12)),
            "targetFirstRate":float((y==1).mean()),"positiveMonths":pm,"negativeMonths":nm,
            "positiveActiveMonthRate":float(pm/max(pm+nm,1))}

def loose_gate(m,minrows):
    c={"minimumRows":m["rows"]>=minrows,"positiveEV":m["meanNet"]>0,
       "pfAbove1":m["profitFactor"]>1,"positiveMonthsAtLeast50pct":m["positiveActiveMonthRate"]>=0.50}
    return {"pass":all(c.values()),"checks":c}

def s_gate(m,minrows):
    c={"minimumRows":m["rows"]>=minrows,"meanNetAtLeast20bp":m["meanNet"]>=0.0020,
       "pfAtLeast1p5":m["profitFactor"]>=1.50,"targetFirstAtLeast42pct":m["targetFirstRate"]>=0.42,
       "positiveMonthsAtLeast67pct":m["positiveActiveMonthRate"]>=0.67}
    return {"pass":all(c.values()),"checks":c}

def select_family(events:pd.DataFrame):
    reports={}
    for pdol in PRIOR_DOLLAR:
      for gap in GAPS:
       for va in VOL_ACCEL:
        for pb in PULLBACK_DEPTH:
         for cdol in CUM_DOLLAR:
          base=events[
            (events["prevDollar"]>=pdol)&(events["gapPct"]>=gap)&
            (events["volumeAccel"]>=va)&(events["pullbackDepth"]>=pb)&
            (events["cumDollar"]>=cdol)
          ].copy()
          if base.empty:continue
          for topn in TOP_NS:
            z=(base.sort_values(["signalTime","score","symbol"],ascending=[True,False,True])
               .groupby("signalTime",group_keys=False).head(topn).copy())
            z["period"]=period_of(z["signalTime"])
            z=z[z["period"]!="outside"].copy()
            name=f"LP_PD{int(pdol/1e6)}M_G{int(gap*100)}_VA{va:g}_PB{int(pb*100)}_CD{int(cdol/1000)}K_TOP{topn}"
            split={p:z[z["period"]==p].copy() for p in ("train","calibration","validation","fresh_oos")}
            mm={p:metrics(v) for p,v in split.items()}
            stress={p:metrics(v,EXTRA_STRESS) for p,v in split.items()}
            reports[name]={
              "train":mm["train"],"calibration":mm["calibration"],
              "validation":mm["validation"],"freshOos":mm["fresh_oos"],
              "validationPlus10bp":stress["validation"],"freshOosPlus10bp":stress["fresh_oos"],
              "trainGate":loose_gate(mm["train"],75),"calibrationGate":loose_gate(mm["calibration"],25),
              "validationGate":s_gate(mm["validation"],60),"freshOosGate":s_gate(mm["fresh_oos"],25),
              "validationStressGate":s_gate(stress["validation"],60),"freshOosStressGate":s_gate(stress["fresh_oos"],25),
            }
            reports[name]["eligibleAfterCalibration"]=bool(reports[name]["trainGate"]["pass"] and reports[name]["calibrationGate"]["pass"])
    eligible=[k for k,v in reports.items() if v["eligibleAfterCalibration"]]
    selected=max(eligible,key=lambda k:(reports[k]["calibration"]["profitFactor"],reports[k]["calibration"]["meanNet"],reports[k]["calibration"]["targetFirstRate"])) if eligible else None
    s_pass=False
    if selected:
      v=reports[selected]
      s_pass=bool(v["validationGate"]["pass"] and v["freshOosGate"]["pass"] and v["validationStressGate"]["pass"] and v["freshOosStressGate"]["pass"])
    return reports,eligible,selected,s_pass

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--out-dir",required=True);args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    last_by_symbol={}
    frames=[];audits=[]
    with tempfile.TemporaryDirectory() as td:
      root=Path(td)
      for idx,month in enumerate(census._month_iter(START,END),1):
        ms=month.strftime("%Y-%m")
        path=root/f"ohlcv_{ms}.parquet"
        census._download_us_month(month,path)
        daily=daily_current(path)
        prev=attach_previous(daily,last_by_symbol)
        ev=month_events(path,prev,ms) if not prev.empty else pd.DataFrame()
        if not ev.empty:frames.append(ev)
        audits.append({"month":ms,"dailyRows":int(len(daily)),"eligibleDailyRows":int(len(prev)),"events":int(len(ev))})
        update_last(daily,last_by_symbol)
        path.unlink(missing_ok=True)
        print(json.dumps({"usLowpriceMonth":ms,"index":idx,"events":int(len(ev)),"totalEvents":sum(len(x) for x in frames)},ensure_ascii=False),flush=True)
    if not frames:raise RuntimeError("US_LOWPRICE_NO_EVENTS")
    events=pd.concat(frames,ignore_index=True)
    events["signalTime"]=pd.to_datetime(events["signalTime"],utc=True)
    reports,eligible,selected,s_pass=select_family(events)
    events.to_parquet(out/"broad-events.parquet",index=False)
    pd.DataFrame(audits).to_csv(out/"month-audit.csv",index=False)
    result={"schemaVersion":1,"contract":"us-lowprice-causal-pullback-v9","source":census.US_DATASET,
            "broadEventRows":int(len(events)),"symbols":int(events["symbol"].nunique()),
            "candidateCount":len(reports),"eligibleAfterCalibration":eligible,
            "selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,
            "S_PASS":s_pass,
            "truthBoundary":{"lowPriceNotClaimedAsMicrocap":True,"previousCloseAndPreviousDollarOnlyFromCompletedPriorRegularSession":True,
              "signalUsesCurrentAndPriorCompletedMinuteBarsOnly":True,"pullbackMustOccurBeforeRebreak":True,
              "crossSectionTopNUsesSameCompletedTimestampOnly":True,"entryUsesNextMinuteOpenWith25bpSlippage":True,
              "roundTripCost30bpApplied":True,"sameMinuteTargetStopUsesStopFirst":True,
              "trainAndCalibrationOnlySelectFamily":True,"validationAndFreshNeverSelectFamily":True,
              "plus10bpStressRequiredForS":True,"pointInTimeFloatNotUsed":True,"profitabilityProven":s_pass,
              "executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":main()
