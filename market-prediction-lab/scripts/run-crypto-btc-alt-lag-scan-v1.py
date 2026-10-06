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

DATASET="rogerdehe/klines-binance"
START=pd.Timestamp("2023-04-01",tz="UTC")
TRAIN_END=pd.Timestamp("2025-04-01",tz="UTC")
END=pd.Timestamp("2026-04-01",tz="UTC")
TIMEFRAME="3m"
MIN_ROWS_TRAIN=50_000
MIN_ROWS_VALID=20_000
MAX_WORKERS=8


def url_for(path:str)->str:
    return f"https://huggingface.co/datasets/{DATASET}/resolve/main/{path}"


def download_read(path:str):
    last=None
    for attempt in range(4):
        try:
            with requests.get(url_for(path),stream=True,timeout=180,allow_redirects=True,headers={"User-Agent":"market-prediction-lab/btc-alt-lag-scan"}) as r:
                if r.status_code in (429,500,502,503,504):
                    raise RuntimeError(f"HTTP_{r.status_code}")
                r.raise_for_status()
                with tempfile.NamedTemporaryFile(suffix=".parquet") as tmp:
                    for chunk in r.iter_content(8*1024*1024):
                        if chunk:
                            tmp.write(chunk)
                    tmp.flush()
                    df=(pl.read_parquet(tmp.name,columns=["date","close","volume"])
                        .filter((pl.col("date")>=pl.lit(START.to_pydatetime()))&(pl.col("date")<pl.lit(END.to_pydatetime())))
                        .sort("date"))
                    return df,None
        except Exception as exc:
            last=exc
    return None,repr(last)


def symbol_from_path(path:str,market:str)->str:
    stem=Path(path).stem.upper()
    if market=="CRYPTO_SPOT":
        return stem.replace("_USDT","USDT")
    return stem.replace("_USDT_USDT","USDT")


def prep(df:pl.DataFrame):
    if df is None or df.height<1000:
        return None
    pdf=df.to_pandas()
    pdf["date"]=pd.to_datetime(pdf["date"],utc=True)
    pdf["ret"]=np.log(pd.to_numeric(pdf["close"],errors="coerce")).diff()
    pdf["dollar"]=pd.to_numeric(pdf["close"],errors="coerce")*pd.to_numeric(pdf["volume"],errors="coerce")
    return pdf.dropna(subset=["date","ret","dollar"])


def corr_stats(alt:pd.DataFrame,btc:pd.DataFrame,start,end):
    a=alt[(alt["date"]>=start)&(alt["date"]<end)][["date","ret"]].rename(columns={"ret":"alt"})
    b=btc[(btc["date"]>=start)&(btc["date"]<end)][["date","ret"]].rename(columns={"ret":"btc"})
    x=a.merge(b,on="date",how="inner").sort_values("date")
    if len(x)<1000:
        return None
    vals={
      "rows":len(x),
      "rho0":x["alt"].corr(x["btc"]),
      "rhoLag1":x["alt"].corr(x["btc"].shift(1)),
      "rhoLag2":x["alt"].corr(x["btc"].shift(2)),
    }
    for k,v in list(vals.items()):
        if k!="rows" and (v is None or not np.isfinite(v)):
            vals[k]=None
    valid=[v for k,v in vals.items() if k.startswith("rhoLag") and v is not None]
    vals["bestLagCorr"]=max(valid) if valid else None
    vals["delayScore"]=(vals["bestLagCorr"]-vals["rho0"]) if valid and vals["rho0"] is not None else None
    return vals


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
      if p.startswith(f"{sub}/{TIMEFRAME}/") and p.endswith(".parquet")
      and "-mark" not in p and "-funding_rate" not in p and "-index" not in p
    ]
    btc_candidates=[p for p in paths if Path(p).stem.upper() in (("BTC_USDT",) if sub=="spot" else ("BTC_USDT_USDT",))]
    if not btc_candidates:
        raise RuntimeError("BTC_3M_FILE_NOT_FOUND")
    btc_df,err=download_read(btc_candidates[0])
    if btc_df is None:
        raise RuntimeError(f"BTC_3M_DOWNLOAD_FAILED:{err}")
    btc=prep(btc_df)
    if btc is None:
        raise RuntimeError("BTC_3M_EMPTY")

    alt_paths=[p for p in paths if p!=btc_candidates[0]]
    rows=[]; failures=[]
    def one(path):
        df,err=download_read(path)
        if df is None:
            return None,{"path":path,"error":err}
        alt=prep(df)
        if alt is None:
            return None,{"path":path,"error":"TOO_FEW_ROWS"}
        tr=corr_stats(alt,btc,START,TRAIN_END)
        va=corr_stats(alt,btc,TRAIN_END,END)
        if tr is None or va is None:
            return None,{"path":path,"error":"INSUFFICIENT_OVERLAP"}
        liq=float(alt[(alt["date"]>=START)&(alt["date"]<TRAIN_END)]["dollar"].median())
        return {
          "symbol":symbol_from_path(path,market),
          "path":path,
          "trainRows":tr["rows"],"trainRho0":tr["rho0"],"trainLag1":tr["rhoLag1"],"trainLag2":tr["rhoLag2"],"trainBestLagCorr":tr["bestLagCorr"],"trainDelayScore":tr["delayScore"],
          "validationRows":va["rows"],"validationRho0":va["rho0"],"validationLag1":va["rhoLag1"],"validationLag2":va["rhoLag2"],"validationBestLagCorr":va["bestLagCorr"],"validationDelayScore":va["delayScore"],
          "trainMedianDollar3m":liq,
        },None

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs={pool.submit(one,p):p for p in alt_paths}
        for idx,f in enumerate(concurrent.futures.as_completed(futs),1):
            r,e=f.result()
            if r is not None: rows.append(r)
            else: failures.append(e)
            if idx%50==0 or idx==len(futs):
                print(json.dumps({"market":market,"filesComplete":idx,"total":len(futs),"usable":len(rows),"failed":len(failures)}),flush=True)

    pdf=pd.DataFrame(rows)
    if pdf.empty:
        raise RuntimeError("NO_ALT_LAG_RESULTS")
    pdf["liquidityPct"]=pdf["trainMedianDollar3m"].rank(pct=True,method="average")
    # Structural lag must be present in both pre-selected train and untouched validation.
    pdf["structuralLag"]=(
      (pdf["trainDelayScore"]>0)&(pdf["validationDelayScore"]>0)&
      (pdf["trainBestLagCorr"]>0.02)&(pdf["validationBestLagCorr"]>0.02)
    )
    # Paper hypothesis expects lag to be stronger among lower-liquidity ALTs.
    pdf["paperLikeLag"]=pdf["structuralLag"]&(pdf["liquidityPct"]<=0.50)
    pdf["combinedDelayScore"]=pdf["trainDelayScore"]+pdf["validationDelayScore"]
    pdf=pdf.sort_values(["paperLikeLag","combinedDelayScore"],ascending=[False,False])
    pdf.to_csv(out/"all-symbol-lag-scan.csv",index=False)
    survivors=pdf[pdf["paperLikeLag"]].head(120).copy()
    survivors.to_csv(out/"one-minute-survivors.csv",index=False)

    summary={
      "schemaVersion":1,
      "contract":"crypto-btc-alt-lag-scan-v1",
      "market":market,
      "dataset":DATASET,
      "timeframe":TIMEFRAME,
      "allFilesConsidered":len(paths),
      "altFilesAttempted":len(alt_paths),
      "usableAltSymbols":len(pdf),
      "failedFiles":len(failures),
      "failurePreview":failures[:30],
      "structuralLagCount":int(pdf["structuralLag"].sum()),
      "paperLikeLowLiquidityLagCount":int(pdf["paperLikeLag"].sum()),
      "oneMinuteSurvivorCount":len(survivors),
      "topSurvivors":survivors[["symbol","trainRho0","trainBestLagCorr","trainDelayScore","validationRho0","validationBestLagCorr","validationDelayScore","liquidityPct"]].head(30).to_dict("records"),
      "truthBoundary":{
        "allThreeMinutePairsConsidered":True,
        "btcLeadOnlyNoAltToBtcSelection":True,
        "trainEnds2025_04_01":True,
        "validation2025_04_to_2026_04UntouchedByThresholdSelection":True,
        "lowLiquidityFilterMatchesPaperHypothesis":True,
        "thisIsStructuralScanNotProfitabilityPass":True,
        "executionAuthority":"NONE",
      },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
