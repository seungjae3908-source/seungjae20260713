#!/usr/bin/env python3
from __future__ import annotations
import json,tempfile
from pathlib import Path
import duckdb,pandas as pd,polars as pl
from huggingface_hub import hf_hub_download,list_repo_files
import importlib.util

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("census",ROOT/"market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")
if spec is None or spec.loader is None: raise RuntimeError("CENSUS_IMPORT_FAILED")
census=importlib.util.module_from_spec(spec);spec.loader.exec_module(census)

def emit(kind,**kw): print(json.dumps({"kind":kind,**kw},ensure_ascii=False),flush=True)

def crypto():
    files=list_repo_files("rogerdehe/klines-binance",repo_type="dataset")
    for market,file in [
        ("SPOT","spot/5m/BTC_USDT.parquet"),
        ("FUTURES","futures/5m/BTC_USDT_USDT.parquet"),
    ]:
        p=hf_hub_download(repo_id="rogerdehe/klines-binance",repo_type="dataset",filename=file)
        x=pl.read_parquet(p)
        emit("crypto_schema",market=market,file=file,rows=x.height,columns=x.columns,dtypes=[str(d) for d in x.dtypes],
             first=str(x["date"].min()) if "date" in x.columns else None,last=str(x["date"].max()) if "date" in x.columns else None)
    rel=[f for f in files if "BTC" in f.upper() and ("funding" in f.lower() or "open_interest" in f.lower() or "oi" in f.lower())]
    emit("crypto_aux_files",count=len(rel),preview=rel[:80])

def us():
    month=pd.Timestamp("2025-03-01",tz="UTC")
    with tempfile.TemporaryDirectory() as td:
        p=Path(td)/"us.parquet";census._download_us_month(month,p)
        con=duckdb.connect()
        q=f"""
        WITH b AS (
          SELECT upper(ticker) symbol, timezone('America/New_York', timestamp) ts, CAST(volume AS DOUBLE) volume
          FROM read_parquet('{p.as_posix()}')
        )
        SELECT
          count(*) AS all_rows,
          count(*) FILTER(WHERE CAST(ts AS TIME)>=TIME '04:00:00' AND CAST(ts AS TIME)<TIME '09:30:00') AS premarket_rows,
          count(*) FILTER(WHERE CAST(ts AS TIME)>=TIME '09:30:00' AND CAST(ts AS TIME)<TIME '16:00:00') AS regular_rows,
          count(DISTINCT symbol) FILTER(WHERE CAST(ts AS TIME)>=TIME '04:00:00' AND CAST(ts AS TIME)<TIME '09:30:00') AS premarket_symbols,
          sum(volume) FILTER(WHERE CAST(ts AS TIME)>=TIME '04:00:00' AND CAST(ts AS TIME)<TIME '09:30:00') AS premarket_volume
        FROM b
        """
        row=con.execute(q).fetchone()
        samples=con.execute(f"""
          WITH b AS (
            SELECT upper(ticker) symbol, timezone('America/New_York', timestamp) ts, CAST(volume AS DOUBLE) volume
            FROM read_parquet('{p.as_posix()}')
          )
          SELECT symbol,count(*) bars,sum(volume) volume
          FROM b
          WHERE CAST(ts AS TIME)>=TIME '04:00:00' AND CAST(ts AS TIME)<TIME '09:30:00'
          GROUP BY symbol ORDER BY volume DESC LIMIT 20
        """).fetchall()
        con.close()
        emit("us_premarket",month="2025-03",allRows=row[0],premarketRows=row[1],regularRows=row[2],premarketSymbols=row[3],premarketVolume=row[4],topSymbols=samples)

def main():
    crypto();us()
if __name__=="__main__":main()
