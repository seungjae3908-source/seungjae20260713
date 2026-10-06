#!/usr/bin/env python3
from __future__ import annotations
import argparse, importlib.util, json, tempfile
from pathlib import Path
import pandas as pd, polars as pl, duckdb

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    s=importlib.util.spec_from_file_location(name,path)
    if s is None or s.loader is None: raise RuntimeError("IMPORT_FAILED:"+name)
    m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m

v3=load("us_v3",ROOT/"market-prediction-lab/scripts/run-hunter-us-intraday-v3c.py")
common=load("common",ROOT/"market-prediction-lab/scripts/hunter_v3_common.py")
BOUNDARY=pd.Timestamp("2025-04-01").date()
COST=0.002
TARGET=0.05

def path_execute(candidates: pl.DataFrame)->pl.DataFrame:
    outputs=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        candidates=candidates.with_columns([
            pl.col("date").cast(pl.Date),
            pl.col("s5_close").cast(pl.Float64).alias("entryPrice"),
            pl.col("prevRange").mul(0.8).clip(0.012,0.035).alias("stopPct"),
        ])
        for month in v3.census._month_iter(v3.census.START,v3.census.END_EXCLUSIVE):
            start=month.date()
            nxt=(month+pd.offsets.MonthBegin(1)).date()
            cm=candidates.filter((pl.col("date")>=pl.lit(start))&(pl.col("date")<pl.lit(nxt)))
            if cm.is_empty(): continue
            p=root/f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            v3.census._download_us_month(month,p)
            con=duckdb.connect()
            con.register("cand",cm.select(["symbol","date","entryPrice","stopPct","score"]).to_arrow())
            q=f"""
            WITH b AS (
              SELECT upper(ticker) AS symbol,
                     timezone('America/New_York', timestamp) AS ts,
                     CAST(high AS DOUBLE) AS px_high,
                     CAST(low AS DOUBLE) AS px_low,
                     CAST(close AS DOUBLE) AS px_close
              FROM read_parquet('{p.as_posix()}')
            ),
            post AS (
              SELECT b.*, CAST(ts AS DATE) AS date,
                     c.entryPrice, c.stopPct, c.score
              FROM b
              JOIN cand c ON b.symbol=c.symbol AND CAST(b.ts AS DATE)=c.date
              WHERE CAST(b.ts AS TIME)>=TIME '09:40:00'
                AND CAST(b.ts AS TIME)<TIME '16:00:00'
            )
            SELECT
              symbol,date,entryPrice,stopPct,score,
              min(ts) FILTER (WHERE px_low <= entryPrice*(1.0-stopPct)) AS stop_ts,
              min(ts) FILTER (WHERE px_high >= entryPrice*(1.0+{TARGET})) AS target_ts,
              arg_max(px_close,ts) AS eod_close
            FROM post
            GROUP BY symbol,date,entryPrice,stopPct,score
            """
            o=pl.from_arrow(con.execute(q).fetch_arrow_table()); con.close()
            if o.height: outputs.append(o)
            print(json.dumps({"month":month.strftime("%Y-%m"),"candidates":cm.height,"executed":o.height}),flush=True)
    if not outputs: raise RuntimeError("NO_US_V4_PATH_RESULTS")
    x=pl.concat(outputs,how="vertical_relaxed")
    stop_first=pl.col("stop_ts").is_not_null() & (pl.col("target_ts").is_null() | (pl.col("stop_ts")<=pl.col("target_ts")))
    target_first=pl.col("target_ts").is_not_null() & ~stop_first
    exit_price=(pl.when(stop_first).then(pl.col("entryPrice")*(1-pl.col("stopPct")))
                .when(target_first).then(pl.col("entryPrice")*(1+TARGET))
                .otherwise(pl.col("eod_close")))
    gross=exit_price/pl.col("entryPrice")-1
    return x.with_columns([
        pl.col("date").cast(pl.Datetime).alias("tradeTime"),
        exit_price.alias("exitPrice"),
        gross.alias("grossReturn"),
        (gross-COST).alias("netReturn"),
        pl.when(stop_first).then(pl.lit("STOP"))
          .when(target_first).then(pl.lit("TP5"))
          .otherwise(pl.lit("EOD")).alias("exitReason"),
        pl.lit("GAP_RVOL_TOP3_TP5").alias("candidate"),
    ])

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--out-dir",required=True); a=ap.parse_args()
    out=Path(a.out_dir); out.mkdir(parents=True,exist_ok=True)
    raw,audits=v3.load_days()
    x=v3.prepare(raw)
    picked=(x.filter(v3.mask("GAP_RVOL"))
            .sort(["date","score"],descending=[False,True])
            .group_by("date",maintain_order=True).head(3))
    path=path_execute(picked).sort(["date","symbol"])
    train=path.filter(pl.col("date")<pl.lit(BOUNDARY))
    held=path.filter(pl.col("date")>=pl.lit(BOUNDARY))
    tm=common.metrics(train,"US_STOCK")
    hm=common.metrics(held,"US_STOCK")
    fm=common.metrics(path,"US_STOCK")
    gate=common.gate(hm)
    path.write_csv(out/"path-ledger.csv")
    summary={
      "schemaVersion":1,"contract":"hunter-us-path-diagnostic-v4","market":"US_STOCK",
      "candidate":"GAP_RVOL_TOP3_TP5","targetPct":TARGET,
      "execution":{"entry":"09:40 ET proxy from second 5m close","path":"chronological 1m bars after 09:40","sameMinuteTie":"STOP_FIRST","roundTripCost":COST},
      "trainFirstTwoYears":tm,"heldoutLastYear":hm,"observedThreeYear":fm,"heldoutGate":gate,
      "truthBoundary":{"signalRefit":False,"heldoutUsedForSelection":False,"pathOrderingImproved":True,"profitabilityProven":False,"executionAuthority":"NONE"}
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)
if __name__=="__main__":main()
