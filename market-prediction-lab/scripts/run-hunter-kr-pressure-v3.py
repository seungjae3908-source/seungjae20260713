#!/usr/bin/env python3
from __future__ import annotations
import argparse, importlib.util, json
from pathlib import Path
import pandas as pd, polars as pl
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path)
 if s is None or s.loader is None: raise RuntimeError("IMPORT_FAILED:"+name)
 m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
v1=load("v1",ROOT/"market-prediction-lab/scripts/run-full-universe-3pct-hunter-causal-backtest-v1.py")
common=load("common",ROOT/"market-prediction-lab/scripts/hunter_v3_common.py")
BOUNDARY=pd.Timestamp("2025-04-01").date(); COST=0.003
FAMILIES=("ACCEL_BREAKOUT","COMPRESSION_PRESSURE","VOLUME_MOMENTUM"); TOP_NS=(1,3,5,10); TARGETS=(0.03,0.05)
def rank01(e):
 r=e.rank("average",descending=True).over("date").cast(pl.Float64); n=pl.len().over("date").cast(pl.Float64)
 return pl.when(n>1).then(1-(r-1)/(n-1)).otherwise(1.0)
def prepare(x):
 x=x.sort(["symbol","date"]).with_columns([
  pl.col("open").shift(1).over("symbol").alias("po"),pl.col("high").shift(1).over("symbol").alias("ph"),pl.col("low").shift(1).over("symbol").alias("pl"),
  pl.col("close").shift(1).over("symbol").alias("pc"),pl.col("close").shift(2).over("symbol").alias("c2"),pl.col("close").shift(6).over("symbol").alias("c6"),
  pl.col("volume").shift(1).over("symbol").alias("pv"),
  pl.col("volume").shift(2).rolling_mean(20,min_samples=10).over("symbol").alias("v20"),
  (pl.col("close").shift(2)*pl.col("volume").shift(2)).rolling_mean(20,min_samples=10).over("symbol").alias("dv20"),
  pl.col("high").shift(2).rolling_max(20,min_samples=10).over("symbol").alias("h20")
 ])
 x=x.with_columns([
  ((pl.col("ph")-pl.col("pl"))/pl.col("pc")).alias("rangePrev"),
  ((pl.col("pc")-pl.col("pl"))/(pl.col("ph")-pl.col("pl")).clip(1.0,None)).alias("closeLoc"),
  (pl.col("pv")/pl.col("v20")).alias("volAccel"),((pl.col("pc")*pl.col("pv"))/pl.col("dv20")).alias("dollarAccel"),
  (pl.col("pc")/pl.col("c2")-1).alias("ret1"),(pl.col("pc")/pl.col("c6")-1).alias("ret5"),(pl.col("pc")/pl.col("h20")-1).alias("breakDist")
 ])
 x=x.filter(pl.col("pc").is_not_null()&(pl.col("open")>=1000)&(pl.col("dv20")>=1_000_000_000)&pl.col("volAccel").is_finite())
 return x.with_columns([rank01(pl.col("volAccel")).alias("rv"),rank01(pl.col("dollarAccel")).alias("rd"),rank01(pl.col("closeLoc")).alias("rc"),rank01(pl.col("ret1")).alias("r1"),rank01(pl.col("ret5")).alias("r5"),rank01(pl.col("breakDist")).alias("rb")]).with_columns(((pl.col("rv")+pl.col("rd")+pl.col("rc")+pl.col("r1")+pl.col("r5")+pl.col("rb"))/6).alias("score"))
def mask(f):
 c=(pl.col("volAccel")>=1.2)&(pl.col("dollarAccel")>=1.2)&(pl.col("closeLoc")>=0.55)
 if f=="ACCEL_BREAKOUT": return c&(pl.col("breakDist")>=-0.01)&(pl.col("ret1")>=0)
 if f=="COMPRESSION_PRESSURE": return c&(pl.col("rangePrev")<=0.08)&(pl.col("ret5")>=-0.03)&(pl.col("breakDist")>=-0.05)
 return c&(pl.col("ret1")>=0.01)&(pl.col("ret5")>=0.02)
def sim(x,t):
 stop=pl.col("rangePrev").mul(0.7).clip(0.01,0.035); sh=pl.col("low")<=pl.col("open")*(1-stop); th=pl.col("high")>=pl.col("open")*(1+t)
 ep=pl.when(sh).then(pl.col("open")*(1-stop)).when(th).then(pl.col("open")*(1+t)).otherwise(pl.col("close")); g=ep/pl.col("open")-1
 return x.with_columns([pl.col("date").cast(pl.Datetime).alias("tradeTime"),pl.col("open").alias("entryPrice"),ep.alias("exitPrice"),g.alias("grossReturn"),(g-COST).alias("netReturn"),stop.alias("stopPct"),pl.lit(t).alias("targetPct")])
def main():
 ap=argparse.ArgumentParser(); ap.add_argument("--out-dir",required=True); a=ap.parse_args(); out=Path(a.out_dir); out.mkdir(parents=True,exist_ok=True)
 loaded,source=v1.census.load_kr(); v1.assert_source_coverage("KR_STOCK",source); x=prepare(loaded); reports={}; ledgers={}; grid=[]
 for f in FAMILIES:
  base=x.filter(mask(f))
  for n in TOP_NS:
   p=base.sort(["date","score"],descending=[False,True]).group_by("date",maintain_order=True).head(n)
   for t in TARGETS:
    name=f"{f}_TOP{n}_TP{int(t*100)}"; tr=sim(p,t).with_columns(pl.lit(name).alias("candidate")); train=tr.filter(pl.col("date")<pl.lit(BOUNDARY)); test=tr.filter(pl.col("date")>=pl.lit(BOUNDARY))
    tm=common.metrics(train,"KR_STOCK"); hm=common.metrics(test,"KR_STOCK"); fm=common.metrics(tr,"KR_STOCK")
    reports[name]={"candidate":name,"family":f,"topN":n,"targetPct":t,"trainFirstTwoYears":tm,"heldoutLastYear":hm,"observedThreeYear":fm}; ledgers[name]=tr
    grid.append({"candidate":name,"trainReturn":tm["totalReturn"],"trainPF":tm["profitFactor"],"trainPositiveMonthRate":tm["positiveMonthRate"],"heldoutReturn":hm["totalReturn"],"heldoutPF":hm["profitFactor"],"heldoutPositiveMonthRate":hm["positiveMonthRate"],"threeYearReturn":fm["totalReturn"]})
 elig=[n for n,r in reports.items() if r["trainFirstTwoYears"]["tradeCount"]>=50]; win=max(elig,key=lambda n:common.choose_key(reports[n]["trainFirstTwoYears"],n)); sel=reports[win]; sel["heldoutGate"]=common.gate(sel["heldoutLastYear"])
 ledgers[win].sort(["date","symbol"]).write_csv(out/"selected-ledger.csv"); pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
 summary={"contract":"hunter-kr-pressure-v3","market":"KR_STOCK","source":source,"selected":sel,"truthBoundary":{"heldoutUsedForSelection":False,"profitabilityProven":False,"executionAuthority":"NONE"}}
 (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"); print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)
if __name__=="__main__": main()
