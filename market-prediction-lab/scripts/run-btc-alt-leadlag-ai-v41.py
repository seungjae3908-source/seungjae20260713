#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from lightgbm import LGBMClassifier

ROOT=Path(__file__).resolve().parents[2]
V4_SCRIPT=ROOT/"market-prediction-lab"/"scripts"/"run-btc-alt-leadlag-extreme-v4.py"
SPEC=importlib.util.spec_from_file_location("leadlag_v4",V4_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V4_IMPORT_FAILED")
v4=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v4)
v1=v4.v1

TRAIN_END=v4.TRAIN_END
CAL_END=v4.CAL_END
VAL_END=v4.VAL_END
POST_END=v4.POST_END
TOP_NS=(1,3,5,10)
LIQ_BANDS=(0.25,0.50,1.00)
FEATURES=("btcAbs","btcSigned","signedAltRet1","responseRatio","lagGap","logPriorDollar","liquidityPct")
RANDOM_SEED=41


def add_features(df:pd.DataFrame)->pd.DataFrame:
    x=df.copy()
    btc=pd.to_numeric(x["btcRet1"],errors="coerce")
    signed_alt=pd.to_numeric(x["signedAltRet1"],errors="coerce")
    x["btcAbs"]=btc.abs()
    x["btcSigned"]=np.where(x["direction"].eq("LONG"),btc,-btc)
    x["signedAltRet1"]=signed_alt
    x["responseRatio"]=pd.to_numeric(x["responseRatio"],errors="coerce")
    x["lagGap"]=pd.to_numeric(x["lagGap"],errors="coerce")
    prior=pd.to_numeric(x["avgDollarPriorMonth"],errors="coerce").clip(lower=1.0)
    x["logPriorDollar"]=np.log1p(prior)
    x["liquidityPct"]=pd.to_numeric(x["liquidityPct"],errors="coerce")
    return x.replace([np.inf,-np.inf],np.nan)


def training_base(outcomes:pd.DataFrame,direction:str):
    # One row per event-symbol, label from a fixed 30m TP3/SL1.5 path.
    x=outcomes[
        (outcomes["direction"]==direction)
        &(outcomes["holdMinutes"]==30)
        &(outcomes["targetPct"]==0.03)
    ].copy()
    x=x.sort_values(["timestamp","symbol"]).drop_duplicates(["timestamp","symbol"],keep="first")
    x=add_features(x)
    x["label"]=(pd.to_numeric(x["netReturn"],errors="coerce")>0).astype(int)
    return x


def fit_model(train:pd.DataFrame):
    z=train.dropna(subset=list(FEATURES)+["label"]).copy()
    if len(z)<200 or z["label"].nunique()<2:
        raise RuntimeError(f"AI_TRAIN_INSUFFICIENT:{len(z)}:{z['label'].nunique()}")
    model=LGBMClassifier(
        n_estimators=250,
        learning_rate=0.035,
        num_leaves=15,
        max_depth=5,
        min_child_samples=60,
        subsample=0.85,
        colsample_bytree=0.9,
        reg_lambda=1.0,
        random_state=RANDOM_SEED,
        n_jobs=2,
        verbosity=-1,
    )
    model.fit(z[list(FEATURES)],z["label"])
    return model,{
        "rows":int(len(z)),
        "positiveRate":float(z["label"].mean()),
        "positives":int(z["label"].sum()),
        "negatives":int((1-z["label"]).sum()),
    }


def score_pairs(outcomes:pd.DataFrame,direction:str,model):
    base=outcomes[outcomes["direction"]==direction].sort_values(["timestamp","symbol"]).drop_duplicates(["timestamp","symbol"]).copy()
    base=add_features(base)
    ok=base[list(FEATURES)].notna().all(axis=1)
    base=base[ok].copy()
    base["aiProb"]=model.predict_proba(base[list(FEATURES)])[:,1]
    return base[["timestamp","symbol","direction","aiProb","liquidityPct"]]


def select_pairs(scored,liq_max,top_n):
    x=scored[pd.to_numeric(scored["liquidityPct"],errors="coerce")<=liq_max].copy()
    if x.empty:return x
    return (
        x.sort_values(["timestamp","aiProb"],ascending=[True,False])
        .groupby("timestamp",group_keys=False).head(top_n)
    )


def join_exit(outcomes,selected,hold,target,direction):
    x=outcomes[
        (outcomes["direction"]==direction)
        &(outcomes["holdMinutes"]==hold)
        &(outcomes["targetPct"]==target)
    ].copy()
    y=selected[["timestamp","symbol","aiProb"]].copy()
    z=x.merge(y,on=["timestamp","symbol"],how="inner",validate="many_to_one")
    return v4.deoverlap(z,hold)


def metrics_pdf(pdf,market,start,end):
    return v4.metrics_pdf(pdf,market,start,end)


def gate(m,n): return v4.gate(m,n)


def rank_key(m,name): return v4.rank_key(m,name)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=v4.MARKETS)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    events,event_audit=v4.load_btc_events(market)
    symbols,life_map,liq,march,source_meta=v4.universe_and_liquidity(market)
    outcomes,download_audit=v4.download_and_build_outcomes(market,events,symbols,life_map,liq,march)
    outcomes["date"]=pd.to_datetime(outcomes["date"]).dt.date

    directions=["LONG"] if market=="CRYPTO_SPOT" else ["LONG","SHORT"]
    reports={}; grid=[]; ledgers={}; model_audit={}
    for direction in directions:
        base=training_base(outcomes,direction)
        train=base[base["date"]<TRAIN_END].copy()
        model,audit=fit_model(train)
        model_audit[direction]=audit
        scored=score_pairs(outcomes,direction,model)
        for liq_max in LIQ_BANDS:
            for top_n in TOP_NS:
                selected=select_pairs(scored,liq_max,top_n)
                for hold in v4.HOLDS:
                    for target in v4.TARGETS:
                        name=f"AI_{direction}_LIQ{liq_max:.2f}_TOP{top_n}_H{hold}_TP{int(target*100)}"
                        trades=join_exit(outcomes,selected,hold,target,direction)
                        mt=metrics_pdf(trades[trades["date"]<TRAIN_END],market,"2023-04-01",str(TRAIN_END))
                        mc=metrics_pdf(trades[(trades["date"]>=TRAIN_END)&(trades["date"]<CAL_END)],market,str(TRAIN_END),str(CAL_END))
                        mv=metrics_pdf(trades[(trades["date"]>=CAL_END)&(trades["date"]<VAL_END)],market,str(CAL_END),str(VAL_END))
                        mp=metrics_pdf(trades[(trades["date"]>=VAL_END)&(trades["date"]<POST_END)],market,str(VAL_END),str(POST_END))
                        gt=gate(mt,30); gc=gate(mc,10); gv=gate(mv,10); gp=gate(mp,8)
                        eligible=gt["pass"] and gc["pass"]
                        reports[name]={
                            "direction":direction,"liquidityMax":liq_max,"topN":top_n,"holdMinutes":hold,"targetPct":target,
                            "train":mt,"calibration":mc,"validation":mv,"postHocBenchmark":mp,
                            "trainGate":gt,"calibrationGate":gc,"validationGate":gv,"postHocGate":gp,
                            "eligibleAfterCalibration":eligible,
                        }
                        if eligible:ledgers[name]=trades
                        grid.append({
                            "candidate":name,"direction":direction,"liquidityMax":liq_max,"topN":top_n,"holdMinutes":hold,"targetPct":target,
                            "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                            "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                            "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                            "postHocReturn":mp.get("totalReturn"),"postHocPF":mp.get("profitFactor"),"postHocMDD":mp.get("mdd"),"postHocPosMonthRate":mp.get("positiveMonthRate"),"postHocTrades":mp.get("tradeCount"),
                            "distinctSymbols":int(trades["symbol"].nunique()) if len(trades) else 0,
                            "activeEventTimes":int(trades["timestamp"].nunique()) if len(trades) else 0,
                        })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    passes=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None

    pdf=pd.DataFrame(grid); pdf.to_csv(out/"candidate-grid.csv",index=False)
    if len(pdf):
        pdf.sort_values(["calibrationPass","calibrationReturn","calibrationPF"],ascending=[False,False,False]).head(40).to_csv(out/"top40-calibration.csv",index=False)
        pdf.sort_values(["validationReturn","validationPF"],ascending=[False,False]).head(40).to_csv(out/"top40-validation-diagnostic.csv",index=False)
    if selected and selected in ledgers:ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)

    summary={
        "schemaVersion":1,
        "contract":"btc-alt-leadlag-ai-v41",
        "market":market,
        "source":source_meta,
        "btcEventAudit":event_audit,
        "fullUSDTAltUniverse":len(symbols),
        "downloadAudit":download_audit,
        "modelAudit":model_audit,
        "features":list(FEATURES),
        "candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(passes),
        "validationPassCandidates":passes,
        "selectedByCalibration":selected,
        "selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "fullEligibleUSDTAltUniverseUsedForTrainingAndRanking":True,
            "featuresUseOnlyCompletedBTCAndAltEventMinutePlusPriorMonthLiquidity":True,
            "modelFitOnlyBefore2024_10_01":True,
            "entryNextMinuteOpenInheritedFromV4":True,
            "validationExcludedFromModelAndCandidateSelection":True,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
