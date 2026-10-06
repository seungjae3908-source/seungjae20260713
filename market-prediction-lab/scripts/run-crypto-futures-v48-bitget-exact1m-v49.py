#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v45=load(
    "v45",
    "market-prediction-lab/scripts/audit-crypto-futures-v44-robustness-capital-v45.py",
)

BASE="https://api.bitget.com/api/v3/market/history-candles"
CATEGORY="USDT-FUTURES"
INTERVAL="1m"
TARGET=0.03
STOP=0.015
HOLD=pd.Timedelta(hours=8)
ENTRY_SLIPPAGE=0.0005
ROUND_TRIP_COST=0.0012
CHUNK_MINUTES=95
MAX_WORKERS=6
EXTRA_COSTS={
    "bitgetPathFundingProxy":0.0,
    "bitgetPathFundingProxyPlus5bp":0.0005,
    "bitgetPathFundingProxyPlus10bp":0.0010,
}
MIN_PATH_COVERAGE=0.80

class GlobalRateLimiter:
    def __init__(self, limit:int=15, window:float=1.0):
        self.limit=limit
        self.window=window
        self.times=deque()
        self.lock=threading.Lock()

    def acquire(self):
        while True:
            sleep_for=0.0
            with self.lock:
                now=time.monotonic()
                while self.times and now-self.times[0]>=self.window:
                    self.times.popleft()
                if len(self.times)<self.limit:
                    self.times.append(now)
                    return
                sleep_for=max(0.01,self.window-(now-self.times[0])+0.01)
            time.sleep(sleep_for)

RATE=GlobalRateLimiter()

def fetch_chunk(symbol:str,start:pd.Timestamp,end:pd.Timestamp):
    s=pd.Timestamp(start)
    e=pd.Timestamp(end)
    if s.tzinfo is None:s=s.tz_localize("UTC")
    else:s=s.tz_convert("UTC")
    if e.tzinfo is None:e=e.tz_localize("UTC")
    else:e=e.tz_convert("UTC")

    params={
        "category":CATEGORY,
        "symbol":symbol,
        "interval":INTERVAL,
        "startTime":str(int(s.timestamp()*1000)),
        "endTime":str(int(e.timestamp()*1000)),
        "limit":"100",
        "type":"market",
    }
    last=None
    for attempt in range(6):
        try:
            RATE.acquire()
            r=requests.get(
                BASE,params=params,timeout=30,
                headers={"User-Agent":"market-prediction-lab/bitget-exact1m-v49"},
            )
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            payload=r.json()
            if str(payload.get("code"))!="00000":
                return None,f"CODE:{payload.get('code')}:{payload.get('msg')}"
            data=payload.get("data") or []
            rows=[]
            for a in data:
                if len(a)<5:continue
                try:
                    rows.append({
                        "timestamp":pd.to_datetime(int(a[0]),unit="ms",utc=True),
                        "open":float(a[1]),"high":float(a[2]),
                        "low":float(a[3]),"close":float(a[4]),
                    })
                except Exception:
                    continue
            if not rows:
                return pd.DataFrame(columns=["timestamp","open","high","low","close"]),"EMPTY"
            return pd.DataFrame(rows),None
        except Exception as exc:
            last=exc
            time.sleep(min(0.5*(attempt+1),3.0))
    return None,repr(last)

def fetch_event_path(symbol:str,entry_time:pd.Timestamp):
    t=pd.Timestamp(entry_time)
    if t.tzinfo is None:t=t.tz_localize("UTC")
    else:t=t.tz_convert("UTC")
    expected=t.floor("min")
    end=t+HOLD
    cursor=expected
    frames=[]
    failures=[]
    while cursor<end:
        chunk_end=min(cursor+pd.Timedelta(minutes=CHUNK_MINUTES),end)
        # History endpoint is described as "after startTime", so request one minute
        # before the desired chunk and filter precisely afterwards.
        df,err=fetch_chunk(
            symbol,
            cursor-pd.Timedelta(minutes=1),
            chunk_end+pd.Timedelta(minutes=1),
        )
        if df is None:
            failures.append({"start":str(cursor),"end":str(chunk_end),"error":err})
        elif len(df):
            frames.append(df)
        cursor=chunk_end

    if not frames:
        return None,{"error":"NO_BITGET_1M_PATH","failures":failures[:10]}

    bars=(
        pd.concat(frames,ignore_index=True)
        .drop_duplicates("timestamp")
        .sort_values("timestamp")
    )
    bars=bars[(bars["timestamp"]>=expected)&(bars["timestamp"]<end)].copy()
    if bars.empty:
        return None,{"error":"NO_BARS_IN_HOLD_WINDOW","failures":failures[:10]}

    entry_rows=bars[bars["timestamp"]==expected]
    if entry_rows.empty:
        return None,{
            "error":"NO_EXACT_ENTRY_CANDLE",
            "nearest":str(bars.iloc[(bars["timestamp"]-expected).abs().argsort().iloc[0]]["timestamp"])
            if len(bars) else None,
            "failures":failures[:10],
        }
    return bars,{
        "rawRows":int(len(bars)),
        "chunkFailures":len(failures),
        "failurePreview":failures[:10],
    }

def replay_event(row:dict):
    symbol=str(row["symbol"])
    entry_time=pd.Timestamp(row["entryTime"])
    bars,audit=fetch_event_path(symbol,entry_time)
    if bars is None:
        return None,{"symbol":symbol,"entryTime":str(entry_time),**audit}

    expected=pd.Timestamp(entry_time)
    if expected.tzinfo is None:expected=expected.tz_localize("UTC")
    else:expected=expected.tz_convert("UTC")
    expected=expected.floor("min")
    first=bars[bars["timestamp"]==expected].iloc[0]
    raw_open=float(first["open"])
    entry=raw_open*(1.0-ENTRY_SLIPPAGE)
    if not np.isfinite(entry) or entry<=0:
        return None,{"symbol":symbol,"entryTime":str(entry_time),"error":"BAD_ENTRY_PRICE"}

    tp=entry*(1.0-TARGET)
    sl=entry*(1.0+STOP)
    exit_px=None
    exit_t=None
    reason=None
    highs=[]
    lows=[]
    prev=None
    gap_error=None

    for _,b in bars.iterrows():
        ts=pd.Timestamp(b["timestamp"])
        if prev is not None and ts-prev>pd.Timedelta(minutes=2):
            gap_error=f"PATH_GAP:{prev}->{ts}"
            break
        prev=ts
        hi=float(b["high"]);lo=float(b["low"])
        highs.append(hi);lows.append(lo)
        # Conservative same-minute ambiguity: stop first.
        if hi>=sl:
            exit_px=sl;exit_t=ts;reason="STOP";break
        if lo<=tp:
            exit_px=tp;exit_t=ts;reason="TARGET";break

    if gap_error:
        return None,{
            "symbol":symbol,"entryTime":str(entry_time),
            "error":gap_error,**audit,
        }

    hold_end=expected+HOLD
    if exit_px is None:
        last=bars.iloc[-1]
        last_t=pd.Timestamp(last["timestamp"])
        # A TIME exit is only valid if the retrieved path reaches the hold horizon.
        if last_t<hold_end-pd.Timedelta(minutes=2):
            return None,{
                "symbol":symbol,"entryTime":str(entry_time),
                "error":f"INCOMPLETE_TIME_PATH:{last_t}<{hold_end}",
                **audit,
            }
        exit_px=float(last["close"])
        exit_t=last_t
        reason="TIME"

    gross=1.0-exit_px/entry
    funding=float(row.get("fundingReturnShort",0.0) or 0.0)
    net_base=gross-ROUND_TRIP_COST
    net_funding=net_base+funding
    binance_raw=float(row["entryPriceExec"])/(1.0-ENTRY_SLIPPAGE)
    basis=raw_open/binance_raw-1.0 if binance_raw>0 else np.nan

    out={
        "market":"CRYPTO_FUTURES",
        "timestamp":pd.Timestamp(row["timestamp"]),
        "symbol":symbol,
        "direction":"SHORT",
        "score":float(row["score"]),
        "period":str(row["period"]),
        "entryTime":expected,
        "exitTime":exit_t,
        "bitgetEntryOpen":raw_open,
        "entryPriceExec":entry,
        "exitPrice":float(exit_px),
        "exitReason":reason,
        "grossReturn":float(gross),
        "roundTripCost":ROUND_TRIP_COST,
        "fundingReturnShortProxy":funding,
        "netReturnBeforeFunding":float(net_base),
        "netReturnWithFundingProxy":float(net_funding),
        "MFE":1.0-float(np.nanmin(lows))/entry,
        "MAE":float(np.nanmax(highs))/entry-1.0,
        "targetFirst3":1 if reason=="TARGET" else 0,
        "binanceReferenceOpen":binance_raw,
        "openBasis":float(basis),
        "bitgetBarsUsed":int(len(highs)),
    }
    return out,{"symbol":symbol,"entryTime":str(entry_time),"ok":True,**audit}

def period_audit(df:pd.DataFrame):
    scenarios={}
    for name,extra in EXTRA_COSTS.items():
        z=df.copy()
        z["netReturn"]=pd.to_numeric(z["netReturnWithFundingProxy"],errors="coerce")-float(extra)
        scenarios[name]=v45.period_audit(z)
    base=scenarios["bitgetPathFundingProxy"]
    plus10=scenarios["bitgetPathFundingProxyPlus10bp"]
    cap3=next(x for x in plus10["slotCapital"] if x["maxPositions"]==3)
    checks={
        "minimumRows":len(df)>=100,
        "baseRobustnessPass":bool(base["robustnessGate"]["pass"]),
        "plus10bpPositiveEV":float(plus10["exactMetrics"]["meanNet"])>0,
        "plus10bpProfitFactorAbove1":float(plus10["exactMetrics"]["profitFactor"])>1,
        "plus10bpThreeSlotPositive":float(cap3["totalReturn"])>0,
        "plus10bpThreeSlotMddAtMost35pct":float(cap3["mdd"])<=0.35,
    }
    return {
        "rows":int(len(df)),
        "symbols":int(df["symbol"].astype(str).nunique()) if len(df) else 0,
        "scenarios":{
            k:{
                "exactMetrics":v["exactMetrics"],
                "slotCapital":v["slotCapital"],
                "robustnessGate":v["robustnessGate"],
            }
            for k,v in scenarios.items()
        },
        "gate":{"pass":all(checks.values()),"checks":checks},
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--covered-events",required=True)
    ap.add_argument("--v48-summary",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    prior=json.loads(Path(args.v48_summary).read_text(encoding="utf-8"))
    if prior.get("contract")!="crypto-futures-v47-bitget-covered-subset-v48":
        raise RuntimeError("V49_WRONG_PRIOR")
    if not bool(prior.get("coveredSubsetPass")):
        raise RuntimeError("V49_V48_NOT_PASS")

    events=pd.read_parquet(args.covered_events)
    events["entryTime"]=pd.to_datetime(events["entryTime"],utc=True)
    events["timestamp"]=pd.to_datetime(events["timestamp"],utc=True)
    events=events[events["period"].astype(str).isin(["validation","fresh_oos"])].copy()
    events=events.sort_values(["entryTime","score","symbol"],ascending=[True,False,True]).reset_index(drop=True)
    if events.empty:
        raise RuntimeError("V49_NO_EVENTS")

    rows=[];audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={
            pool.submit(replay_event,r):i
            for i,r in enumerate(events.to_dict("records"))
        }
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            try:
                rr,aa=fut.result()
            except Exception as exc:
                rr=None;aa={"error":repr(exc)}
            if rr is not None:rows.append(rr)
            audits.append(aa)
            if idx%50==0 or idx==len(futs):
                print(json.dumps({
                    "bitgetExactEventsComplete":idx,
                    "events":len(futs),
                    "exactRows":len(rows),
                    "failed":idx-len(rows),
                }),flush=True)

    exact=pd.DataFrame(rows)
    audit_df=pd.DataFrame(audits)
    audit_df.to_csv(out/"source-audit.csv",index=False)
    if exact.empty:
        raise RuntimeError("V49_NO_EXACT_BITGET_ROWS")
    exact.to_parquet(out/"bitget-exact-events.parquet",index=False)

    total=len(events)
    coverage=float(len(exact)/max(total,1))
    basis=pd.to_numeric(exact["openBasis"],errors="coerce").dropna().abs()

    periods={}
    period_checks={}
    for p in ("validation","fresh_oos"):
        all_p=events[events["period"].astype(str)==p]
        ex=exact[exact["period"].astype(str)==p].copy()
        cov=float(len(ex)/max(len(all_p),1))
        pa=period_audit(ex)
        periods[p]={
            "requestedRows":int(len(all_p)),
            "exactRows":int(len(ex)),
            "pathCoverage":cov,
            "audit":pa,
        }
        period_checks[p]=bool(cov>=MIN_PATH_COVERAGE and pa["gate"]["pass"])

    checks={
        "overallPathCoverageAtLeast80pct":coverage>=MIN_PATH_COVERAGE,
        "validationPathCoverageAtLeast80pct":periods["validation"]["pathCoverage"]>=MIN_PATH_COVERAGE,
        "freshPathCoverageAtLeast80pct":periods["fresh_oos"]["pathCoverage"]>=MIN_PATH_COVERAGE,
        "medianAbsOpenBasisAtMost50bp":bool(len(basis) and float(basis.median())<=0.005),
        "validationGatePass":period_checks["validation"],
        "freshGatePass":period_checks["fresh_oos"],
    }

    result={
        "schemaVersion":1,
        "contract":"crypto-futures-v48-bitget-exact1m-v49",
        "sourceRunV48":37457612026,
        "requestedEvents":int(total),
        "exactBitgetRows":int(len(exact)),
        "pathCoverage":coverage,
        "distinctSymbols":int(exact["symbol"].astype(str).nunique()),
        "basisDiagnostic":{
            "medianAbsOpenBasis":float(basis.median()) if len(basis) else None,
            "p95AbsOpenBasis":float(basis.quantile(0.95)) if len(basis) else None,
        },
        "periods":periods,
        "promotionGate":{"pass":all(checks.values()),"checks":checks},
        "truthBoundary":{
            "signalTimesAndThresholdFrozenBeforeBitgetReplay":True,
            "bitgetPublicMarketCandlesOnly":True,
            "bitgetExactOneMinutePricePath":True,
            "bitgetEntryUsesSameSignalTimeAndNextMinuteOpenConvention":True,
            "shortEntrySlippageApplied":ENTRY_SLIPPAGE,
            "roundTripCostApplied":ROUND_TRIP_COST,
            "targetPct":TARGET,
            "stopPct":STOP,
            "maxHoldHours":8,
            "sameMinuteTargetStopUsesStopFirst":True,
            "fundingUsesFrozenBinanceFundingProxyNotBitgetFunding":True,
            "plus10bpStressRetainedForFundingFeeMismatch":True,
            "noThresholdRetuning":True,
            "noCandidateReselection":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
