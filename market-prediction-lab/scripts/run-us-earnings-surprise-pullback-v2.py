#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

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
base=load_module("us_earnings_v1","market-prediction-lab/scripts/run-us-earnings-first-pullback-v1.py")

TRAIN_END=base.TRAIN_END
CAL_END=base.CAL_END
END=base.END
GAPS=(0.02,0.04)
FIRST5_RVOLS=(1.2,2.0)
FIRST5_RETURNS=(0.00,0.01)
PULLBACKS=base.PULLBACKS
EXIT_NAMES=tuple(x[0] for x in base.EXITS)

SURPRISES={
    "SUE1":lambda x:(x["sue"]>=1.0),
    "SUE2":lambda x:(x["sue"]>=2.0),
    "SUE3":lambda x:(x["sue"]>=3.0),
    "REV1":lambda x:(x["revenue_sue"]>=1.0),
    "REV2":lambda x:(x["revenue_sue"]>=2.0),
    "BOTH1":lambda x:(x["sue"]>=1.0)&(x["revenue_sue"]>=1.0),
    "EITHER2":lambda x:(x[["sue","revenue_sue"]].max(axis=1)>=2.0),
}


def load_pit_events():
    ds=load_dataset("ZipLime/earnings-calendar","pit",split="train")
    wanted=[
      "ticker","ticker_confidence","session","first_tradeable_session",
      "knowledge_date","sue","revenue_sue","eps_quality"
    ]
    cols=[c for c in wanted if c in ds.column_names]
    pdf=ds.select_columns(cols).to_pandas()
    required={"ticker","session","first_tradeable_session","sue","revenue_sue"}
    missing=required-set(pdf.columns)
    if missing:
        raise RuntimeError(f"PIT_COLUMNS_MISSING:{sorted(missing)}")
    pdf["date"]=pd.to_datetime(pdf["first_tradeable_session"],errors="coerce").dt.date
    pdf["ticker"]=pdf["ticker"].astype("string").str.upper().str.strip()
    pdf["sue"]=pd.to_numeric(pdf["sue"],errors="coerce")
    pdf["revenue_sue"]=pd.to_numeric(pdf["revenue_sue"],errors="coerce")
    pdf=pdf.dropna(subset=["ticker","date"]).copy()
    pdf=pdf[(pdf["date"]>=base.START)&(pdf["date"]<base.END)]
    pdf=pdf[pdf["session"].isin(["pre_market","after_close","non_session"])].copy()
    if "ticker_confidence" in pdf.columns:
        pdf=pdf[pdf["ticker_confidence"]=="as_of"].copy()
    if "eps_quality" in pdf.columns:
        pdf=pdf[pdf["eps_quality"].fillna("ok")!="implausible"].copy()
    pdf=pdf[pdf["ticker"].str.match(r"^[A-Z][A-Z0-9.\-]{0,9}$",na=False)]
    # Multiple filings for one ticker/session: keep strongest point-in-time positive surprise values.
    agg=pdf.groupby(["date","ticker"],as_index=False).agg({
      "sue":"max","revenue_sue":"max"
    })
    return agg


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
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 1),int(m.get("tradeCount") or 0),name)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    events=load_pit_events()
    stream_events=pl.from_pandas(events[["date","ticker"]]).with_columns(pl.col("date").cast(pl.Date))
    daily,outcomes=base.stream(stream_events)

    # Attach point-in-time surprise features to every 1m replay outcome.
    outcomes=outcomes.merge(events,on=["date","ticker"] if "ticker" in outcomes.columns else ["date"],how="left") if False else outcomes
    # base outcomes use symbol; event table uses ticker.
    ev=events.rename(columns={"ticker":"symbol"}).copy()
    ev["date"]=pd.to_datetime(ev["date"],errors="coerce").dt.date
    outcomes=outcomes.copy()
    outcomes["date"]=pd.to_datetime(outcomes["date"],errors="coerce").dt.date
    dpdf=daily.to_pandas()
    dpdf["date"]=pd.to_datetime(dpdf["date"],errors="coerce").dt.date
    outcomes=outcomes.merge(ev,on=["date","symbol"],how="inner",validate="many_to_one")
    dpdf=dpdf.merge(ev,on=["date","symbol"],how="inner",validate="many_to_one")

    reports={}; grid=[]
    for surprise_name,fn in SURPRISES.items():
      event_mask=fn(dpdf).fillna(False)
      surprise_days=dpdf.loc[event_mask].copy()
      for gap in GAPS:
       for rv in FIRST5_RVOLS:
        for f5 in FIRST5_RETURNS:
         eligible=surprise_days[
           (surprise_days["gap"]>=gap)&(surprise_days["gap"]<=0.30)&
           (surprise_days["first5Rvol"]>=rv)&(surprise_days["first5Return"]>=f5)
         ][["date","symbol"]].drop_duplicates()
         if eligible.empty:
            continue
         keys=pd.MultiIndex.from_frame(eligible)
         om=pd.MultiIndex.from_frame(outcomes[["date","symbol"]])
         base_out=outcomes[om.isin(keys)].copy()
         for pullback in PULLBACKS:
          for exit_name in EXIT_NAMES:
           name=f"{surprise_name}_G{int(gap*100)}_RV{rv:g}_F5{int(f5*100)}_PB{pullback*100:.1f}_{exit_name}"
           t=base_out[(base_out["pullbackPct"]==pullback)&(base_out["exitConfig"]==exit_name)].copy()
           mt=metrics(t[t["date"]<TRAIN_END],"2023-04-01",str(TRAIN_END))
           mc=metrics(t[(t["date"]>=TRAIN_END)&(t["date"]<CAL_END)],str(TRAIN_END),str(CAL_END))
           mv=metrics(t[(t["date"]>=CAL_END)&(t["date"]<END)],str(CAL_END),str(END))
           gt,gc,gv=gate(mt,20),gate(mc,8),gate(mv,10)
           elig=gt["pass"] and gc["pass"]
           reports[name]={"surprise":surprise_name,"train":mt,"calibration":mc,"validation":mv,"trainGate":gt,"calibrationGate":gc,"validationGate":gv,"eligible":elig}
           grid.append({
             "candidate":name,"surprise":surprise_name,"gap":gap,"first5Rvol":rv,"first5Return":f5,"pullback":pullback,"exit":exit_name,
             "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
             "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationTrades":mc.get("tradeCount"),
             "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
           })

    eligible=[n for n,d in reports.items() if d["eligible"]]
    passes=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    winner=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None
    pdf=pd.DataFrame(grid)
    pdf.to_csv(out/"candidate-grid.csv",index=False)
    if not pdf.empty:
        pdf.sort_values(["calibrationPass","calibrationReturn","calibrationPF"],ascending=[False,False,False]).head(40).to_csv(out/"top40-calibration.csv",index=False)
    summary={
      "schemaVersion":1,"contract":"us-earnings-surprise-pullback-v2",
      "pitEventRows":len(events),"eventCandidateDays":daily.height,"outcomeRows":len(outcomes),
      "candidateCount":len(reports),"eligibleAfterCalibrationCount":len(eligible),
      "validationPassCount":len(passes),"validationPassCandidates":passes,
      "selectedByCalibration":winner,"selectedResults":reports.get(winner) if winner else None,
      "truthBoundary":{
        "eventSource":"ZipLime/earnings-calendar pit",
        "sueAndRevenueSuePointInTime":True,
        "onlyPositiveSurpriseLongsTested":True,
        "onlyPreMarketAfterCloseNonSessionAnnouncements":True,
        "tickerConfidenceAsOfOnly":True,
        "firstTradeableSessionUsed":True,
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
