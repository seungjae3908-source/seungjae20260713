#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import duckdb
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

orb=load_module("us_orb_v3","market-prediction-lab/scripts/run-full-universe-3pct-hunter-us-orb-v3.py")
v1=orb.v1
census=orb.census

TRAIN_END=pd.Timestamp("2024-04-01").date()
CAL_END=pd.Timestamp("2024-10-01").date()
VAL_END=pd.Timestamp("2025-04-01").date()
END=pd.Timestamp("2026-04-01").date()

GAPS=(0.02,0.04,0.06)
FIRST5_RVOLS=(1.5,2.5,4.0)
FIRST5_RETURNS=(0.00,0.01)
TOP_NS=(5,10)
PULLBACKS=(0.005,0.010)
MAX_REBREAK_WAITS=(30,60)
TARGETS=(0.03,0.05)
STOP=0.015
HOLDS=(60,120)
BREAKOUT_CONFIRM=0.0005
ENTRY_SLIPPAGE=0.0005
COST=0.002


def rank_daily(x:pl.DataFrame,top_n:int):
    if x.is_empty():return x
    return (
        x.with_columns([
            pl.col("gap").rank("average",descending=True).over("date").alias("r1"),
            pl.col("first5Rvol").rank("average",descending=True).over("date").alias("r2"),
            pl.col("first5Return").rank("average",descending=True).over("date").alias("r3"),
            pl.col("priorDollar20").rank("average",descending=True).over("date").alias("r4"),
        ])
        .with_columns((-(pl.col("r1")+pl.col("r2")+pl.col("r3")+0.5*pl.col("r4"))).alias("score"))
        .sort(["date","score"],descending=[False,True])
        .group_by("date",maintain_order=True).head(top_n)
    )


def replay_month(path:Path,cand:pl.DataFrame):
    if cand.is_empty():return []
    join=cand.select(["symbol","date","first5_high"]).unique()
    con=duckdb.connect()
    con.register("candidate_days",join.to_arrow())
    q=f"""
    WITH bars AS (
      SELECT
        upper(ticker) AS symbol,
        timezone('America/New_York', timestamp) AS local_ts,
        CAST(open AS DOUBLE) AS open,
        CAST(high AS DOUBLE) AS high,
        CAST(low AS DOUBLE) AS low,
        CAST(close AS DOUBLE) AS close,
        CAST(volume AS DOUBLE) AS volume
      FROM read_parquet('{path.as_posix()}')
    ),
    regular AS (
      SELECT *, CAST(local_ts AS DATE) AS date, CAST(local_ts AS TIME) AS local_time
      FROM bars
      WHERE CAST(local_ts AS TIME) >= TIME '09:35:00'
        AND CAST(local_ts AS TIME) < TIME '16:00:00'
    )
    SELECT r.symbol,r.date,r.local_ts,r.open,r.high,r.low,r.close,r.volume,c.first5_high
    FROM regular r
    INNER JOIN candidate_days c ON r.symbol=c.symbol AND r.date=c.date
    ORDER BY r.symbol,r.date,r.local_ts
    """
    pdf=con.execute(q).df()
    con.close()
    if pdf.empty:return []

    out=[]
    for (symbol,date),g in pdf.groupby(["symbol","date"],sort=False):
        g=g.sort_values("local_ts").reset_index(drop=True)
        first5_high=float(g["first5_high"].iloc[0])
        threshold=first5_high*(1.0+BREAKOUT_CONFIRM)

        breakout_i=None
        for i,row in g.iterrows():
            if float(row["close"])>=threshold:
                breakout_i=i;break
        if breakout_i is None:continue

        for pb in PULLBACKS:
            for wait in MAX_REBREAK_WAITS:
                limit=min(len(g)-2,breakout_i+wait)
                running_high=float(g["high"].iloc[breakout_i])
                pull_i=None
                entry_i=None
                for i in range(breakout_i+1,limit+1):
                    running_high=max(running_high,float(g["high"].iloc[i]))
                    if pull_i is None:
                        if float(g["low"].iloc[i])<=running_high*(1.0-pb) and float(g["close"].iloc[i])>=first5_high*0.995:
                            pull_i=i
                        continue
                    if i<3:continue
                    prior3=float(g["high"].iloc[max(pull_i,i-3):i].max())
                    if float(g["close"].iloc[i])>=max(threshold,prior3):
                        entry_i=i+1
                        break
                if entry_i is None or entry_i>=len(g):continue

                entry=float(g["open"].iloc[entry_i])*(1.0+ENTRY_SLIPPAGE)
                if entry<=0:continue
                for target in TARGETS:
                    for hold in HOLDS:
                        end_i=min(len(g)-1,entry_i+hold-1)
                        future=g.iloc[entry_i:end_i+1]
                        tp=entry*(1.0+target); sl=entry*(1.0-STOP)
                        exit_i=end_i;exit_px=float(g["close"].iloc[end_i]);reason="MAX_HOLD"
                        for j in range(entry_i,end_i+1):
                            # Conservative same-minute ordering.
                            if float(g["low"].iloc[j])<=sl:
                                exit_i=j;exit_px=sl;reason="STOP";break
                            if float(g["high"].iloc[j])>=tp:
                                exit_i=j;exit_px=tp;reason="TARGET";break
                        gross=exit_px/entry-1.0
                        out.append({
                            "date":pd.Timestamp(date).date(),"symbol":str(symbol),
                            "pullbackPct":pb,"maxRebreakWait":wait,
                            "targetPct":target,"stopPct":STOP,"holdMinutes":hold,
                            "entryPrice":entry,"exitPrice":exit_px,
                            "grossReturn":gross,"netReturn":gross-COST,
                            "MFE":float(future["high"].max())/entry-1.0,
                            "MAE":1.0-float(future["low"].min())/entry,
                            "breakoutTime":str(g["local_ts"].iloc[breakout_i]),
                            "pullbackTime":str(g["local_ts"].iloc[pull_i]),
                            "entryTime":str(g["local_ts"].iloc[entry_i]),
                            "exitTime":str(g["local_ts"].iloc[exit_i]),
                            "exitReason":reason,
                        })
    return out


def stream():
    daily_frames=[]
    outcomes=[]
    history=None
    base_cols=["symbol","date","open","close","volume","dollar_volume","first5_high","first5_low","first5_close","first5_volume"]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for idx,month in enumerate(census._month_iter(census.START,census.END_EXCLUSIVE),1):
            path=root/f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            census._download_us_month(month,path)
            month_base=orb.aggregate_month(path).select(base_cols).sort(["symbol","date"])
            combined=month_base if history is None or history.is_empty() else pl.concat([history,month_base],how="vertical").sort(["symbol","date"])
            feat=combined.with_columns([
                pl.col("close").shift(1).over("symbol").alias("prev_close"),
                pl.col("dollar_volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorDollar20"),
                pl.col("first5_volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorFirst5Vol20"),
            ]).with_columns([
                (pl.col("open")/pl.col("prev_close")-1.0).alias("gap"),
                (pl.col("first5_volume")/pl.col("priorFirst5Vol20")).alias("first5Rvol"),
                (pl.col("first5_close")/pl.col("open")-1.0).alias("first5Return"),
            ])
            mstart=month.date();mend=(month+pd.offsets.MonthBegin(1)).date()
            current=feat.filter(
                (pl.col("date")>=pl.lit(mstart))&(pl.col("date")<pl.lit(mend))
                &pl.col("gap").is_not_null()&pl.col("first5Rvol").is_not_null()&pl.col("first5Return").is_not_null()
                &(pl.col("open")>=2.0)&(pl.col("priorDollar20")>=5_000_000)
            )
            if current.height:
                daily_frames.append(current)
                broad=current.filter(
                    (pl.col("gap")>=min(GAPS))&(pl.col("gap")<=0.30)
                    &(pl.col("first5Rvol")>=min(FIRST5_RVOLS))
                    &(pl.col("first5Return")>=min(FIRST5_RETURNS))
                )
                if broad.height:
                    outcomes.extend(replay_month(path,broad))
                else:
                    broad=current.head(0)
            else:
                broad=current
            history=combined.sort(["symbol","date"]).group_by("symbol",maintain_order=True).tail(25).select(base_cols)
            print(json.dumps({
                "usPullbackMonth":month.strftime("%Y-%m"),"dailyRows":current.height,
                "broadDays":broad.height,"outcomes":len(outcomes),"index":idx
            }),flush=True)
            path.unlink(missing_ok=True)
    if len(daily_frames)<34 or not outcomes:
        raise RuntimeError(f"US_PULLBACK_DATA_INCOMPLETE:{len(daily_frames)}:{len(outcomes)}")
    return pl.concat(daily_frames,how="vertical").sort(["date","symbol"]),pl.DataFrame(outcomes).with_columns(pl.col("date").cast(pl.Date))


def gate(m,min_trades):
    return orb.gate(m,min_trades)


def metrics_period(trades,dates,start,end):
    sub=trades.filter((pl.col("date")>=pl.lit(start))&(pl.col("date")<pl.lit(end)))
    ds=[d for d in dates if start<=d<end]
    return v1.metrics(sub,"US_STOCK",ds)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    daily,outcomes=stream()
    dates=daily.select("date").unique().sort("date").get_column("date").to_list()
    reports={};grid=[];ledgers={}
    for gap in GAPS:
        for rv in FIRST5_RVOLS:
            for strength in FIRST5_RETURNS:
                base=daily.filter(
                    (pl.col("gap")>=gap)&(pl.col("gap")<=0.30)
                    &(pl.col("first5Rvol")>=rv)&(pl.col("first5Return")>=strength)
                )
                for top_n in TOP_NS:
                    selected=rank_daily(base,top_n)
                    for pb in PULLBACKS:
                        for wait in MAX_REBREAK_WAITS:
                            for target in TARGETS:
                                for hold in HOLDS:
                                    name=f"US_PULLBACK_G{int(gap*100)}_RV{rv:g}_F5{int(strength*100)}_TOP{top_n}_PB{pb*100:.1f}_W{wait}_TP{int(target*100)}_H{hold}"
                                    oc=outcomes.filter(
                                        (pl.col("pullbackPct")==pb)&(pl.col("maxRebreakWait")==wait)
                                        &(pl.col("targetPct")==target)&(pl.col("holdMinutes")==hold)
                                    )
                                    trades=selected.join(oc,on=["date","symbol"],how="inner").with_columns([
                                        pl.lit("US_STOCK").alias("market"),
                                        pl.lit("LONG").alias("direction"),
                                        pl.lit(name).alias("candidate"),
                                        pl.lit(COST).alias("roundTripCost"),
                                    ])
                                    mt=metrics_period(trades,dates,dates[0],TRAIN_END)
                                    mc=metrics_period(trades,dates,TRAIN_END,CAL_END)
                                    mv=metrics_period(trades,dates,CAL_END,VAL_END)
                                    mr=metrics_period(trades,dates,VAL_END,END)
                                    gt,gc,gv=gate(mt,50),gate(mc,15),gate(mv,15)
                                    eligible=gt["pass"] and gc["pass"]
                                    reports[name]={
                                        "train":mt,"calibration":mc,"validation":mv,"reused":mr,
                                        "trainGate":gt,"calibrationGate":gc,"validationGate":gv,
                                        "eligibleAfterCalibration":eligible
                                    }
                                    if eligible:ledgers[name]=trades
                                    grid.append({
                                        "candidate":name,"gap":gap,"rvol":rv,"first5Return":strength,"topN":top_n,
                                        "pullbackPct":pb,"wait":wait,"target":target,"hold":hold,
                                        "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainTrades":mt.get("tradeCount"),
                                        "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                                        "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                                        "reusedReturn":mr.get("totalReturn"),"reusedPF":mr.get("profitFactor"),"reusedMDD":mr.get("mdd"),"reusedPosMonthRate":mr.get("positiveMonthRate"),"reusedTrades":mr.get("tradeCount"),
                                    })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val_pass=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:orb.rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:
        ledgers[selected].write_csv(out/"selected-ledger.csv")
    summary={
        "schemaVersion":1,"contract":"us-opening-pullback-rebreak-v4",
        "candidateCount":len(reports),"eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(val_pass),"validationPassCandidates":val_pass,
        "selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "allUsTradableSymbolsConsideredBeforeDailyRanking":True,
            "entryAfterBreakoutThenPullbackThenCompleted1mRebreak":True,
            "entryNextMinuteOpen":True,
            "stopFirstConservative":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "2025_04_to_2026_03AlreadySeenInPriorResearch":True,
            "profitabilityProven":False,"executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
