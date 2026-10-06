#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import requests
from huggingface_hub import HfApi
from lightgbm import LGBMClassifier

ROOT=Path(__file__).resolve().parents[2]

DATASET="rogerdehe/klines-binance"
START=pd.Timestamp("2023-04-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01",tz="UTC")
CAL_END=pd.Timestamp("2025-04-01",tz="UTC")
END=pd.Timestamp("2026-04-01",tz="UTC")

HORIZON=32
TARGET=0.03
STOP=0.015
COSTS={"CRYPTO_SPOT":0.0020,"CRYPTO_FUTURES":0.0012}
MIN_DOLLAR_15M=25_000.0
SAMPLE_EVERY=4
MAX_ROWS_PER_SYMBOL={"train":3500,"calibration":1800,"validation":3000}
QUANTILES=(0.90,0.95,0.975,0.99)
MAX_WORKERS=6

FEATURES=[
  "ret1","ret4","ret16","ret96",
  "rvol","rangePct","atr16","closeLoc",
  "distHigh16","distLow16","distHigh96","distLow96",
  "compression","dollarAccel4","body","waveAccel",
]


def url_for(path:str)->str:
    return f"https://huggingface.co/datasets/{DATASET}/resolve/main/{path}"


def download_symbol(path:str):
    last=None
    for attempt in range(4):
        try:
            with requests.get(url_for(path),stream=True,timeout=180,allow_redirects=True,headers={"User-Agent":"market-prediction-lab/crypto-15m-ml-v1"}) as r:
                if r.status_code in (429,500,502,503,504):
                    raise RuntimeError(f"HTTP_{r.status_code}")
                r.raise_for_status()
                with tempfile.NamedTemporaryFile(suffix=".parquet") as tmp:
                    for chunk in r.iter_content(8*1024*1024):
                        if chunk:
                            tmp.write(chunk)
                    tmp.flush()
                    df=(pl.read_parquet(tmp.name,columns=["date","open","high","low","close","volume"])
                        .filter((pl.col("date")>=pl.lit(START.to_pydatetime()))&(pl.col("date")<pl.lit(END.to_pydatetime())))
                        .sort("date"))
                    return df,None
        except Exception as exc:
            last=exc
    return None,repr(last)


def symbol_from_path(path:str,market:str)->str:
    stem=Path(path).stem.upper()
    return stem.replace("_USDT","USDT") if market=="CRYPTO_SPOT" else stem.replace("_USDT_USDT","USDT")


def future_roll(s:pd.Series,window:int,kind:str):
    z=s.shift(-1)
    rev=z.iloc[::-1]
    if kind=="min":
        out=rev.rolling(window,min_periods=window).min().iloc[::-1]
    else:
        out=rev.rolling(window,min_periods=window).max().iloc[::-1]
    return out


def deterministic_cap(df:pd.DataFrame,n:int):
    if len(df)<=n:
        return df
    idx=np.linspace(0,len(df)-1,n,dtype=int)
    return df.iloc[idx].copy()


def process_symbol(path:str,market:str):
    df,err=download_symbol(path)
    if df is None or df.height<500:
        return None,{"path":path,"error":err or "TOO_FEW_ROWS"}
    x=df.to_pandas()
    x["timestamp"]=pd.to_datetime(x["date"],utc=True)
    x=x.drop(columns=["date"]).sort_values("timestamp").reset_index(drop=True)
    gap=x["timestamp"].diff()
    x["segment"]=(gap>pd.Timedelta(minutes=30)).cumsum()
    symbol=symbol_from_path(path,market)
    parts=[]

    for _,g0 in x.groupby("segment",sort=False):
        if len(g0)<220:
            continue
        g=g0.copy().reset_index(drop=True)
        for c in ["open","high","low","close","volume"]:
            g[c]=pd.to_numeric(g[c],errors="coerce")
        g=g.dropna(subset=["open","high","low","close","volume"]).reset_index(drop=True)
        if len(g)<220:
            continue

        close=g["close"].astype(float); high=g["high"].astype(float); low=g["low"].astype(float)
        op=g["open"].astype(float); vol=g["volume"].astype(float)
        dollar=close*vol
        prev_close=close.shift(1)
        tr=pd.concat([(high-low).abs(),(high-prev_close).abs(),(low-prev_close).abs()],axis=1).max(axis=1)
        atr16=tr.rolling(16,min_periods=12).mean()/close.replace(0,np.nan)
        prior_dollar96=dollar.shift(1).rolling(96,min_periods=48).mean()
        prior_dollar4=dollar.shift(1).rolling(4,min_periods=3).mean()
        high16=high.shift(1).rolling(16,min_periods=12).max()
        low16=low.shift(1).rolling(16,min_periods=12).min()
        high96=high.shift(1).rolling(96,min_periods=48).max()
        low96=low.shift(1).rolling(96,min_periods=48).min()

        g["ret1"]=close/close.shift(1)-1.0
        g["ret4"]=close/close.shift(4)-1.0
        g["ret16"]=close/close.shift(16)-1.0
        g["ret96"]=close/close.shift(96)-1.0
        g["rvol"]=dollar/prior_dollar96.replace(0,np.nan)
        g["rangePct"]=(high-low)/close.replace(0,np.nan)
        g["atr16"]=atr16
        g["closeLoc"]=(close-low)/(high-low).replace(0,np.nan)
        g["distHigh16"]=close/high16-1.0
        g["distLow16"]=close/low16-1.0
        g["distHigh96"]=close/high96-1.0
        g["distLow96"]=close/low96-1.0
        g["compression"]=g["rangePct"]/atr16.replace(0,np.nan)
        g["dollarAccel4"]=dollar/prior_dollar4.replace(0,np.nan)
        g["body"]=close/op-1.0
        g["waveAccel"]=g["ret4"]-0.25*g["ret16"]

        g["entryPrice"]=op.shift(-1)
        g["futureHigh"]=future_roll(high,HORIZON,"max")
        g["futureLow"]=future_roll(low,HORIZON,"min")
        g["endClose"]=close.shift(-HORIZON)

        entry=g["entryPrice"]
        long_tp=g["futureHigh"]>=entry*(1.0+TARGET)
        long_sl=g["futureLow"]<=entry*(1.0-STOP)
        short_tp=g["futureLow"]<=entry*(1.0-TARGET)
        short_sl=g["futureHigh"]>=entry*(1.0+STOP)

        # Conservative path ambiguity: if target and stop both occur in horizon, stop wins.
        g["longLabel"]=(long_tp & ~long_sl).astype(int)
        g["shortLabel"]=(short_tp & ~short_sl).astype(int)
        long_gross=np.where(long_sl,-STOP,np.where(long_tp & ~long_sl,TARGET,g["endClose"]/entry-1.0))
        short_gross=np.where(short_sl,-STOP,np.where(short_tp & ~short_sl,TARGET,1.0-g["endClose"]/entry))
        g["longNet"]=long_gross-COSTS[market]
        g["shortNet"]=short_gross-COSTS[market]
        g["longMFE"]=g["futureHigh"]/entry-1.0
        g["longMAE"]=1.0-g["futureLow"]/entry
        g["shortMFE"]=1.0-g["futureLow"]/entry
        g["shortMAE"]=g["futureHigh"]/entry-1.0
        g["priorDollar96"]=prior_dollar96

        activity=(
          (g["rvol"]>=1.2) |
          (g["ret4"].abs()>=0.01) |
          (g["compression"]<=0.80) |
          (g["distHigh16"]>=-0.03) |
          (g["distLow16"]<=0.03)
        )
        sample=(np.arange(len(g))%SAMPLE_EVERY)==0
        good=activity & sample & (g["priorDollar96"]>=MIN_DOLLAR_15M) & (g["atr16"]>=0.002) & g["entryPrice"].notna() & g["endClose"].notna()
        keep=g.loc[good,["timestamp","entryPrice","longLabel","shortLabel","longNet","shortNet","longMFE","longMAE","shortMFE","shortMAE"]+FEATURES].copy()
        if keep.empty:
            continue
        keep["symbol"]=symbol
        keep["date"]=keep["timestamp"].dt.date
        parts.append(keep)

    if not parts:
        return None,{"path":path,"error":"NO_CANDIDATE_STATES"}
    z=pd.concat(parts,ignore_index=True).sort_values("timestamp")
    # Deterministic per-symbol caps preserve every usable symbol without allowing giant legacy pairs to dominate.
    buckets=[]
    for name,a,b in [
      ("train",START,TRAIN_END),
      ("calibration",TRAIN_END,CAL_END),
      ("validation",CAL_END,END),
    ]:
        p=z[(z["timestamp"]>=a)&(z["timestamp"]<b)].copy()
        if p.empty:
            continue
        p=deterministic_cap(p,MAX_ROWS_PER_SYMBOL[name])
        p["period"]=name
        buckets.append(p)
    if not buckets:
        return None,{"path":path,"error":"NO_PERIOD_ROWS"}
    return pd.concat(buckets,ignore_index=True),None


def fit_model(train:pd.DataFrame,label:str):
    X=train[FEATURES].replace([np.inf,-np.inf],np.nan)
    y=train[label].astype(int)
    if len(train)<5000 or y.nunique()<2:
        raise RuntimeError(f"INSUFFICIENT_TRAIN:{label}:{len(train)}:{y.nunique()}")
    model=LGBMClassifier(
      objective="binary",
      n_estimators=350,
      learning_rate=0.04,
      num_leaves=31,
      min_child_samples=80,
      subsample=0.80,
      colsample_bytree=0.80,
      reg_lambda=1.0,
      class_weight="balanced",
      random_state=23,
      n_jobs=4,
      verbosity=-1,
    )
    model.fit(X,y)
    return model


def metric_frame(pdf:pd.DataFrame,net_col:str):
    prefix="long" if net_col=="longNet" else "short"
    mfe_col=f"{prefix}MFE"
    mae_col=f"{prefix}MAE"
    if pdf.empty:
        return pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64,"MFE":pl.Float64,"MAE":pl.Float64})
    cols=["date",net_col,mfe_col,mae_col]
    return pl.from_pandas(
        pdf[cols].rename(columns={net_col:"netReturn",mfe_col:"MFE",mae_col:"MAE"})
    ).with_columns(pl.col("date").cast(pl.Date))


def metrics(pdf,market,net_col,start,end):
    dates=[d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]
    return v1_metrics(metric_frame(pdf,net_col),market,dates)


def v1_metrics(trades,market,dates):
    # local import avoids importing full census before dependencies are available at module parse time
    import importlib.util
    p=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-causal-backtest-v1.py"
    spec=importlib.util.spec_from_file_location("hunter_metrics",p)
    m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m.metrics(trades,market,dates)


def gate(m,min_trades):
    checks={
      "positiveReturn":float(m.get("totalReturn") or 0)>0,
      "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
      "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,
      "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
      "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def eval_direction(data,market,direction):
    label="longLabel" if direction=="LONG" else "shortLabel"
    net="longNet" if direction=="LONG" else "shortNet"
    train=data[data["period"]=="train"].copy()
    cal=data[data["period"]=="calibration"].copy()
    val=data[data["period"]=="validation"].copy()

    model=fit_model(train,label)
    cal["score"]=model.predict_proba(cal[FEATURES].replace([np.inf,-np.inf],np.nan))[:,1]
    val["score"]=model.predict_proba(val[FEATURES].replace([np.inf,-np.inf],np.nan))[:,1]

    candidates=[]
    for q in QUANTILES:
        threshold=float(cal["score"].quantile(q))
        ct=cal[cal["score"]>=threshold].copy()
        vt=val[val["score"]>=threshold].copy()
        mc=metrics(ct,market,net,str(TRAIN_END.date()),str(CAL_END.date()))
        mv=metrics(vt,market,net,str(CAL_END.date()),str(END.date()))
        gc=gate(mc,100)
        gv=gate(mv,150)
        candidates.append({
          "quantile":q,"threshold":threshold,
          "calibration":mc,"validation":mv,
          "calibrationGate":gc,"validationGate":gv,
          "calibrationTrades":len(ct),"validationTrades":len(vt),
        })
    eligible=[x for x in candidates if x["calibrationGate"]["pass"]]
    winner=sorted(
      eligible,
      key=lambda x:(
        float(x["calibration"].get("positiveMonthRate") or 0),
        float(x["calibration"].get("totalReturn") or 0),
        float(x["calibration"].get("profitFactor") or 0),
        -float(x["calibration"].get("mdd") or 1),
        x["calibrationTrades"],
      ),
      reverse=True,
    )[0] if eligible else None

    importances=sorted(
      [{"feature":f,"importance":float(v)} for f,v in zip(FEATURES,model.feature_importances_)],
      key=lambda z:z["importance"],reverse=True
    )
    return {
      "direction":direction,
      "trainRows":len(train),"calibrationRows":len(cal),"validationRows":len(val),
      "trainPositiveRate":float(train[label].mean()),
      "calibrationScoreCandidates":candidates,
      "eligibleCalibrationCount":len(eligible),
      "winner":winner,
      "validationPass":bool(winner and winner["validationGate"]["pass"]),
      "featureImportance":importances,
    }


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    sub="spot" if market=="CRYPTO_SPOT" else "futures"
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    files=HfApi().list_repo_files(DATASET,repo_type="dataset")
    paths=[
      p for p in files
      if p.startswith(f"{sub}/15m/") and p.endswith(".parquet")
      and "-mark" not in p and "-funding_rate" not in p and "-index" not in p
    ]

    frames=[]; failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={pool.submit(process_symbol,p,market):p for p in paths}
        for idx,f in enumerate(concurrent.futures.as_completed(futs),1):
            df,err=f.result()
            if df is not None and not df.empty:
                frames.append(df)
            else:
                failures.append(err)
            if idx%25==0 or idx==len(futs):
                print(json.dumps({
                  "market":market,"filesComplete":idx,"total":len(futs),
                  "usableSymbols":len(frames),"failed":len(failures),
                  "sampleRows":sum(len(x) for x in frames),
                }),flush=True)

    if not frames:
        raise RuntimeError("NO_ML_STATES")
    data=pd.concat(frames,ignore_index=True)
    usable_symbols=int(data["symbol"].nunique())

    directions=["LONG"] if market=="CRYPTO_SPOT" else ["LONG","SHORT"]
    results={d:eval_direction(data,market,d) for d in directions}

    summary={
      "schemaVersion":1,
      "contract":"crypto-full-universe-15m-nonlinear-ml-v1",
      "market":market,
      "dataset":DATASET,
      "all15mFilesConsidered":len(paths),
      "usableSymbols":usable_symbols,
      "failedSymbols":len(failures),
      "failurePreview":failures[:40],
      "sampleRows":len(data),
      "sampling":{
        "everyNth15mBar":SAMPLE_EVERY,
        "minPriorDollarPer15m":MIN_DOLLAR_15M,
        "perSymbolPeriodCaps":MAX_ROWS_PER_SYMBOL,
        "broadActivityTrigger":True,
      },
      "directions":results,
      "validationPassDirections":[d for d,r in results.items() if r["validationPass"]],
      "truthBoundary":{
        "all15mPairFilesConsidered":True,
        "allUsableSymbolsRepresentedBeforePerSymbolCap":True,
        "featuresUseCompleted15mBarAndPastOnly":True,
        "entryNext15mOpen":True,
        "labelHorizonHours":8,
        "targetPct":TARGET,
        "stopPct":STOP,
        "targetStopSameHorizonAmbiguityUsesStopFirst":True,
        "modelFitTrainOnlyBefore2024_10":True,
        "probabilityThresholdSelectedCalibrationOnly":True,
        "validationExcludedFromSelection":True,
        "ohlcvOnlyStageOneNoTakerOrderFlowYet":True,
        "profitabilityProven":False,
        "executionAuthority":"NONE",
      },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")

    rows=[]
    for d,r in results.items():
        for c in r["calibrationScoreCandidates"]:
            rows.append({
              "direction":d,"quantile":c["quantile"],"threshold":c["threshold"],
              "calibrationPass":c["calibrationGate"]["pass"],
              "calibrationReturn":c["calibration"].get("totalReturn"),
              "calibrationPF":c["calibration"].get("profitFactor"),
              "calibrationMDD":c["calibration"].get("mdd"),
              "calibrationPosMonthRate":c["calibration"].get("positiveMonthRate"),
              "calibrationTrades":c["calibrationTrades"],
              "validationPass":c["validationGate"]["pass"],
              "validationReturn":c["validation"].get("totalReturn"),
              "validationPF":c["validation"].get("profitFactor"),
              "validationMDD":c["validation"].get("mdd"),
              "validationPosMonthRate":c["validation"].get("positiveMonthRate"),
              "validationTrades":c["validationTrades"],
            })
    pd.DataFrame(rows).to_csv(out/"threshold-grid.csv",index=False)
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
