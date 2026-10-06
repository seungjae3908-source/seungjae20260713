#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import json
import threading
import time
from collections import deque
from pathlib import Path

import pandas as pd
import requests

BASE="https://api.bitget.com/api/v2/mix/market/history-fund-rate"
PRODUCT_TYPE="usdt-futures"
PAGE_SIZE=100
MAX_PAGES=100
MAX_WORKERS=6
TARGET_VALIDATION_START=pd.Timestamp("2025-04-01T00:00:00Z")
TARGET_FRESH_START=pd.Timestamp("2026-04-01T00:00:00Z")

class Limiter:
    def __init__(self,limit=15,window=1.0):
        self.limit=limit;self.window=window;self.q=deque();self.lock=threading.Lock()
    def acquire(self):
        while True:
            with self.lock:
                now=time.monotonic()
                while self.q and now-self.q[0]>=self.window:self.q.popleft()
                if len(self.q)<self.limit:
                    self.q.append(now);return
                wait=max(0.01,self.window-(now-self.q[0])+0.01)
            time.sleep(wait)

RATE=Limiter()

def fetch_page(symbol,page_no):
    params={
        "symbol":symbol,
        "productType":PRODUCT_TYPE,
        "pageSize":str(PAGE_SIZE),
        "pageNo":str(page_no),
    }
    last=None
    for attempt in range(5):
        try:
            RATE.acquire()
            r=requests.get(BASE,params=params,timeout=30,headers={"User-Agent":"market-prediction-lab/bitget-funding-depth-v410"})
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            p=r.json()
            if str(p.get("code"))!="00000":
                return None,f"CODE:{p.get('code')}:{p.get('msg')}"
            data=p.get("data") or []
            return data,None
        except Exception as exc:
            last=exc;time.sleep(min(0.5*(attempt+1),2.0))
    return None,repr(last)

def probe_symbol(symbol):
    rows=[]
    failures=[]
    empty_page=None
    for page in range(1,MAX_PAGES+1):
        data,err=fetch_page(symbol,page)
        if data is None:
            failures.append({"page":page,"error":err})
            break
        if not data:
            empty_page=page
            break
        for x in data:
            try:
                rows.append({
                    "symbol":str(x.get("symbol") or symbol),
                    "fundingRate":float(x["fundingRate"]),
                    "fundingTime":pd.to_datetime(int(x["fundingTime"]),unit="ms",utc=True),
                })
            except Exception:
                continue
        if rows and min(r["fundingTime"] for r in rows)<=TARGET_VALIDATION_START:
            break
        if len(data)<PAGE_SIZE:
            break

    if not rows:
        return {
            "symbol":symbol,"ok":False,"rows":0,
            "error":failures[-1]["error"] if failures else "EMPTY",
            "failures":failures,
        },[]

    df=pd.DataFrame(rows).drop_duplicates("fundingTime").sort_values("fundingTime")
    earliest=pd.Timestamp(df["fundingTime"].min())
    latest=pd.Timestamp(df["fundingTime"].max())
    return {
        "symbol":symbol,
        "ok":True,
        "rows":int(len(df)),
        "earliest":str(earliest),
        "latest":str(latest),
        "pagesAttempted":int((empty_page-1) if empty_page else min(MAX_PAGES,max(1,(len(rows)+PAGE_SIZE-1)//PAGE_SIZE))),
        "reachesValidationStart":bool(earliest<=TARGET_VALIDATION_START),
        "reachesFreshStart":bool(earliest<=TARGET_FRESH_START),
        "emptyPage":empty_page,
        "failures":failures,
    },df.to_dict("records")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--covered-events",required=True)
    ap.add_argument("--out-dir",required=True)
    ap.add_argument("--symbols",type=int,default=30)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    events=pd.read_parquet(args.covered_events)
    counts=events["symbol"].astype(str).value_counts()
    symbols=[str(x) for x in counts.head(args.symbols).index]
    audits=[];funding=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={pool.submit(probe_symbol,s):s for s in symbols}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            s=futs[fut]
            try:a,rows=fut.result()
            except Exception as exc:a={"symbol":s,"ok":False,"error":repr(exc)};rows=[]
            audits.append(a);funding.extend(rows)
            if idx%5==0 or idx==len(futs):
                print(json.dumps({
                    "fundingDepthComplete":idx,"symbols":len(futs),
                    "reachesValidation":sum(1 for x in audits if x.get("reachesValidationStart")),
                    "reachesFresh":sum(1 for x in audits if x.get("reachesFreshStart")),
                }),flush=True)

    adf=pd.DataFrame(audits)
    adf.to_json(out/"symbol-audit.jsonl",orient="records",lines=True,force_ascii=False)
    if funding:
        pd.DataFrame(funding).to_parquet(out/"funding-sample.parquet",index=False)

    ok=[x for x in audits if x.get("ok")]
    validation=[x for x in ok if x.get("reachesValidationStart")]
    fresh=[x for x in ok if x.get("reachesFreshStart")]
    result={
        "schemaVersion":1,
        "contract":"bitget-funding-history-depth-v410-probe",
        "symbolsRequested":len(symbols),
        "symbolsUsable":len(ok),
        "symbolsReachingValidationStart":len(validation),
        "symbolsReachingFreshStart":len(fresh),
        "usableCoverage":len(ok)/max(len(symbols),1),
        "validationHistoryCoverage":len(validation)/max(len(symbols),1),
        "freshHistoryCoverage":len(fresh)/max(len(symbols),1),
        "earliestOverall":min((x.get("earliest") for x in ok),default=None),
        "latestOverall":max((x.get("latest") for x in ok),default=None),
        "auditPreview":audits[:30],
        "truthBoundary":{
            "bitgetPublicFundingApiOnly":True,
            "topSymbolsChosenByFrozenV48EventFrequency":True,
            "noSignalOrThresholdRetuning":True,
            "probeOnlyNotPnlAudit":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
