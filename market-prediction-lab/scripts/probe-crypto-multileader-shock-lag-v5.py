#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from huggingface_hub import snapshot_download

ROOT=Path(__file__).resolve().parents[2]

def load_module(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

factory=load_module(
    "intraday_factory",
    "market-prediction-lab/scripts/run-crypto-full-universe-intraday-factory-v4.py",
)

DATASET="rogerdehe/klines-binance"
START=pd.Timestamp("2023-04-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01",tz="UTC")
CAL_END=pd.Timestamp("2025-04-01",tz="UTC")
VAL_END=pd.Timestamp("2026-04-01",tz="UTC")
OOS_END=pd.Timestamp("2026-10-01",tz="UTC")

LEADERS=("BTC","ETH","SOL")
SHOCK_Z_MIN=1.5
COMPOSITE_RET_MIN=0.004
AGREEMENT_MIN=2
TARGET=0.03
STOP=0.015
HOLD_BARS=32
NEG_SAMPLE_PCT=2
SAMPLE_LIMIT=500_000


def period_of(ts:pd.Timestamp)->str:
    t=pd.Timestamp(ts)
    if t<TRAIN_END:return "train"
    if t<CAL_END:return "calibration"
    if t<VAL_END:return "validation"
    return "freshOos"


def deterministic_keep(symbol:str,ts,rate:int)->bool:
    h=hashlib.sha256(f"{symbol}:{ts}".encode()).digest()
    return int.from_bytes(h[:4],"big")%100 < rate


def leader_path(folder:Path,sub:str,leader:str)->Path:
    exact=folder/(f"{leader}_USDT.parquet" if sub=="spot" else f"{leader}_USDT_USDT.parquet")
    if exact.exists():
        return exact
    hits=sorted(folder.glob(f"{leader}_USDT*.parquet"))
    if not hits:
        raise RuntimeError(f"LEADER_FILE_MISSING:{sub}:{leader}")
    return hits[0]


def load_leader_series(folder:Path,sub:str,leader:str)->pd.DataFrame:
    p=leader_path(folder,sub,leader)
    x=factory.load_file(p)
    if x is None or x.is_empty():
        raise RuntimeError(f"LEADER_EMPTY:{sub}:{leader}")
    z=x.select(["date","close"]).to_pandas()
    z["date"]=pd.to_datetime(z["date"],utc=True)
    z=z[(z["date"]>=START)&(z["date"]<OOS_END)].sort_values("date").reset_index(drop=True)
    c=pd.to_numeric(z["close"],errors="coerce")
    r1=c/c.shift(1)-1.0
    r4=c/c.shift(4)-1.0
    prior_std=r1.shift(1).rolling(96,min_periods=48).std()
    z[f"{leader}_ret1"]=r1
    z[f"{leader}_ret4"]=r4
    z[f"{leader}_z1"]=r1/prior_std.replace(0,np.nan)
    return z[["date",f"{leader}_ret1",f"{leader}_ret4",f"{leader}_z1"]]


def build_events(folder:Path,sub:str,market:str)->pd.DataFrame:
    merged=None
    for leader in LEADERS:
        z=load_leader_series(folder,sub,leader)
        merged=z if merged is None else merged.merge(z,on="date",how="inner")
    if merged is None or merged.empty:
        raise RuntimeError("NO_LEADER_ALIGNMENT")
    ret_cols=[f"{x}_ret1" for x in LEADERS]
    z_cols=[f"{x}_z1" for x in LEADERS]
    ret=merged[ret_cols].to_numpy(float)
    zs=merged[z_cols].to_numpy(float)
    composite=np.nanmedian(ret,axis=1)
    direction=np.where(composite>=0,1,-1)
    signed=ret*direction[:,None]
    agreement=(signed>0).sum(axis=1)
    shock=np.nanmax(np.abs(zs),axis=1)
    merged["compositeRet1"]=composite
    merged["leaderDirection"]=direction
    merged["leaderAgreement"]=agreement
    merged["leaderShockZ"]=shock
    mask=(
        np.isfinite(composite)
        &np.isfinite(shock)
        &(np.abs(composite)>=COMPOSITE_RET_MIN)
        &(shock>=SHOCK_Z_MIN)
        &(agreement>=AGREEMENT_MIN)
    )
    if market=="CRYPTO_SPOT":
        mask=mask&(direction>0)
    ev=merged.loc[mask].copy()
    ev["direction"]=np.where(ev["leaderDirection"]>0,"LONG","SHORT")
    ev["period"]=ev["date"].map(period_of)
    return ev.reset_index(drop=True)


def add_alt_features(x:pl.DataFrame)->pl.DataFrame:
    f=factory.features(x)
    return f.with_columns([
        (pl.col("close")/pl.col("prevClose")-1.0).alias("altRet1"),
        (pl.col("close")/pl.col("vwap32")-1.0).alias("vwapDist"),
    ])


def process_symbol(
    p:Path,
    sub:str,
    market:str,
    events_pl:pl.DataFrame,
):
    sym=factory.base_symbol(p,sub)
    if sym in LEADERS or not factory.allowed_symbol(sym):
        return None
    x=factory.load_file(p)
    if x is None or x.is_empty():
        return {"symbol":sym,"ok":False,"states":0,"positives":0,"sample":[]}
    f=add_alt_features(x)
    min_liq=5_000_000 if market=="CRYPTO_SPOT" else 10_000_000
    f=f.filter(pl.col("priorDollar24h")>=min_liq)
    if f.is_empty():
        return {"symbol":sym,"ok":True,"states":0,"positives":0,"sample":[]}
    joined=f.join(events_pl,on="date",how="inner")
    if joined.is_empty():
        return {"symbol":sym,"ok":True,"states":0,"positives":0,"sample":[]}

    pdf=x.to_pandas()
    pdf["date"]=pd.to_datetime(pdf["date"],utc=True)
    idxmap={pd.Timestamp(t):i for i,t in enumerate(pdf["date"])}
    sample=[]
    positives=0
    period_counts=Counter()
    period_pos=Counter()

    cols=[
        "date","direction","period","compositeRet1","leaderAgreement","leaderShockZ",
        "BTC_ret1","ETH_ret1","SOL_ret1","BTC_z1","ETH_z1","SOL_z1",
        "altRet1","ret4","ret16","rvol","priorDollar24h","vwapDist","closeLoc",
    ]
    for r in joined.select(cols).iter_rows(named=True):
        ts=pd.Timestamp(r["date"])
        i=idxmap.get(ts)
        if i is None:
            continue
        direction=str(r["direction"])
        if market=="CRYPTO_SPOT" and direction!="LONG":
            continue
        res=factory.simulate_one(
            pdf,
            i,
            direction,
            TARGET,
            HOLD_BARS,
            0.0,
        )
        if res is None:
            continue
        label=1 if res["exitReason"]=="TARGET" else 0
        positives+=label
        per=str(r["period"])
        period_counts[per]+=1
        period_pos[per]+=label

        signed_alt=float(r["altRet1"]) if direction=="LONG" else -float(r["altRet1"])
        comp_abs=abs(float(r["compositeRet1"]))
        response=signed_alt/max(comp_abs,1e-8)
        lag_gap=comp_abs-signed_alt
        keep=bool(label) or deterministic_keep(sym,ts,NEG_SAMPLE_PCT)
        if keep:
            sample.append({
                "market":market,
                "timestamp":ts,
                "symbol":sym,
                "direction":direction,
                "period":per,
                "label":label,
                "compositeRet1":float(r["compositeRet1"]),
                "leaderAgreement":float(r["leaderAgreement"]),
                "leaderShockZ":float(r["leaderShockZ"]),
                "btcRet1":float(r["BTC_ret1"]),
                "ethRet1":float(r["ETH_ret1"]),
                "solRet1":float(r["SOL_ret1"]),
                "btcZ1":float(r["BTC_z1"]),
                "ethZ1":float(r["ETH_z1"]),
                "solZ1":float(r["SOL_z1"]),
                "altRet1":float(r["altRet1"]),
                "ret4":float(r["ret4"]),
                "ret16":float(r["ret16"]),
                "rvol":float(r["rvol"]),
                "priorDollar24h":float(r["priorDollar24h"]),
                "vwapDist":float(r["vwapDist"]),
                "closeLoc":float(r["closeLoc"]),
                "responseRatio":float(response),
                "lagGap":float(lag_gap),
                "netReturn":float(res["netReturn"]),
                "MFE":float(res["MFE"]),
                "MAE":float(res["MAE"]),
                "exitReason":str(res["exitReason"]),
            })
    return {
        "symbol":sym,
        "ok":True,
        "states":int(sum(period_counts.values())),
        "positives":int(positives),
        "periodCounts":dict(period_counts),
        "periodPositives":dict(period_pos),
        "sample":sample,
    }


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    sub="spot" if market=="CRYPTO_SPOT" else "futures"
    out=Path(args.out_dir)
    out.mkdir(parents=True,exist_ok=True)

    folder=Path(snapshot_download(
        repo_id=DATASET,
        repo_type="dataset",
        allow_patterns=[f"{sub}/15m/*.parquet"],
    ))/sub/"15m"
    files=sorted(folder.glob("*.parquet"))
    if len(files)<500:
        raise RuntimeError(f"TOO_FEW_FILES:{market}:{len(files)}")

    events=build_events(folder,sub,market)
    if events.empty:
        raise RuntimeError(f"NO_MULTILEADER_EVENTS:{market}")
    event_counts=events.groupby("period").size().to_dict()

    event_cols=[
        "date","direction","period","compositeRet1","leaderAgreement","leaderShockZ",
        "BTC_ret1","ETH_ret1","SOL_ret1","BTC_z1","ETH_z1","SOL_z1",
    ]
    events_pl=pl.from_pandas(events[event_cols]).with_columns(
        pl.col("date").cast(pl.Datetime(time_zone="UTC"))
    )

    totals=Counter()
    period_states=Counter()
    period_pos=Counter()
    samples=[]
    audits=[]
    for idx,p in enumerate(files,1):
        r=process_symbol(p,sub,market,events_pl)
        if r is None:
            continue
        audits.append({
            "symbol":r["symbol"],
            "ok":r["ok"],
            "states":r["states"],
            "positives":r["positives"],
        })
        totals["symbolsProcessed"]+=1
        totals["states"]+=r["states"]
        totals["positives"]+=r["positives"]
        for k,v in r.get("periodCounts",{}).items():
            period_states[k]+=int(v)
        for k,v in r.get("periodPositives",{}).items():
            period_pos[k]+=int(v)
        if len(samples)<SAMPLE_LIMIT:
            room=SAMPLE_LIMIT-len(samples)
            samples.extend(r["sample"][:room])
        if idx%50==0 or idx==len(files):
            print(json.dumps({
                "filesComplete":idx,
                "files":len(files),
                "symbolsProcessed":totals["symbolsProcessed"],
                "states":totals["states"],
                "positives":totals["positives"],
                "sampleRows":len(samples),
                "market":market,
            }),flush=True)

    sample_df=pd.DataFrame(samples)
    if len(sample_df):
        sample_df.to_parquet(out/"states-sample.parquet",index=False)
    pd.DataFrame(audits).to_csv(out/"symbol-audit.csv",index=False)
    events.to_csv(out/"leader-events.csv",index=False)

    periods={}
    for per in ("train","calibration","validation","freshOos"):
        states=int(period_states[per])
        pos=int(period_pos[per])
        periods[per]={
            "leaderEvents":int(event_counts.get(per,0)),
            "eventSymbolStates":states,
            "targetBeforeStopLabels":pos,
            "positiveRate":(pos/states) if states else None,
        }

    result={
        "schemaVersion":1,
        "contract":"crypto-multileader-shock-lag-v5-probe",
        "market":market,
        "source15mFiles":len(files),
        "leaders":list(LEADERS),
        "eventDefinition":{
            "minMaxAbsPriorVolZ":SHOCK_Z_MIN,
            "minAbsMedianLeaderReturn":COMPOSITE_RET_MIN,
            "minimumDirectionalAgreement":AGREEMENT_MIN,
        },
        "leaderEventCount":int(len(events)),
        "symbolsProcessed":int(totals["symbolsProcessed"]),
        "eventSymbolStates":int(totals["states"]),
        "targetBeforeStopLabels":int(totals["positives"]),
        "positiveRate":(
            float(totals["positives"]/totals["states"])
            if totals["states"] else None
        ),
        "periods":periods,
        "sampleRows":int(len(sample_df)),
        "negativeSamplePct":NEG_SAMPLE_PCT,
        "label":{
            "entry":"NEXT_15M_OPEN",
            "targetPct":TARGET,
            "stopPct":STOP,
            "maxHoldBars":HOLD_BARS,
            "maxHoldHours":HOLD_BARS*0.25,
            "sameBarStopFirst":True,
        },
        "truthBoundary":{
            "allAvailable15mAltFilesScanned":True,
            "btcEthSolCompletedBarsOnly":True,
            "leaderVolatilityNormalizationUsesPriorBarsOnly":True,
            "eventHasNoClockTimeRestriction":True,
            "spotLongOnly":market=="CRYPTO_SPOT",
            "futuresLongShort":market=="CRYPTO_FUTURES",
            "entryUsesNextCompletedSignalBarOpen":True,
            "labelPathUsesFutureOnlyAfterSignal":True,
            "freshOosExcludedFromEventDefinitionTuning":True,
            "thisIsLabelProbeNotFinalStrategy":True,
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
