#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl

ROOT=Path(__file__).resolve().parents[2]
V1_SCRIPT=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC=importlib.util.spec_from_file_location("hunter_v1",V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v1)
census=v1.census

MARKETS=("KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES")
TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()
EXIT_CONFIGS=(
    ("TP3_SL1p5",0.03,0.015),
    ("TP4_SL1p5",0.04,0.015),
    ("TP5_SL1p5",0.05,0.015),
)

COSTS=v1.COSTS


def load_market(market:str):
    if market=="US_STOCK":
        return census.load_us()
    if market=="KR_STOCK":
        return v1.load_kr_fast()
    if market=="CRYPTO_SPOT":
        return census.load_crypto("CRYPTO_SPOT")
    return census.load_crypto("CRYPTO_FUTURES")


def add_features(df:pl.DataFrame,market:str)->pl.DataFrame:
    x=census.add_features(df,market).sort(["symbol","date"])
    x=x.with_columns([
        pl.col("open").shift(1).over("symbol").alias("prev_open"),
        pl.col("high").shift(1).over("symbol").alias("prev_high"),
        pl.col("low").shift(1).over("symbol").alias("prev_low"),
        pl.col("close").shift(2).over("symbol").alias("close_2ago"),
        pl.col("close").shift(4).over("symbol").alias("close_4ago"),
        pl.col("close").shift(11).over("symbol").alias("close_11ago"),
        pl.col("volume").shift(2).over("symbol").alias("volume_2ago"),
        pl.col("low").shift(1).rolling_min(20,min_samples=5).over("symbol").alias("prior_low20"),
        pl.col("high").shift(1).rolling_max(60,min_samples=20).over("symbol").alias("prior_high60"),
        pl.col("low").shift(1).rolling_min(60,min_samples=20).over("symbol").alias("prior_low60"),
    ])
    x=x.with_columns([
        (pl.col("prev_close")/pl.col("close_2ago")-1.0).alias("ret1_prev"),
        (pl.col("prev_close")/pl.col("close_4ago")-1.0).alias("ret3_prev"),
        (pl.col("prev_close")/pl.col("close_11ago")-1.0).alias("ret10_prev"),
        ((pl.col("prev_high")-pl.col("prev_low"))/pl.col("prev_close")).alias("prev_range_pct"),
        ((pl.col("prev_close")-pl.col("prev_low"))/(pl.col("prev_high")-pl.col("prev_low")).replace(0,None)).alias("prev_close_loc"),
        (pl.col("prev_close")/pl.col("prev_open")-1.0).alias("prev_body"),
        (pl.col("prev_volume")/pl.col("volume_2ago").replace(0,None)).alias("volume_accel1"),
        (pl.col("prev_close")/pl.col("prior_low20")-1.0).alias("distance_prior_low20"),
        (pl.col("prev_close")/pl.col("prior_high60")-1.0).alias("distance_prior_high60"),
        (pl.col("prev_close")/pl.col("prior_low60")-1.0).alias("distance_prior_low60"),
    ])
    x=x.with_columns([
        pl.max_horizontal(
            (pl.col("prev_high")-pl.col("prev_low")).abs(),
            (pl.col("prev_high")-pl.col("close_2ago")).abs(),
            (pl.col("prev_low")-pl.col("close_2ago")).abs(),
        ).alias("prev_true_range"),
        (pl.col("ret3_prev")-pl.col("ret10_prev")*0.30).alias("wave_accel"),
    ])
    x=x.with_columns(
        pl.col("prev_true_range").rolling_mean(14,min_samples=10).over("symbol")
        .truediv(pl.col("prev_close")).alias("prior_atr_pct")
    )
    x=x.with_columns(
        (pl.col("prev_range_pct")/pl.col("prior_atr_pct").replace(0,None)).alias("compression_ratio")
    )

    # Cross-sectional ranks still consider the entire tradable universe each day.
    x=x.with_columns([
        (pl.col("ret3_prev").rank("average",descending=True).over("date")/pl.len().over("date")).alias("cs_ret3_rank"),
        (pl.col("prior_rvol").rank("average",descending=True).over("date")/pl.len().over("date")).alias("cs_rvol_rank"),
        (pl.col("ret3_prev").rank("average",descending=False).over("date")/pl.len().over("date")).alias("cs_ret3_low_rank"),
    ])
    return x


def tradable_mask(market:str)->pl.Expr:
    common=(
        pl.col("prev_close").is_not_null()
        & pl.col("ret1_prev").is_not_null()
        & pl.col("ret3_prev").is_not_null()
        & pl.col("ret5_prev").is_not_null()
        & pl.col("ret10_prev").is_not_null()
        & pl.col("ret20_prev").is_not_null()
        & pl.col("prior_rvol").is_not_null()
        & pl.col("prior_atr_pct").is_not_null()
        & pl.col("prior_dollar_volume20").is_not_null()
        & pl.col("prev_close_loc").is_not_null()
        & pl.col("compression_ratio").is_not_null()
    )
    if market=="US_STOCK":
        return common & (pl.col("prev_close")>=2.0) & (pl.col("prior_dollar_volume20")>=2_000_000)
    if market=="KR_STOCK":
        return common & (pl.col("prev_close")>=1000.0) & (pl.col("prior_dollar_volume20")>=200_000_000)
    return common & (pl.col("prior_dollar_volume20")>=500_000)


def long_defs():
    return [
        ("BREAKOUT_A", (pl.col("distance_prior_high20")>=-0.02)&(pl.col("ret5_prev")>=0.01)&(pl.col("prior_rvol")>=1.2)),
        ("BREAKOUT_B", (pl.col("distance_prior_high20")>=-0.05)&(pl.col("ret5_prev")>=0.03)&(pl.col("prior_rvol")>=1.8)),
        ("MOM_ACCEL_A", (pl.col("ret3_prev")>=0.02)&(pl.col("wave_accel")>=0.01)&(pl.col("prev_close_loc")>=0.70)),
        ("MOM_ACCEL_B", (pl.col("ret3_prev")>=0.04)&(pl.col("ret20_prev")>=0.05)&(pl.col("prev_close_loc")>=0.75)),
        ("VOLUME_BURST_A", (pl.col("prior_rvol")>=2.0)&(pl.col("prev_body")>=0.01)&(pl.col("prev_close_loc")>=0.75)),
        ("VOLUME_BURST_B", (pl.col("prior_rvol")>=3.0)&(pl.col("volume_accel1")>=1.4)&(pl.col("prev_close_loc")>=0.80)),
        ("COMPRESSION_A", (pl.col("compression_ratio")<=0.75)&(pl.col("distance_prior_high20")>=-0.05)&(pl.col("ret5_prev")>=0)),
        ("COMPRESSION_B", (pl.col("compression_ratio")<=0.55)&(pl.col("distance_prior_high20")>=-0.08)&(pl.col("ret20_prev")>=0.03)),
        ("PULLBACK_TREND_A", (pl.col("ret20_prev")>=0.08)&(pl.col("ret3_prev")<=-0.01)&(pl.col("ret3_prev")>=-0.06)&(pl.col("prev_close_loc")>=0.55)),
        ("PULLBACK_TREND_B", (pl.col("ret20_prev")>=0.12)&(pl.col("ret3_prev")<=-0.02)&(pl.col("distance_prior_high20")>=-0.15)),
        ("OVERSOLD_REBOUND_A", (pl.col("ret5_prev")<=-0.05)&(pl.col("prev_body")>0)&(pl.col("prev_close_loc")>=0.65)&(pl.col("prior_rvol")>=1.2)),
        ("OVERSOLD_REBOUND_B", (pl.col("ret5_prev")<=-0.08)&(pl.col("prev_close_loc")>=0.75)&(pl.col("prior_atr_pct")>=0.02)),
        ("VOL_EXP_CONT_A", (pl.col("prev_range_pct")>=pl.col("prior_atr_pct")*1.5)&(pl.col("prev_body")>0)&(pl.col("prev_close_loc")>=0.80)),
        ("WAVE_ACCEL_A", (pl.col("wave_accel")>=0.025)&(pl.col("ret10_prev")>=0.02)&(pl.col("prior_rvol")>=1.1)),
        ("WAVE_ACCEL_B", (pl.col("wave_accel")>=0.04)&(pl.col("ret20_prev")>=0.04)&(pl.col("prev_close_loc")>=0.70)),
        ("EVENT_CONT_A", (pl.col("ret1_prev")>=0.04)&(pl.col("prior_rvol")>=2.0)&(pl.col("prev_close_loc")>=0.75)),
        ("EVENT_CONT_B", (pl.col("ret1_prev")>=0.07)&(pl.col("prior_rvol")>=3.0)&(pl.col("prev_close_loc")>=0.80)),
        ("EVENT_REVERSAL_A", (pl.col("ret1_prev")<=-0.06)&(pl.col("prior_rvol")>=2.0)&(pl.col("prev_close_loc")>=0.60)),
        ("CS_LEADER_A", (pl.col("cs_ret3_rank")<=0.10)&(pl.col("cs_rvol_rank")<=0.20)&(pl.col("ret3_prev")>0)),
        ("CS_LEADER_B", (pl.col("cs_ret3_rank")<=0.05)&(pl.col("cs_rvol_rank")<=0.10)&(pl.col("prev_close_loc")>=0.65)),
    ]


def short_defs():
    return [
        ("BREAKDOWN_A", (pl.col("distance_prior_low20")<=0.02)&(pl.col("ret5_prev")<=-0.01)&(pl.col("prior_rvol")>=1.2)),
        ("BREAKDOWN_B", (pl.col("distance_prior_low20")<=0.05)&(pl.col("ret5_prev")<=-0.03)&(pl.col("prior_rvol")>=1.8)),
        ("MOM_ACCEL_A", (pl.col("ret3_prev")<=-0.02)&(pl.col("wave_accel")<=-0.01)&(pl.col("prev_close_loc")<=0.30)),
        ("MOM_ACCEL_B", (pl.col("ret3_prev")<=-0.04)&(pl.col("ret20_prev")<=-0.05)&(pl.col("prev_close_loc")<=0.25)),
        ("VOLUME_BURST_A", (pl.col("prior_rvol")>=2.0)&(pl.col("prev_body")<=-0.01)&(pl.col("prev_close_loc")<=0.25)),
        ("VOLUME_BURST_B", (pl.col("prior_rvol")>=3.0)&(pl.col("volume_accel1")>=1.4)&(pl.col("prev_close_loc")<=0.20)),
        ("COMPRESSION_A", (pl.col("compression_ratio")<=0.75)&(pl.col("distance_prior_low20")<=0.05)&(pl.col("ret5_prev")<=0)),
        ("COMPRESSION_B", (pl.col("compression_ratio")<=0.55)&(pl.col("distance_prior_low20")<=0.08)&(pl.col("ret20_prev")<=-0.03)),
        ("BOUNCE_DOWNTREND_A", (pl.col("ret20_prev")<=-0.08)&(pl.col("ret3_prev")>=0.01)&(pl.col("ret3_prev")<=0.06)&(pl.col("prev_close_loc")<=0.45)),
        ("OVERBOUGHT_REV_A", (pl.col("ret5_prev")>=0.05)&(pl.col("prev_body")<0)&(pl.col("prev_close_loc")<=0.35)&(pl.col("prior_rvol")>=1.2)),
        ("VOL_EXP_CONT_A", (pl.col("prev_range_pct")>=pl.col("prior_atr_pct")*1.5)&(pl.col("prev_body")<0)&(pl.col("prev_close_loc")<=0.20)),
        ("WAVE_ACCEL_A", (pl.col("wave_accel")<=-0.025)&(pl.col("ret10_prev")<=-0.02)&(pl.col("prior_rvol")>=1.1)),
        ("EVENT_CONT_A", (pl.col("ret1_prev")<=-0.04)&(pl.col("prior_rvol")>=2.0)&(pl.col("prev_close_loc")<=0.25)),
        ("EVENT_CONT_B", (pl.col("ret1_prev")<=-0.07)&(pl.col("prior_rvol")>=3.0)&(pl.col("prev_close_loc")<=0.20)),
        ("EVENT_REVERSAL_A", (pl.col("ret1_prev")>=0.06)&(pl.col("prior_rvol")>=2.0)&(pl.col("prev_close_loc")<=0.40)),
        ("CS_LAGGARD_A", (pl.col("cs_ret3_low_rank")<=0.10)&(pl.col("cs_rvol_rank")<=0.20)&(pl.col("ret3_prev")<0)),
        ("CS_LAGGARD_B", (pl.col("cs_ret3_low_rank")<=0.05)&(pl.col("cs_rvol_rank")<=0.10)&(pl.col("prev_close_loc")<=0.35)),
    ]


def simulate(signals:pl.DataFrame,market:str,direction:str,target:float,stop:float,name:str)->pl.DataFrame:
    cost=COSTS[market]
    if direction=="LONG":
        stop_hit=pl.col("low")<=pl.col("open")*(1.0-stop)
        target_hit=pl.col("high")>=pl.col("open")*(1.0+target)
        exit_price=(
            pl.when(stop_hit).then(pl.col("open")*(1.0-stop))
            .when(target_hit).then(pl.col("open")*(1.0+target))
            .otherwise(pl.col("close"))
        )
        gross=exit_price/pl.col("open")-1.0
        mfe=pl.col("high")/pl.col("open")-1.0
        mae=1.0-pl.col("low")/pl.col("open")
    else:
        stop_hit=pl.col("high")>=pl.col("open")*(1.0+stop)
        target_hit=pl.col("low")<=pl.col("open")*(1.0-target)
        exit_price=(
            pl.when(stop_hit).then(pl.col("open")*(1.0+stop))
            .when(target_hit).then(pl.col("open")*(1.0-target))
            .otherwise(pl.col("close"))
        )
        gross=1.0-exit_price/pl.col("open")
        mfe=1.0-pl.col("low")/pl.col("open")
        mae=pl.col("high")/pl.col("open")-1.0
    return signals.with_columns([
        pl.lit(market).alias("market"),
        pl.lit(direction).alias("direction"),
        pl.lit(name).alias("candidate"),
        pl.col("open").alias("entryPrice"),
        exit_price.alias("exitPrice"),
        gross.alias("grossReturn"),
        pl.lit(cost).alias("roundTripCost"),
        (gross-cost).alias("netReturn"),
        mfe.alias("MFE"),
        mae.alias("MAE"),
        pl.when(stop_hit).then(pl.lit("STOP"))
          .when(target_hit).then(pl.lit("TARGET"))
          .otherwise(pl.lit("CLOSE")).alias("exitReason"),
    ])


def gate(m:dict,min_trades:int)->dict:
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1.0,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def metrics_period(trades:pl.DataFrame,market:str,dates:list,start,end):
    sub=trades.filter((pl.col("date")>=pl.lit(start))&(pl.col("date")<pl.lit(end)))
    ds=[d for d in dates if start<=d<end]
    return v1.metrics(sub,market,ds)


def rank_key(m:dict,name:str):
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
    ap.add_argument("--market",required=True,choices=MARKETS)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    loaded,source=load_market(market)
    v1.assert_source_coverage(market,source)
    raw=add_features(loaded,market).filter(tradable_mask(market))
    dates=raw.select("date").unique().sort("date").get_column("date").to_list()
    if not dates:
        raise RuntimeError(f"NO_FACTORY_DATES:{market}")

    dirs=[("LONG",long_defs())]
    if market=="CRYPTO_FUTURES":
        dirs.append(("SHORT",short_defs()))

    reports={}
    grid=[]
    candidate_ledgers={}
    for direction,defs in dirs:
        for family,mask in defs:
            sig=raw.filter(mask)
            if sig.is_empty():
                continue
            for exit_name,target,stop in EXIT_CONFIGS:
                name=f"{direction}_{family}_{exit_name}"
                trades=simulate(sig,market,direction,target,stop,name)
                mt=metrics_period(trades,market,dates,dates[0],TRAIN_END)
                mc=metrics_period(trades,market,dates,TRAIN_END,CAL_END)
                mv=metrics_period(trades,market,dates,CAL_END,VAL_END)
                gt=gate(mt,60); gc=gate(mc,20); gv=gate(mv,30)
                eligible=gt["pass"] and gc["pass"]
                reports[name]={
                    "direction":direction,"family":family,"exit":exit_name,
                    "train":mt,"calibration":mc,"validation":mv,
                    "trainGate":gt,"calibrationGate":gc,"validationGate":gv,
                    "eligibleAfterCalibration":eligible,
                }
                if eligible:
                    candidate_ledgers[name]=trades
                grid.append({
                    "candidate":name,"direction":direction,"family":family,"exit":exit_name,
                    "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                    "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                    "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                    "distinctSymbols":trades.select("symbol").unique().height,
                    "activeDates":trades.select("date").unique().height,
                })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    pass_names=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None

    pdf=pd.DataFrame(grid)
    pdf.to_csv(out/"candidate-grid.csv",index=False)
    if len(pdf):
        pdf.sort_values(["calibrationPass","calibrationReturn","calibrationPF"],ascending=[False,False,False]).head(30).to_csv(out/"top30-calibration.csv",index=False)
        pdf.sort_values(["validationReturn","validationPF"],ascending=[False,False]).head(30).to_csv(out/"top30-validation-diagnostic.csv",index=False)

    if selected and selected in candidate_ledgers:
        candidate_ledgers[selected].select([
            "market","date","symbol","direction","candidate","entryPrice","exitPrice",
            "grossReturn","roundTripCost","netReturn","MFE","MAE","exitReason",
            "ret1_prev","ret3_prev","ret5_prev","ret10_prev","ret20_prev","prior_rvol",
            "prior_dollar_volume20","prior_atr_pct","compression_ratio","prev_close_loc",
            "prev_body","wave_accel","distance_prior_high20","distance_prior_low20",
        ]).write_csv(out/"selected-ledger.csv")

    summary={
        "schemaVersion":1,
        "contract":"four-market-strategy-factory-v1",
        "market":market,
        "source":source,
        "fullUniverseSymbolsWithTradableRows":raw.select("symbol").unique().height,
        "tradableRows":raw.height,
        "periods":{
            "train":[str(dates[0]),str(TRAIN_END)],
            "calibration":[str(TRAIN_END),str(CAL_END)],
            "validation":[str(CAL_END),str(VAL_END)],
        },
        "candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(pass_names),
        "validationPassCandidates":pass_names,
        "selectedByCalibration":selected,
        "selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "allTradableSymbolsConsidered":True,
            "noFixedTopNUniverseCap":True,
            "signalsUsePriorSessionOnly":True,
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
