#!/usr/bin/env python3
from __future__ import annotations
import argparse,importlib.util,json
from pathlib import Path
import pandas as pd, polars as pl
ROOT=Path(__file__).resolve().parents[2]
s=importlib.util.spec_from_file_location("common",ROOT/"market-prediction-lab/scripts/hunter_v3_common.py")
if s is None or s.loader is None: raise RuntimeError("COMMON_IMPORT_FAILED")
common=importlib.util.module_from_spec(s); s.loader.exec_module(common)
BOUNDARY=pd.Timestamp("2025-04-01",tz="UTC"); FAMS=("BREAKOUT_VOLUME","COMPRESSION_BREAK","TREND_WAVE"); TOPS=(1,3,5,10); H=(16,32); T=(.03,.05); COST={"CRYPTO_SPOT":.002,"CRYPTO_FUTURES":.0012}
def sim(x,m,h,t):
 stop=.02 if m=="CRYPTO_SPOT" else .018; hi=pl.col(f"hi{h}"); lo=pl.col(f"lo{h}"); cl=pl.col(f"cl{h}")
 ls=lo<=pl.col("entryPrice")*(1-stop); lt=hi>=pl.col("entryPrice")*(1+t); ss=hi>=pl.col("entryPrice")*(1+stop); st=lo<=pl.col("entryPrice")*(1-t)
 sh=pl.when(pl.col("direction")=="LONG").then(ls).otherwise(ss); th=pl.when(pl.col("direction")=="LONG").then(lt).otherwise(st)
 ep=pl.when(pl.col("direction")=="LONG").then(pl.when(ls).then(pl.col("entryPrice")*(1-stop)).when(lt).then(pl.col("entryPrice")*(1+t)).otherwise(cl)).otherwise(pl.when(ss).then(pl.col("entryPrice")*(1+stop)).when(st).then(pl.col("entryPrice")*(1-t)).otherwise(cl))
 g=pl.when(pl.col("direction")=="LONG").then(ep/pl.col("entryPrice")-1).otherwise(1-ep/pl.col("entryPrice"))
 return x.with_columns([ep.alias("exitPrice"),g.alias("grossReturn"),(g-COST[m]).alias("netReturn"),pl.lit(h).alias("horizonBars"),pl.lit(t).alias("targetPct"),pl.lit(stop).alias("stopPct")])
def main():
 ap=argparse.ArgumentParser();ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"]);ap.add_argument("--input-root",required=True);ap.add_argument("--out-dir",required=True);a=ap.parse_args()
 frames=[]
 for f in Path(a.input_root).glob("**/candidates.parquet"):
  q=pl.read_parquet(f)
  if q.height and str(q["market"][0])==a.market:frames.append(q)
 if not frames:raise RuntimeError("NO_CANDIDATES:"+a.market)
 x=pl.concat(frames,how="vertical");dirs=["LONG","SHORT"] if a.market=="CRYPTO_FUTURES" else ["LONG"];reports={};ledgers={};grid=[]
 for d in dirs:
  for fam in FAMS:
   base=x.filter((pl.col("direction")==d)&(pl.col("family")==fam))
   for n in TOPS:
    p=base.sort(["entryTime","score"],descending=[False,True]).group_by("entryTime",maintain_order=True).head(n)
    for h in H:
     for t in T:
      name=f"{fam}_{d}_TOP{n}_H{h}_TP{int(t*100)}";tr=sim(p,a.market,h,t).with_columns(pl.lit(name).alias("candidate"));train=tr.filter(pl.col("entryTime")<pl.lit(BOUNDARY.to_pydatetime()));test=tr.filter(pl.col("entryTime")>=pl.lit(BOUNDARY.to_pydatetime()))
      tm=common.metrics(train,a.market,time_col="entryTime");hm=common.metrics(test,a.market,time_col="entryTime");fm=common.metrics(tr,a.market,time_col="entryTime")
      reports[name]={"candidate":name,"direction":d,"family":fam,"topN":n,"horizonBars":h,"targetPct":t,"trainFirstTwoYears":tm,"heldoutLastYear":hm,"observedThreeYear":fm};ledgers[name]=tr
      grid.append({"candidate":name,"direction":d,"trainReturn":tm["totalReturn"],"trainPF":tm["profitFactor"],"trainPositiveMonthRate":tm["positiveMonthRate"],"heldoutReturn":hm["totalReturn"],"heldoutPF":hm["profitFactor"],"heldoutPositiveMonthRate":hm["positiveMonthRate"],"threeYearReturn":fm["totalReturn"]})
 selected={};selFrames=[]
 for d in dirs:
  elig=[n for n,r in reports.items() if r["direction"]==d and r["trainFirstTwoYears"]["tradeCount"]>=100]
  if not elig:raise RuntimeError("NO_ELIGIBLE:"+d)
  w=max(elig,key=lambda n:common.choose_key(reports[n]["trainFirstTwoYears"],n));r=reports[w];r["heldoutGate"]=common.gate(r["heldoutLastYear"]);selected[d]=r;selFrames.append(ledgers[w])
 allsel=pl.concat(selFrames,how="vertical");allsel.write_csv(Path(a.out_dir)/"selected-ledger.csv");pd.DataFrame(grid).to_csv(Path(a.out_dir)/"candidate-grid.csv",index=False)
 mf=common.metrics(allsel,a.market,time_col="entryTime");mh=common.metrics(allsel.filter(pl.col("entryTime")>=pl.lit(BOUNDARY.to_pydatetime())),a.market,time_col="entryTime")
 summary={"contract":"hunter-crypto-intraday-v3","market":a.market,"source":{"provider":"rogerdehe/klines-binance","timeframe":"15m","candidateRows":x.height},"selectedByDirection":selected,"marketObservedThreeYear":mf,"marketHeldoutLastYear":mh,"marketHeldoutGate":common.gate(mh),"truthBoundary":{"heldoutUsedForSelection":False,"takerCvdOiEnrichmentDone":False,"profitabilityProven":False,"executionAuthority":"NONE"}}
 Path(a.out_dir).mkdir(parents=True,exist_ok=True);(Path(a.out_dir)/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8");print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)
if __name__=="__main__":main()
