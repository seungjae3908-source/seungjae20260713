#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import pandas as pd
import polars as pl

ROOT=Path(__file__).resolve().parents[2]

def load_module(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v1=load_module("hunter_v1","market-prediction-lab/scripts/run-full-universe-3pct-hunter-causal-backtest-v1.py")
f1=load_module("factory_v1","market-prediction-lab/scripts/run-four-market-strategy-factory-v1.py")
census=v1.census

MARKETS=f1.MARKETS
TRAIN_END=f1.TRAIN_END
CAL_END=f1.CAL_END
VAL_END=f1.VAL_END
TOP_NS=(5,10,20,50)
EXIT_CONFIGS=f1.EXIT_CONFIGS


def load_market(market):
    return f1.load_market(market)


def add_anchor_features(df,market):
    x=f1.add_features(df,market).sort(["symbol","date"])
    x=x.with_columns([
        pl.col("high").shift(1).rolling_max(252,min_samples=120).over("symbol").alias("prior_high252"),
        pl.col("low").shift(1).rolling_min(120,min_samples=60).over("symbol").alias("prior_low120"),
        pl.col("low").shift(1).rolling_min(60,min_samples=30).over("symbol").alias("prior_low60_anchor"),
    ])
    x=x.with_columns([
        (pl.col("prev_close")/pl.col("prior_high252")).alias("pth252"),
        (pl.col("prev_close")/pl.col("prior_low120")-1.0).alias("from_low120"),
        (pl.col("prev_close")/pl.col("prior_low60_anchor")-1.0).alias("from_low60"),
    ])
    return x


def tradable(market):
    return f1.tradable_mask(market) & pl.col("pth252").is_not_null()


def long_defs():
    return [
        ("PTH_MOM_A",(pl.col("pth252")>=0.95)&(pl.col("prior_rvol")>=1.5)&(pl.col("ret20_prev")>=0.05)&(pl.col("prev_close_loc")>=0.65)),
        ("PTH_MOM_B",(pl.col("pth252")>=0.98)&(pl.col("prior_rvol")>=2.0)&(pl.col("ret5_prev")>=0.02)&(pl.col("prev_close_loc")>=0.70)),
        ("PTH_TURNOVER_A",(pl.col("pth252")>=0.90)&(pl.col("prior_rvol")>=2.5)&(pl.col("cs_ret3_rank")<=0.20)&(pl.col("ret3_prev")>0)),
        ("PTH_TURNOVER_B",(pl.col("pth252")>=0.95)&(pl.col("prior_rvol")>=3.0)&(pl.col("cs_ret3_rank")<=0.10)),
        ("PTH_COMPRESSION_A",(pl.col("pth252")>=0.95)&(pl.col("compression_ratio")<=0.70)&(pl.col("ret20_prev")>=0.03)),
        ("PTH_COMPRESSION_B",(pl.col("pth252")>=0.98)&(pl.col("compression_ratio")<=0.55)&(pl.col("prior_rvol")>=1.1)),
        ("LOW_ANCHOR_REV_A",(pl.col("from_low60")<=0.08)&(pl.col("ret5_prev")<=-0.05)&(pl.col("prev_close_loc")>=0.65)&(pl.col("prior_rvol")>=1.2)),
        ("LOW_ANCHOR_REV_B",(pl.col("from_low120")<=0.12)&(pl.col("ret20_prev")<=-0.10)&(pl.col("prev_body")>0)&(pl.col("prev_close_loc")>=0.60)),
        ("ANCHOR_SWITCH_A",(pl.col("pth252")>=0.90)&(pl.col("ret5_prev")<=-0.03)&(pl.col("ret20_prev")>=0.05)&(pl.col("prev_close_loc")>=0.55)),
    ]


def short_defs():
    return [
        ("LOW_MOM_A",(pl.col("from_low120")<=0.08)&(pl.col("prior_rvol")>=1.5)&(pl.col("ret20_prev")<=-0.05)&(pl.col("prev_close_loc")<=0.35)),
        ("LOW_MOM_B",(pl.col("from_low60")<=0.05)&(pl.col("prior_rvol")>=2.0)&(pl.col("ret5_prev")<=-0.02)&(pl.col("prev_close_loc")<=0.30)),
        ("LOW_TURNOVER_A",(pl.col("from_low120")<=0.15)&(pl.col("prior_rvol")>=2.5)&(pl.col("cs_ret3_low_rank")<=0.20)&(pl.col("ret3_prev")<0)),
        ("HIGH_ANCHOR_REV_A",(pl.col("pth252")>=0.95)&(pl.col("ret5_prev")>=0.05)&(pl.col("prev_body")<0)&(pl.col("prev_close_loc")<=0.35)),
        ("HIGH_ANCHOR_REV_B",(pl.col("pth252")>=0.98)&(pl.col("prior_rvol")>=2.0)&(pl.col("ret1_prev")>=0.04)&(pl.col("prev_close_loc")<=0.40)),
    ]


def score(direction):
    if direction=="LONG":
        return (
            pl.col("pth252").fill_null(0.0)*1.5
            +(1.0-pl.col("cs_ret3_rank")).fill_null(0.0)
            +(1.0-pl.col("cs_rvol_rank")).fill_null(0.0)
            +pl.col("prev_close_loc").fill_null(0.5)
            +pl.col("ret20_prev").clip(-0.30,0.30)
        )
    return (
        (1.0-pl.col("from_low120").clip(0,1)).fill_null(0.0)*1.5
        +(1.0-pl.col("cs_ret3_low_rank")).fill_null(0.0)
        +(1.0-pl.col("cs_rvol_rank")).fill_null(0.0)
        +(1.0-pl.col("prev_close_loc").fill_null(0.5))
        +(-pl.col("ret20_prev")).clip(-0.30,0.30)
    )


def topn(sig,direction,n):
    if sig.is_empty():
        return sig
    return (
        sig.with_columns(score(direction).alias("anchorScore"))
        .sort(["date","anchorScore","prior_dollar_volume20"],descending=[False,True,True])
        .group_by("date",maintain_order=True).head(n)
    )


def metrics_period(trades,market,dates,start,end):
    sub=trades.filter((pl.col("date")>=pl.lit(start))&(pl.col("date")<pl.lit(end)))
    ds=[d for d in dates if start<=d<end]
    return v1.metrics(sub,market,ds)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=MARKETS)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    loaded,source=load_market(market)
    v1.assert_source_coverage(market,source)
    raw=add_anchor_features(loaded,market).filter(tradable(market))
    dates=raw.select("date").unique().sort("date").get_column("date").to_list()
    if not dates:
        raise RuntimeError(f"NO_ANCHOR_DATES:{market}")

    lanes=[("LONG",long_defs())]
    if market=="CRYPTO_FUTURES":
        lanes.append(("SHORT",short_defs()))

    reports={}; grid=[]; ledgers={}
    for direction,defs in lanes:
        for family,mask in defs:
            base=raw.filter(mask)
            if base.is_empty(): continue
            for n in TOP_NS:
                sig=topn(base,direction,n)
                for exit_name,tp,sl in EXIT_CONFIGS:
                    name=f"{direction}_{family}_TOP{n}_{exit_name}"
                    trades=f1.simulate(sig,market,direction,tp,sl,name)
                    mt=metrics_period(trades,market,dates,dates[0],TRAIN_END)
                    mc=metrics_period(trades,market,dates,TRAIN_END,CAL_END)
                    mv=metrics_period(trades,market,dates,CAL_END,VAL_END)
                    gt=f1.gate(mt,50); gc=f1.gate(mc,15); gv=f1.gate(mv,25)
                    eligible=gt["pass"] and gc["pass"]
                    reports[name]={
                        "direction":direction,"family":family,"topN":n,"exit":exit_name,
                        "train":mt,"calibration":mc,"validation":mv,
                        "trainGate":gt,"calibrationGate":gc,"validationGate":gv,
                        "eligibleAfterCalibration":eligible,
                    }
                    if eligible: ledgers[name]=trades
                    grid.append({
                        "candidate":name,"direction":direction,"family":family,"topN":n,"exit":exit_name,
                        "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                        "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                        "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                        "distinctSymbols":trades.select("symbol").unique().height,
                        "activeDates":trades.select("date").unique().height,
                    })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    passes=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:f1.rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None

    pdf=pd.DataFrame(grid)
    pdf.to_csv(out/"candidate-grid.csv",index=False)
    if len(pdf):
        pdf.sort_values(["calibrationPass","calibrationReturn","calibrationPF"],ascending=[False,False,False]).head(40).to_csv(out/"top40-calibration.csv",index=False)
    if selected and selected in ledgers:
        ledgers[selected].write_csv(out/"selected-ledger.csv")

    summary={
        "schemaVersion":1,
        "contract":"four-market-anchor-interaction-v3",
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
        "truthBoundary":{
            "allTradableSymbolsConsidered":True,
            "topNAfterFullUniverseScan":True,
            "pth252UsesPriorHighOnly":True,
            "turnoverProxyIsRelativeVolumeNotSharesOutstanding":True,
            "signalsPriorSessionOnly":True,
            "sameDayOpenFillOnly":True,
            "stopFirstConservative":True,
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
