#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT=Path(__file__).resolve().parents[2]
CENSUS_PATH=ROOT/"market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py"
SPEC=importlib.util.spec_from_file_location("census_v2",CENSUS_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("CENSUS_IMPORT_FAILED")
census=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(census)

URL="https://api.finance.naver.com/siseJson.naver?symbol={symbol}&requestType=0&count=500&timeframe=minute"
HEADERS={"User-Agent":"Mozilla/5.0 market-prediction-lab/kr-always-on-opportunity-v1"}
SESSION_START="09:00"
SESSION_END="16:30"
HORIZON_MINUTES=60
NEG_SAMPLE_PCT=2


def current_universe():
    frozen,delisted,market_by_symbol,meta=census._build_kr_frozen_universe()
    base={s:market_by_symbol.get(s,"UNKNOWN") for s in frozen if s not in delisted}
    live_added=0
    live_error=None
    try:
        import FinanceDataReader as fdr
        live=fdr.StockListing("KRX")
        code_col="Code" if "Code" in live.columns else None
        market_col="Market" if "Market" in live.columns else None
        if code_col:
            for _,r in live.iterrows():
                s=str(r[code_col]).zfill(6)
                m=str(r[market_col]) if market_col else "UNKNOWN"
                if s not in base:
                    live_added+=1
                base[s]=m
    except Exception as exc:
        live_error=repr(exc)
    return sorted(base),base,{
        "frozenMeta":meta,
        "frozenActiveSymbols":len(set(frozen)-set(delisted)),
        "liveAddedSymbols":live_added,
        "liveListingError":live_error,
        "combinedSymbols":len(base),
    }


def fetch_rows(symbol:str):
    last=None
    for attempt in range(4):
        try:
            r=requests.get(URL.format(symbol=symbol),headers=HEADERS,timeout=35)
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
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
                return None,"NO_ROWS"
            x=pd.DataFrame(rows,columns=["stamp","close","cumVolume"]).drop_duplicates("stamp").sort_values("stamp")
            x["timestamp"]=pd.to_datetime(x["stamp"],format="%Y%m%d%H%M",errors="coerce")
            x=x.dropna(subset=["timestamp"])
            return x,None
        except Exception as exc:
            last=exc
            time.sleep(min(1.0+attempt,4.0))
    return None,repr(last)


def deterministic_keep(symbol:str,stamp:str,pct:int)->bool:
    h=hashlib.sha256(f"{symbol}:{stamp}".encode()).digest()
    return int.from_bytes(h[:4],"big")%100 < pct


def grid_day(g:pd.DataFrame)->pd.DataFrame:
    d=pd.Timestamp(g["timestamp"].iloc[0]).normalize()
    idx=pd.date_range(d+pd.Timedelta(SESSION_START+":00"),d+pd.Timedelta(SESSION_END+":00"),freq="1min")
    z=g.set_index("timestamp")[["close","cumVolume"]].reindex(idx)
    z["close"]=z["close"].ffill()
    z["cumVolume"]=z["cumVolume"].ffill()
    z=z.dropna(subset=["close","cumVolume"]).copy()
    z["minuteVolume"]=z["cumVolume"].diff()
    if len(z):
        # The first observed cumulative value may represent many earlier trades; do not treat it as one-minute flow.
        z.iloc[0,z.columns.get_loc("minuteVolume")]=0.0
    z["minuteVolume"]=z["minuteVolume"].clip(lower=0).fillna(0)
    z["timestamp"]=z.index
    z["date"]=z.index.date
    z["minuteOfSession"]=((z.index-(d+pd.Timedelta(hours=9))).total_seconds()/60).astype(int)
    return z.reset_index(drop=True)


def feature_day(g:pd.DataFrame, history_tail:pd.DataFrame|None=None)->tuple[pd.DataFrame,pd.DataFrame]:
    z=grid_day(g)
    if z.empty:
        return pd.DataFrame(), pd.DataFrame()

    # Keep the previous session's final observed minute context so the scanner can
    # compute features from 09:00 instead of silently dropping the opening hour.
    # This is previous-observed-bar context across the overnight gap, not continuous
    # clock-time history; labels remain strictly inside the current session.
    history=(history_tail.copy() if history_tail is not None else pd.DataFrame())
    base_cols=["close","minuteVolume","timestamp","date","minuteOfSession"]
    if len(history):
        ctx=pd.concat([history[base_cols],z[base_cols]],ignore_index=True)
    else:
        ctx=z[base_cols].copy()

    cctx=ctx["close"].astype(float)
    vctx=ctx["minuteVolume"].astype(float)
    dctx=cctx*vctx
    ctx["ret1"]=cctx/cctx.shift(1)-1
    ctx["ret5"]=cctx/cctx.shift(5)-1
    ctx["ret15"]=cctx/cctx.shift(15)-1
    priorv=vctx.shift(1).rolling(60,min_periods=20).mean()
    priord=dctx.shift(1).rolling(60,min_periods=20).mean()
    ctx["rvol60"]=vctx/priorv.replace(0,np.nan)
    ctx["dollarAccel5"]=dctx.rolling(5,min_periods=3).mean()/priord.replace(0,np.nan)
    ph=cctx.shift(1).rolling(30,min_periods=10).max()
    pl=cctx.shift(1).rolling(30,min_periods=10).min()
    ctx["distHigh30"]=cctx/ph-1
    ctx["distLow30"]=cctx/pl-1
    ctx["closeRangeLoc"]=(cctx-pl)/(ph-pl).replace(0,np.nan)
    roll_dollar=dctx.rolling(30,min_periods=10).sum()
    roll_vol=vctx.rolling(30,min_periods=10).sum()
    ctx["vwap30"]=roll_dollar/roll_vol.replace(0,np.nan)
    ctx["vwapDist"]=cctx/ctx["vwap30"]-1
    ctx["priorDollar60"]=priord

    current=ctx.tail(len(z)).copy().reset_index(drop=True)
    c=z["close"].astype(float)
    current["entryPriceProxy"]=c.shift(-1).to_numpy()
    future=c.shift(-1).iloc[::-1].rolling(HORIZON_MINUTES,min_periods=1).max().iloc[::-1]
    current["futureMaxClose60"]=future.to_numpy()
    current["labelClose3"]=(future>=c.shift(-1)*1.03).astype(int).to_numpy()
    current["labelClose5"]=(future>=c.shift(-1)*1.05).astype(int).to_numpy()
    current["labelClose10"]=(future>=c.shift(-1)*1.10).astype(int).to_numpy()
    current["forwardCloseMFE60"]=(future/c.shift(-1)-1).to_numpy()

    next_history=z[base_cols].tail(60).copy().reset_index(drop=True)
    current=current.dropna(subset=["ret15","rvol60","dollarAccel5","distHigh30","distLow30","vwapDist","entryPriceProxy"])
    return current,next_history

def process_symbol(symbol:str,market:str):
    raw,err=fetch_rows(symbol)
    if raw is None:
        return [],{"symbol":symbol,"market":market,"ok":False,"error":err}
    raw["date"]=raw["timestamp"].dt.date
    samples=[]
    states=0;pos3=0;pos5=0;pos10=0
    opening3=0;outside3=0
    days=0
    history_tail=None
    for _,g in raw.groupby("date",sort=True):
        f,history_tail=feature_day(g,history_tail)
        if f.empty:
            continue
        days+=1
        f=f[(f["close"]>=500)&(f["priorDollar60"]>=100000)].copy()
        states+=len(f)
        pos3+=int(f["labelClose3"].sum())
        pos5+=int(f["labelClose5"].sum())
        pos10+=int(f["labelClose10"].sum())
        opening=(f["minuteOfSession"]>=0)&(f["minuteOfSession"]<5)
        opening3+=int(f.loc[opening,"labelClose3"].sum())
        outside3+=int(f.loc[~opening,"labelClose3"].sum())
        f["bucket15"]=(f["minuteOfSession"]//15).astype(int)
        for _,b in f.groupby("bucket15",sort=True):
            p=b[b["labelClose3"]==1]
            if len(p):
                r=p.iloc[0]
            else:
                r=b.iloc[0]
                if not deterministic_keep(symbol,str(r["timestamp"]),NEG_SAMPLE_PCT):
                    continue
            samples.append({
                "market":"KR_STOCK","exchangeMarket":market,"symbol":symbol,
                "timestamp":r["timestamp"],"date":r["date"],"minuteOfSession":int(r["minuteOfSession"]),
                "close":float(r["close"]),"entryPriceProxy":float(r["entryPriceProxy"]),
                "ret1":float(r["ret1"]),"ret5":float(r["ret5"]),"ret15":float(r["ret15"]),
                "rvol60":float(r["rvol60"]),"dollarAccel5":float(r["dollarAccel5"]),
                "distHigh30":float(r["distHigh30"]),"distLow30":float(r["distLow30"]),
                "closeRangeLoc":float(r["closeRangeLoc"]),"vwapDist":float(r["vwapDist"]),
                "priorDollar60":float(r["priorDollar60"]),
                "labelClose3":int(r["labelClose3"]),"labelClose5":int(r["labelClose5"]),
                "labelClose10":int(r["labelClose10"]),"forwardCloseMFE60":float(r["forwardCloseMFE60"]),
            })
    return samples,{
        "symbol":symbol,"market":market,"ok":True,"rawRows":int(len(raw)),"usableDays":days,
        "scannerStates":states,"close3States":pos3,"close5States":pos5,"close10States":pos10,
        "opening5Close3":opening3,"outsideOpening5Close3":outside3,"sampleRows":len(samples),
    }


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    ap.add_argument("--max-symbols",type=int,default=0)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    symbols,market_map,source=current_universe()
    if args.max_symbols>0:
        symbols=symbols[:args.max_symbols]

    samples=[];audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futs={pool.submit(process_symbol,s,market_map.get(s,"UNKNOWN")):s for s in symbols}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            try:rows,audit=fut.result()
            except Exception as exc:
                s=futs[fut];rows=[];audit={"symbol":s,"market":market_map.get(s,"UNKNOWN"),"ok":False,"error":repr(exc)}
            samples.extend(rows);audits.append(audit)
            if idx%100==0 or idx==len(futs):
                print(json.dumps({"krMinuteSymbols":idx,"total":len(futs),"samples":len(samples)},ensure_ascii=False),flush=True)

    aud=pd.DataFrame(audits)
    good=aud[aud["ok"]==True] if len(aud) else pd.DataFrame()
    data=pd.DataFrame(samples)
    if data.empty:
        raise RuntimeError("NO_KR_RECENT_MINUTE_SAMPLES")
    data.to_parquet(out/"events.parquet",index=False)
    aud.to_csv(out/"symbol-audit.csv",index=False)

    states=int(good["scannerStates"].sum()) if len(good) else 0
    p3=int(good["close3States"].sum()) if len(good) else 0
    op5=int(good["opening5Close3"].sum()) if len(good) else 0
    out5=int(good["outsideOpening5Close3"].sum()) if len(good) else 0
    result={
        "schemaVersion":1,
        "contract":"kr-recent-all-session-opportunity-miner-v1",
        "source":source,
        "requestedSymbols":len(symbols),
        "usableSymbols":int(len(good)),
        "coverage":float(len(good)/max(len(symbols),1)),
        "scannerStates":states,
        "close3States":p3,
        "close5States":int(good["close5States"].sum()) if len(good) else 0,
        "close10States":int(good["close10States"].sum()) if len(good) else 0,
        "opening5Close3States":op5,
        "outsideOpening5Close3States":out5,
        "outsideOpening5Share":float(out5/max(p3,1)),
        "sampleRows":int(len(data)),
        "positiveSampleBuckets":int(data["labelClose3"].sum()),
        "truthBoundary":{
            "allCurrentKnownKrxSymbolsRequested":args.max_symbols==0,
            "scannerCoversEntire0900To1630Window":True,
            "openingFiveMinutesNotRequired":True,
            "sourceIsRecentOnlyNotThreeYearHistory":True,
            "sourceProvidesMinuteCloseAndCumulativeVolumeNotTrueOhlc":True,
            "minuteVolumeDerivedFromCumulativeDifference":True,
            "openingFeaturesUsePriorSessionObservedMinuteTail":True,
            "overnightContextIsPreviousObservedBarsNotContinuousClockMinutes":True,
            "futureLabelUsesClockMinuteGridAndFutureCloseMax":True,
            "labelsAreClosePathProxyNotIntrabarHighMfe":True,
            "notTradingPnlProof":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE"
        }
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)


if __name__=="__main__":
    main()
