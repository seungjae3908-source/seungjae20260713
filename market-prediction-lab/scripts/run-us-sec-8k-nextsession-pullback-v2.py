#!/usr/bin/env python3
from __future__ import annotations

import argparse, importlib.util, json, tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

census=load("census_v2","market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")

START=pd.Timestamp("2023-04-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01",tz="UTC")
CAL_END=pd.Timestamp("2025-04-01",tz="UTC")
VAL_END=pd.Timestamp("2026-04-01",tz="UTC")
END=pd.Timestamp("2026-10-01",tz="UTC")

TARGET=0.03
STOP=0.015
ENTRY_SLIPPAGE=0.0015
ROUND_TRIP_COST=0.0030
EXTRA_STRESS=0.0010
HOLD_MINUTES=90

RVOL=(1.5,2.0,3.0)
CUM_DOLLAR=(250_000.0,1_000_000.0,5_000_000.0)
PULLBACK=(0.02,0.04,0.06)
TOP_N=(1,3,5)

def period_of(ts):
    t=pd.to_datetime(ts,utc=True)
    return np.select(
        [t<TRAIN_END,t<CAL_END,t<VAL_END,t<END],
        ["train","calibration","validation","fresh_oos"],
        default="outside",
    )

def metrics(df,stress=0.0):
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

def train_gate(m,minrows):
    c={"minimumRows":m["rows"]>=minrows,"positiveEV":m["meanNet"]>0,
       "pfAbove1":m["profitFactor"]>1.0,"positiveMonthsAtLeast50pct":m["positiveActiveMonthRate"]>=0.50}
    return {"pass":all(c.values()),"checks":c}

def calibration_gate(m,minrows):
    c={"minimumRows":m["rows"]>=minrows,"meanNetAtLeast10bp":m["meanNet"]>=0.0010,
       "pfAtLeast1p15":m["profitFactor"]>=1.15,"targetFirstAtLeast35pct":m["targetFirstRate"]>=0.35,
       "positiveMonthsAtLeast50pct":m["positiveActiveMonthRate"]>=0.50}
    return {"pass":all(c.values()),"checks":c}

def s_gate(m,minrows):
    c={"minimumRows":m["rows"]>=minrows,"meanNetAtLeast20bp":m["meanNet"]>=0.0020,
       "pfAtLeast1p5":m["profitFactor"]>=1.50,"targetFirstAtLeast42pct":m["targetFirstRate"]>=0.42,
       "positiveMonthsAtLeast67pct":m["positiveActiveMonthRate"]>=0.67}
    return {"pass":all(c.values()),"checks":c}

def normalize_events(path:Path)->pd.DataFrame:
    e=pd.read_csv(path)
    req={"ticker","filingDate","form","cik"}
    miss=req-set(e.columns)
    if miss: raise RuntimeError(f"SEC8K_REQUIRED_COLUMNS_MISSING:{sorted(miss)}")
    e["ticker"]=e["ticker"].astype(str).str.upper().str.strip()
    e["filingDate"]=pd.to_datetime(e["filingDate"],errors="coerce").dt.date
    e=e.dropna(subset=["ticker","filingDate"]).copy()
    e=e[e["ticker"].str.match(r"^[A-Z][A-Z0-9.\-]{0,9}$",na=False)]
    # Multiple 8-K filings for same ticker/date collapse to one event-day.
    e=e.sort_values(["filingDate","ticker"]).drop_duplicates(["filingDate","ticker"])
    return e

def month_pairs(events:pd.DataFrame,month:pd.Timestamp)->pd.DataFrame:
    # Need filings from up to 7 calendar days before month start to resolve next session.
    start=month.date()
    next_month=(month+pd.offsets.MonthBegin(1)).date()
    lo=(month-pd.Timedelta(days=7)).date()
    return events[(events["filingDate"]>=lo)&(events["filingDate"]<next_month)].copy()

def process_month(path:Path,events:pd.DataFrame,month:str)->pd.DataFrame:
    if events.empty:return pd.DataFrame()
    con=duckdb.connect()
    con.register("events",events[["ticker","filingDate"]])
    q=f"""
    WITH raw0 AS (
      SELECT
        upper(ticker) AS symbol,
        timezone('America/New_York',timestamp) AS ts,
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
        CAST(ts AS DATE) AS tradeDate,
        CAST(ts AS TIME) AS tm
      FROM raw0
      WHERE CAST(ts AS TIME)>=TIME '09:30:00'
        AND CAST(ts AS TIME)<TIME '16:00:00'
    ),
    sessions AS (
      SELECT symbol,tradeDate,min(ts) AS sessionOpenTs
      FROM raw GROUP BY symbol,tradeDate
    ),
    e0 AS (
      SELECT
        upper(e.ticker) AS symbol,
        CAST(e.filingDate AS DATE) AS filingDate,
        min(s.tradeDate) FILTER(WHERE s.tradeDate>CAST(e.filingDate AS DATE)) AS nextTradeDate
      FROM events e
      JOIN sessions s ON s.symbol=upper(e.ticker)
      GROUP BY 1,2
    ),
    e AS (
      SELECT * FROM e0
      WHERE nextTradeDate IS NOT NULL
        AND strftime(nextTradeDate,'%Y-%m')='{month}'
    ),
    j0 AS (
      SELECT r.*,e.filingDate,e.nextTradeDate,
        sum(r.px_close*r.px_volume) OVER (
          PARTITION BY r.symbol,r.tradeDate ORDER BY r.ts
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumDollar,
        max(r.px_high) OVER (
          PARTITION BY r.symbol,r.tradeDate ORDER BY r.ts
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS runningHigh,
        sum(((r.px_high+r.px_low+r.px_close)/3.0)*r.px_volume) OVER (
          PARTITION BY r.symbol,r.tradeDate ORDER BY r.ts
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) / nullif(sum(r.px_volume) OVER (
          PARTITION BY r.symbol,r.tradeDate ORDER BY r.ts
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ),0) AS vwap,
        avg(r.px_volume) OVER (
          PARTITION BY r.symbol,r.tradeDate ORDER BY r.ts
          ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING
        ) AS prior20Vol,
        max(r.px_high) OVER (
          PARTITION BY r.symbol,r.tradeDate ORDER BY r.ts
          ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING
        ) AS prior3High,
        lead(r.px_open) OVER (PARTITION BY r.symbol,r.tradeDate ORDER BY r.ts) AS nextOpen,
        lead(r.ts) OVER (PARTITION BY r.symbol,r.tradeDate ORDER BY r.ts) AS nextTs
      FROM raw r
      JOIN e ON e.symbol=r.symbol AND e.nextTradeDate=r.tradeDate
    ),
    j AS (
      SELECT *,
        px_volume/nullif(prior20Vol,0) AS rvol20,
        px_close/runningHigh-1.0 AS ddFromHigh,
        (px_close-px_low)/nullif(px_high-px_low,0) AS closeLoc
      FROM j0
    ),
    s AS (
      SELECT *,
        min(ddFromHigh) OVER (
          PARTITION BY symbol,tradeDate ORDER BY ts
          ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS recentPullback
      FROM j
    ),
    broad AS (
      SELECT *,
        (
          ln(1+greatest(cumDollar,0)/250000.0)*0.35
          +ln(1+greatest(rvol20,0))*0.30
          +greatest(-recentPullback,0)*3.0
          +coalesce(closeLoc,0.5)*0.20
        ) AS score
      FROM s
      WHERE cumDollar>=250000
        AND rvol20>=1.5
        AND recentPullback<=-0.02
        AND recentPullback>=-0.15
        AND px_close>prior3High
        AND px_close>=vwap
        AND px_close>=runningHigh*0.97
        AND nextOpen>0 AND nextTs IS NOT NULL
    ),
    onset AS (
      SELECT DISTINCT ON (symbol,tradeDate) *
      FROM broad
      ORDER BY symbol,tradeDate,ts
    ),
    sig AS (
      SELECT
        row_number() OVER(ORDER BY ts,symbol)-1 AS eventId,
        symbol,filingDate,tradeDate,ts AS signalTime,
        cumDollar,rvol20,-recentPullback AS pullbackDepth,closeLoc,score,
        nextTs AS entryTime,nextOpen*(1.0+{ENTRY_SLIPPAGE}) AS entryPrice
      FROM onset
    ),
    f AS (
      SELECT
        s.eventId,
        min(r.ts) FILTER(WHERE r.px_high>=s.entryPrice*(1.0+{TARGET})) AS firstTargetTs,
        min(r.ts) FILTER(WHERE r.px_low<=s.entryPrice*(1.0-{STOP})) AS firstStopTs,
        arg_max(r.px_close,r.ts) AS lastClose,
        max(r.px_high) AS futureHigh,
        min(r.px_low) AS futureLow,
        count(*) AS futureBars
      FROM sig s
      LEFT JOIN raw r
        ON r.symbol=s.symbol AND r.tradeDate=s.tradeDate
       AND r.ts>=s.entryTime
       AND r.ts<s.entryTime+INTERVAL '{HOLD_MINUTES} minutes'
      GROUP BY s.eventId
    )
    SELECT
      s.*,'{month}' AS "month",
      CASE
        WHEN f.firstStopTs IS NOT NULL AND (f.firstTargetTs IS NULL OR f.firstStopTs<=f.firstTargetTs)
        THEN -{STOP}-{ROUND_TRIP_COST}
        WHEN f.firstTargetTs IS NOT NULL THEN {TARGET}-{ROUND_TRIP_COST}
        ELSE f.lastClose/s.entryPrice-1.0-{ROUND_TRIP_COST}
      END AS netReturn,
      f.futureHigh/s.entryPrice-1.0 AS MFE,
      1.0-f.futureLow/s.entryPrice AS MAE,
      CASE WHEN f.firstTargetTs IS NOT NULL AND (f.firstStopTs IS NULL OR f.firstTargetTs<f.firstStopTs) THEN 1 ELSE 0 END AS labelTargetFirst3
    FROM sig s JOIN f USING(eventId)
    WHERE f.futureBars>0 AND f.lastClose IS NOT NULL
    ORDER BY signalTime,symbol
    """
    df=con.execute(q).df();con.close()
    return df

def select_family(events):
    reports={}
    for rv in RVOL:
      for cd in CUM_DOLLAR:
       for pb in PULLBACK:
        base=events[(events["rvol20"]>=rv)&(events["cumDollar"]>=cd)&(events["pullbackDepth"]>=pb)].copy()
        if base.empty:continue
        for topn in TOP_N:
          z=(base.sort_values(["signalTime","score","symbol"],ascending=[True,False,True])
             .groupby("signalTime",group_keys=False).head(topn).copy())
          z["period"]=period_of(z["signalTime"])
          z=z[z["period"]!="outside"].copy()
          name=f"SEC8K_RV{rv:g}_CD{int(cd/1000)}K_PB{int(pb*100)}_TOP{topn}"
          sp={p:z[z["period"]==p].copy() for p in ("train","calibration","validation","fresh_oos")}
          mm={p:metrics(v) for p,v in sp.items()}
          ss={p:metrics(v,EXTRA_STRESS) for p,v in sp.items()}
          reports[name]={
            "train":mm["train"],"calibration":mm["calibration"],
            "validation":mm["validation"],"freshOos":mm["fresh_oos"],
            "validationPlus10bp":ss["validation"],"freshOosPlus10bp":ss["fresh_oos"],
            "trainGate":train_gate(mm["train"],100),
            "calibrationGate":calibration_gate(mm["calibration"],40),
            "validationGate":s_gate(mm["validation"],75),
            "freshOosGate":s_gate(mm["fresh_oos"],40),
            "validationStressGate":s_gate(ss["validation"],75),
            "freshOosStressGate":s_gate(ss["fresh_oos"],40),
          }
          reports[name]["eligibleAfterCalibration"]=bool(
            reports[name]["trainGate"]["pass"] and reports[name]["calibrationGate"]["pass"]
          )
    eligible=[k for k,v in reports.items() if v["eligibleAfterCalibration"]]
    selected=max(eligible,key=lambda k:(
        reports[k]["calibration"]["profitFactor"],
        reports[k]["calibration"]["meanNet"],
        reports[k]["calibration"]["targetFirstRate"]
    )) if eligible else None
    s_pass=False
    if selected:
        v=reports[selected]
        s_pass=bool(v["validationGate"]["pass"] and v["freshOosGate"]["pass"] and
                    v["validationStressGate"]["pass"] and v["freshOosStressGate"]["pass"])
    return reports,eligible,selected,s_pass

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    events=normalize_events(Path(args.events))
    frames=[];audit=[]
    with tempfile.TemporaryDirectory() as td:
      root=Path(td)
      for idx,month in enumerate(census._month_iter(START,END),1):
        ms=month.strftime("%Y-%m")
        path=root/f"ohlcv_{ms}.parquet"
        census._download_us_month(month,path)
        em=month_pairs(events,month)
        df=process_month(path,em,ms)
        if not df.empty:frames.append(df)
        audit.append({"month":ms,"eventInputs":int(len(em)),"signalRows":int(len(df))})
        path.unlink(missing_ok=True)
        print(json.dumps({"month":ms,"index":idx,"signalRows":int(len(df)),
                          "totalSignalRows":int(sum(len(x) for x in frames))}),flush=True)
    if not frames: raise RuntimeError("SEC8K_BACKTEST_NO_SIGNALS")
    allx=pd.concat(frames,ignore_index=True)
    allx["signalTime"]=pd.to_datetime(allx["signalTime"],utc=True)
    reports,eligible,selected,s_pass=select_family(allx)
    allx.to_parquet(out/"broad-events.parquet",index=False)
    pd.DataFrame(audit).to_csv(out/"month-audit.csv",index=False)
    result={
      "schemaVersion":1,"contract":"us-sec-8k-nextsession-pullback-v2",
      "sourceProbeRun":37482537143,
      "sourceEventRows":int(len(events)),
      "broadSignalRows":int(len(allx)),
      "symbols":int(allx["symbol"].nunique()),
      "candidateCount":len(reports),
      "eligibleAfterCalibration":eligible,
      "selectedByCalibration":selected,
      "selectedResults":reports.get(selected) if selected else None,
      "S_PASS":s_pass,
      "truthBoundary":{
        "filingDateOnlyNoIntradayFilingTimeUsed":True,
        "sameDayTradingForbidden":True,
        "firstTradeableSessionAfterFilingDateOnly":True,
        "signalUsesCurrentAndPriorCompletedOneMinuteBarsOnly":True,
        "pullbackMustPrecedeRebreak":True,
        "entryUsesNextMinuteOpenWith15bpSlippage":True,
        "roundTripCost30bpApplied":True,
        "sameMinuteTargetStopUsesStopFirst":True,
        "trainAndCalibrationOnlySelectFamily":True,
        "validationAndFreshNeverSelectFamily":True,
        "plus10bpStressRequiredForS":True,
        "currentTickerMapMayHaveSurvivorshipCoverageLimit":True,
        "profitabilityProven":s_pass,
        "executionAuthority":"NONE",
      },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":main()
