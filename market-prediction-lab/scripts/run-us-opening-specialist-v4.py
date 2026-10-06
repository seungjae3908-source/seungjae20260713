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

TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()
GAP_UP=(0.02,0.04)
GAP_DOWN=(-0.03,-0.05)
RVOLS=(1.5,2.5)
F5_RET=(0.005,0.015)
TOP_NS=(5,10,20)
TARGETS=(0.03,0.05)
STOPS=(0.015,0.025)
HOLDS=(60,120,240)
COST=0.002
ENTRY_SLIPPAGE=0.0005


def build_current_features(combined:pl.DataFrame,month_start,month_end):
    feat=combined.with_columns([
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("dollar_volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorDollar20"),
        pl.col("first5_volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorFirst5Vol20"),
    ]).with_columns([
        (pl.col("open")/pl.col("prev_close")-1.0).alias("gap"),
        (pl.col("first5_volume")/pl.col("priorFirst5Vol20")).alias("first5Rvol"),
        (pl.col("first5_close")/pl.col("open")-1.0).alias("first5Return"),
        ((pl.col("first5_high")-pl.col("first5_low"))/pl.col("open")).alias("first5RangePct"),
        ((pl.col("first5_close")-pl.col("first5_low"))/(pl.col("first5_high")-pl.col("first5_low")).replace(0,None)).alias("first5CloseLoc"),
    ])
    return feat.filter(
        (pl.col("date")>=pl.lit(month_start))
        &(pl.col("date")<pl.lit(month_end))
        &pl.col("gap").is_not_null()
        &pl.col("first5Rvol").is_not_null()
        &pl.col("first5Return").is_not_null()
        &(pl.col("open")>=2.0)
        &(pl.col("priorDollar20")>=5_000_000)
    )


def broad_candidates(current:pl.DataFrame):
    return current.filter(
        (
            ((pl.col("gap")>=0.015)&(pl.col("gap")<=0.30)&(pl.col("first5Rvol")>=1.2)&(pl.col("first5Return")>=0.0))
            |
            ((pl.col("gap")<=-0.02)&(pl.col("gap")>=-0.30)&(pl.col("first5Rvol")>=1.2)&(pl.col("first5Return")>=0.003))
        )
    )


def raw_month(path:Path,cand:pl.DataFrame):
    if cand.is_empty():
        return pd.DataFrame()
    join=cand.select(["symbol","date"]).unique()
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
    SELECT r.*
    FROM regular r
    INNER JOIN candidate_days c ON r.symbol=c.symbol AND r.date=c.date
    ORDER BY r.symbol,r.date,r.local_ts
    """
    pdf=con.execute(q).df()
    con.close()
    return pdf


def detect_event(g:pd.DataFrame,event_type:str):
    g=g.sort_values("local_ts").reset_index(drop=True).copy()
    if len(g)<8:return None
    g["cumPV"]=(g["close"]*g["volume"]).cumsum()
    g["cumV"]=g["volume"].cumsum()
    g["vwap"]=g["cumPV"]/g["cumV"].replace(0,np.nan)
    after=g[g["local_time"].astype(str)>="09:35:00"].copy()
    if after.empty:return None
    first5=g[g["local_time"].astype(str)<"09:35:00"]
    if first5.empty:return None
    f5h=float(first5["high"].max()); f5l=float(first5["low"].min())

    if event_type=="GAPDOWN_RECLAIM":
        for i in after.index:
            if i+1>=len(g):break
            if float(g["close"].iloc[i])>f5h*1.0005 and float(g["close"].iloc[i])>float(g["vwap"].iloc[i]):
                return i+1,{"triggerIndex":int(i),"triggerTime":str(g["local_ts"].iloc[i]),"pullbackDepth":None}
        return None

    if event_type=="OPEN_DRIVE":
        for i in after.index:
            if i+1>=len(g):break
            if float(g["close"].iloc[i])>f5h*1.0005 and float(g["close"].iloc[i])>float(g["vwap"].iloc[i]):
                return i+1,{"triggerIndex":int(i),"triggerTime":str(g["local_ts"].iloc[i]),"pullbackDepth":0.0}
        return None

    pb=float(event_type.split("_")[-1])/10000.0
    running_high=f5h
    armed=False
    max_dd=0.0
    for i in after.index:
        if i+1>=len(g):break
        running_high=max(running_high,float(g["high"].iloc[i]))
        dd=1.0-float(g["close"].iloc[i])/running_high if running_high>0 else 0.0
        max_dd=max(max_dd,dd)
        if dd>=pb:
            armed=True
        if not armed or i<3:
            continue
        prev3=float(g["high"].iloc[i-3:i].max())
        if float(g["close"].iloc[i])>prev3 and float(g["close"].iloc[i])>float(g["vwap"].iloc[i]):
            return i+1,{"triggerIndex":int(i),"triggerTime":str(g["local_ts"].iloc[i]),"pullbackDepth":max_dd}
    return None


def simulate(g:pd.DataFrame,entry_i:int,target:float,stop:float,hold:int):
    end_i=min(len(g)-1,entry_i+hold-1)
    if entry_i>=len(g):return None
    entry=float(g["open"].iloc[entry_i])*(1.0+ENTRY_SLIPPAGE)
    if entry<=0:return None
    future=g.iloc[entry_i:end_i+1]
    tp=entry*(1+target);sl=entry*(1-stop)
    exit_i=end_i;exit_px=float(g["close"].iloc[end_i]);reason="TIME"
    for j in range(entry_i,end_i+1):
        if float(g["low"].iloc[j])<=sl:
            exit_i=j;exit_px=sl;reason="STOP";break
        if float(g["high"].iloc[j])>=tp:
            exit_i=j;exit_px=tp;reason="TARGET";break
    gross=exit_px/entry-1.0
    return {
        "entryPrice":entry,"exitPrice":exit_px,"grossReturn":gross,"roundTripCost":COST,"netReturn":gross-COST,
        "MFE":float(future["high"].max())/entry-1.0,"MAE":1.0-float(future["low"].min())/entry,
        "entryTime":str(g["local_ts"].iloc[entry_i]),"exitTime":str(g["local_ts"].iloc[exit_i]),"exitReason":reason,
    }


def stream_events():
    base_cols=["symbol","date","open","close","volume","dollar_volume","first5_high","first5_low","first5_close","first5_volume"]
    history=None
    daily_frames=[]
    event_rows=[]
    outcome_rows=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for idx,month in enumerate(census._month_iter(census.START,census.END_EXCLUSIVE),1):
            path=root/f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            census._download_us_month(month,path)
            month_base=orb.aggregate_month(path).select(base_cols).sort(["symbol","date"])
            combined=month_base if history is None or history.is_empty() else pl.concat([history,month_base],how="vertical").sort(["symbol","date"])
            month_start=month.date();month_end=(month+pd.offsets.MonthBegin(1)).date()
            current=build_current_features(combined,month_start,month_end)
            if current.height:
                daily_frames.append(current)
                broad=broad_candidates(current)
            else:
                broad=current
            raw=raw_month(path,broad) if broad.height else pd.DataFrame()
            # Normalize the Polars/DuckDB date keys to datetime.date before lookup.
            # DuckDB returns pandas Timestamp/date-like values while Polars to_dicts()
            # returns datetime.date. Without normalization every intraday group misses.
            dmap={(str(r["symbol"]),pd.Timestamp(r["date"]).date()):r for r in broad.to_dicts()}
            raw_groups=0
            matched_meta=0
            if not raw.empty:
                for (sym,date),g in raw.groupby(["symbol","date"],sort=False):
                    raw_groups+=1
                    norm_date=pd.Timestamp(date).date()
                    meta=dmap.get((str(sym),norm_date))
                    if meta is None:
                        continue
                    matched_meta+=1
                    types=[]
                    if float(meta["gap"])>=0.015:
                        types=["OPEN_DRIVE","GAPUP_PB_75","GAPUP_PB_150"]
                    elif float(meta["gap"])<=-0.02:
                        types=["GAPDOWN_RECLAIM"]
                    for typ in types:
                        det=detect_event(g,typ)
                        if det is None:continue
                        entry_i,extra=det
                        eid=f"{sym}|{norm_date}|{typ}"
                        event_rows.append({
                            "eventId":eid,"symbol":str(sym),"date":norm_date,"eventType":typ,
                            "gap":float(meta["gap"]),"first5Rvol":float(meta["first5Rvol"]),
                            "first5Return":float(meta["first5Return"]),"first5RangePct":float(meta["first5RangePct"]),
                            "first5CloseLoc":float(meta["first5CloseLoc"]),"priorDollar20":float(meta["priorDollar20"]),
                            **extra,
                        })
                        sorted_g=g.sort_values("local_ts").reset_index(drop=True)
                        for target in TARGETS:
                            for stop in STOPS:
                                for hold in HOLDS:
                                    res=simulate(sorted_g,entry_i,target,stop,hold)
                                    if res is None:
                                        continue
                                    outcome_rows.append({
                                        "eventId":eid,"target":target,"stop":stop,"holdMinutes":hold,**res,
                                    })
            history=(combined.sort(["symbol","date"]).group_by("symbol",maintain_order=True).tail(25).select(base_cols))
            print(json.dumps({"usSpecialistMonth":month.strftime("%Y-%m"),"dailyRows":current.height,"broadDays":broad.height,"rawIntradayGroups":raw_groups,"matchedMetaGroups":matched_meta,"eventsTotal":len(event_rows),"monthIndex":idx}),flush=True)
            path.unlink(missing_ok=True)
    if not daily_frames or not event_rows or not outcome_rows:
        raise RuntimeError("US_SPECIALIST_NO_EVENTS")
    daily=pl.concat(daily_frames,how="vertical").sort(["date","symbol"])
    return daily,event_rows,outcome_rows


def rank_events(df:pd.DataFrame,top_n:int):
    y=df.copy()
    y["r1"]=y.groupby("date")["gap"].rank(method="average",ascending=False)
    y["r2"]=y.groupby("date")["first5Rvol"].rank(method="average",ascending=False)
    y["r3"]=y.groupby("date")["first5Return"].rank(method="average",ascending=False)
    y["r4"]=y.groupby("date")["priorDollar20"].rank(method="average",ascending=False)
    y["score"]=-(y["r1"]+y["r2"]+y["r3"]+0.5*y["r4"])
    return y.sort_values(["date","score","symbol"],ascending=[True,False,True]).groupby("date",group_keys=False).head(top_n)


def calc(pdf,start,end,all_dates):
    if pdf.empty:
        x=pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    else:
        x=pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))
    dates=[d for d in all_dates if start<=d<end]
    sub=x.filter((pl.col("date")>=pl.lit(start))&(pl.col("date")<pl.lit(end)))
    return v1.metrics(sub,"US_STOCK",dates)


def gate(m,min_trades):
    checks={"positiveReturn":float(m.get("totalReturn") or 0)>0,"profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
            "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,"mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
            "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades}
    return {"pass":all(checks.values()),"checks":checks}


def rank_key(m,name):
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 1),name)


def main():
    ap=argparse.ArgumentParser();ap.add_argument("--out-dir",required=True);args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    daily,events,outcomes=stream_events()
    all_dates=daily.select("date").unique().sort("date").get_column("date").to_list()

    meta=pd.DataFrame(events)
    outcome_df=pd.DataFrame(outcomes)
    reports={};grid=[];ledgers={}
    configs=[]
    for typ in sorted(meta["eventType"].unique()):
        gaps=GAP_DOWN if typ=="GAPDOWN_RECLAIM" else GAP_UP
        for gap in gaps:
            for rv in RVOLS:
                for f5 in F5_RET:
                    for top_n in TOP_NS:
                        configs.append((typ,gap,rv,f5,top_n))

    for typ,gap,rv,f5,top_n in configs:
        x=meta[meta["eventType"]==typ].copy()
        if typ=="GAPDOWN_RECLAIM":
            x=x[(x["gap"]<=gap)&(x["first5Rvol"]>=rv)&(x["first5Return"]>=f5)]
        else:
            x=x[(x["gap"]>=gap)&(x["first5Rvol"]>=rv)&(x["first5Return"]>=f5)]
        if x.empty:continue
        selected=rank_events(x,top_n)
        for target in TARGETS:
            for stop in STOPS:
                for hold in HOLDS:
                    name=f"US_{typ}_G{gap:+.2f}_RV{rv:g}_F5{f5:.3f}_TOP{top_n}_TP{int(target*100)}_SL{stop:g}_H{hold}"
                    selected_ids=selected[[
                        "eventId","date","symbol","eventType","gap","first5Rvol","first5Return",
                        "first5CloseLoc","priorDollar20","triggerTime","pullbackDepth"
                    ]].copy()
                    oc=outcome_df[
                        (outcome_df["target"]==target)
                        &(outcome_df["stop"]==stop)
                        &(outcome_df["holdMinutes"]==hold)
                    ].copy()
                    pdf=selected_ids.merge(oc,on="eventId",how="inner",validate="one_to_one")
                    if len(pdf):
                        pdf["market"]="US_STOCK"
                        pdf["direction"]="LONG"
                        pdf["candidate"]=name
                    mt=calc(pdf,all_dates[0],TRAIN_END,all_dates);mc=calc(pdf,TRAIN_END,CAL_END,all_dates);mv=calc(pdf,CAL_END,VAL_END,all_dates)
                    gt,gc,gv=gate(mt,50),gate(mc,15),gate(mv,25)
                    eligible=gt["pass"] and gc["pass"]
                    reports[name]={"eventType":typ,"train":mt,"calibration":mc,"validation":mv,"trainGate":gt,"calibrationGate":gc,"validationGate":gv,"eligibleAfterCalibration":eligible}
                    if eligible:ledgers[name]=pdf
                    grid.append({
                        "candidate":name,"eventType":typ,"gapThreshold":gap,"rvolMin":rv,"first5ReturnMin":f5,"topN":top_n,"target":target,"stop":stop,"holdMinutes":hold,
                        "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainTrades":mt.get("tradeCount"),
                        "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationTrades":mc.get("tradeCount"),
                        "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                    })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    passes=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)
    summary={
        "schemaVersion":1,"contract":"us-opening-specialist-v4",
        "fullUniverseDailyRows":daily.height,"fullUniverseSymbols":daily.select("symbol").unique().height,
        "broadIntradayEvents":len(events),"precomputedOutcomeRows":len(outcomes),"candidateCount":len(reports),"eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(passes),"validationPassCandidates":passes,
        "selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "allTradableSymbolsScannedMonthly":True,
            "intradayReplayResolution":"1m",
            "entryAfterCompletedTriggerMinute":True,
            "entryNextMinuteOpenWithSlippage":True,
            "stopFirstConservativeWithinMinute":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "freshPost2026MarchIntradayOosAvailable":False,
            "intradayPathsCompressedToOutcomeGridAtDetection":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
