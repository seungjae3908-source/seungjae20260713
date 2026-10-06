#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from huggingface_hub import snapshot_download
from lightgbm import LGBMClassifier

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

flow=load(
    "flow_v3",
    "market-prediction-lab/scripts/run-full-universe-3pct-hunter-crypto-flow-v3.py",
)
activity=load(
    "flow_v4_activity",
    "market-prediction-lab/scripts/run-crypto-full-universe-flow-v4.py",
)

DATASET="rogerdehe/klines-binance"
TARGET=0.03
STOP=0.015
HOLD_BARS=32
COSTS={"CRYPTO_SPOT":0.0020,"CRYPTO_FUTURES":0.0012}

TRAIN_END=pd.Timestamp("2024-10-01",tz="UTC")
CAL_END=pd.Timestamp("2025-04-01",tz="UTC")
VAL_END=pd.Timestamp("2026-04-01",tz="UTC")
END=pd.Timestamp("2026-10-01",tz="UTC")

FEATURES=[
    "activityScore","baseRvol","ret60",
    "flow1","flow4","flowAccel4","cvd12","cvd24",
    "takerRatio","takerAccel","rvol","ret4","ret12",
    "vwapDist","quoteAccel4","rangePct","closeLoc",
]

def market_cfg(market:str):
    return ("spot",["LONG"]) if market=="CRYPTO_SPOT" else ("futures",["LONG","SHORT"])

def add_month_context(months:set[str])->list[str]:
    out=set(months)
    for m in list(months):
        p=pd.Period(m,freq="M")
        out.add(str(p-1))
        out.add(str(p+1))
    return sorted(m for m in out if "2023-04"<=m<="2026-10")

def augment_features(pdf:pd.DataFrame)->pd.DataFrame:
    x=flow.add_features(pdf)
    out=[]
    for symbol,g0 in x.groupby("symbol",sort=False):
        g=g0.sort_values("timestamp").copy()
        q=pd.to_numeric(g["quote_volume"],errors="coerce").astype(float)
        tq=pd.to_numeric(g["taker_buy_quote"],errors="coerce").astype(float)
        delta=2.0*tq-q
        g["flow1"]=np.where(q>0,delta/q,np.nan)
        g["cvd12"]=(
            delta.rolling(12,min_periods=8).sum()
            / q.rolling(12,min_periods=8).sum().replace(0,np.nan)
        )
        g["cvd24"]=(
            delta.rolling(24,min_periods=12).sum()
            / q.rolling(24,min_periods=12).sum().replace(0,np.nan)
        )
        g["ret12"]=g["close"]/g["close"].shift(12)-1.0
        g["flowAccel4"]=g["flow4"]-g["flow4"].shift(4)
        prior_taker=g["takerRatio"].shift(1).rolling(8,min_periods=4).mean()
        g["takerAccel"]=g["takerRatio"]-prior_taker
        prior_q4=q.shift(1).rolling(4,min_periods=3).mean()
        g["quoteAccel4"]=q/prior_q4.replace(0,np.nan)
        g["vwapDist"]=g["close"]/g["vwap96"].replace(0,np.nan)-1.0
        g["rangePct"]=(g["high"]-g["low"])/g["close"].replace(0,np.nan)
        g["closeLoc"]=(g["close"]-g["low"])/(g["high"]-g["low"]).replace(0,np.nan)
        out.append(g)
    if not out:
        return pd.DataFrame()
    return pd.concat(out,ignore_index=True).replace([np.inf,-np.inf],np.nan)

def path_outcome(pdf:pd.DataFrame,i:int,direction:str,cost:float):
    if i+1>=len(pdf):
        return None
    signal_t=pd.Timestamp(pdf["timestamp"].iloc[i])
    entry_i=i+1
    entry_t=pd.Timestamp(pdf["timestamp"].iloc[entry_i])
    if entry_t-signal_t>pd.Timedelta(minutes=30):
        return None
    entry=float(pdf["open"].iloc[entry_i])
    if not np.isfinite(entry) or entry<=0:
        return None

    end_i=entry_i
    for j in range(entry_i,min(len(pdf),entry_i+HOLD_BARS)):
        if j>entry_i:
            prev=pd.Timestamp(pdf["timestamp"].iloc[j-1])
            cur=pd.Timestamp(pdf["timestamp"].iloc[j])
            if cur-prev>pd.Timedelta(minutes=30):
                break
        if pd.Timestamp(pdf["timestamp"].iloc[j])-entry_t>=pd.Timedelta(hours=8):
            break
        end_i=j

    if end_i<entry_i:
        return None

    tp=entry*(1+TARGET) if direction=="LONG" else entry*(1-TARGET)
    sl=entry*(1-STOP) if direction=="LONG" else entry*(1+STOP)
    reason="TIME"
    exit_i=end_i
    exit_px=float(pdf["close"].iloc[end_i])

    highs=pd.to_numeric(pdf["high"].iloc[entry_i:end_i+1],errors="coerce").to_numpy(float)
    lows=pd.to_numeric(pdf["low"].iloc[entry_i:end_i+1],errors="coerce").to_numpy(float)
    for j in range(entry_i,end_i+1):
        hi=float(pdf["high"].iloc[j]); lo=float(pdf["low"].iloc[j])
        if direction=="LONG":
            if lo<=sl:
                reason="STOP";exit_i=j;exit_px=sl;break
            if hi>=tp:
                reason="TARGET";exit_i=j;exit_px=tp;break
        else:
            if hi>=sl:
                reason="STOP";exit_i=j;exit_px=sl;break
            if lo<=tp:
                reason="TARGET";exit_i=j;exit_px=tp;break

    if direction=="LONG":
        gross=exit_px/entry-1.0
        mfe=float(np.nanmax(highs))/entry-1.0
        mae=1.0-float(np.nanmin(lows))/entry
    else:
        gross=1.0-exit_px/entry
        mfe=1.0-float(np.nanmin(lows))/entry
        mae=float(np.nanmax(highs))/entry-1.0
    return {
        "entryTime":pd.Timestamp(pdf["timestamp"].iloc[entry_i]),
        "exitTime":pd.Timestamp(pdf["timestamp"].iloc[exit_i]),
        "entryPrice":entry,
        "exitPrice":exit_px,
        "pathOutcome":reason,
        "labelTargetFirst3":1 if reason=="TARGET" else 0,
        "grossReturn":gross,
        "netReturn":gross-cost,
        "MFE":mfe,
        "MAE":mae,
    }

def process_symbol(market:str,symbol:str,candidates:pd.DataFrame):
    months=set(candidates["month"].astype(str))
    frames=[];failures=[]
    for m in add_month_context(months):
        _,_,df,status=flow.fetch_month_symbol(market,symbol,m)
        if df is not None and not df.empty:
            frames.append(df)
        elif status!="404":
            failures.append({"month":m,"status":status})
    if not frames:
        return [],{"symbol":symbol,"ok":False,"error":"NO_RAW_FRAMES","failures":failures[:10]}

    raw=pd.concat(frames,ignore_index=True).sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    feat=augment_features(raw)
    if feat.empty:
        return [],{"symbol":symbol,"ok":False,"error":"NO_FEATURES","failures":failures[:10]}

    feat["timestamp"]=pd.to_datetime(feat["timestamp"],utc=True)
    raw["timestamp"]=pd.to_datetime(raw["timestamp"],utc=True)
    idxmap={pd.Timestamp(t):i for i,t in enumerate(raw["timestamp"])}
    fidx=feat.set_index("timestamp",drop=False)

    rows=[]
    directions=market_cfg(market)[1]
    for _,cand in candidates.iterrows():
        t=pd.Timestamp(cand["timestamp"])
        if t.tzinfo is None:
            t=t.tz_localize("UTC")
        else:
            t=t.tz_convert("UTC")
        if t not in fidx.index:
            continue
        fr=fidx.loc[t]
        if isinstance(fr,pd.DataFrame):
            fr=fr.iloc[-1]
        i=idxmap.get(t)
        if i is None:
            continue
        vals={
            "activityScore":float(cand["activityScore"]),
            "baseRvol":float(cand["baseRvol"]),
            "ret60":float(cand["ret60"]),
            "flow1":fr.get("flow1"),"flow4":fr.get("flow4"),
            "flowAccel4":fr.get("flowAccel4"),"cvd12":fr.get("cvd12"),
            "cvd24":fr.get("cvd24"),"takerRatio":fr.get("takerRatio"),
            "takerAccel":fr.get("takerAccel"),"rvol":fr.get("rvol"),
            "ret4":fr.get("ret4"),"ret12":fr.get("ret12"),
            "vwapDist":fr.get("vwapDist"),"quoteAccel4":fr.get("quoteAccel4"),
            "rangePct":fr.get("rangePct"),"closeLoc":fr.get("closeLoc"),
        }
        if any(not np.isfinite(float(v)) for v in vals.values() if v is not None):
            continue
        if any(v is None or pd.isna(v) for v in vals.values()):
            continue
        for direction in directions:
            oc=path_outcome(raw,i,direction,COSTS[market])
            if oc is None:
                continue
            rows.append({
                "market":market,"symbol":symbol,"timestamp":t,
                "date":t.date(),"month":t.strftime("%Y-%m"),
                "direction":direction,**{k:float(v) for k,v in vals.items()},**oc,
            })
    return rows,{
        "symbol":symbol,"ok":True,"candidateRows":int(len(candidates)),
        "labeledRows":int(len(rows)),"rawRows":int(len(raw)),
        "featureRows":int(len(feat)),"failures":failures[:10],
    }

def period_for(ts:pd.Series)->pd.Series:
    t=pd.to_datetime(ts,utc=True)
    return np.select(
        [t<TRAIN_END,t<CAL_END,t<VAL_END,t<END],
        ["train","calibration","validation","fresh_oos"],
        default="outside",
    )

def economic_metrics(df:pd.DataFrame,score:np.ndarray,threshold:float):
    pred=score>=threshold
    y=df["labelTargetFirst3"].astype(int).to_numpy()
    net=df["netReturn"].astype(float).to_numpy()
    selected=int(pred.sum())
    tp=int((pred&(y==1)).sum())
    positives=int((y==1).sum())
    precision=tp/max(selected,1)
    recall=tp/max(positives,1)
    sel=net[pred]
    pos=float(np.maximum(sel,0).sum()) if selected else 0.0
    neg=float(np.maximum(-sel,0).sum()) if selected else 0.0
    pf=pos/max(neg,1e-12) if selected else 0.0
    months_pos=0;months_neg=0
    if selected:
        z=pd.DataFrame({"month":df["month"].to_numpy()[pred],"net":sel})
        ms=z.groupby("month")["net"].sum()
        months_pos=int((ms>0).sum());months_neg=int((ms<0).sum())
    active=months_pos+months_neg
    return {
        "threshold":float(threshold),"rows":int(len(df)),
        "sampleSelected":selected,"positiveRows":positives,
        "selectedPositiveRows":tp,"precision":float(precision),"recall":float(recall),
        "selectedShare":float(selected/max(len(df),1)),
        "meanNetReturn":float(sel.mean()) if selected else 0.0,
        "profitFactor":float(pf),
        "positiveMonths":months_pos,"negativeMonths":months_neg,
        "positiveActiveMonthRate":float(months_pos/max(active,1)),
    }

def choose_threshold(cal:pd.DataFrame,score:np.ndarray):
    qs=np.unique(np.concatenate([
        np.linspace(0.50,0.90,17),np.linspace(0.91,0.99,17),
        np.array([0.9925,0.995,0.9975,0.999]),
    ]))
    rows=[economic_metrics(cal,score,float(t)) for t in np.unique(np.quantile(score,qs))]
    eligible=[
        r for r in rows
        if r["sampleSelected"]>=100
        and r["meanNetReturn"]>0
        and r["profitFactor"]>1
        and r["precision"]>=0.35
        and r["recall"]>=0.10
        and r["selectedShare"]<=0.30
        and r["positiveActiveMonthRate"]>=0.50
    ]
    if eligible:
        winner=max(eligible,key=lambda r:(r["meanNetReturn"],r["profitFactor"],r["recall"],r["precision"]))
        mode="ECONOMIC_GATE"
    else:
        cand=[r for r in rows if r["sampleSelected"]>=100] or rows
        winner=max(cand,key=lambda r:(r["meanNetReturn"],r["profitFactor"],r["recall"]))
        mode="BEST_EV_DIAGNOSTIC"
    return {"selectionMode":mode,"winner":winner,"grid":rows}

def gate(m):
    checks={
        "minimumSelectedRows":m["sampleSelected"]>=100,
        "positiveEV":m["meanNetReturn"]>0,
        "profitFactorAbove1":m["profitFactor"]>1,
        "precisionAtLeast35pct":m["precision"]>=0.35,
        "recallAtLeast10pct":m["recall"]>=0.10,
        "selectedShareAtMost30pct":m["selectedShare"]<=0.30,
        "positiveActiveMonthRateAtLeast50pct":m["positiveActiveMonthRate"]>=0.50,
    }
    return {"pass":all(checks.values()),"checks":checks}

def train_direction(data:pd.DataFrame,direction:str):
    d=data[data["direction"]==direction].copy()
    train=d[d["period"]=="train"].copy()
    cal=d[d["period"]=="calibration"].copy()
    val=d[d["period"]=="validation"].copy()
    fresh=d[d["period"]=="fresh_oos"].copy()
    if min(len(train),len(cal),len(val),len(fresh))<100:
        raise RuntimeError(f"V43_EMPTY_PERIOD:{direction}:{len(train)}:{len(cal)}:{len(val)}:{len(fresh)}")

    y=train["labelTargetFirst3"].astype(int)
    model=LGBMClassifier(
        objective="binary",n_estimators=550,learning_rate=0.03,
        num_leaves=31,min_child_samples=80,subsample=0.80,
        colsample_bytree=0.85,reg_alpha=0.20,reg_lambda=1.75,
        random_state=113,n_jobs=4,verbosity=-1,
    )
    model.fit(train[FEATURES],y)
    cal_score=model.predict_proba(cal[FEATURES])[:,1]
    sel=choose_threshold(cal,cal_score)
    thr=float(sel["winner"]["threshold"])
    val_m=economic_metrics(val,model.predict_proba(val[FEATURES])[:,1],thr)
    fresh_m=economic_metrics(fresh,model.predict_proba(fresh[FEATURES])[:,1],thr)
    return {
        "direction":direction,
        "rowCounts":{"train":len(train),"calibration":len(cal),"validation":len(val),"freshOos":len(fresh)},
        "trainPositiveRate":float(y.mean()),
        "calibrationSelection":sel,
        "validation":val_m,"freshOos":fresh_m,
        "validationGate":gate(val_m),"freshOosGate":gate(fresh_m),
        "promotionPass":bool(gate(val_m)["pass"] and gate(fresh_m)["pass"]),
        "featureImportance":sorted(
            [{"feature":f,"importance":float(v)} for f,v in zip(FEATURES,model.feature_importances_)],
            key=lambda z:z["importance"],reverse=True,
        ),
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    sub,_=market_cfg(market)
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    folder=Path(snapshot_download(
        repo_id=DATASET,repo_type="dataset",allow_patterns=[f"{sub}/15m/*.parquet"]
    ))/sub/"15m"
    files,selected,tasks,prescreen_failures=activity.full_universe_prescreen(folder,sub)
    selected=selected.clone()
    selected_pd=selected.to_pandas()
    selected_pd["timestamp"]=pd.to_datetime(selected_pd["date"],utc=True)
    selected_pd["month"]=selected_pd["month"].astype(str)

    by_symbol=defaultdict(list)
    for _,r in selected_pd.iterrows():
        by_symbol[str(r["symbol"])].append(r.to_dict())

    rows=[];audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futs={}
        for symbol,rr in by_symbol.items():
            cand=pd.DataFrame(rr)
            futs[pool.submit(process_symbol,market,symbol,cand)]=symbol
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            symbol=futs[fut]
            try:
                r,a=fut.result()
            except Exception as exc:
                r=[];a={"symbol":symbol,"ok":False,"error":repr(exc)}
            rows.extend(r);audits.append(a)
            if idx%25==0 or idx==len(futs):
                print(json.dumps({
                    "v43SymbolsComplete":idx,"symbols":len(futs),
                    "labeledRows":len(rows),"market":market
                }),flush=True)

    if not rows:
        raise RuntimeError(f"V43_NO_LABELED_ROWS:{market}")
    data=pd.DataFrame(rows)
    data["period"]=period_for(data["timestamp"])
    data=data[data["period"]!="outside"].copy()
    data=data.replace([np.inf,-np.inf],np.nan).dropna(subset=FEATURES+["netReturn","labelTargetFirst3"])
    data.to_parquet(out/"events.parquet",index=False)
    pd.DataFrame(audits).to_csv(out/"symbol-audit.csv",index=False)

    results={}
    for direction in market_cfg(market)[1]:
        results[direction]=train_direction(data,direction)
    promotion=any(r["promotionPass"] for r in results.values())
    result={
        "schemaVersion":1,
        "contract":"crypto-orderflow-targetfirst-ai-v43",
        "market":market,
        "source15mFiles":len(files),
        "prescreenRows":int(len(selected_pd)),
        "prescreenFailures":len(prescreen_failures),
        "symbolsAttempted":len(by_symbol),
        "labeledRows":int(len(data)),
        "features":FEATURES,
        "directions":results,
        "promotionPass":bool(promotion),
        "truthBoundary":{
            "allAvailable15mPairsScannedBeforeActivityPromotion":True,
            "crossSectionalActivityTop50PerDayNarrowsRawMicrostructureStage":True,
            "rawTakerBuyQuoteUsesBinancePublicMonthlyArchives":True,
            "signalFeaturesUseCompleted15mBarAndPastOnly":True,
            "entryUsesNext15mOpen":True,
            "targetBeforeStopUsesForward15mHighLow":True,
            "sameBarTargetStopUsesStopFirst":True,
            "targetPct":TARGET,"stopPct":STOP,"maxHoldHours":8,
            "validationAndFreshOosExcludedFromFitAndThresholdSelection":True,
            "eventLevelEconomicsNotPortfolioPnl":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8"
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
