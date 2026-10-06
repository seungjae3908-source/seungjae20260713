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
from datasets import load_dataset

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
orb=load_module("us_orb_v3","market-prediction-lab/scripts/run-full-universe-3pct-hunter-us-orb-v3.py")
census=v1.census

START=pd.Timestamp("2023-04-01").date()
TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
END=pd.Timestamp("2026-04-01").date()

GAPS=(0.02,0.04,0.06)
FIRST5_RVOLS=(1.2,2.0)
FIRST5_RETURNS=(0.00,0.01)
PULLBACKS=(0.005,0.010)
EXITS=(("TP3_SL1p5",0.03,0.015),("TP5_SL1p5",0.05,0.015))
COST=0.002
ENTRY_SLIPPAGE=0.0005


def load_events():
    ds=load_dataset("ZipLime/earnings-calendar","announcements",split="train")
    cols=[c for c in ["ticker","ticker_confidence","session","first_tradeable_session","announced_at","knowledge_date"] if c in ds.column_names]
    pdf=ds.select_columns(cols).to_pandas()
    pdf["first_tradeable_session"]=pd.to_datetime(pdf["first_tradeable_session"],errors="coerce").dt.date
    pdf["ticker"]=pdf["ticker"].astype("string").str.upper().str.strip()
    pdf=pdf.dropna(subset=["ticker","first_tradeable_session"]).copy()
    pdf=pdf[(pdf["first_tradeable_session"]>=START)&(pdf["first_tradeable_session"]<END)]
    # Use only announcements known before the session open.
    if "session" in pdf.columns:
        pdf=pdf[pdf["session"].isin(["pre_market","after_close","non_session"])].copy()
    if "ticker_confidence" in pdf.columns:
        pdf=pdf[pdf["ticker_confidence"]=="as_of"].copy()
    pdf=pdf[pdf["ticker"].str.match(r"^[A-Z][A-Z0-9.\-]{0,9}$",na=False)]
    pdf=pdf.sort_values(["first_tradeable_session","ticker"]).drop_duplicates(["first_tradeable_session","ticker"])
    return pl.from_pandas(pdf.rename(columns={"first_tradeable_session":"date"})).with_columns(pl.col("date").cast(pl.Date))


def daily_month(path:Path)->pl.DataFrame:
    return orb.aggregate_month(path)


def replay_month(path:Path,candidates:pl.DataFrame)->pd.DataFrame:
    if candidates.is_empty():
        return pd.DataFrame()
    join=candidates.select(["symbol","date","open","first5_high"]).unique()
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
      WHERE CAST(local_ts AS TIME) >= TIME '09:30:00'
        AND CAST(local_ts AS TIME) < TIME '16:00:00'
    )
    SELECT r.symbol,r.date,r.local_ts,r.open,r.high,r.low,r.close,r.volume,c.open AS day_open,c.first5_high
    FROM regular r
    INNER JOIN candidate_days c
      ON r.symbol=c.symbol AND r.date=c.date
    ORDER BY r.symbol,r.date,r.local_ts
    """
    pdf=con.execute(q).df()
    con.close()
    if pdf.empty:
        return pdf

    rows=[]
    for (symbol,date),g0 in pdf.groupby(["symbol","date"],sort=False):
        g=g0.sort_values("local_ts").reset_index(drop=True)
        qv=g["close"].astype(float)*g["volume"].astype(float)
        cumv=g["volume"].astype(float).cumsum().replace(0,np.nan)
        g["vwap"]=(qv.cumsum()/cumv)
        day_open=float(g["day_open"].iloc[0])
        first5_high=float(g["first5_high"].iloc[0])
        start_idx=int((pd.to_datetime(g["local_ts"]).dt.time>=pd.Timestamp("09:35").time()).idxmax())
        if start_idx<=0 or start_idx>=len(g)-1:
            continue

        for pullback in PULLBACKS:
            running_high=max(first5_high,float(g["high"].iloc[:start_idx+1].max()))
            pulled=False
            pullback_low=None
            entry_idx=None
            confirm_idx=None
            for i in range(start_idx,len(g)-1):
                running_high=max(running_high,float(g["high"].iloc[i]))
                close=float(g["close"].iloc[i])
                low=float(g["low"].iloc[i])
                if not pulled and close<=running_high*(1.0-pullback):
                    pulled=True
                    pullback_low=low
                    continue
                if pulled:
                    pullback_low=min(float(pullback_low),low)
                    prev_high=float(g["high"].iloc[i-1])
                    vwap=float(g["vwap"].iloc[i]) if pd.notna(g["vwap"].iloc[i]) else np.nan
                    if close>prev_high and np.isfinite(vwap) and close>vwap and close>day_open:
                        confirm_idx=i
                        entry_idx=i+1
                        break
            if entry_idx is None:
                continue
            entry=float(g["open"].iloc[entry_idx])*(1.0+ENTRY_SLIPPAGE)
            if entry<=0:
                continue
            future=g.iloc[entry_idx:].copy().reset_index(drop=True)
            mfe=float(future["high"].max())/entry-1.0
            mae=1.0-float(future["low"].min())/entry

            for exit_name,target,stop in EXITS:
                tp=entry*(1.0+target)
                sl=max(entry*(1.0-stop),float(pullback_low)*0.997 if pullback_low is not None else entry*(1.0-stop))
                # Ensure risk does not exceed configured hard stop.
                sl=max(sl,entry*(1.0-stop))
                exit_price=float(future["close"].iloc[-1])
                exit_reason="EOD"
                exit_time=future["local_ts"].iloc[-1]
                for _,bar in future.iterrows():
                    if float(bar["low"])<=sl:
                        exit_price=sl; exit_reason="STOP"; exit_time=bar["local_ts"]; break
                    if float(bar["high"])>=tp:
                        exit_price=tp; exit_reason="TARGET"; exit_time=bar["local_ts"]; break
                gross=exit_price/entry-1.0
                rows.append({
                    "date":pd.Timestamp(date).date(),"symbol":str(symbol),"pullbackPct":pullback,
                    "exitConfig":exit_name,"entryPrice":entry,"exitPrice":exit_price,
                    "grossReturn":gross,"netReturn":gross-COST,"MFE":mfe,"MAE":mae,
                    "confirmTime":str(g["local_ts"].iloc[confirm_idx]),"entryTime":str(g["local_ts"].iloc[entry_idx]),
                    "exitTime":str(exit_time),"exitReason":exit_reason,
                })
    return pd.DataFrame(rows)


def stream(events:pl.DataFrame):
    daily_frames=[]
    outcomes=[]
    history=None
    base_cols=["symbol","date","open","close","volume","dollar_volume","first5_high","first5_low","first5_close","first5_volume"]
    by_month={}
    e=events.with_columns(pl.col("date").dt.strftime("%Y-%m").alias("month"))
    for key,frame in e.partition_by("month",as_dict=True).items():
        by_month[key[0] if isinstance(key,tuple) else key]=frame

    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for idx,month in enumerate(census._month_iter(census.START,census.END_EXCLUSIVE),1):
            ms=month.strftime("%Y-%m")
            path=root/f"ohlcv_{ms}.parquet"
            census._download_us_month(month,path)
            month_base=daily_month(path).select(base_cols).sort(["symbol","date"])
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
            month_start=month.date()
            month_end=(month+pd.offsets.MonthBegin(1)).date()
            current=feat.filter((pl.col("date")>=pl.lit(month_start))&(pl.col("date")<pl.lit(month_end)))
            ev=by_month.get(ms)
            if ev is not None and not ev.is_empty():
                cand=(current.join(ev.select([pl.col("ticker").alias("symbol"),"date"]),on=["symbol","date"],how="inner")
                      .filter(
                         pl.col("gap").is_not_null()&pl.col("first5Rvol").is_not_null()&
                         (pl.col("open")>=2.0)&(pl.col("priorDollar20")>=5_000_000)&
                         (pl.col("gap")>=min(GAPS))&(pl.col("gap")<=0.30)&
                         (pl.col("first5Rvol")>=min(FIRST5_RVOLS))&
                         (pl.col("first5Return")>=min(FIRST5_RETURNS))
                      ))
                if cand.height:
                    o=replay_month(path,cand)
                    if not o.empty:
                        outcomes.append(o)
                    daily_frames.append(cand)
                print(json.dumps({"month":ms,"eventRows":ev.height,"candidateDays":cand.height if 'cand' in locals() else 0,"outcomes":0 if not outcomes else sum(len(x) for x in outcomes)}),flush=True)
            history=(combined.sort(["symbol","date"]).group_by("symbol",maintain_order=True).tail(25).select(base_cols))
            path.unlink(missing_ok=True)
    if not daily_frames:
        raise RuntimeError("NO_EARNINGS_CANDIDATES")
    daily=pl.concat(daily_frames,how="vertical").unique(["symbol","date"])
    out=pd.concat(outcomes,ignore_index=True) if outcomes else pd.DataFrame()
    if out.empty:
        raise RuntimeError("NO_EARNINGS_PULLBACK_OUTCOMES")
    return daily,out


def gate(m,min_trades):
    checks={
      "positiveReturn":float(m.get("totalReturn") or 0)>0,
      "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
      "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,
      "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
      "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def to_pl(pdf):
    if pdf.empty:
        return pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    return pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))


def metrics(pdf,start,end):
    dates=[d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="B")]
    return v1.metrics(to_pl(pdf),"US_STOCK",dates)


def rank_key(m,name):
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 1),name)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    events=load_events()
    daily,outcomes=stream(events)
    dpdf=daily.to_pandas()
    dmap=dpdf.set_index(["date","symbol"])

    reports={}; grid=[]
    for gap in GAPS:
        for rv in FIRST5_RVOLS:
            for f5 in FIRST5_RETURNS:
                eligible=dpdf[(dpdf["gap"]>=gap)&(dpdf["gap"]<=0.30)&(dpdf["first5Rvol"]>=rv)&(dpdf["first5Return"]>=f5)][["date","symbol"]]
                keys=set(map(tuple,eligible.to_records(index=False)))
                base_out=outcomes[outcomes.apply(lambda r:(r["date"],r["symbol"]) in keys,axis=1)].copy()
                for pullback in PULLBACKS:
                    for exit_name,_,_ in EXITS:
                        name=f"EARN_G{int(gap*100)}_RV{rv:g}_F5{int(f5*100)}_PB{pullback*100:.1f}_{exit_name}"
                        t=base_out[(base_out["pullbackPct"]==pullback)&(base_out["exitConfig"]==exit_name)].copy()
                        mt=metrics(t[t["date"]<TRAIN_END],"2023-04-01",str(TRAIN_END))
                        mc=metrics(t[(t["date"]>=TRAIN_END)&(t["date"]<CAL_END)],str(TRAIN_END),str(CAL_END))
                        mv=metrics(t[(t["date"]>=CAL_END)&(t["date"]<END)],str(CAL_END),str(END))
                        gt,gc,gv=gate(mt,30),gate(mc,10),gate(mv,15)
                        elig=gt["pass"] and gc["pass"]
                        reports[name]={"train":mt,"calibration":mc,"validation":mv,"trainGate":gt,"calibrationGate":gc,"validationGate":gv,"eligible":elig}
                        grid.append({
                          "candidate":name,"gap":gap,"first5Rvol":rv,"first5Return":f5,"pullback":pullback,"exit":exit_name,
                          "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                          "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
                          "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                        })

    eligible=[n for n,d in reports.items() if d["eligible"]]
    passes=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    winner=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if winner:
        # Recreate winner ledger from encoded parameters is unnecessary for first-pass; grid is SSOT.
        pass
    summary={
      "schemaVersion":1,"contract":"us-earnings-first-pullback-v1",
      "eventRows":events.height,"eventCandidateDays":daily.height,"outcomeRows":len(outcomes),
      "candidateCount":len(reports),"eligibleAfterCalibrationCount":len(eligible),
      "validationPassCount":len(passes),"validationPassCandidates":passes,
      "selectedByCalibration":winner,"selectedResults":reports.get(winner) if winner else None,
      "truthBoundary":{
        "eventSource":"ZipLime/earnings-calendar announcements",
        "onlyPreMarketAfterCloseNonSessionAnnouncements":True,
        "tickerConfidenceAsOfOnly":True,
        "firstTradeableSessionUsed":True,
        "sueNotUsedForSignal":True,
        "gapKnownAtOpenAndEntryOccursAfterFirstPullback":True,
        "pullbackAndReclaimUseCompletedOneMinuteBars":True,
        "entryNextMinuteOpen":True,
        "stopFirstConservative":True,
        "validationExcludedFromSelection":True,
        "profitabilityProven":False,
        "executionAuthority":"NONE",
      },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
