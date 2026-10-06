#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
CENSUS_PATH = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-census-v2.py"
SPEC = importlib.util.spec_from_file_location("census_v2", CENSUS_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("CENSUS_IMPORT_FAILED")
census = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(census)

COST = 0.002
STOP = 0.015
HORIZON = 60


def query_sql(path: Path) -> str:
    return f"""
    WITH raw AS (
      SELECT
        upper(ticker) AS symbol,
        timezone('America/New_York', timestamp) AS ts,
        CAST(open AS DOUBLE) AS open,
        CAST(high AS DOUBLE) AS high,
        CAST(low AS DOUBLE) AS low,
        CAST(close AS DOUBLE) AS close,
        CAST(volume AS DOUBLE) AS volume
      FROM read_parquet('{path.as_posix()}')
      WHERE open > 0 AND close > 0 AND volume >= 0
    ),
    session AS (
      SELECT
        *,
        CAST(ts AS DATE) AS date,
        CAST(ts AS TIME) AS tm,
        close * volume AS dollar
      FROM raw
      WHERE CAST(ts AS TIME) >= TIME '04:00:00'
        AND CAST(ts AS TIME) < TIME '20:00:00'
        AND regexp_matches(symbol,'^[A-Z][A-Z0-9.\\-]{{0,9}}$')
    ),
    w AS (
      SELECT
        *,
        lag(close,1) OVER (PARTITION BY symbol,date ORDER BY ts) AS c1,
        lag(close,5) OVER (PARTITION BY symbol,date ORDER BY ts) AS c5,
        lag(close,15) OVER (PARTITION BY symbol,date ORDER BY ts) AS c15,
        avg(dollar) OVER (
          PARTITION BY symbol,date ORDER BY ts
          ROWS BETWEEN 60 PRECEDING AND 1 PRECEDING
        ) AS priorDollar60,
        avg(dollar) OVER (
          PARTITION BY symbol,date ORDER BY ts
          ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING
        ) AS priorDollar5,
        max(high) OVER (
          PARTITION BY symbol,date ORDER BY ts
          ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS priorHigh30,
        min(low) OVER (
          PARTITION BY symbol,date ORDER BY ts
          ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS priorLow30,
        sum(dollar) OVER (
          PARTITION BY symbol,date ORDER BY ts
          ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) / nullif(
          sum(volume) OVER (
            PARTITION BY symbol,date ORDER BY ts
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
          ),0
        ) AS vwap30,
        lead(open,1) OVER (PARTITION BY symbol,date ORDER BY ts) AS entryPrice,
        max(high) OVER (
          PARTITION BY symbol,date ORDER BY ts
          ROWS BETWEEN 1 FOLLOWING AND {HORIZON} FOLLOWING
        ) AS futureHigh,
        min(low) OVER (
          PARTITION BY symbol,date ORDER BY ts
          ROWS BETWEEN 1 FOLLOWING AND {HORIZON} FOLLOWING
        ) AS futureLow
      FROM session
    ),
    f AS (
      SELECT
        *,
        close/nullif(c1,0)-1 AS ret1,
        close/nullif(c5,0)-1 AS ret5,
        close/nullif(c15,0)-1 AS ret15,
        dollar/nullif(priorDollar60,0) AS rvol60,
        priorDollar5/nullif(priorDollar60,0) AS dollarAccel5,
        (high-low)/nullif(close,0) AS rangePct,
        (close-low)/nullif(high-low,0) AS closeLoc,
        close/nullif(priorHigh30,0)-1 AS distHigh30,
        close/nullif(priorLow30,0)-1 AS distLow30,
        close/nullif(vwap30,0)-1 AS vwapDist,
        CASE
          WHEN tm < TIME '09:30:00' THEN 'PRE'
          WHEN tm < TIME '16:00:00' THEN 'REG'
          ELSE 'POST'
        END AS sessionPart
      FROM w
      WHERE entryTime IS NOT NULL
        AND entryPrice IS NOT NULL
        AND entryTime <= ts + INTERVAL '2 minutes'
        AND futureHigh IS NOT NULL
        AND futureLow IS NOT NULL
        AND priorDollar60 IS NOT NULL
        AND priorHigh30 IS NOT NULL
        AND priorLow30 IS NOT NULL
    )
    """


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", required=True, help="YYYY-MM")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    month = pd.Timestamp(args.month + "-01", tz="UTC")
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / f"ohlcv_{args.month}.parquet"
        census._download_us_month(month, p)
        con = duckdb.connect()
        base = query_sql(p)

        stats_sql = base + f"""
        SELECT
          count(*) AS scannerStates,
          count(DISTINCT symbol) AS symbols,
          count(*) FILTER (WHERE futureHigh >= entryPrice*1.03) AS mfe3States,
          count(*) FILTER (WHERE futureHigh >= entryPrice*1.05) AS mfe5States,
          count(*) FILTER (WHERE futureHigh >= entryPrice*1.10) AS mfe10States,
          count(*) FILTER (
            WHERE futureHigh >= entryPrice*1.03
              AND futureLow > entryPrice*(1.0-{STOP})
          ) AS strict3NoStopStates,
          count(*) FILTER (
            WHERE futureHigh >= entryPrice*1.05
              AND futureLow > entryPrice*(1.0-{STOP})
          ) AS strict5NoStopStates,
          count(*) FILTER (
            WHERE tm >= TIME '09:30:00'
              AND tm < TIME '09:35:00'
              AND futureHigh >= entryPrice*1.03
          ) AS opening5mMfe3States,
          count(*) FILTER (
            WHERE NOT (tm >= TIME '09:30:00' AND tm < TIME '09:35:00')
              AND futureHigh >= entryPrice*1.03
          ) AS outsideOpening5mMfe3States,
          count(*) FILTER (
            WHERE tm >= TIME '09:30:00'
              AND tm < TIME '09:45:00'
              AND futureHigh >= entryPrice*1.03
          ) AS opening15mMfe3States,
          count(DISTINCT symbol || ':' || CAST(date AS VARCHAR) || ':' || CAST(floor(epoch(ts)/900) AS VARCHAR))
            FILTER (WHERE futureHigh >= entryPrice*1.03)
            AS mfe3Symbol15mBuckets
        FROM f
        WHERE close >= 1.0
          AND priorDollar60 >= 100000
        """
        row = con.execute(stats_sql).fetchone()
        cols = [d[0] for d in con.description]
        stats = dict(zip(cols,row))

        parts_sql = base + f"""
        SELECT
          sessionPart,
          count(*) AS scannerStates,
          count(*) FILTER (WHERE futureHigh >= entryPrice*1.03) AS mfe3States,
          count(*) FILTER (
            WHERE futureHigh >= entryPrice*1.03
              AND futureLow > entryPrice*(1.0-{STOP})
          ) AS strict3NoStopStates
        FROM f
        WHERE close >= 1.0
          AND priorDollar60 >= 100000
        GROUP BY sessionPart
        ORDER BY sessionPart
        """
        parts_df = con.execute(parts_sql).fetchdf()

        sample_sql = base + f"""
        SELECT
          symbol,ts,entryTime,date,sessionPart,close,entryPrice,futureHigh,futureLow,
          ret1,ret5,ret15,rvol60,dollarAccel5,rangePct,closeLoc,
          distHigh30,distLow30,vwapDist,
          futureHigh/entryPrice-1 AS forwardMFE,
          1-futureLow/entryPrice AS forwardMAE
        FROM f
        WHERE close >= 1.0
          AND priorDollar60 >= 100000
          AND futureHigh >= entryPrice*1.03
        ORDER BY ts,symbol
        LIMIT 20000
        """
        sample = con.execute(sample_sql).fetchdf()
        con.close()

    parts_df.to_csv(out / "session-parts.csv", index=False)
    sample.to_parquet(out / "mfe3-event-sample.parquet", index=False)

    result = {
        "schemaVersion": 1,
        "contract": "us-all-session-opportunity-probe-v1",
        "month": args.month,
        "sessionWindowET": "04:00-20:00",
        "barResolution": "1m",
        "forwardHorizonMinutes": HORIZON,
        "stopReferencePct": STOP,
        "roundTripCostReference": COST,
        "stats": {k: int(v) if v is not None else None for k,v in stats.items()},
        "sessionParts": parts_df.to_dict("records"),
        "sampleRows": int(len(sample)),
        "truthBoundary": {
            "allMinuteStatesScannedWithinSessionWindow": True,
            "notOpeningOnly": True,
            "preRegularPostAllIncluded": True,
            "opening5mReportedSeparatelyFromRestOfSession": True,
            "signalStateUsesCurrentAndPastBarsOnly": True,
            "forwardHighLowUsesClockTimeRangeNotRowCount": True,
            "nextEntryBarMustArriveWithinTwoClockMinutes": True,
            "forwardHighLowUsedOnlyAsLabel": True,
            "strictNoStopLabelIsConservativeNotExactPathOrder": True,
            "notYetATradingStrategy": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": result}, ensure_ascii=False, default=str), flush=True)


if __name__ == "__main__":
    main()
