#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import pandas as pd
import polars as pl

ROOT = Path(__file__).resolve().parents[2]
V1_PATH = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-causal-backtest-v1.py"
KR3_PATH = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-kr-event-v3.py"

def load_module(path: Path, name: str):
    spec=importlib.util.spec_from_file_location(name,path)
    if spec is None or spec.loader is None: raise RuntimeError(f"IMPORT_FAILED:{name}")
    mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

v1=load_module(V1_PATH,"hunter_v1")
kr3=load_module(KR3_PATH,"kr_event_v3")

TRAIN_END=kr3.TRAIN_END
VALID_END=kr3.VALID_END
OOS_END=kr3.OOS_END
COST=0.003

ACCELS=(1.5,2.5)
RVOLS=(1.2,1.8)
COMPRESSIONS=(0.8,1.0)
NEAR_HIGHS=(-0.05,-0.10)
MONOTONIC=(False,True)
TOP_NS=(1,3)
TARGETS=(0.03,0.05)
STOPS=(0.02,0.03)


def add_features(df: pl.DataFrame) -> pl.DataFrame:
    x=df.sort(["symbol","date"]).with_columns(
        (pl.col("close")*pl.col("volume")).alias("dollar"),
        ((pl.col("high")-pl.col("low"))/pl.col("close")).alias("rangePct"),
    )
    x=x.with_columns([
        pl.col("open").shift(1).over("symbol").alias("prev_open"),
        pl.col("high").shift(1).over("symbol").alias("prev_high"),
        pl.col("low").shift(1).over("symbol").alias("prev_low"),
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("close").shift(2).over("symbol").alias("close2"),
        pl.col("close").shift(6).over("symbol").alias("close6"),
        pl.col("dollar").shift(1).over("symbol").alias("dv1"),
        pl.col("dollar").shift(2).over("symbol").alias("dv2"),
        pl.col("dollar").shift(3).over("symbol").alias("dv3"),
        pl.col("dollar").shift(4).over("symbol").alias("dv4"),
        pl.col("dollar").shift(2).rolling_mean(20,min_samples=10).over("symbol").alias("preDollar20"),
        pl.col("rangePct").shift(2).rolling_mean(20,min_samples=10).over("symbol").alias("preRange20"),
        pl.col("high").shift(1).rolling_max(20,min_samples=10).over("symbol").alias("priorHigh20"),
    ])
    x=x.with_columns([
        (pl.col("dv1")/((pl.col("dv2")+pl.col("dv3")+pl.col("dv4"))/3.0)).alias("accel3"),
        (pl.col("dv1")/pl.col("preDollar20")).alias("dollarRvol"),
        (((pl.col("prev_high")-pl.col("prev_low"))/pl.col("prev_close"))/pl.col("preRange20")).alias("compressionRatio"),
        (pl.col("prev_close")/pl.col("priorHigh20")-1.0).alias("nearHigh20"),
        (pl.col("prev_close")/pl.col("close2")-1.0).alias("ret1"),
        (pl.col("prev_close")/pl.col("close6")-1.0).alias("ret5"),
        ((pl.col("dv1")>pl.col("dv2"))&(pl.col("dv2")>pl.col("dv3"))).alias("monotonicAccel"),
    ])
    return x.filter(
        pl.col("accel3").is_not_null()
        & pl.col("dollarRvol").is_not_null()
        & pl.col("compressionRatio").is_not_null()
        & pl.col("nearHigh20").is_not_null()
        & (pl.col("open")>=1000)
        & (pl.col("preDollar20")>=1_000_000_000)
        & (pl.col("ret1")>=-0.02) & (pl.col("ret1")<=0.05)
        & (pl.col("ret5")>=-0.02) & (pl.col("ret5")<=0.15)
    )


def rank_daily(x: pl.DataFrame,top_n:int)->pl.DataFrame:
    if x.is_empty(): return x
    return (
        x.with_columns([
            pl.col("accel3").rank("average",descending=True).over("date").alias("r1"),
            pl.col("dollarRvol").rank("average",descending=True).over("date").alias("r2"),
            pl.col("nearHigh20").rank("average",descending=True).over("date").alias("r3"),
            (-pl.col("compressionRatio")).rank("average",descending=True).over("date").alias("r4"),
            pl.col("dv1").rank("average",descending=True).over("date").alias("r5"),
        ])
        .with_columns((-(pl.col("r1")+pl.col("r2")+pl.col("r3")+pl.col("r4")+pl.col("r5"))).alias("score"))
        .sort(["date","score"],descending=[False,True])
        .group_by("date",maintain_order=True).head(top_n)
    )


def simulate(rows:pl.DataFrame,target:float,stop:float,name:str)->pl.DataFrame:
    if rows.is_empty(): return rows
    sh=pl.col("low")<=pl.col("open")*(1-stop)
    th=pl.col("high")>=pl.col("open")*(1+target)
    exitp=pl.when(sh).then(pl.col("open")*(1-stop)).when(th).then(pl.col("open")*(1+target)).otherwise(pl.col("close"))
    gross=exitp/pl.col("open")-1
    return rows.with_columns([
        pl.lit("KR_STOCK").alias("market"),pl.lit("LONG").alias("direction"),pl.lit(name).alias("candidate"),
        pl.col("open").alias("entryPrice"),exitp.alias("exitPrice"),pl.lit(target).alias("targetPct"),pl.lit(stop).alias("stopPct"),
        pl.lit(COST).alias("roundTripCost"),gross.alias("grossReturn"),(gross-COST).alias("netReturn"),
        (pl.col("high")/pl.col("open")-1).alias("MFE"),(1-pl.col("low")/pl.col("open")).alias("MAE"),
        pl.when(sh).then(pl.lit("STOP")).when(th).then(pl.lit("TARGET")).otherwise(pl.lit("EOD")).alias("exitReason"),
    ])


def gate(m:dict,min_trades:int):
    checks={"positiveReturn":float(m.get("totalReturn") or 0)>0,
            "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
            "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,
            "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
            "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades}
    return {"pass":all(checks.values()),"checks":checks}


def rank_key(m:dict,name:str):
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 0),int(m.get("tradeCount") or 0),name)


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--out-dir",required=True); args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    raw,source=kr3.load_kr_extended()
    x=add_features(raw)
    dates=x.select("date").unique().sort("date").get_column("date").to_list()
    td=[d for d in dates if d<TRAIN_END]
    vd=[d for d in dates if TRAIN_END<=d<VALID_END]
    od=[d for d in dates if VALID_END<=d<OOS_END]

    reports={}; grid=[]
    for acc in ACCELS:
        for rv in RVOLS:
            for comp in COMPRESSIONS:
                for nh in NEAR_HIGHS:
                    for mono in MONOTONIC:
                        mask=(pl.col("accel3")>=acc)&(pl.col("dollarRvol")>=rv)&(pl.col("compressionRatio")<=comp)&(pl.col("nearHigh20")>=nh)
                        if mono: mask=mask&pl.col("monotonicAccel")
                        base=x.filter(mask)
                        for top_n in TOP_NS:
                            sel=rank_daily(base,top_n)
                            for target in TARGETS:
                                for stop in STOPS:
                                    name=f"KR_ACCEL_A{acc:g}_RV{rv:g}_C{comp:g}_NH{abs(nh)*100:g}_M{int(mono)}_TOP{top_n}_TP{int(target*100)}_SL{int(stop*100)}"
                                    tr=simulate(sel,target,stop,name)
                                    train=tr.filter(pl.col("date")<pl.lit(TRAIN_END))
                                    valid=tr.filter((pl.col("date")>=pl.lit(TRAIN_END))&(pl.col("date")<pl.lit(VALID_END)))
                                    oos=tr.filter((pl.col("date")>=pl.lit(VALID_END))&(pl.col("date")<pl.lit(OOS_END)))
                                    mt=v1.metrics(train,"KR_STOCK",td); mv=v1.metrics(valid,"KR_STOCK",vd); mo=v1.metrics(oos,"KR_STOCK",od)
                                    gt,gv,go=gate(mt,50),gate(mv,25),gate(mo,12)
                                    reports[name]={"trades":tr,"train":mt,"validation":mv,"oos":mo,"trainGate":gt,"validationGate":gv,"oosGate":go}
                                    grid.append({"candidate":name,"accel":acc,"rvol":rv,"compression":comp,"nearHigh":nh,"monotonic":mono,"topN":top_n,"target":target,"stop":stop,
                                        "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                                        "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                                        "oosReturn":mo.get("totalReturn"),"oosPF":mo.get("profitFactor"),"oosMDD":mo.get("mdd"),"oosPosMonthRate":mo.get("positiveMonthRate"),"oosTrades":mo.get("tradeCount")})

    train_pass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    valid_pass=[n for n in train_pass if reports[n]["validationGate"]["pass"]]
    winner=sorted(valid_pass,key=lambda n:rank_key(reports[n]["validation"],n),reverse=True)[0] if valid_pass else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    summary={"schemaVersion":1,"contract":"full-universe-3pct-hunter-kr-acceleration-v4","source":source,
             "periods":{"train":["2023-04-01",str(TRAIN_END)],"validation":[str(TRAIN_END),str(VALID_END)],"freshOos":[str(VALID_END),str(OOS_END)]},
             "candidateCount":len(grid),"trainPassCount":len(train_pass),"validationPassCount":len(valid_pass),"winner":winner,"profitabilityProven":False,"executionAuthority":"NONE"}
    if winner:
        d=reports[winner]; summary["winnerResults"]={"train":d["train"],"trainGate":d["trainGate"],"validation":d["validation"],"validationGate":d["validationGate"],"freshOos":d["oos"],"freshOosGate":d["oosGate"]}
        cols=["market","date","symbol","direction","candidate","entryPrice","exitPrice","grossReturn","roundTripCost","netReturn","MFE","MAE","accel3","dollarRvol","compressionRatio","nearHigh20","ret1","ret5","monotonicAccel","exitReason"]
        d["trades"].select(cols).write_csv(out/"winner-ledger.csv")
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
