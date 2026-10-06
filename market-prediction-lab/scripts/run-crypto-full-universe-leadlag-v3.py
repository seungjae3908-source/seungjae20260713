#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from huggingface_hub import snapshot_download

ROOT=Path(__file__).resolve().parents[2]
V1_SCRIPT=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC=importlib.util.spec_from_file_location("hunter_v1",V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v1)

DATASET="rogerdehe/klines-binance"
START=pd.Timestamp("2023-04-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01",tz="UTC")
CAL_END=pd.Timestamp("2025-04-01",tz="UTC")
VAL_END=pd.Timestamp("2026-04-01",tz="UTC")
OOS_MAX_END=pd.Timestamp("2026-08-01",tz="UTC")
TOP_NS=(5,10,20)
HOLDS=(4,8,16)
EXITS=(
    ("TP3_SL1p5",0.03,0.015),
    ("TP5_SL1p5",0.05,0.015),
)
COSTS={"CRYPTO_SPOT":0.0020,"CRYPTO_FUTURES":0.0012}
STABLE_OR_NONDIR={
    "USDC","BUSD","TUSD","FDUSD","USDP","DAI","USDS","UST","USTC","EUR","EURT","AEUR",
    "PAX","PAXG","WBTC","WBETH",
}


def market_cfg(market:str):
    if market=="CRYPTO_SPOT":
        return "spot","BTC_USDT.parquet",["LONG"]
    return "futures","BTC_USDT_USDT.parquet",["LONG","SHORT"]


def base_symbol(path:Path,sub:str):
    name=path.stem
    if sub=="spot":
        return name[:-5] if name.endswith("_USDT") else name
    return name[:-10] if name.endswith("_USDT_USDT") else name


def allowed_symbol(sym:str):
    u=sym.upper()
    if u in STABLE_OR_NONDIR:
        return False
    if u.endswith(("UP","DOWN","BULL","BEAR")):
        return False
    return True


def load_15m(path:Path):
    try:
        x=pl.read_parquet(path,columns=["date","open","high","low","close","volume"])
    except Exception:
        return None
    if x.is_empty():
        return None
    x=x.with_columns([
        pl.col("date").cast(pl.Datetime(time_zone="UTC")),
        pl.col("open").cast(pl.Float64),
        pl.col("high").cast(pl.Float64),
        pl.col("low").cast(pl.Float64),
        pl.col("close").cast(pl.Float64),
        pl.col("volume").cast(pl.Float64),
    ]).filter(
        (pl.col("date")>=pl.lit(START))
        & (pl.col("date")<pl.lit(OOS_MAX_END))
        & (pl.col("open")>0)
        & (pl.col("close")>0)
    ).sort("date")
    return x if x.height else None


def btc_features(btc:pl.DataFrame):
    return (
        btc.with_columns([
            (pl.col("close")/pl.col("open")-1.0).alias("btcRet15"),
            (pl.col("close")/pl.col("close").shift(2)-1.0).alias("btcRet30"),
            (pl.col("close")/pl.col("close").shift(4)-1.0).alias("btcRet60"),
        ])
        .select(["date","btcRet15","btcRet30","btcRet60"])
        .drop_nulls()
    )


def add_alt_features(x:pl.DataFrame):
    return (
        x.with_columns([
            (pl.col("close")*pl.col("volume")).alias("dollar"),
            (pl.col("close")/pl.col("open")-1.0).alias("altRet15"),
            (pl.col("close")/pl.col("close").shift(2)-1.0).alias("altRet30"),
            (pl.col("close")/pl.col("close").shift(4)-1.0).alias("altRet60"),
        ])
        .with_columns([
            pl.col("dollar").shift(1).rolling_mean(96,min_samples=48).alias("priorDollar24h"),
            (pl.col("dollar")/pl.col("dollar").shift(1).rolling_mean(96,min_samples=48)).alias("rvol15"),
        ])
    )


def definitions(direction:str):
    if direction=="LONG":
        return [
            ("BTC15_LAG075", (pl.col("btcRet15")>=0.0075)&(pl.col("altRet15")<=pl.col("btcRet15")*0.35)&(pl.col("altRet15")>=-0.03), pl.col("btcRet15")-pl.col("altRet15")),
            ("BTC15_LAG125", (pl.col("btcRet15")>=0.0125)&(pl.col("altRet15")<=pl.col("btcRet15")*0.40)&(pl.col("altRet15")>=-0.03), pl.col("btcRet15")-pl.col("altRet15")),
            ("BTC15_LAG200", (pl.col("btcRet15")>=0.0200)&(pl.col("altRet15")<=pl.col("btcRet15")*0.50)&(pl.col("altRet15")>=-0.04), pl.col("btcRet15")-pl.col("altRet15")),
            ("BTC30_LAG120", (pl.col("btcRet30")>=0.012)&(pl.col("altRet30")<=pl.col("btcRet30")*0.40)&(pl.col("altRet30")>=-0.04), pl.col("btcRet30")-pl.col("altRet30")),
            ("BTC30_LAG200", (pl.col("btcRet30")>=0.020)&(pl.col("altRet30")<=pl.col("btcRet30")*0.50)&(pl.col("altRet30")>=-0.05), pl.col("btcRet30")-pl.col("altRet30")),
            ("BTC_ACCEL", (pl.col("btcRet15")>=0.008)&((pl.col("btcRet15")*2-pl.col("btcRet30"))>=0.004)&(pl.col("altRet15")<=0.004)&(pl.col("altRet15")>=-0.025), (pl.col("btcRet15")*2-pl.col("btcRet30"))+(pl.col("btcRet15")-pl.col("altRet15"))),
        ]
    return [
        ("BTC15_LAG075", (pl.col("btcRet15")<=-0.0075)&(pl.col("altRet15")>=pl.col("btcRet15")*0.35)&(pl.col("altRet15")<=0.03), pl.col("altRet15")-pl.col("btcRet15")),
        ("BTC15_LAG125", (pl.col("btcRet15")<=-0.0125)&(pl.col("altRet15")>=pl.col("btcRet15")*0.40)&(pl.col("altRet15")<=0.03), pl.col("altRet15")-pl.col("btcRet15")),
        ("BTC15_LAG200", (pl.col("btcRet15")<=-0.0200)&(pl.col("altRet15")>=pl.col("btcRet15")*0.50)&(pl.col("altRet15")<=0.04), pl.col("altRet15")-pl.col("btcRet15")),
        ("BTC30_LAG120", (pl.col("btcRet30")<=-0.012)&(pl.col("altRet30")>=pl.col("btcRet30")*0.40)&(pl.col("altRet30")<=0.04), pl.col("altRet30")-pl.col("btcRet30")),
        ("BTC30_LAG200", (pl.col("btcRet30")<=-0.020)&(pl.col("altRet30")>=pl.col("btcRet30")*0.50)&(pl.col("altRet30")<=0.05), pl.col("altRet30")-pl.col("btcRet30")),
        ("BTC_ACCEL", (pl.col("btcRet15")<=-0.008)&((pl.col("btcRet15")*2-pl.col("btcRet30"))<=-0.004)&(pl.col("altRet15")>=-0.004)&(pl.col("altRet15")<=0.025), -(pl.col("btcRet15")*2-pl.col("btcRet30"))+(pl.col("altRet15")-pl.col("btcRet15"))),
    ]


def collect_signals(files:list[Path],btc_f:pl.DataFrame,sub:str,market:str):
    rows=[]
    usable=0
    failed=[]
    min_liq=500_000 if market=="CRYPTO_SPOT" else 1_000_000
    dirs=market_cfg(market)[2]
    for idx,p in enumerate(files,1):
        sym=base_symbol(p,sub)
        if sym=="BTC" or not allowed_symbol(sym):
            continue
        x=load_15m(p)
        if x is None:
            failed.append({"symbol":sym,"error":"NO_15M_ROWS"}); continue
        usable+=1
        z=add_alt_features(x).join(btc_f,on="date",how="inner").filter(
            (pl.col("priorDollar24h")>=min_liq)
            & pl.col("rvol15").is_not_null()
        )
        if z.is_empty():
            continue
        for direction in dirs:
            for fam,mask,score in definitions(direction):
                s=z.filter(mask).select([
                    "date",
                    pl.lit(sym).alias("symbol"),
                    pl.lit(direction).alias("direction"),
                    pl.lit(fam).alias("family"),
                    (score + pl.col("rvol15").clip(0,10)*0.001).alias("score"),
                    "btcRet15","btcRet30","btcRet60","altRet15","altRet30","altRet60",
                    "rvol15","priorDollar24h",
                ])
                if s.height:
                    rows.append(s)
        if idx%50==0:
            print(json.dumps({"leadLagSignalScanFiles":idx,"files":len(files),"usable":usable,"frames":len(rows),"market":market}),flush=True)
    if not rows:
        raise RuntimeError(f"NO_LEADLAG_SIGNALS:{market}")
    sig=pl.concat(rows,how="vertical").sort(["date","score"],descending=[False,True])
    return sig,{"plannedFiles":len(files),"usableFiles":usable,"failedFiles":len(failed),"failurePreview":failed[:30]}


def select_topn(signals:pl.DataFrame,top_n:int):
    return (
        signals.sort(["date","family","direction","score"],descending=[False,False,False,True])
        .group_by(["date","family","direction"],maintain_order=True)
        .head(top_n)
    )


def simulate_selected_grid(selected:pl.DataFrame,file_map:dict[str,Path],sub:str,market:str,configs:list[tuple]):
    by_symbol={k:v for k,v in selected.partition_by("symbol",as_dict=True).items()}
    rows_by={name:[] for name,_,_,_ in configs}
    cost=COSTS[market]
    for key,sig in by_symbol.items():
        sym=key[0] if isinstance(key,tuple) else key
        p=file_map.get(str(sym))
        if p is None:
            continue
        x=load_15m(p)
        if x is None:
            continue
        pdf=x.to_pandas()
        pdf["date"]=pd.to_datetime(pdf["date"],utc=True)
        index={pd.Timestamp(t):i for i,t in enumerate(pdf["date"])}
        opens=pdf["open"].to_numpy(float)
        highs=pdf["high"].to_numpy(float)
        lows=pdf["low"].to_numpy(float)
        closes=pdf["close"].to_numpy(float)
        times=list(pdf["date"])
        for r in sig.iter_rows(named=True):
            t=pd.Timestamp(r["date"])
            i=index.get(t)
            if i is None or i+1>=len(pdf):
                continue
            entry_i=i+1
            entry=float(opens[entry_i])
            if entry<=0:
                continue
            direction=str(r["direction"])
            common={
                "market":market,"date":t.date(),"timestamp":t,"symbol":str(sym),
                "direction":direction,"family":r["family"],
                "btcRet15":r["btcRet15"],"btcRet30":r["btcRet30"],
                "altRet15":r["altRet15"],"altRet30":r["altRet30"],
                "rvol15":r["rvol15"],"priorDollar24h":r["priorDollar24h"],
            }
            for name,target,stop,hold in configs:
                end_i=min(len(pdf)-1,entry_i+hold-1)
                exit_i=end_i
                exit_price=float(closes[end_i])
                reason="TIME"
                if direction=="LONG":
                    tp=entry*(1+target); sl=entry*(1-stop)
                    for j in range(entry_i,end_i+1):
                        if lows[j]<=sl:
                            exit_i=j; exit_price=sl; reason="STOP"; break
                        if highs[j]>=tp:
                            exit_i=j; exit_price=tp; reason="TARGET"; break
                    gross=exit_price/entry-1.0
                    mfe=float(np.max(highs[entry_i:end_i+1]))/entry-1.0
                    mae=1.0-float(np.min(lows[entry_i:end_i+1]))/entry
                else:
                    tp=entry*(1-target); sl=entry*(1+stop)
                    for j in range(entry_i,end_i+1):
                        if highs[j]>=sl:
                            exit_i=j; exit_price=sl; reason="STOP"; break
                        if lows[j]<=tp:
                            exit_i=j; exit_price=tp; reason="TARGET"; break
                    gross=1.0-exit_price/entry
                    mfe=1.0-float(np.min(lows[entry_i:end_i+1]))/entry
                    mae=float(np.max(highs[entry_i:end_i+1]))/entry-1.0
                rows_by[name].append({
                    **common,
                    "candidate":name,
                    "entryTime":str(times[entry_i]),"exitTime":str(times[exit_i]),
                    "entryPrice":entry,"exitPrice":exit_price,"grossReturn":gross,
                    "roundTripCost":cost,"netReturn":gross-cost,"MFE":mfe,"MAE":mae,
                    "exitReason":reason,
                })
    return {name:pd.DataFrame(rows) for name,rows in rows_by.items()}

def to_pl(pdf):
    if pdf.empty:
        return pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    return pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))


def period_dates(start,end):
    return [d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]


def calc(pdf,market,start,end):
    return v1.metrics(to_pl(pdf),market,period_dates(start,end))


def gate(m,min_trades):
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1.0,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def split_metrics(pdf,market):
    d=pd.to_datetime(pdf["date"]).dt.date if len(pdf) else pd.Series([],dtype=object)
    return {
        "train":calc(pdf[d<TRAIN_END.date()] if len(pdf) else pdf,market,"2023-04-01","2024-10-01"),
        "calibration":calc(pdf[(d>=TRAIN_END.date())&(d<CAL_END.date())] if len(pdf) else pdf,market,"2024-10-01","2025-04-01"),
        "validation":calc(pdf[(d>=CAL_END.date())&(d<VAL_END.date())] if len(pdf) else pdf,market,"2025-04-01","2026-04-01"),
        "freshOos":calc(pdf[(d>=VAL_END.date())&(d<OOS_MAX_END.date())] if len(pdf) else pdf,market,"2026-04-01","2026-08-01"),
    }


def rank_key(m,name):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 1),
        int(m.get("tradeCount") or 0),
        name,
    )


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    sub,btc_name,dirs=market_cfg(market)
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    folder=Path(snapshot_download(
        repo_id=DATASET,repo_type="dataset",
        allow_patterns=[f"{sub}/15m/*.parquet"],
    ))/sub/"15m"
    files=sorted(folder.glob("*.parquet"))
    if len(files)<500:
        raise RuntimeError(f"LEADLAG_TOO_FEW_15M_FILES:{market}:{len(files)}")
    btc_path=folder/btc_name
    if not btc_path.exists():
        raise RuntimeError(f"BTC_15M_MISSING:{btc_path}")
    btc=load_15m(btc_path)
    if btc is None:
        raise RuntimeError("BTC_15M_EMPTY")
    btc_f=btc_features(btc)

    file_map={base_symbol(p,sub):p for p in files if allowed_symbol(base_symbol(p,sub))}
    sig,source=collect_signals(files,btc_f,sub,market)

    reports={}
    grid=[]
    ledgers={}
    for top_n in TOP_NS:
        selected=select_topn(sig,top_n)
        families=selected.select(["family","direction"]).unique().iter_rows(named=True)
        for fd in families:
            family=fd["family"]; direction=fd["direction"]
            s=selected.filter((pl.col("family")==family)&(pl.col("direction")==direction))
            configs=[]
            meta={}
            for exit_name,target,stop in EXITS:
                for hold in HOLDS:
                    name=f"{direction}_{family}_TOP{top_n}_{exit_name}_H{hold}"
                    configs.append((name,target,stop,hold))
                    meta[name]=(exit_name,hold)
            pdfs=simulate_selected_grid(s,file_map,sub,market,configs)
            for name,target,stop,hold in configs:
                exit_name,_=meta[name]
                pdf=pdfs[name]
                mm=split_metrics(pdf,market)
                gt=gate(mm["train"],80); gc=gate(mm["calibration"],25); gv=gate(mm["validation"],40); go=gate(mm["freshOos"],15)
                eligible=gt["pass"] and gc["pass"]
                reports[name]={
                    "direction":direction,"family":family,"topN":top_n,"exit":exit_name,"holdBars":hold,
                    **mm,"trainGate":gt,"calibrationGate":gc,"validationGate":gv,"freshOosGate":go,
                    "eligibleAfterCalibration":eligible,
                }
                if eligible: ledgers[name]=pdf
                grid.append({
                    "candidate":name,"direction":direction,"family":family,"topN":top_n,"exit":exit_name,"holdBars":hold,
                    "trainPass":gt["pass"],"trainReturn":mm["train"].get("totalReturn"),"trainPF":mm["train"].get("profitFactor"),"trainMDD":mm["train"].get("mdd"),"trainPosMonthRate":mm["train"].get("positiveMonthRate"),"trainTrades":mm["train"].get("tradeCount"),
                    "calibrationPass":gc["pass"],"calibrationReturn":mm["calibration"].get("totalReturn"),"calibrationPF":mm["calibration"].get("profitFactor"),"calibrationMDD":mm["calibration"].get("mdd"),"calibrationPosMonthRate":mm["calibration"].get("positiveMonthRate"),"calibrationTrades":mm["calibration"].get("tradeCount"),
                    "validationPass":gv["pass"],"validationReturn":mm["validation"].get("totalReturn"),"validationPF":mm["validation"].get("profitFactor"),"validationMDD":mm["validation"].get("mdd"),"validationPosMonthRate":mm["validation"].get("positiveMonthRate"),"validationTrades":mm["validation"].get("tradeCount"),
                    "freshOosPass":go["pass"],"freshOosReturn":mm["freshOos"].get("totalReturn"),"freshOosPF":mm["freshOos"].get("profitFactor"),"freshOosMDD":mm["freshOos"].get("mdd"),"freshOosPosMonthRate":mm["freshOos"].get("positiveMonthRate"),"freshOosTrades":mm["freshOos"].get("tradeCount"),
                    "distinctSymbols":int(pdf["symbol"].nunique()) if len(pdf) else 0,
                })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val_pass=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    full_pass=[n for n in val_pass if reports[n]["freshOosGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:
        ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)

    summary={
        "schemaVersion":1,
        "contract":"crypto-full-universe-btc-leadlag-v3",
        "market":market,
        "dataset":DATASET,
        "timeframe":"15m",
        "source15mFiles":len(files),
        "eligibleDirectionalFiles":len(file_map),
        "signalRowsBeforeTopN":sig.height,
        "sourceAudit":source,
        "candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(val_pass),
        "freshOosPassCount":len(full_pass),
        "validationPassCandidates":val_pass,
        "freshOosPassCandidates":full_pass,
        "selectedByCalibration":selected,
        "selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "allAvailable15mPairsScanned":True,
            "delistedPairsIncludedWhereDatasetRetainsThem":True,
            "topNAppliedOnlyAfterFullUniverseSignalScan":True,
            "btcSignalUsesCompleted15mBars":True,
            "entryUsesNext15mOpen":True,
            "stopFirstConservativeWithin15mBar":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "freshOosExcludedFromSelection":True,
            "duplicateParquetReadsAcrossExitConfigsEliminated":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
