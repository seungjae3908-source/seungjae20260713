#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import io
import json
import time
import zipfile
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import requests

ROOT=Path(__file__).resolve().parents[2]
V1_PATH=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-causal-backtest-v1.py"
FLOW_PATH=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-crypto-flow-v3.py"

def loadmod(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    if spec is None or spec.loader is None: raise RuntimeError(f"IMPORT_FAILED:{name}")
    mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

v1=loadmod(V1_PATH,"hunter_v1")
flow=loadmod(FLOW_PATH,"crypto_flow_v3")

TRAIN_END=flow.TRAIN_END
VALID_END=flow.VALID_END
OOS_END=flow.OOS_END
COST=flow.COSTS["CRYPTO_FUTURES"]

BASES=(1,3)
OI_RULES={
    "OI1H_UP": lambda x: x["oi1h"]>=0.005,
    "OI1H_DOWN": lambda x: x["oi1h"]<=-0.005,
    "OI4H_UP": lambda x: x["oi4h"]>=0.010,
    "OI4H_DOWN": lambda x: x["oi4h"]<=-0.010,
    "OI1H_UP_CROWD_LONG": lambda x: (x["oi1h"]>=0.005)&(x["count_long_short_ratio"]>=1.0),
    "OI1H_DOWN_CROWD_LONG": lambda x: (x["oi1h"]<=-0.005)&(x["count_long_short_ratio"]>=1.0),
    "OI1H_UP_TAKER_SHORT": lambda x: (x["oi1h"]>=0.005)&(x["sum_taker_long_short_vol_ratio"]<=1.0),
    "OI1H_DOWN_TAKER_SHORT": lambda x: (x["oi1h"]<=-0.005)&(x["sum_taker_long_short_vol_ratio"]<=1.0),
}

def metrics_url(symbol,day):
    return f"https://data.binance.vision/data/futures/um/daily/metrics/{symbol}/{symbol}-metrics-{day}.zip"

def fetch_metrics(symbol,day):
    url=metrics_url(symbol,day)
    last=None
    for attempt in range(4):
        try:
            r=requests.get(url,timeout=30,headers={"User-Agent":"market-prediction-lab/futures-oi-v4"})
            if r.status_code==404: return symbol,day,None,"404"
            if r.status_code in (429,500,502,503,504): raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            z=zipfile.ZipFile(io.BytesIO(r.content)); name=z.namelist()[0]
            df=pd.read_csv(z.open(name))
            if df.empty: return symbol,day,None,"EMPTY"
            return symbol,day,df,"OK"
        except Exception as exc:
            last=exc; time.sleep(min(2*(attempt+1),8))
    return symbol,day,None,repr(last)

def load_metrics_for_signals(signals:pd.DataFrame):
    pairs=set()
    for row in signals[["symbol","signalEnd"]].itertuples(index=False):
        day=pd.Timestamp(row.signalEnd).date()
        pairs.add((row.symbol,str(day)))
        pairs.add((row.symbol,str(day-timedelta(days=1))))
    frames=[]; fail=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futs={pool.submit(fetch_metrics,s,d):(s,d) for s,d in pairs}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            s,d=futs[fut]; ss,dd,df,status=fut.result()
            if df is not None:
                df["symbol"]=ss; frames.append(df)
            else: fail.append({"symbol":s,"day":d,"status":status})
            if idx%200==0 or idx==len(pairs):
                print(json.dumps({"oiFilesComplete":idx,"planned":len(pairs),"usable":len(frames),"failed":len(fail)}),flush=True)
    if not frames: raise RuntimeError("NO_OI_METRICS")
    m=pd.concat(frames,ignore_index=True)
    required=["create_time","sum_open_interest","sum_open_interest_value","count_toptrader_long_short_ratio","sum_toptrader_long_short_ratio","count_long_short_ratio","sum_taker_long_short_vol_ratio"]
    miss=[c for c in required if c not in m.columns]
    if miss: raise RuntimeError(f"OI_COLUMNS_MISSING:{miss}")
    m["create_time"]=pd.to_datetime(m["create_time"],utc=True,errors="coerce")
    for c in required[1:]: m[c]=pd.to_numeric(m[c],errors="coerce")
    m=m.dropna(subset=["create_time","sum_open_interest"]).sort_values(["symbol","create_time"])
    changed=m["create_time"].dt.date>=pd.Timestamp("2026-06-25").date()
    m["effective_time"]=m["create_time"]
    m.loc[changed,"effective_time"]=m.loc[changed,"effective_time"]+pd.Timedelta(minutes=5)
    out=[]
    for symbol,g0 in m.groupby("symbol",sort=False):
        g0=g0.sort_values("effective_time").copy()
        seg=(g0["effective_time"].diff()>pd.Timedelta(minutes=10)).cumsum()
        for _,g in g0.groupby(seg,sort=False):
            g=g.copy()
            g["oi1h"]=g["sum_open_interest"]/g["sum_open_interest"].shift(12)-1.0
            g["oi4h"]=g["sum_open_interest"]/g["sum_open_interest"].shift(48)-1.0
            out.append(g)
    m=pd.concat(out,ignore_index=True).dropna(subset=["oi1h","oi4h"])
    return m,{"plannedFiles":len(pairs),"usableFiles":len(frames),"failedFiles":len(fail),"failurePreview":fail[:30]}

def attach_metrics(signals:pl.DataFrame,metrics:pd.DataFrame)->pd.DataFrame:
    s=signals.to_pandas()
    s["timestamp"]=pd.to_datetime(s["timestamp"],utc=True)
    s["signalEnd"]=s["timestamp"]+pd.Timedelta(minutes=15)
    chunks=[]
    for symbol,g in s.groupby("symbol",sort=False):
        mg=metrics[metrics["symbol"]==symbol].sort_values("effective_time")
        if mg.empty: continue
        sg=g.sort_values("signalEnd")
        j=pd.merge_asof(sg,mg,left_on="signalEnd",right_on="effective_time",direction="backward",tolerance=pd.Timedelta(minutes=10),suffixes=("","_metric"))
        chunks.append(j)
    if not chunks: return pd.DataFrame()
    return pd.concat(chunks,ignore_index=True).dropna(subset=["oi1h","oi4h"])

def simulate_short(features:pd.DataFrame,signals:pd.DataFrame)->pl.DataFrame:
    sig={(str(r.symbol),pd.Timestamp(r.timestamp)):True for r in signals[["symbol","timestamp"]].itertuples(index=False)}
    rows=[]
    for (symbol,seg),g in features.groupby(["symbol","segmentId"],sort=False):
        g=g.sort_values("timestamp").reset_index(drop=True)
        ts=list(g["timestamp"]); opens=g["open"].to_numpy(float); highs=g["high"].to_numpy(float); lows=g["low"].to_numpy(float); closes=g["close"].to_numpy(float)
        for i,t in enumerate(ts[:-1]):
            if (str(symbol),pd.Timestamp(t)) not in sig: continue
            ei=i+1
            if pd.Timestamp(ts[ei])-pd.Timestamp(t)>pd.Timedelta(minutes=30): continue
            entry=float(opens[ei]); end_i=min(len(g)-1,ei+31)
            tp=entry*(1-0.05); sl=entry*(1+0.015)
            exitp=float(closes[end_i]); reason="TIME"; xi=end_i
            for k in range(ei,end_i+1):
                if highs[k]>=sl: exitp=sl; reason="STOP"; xi=k; break
                if lows[k]<=tp: exitp=tp; reason="TARGET"; xi=k; break
            gross=1-exitp/entry
            rows.append({"timestamp":pd.Timestamp(t),"date":pd.Timestamp(t).date(),"symbol":str(symbol),"market":"CRYPTO_FUTURES","direction":"SHORT",
                         "entryPrice":entry,"exitPrice":exitp,"grossReturn":gross,"netReturn":gross-COST,
                         "MFE":1-float(np.min(lows[ei:end_i+1]))/entry,"MAE":float(np.max(highs[ei:end_i+1]))/entry-1,
                         "roundTripCost":COST,"exitReason":reason})
    return pl.from_pandas(pd.DataFrame(rows)) if rows else pl.DataFrame()

def gate(m,mintrades):
    checks={"positiveReturn":float(m.get("totalReturn") or 0)>0,"profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
            "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,"mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
            "minimumTrades":int(m.get("tradeCount") or 0)>=mintrades}
    return {"pass":all(checks.values()),"checks":checks}

def rank_key(m,name):
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 0),int(m.get("tradeCount") or 0),name)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--out-dir",required=True); args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    raw,source=flow.load_bars("CRYPTO_FUTURES")
    fp=flow.add_features(raw)
    features=pl.from_pandas(fp).with_columns([pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")),pl.col("date").cast(pl.Date)])
    base_signals={}
    union=[]
    for topn in BASES:
        s=flow.signal_frame(features,"CRYPTO_FUTURES","FLOW_RECLAIM","SHORT",0.4,2.5,None,topn)
        base_signals[topn]=s
        if not s.is_empty(): union.append(s.select(["timestamp","symbol"]))
    allsig=pl.concat(union,how="vertical").unique(subset=["timestamp","symbol"])
    spdf=allsig.to_pandas(); spdf["timestamp"]=pd.to_datetime(spdf["timestamp"],utc=True); spdf["signalEnd"]=spdf["timestamp"]+pd.Timedelta(minutes=15)
    metrics,metric_meta=load_metrics_for_signals(spdf)
    outcomes=simulate_short(fp,spdf)
    if outcomes.is_empty(): raise RuntimeError("NO_OI_V4_OUTCOMES")

    td=[d.date() for d in pd.date_range("2023-05-01","2025-03-31",freq="D")]
    vd=[d.date() for d in pd.date_range("2025-04-01","2026-03-31",freq="D")]
    od=[d.date() for d in pd.date_range("2026-04-01","2026-09-30",freq="D")]
    reports={}; grid=[]
    for topn,s in base_signals.items():
        attached=attach_metrics(s,metrics)
        if attached.empty: continue
        for rule,fn in OI_RULES.items():
            mask=fn(attached)
            filt=attached.loc[mask,["timestamp","symbol","oi1h","oi4h","count_long_short_ratio","sum_toptrader_long_short_ratio","sum_taker_long_short_vol_ratio","sum_open_interest","sum_open_interest_value"]]
            if filt.empty: continue
            fpl=pl.from_pandas(filt).with_columns(pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")))
            tr=outcomes.join(fpl,on=["timestamp","symbol"],how="inner").unique(subset=["timestamp","symbol"])
            name=f"OI_{rule}_TOP{topn}_TP5_SL1.5_H32"
            tr=tr.with_columns(pl.lit(name).alias("candidate"))
            train=tr.filter(pl.col("date")<pl.lit(TRAIN_END))
            valid=tr.filter((pl.col("date")>=pl.lit(TRAIN_END))&(pl.col("date")<pl.lit(VALID_END)))
            oos=tr.filter((pl.col("date")>=pl.lit(VALID_END))&(pl.col("date")<pl.lit(OOS_END)))
            mt=v1.metrics(train,"CRYPTO_FUTURES",td); mv=v1.metrics(valid,"CRYPTO_FUTURES",vd); mo=v1.metrics(oos,"CRYPTO_FUTURES",od)
            gt,gv,go=gate(mt,100),gate(mv,50),gate(mo,25)
            reports[name]={"trades":tr,"train":mt,"validation":mv,"oos":mo,"trainGate":gt,"validationGate":gv,"oosGate":go}
            grid.append({"candidate":name,"rule":rule,"topN":topn,"trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                         "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                         "oosReturn":mo.get("totalReturn"),"oosPF":mo.get("profitFactor"),"oosMDD":mo.get("mdd"),"oosPosMonthRate":mo.get("positiveMonthRate"),"oosTrades":mo.get("tradeCount")})
    trainpass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    validpass=[n for n in trainpass if reports[n]["validationGate"]["pass"]]
    winner=sorted(validpass,key=lambda n:rank_key(reports[n]["validation"],n),reverse=True)[0] if validpass else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    summary={"schemaVersion":1,"contract":"full-universe-3pct-hunter-futures-oi-v4","source":source,"metricsSource":metric_meta,
             "periods":{"train":["2023-05-01","2025-04-01"],"validation":["2025-04-01","2026-04-01"],"freshOos":["2026-04-01","2026-10-01"]},
             "candidateCount":len(grid),"trainPassCount":len(trainpass),"validationPassCount":len(validpass),"winner":winner,
             "truthBoundary":{"baseFlowFixedFromTrainOnly":True,"oiRulesPredefinedBeforeValidation":True,"metricsLabelShiftAfter2026_06_25Handled":True,
                              "freshOosUsedForSelection":False,"profitabilityProven":False,"executionAuthority":"NONE"}}
    if winner:
        d=reports[winner]; summary["winnerResults"]={"train":d["train"],"trainGate":d["trainGate"],"validation":d["validation"],"validationGate":d["validationGate"],"freshOos":d["oos"],"freshOosGate":d["oosGate"]}
        d["trades"].write_csv(out/"winner-ledger.csv")
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
