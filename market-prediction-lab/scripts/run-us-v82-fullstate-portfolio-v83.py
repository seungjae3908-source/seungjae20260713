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
import pyarrow as pa
import pyarrow.parquet as pq
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

probe=load(
    "us_probe_v1",
    "market-prediction-lab/scripts/run-us-all-session-opportunity-probe-v1.py",
)
census=load(
    "census_v2",
    "market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py",
)
v8=load(
    "target_first_v8",
    "market-prediction-lab/scripts/train-us-all-session-target-first-ai-v8.py",
)
common=load(
    "always_on",
    "market-prediction-lab/scripts/always_on_portfolio_replay.py",
)

ENTRY_SLIPPAGE=0.0005
TARGET=0.03
STOP=0.015
HOLD_MINUTES=60
ROUND_TRIP_COST=0.002
BATCH_ROWS=250_000

def frozen_model(events_path:Path):
    data=pd.read_parquet(events_path)
    train=data[data["period"].astype(str)=="train"].copy()
    if train.empty:
        raise RuntimeError("V83_FROZEN_TRAIN_EMPTY")
    y=pd.to_numeric(
        train["labelTargetFirst3"],errors="coerce"
    ).fillna(0).astype(int)
    model=LGBMClassifier(
        objective="binary",
        n_estimators=700,
        learning_rate=0.025,
        num_leaves=31,
        min_child_samples=160,
        subsample=0.80,
        colsample_bytree=0.85,
        reg_alpha=0.25,
        reg_lambda=2.0,
        random_state=97,
        n_jobs=4,
        verbosity=-1,
    )
    model.fit(
        v8.clean_x(train),
        y,
        sample_weight=v8.sampling_weight(train),
    )
    return model,int(len(train))

def full_state_query(raw_path:Path)->str:
    return probe.query_sql(raw_path)+"""
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
      ln(greatest(close,0.000001)) AS logPrice,
      ln(greatest(priorDollar60,1.0)) AS logPriorDollar
    FROM f
    WHERE close>=1.0
      AND priorDollar60>=100000
    ORDER BY timestamp,symbol
    """

def score_full_state(
    raw_path:Path,
    selected_path:Path,
    model,
    threshold:float,
)->dict:
    con=duckdb.connect()
    reader=con.execute(full_state_query(raw_path)).fetch_record_batch(BATCH_ROWS)
    writer=None
    scanned=0
    selected=0
    by_session={"PRE":0,"REG":0,"POST":0}
    opening5=0
    outside5=0

    try:
        for batch in reader:
            df=batch.to_pandas()
            if df.empty:
                continue
            scanned+=len(df)
            score=model.predict_proba(v8.clean_x(df))[:,1]
            mask=score>=threshold
            if not mask.any():
                continue
            s=df.loc[mask].copy()
            s["score"]=score[mask]
            selected+=len(s)
            counts=s["sessionPart"].astype(str).value_counts()
            for k,v in counts.items():
                by_session[str(k)]=by_session.get(str(k),0)+int(v)

            tm=pd.to_datetime(s["timestamp"],errors="coerce")
            minutes=tm.dt.hour*60+tm.dt.minute
            op=(minutes>=9*60+30)&(minutes<9*60+35)
            opening5+=int(op.sum())
            outside5+=int((~op).sum())

            table=pa.Table.from_pandas(
                s[
                    [
                        "symbol","timestamp","date","sessionPart",
                        "entryTime","entryPrice","score",
                    ]
                ],
                preserve_index=False,
            )
            if writer is None:
                writer=pq.ParquetWriter(
                    selected_path,
                    table.schema,
                    compression="zstd",
                )
            writer.write_table(table)
    finally:
        if writer is not None:
            writer.close()
        con.close()

    if selected==0 or not selected_path.exists():
        raise RuntimeError("V83_NO_FULL_STATE_SELECTIONS")
    return {
        "scannerStates":int(scanned),
        "selectedStates":int(selected),
        "selectedShare":float(selected/max(scanned,1)),
        "selectedBySession":by_session,
        "selectedOpening5":int(opening5),
        "selectedOutsideOpening5":int(outside5),
        "selectedOutsideOpening5Share":float(outside5/max(selected,1)),
    }

def exact_outcomes(
    raw_path:Path,
    selected_path:Path,
    exact_path:Path,
)->dict:
    con=duckdb.connect()
    q=f"""
    COPY (
      WITH e AS (
        SELECT
          row_number() OVER () AS eventId,
          upper(symbol) AS symbol,
          CAST(timestamp AS TIMESTAMP) AS timestamp,
          CAST(entryTime AS TIMESTAMP) AS entryTime,
          CAST(entryPrice AS DOUBLE) AS entryPrice,
          CAST(score AS DOUBLE) AS score,
          CAST(entryPrice AS DOUBLE)*(1.0+{ENTRY_SLIPPAGE}) AS entryPriceExec
        FROM read_parquet('{selected_path.as_posix()}')
      ),
      bars AS (
        SELECT
          upper(ticker) AS symbol,
          timezone('America/New_York', timestamp) AS ts,
          CAST(high AS DOUBLE) AS high,
          CAST(low AS DOUBLE) AS low,
          CAST(close AS DOUBLE) AS close
        FROM read_parquet('{raw_path.as_posix()}')
        WHERE high>0 AND low>0 AND close>0
      ),
      f AS (
        SELECT
          e.eventId,e.symbol,e.timestamp,e.entryTime,
          e.entryPrice,e.entryPriceExec,e.score,
          min(b.ts) FILTER (
            WHERE b.high>=e.entryPriceExec*(1.0+{TARGET})
          ) AS firstTargetTs,
          min(b.ts) FILTER (
            WHERE b.low<=e.entryPriceExec*(1.0-{STOP})
          ) AS firstStopTs,
          arg_max(b.close,b.ts) AS lastClose,
          max(b.ts) AS lastTs,
          max(b.high) AS futureHighExact,
          min(b.low) AS futureLowExact,
          count(b.ts) AS futureBars
        FROM e
        LEFT JOIN bars b
          ON b.symbol=e.symbol
         AND b.ts>=e.entryTime
         AND b.ts<e.entryTime+INTERVAL '{HOLD_MINUTES} minutes'
        GROUP BY
          e.eventId,e.symbol,e.timestamp,e.entryTime,
          e.entryPrice,e.entryPriceExec,e.score
      )
      SELECT
        'US_STOCK' AS market,
        timestamp,
        symbol,
        'LONG' AS direction,
        score,
        entryTime,
        CASE
          WHEN firstStopTs IS NOT NULL
           AND (firstTargetTs IS NULL OR firstStopTs<=firstTargetTs)
          THEN firstStopTs
          WHEN firstTargetTs IS NOT NULL THEN firstTargetTs
          ELSE lastTs
        END AS exitTime,
        CASE
          WHEN firstStopTs IS NOT NULL
           AND (firstTargetTs IS NULL OR firstStopTs<=firstTargetTs)
          THEN -{STOP}-{ROUND_TRIP_COST}
          WHEN firstTargetTs IS NOT NULL
          THEN {TARGET}-{ROUND_TRIP_COST}
          WHEN lastClose IS NOT NULL AND entryPriceExec>0
          THEN lastClose/entryPriceExec-1.0-{ROUND_TRIP_COST}
          ELSE NULL
        END AS netReturn,
        futureHighExact/entryPriceExec-1.0 AS MFE,
        1.0-futureLowExact/entryPriceExec AS MAE,
        CASE
          WHEN firstStopTs IS NOT NULL
           AND (firstTargetTs IS NULL OR firstStopTs<=firstTargetTs)
          THEN 'STOP'
          WHEN firstTargetTs IS NOT NULL THEN 'TARGET'
          ELSE 'TIME'
        END AS exitReason,
        CASE
          WHEN firstTargetTs IS NOT NULL
           AND (firstStopTs IS NULL OR firstTargetTs<firstStopTs)
          THEN 1 ELSE 0
        END AS targetFirst3
      FROM f
      WHERE futureBars>0
        AND lastTs IS NOT NULL
    ) TO '{exact_path.as_posix()}' (
      FORMAT PARQUET,
      COMPRESSION ZSTD
    )
    """
    con.execute(q)
    stats=con.execute(
        f"""
        SELECT
          count(*) AS rows,
          count(DISTINCT symbol) AS symbols,
          sum(targetFirst3) AS targetFirst3,
          avg(netReturn) AS meanNet,
          avg(CASE WHEN netReturn>0 THEN 1.0 ELSE 0.0 END) AS positiveRate,
          sum(CASE WHEN exitReason='TARGET' THEN 1 ELSE 0 END) AS targetExits,
          sum(CASE WHEN exitReason='STOP' THEN 1 ELSE 0 END) AS stopExits,
          sum(CASE WHEN exitReason='TIME' THEN 1 ELSE 0 END) AS timeExits
        FROM read_parquet('{exact_path.as_posix()}')
        """
    ).fetchone()
    con.close()
    return {
        "rows":int(stats[0] or 0),
        "symbols":int(stats[1] or 0),
        "targetFirst3":int(stats[2] or 0),
        "meanNet":float(stats[3] or 0),
        "positiveRate":float(stats[4] or 0),
        "targetExits":int(stats[5] or 0),
        "stopExits":int(stats[6] or 0),
        "timeExits":int(stats[7] or 0),
    }

def portfolio_grid(exact_path:Path)->tuple[list[dict],dict]:
    events=pd.read_parquet(
        exact_path,
        columns=[
            "market","timestamp","symbol","direction","score",
            "entryTime","exitTime","netReturn","MFE","MAE",
        ],
    )
    events=events.dropna(
        subset=["timestamp","entryTime","exitTime","netReturn","MFE","MAE"]
    ).copy()
    capacities=(1,3,5,10,20,None)
    rows=[]
    detail={}
    for cap in capacities:
        r=common.replay_always_on(
            events,
            max_positions=cap,
            opportunity_target=TARGET,
        )
        key="UNLIMITED" if cap is None else str(cap)
        detail[key]=r
        rows.append(
            {
                "maxPositions":key,
                "signalEvents":int(r["scanner"]["signalEvents"]),
                "entries":int(r["positions"]["entries"]),
                "reentries":int(r["positions"]["reentriesAfterPriorExit"]),
                "maxConcurrent":int(r["positions"]["maxConcurrent"]),
                "newEntriesWhileOtherOpen":int(
                    r["scanner"]["newEntriesWhileOtherPositionOpen"]
                ),
                "capacityBlocked":int(
                    r["allMissReasons"].get("portfolio_capacity",0)
                ),
                "alreadyOpenSuppressed":int(
                    r["allMissReasons"].get("already_open",0)
                ),
                "watchlistAdds":int(
                    r.get("watchlist",{}).get("capacityBlockedAdds",0)
                ),
                "laterFreshSignalEntries":int(
                    r.get("watchlist",{}).get("entriesOnLaterFreshSignal",0)
                ),
                "bookedNetReturnSum":float(
                    r["positions"]["bookedNetReturnSum"]
                ),
                "positiveEntryRate":r["positions"]["positiveEntryRate"],
            }
        )
    return rows,detail

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--frozen-events",required=True)
    ap.add_argument("--v82-summary",required=True)
    ap.add_argument("--month",default="2026-03")
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()

    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    v82=json.loads(Path(args.v82_summary).read_text(encoding="utf-8"))
    if v82.get("contract")!="us-all-session-target-first-ai-v82-recall":
        raise RuntimeError("V83_WRONG_V82_SUMMARY")
    threshold=float(v82["calibrationSelection"]["winner"]["threshold"])
    if not bool(v82.get("candidatePass")):
        raise RuntimeError("V83_SOURCE_CANDIDATE_NOT_PASS")

    model,train_rows=frozen_model(Path(args.frozen_events))

    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        raw=root/f"ohlcv_{args.month}.parquet"
        selected=root/"selected-full-state.parquet"
        exact=root/"exact-signals.parquet"

        census._download_us_month(
            pd.Timestamp(args.month+"-01",tz="UTC"),
            raw,
        )
        selection_audit=score_full_state(
            raw,selected,model,threshold
        )
        exact_audit=exact_outcomes(
            raw,selected,exact
        )
        grid,detail=portfolio_grid(exact)

    pd.DataFrame(grid).to_csv(out/"capacity-grid.csv",index=False)
    result={
        "schemaVersion":1,
        "contract":"us-v82-fullstate-portfolio-v83",
        "month":args.month,
        "fixedThreshold":threshold,
        "frozenTrainRows":train_rows,
        "sourceV82Holdout":{
            "rowRecall":v82["newHoldout2026_03"]["recall"],
            "eventClusterRecall":v82["newHoldout2026_03"]["eventClusterRecall"],
            "precision":v82["newHoldout2026_03"]["populationWeightedPrecision"],
            "meanNet":v82["newHoldout2026_03"]["populationWeightedMeanNetReturn"],
            "profitFactor":v82["newHoldout2026_03"]["populationWeightedProfitFactor"],
            "candidatePass":v82["candidatePass"],
        },
        "fullStateSelection":selection_audit,
        "selectedExactOutcome":exact_audit,
        "capacityGrid":grid,
        "capacityDetails":detail,
        "truthBoundary":{
            "thresholdFrozenFromV82CalibrationOnly":True,
            "marchFullStateNotUsedForModelOrThresholdSelection":True,
            "allEligibleMarchMinuteStatesScoredBeforePortfolioReplay":True,
            "scannerRunsAcrossPreRegularPost":True,
            "scannerContinuesWhilePositionsOpen":True,
            "sameSymbolFreshSignalsRecheckedAfterCapacityBlock":True,
            "sameSymbolOpenPositionSuppressesDuplicateEntry":True,
            "entryUsesNextMinuteOpenPlusSlippage":True,
            "exactOneMinuteTargetStopPathUsed":True,
            "sameMinuteTargetStopUsesStopFirst":True,
            "roundTripCostIncluded":True,
            "bookedNetReturnSumIsNotCapitalWeightedPortfolioReturn":True,
            "oneMonthReplayCannotProveLongRunProfitability":True,
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
