#!/usr/bin/env python3
import json, duckdb, time

url="https://huggingface.co/datasets/mito0o852/OHLCV-1m/resolve/main/data/ohlcv_2026-03.parquet"
con=duckdb.connect()
con.execute("INSTALL httpfs")
con.execute("LOAD httpfs")
con.execute("SET enable_progress_bar=false")
started=time.time()

schema=con.execute(f"DESCRIBE SELECT * FROM read_parquet('{url}')").fetchall()
sample=con.execute(f"""
SELECT
  min(timestamp) AS min_ts,
  max(timestamp) AS max_ts,
  count(*) AS n,
  count(distinct ticker) AS tickers
FROM read_parquet('{url}')
WHERE timestamp >= TIMESTAMPTZ '2026-03-02 14:30:00+00'
  AND timestamp <  TIMESTAMPTZ '2026-03-02 14:36:00+00'
""").fetchone()
print(json.dumps({
  "schema":schema,
  "sample":{"min":str(sample[0]),"max":str(sample[1]),"rows":sample[2],"tickers":sample[3]},
  "seconds":time.time()-started
},indent=2))
assert sample[2] > 1000
assert sample[3] > 500
