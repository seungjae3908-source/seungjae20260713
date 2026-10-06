#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

ROOT=Path(__file__).resolve().parents[2]
V1_PATH=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-causal-backtest-v1.py"
KR3_PATH=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-kr-event-v3.py"

def loadmod(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    if spec is None or spec.loader is None: raise RuntimeError(f"IMPORT_FAILED:{name}")
    mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

v1=loadmod(V1_PATH,"hunter_v1")
kr3=loadmod(KR3_PATH,"kr_event_v3")

FIT_END=pd.Timestamp("2024-10-01").date()
TUNE_END=pd.Timestamp("2025-04-01").date()
VALID_END=pd.Timestamp("2026-04-01").date()
OOS_END=pd.Timestamp("2026-10-01").date()
TOP_NS=(1,3,5,10)
TARGETS=(0.03,0.05)
STOPS=(0.015,0.025)
COST=0.003
FEATURES=[
    "ret1","ret5","ret20","rvol","dollarAccel3","nearHigh20","nearLow20",
    "compression","closePosition","prevDollarLog","prevRangePct","prevBodyReturn",
    "rankRvol","rankAccel","rankNearHigh","rankRet5","rankCompression","rankLiquidity","marketCode",
]

def add_features(df:pl.DataFrame,market_map:dict[str,str])->pl.DataFrame:
    x=df.sort(["symbol","date"]).with_columns([
        (pl.col("close")*pl.col("volume")).alias("dollar"),
        ((pl.col("high")-pl.col("low"))/pl.col("close")).alias("rangePct"),
    ])
    x=x.with_columns([
        pl.col("open").shift(1).over("symbol").alias("prevOpen"),
        pl.col("high").shift(1).over("symbol").alias("prevHigh"),
        pl.col("low").shift(1).over("symbol").alias("prevLow"),
        pl.col("close").shift(1).over("symbol").alias("prevClose"),
        pl.col("close").shift(2).over("symbol").alias("close2"),
        pl.col("close").shift(6).over("symbol").alias("close6"),
        pl.col("close").shift(21).over("symbol").alias("close21"),
        pl.col("volume").shift(1).over("symbol").alias("prevVolume"),
        pl.col("volume").shift(2).rolling_mean(20,min_samples=10).over("symbol").alias("preVolume20"),
        pl.col("dollar").shift(1).over("symbol").alias("dv1"),
        pl.col("dollar").shift(2).over("symbol").alias("dv2"),
        pl.col("dollar").shift(3).over("symbol").alias("dv3"),
        pl.col("dollar").shift(4).over("symbol").alias("dv4"),
        pl.col("dollar").shift(2).rolling_mean(20,min_samples=10).over("symbol").alias("preDollar20"),
        pl.col("rangePct").shift(2).rolling_mean(20,min_samples=10).over("symbol").alias("preRange20"),
        pl.col("high").shift(1).rolling_max(20,min_samples=10).over("symbol").alias("priorHigh20"),
        pl.col("low").shift(1).rolling_min(20,min_samples=10).over("symbol").alias("priorLow20"),
    ])
    x=x.with_columns([
        (pl.col("prevClose")/pl.col("close2")-1).alias("ret1"),
        (pl.col("prevClose")/pl.col("close6")-1).alias("ret5"),
        (pl.col("prevClose")/pl.col("close21")-1).alias("ret20"),
        (pl.col("prevVolume")/pl.col("preVolume20")).alias("rvol"),
        (pl.col("dv1")/((pl.col("dv2")+pl.col("dv3")+pl.col("dv4"))/3)).alias("dollarAccel3"),
        (pl.col("prevClose")/pl.col("priorHigh20")-1).alias("nearHigh20"),
        (pl.col("prevClose")/pl.col("priorLow20")-1).alias("nearLow20"),
        ((((pl.col("prevHigh")-pl.col("prevLow"))/pl.col("prevClose"))/pl.col("preRange20"))).alias("compression"),
        ((pl.col("prevClose")-pl.col("prevLow"))/(pl.col("prevHigh")-pl.col("prevLow")).clip(1e-9,None)).alias("closePosition"),
        pl.col("preDollar20").log1p().alias("prevDollarLog"),
        ((pl.col("prevHigh")-pl.col("prevLow"))/pl.col("prevClose")).alias("prevRangePct"),
        (pl.col("prevClose")/pl.col("prevOpen")-1).alias("prevBodyReturn"),
        (pl.col("high")/pl.col("open")-1>=0.03).cast(pl.Int8).alias("label3"),
    ])
    mapping={"KOSPI":0.0,"KOSDAQ":1.0,"KONEX":2.0}
    map_df=pl.DataFrame({"symbol":list(market_map.keys()),"marketCode":[mapping.get(market_map[s],3.0) for s in market_map]})
    x=x.join(map_df,on="symbol",how="left").with_columns(pl.col("marketCode").fill_null(3.0))
    x=x.filter(
        pl.col("ret20").is_not_null() & pl.col("rvol").is_not_null() & pl.col("preDollar20").is_not_null()
        & (pl.col("prevClose")>=1000) & (pl.col("preDollar20")>=1_000_000_000)
    )
    x=x.with_columns([
        (1.0-(pl.col("rvol").rank("average",descending=True).over("date")-1)/(pl.len().over("date")-1).clip(1,None)).alias("rankRvol"),
        (1.0-(pl.col("dollarAccel3").rank("average",descending=True).over("date")-1)/(pl.len().over("date")-1).clip(1,None)).alias("rankAccel"),
        (1.0-(pl.col("nearHigh20").rank("average",descending=True).over("date")-1)/(pl.len().over("date")-1).clip(1,None)).alias("rankNearHigh"),
        (1.0-(pl.col("ret5").rank("average",descending=True).over("date")-1)/(pl.len().over("date")-1).clip(1,None)).alias("rankRet5"),
        (1.0-((-pl.col("compression")).rank("average",descending=True).over("date")-1)/(pl.len().over("date")-1).clip(1,None)).alias("rankCompression"),
        (1.0-(pl.col("preDollar20").rank("average",descending=True).over("date")-1)/(pl.len().over("date")-1).clip(1,None)).alias("rankLiquidity"),
    ])
    return x.filter(pl.all_horizontal([pl.col(c).is_finite() for c in FEATURES]))

def sampled_training(pdf:pd.DataFrame,cutoff)->pd.DataFrame:
    t=pdf[pdf["date"]<cutoff].copy()
    pos=t[t["label3"]==1]
    neg=t[t["label3"]==0]
    max_neg=min(len(neg),max(500_000,len(pos)*2))
    if len(neg)>max_neg: neg=neg.sample(max_neg,random_state=20261006)
    return pd.concat([pos,neg],ignore_index=True).sample(frac=1,random_state=20261006)

def fit_model(pdf:pd.DataFrame,cutoff):
    t=sampled_training(pdf,cutoff)
    model=HistGradientBoostingClassifier(
        learning_rate=0.05,max_iter=120,max_leaf_nodes=31,min_samples_leaf=100,
        l2_regularization=2.0,class_weight="balanced",random_state=20261006
    )
    model.fit(t[FEATURES].to_numpy(float),t["label3"].to_numpy(int))
    return model,{"rows":len(t),"positives":int(t["label3"].sum()),"negative":int((t["label3"]==0).sum())}

def score_period(model,pdf,start,end):
    x=pdf[(pdf["date"]>=start)&(pdf["date"]<end)].copy()
    x["prob3"]=model.predict_proba(x[FEATURES].to_numpy(float))[:,1]
    auc=float(roc_auc_score(x["label3"],x["prob3"])) if x["label3"].nunique()>1 else None
    return x,auc

def select_top(scored:pd.DataFrame,topn:int):
    return scored.sort_values(["date","prob3"],ascending=[True,False]).groupby("date",sort=False).head(topn).copy()

def simulate(sel:pd.DataFrame,target:float,stop:float,name:str)->pl.DataFrame:
    rows=[]
    for r in sel.itertuples(index=False):
        entry=float(r.open); sl=entry*(1-stop); tp=entry*(1+target)
        if float(r.low)<=sl: exitp=sl; reason="STOP"
        elif float(r.high)>=tp: exitp=tp; reason="TARGET"
        else: exitp=float(r.close); reason="EOD"
        gross=exitp/entry-1
        rows.append({"market":"KR_STOCK","date":r.date,"symbol":r.symbol,"direction":"LONG","candidate":name,
                     "entryPrice":entry,"exitPrice":exitp,"grossReturn":gross,"roundTripCost":COST,"netReturn":gross-COST,
                     "MFE":float(r.high)/entry-1,"MAE":1-float(r.low)/entry,"exitReason":reason,"prob3":float(r.prob3)})
    return pl.DataFrame(rows) if rows else pl.DataFrame()

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
    raw,source=kr3.load_kr_extended()
    _,_,market_map,_=v1.census._build_kr_frozen_universe()
    feat=add_features(raw,market_map)
    pdf=feat.select(["date","symbol","open","high","low","close","label3",*FEATURES]).to_pandas()
    pdf["date"]=pd.to_datetime(pdf["date"]).dt.date
    td=[d.date() for d in pd.date_range("2023-05-01","2024-09-30",freq="D")]
    tuned=[d.date() for d in pd.date_range("2024-10-01","2025-03-31",freq="D")]
    vd=[d.date() for d in pd.date_range("2025-04-01","2026-03-31",freq="D")]
    od=[d.date() for d in pd.date_range("2026-04-01","2026-09-30",freq="D")]

    model1,fit_meta=fit_model(pdf,FIT_END)
    tune,auc_tune=score_period(model1,pdf,FIT_END,TUNE_END)
    grid=[]; tune_reports={}
    for topn in TOP_NS:
        sel=select_top(tune,topn)
        for target in TARGETS:
            for stop in STOPS:
                name=f"KR_AI_TOP{topn}_TP{int(target*100)}_SL{stop:g}"
                tr=simulate(sel,target,stop,name)
                m=v1.metrics(tr,"KR_STOCK",tuned); g=gate(m,30)
                tune_reports[name]={"metrics":m,"gate":g,"topN":topn,"target":target,"stop":stop}
                grid.append({"candidate":name,"tunePass":g["pass"],"tuneReturn":m.get("totalReturn"),"tunePF":m.get("profitFactor"),"tuneMDD":m.get("mdd"),"tunePosMonthRate":m.get("positiveMonthRate"),"tuneTrades":m.get("tradeCount")})
    pass_names=[n for n,d in tune_reports.items() if d["gate"]["pass"]]
    winner=sorted(pass_names,key=lambda n:rank_key(tune_reports[n]["metrics"],n),reverse=True)[0] if pass_names else None
    pd.DataFrame(grid).to_csv(out/"tune-grid.csv",index=False)

    summary={"schemaVersion":1,"contract":"full-universe-3pct-hunter-kr-ai-v5","source":source,
             "periods":{"fit":["2023-05-01",str(FIT_END)],"internalTune":[str(FIT_END),str(TUNE_END)],"validation":[str(TUNE_END),str(VALID_END)],"freshOos":[str(VALID_END),str(OOS_END)]},
             "features":FEATURES,"fitMeta":fit_meta,"internalTuneAuc":auc_tune,"tunePassCount":len(pass_names),"winner":winner,
             "truthBoundary":{"modelFitUsesOnlyPreTuneData":True,"strategyChoiceUsesOnlyInternalTune":True,"validationUsedForSelection":False,"freshOosUsedForSelection":False,"sameDayOpenExcludedFromFeatures":True,"profitabilityProven":False,"executionAuthority":"NONE"}}
    if winner:
        cfg=tune_reports[winner]
        model2,final_fit_meta=fit_model(pdf,TUNE_END)
        valid,auc_valid=score_period(model2,pdf,TUNE_END,VALID_END)
        oos,auc_oos=score_period(model2,pdf,VALID_END,OOS_END)
        sv=select_top(valid,cfg["topN"]); so=select_top(oos,cfg["topN"])
        tv=simulate(sv,cfg["target"],cfg["stop"],winner); to=simulate(so,cfg["target"],cfg["stop"],winner)
        mv=v1.metrics(tv,"KR_STOCK",vd); mo=v1.metrics(to,"KR_STOCK",od)
        gv,go=gate(mv,50),gate(mo,25)
        summary["finalFitMeta"]=final_fit_meta
        summary["validationAuc"]=auc_valid; summary["freshOosAuc"]=auc_oos
        summary["winnerResults"]={"internalTune":cfg["metrics"],"internalTuneGate":cfg["gate"],"validation":mv,"validationGate":gv,"freshOos":mo,"freshOosGate":go}
        pl.concat([tv,to],how="vertical").write_csv(out/"winner-ledger-validation-oos.csv")
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
