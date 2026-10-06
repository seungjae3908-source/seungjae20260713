#!/usr/bin/env python3
from __future__ import annotations
import csv,io,json,zipfile
import requests

URLS={
 "spot5m":"https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/5m/BTCUSDT-5m-2025-03.zip",
 "futures5m":"https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/5m/BTCUSDT-5m-2025-03.zip",
 "futuresMetrics":"https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2025-03-15.zip",
}
def main():
 for name,url in URLS.items():
  r=requests.get(url,timeout=60,headers={"User-Agent":"hunter-v5-probe/1.0"})
  result={"kind":name,"url":url,"status":r.status_code,"bytes":len(r.content)}
  if r.status_code==200:
   z=zipfile.ZipFile(io.BytesIO(r.content))
   result["files"]=z.namelist()
   first=z.namelist()[0]
   text=z.read(first).decode("utf-8-sig",errors="replace").splitlines()
   result["preview"]=text[:4]
  print(json.dumps(result,ensure_ascii=False),flush=True)
if __name__=="__main__":main()
