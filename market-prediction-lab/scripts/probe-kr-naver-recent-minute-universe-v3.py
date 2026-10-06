#!/usr/bin/env python3
from __future__ import annotations

import concurrent.futures
import importlib.util
import json
import re
import time
from pathlib import Path

import pandas as pd
import requests

ROOT=Path(__file__).resolve().parents[2]
P=ROOT/"market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py"
SPEC=importlib.util.spec_from_file_location("census_v2",P)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("CENSUS_IMPORT_FAILED")
census=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(census)

URL="https://api.finance.naver.com/siseJson.naver?symbol={symbol}&requestType=0&count=500&timeframe=minute"
HEADERS={"User-Agent":"Mozilla/5.0 market-prediction-lab/kr-recent-minute-probe"}

def choose_symbols():
    universe,delisted,market_by_symbol,meta=census._build_kr_frozen_universe()
    current=[s for s in universe if s not in delisted]
    chosen=[]
    for market in ("KOSPI","KOSDAQ","KONEX"):
        syms=sorted(s for s in current if market_by_symbol.get(s)==market)
        if not syms:
            continue
        # deterministic spread across code space, not top/liquid only
        n=min(20,len(syms))
        idx=[round(i*(len(syms)-1)/max(n-1,1)) for i in range(n)]
        chosen.extend((syms[i],market) for i in idx)
    return chosen,meta

def fetch(symbol,market):
    last=None
    for attempt in range(4):
        try:
            r=requests.get(URL.format(symbol=symbol),headers=HEADERS,timeout=30)
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            # Expected shape: ["YYYYMMDDHHMM", null, null, null, close, cumulativeVolume, null]
            rows=[]
            for m in re.finditer(r'\["(\d{12})"\s*,([^\]]+)\]',r.text):
                vals=[v.strip() for v in m.group(2).split(",")]
                if len(vals)<5:
                    continue
                close=pd.to_numeric(vals[3],errors="coerce")
                cum=pd.to_numeric(vals[4],errors="coerce")
                if pd.isna(close) or pd.isna(cum):
                    continue
                rows.append((m.group(1),float(close),float(cum)))
            if not rows:
                return {"symbol":symbol,"market":market,"ok":False,"status":"NO_ROWS"}
            x=pd.DataFrame(rows,columns=["stamp","close","cumVolume"]).drop_duplicates("stamp").sort_values("stamp")
            x["timestamp"]=pd.to_datetime(x["stamp"],format="%Y%m%d%H%M",errors="coerce")
            x=x.dropna(subset=["timestamp"])
            x["date"]=x["timestamp"].dt.date
            x["minuteVolume"]=x.groupby("date")["cumVolume"].diff()
            first=x.groupby("date",sort=False).head(1).index
            x.loc[first,"minuteVolume"]=x.loc[first,"cumVolume"]
            neg=int((x["minuteVolume"]<0).sum())
            zero=int((x["minuteVolume"]==0).sum())
            dates=sorted(str(d) for d in x["date"].unique())
            return {
                "symbol":symbol,"market":market,"ok":True,"rows":int(len(x)),
                "dateCount":len(dates),"dates":dates,
                "first":x["stamp"].iloc[0],"last":x["stamp"].iloc[-1],
                "negativeMinuteVolume":neg,"zeroMinuteVolume":zero,
                "priceChanges":int((x["close"].diff()!=0).sum()),
                "minuteVolumeSum":float(x["minuteVolume"].clip(lower=0).sum()),
                "lastCumVolumeByDay":{
                    str(d):float(g["cumVolume"].iloc[-1])
                    for d,g in x.groupby("date")
                },
            }
        except Exception as exc:
            last=exc
            time.sleep(min(1+attempt,4))
    return {"symbol":symbol,"market":market,"ok":False,"status":repr(last)}

def main():
    chosen,meta=choose_symbols()
    rows=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futs={pool.submit(fetch,s,m):(s,m) for s,m in chosen}
        for fut in concurrent.futures.as_completed(futs):
            rows.append(fut.result())
    rows=sorted(rows,key=lambda z:(z["market"],z["symbol"]))
    ok=[x for x in rows if x.get("ok")]
    by_market={}
    for market in ("KOSPI","KOSDAQ","KONEX"):
        sub=[x for x in rows if x["market"]==market]
        good=[x for x in sub if x.get("ok")]
        by_market[market]={
            "tested":len(sub),"ok":len(good),
            "coverage":len(good)/max(len(sub),1),
            "medianRows":float(pd.Series([x["rows"] for x in good]).median()) if good else 0,
            "medianDateCount":float(pd.Series([x["dateCount"] for x in good]).median()) if good else 0,
        }
    valid_volume=[x for x in ok if int(x.get("negativeMinuteVolume") or 0)==0]
    result={
        "schemaVersion":1,
        "contract":"kr-naver-recent-minute-universe-probe-v3",
        "sampleSize":len(rows),"ok":len(ok),"coverage":len(ok)/max(len(rows),1),
        "volumeDeltaCleanCount":len(valid_volume),
        "volumeDeltaCleanRate":len(valid_volume)/max(len(ok),1),
        "byMarket":by_market,
        "universeMeta":meta,
        "rows":rows,
        "truthBoundary":{
            "sampleSpansKOSPIKOSDAQKONEX":True,
            "sampleDeterministicNotTopLiquidOnly":True,
            "sourceProvidesMinuteCloseAndCumulativeVolume":True,
            "minuteVolumeDerivedFromDailyCumulativeDifference":True,
            "sourceDoesNotProvideTrueMinuteOHLC":True,
            "recentWindowOnlyNotThreeYearHistory":True,
            "readOnlyPublicHttpOnly":True,
            "noBrokerCredentials":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    out=ROOT/"market-prediction-lab/docs/kr-naver-recent-minute-universe-probe-v3"
    out.mkdir(parents=True,exist_ok=True)
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    pd.DataFrame(rows).to_csv(out/"sample-audit.csv",index=False)
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)
    if result["coverage"]<0.80 or result["volumeDeltaCleanRate"]<0.90:
        raise SystemExit(1)

if __name__=="__main__":
    main()
