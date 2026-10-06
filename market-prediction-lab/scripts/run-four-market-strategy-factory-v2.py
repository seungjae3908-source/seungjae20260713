#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT=Path(__file__).resolve().parents[2]

def load_module(name, rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v1=load_module("hunter_v1","market-prediction-lab/scripts/run-full-universe-3pct-hunter-causal-backtest-v1.py")
factory1=load_module("factory_v1","market-prediction-lab/scripts/run-four-market-strategy-factory-v1.py")
census=v1.census

MARKETS=factory1.MARKETS
TRAIN_END=factory1.TRAIN_END
CAL_END=factory1.CAL_END
VAL_END=factory1.VAL_END
TOP_NS=(5,10,20,50)
EXIT_CONFIGS=factory1.EXIT_CONFIGS
AI_FEATURES=[
    "ret1_prev","ret3_prev","ret5_prev","ret10_prev","ret20_prev",
    "prior_rvol","prior_atr_pct","compression_ratio","prev_close_loc",
    "prev_body","wave_accel","distance_prior_high20","distance_prior_low20",
    "distance_prior_high60","distance_prior_low60","volume_accel1",
    "cs_ret3_rank","cs_rvol_rank","cs_ret3_low_rank",
]
AI_NEG_POS_RATIO=5
RANDOM_SEED=23


def market_frame(market):
    loaded,source=factory1.load_market(market)
    v1.assert_source_coverage(market,source)
    raw=factory1.add_features(loaded,market).filter(factory1.tradable_mask(market))
    return raw,source


def direction_defs(market):
    out=[("LONG",factory1.long_defs())]
    if market=="CRYPTO_FUTURES":
        out.append(("SHORT",factory1.short_defs()))
    return out


def family_score_expr(direction:str):
    if direction=="LONG":
        # Lower rank = stronger for cs ranks, so invert. All features are prior-only.
        return (
            (1.0-pl.col("cs_ret3_rank")).fill_null(0.0)*1.6
            +(1.0-pl.col("cs_rvol_rank")).fill_null(0.0)*1.2
            +pl.col("prev_close_loc").fill_null(0.5)*0.8
            +pl.col("ret3_prev").clip(-0.15,0.15)*3.0
            +pl.col("wave_accel").clip(-0.15,0.15)*2.0
            +(pl.col("distance_prior_high20").clip(-0.30,0.05)+0.30)*0.8
        )
    return (
        (1.0-pl.col("cs_ret3_low_rank")).fill_null(0.0)*1.6
        +(1.0-pl.col("cs_rvol_rank")).fill_null(0.0)*1.2
        +(1.0-pl.col("prev_close_loc").fill_null(0.5))*0.8
        +(-pl.col("ret3_prev")).clip(-0.15,0.15)*3.0
        +(-pl.col("wave_accel")).clip(-0.15,0.15)*2.0
        +(0.30-pl.col("distance_prior_low20").clip(-0.05,0.30))*0.8
    )


def topn_per_day(sig:pl.DataFrame,direction:str,top_n:int)->pl.DataFrame:
    if sig.is_empty():
        return sig
    return (
        sig.with_columns(family_score_expr(direction).alias("rankScore"))
        .sort(["date","rankScore","prior_dollar_volume20"],descending=[False,True,True])
        .group_by("date",maintain_order=True)
        .head(top_n)
    )


def label_expr(direction:str):
    if direction=="LONG":
        return (pl.col("high")/pl.col("open")-1.0)>=0.03
    return (1.0-pl.col("low")/pl.col("open"))>=0.03


def fit_ai_model(raw:pl.DataFrame,direction:str):
    train=raw.filter(pl.col("date")<pl.lit(TRAIN_END)).select(["date","symbol",*AI_FEATURES]).to_pandas()
    labels=raw.filter(pl.col("date")<pl.lit(TRAIN_END)).select(label_expr(direction).cast(pl.Int8).alias("y")).to_series().to_numpy()
    train["y"]=labels
    train=train.replace([np.inf,-np.inf],np.nan)
    pos=train[train["y"]==1]
    neg=train[train["y"]==0]
    if len(pos)<100:
        raise RuntimeError(f"AI_TOO_FEW_POSITIVES:{direction}:{len(pos)}")
    max_neg=min(len(neg),len(pos)*AI_NEG_POS_RATIO)
    neg=neg.sample(n=max_neg,random_state=RANDOM_SEED) if len(neg)>max_neg else neg
    sample=pd.concat([pos,neg],ignore_index=True).sample(frac=1.0,random_state=RANDOM_SEED)
    X=sample[AI_FEATURES].to_numpy(float)
    y=sample["y"].to_numpy(int)
    model=Pipeline([
        ("imputer",SimpleImputer(strategy="median")),
        ("scaler",StandardScaler()),
        ("model",LogisticRegression(
            C=0.7,class_weight="balanced",max_iter=1200,random_state=RANDOM_SEED
        )),
    ])
    model.fit(X,y)
    return model,{
        "trainRows":int(len(sample)),
        "positiveRows":int((y==1).sum()),
        "negativeRows":int((y==0).sum()),
        "positiveRate":float(np.mean(y)),
    }


def score_ai(raw:pl.DataFrame,model)->pl.DataFrame:
    pdf=raw.select(["date","symbol",*AI_FEATURES]).to_pandas()
    X=pdf[AI_FEATURES].replace([np.inf,-np.inf],np.nan).to_numpy(float)
    pdf["aiProb"]=model.predict_proba(X)[:,1]
    scored=pl.from_pandas(pdf[["date","symbol","aiProb"]])
    return raw.join(scored,on=["date","symbol"],how="inner")


def ai_topn(scored:pl.DataFrame,top_n:int)->pl.DataFrame:
    return (
        scored.sort(["date","aiProb","prior_dollar_volume20"],descending=[False,True,True])
        .group_by("date",maintain_order=True).head(top_n)
    )


def metrics_period(trades,market,dates,start,end):
    sub=trades.filter((pl.col("date")>=pl.lit(start))&(pl.col("date")<pl.lit(end)))
    ds=[d for d in dates if start<=d<end]
    return v1.metrics(sub,market,ds)


def gate(m,min_trades):
    return factory1.gate(m,min_trades)


def rank_key(m,name):
    return factory1.rank_key(m,name)


def eval_candidate(trades,market,dates):
    mt=metrics_period(trades,market,dates,dates[0],TRAIN_END)
    mc=metrics_period(trades,market,dates,TRAIN_END,CAL_END)
    mv=metrics_period(trades,market,dates,CAL_END,VAL_END)
    gt=gate(mt,60); gc=gate(mc,20); gv=gate(mv,30)
    return mt,mc,mv,gt,gc,gv


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=MARKETS)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    raw,source=market_frame(market)
    dates=raw.select("date").unique().sort("date").get_column("date").to_list()
    if not dates:
        raise RuntimeError(f"NO_FACTORY_V2_DATES:{market}")

    reports={}
    grid=[]
    ledgers={}
    ai_audit={}

    for direction,defs in direction_defs(market):
        # 1) Literature/rule-family ranking over the complete daily universe.
        for family,mask in defs:
            base_sig=raw.filter(mask)
            if base_sig.is_empty():
                continue
            for top_n in TOP_NS:
                sig=topn_per_day(base_sig,direction,top_n)
                for exit_name,target,stop in EXIT_CONFIGS:
                    name=f"RULE_{direction}_{family}_TOP{top_n}_{exit_name}"
                    trades=factory1.simulate(sig,market,direction,target,stop,name)
                    mt,mc,mv,gt,gc,gv=eval_candidate(trades,market,dates)
                    eligible=gt["pass"] and gc["pass"]
                    reports[name]={
                        "lane":"RULE","direction":direction,"family":family,"topN":top_n,"exit":exit_name,
                        "train":mt,"calibration":mc,"validation":mv,
                        "trainGate":gt,"calibrationGate":gc,"validationGate":gv,
                        "eligibleAfterCalibration":eligible,
                    }
                    if eligible: ledgers[name]=trades
                    grid.append({
                        "candidate":name,"lane":"RULE","direction":direction,"family":family,"topN":top_n,"exit":exit_name,
                        "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                        "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                        "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                        "distinctSymbols":trades.select("symbol").unique().height,
                        "activeDates":trades.select("date").unique().height,
                    })

        # 2) Global AI meta-ranker; all tradable symbols are scored every day.
        model,audit=fit_ai_model(raw,direction)
        ai_audit[direction]=audit
        scored=score_ai(raw,model)
        for top_n in TOP_NS:
            sig=ai_topn(scored,top_n)
            for exit_name,target,stop in EXIT_CONFIGS:
                name=f"AI_{direction}_TOP{top_n}_{exit_name}"
                trades=factory1.simulate(sig,market,direction,target,stop,name)
                mt,mc,mv,gt,gc,gv=eval_candidate(trades,market,dates)
                eligible=gt["pass"] and gc["pass"]
                reports[name]={
                    "lane":"AI","direction":direction,"family":"GLOBAL_AI","topN":top_n,"exit":exit_name,
                    "train":mt,"calibration":mc,"validation":mv,
                    "trainGate":gt,"calibrationGate":gc,"validationGate":gv,
                    "eligibleAfterCalibration":eligible,
                }
                if eligible: ledgers[name]=trades
                grid.append({
                    "candidate":name,"lane":"AI","direction":direction,"family":"GLOBAL_AI","topN":top_n,"exit":exit_name,
                    "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                    "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                    "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                    "distinctSymbols":trades.select("symbol").unique().height,
                    "activeDates":trades.select("date").unique().height,
                })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    passes=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None

    pdf=pd.DataFrame(grid)
    pdf.to_csv(out/"candidate-grid.csv",index=False)
    if len(pdf):
        pdf.sort_values(["calibrationPass","calibrationReturn","calibrationPF"],ascending=[False,False,False]).head(50).to_csv(out/"top50-calibration.csv",index=False)
        pdf.sort_values(["validationReturn","validationPF"],ascending=[False,False]).head(50).to_csv(out/"top50-validation-diagnostic.csv",index=False)

    if selected and selected in ledgers:
        ledgers[selected].select([
            "market","date","symbol","direction","candidate","entryPrice","exitPrice",
            "grossReturn","roundTripCost","netReturn","MFE","MAE","exitReason",
            "ret1_prev","ret3_prev","ret5_prev","ret10_prev","ret20_prev","prior_rvol",
            "prior_dollar_volume20","prior_atr_pct","compression_ratio","prev_close_loc",
            "prev_body","wave_accel","distance_prior_high20","distance_prior_low20",
        ]).write_csv(out/"selected-ledger.csv")

    summary={
        "schemaVersion":1,
        "contract":"four-market-strategy-factory-v2",
        "market":market,
        "source":source,
        "fullUniverseSymbolsWithTradableRows":raw.select("symbol").unique().height,
        "tradableRows":raw.height,
        "candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(passes),
        "validationPassCandidates":passes,
        "selectedByCalibration":selected,
        "selectedResults":reports.get(selected) if selected else None,
        "aiTrainingAudit":ai_audit,
        "truthBoundary":{
            "allTradableSymbolsScoredEveryDay":True,
            "topNMeansBestSignalsAfterFullUniverseScanNotUniverseRestriction":True,
            "aiFeaturesPriorSessionOnly":True,
            "aiModelFitOnlyBefore2024_10_01":True,
            "sameDayOpenUsedOnlyAsFillProxy":True,
            "sameDayGapExcludedFromSignal":True,
            "dailyOhlcOrderUnknown":True,
            "stopFirstConservative":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "intradayPrecisionNotYetProven":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
