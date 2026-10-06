#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import pandas as pd
import polars as pl

ROOT=Path(__file__).resolve().parents[2]
ORB_PATH=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-us-orb-v3.py"
SPEC=importlib.util.spec_from_file_location("us_orb_v3",ORB_PATH)
if SPEC is None or SPEC.loader is None: raise RuntimeError("ORB_V3_IMPORT_FAILED")
orb=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(orb)

def month_ts(month:str):
    return pd.Timestamp(month+"-01",tz="UTC")

def cmd_aggregate(args):
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        src=Path(td)/f"ohlcv_{args.month}.parquet"
        orb.census._download_us_month(month_ts(args.month),src)
        frame=orb.aggregate_month(src)
    if frame.is_empty(): raise RuntimeError(f"US_ORB_EMPTY_AGGREGATE:{args.month}")
    frame.write_parquet(out/f"daily-{args.month}.parquet",compression="zstd")
    print(json.dumps({"AGGREGATE_OK":args.month,"rows":frame.height,"symbols":frame.select("symbol").n_unique()}))

def compute_features(daily:pl.DataFrame)->pl.DataFrame:
    x=daily.sort(["symbol","date"])
    x=x.with_columns([
        pl.col("close").shift(1).over("symbol").alias("prev_close"),
        pl.col("dollar_volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorDollar20"),
        pl.col("first5_volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorFirst5Vol20"),
    ])
    x=x.with_columns([
        (pl.col("open")/pl.col("prev_close")-1).alias("gap"),
        (pl.col("first5_volume")/pl.col("priorFirst5Vol20")).alias("first5Rvol"),
        (pl.col("first5_close")/pl.col("open")-1).alias("first5Return"),
        ((pl.col("first5_high")-pl.col("first5_low"))/pl.col("open")).alias("first5RangePct"),
    ])
    return x.filter(
        pl.col("gap").is_not_null()&pl.col("first5Rvol").is_not_null()&pl.col("first5Return").is_not_null()
        &(pl.col("open")>=2.0)&(pl.col("priorDollar20")>=10_000_000)
    )

def cmd_candidates(args):
    root=Path(args.input_root); out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    files=sorted(root.glob("**/daily-*.parquet"))
    if len(files)!=36: raise RuntimeError(f"US_ORB_DAILY_MONTHS_REQUIRED_36:{len(files)}")
    daily=pl.concat([pl.read_parquet(f) for f in files],how="vertical")
    feat=compute_features(daily)
    broad=orb.broad_candidates(feat)
    broad.write_parquet(out/"broad-candidates.parquet",compression="zstd")
    feat.select("date").unique().sort("date").write_csv(out/"market-dates.csv")
    print(json.dumps({"CANDIDATE_MAP_OK":True,"tradableRows":feat.height,"broadCandidateRows":broad.height,"marketDates":feat.select("date").n_unique()}))

def empty_outcomes():
    return pd.DataFrame(columns=["date","symbol","targetPct","stopPct","entryPrice","exitPrice","grossReturn","netReturn","MFE","MAE","triggerTime","entryTime","exitTime","exitReason"])

def cmd_replay(args):
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    cand=pl.read_parquet(args.candidate_file).filter(pl.col("month")==args.month)
    if cand.is_empty():
        empty_outcomes().to_csv(out/f"outcomes-{args.month}.csv",index=False)
        print(json.dumps({"REPLAY_OK":args.month,"candidateDays":0,"outcomes":0}))
        return
    with tempfile.TemporaryDirectory() as td:
        src=Path(td)/f"ohlcv_{args.month}.parquet"
        orb.census._download_us_month(month_ts(args.month),src)
        rows=orb.replay_month(src,cand)
    pdf=pd.DataFrame(rows) if rows else empty_outcomes()
    pdf.to_csv(out/f"outcomes-{args.month}.csv",index=False)
    print(json.dumps({"REPLAY_OK":args.month,"candidateDays":cand.height,"outcomes":len(pdf)}))

def gate(m,mintrades):
    checks={"positiveReturn":float(m.get("totalReturn") or 0)>0,"profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
            "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,"mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
            "minimumTrades":int(m.get("tradeCount") or 0)>=mintrades}
    return {"pass":all(checks.values()),"checks":checks}

def rank_key(m,name):
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 0),int(m.get("tradeCount") or 0),name)

def cmd_combine(args):
    root=Path(args.input_root); cdir=Path(args.candidate_dir); out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    cand=pl.read_parquet(cdir/"broad-candidates.parquet")
    dates_df=pl.read_csv(cdir/"market-dates.csv",try_parse_dates=True)
    all_dates=dates_df.get_column("date").to_list()
    files=sorted(root.glob("**/outcomes-*.csv"))
    if len(files)!=36: raise RuntimeError(f"US_ORB_OUTCOME_MONTHS_REQUIRED_36:{len(files)}")
    parts=[]
    for f in files:
        p=pd.read_csv(f)
        if not p.empty: parts.append(p)
    if not parts: raise RuntimeError("US_ORB_NO_OUTCOMES")
    opdf=pd.concat(parts,ignore_index=True)
    opdf["date"]=pd.to_datetime(opdf["date"]).dt.date
    outcomes=pl.from_pandas(opdf).with_columns(pl.col("date").cast(pl.Date))

    train_dates=[d for d in all_dates if d<orb.TRAIN_END]
    valid_dates=[d for d in all_dates if orb.TRAIN_END<=d<orb.VALID_END]
    bench_dates=[d for d in all_dates if orb.VALID_END<=d<orb.END]
    grid=[]; reports={}
    for gap in orb.GAPS:
      for rv in orb.FIRST5_RVOLS:
       for strength in orb.FIRST5_RETURNS:
        base=cand.filter((pl.col("gap")>=gap)&(pl.col("gap")<=0.30)&(pl.col("first5Rvol")>=rv)&(pl.col("first5Return")>=strength))
        for topn in orb.TOP_NS:
         sel=orb.rank_daily(base,topn)
         for target in orb.TARGETS:
          for stop in orb.STOPS:
           name=f"US_ORB_G{int(gap*100)}_RV{rv:g}_F5{int(strength*100)}_TOP{topn}_TP{int(target*100)}_SL{int(stop*1000)/10:g}"
           oc=outcomes.filter((pl.col("targetPct")==target)&(pl.col("stopPct")==stop))
           tr=sel.join(oc,on=["date","symbol"],how="inner").with_columns([
             pl.lit("US_STOCK").alias("market"),pl.lit("LONG").alias("direction"),pl.lit(name).alias("candidate"),pl.lit(orb.COST).alias("roundTripCost")
           ])
           train=tr.filter(pl.col("date")<pl.lit(orb.TRAIN_END))
           valid=tr.filter((pl.col("date")>=pl.lit(orb.TRAIN_END))&(pl.col("date")<pl.lit(orb.VALID_END)))
           bench=tr.filter((pl.col("date")>=pl.lit(orb.VALID_END))&(pl.col("date")<pl.lit(orb.END)))
           mt=orb.v1.metrics(train,"US_STOCK",train_dates); mv=orb.v1.metrics(valid,"US_STOCK",valid_dates); mb=orb.v1.metrics(bench,"US_STOCK",bench_dates)
           gt,gv=gate(mt,40),gate(mv,15)
           reports[name]={"trades":tr,"train":mt,"validation":mv,"benchmark":mb,"trainGate":gt,"validationGate":gv}
           grid.append({"candidate":name,"trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
             "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
             "benchmarkReturn":mb.get("totalReturn"),"benchmarkPF":mb.get("profitFactor"),"benchmarkMDD":mb.get("mdd"),"benchmarkPosMonthRate":mb.get("positiveMonthRate"),"benchmarkTrades":mb.get("tradeCount")})
    trainpass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    validpass=[n for n in trainpass if reports[n]["validationGate"]["pass"]]
    winner=sorted(validpass,key=lambda n:rank_key(reports[n]["validation"],n),reverse=True)[0] if validpass else None
    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    summary={"schemaVersion":1,"contract":"full-universe-3pct-hunter-us-orb-v31","candidateCount":len(grid),"broadCandidateRows":cand.height,
      "trainPassCount":len(trainpass),"validationPassCount":len(validpass),"winner":winner,
      "periods":{"train":["2023-04-01",str(orb.TRAIN_END)],"validation":[str(orb.TRAIN_END),str(orb.VALID_END)],"benchmarkReusedObservedDataset":[str(orb.VALID_END),str(orb.END)]},
      "truthBoundary":{"entryAfterFiveMinuteWindow":True,"breakoutConfirmedOnOneMinuteClose":True,"entryNextMinuteOpen":True,"minuteOrderUsedAfterEntry":True,
        "freshPost2026MarchIntradayOosAvailable":False,"benchmarkLastYearPreviouslyObservedInEarlierResearch":True,"profitabilityProven":False,"executionAuthority":"NONE"}}
    if winner:
      d=reports[winner]; summary["winnerResults"]={"train":d["train"],"trainGate":d["trainGate"],"validation":d["validation"],"validationGate":d["validationGate"],"benchmark":d["benchmark"]}
      cols=["market","date","symbol","direction","candidate","entryPrice","exitPrice","grossReturn","roundTripCost","netReturn","MFE","MAE","triggerTime","entryTime","exitTime","exitReason","gap","first5Rvol","first5Return","first5RangePct","priorDollar20"]
      d["trades"].select(cols).write_csv(out/"winner-ledger.csv")
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

def main():
    ap=argparse.ArgumentParser()
    sub=ap.add_subparsers(dest="cmd",required=True)
    a=sub.add_parser("aggregate"); a.add_argument("--month",required=True); a.add_argument("--out-dir",required=True)
    c=sub.add_parser("candidates"); c.add_argument("--input-root",required=True); c.add_argument("--out-dir",required=True)
    r=sub.add_parser("replay"); r.add_argument("--month",required=True); r.add_argument("--candidate-file",required=True); r.add_argument("--out-dir",required=True)
    z=sub.add_parser("combine"); z.add_argument("--input-root",required=True); z.add_argument("--candidate-dir",required=True); z.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    {"aggregate":cmd_aggregate,"candidates":cmd_candidates,"replay":cmd_replay,"combine":cmd_combine}[args.cmd](args)

if __name__=="__main__": main()
