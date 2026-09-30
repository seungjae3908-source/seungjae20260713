#!/usr/bin/env python3
import json, requests, sys

URLS = [
  "https://huggingface.co/datasets/mito0o852/OHLCV-1m/resolve/main/data/ohlcv_2026-03.parquet",
  "https://huggingface.co/datasets/ggaddam/OHLCV-1m/resolve/main/data/ohlcv_2025-03.parquet",
]

headers={"User-Agent":"market-prediction-lab/intraday-probe","Range":"bytes=0-65535"}
results=[]
for url in URLS:
    try:
        r=requests.get(url,headers=headers,timeout=60,allow_redirects=True)
        results.append({
            "url":url,
            "status":r.status_code,
            "contentType":r.headers.get("content-type"),
            "contentLength":r.headers.get("content-length"),
            "contentRange":r.headers.get("content-range"),
            "acceptRanges":r.headers.get("accept-ranges"),
            "bytesRead":len(r.content),
            "finalUrl":r.url,
            "prefix":r.content[:4].hex(),
        })
    except Exception as e:
        results.append({"url":url,"error":str(e)})
print(json.dumps(results,indent=2))
ok=any(x.get("status") in (200,206) and x.get("prefix")=="50415231" for x in results)
raise SystemExit(0 if ok else 2)
