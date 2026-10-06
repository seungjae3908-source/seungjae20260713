#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import polars as pl

ROOT=Path(__file__).resolve().parents[2]
V1_SCRIPT=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC=importlib.util.spec_from_file_location("hunter_v1",V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(v1)
census=v1.census

TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()

TOP_NS=(1,3,5,10)
PULLBACKS=(0.005,0.010)
TARGETS=(0.03,0.05)
STOPS=(0.015,0.025)
COST=0.002
ENTRY_SLIPPAGE=0.0005


def aggregate_month(path:Path)->pl.DataFrame:
    con=duckdb.connect()
    q=f"""
    WITH bars AS (
      SELECT
        upper(ticker) AS symbol,
        timezone('America/New_York', timestamp) AS ts,
        CAST(open AS DOUBLE) AS open,
        CAST(high AS DOUBLE) AS high,
        CAST(low AS DOUBLE) AS low,
        CAST(close AS DOUBLE) AS close,
        CAST(volume AS DOUBLE) AS volume
      FROM read_parquet('{path.as_posix()}')
    ), r AS (
      SELECT *, CAST(ts AS DATE) AS date, CAST(ts AS TIME) AS tm
      FROM bars
      WHERE CAST(ts AS TIME)>=TIME '09:30:00'
        AND CAST(ts AS TIME)<TIME '16:00:00'
        AND regexp_matches(symbol,'^[A-Z][A-Z0-9.\-]{{0,9}}$')
    )
    SELECT
      symbol,date,
      arg_min(open,ts) AS open,
      arg_max(close,ts) AS close,
      sum(close*volume) AS dollar_volume,
      max(high) FILTER (WHERE tm<TIME '09:45:00') AS first15_high,
      min(low) FILTER (WHERE tm<TIME '09:45:00') AS first15_low,
      arg_max(close,ts) FILTER (WHERE tm<TIME '09:45:00') AS first15_close,
      sum(volume) FILTER (WHERE tm<TIME '09:45:00') AS first15_volume
    FROM r
    GROUP BY symbol,date
    """
    x=pl.from_arrow(con.execute(q).fetch_arrow_table()); con.close()
    return x


def add_daily_features(combined:pl.DataFrame)->pl.DataFrame:
    x=combined.sort(["symbol","date"]).with_columns([
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("dollar_volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorDollar20"),
        pl.col("first15_volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorFirst15Vol20"),
    ])
    x=x.with_columns([
        (pl.col("open")/pl.col("prev_close")-1.0).alias("gap"),
        (pl.col("first15_close")/pl.col("open")-1.0).alias("first15Return"),
        (pl.col("first15_volume")/pl.col("priorFirst15Vol20")).alias("first15Rvol"),
        ((pl.col("first15_high")-pl.col("first15_low"))/pl.col("open")).alias("first15Range"),
        ((pl.col("first15_close")-pl.col("first15_low"))/(pl.col("first15_high")-pl.col("first15_low")).replace(0,None)).alias("first15CloseLoc"),
    ])
    return x


def broad_candidates(x:pl.DataFrame)->pl.DataFrame:
    return x.filter(
        pl.col("first15Return").is_not_null()
        & pl.col("first15Rvol").is_not_null()
        & (pl.col("open")>=2.0)
        & (pl.col("priorDollar20")>=5_000_000)
        & (pl.col("first15Return")>=0.005)
        & (pl.col("first15Rvol")>=1.5)
        & (pl.col("first15CloseLoc")>=0.65)
    )


def score_and_top(x:pl.DataFrame,family:str,top_n:int)->pl.DataFrame:
    if family=="RS":
        z=x.filter(
            (pl.col("first15Return")>=0.01)
            &(pl.col("first15Rvol")>=2.0)
            &(pl.col("first15CloseLoc")>=0.70)
        )
    elif family=="GAP_RS":
        z=x.filter(
            (pl.col("gap")>=0.015)&(pl.col("gap")<=0.30)
            &(pl.col("first15Return")>=0.005)
            &(pl.col("first15Rvol")>=2.0)
        )
    elif family=="PRESSURE":
        z=x.filter(
            (pl.col("first15Rvol")>=3.0)
            &(pl.col("first15CloseLoc")>=0.80)
            &(pl.col("first15Return")>=0.005)
        )
    else:
        raise ValueError(family)
    if z.is_empty(): return z
    z=z.with_columns([
        pl.col("first15Return").rank("average",descending=True).over("date").alias("r1"),
        pl.col("first15Rvol").rank("average",descending=True).over("date").alias("r2"),
        pl.col("priorDollar20").rank("average",descending=True).over("date").alias("r3"),
        pl.col("first15CloseLoc").rank("average",descending=True).over("date").alias("r4"),
    ]).with_columns((-(pl.col("r1")+pl.col("r2")+0.5*pl.col("r3")+pl.col("r4"))).alias("score"))
    return z.sort(["date","score"],descending=[False,True]).group_by("date",maintain_order=True).head(top_n)


def replay_month(path:Path,cands:pl.DataFrame)->list[dict]:
    if cands.is_empty(): return []
    cols=["symbol","date","first15_high","open","gap","first15Return","first15Rvol","first15CloseLoc","priorDollar20"]
    join=cands.select(cols).unique()
    con=duckdb.connect(); con.register("cands",join.to_arrow())
    q=f"""
    WITH bars AS (
      SELECT
        upper(ticker) AS symbol,
        timezone('America/New_York',timestamp) AS ts,
        CAST(open AS DOUBLE) AS open,
        CAST(high AS DOUBLE) AS high,
        CAST(low AS DOUBLE) AS low,
        CAST(close AS DOUBLE) AS close,
        CAST(volume AS DOUBLE) AS volume
      FROM read_parquet('{path.as_posix()}')
    ), r AS (
      SELECT *, CAST(ts AS DATE) AS date, CAST(ts AS TIME) AS tm
      FROM bars
      WHERE CAST(ts AS TIME)>=TIME '09:30:00' AND CAST(ts AS TIME)<TIME '16:00:00'
    )
    SELECT r.symbol,r.date,r.ts,r.open,r.high,r.low,r.close,r.volume,
           c.first15_high,c.gap,c.first15Return,c.first15Rvol,c.first15CloseLoc,c.priorDollar20
    FROM r JOIN cands c ON r.symbol=c.symbol AND r.date=c.date
    ORDER BY r.symbol,r.date,r.ts
    """
    pdf=con.execute(q).df(); con.close()
    rows=[]
    for (sym,date),g in pdf.groupby(["symbol","date"],sort=False):
        g=g.sort_values("ts").reset_index(drop=True)
        after=g[pd.to_datetime(g["ts"]).dt.time>=pd.Timestamp("09:45").time()].copy()
        if len(after)<4: continue
        # Running VWAP from open; completed-minute only.
        qv=g["close"].astype(float)*g["volume"].astype(float)
        g["vwap"]=qv.cumsum()/g["volume"].astype(float).cumsum().replace(0,np.nan)
        start_idx=int(after.index[0])
        morning_high=float(g["first15_high"].iloc[0])
        for pb in PULLBACKS:
            pull_i=None
            entry_i=None
            running_high=morning_high
            for i in range(start_idx,len(g)-1):
                hi=float(g["high"].iloc[i]); close=float(g["close"].iloc[i])
                running_high=max(running_high,hi)
                vwap=float(g["vwap"].iloc[i]) if np.isfinite(g["vwap"].iloc[i]) else np.nan
                if pull_i is None:
                    if close<=running_high*(1.0-pb) and np.isfinite(vwap) and close>=vwap:
                        pull_i=i
                    continue
                if i<max(pull_i+1,3): continue
                prev3=float(g["high"].iloc[i-3:i].max())
                if close>=prev3 and close>=morning_high and np.isfinite(vwap) and close>=vwap:
                    entry_i=i+1; break
            if entry_i is None or entry_i>=len(g): continue
            entry=float(g["open"].iloc[entry_i])*(1.0+ENTRY_SLIPPAGE)
            future=g.iloc[entry_i:].copy()
            for target in TARGETS:
                for stop in STOPS:
                    tp=entry*(1+target); sl=entry*(1-stop)
                    exit_price=float(future["close"].iloc[-1]); exit_reason="EOD"; exit_time=future["ts"].iloc[-1]
                    for _,bar in future.iterrows():
                        if float(bar["low"])<=sl:
                            exit_price=sl; exit_reason="STOP"; exit_time=bar["ts"]; break
                        if float(bar["high"])>=tp:
                            exit_price=tp; exit_reason="TARGET"; exit_time=bar["ts"]; break
                    gross=exit_price/entry-1.0
                    rows.append({
                        "date":pd.Timestamp(date).date(),"symbol":sym,"pullbackPct":pb,
                        "targetPct":target,"stopPct":stop,
                        "entryPrice":entry,"exitPrice":exit_price,"grossReturn":gross,"netReturn":gross-COST,
                        "MFE":float(future["high"].max())/entry-1.0,
                        "MAE":1.0-float(future["low"].min())/entry,
                        "entryTime":str(g["ts"].iloc[entry_i]),"exitTime":str(exit_time),"exitReason":exit_reason,
                        "gap":float(g["gap"].iloc[0]),"first15Return":float(g["first15Return"].iloc[0]),
                        "first15Rvol":float(g["first15Rvol"].iloc[0]),"first15CloseLoc":float(g["first15CloseLoc"].iloc[0]),
                        "priorDollar20":float(g["priorDollar20"].iloc[0]),
                    })
    return rows


def stream_data():
    daily_frames=[]; outcome_rows=[]; history=None
    base_cols=["symbol","date","open","close","dollar_volume","first15_high","first15_low","first15_close","first15_volume"]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for idx,month in enumerate(census._month_iter(census.START,census.END_EXCLUSIVE),1):
            p=root/f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            census._download_us_month(month,p)
            mb=aggregate_month(p).select(base_cols).sort(["symbol","date"])
            combined=mb if history is None else pl.concat([history,mb],how="vertical").sort(["symbol","date"])
            feat=add_daily_features(combined)
            a=month.date(); b=(month+pd.offsets.MonthBegin(1)).date()
            cur=feat.filter((pl.col("date")>=pl.lit(a))&(pl.col("date")<pl.lit(b)))
            if cur.height:
                daily_frames.append(cur)
                broad=broad_candidates(cur)
                if broad.height:
                    # Replay the union of top50 from each family to avoid repeated raw reads.
                    unions=[]
                    for fam in ("RS","GAP_RS","PRESSURE"):
                        z=score_and_top(broad,fam,50)
                        if not z.is_empty():unions.append(z)
                    if unions:
                        union=pl.concat(unions,how="vertical").unique(["date","symbol"])
                        r=replay_month(p,union); outcome_rows.extend(r)
                    else:r=[]
                else:r=[]
            else:r=[]
            history=combined.group_by("symbol",maintain_order=True).tail(25).select(base_cols)
            print(json.dumps({"usSipMonth":month.strftime("%Y-%m"),"dailyRows":cur.height,"totalOutcomes":len(outcome_rows),"monthIndex":idx}),flush=True)
            p.unlink(missing_ok=True)
    if not daily_frames or not outcome_rows: raise RuntimeError("US_SIP_NO_DATA")
    return pl.concat(daily_frames,how="vertical").sort(["date","symbol"]),pl.from_pandas(pd.DataFrame(outcome_rows)).with_columns(pl.col("date").cast(pl.Date))


def gate(m,n):
    checks={"positiveReturn":float(m.get("totalReturn") or 0)>0,"profitFactorAbove1":float(m.get("profitFactor") or 0)>1,"positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=.5,"mddAtMost35pct":float(m.get("mdd") or 1)<=.35,"minimumTrades":int(m.get("tradeCount") or 0)>=n}
    return {"pass":all(checks.values()),"checks":checks}


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--out-dir",required=True); args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    daily,outcomes=stream_data()
    dates=daily.select("date").unique().sort("date").get_column("date").to_list()
    reports={};grid=[];ledgers={}
    for fam in ("RS","GAP_RS","PRESSURE"):
        base=broad_candidates(daily)
        for topn in TOP_NS:
            sig=score_and_top(base,fam,topn)
            if sig.is_empty():continue
            for pb in PULLBACKS:
                for target in TARGETS:
                    for stop in STOPS:
                        name=f"{fam}_TOP{topn}_PB{pb*100:.1f}_TP{int(target*100)}_SL{stop*100:.1f}"
                        oc=outcomes.filter((pl.col("pullbackPct")==pb)&(pl.col("targetPct")==target)&(pl.col("stopPct")==stop))
                        trades=sig.join(oc,on=["date","symbol"],how="inner").with_columns([
                            pl.lit("US_STOCK").alias("market"),pl.lit("LONG").alias("direction"),pl.lit(name).alias("candidate"),pl.lit(COST).alias("roundTripCost")
                        ])
                        tr=trades.filter(pl.col("date")<pl.lit(TRAIN_END))
                        ca=trades.filter((pl.col("date")>=pl.lit(TRAIN_END))&(pl.col("date")<pl.lit(CAL_END)))
                        va=trades.filter((pl.col("date")>=pl.lit(CAL_END))&(pl.col("date")<pl.lit(VAL_END)))
                        mt=v1.metrics(tr,"US_STOCK",[d for d in dates if d<TRAIN_END])
                        mc=v1.metrics(ca,"US_STOCK",[d for d in dates if TRAIN_END<=d<CAL_END])
                        mv=v1.metrics(va,"US_STOCK",[d for d in dates if CAL_END<=d<VAL_END])
                        gt,gc,gv=gate(mt,40),gate(mc,15),gate(mv,20)
                        eligible=gt["pass"] and gc["pass"]
                        reports[name]={"family":fam,"topN":topn,"train":mt,"calibration":mc,"validation":mv,"trainGate":gt,"calibrationGate":gc,"validationGate":gv,"eligibleAfterCalibration":eligible}
                        if eligible:ledgers[name]=trades
                        grid.append({"candidate":name,"family":fam,"topN":topn,"pullback":pb,"target":target,"stop":stop,"trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),"calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),"validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount")})
    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    passes=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:(reports[n]["calibration"].get("positiveMonthRate") or 0,reports[n]["calibration"].get("totalReturn") or 0,reports[n]["calibration"].get("profitFactor") or 0,n),reverse=True)[0] if eligible else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:ledgers[selected].write_csv(out/"selected-ledger.csv")
    summary={"schemaVersion":1,"contract":"us-stock-in-play-pullback-v4","fullUniverseSymbols":daily.select("symbol").unique().height,"candidateCount":len(reports),"eligibleAfterCalibrationCount":len(eligible),"validationPassCount":len(passes),"validationPassCandidates":passes,"selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,"truthBoundary":{"allTradableUSSymbolsConsidered":True,"currentDayFirst15mFeaturesKnownBeforeEntry":True,"pullbackAndRebreakUseCompleted1mBars":True,"entryNextMinuteOpen":True,"validationExcludedFromSelection":True,"profitabilityProven":False,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":main()
