#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

BASE="https://api.bitget.com/api/v3/market/history-candles"
CATEGORY="USDT-FUTURES"
INTERVAL="15m"
ENTRY_SLIPPAGE=0.0005

def fetch_probe(symbol:str,entry_time:pd.Timestamp,binance_open:float):
    t=pd.Timestamp(entry_time)
    if t.tzinfo is None:t=t.tz_localize("UTC")
    else:t=t.tz_convert("UTC")
    start=int((t-pd.Timedelta(minutes=30)).timestamp()*1000)
    end=int((t+pd.Timedelta(minutes=30)).timestamp()*1000)
    params={
        "category":CATEGORY,
        "symbol":symbol,
        "interval":INTERVAL,
        "startTime":str(start),
        "endTime":str(end),
        "limit":"10",
    }
    last=None
    for attempt in range(5):
        try:
            r=requests.get(BASE,params=params,timeout=30,headers={"User-Agent":"market-prediction-lab/bitget-portability-v47"})
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            payload=r.json()
            if str(payload.get("code"))!="00000":
                return {"symbol":symbol,"entryTime":t,"ok":False,"error":f"CODE:{payload.get('code')}:{payload.get('msg')}"}
            data=payload.get("data") or []
            if not data:
                return {"symbol":symbol,"entryTime":t,"ok":False,"error":"EMPTY"}
            rows=[]
            for a in data:
                if len(a)<5:continue
                try:
                    rows.append({
                        "ts":pd.to_datetime(int(a[0]),unit="ms",utc=True),
                        "open":float(a[1]),"high":float(a[2]),"low":float(a[3]),"close":float(a[4]),
                    })
                except Exception:
                    continue
            if not rows:
                return {"symbol":symbol,"entryTime":t,"ok":False,"error":"NO_PARSEABLE_ROWS"}
            df=pd.DataFrame(rows)
            df["dt"]=(df["ts"]-t).abs()
            row=df.sort_values("dt").iloc[0]
            if row["dt"]>pd.Timedelta(minutes=15):
                return {"symbol":symbol,"entryTime":t,"ok":False,"error":f"NO_NEAR_CANDLE:{row['dt']}"}
            bitget_open=float(row["open"])
            basis=bitget_open/binance_open-1.0 if binance_open>0 else np.nan
            return {
                "symbol":symbol,"entryTime":t,"ok":True,
                "bitgetCandleTime":row["ts"],"bitgetOpen":bitget_open,
                "binanceReferenceOpen":binance_open,
                "openBasis":float(basis),
            }
        except Exception as exc:
            last=exc
            time.sleep(min(0.5*(attempt+1),2.0))
    return {"symbol":symbol,"entryTime":t,"ok":False,"error":repr(last)}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--exact-events",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    df=pd.read_parquet(args.exact_events)
    df["entryTime"]=pd.to_datetime(df["entryTime"],utc=True)
    df["month"]=df["entryTime"].dt.strftime("%Y-%m")
    # One real selected event per symbol-month gives historical tradability coverage
    # without hammering the public API with repeated signals from the same contract.
    probe=df.sort_values("entryTime").groupby(["symbol","month"],as_index=False).first()
    probe["binanceReferenceOpen"]=pd.to_numeric(probe["entryPriceExec"],errors="coerce")/(1.0-ENTRY_SLIPPAGE)
    tasks=[
        (str(r.symbol),pd.Timestamp(r.entryTime),float(r.binanceReferenceOpen),str(r.period))
        for r in probe.itertuples(index=False)
        if np.isfinite(float(r.binanceReferenceOpen)) and float(r.binanceReferenceOpen)>0
    ]

    rows=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs={pool.submit(fetch_probe,s,t,p):(s,t,period) for s,t,p,period in tasks}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            s,t,period=futs[fut]
            try:r=fut.result()
            except Exception as exc:r={"symbol":s,"entryTime":t,"ok":False,"error":repr(exc)}
            r["period"]=period
            rows.append(r)
            if idx%100==0 or idx==len(futs):
                print(json.dumps({"bitgetProbeComplete":idx,"tasks":len(futs),"ok":sum(1 for x in rows if x.get("ok"))}),flush=True)

    res=pd.DataFrame(rows)
    res.to_csv(out/"probe-rows.csv",index=False)
    ok=res[res["ok"]==True].copy()
    total=len(res);good=len(ok)
    basis=pd.to_numeric(ok.get("openBasis"),errors="coerce").dropna().abs() if good else pd.Series([],dtype=float)
    by_period={}
    for period,g in res.groupby("period"):
        gok=g[g["ok"]==True]
        b=pd.to_numeric(gok.get("openBasis"),errors="coerce").dropna().abs() if len(gok) else pd.Series([],dtype=float)
        by_period[str(period)]={
            "rows":int(len(g)),
            "ok":int(len(gok)),
            "coverage":float(len(gok)/max(len(g),1)),
            "medianAbsOpenBasis":float(b.median()) if len(b) else None,
            "p95AbsOpenBasis":float(b.quantile(0.95)) if len(b) else None,
        }

    symbol_total=int(res["symbol"].nunique()) if len(res) else 0
    symbol_ok=int(ok["symbol"].nunique()) if len(ok) else 0
    checks={
        "probeCoverageAtLeast80pct":good/max(total,1)>=0.80,
        "distinctSymbolCoverageAtLeast80pct":symbol_ok/max(symbol_total,1)>=0.80,
        "medianAbsOpenBasisAtMost50bp":bool(len(basis) and float(basis.median())<=0.005),
    }
    result={
        "schemaVersion":1,
        "contract":"crypto-futures-v46-bitget-portability-v47",
        "sourceRunV44":37453972448,
        "probeRows":total,
        "successfulRows":good,
        "coverage":float(good/max(total,1)),
        "distinctSymbols":symbol_total,
        "coveredSymbols":symbol_ok,
        "distinctSymbolCoverage":float(symbol_ok/max(symbol_total,1)),
        "medianAbsOpenBasis":float(basis.median()) if len(basis) else None,
        "p95AbsOpenBasis":float(basis.quantile(0.95)) if len(basis) else None,
        "periods":by_period,
        "portabilityGate":{"pass":all(checks.values()),"checks":checks},
        "truthBoundary":{
            "bitgetPublicApiOnly":True,
            "noPrivateCredentials":True,
            "oneSelectedEventPerSymbolMonthProbed":True,
            "binanceSignalTimestampNotRetuned":True,
            "thisProbeChecksTradabilityAndPriceBasisNotFullBitgetPnl":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
