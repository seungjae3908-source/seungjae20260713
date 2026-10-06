#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
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
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

census=load(
    "census",
    "market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py",
)

TARGET=0.03
STOP=0.015
HOLD_MINUTES=60
ENTRY_SLIPPAGE=0.0005
ROUND_TRIP_COST=0.002

def exact_path_labels(raw_path:Path, events:pd.DataFrame)->pd.DataFrame:
    x=events.copy().reset_index(drop=True)
    x["eventId"]=np.arange(len(x),dtype=np.int64)
    x["symbol"]=x["symbol"].astype(str).str.upper()
    x["timestamp"]=pd.to_datetime(x["timestamp"],errors="coerce")
    x["entryTime"]=pd.to_datetime(x["entryTime"],errors="coerce")
    x["entryPrice"]=pd.to_numeric(x["entryPrice"],errors="coerce")
    keys=x[["eventId","symbol","timestamp","entryTime","entryPrice"]].copy()
    keys["entryPriceExec"]=keys["entryPrice"]*(1.0+ENTRY_SLIPPAGE)

    con=duckdb.connect()
    con.register("sample_events",keys)
    q=f"""
    WITH bars AS (
      SELECT
        upper(ticker) AS symbol,
        timezone('America/New_York', timestamp) AS ts,
        CAST(open AS DOUBLE) AS open,
        CAST(high AS DOUBLE) AS high,
        CAST(low AS DOUBLE) AS low,
        CAST(close AS DOUBLE) AS close
      FROM read_parquet('{raw_path.as_posix()}')
      WHERE open>0 AND high>0 AND low>0 AND close>0
    ),
    future AS (
      SELECT
        e.eventId,
        e.entryPriceExec,
        min(b.ts) FILTER (
          WHERE b.high >= e.entryPriceExec*(1.0+{TARGET})
        ) AS firstTargetTs,
        min(b.ts) FILTER (
          WHERE b.low <= e.entryPriceExec*(1.0-{STOP})
        ) AS firstStopTs,
        arg_max(b.close,b.ts) AS lastClose,
        max(b.high) AS futureHighExact,
        min(b.low) AS futureLowExact,
        count(*) AS futureBars
      FROM sample_events e
      LEFT JOIN bars b
        ON b.symbol=e.symbol
       AND b.ts>=e.entryTime
       AND b.ts<e.entryTime+INTERVAL '{HOLD_MINUTES} minutes'
      GROUP BY e.eventId,e.entryPriceExec
    )
    SELECT
      eventId,entryPriceExec,firstTargetTs,firstStopTs,lastClose,
      futureHighExact,futureLowExact,futureBars,
      CASE
        WHEN firstTargetTs IS NOT NULL
         AND (firstStopTs IS NULL OR firstTargetTs<firstStopTs)
        THEN 1 ELSE 0
      END AS labelTargetFirst3,
      CASE
        WHEN firstStopTs IS NOT NULL
         AND (firstTargetTs IS NULL OR firstStopTs<=firstTargetTs)
        THEN 'STOP'
        WHEN firstTargetTs IS NOT NULL THEN 'TARGET'
        ELSE 'TIME'
      END AS pathOutcome,
      CASE
        WHEN firstStopTs IS NOT NULL
         AND (firstTargetTs IS NULL OR firstStopTs<=firstTargetTs)
        THEN -{STOP}
        WHEN firstTargetTs IS NOT NULL THEN {TARGET}
        WHEN lastClose IS NOT NULL AND entryPriceExec>0
        THEN lastClose/entryPriceExec-1.0
        ELSE NULL
      END AS exactGrossReturn
    FROM future
    ORDER BY eventId
    """
    labels=con.execute(q).fetchdf()
    con.close()
    labels["exactNetReturn"]=pd.to_numeric(
        labels["exactGrossReturn"],errors="coerce"
    )-ROUND_TRIP_COST
    out=x.merge(labels,on="eventId",how="left")
    out["labelTargetFirst3"]=pd.to_numeric(
        out["labelTargetFirst3"],errors="coerce"
    ).fillna(0).astype("int8")
    return out

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--month",action="append",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    all_events=pd.read_parquet(args.events)
    all_events["month"]=all_events["month"].astype(str)
    frames=[];audits=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for month in args.month:
            src=all_events[all_events["month"]==month].copy()
            if src.empty:
                raise RuntimeError(f"NO_SOURCE_EVENTS:{month}")
            raw=root/f"ohlcv_{month}.parquet"
            census._download_us_month(pd.Timestamp(month+"-01",tz="UTC"),raw)
            labeled=exact_path_labels(raw,src)
            raw.unlink(missing_ok=True)

            usable=labeled["exactNetReturn"].notna()
            pos=labeled["labelTargetFirst3"]==1
            opening=(
                pd.to_numeric(labeled["minuteOfSession"],errors="coerce")
                .between(330,334,inclusive="both")
            )
            audits.append({
                "month":month,
                "period":str(src["period"].iloc[0]),
                "sourceRows":int(len(src)),
                "usablePathRows":int(usable.sum()),
                "coverage":float(usable.mean()),
                "targetFirst3":int(pos.sum()),
                "targetFirst3Rate":float(pos.mean()),
                "opening5TargetFirst3":int((pos&opening).sum()),
                "outsideOpening5TargetFirst3":int((pos&~opening).sum()),
                "outsideOpening5Share":float((pos&~opening).sum()/max(pos.sum(),1)),
                "targetOutcomes":int((labeled["pathOutcome"]=="TARGET").sum()),
                "stopOutcomes":int((labeled["pathOutcome"]=="STOP").sum()),
                "timeOutcomes":int((labeled["pathOutcome"]=="TIME").sum()),
                "meanExactNetReturn":float(
                    pd.to_numeric(labeled["exactNetReturn"],errors="coerce").mean()
                ),
            })
            frames.append(labeled)
            print(json.dumps({"targetFirstMonth":audits[-1]},ensure_ascii=False),flush=True)

    data=pd.concat(frames,ignore_index=True)
    data.to_parquet(out/"events-target-first.parquet",index=False)
    pd.DataFrame(audits).to_csv(out/"month-audit.csv",index=False)
    result={
        "schemaVersion":1,
        "contract":"us-all-session-target-first-label-v8",
        "months":list(args.month),
        "economicAssumptions":{
            "entrySlippage":ENTRY_SLIPPAGE,
            "targetPct":TARGET,
            "stopPct":STOP,
            "maxHoldMinutes":HOLD_MINUTES,
            "roundTripCost":ROUND_TRIP_COST,
            "sameMinuteTargetStopUsesStopFirst":True,
        },
        "sourceRows":int(len(data)),
        "usablePathRows":int(data["exactNetReturn"].notna().sum()),
        "targetFirst3Rows":int(data["labelTargetFirst3"].sum()),
        "audits":audits,
        "truthBoundary":{
            "usesFrozenV3EventSample":True,
            "allMfe3PositiveBucketsRetainedBySource":True,
            "onlyOriginalNoMfe3NegativeBucketsWereDownsampled":True,
            "entryUsesNextMinuteOpenPlusSlippage":True,
            "futurePathUsesTrueOneMinuteHighLow":True,
            "targetStopOrderExplicitlyResolved":True,
            "sameMinuteAmbiguityUsesStopFirst":True,
            "openingTimeNotRequired":True,
            "preRegularPostAllEligible":True,
            "futureDataUsedOnlyForLabelAndEconomicOutcome":True,
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
