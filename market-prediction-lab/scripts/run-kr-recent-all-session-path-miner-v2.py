#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v1=load(
    "kr_recent_v1",
    "market-prediction-lab/scripts/run-kr-recent-all-session-opportunity-miner-v1.py",
)

TARGET=0.03
STOP=0.015
HORIZON=60
NEG_SAMPLE_PCT=2
MAX_WORKERS=12


def exact_close_path_labels(grid:pd.DataFrame)->pd.DataFrame:
    z=grid.copy().reset_index(drop=True)
    c=pd.to_numeric(z["close"],errors="coerce").to_numpy(float)
    n=len(c)
    entry=np.full(n,np.nan)
    if n>1:
        entry[:-1]=c[1:]
    status=np.zeros(n,dtype=np.int8)  # 1 target first, -1 stop first, 0 unresolved/time
    exit_offset=np.full(n,np.nan)
    valid=np.isfinite(entry)&(entry>0)

    # Step 1 is the entry close itself; thresholds cannot be hit there.
    unresolved=valid.copy()
    for step in range(2,HORIZON+2):
        count=n-step
        if count<=0:
            break
        idx=np.arange(count)
        mask=unresolved[:count]
        if not mask.any():
            continue
        px=c[step:step+count]
        ent=entry[:count]
        stop_hit=mask & np.isfinite(px) & (px<=ent*(1.0-STOP))
        status[:count][stop_hit]=-1
        exit_offset[:count][stop_hit]=step-1
        unresolved[:count][stop_hit]=False

        mask=unresolved[:count]
        target_hit=mask & np.isfinite(px) & (px>=ent*(1.0+TARGET))
        status[:count][target_hit]=1
        exit_offset[:count][target_hit]=step-1
        unresolved[:count][target_hit]=False

    z["entryPricePath"]=entry
    z["labelPath3"]=(status==1).astype(np.int8)
    z["pathOutcome"]=np.where(status==1,"TARGET",np.where(status==-1,"STOP","TIME"))
    z["pathExitOffsetMinutes"]=exit_offset
    return z


def feature_day(g:pd.DataFrame,history_tail:pd.DataFrame|None=None):
    current,next_history=v1.feature_day(g,history_tail)
    if current.empty:
        return current,next_history
    grid=exact_close_path_labels(v1.grid_day(g))
    labels=grid[[
        "timestamp","entryPricePath","labelPath3","pathOutcome","pathExitOffsetMinutes"
    ]].copy()
    out=current.merge(labels,on="timestamp",how="left")
    out=out.dropna(subset=["entryPricePath","labelPath3"]).copy()
    return out,next_history


def process_symbol(symbol:str,market:str):
    raw,err=v1.fetch_rows(symbol)
    if raw is None:
        return [],{"symbol":symbol,"market":market,"ok":False,"error":err}
    raw["date"]=raw["timestamp"].dt.date
    samples=[]
    states=0
    positives=0
    opening_pos=0
    outside_pos=0
    days=0
    history_tail=None
    for _,g in raw.groupby("date",sort=True):
        f,history_tail=feature_day(g,history_tail)
        if f.empty:
            continue
        days+=1
        f=f[(f["close"]>=500)&(f["priorDollar60"]>=100000)].copy()
        if f.empty:
            continue
        states+=len(f)
        positives+=int(f["labelPath3"].sum())
        opening=(f["minuteOfSession"]>=0)&(f["minuteOfSession"]<5)
        opening_pos+=int(f.loc[opening,"labelPath3"].sum())
        outside_pos+=int(f.loc[~opening,"labelPath3"].sum())
        f["bucket15"]=(f["minuteOfSession"]//15).astype(int)
        for _,b in f.groupby("bucket15",sort=True):
            p=b[b["labelPath3"]==1]
            if len(p):
                r=p.iloc[0]
            else:
                r=b.iloc[0]
                if not v1.deterministic_keep(symbol,str(r["timestamp"]),NEG_SAMPLE_PCT):
                    continue
            samples.append({
                "market":"KR_STOCK",
                "exchangeMarket":market,
                "symbol":symbol,
                "timestamp":r["timestamp"],
                "date":r["date"],
                "minuteOfSession":int(r["minuteOfSession"]),
                "close":float(r["close"]),
                "entryPriceProxy":float(r["entryPricePath"]),
                "ret1":float(r["ret1"]),
                "ret5":float(r["ret5"]),
                "ret15":float(r["ret15"]),
                "rvol60":float(r["rvol60"]),
                "dollarAccel5":float(r["dollarAccel5"]),
                "distHigh30":float(r["distHigh30"]),
                "distLow30":float(r["distLow30"]),
                "closeRangeLoc":float(r["closeRangeLoc"]),
                "vwapDist":float(r["vwapDist"]),
                "priorDollar60":float(r["priorDollar60"]),
                "labelPath3":int(r["labelPath3"]),
                "pathOutcome":str(r["pathOutcome"]),
                "pathExitOffsetMinutes":(
                    None if pd.isna(r["pathExitOffsetMinutes"])
                    else float(r["pathExitOffsetMinutes"])
                ),
            })
    return samples,{
        "symbol":symbol,
        "market":market,
        "ok":True,
        "rawRows":int(len(raw)),
        "usableDays":days,
        "scannerStates":int(states),
        "path3States":int(positives),
        "opening5Path3":int(opening_pos),
        "outsideOpening5Path3":int(outside_pos),
        "sampleRows":int(len(samples)),
        "samplePositive":int(sum(int(x["labelPath3"]) for x in samples)),
    }


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    ap.add_argument("--max-symbols",type=int,default=0)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    symbols,market_map,source=v1.current_universe()
    if args.max_symbols>0:
        symbols=symbols[:args.max_symbols]

    samples=[];audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={
            pool.submit(process_symbol,s,market_map.get(s,"UNKNOWN")):s
            for s in symbols
        }
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            s=futs[fut]
            try:
                rows,audit=fut.result()
            except Exception as exc:
                rows=[]
                audit={
                    "symbol":s,"market":market_map.get(s,"UNKNOWN"),
                    "ok":False,"error":repr(exc)
                }
            samples.extend(rows)
            audits.append(audit)
            if idx%100==0 or idx==len(futs):
                print(json.dumps({
                    "krPathSymbols":idx,
                    "total":len(futs),
                    "samples":len(samples),
                    "positives":sum(int(x["labelPath3"]) for x in samples),
                },ensure_ascii=False),flush=True)

    aud=pd.DataFrame(audits)
    good=aud[aud["ok"]==True].copy() if len(aud) else pd.DataFrame()
    data=pd.DataFrame(samples)
    if data.empty:
        raise RuntimeError("NO_KR_PATH_SAMPLES")

    data.to_parquet(out/"events.parquet",index=False)
    aud.to_csv(out/"symbol-audit.csv",index=False)

    states=int(good["scannerStates"].sum()) if len(good) else 0
    positives=int(good["path3States"].sum()) if len(good) else 0
    op5=int(good["opening5Path3"].sum()) if len(good) else 0
    out5=int(good["outsideOpening5Path3"].sum()) if len(good) else 0
    result={
        "schemaVersion":1,
        "contract":"kr-recent-all-session-path-miner-v2",
        "source":source,
        "requestedSymbols":len(symbols),
        "usableSymbols":int(len(good)),
        "coverage":float(len(good)/max(len(symbols),1)),
        "scannerStates":states,
        "path3TargetBeforeStopStates":positives,
        "positiveRate":float(positives/max(states,1)),
        "opening5Path3States":op5,
        "outsideOpening5Path3States":out5,
        "outsideOpening5Share":float(out5/max(positives,1)),
        "sampleRows":int(len(data)),
        "positiveSampleBuckets":int(data["labelPath3"].sum()),
        "negativeSamplePct":NEG_SAMPLE_PCT,
        "label":{
            "entry":"NEXT_1M_CLOSE_PROXY",
            "targetPct":TARGET,
            "stopPct":STOP,
            "maxHoldMinutes":HORIZON,
            "stopFirstAtSameClockMinute":True,
        },
        "truthBoundary":{
            "allCurrentKnownKrxSymbolsRequested":args.max_symbols==0,
            "scannerCoversEntire0900To1630Window":True,
            "openingFiveMinutesNotRequired":True,
            "sourceIsRecentOnlyNotThreeYearHistory":True,
            "sourceProvidesMinuteCloseAndCumulativeVolumeNotTrueOhlc":True,
            "pathLabelUsesFutureMinuteClosesOnly":True,
            "targetBeforeStopOrderExplicitlyLabeled":True,
            "allPositive15mBucketsRetained":True,
            "onlyNegativeBucketsDownsampled":True,
            "notTradingPnlProof":True,
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
