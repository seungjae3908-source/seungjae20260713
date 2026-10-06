#!/usr/bin/env python3
from __future__ import annotations
import argparse, importlib.util, json, tempfile
from pathlib import Path
import duckdb, pandas as pd, polars as pl

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    s=importlib.util.spec_from_file_location(name,path)
    if s is None or s.loader is None: raise RuntimeError("IMPORT_FAILED:"+name)
    m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
census=load("census",ROOT/"market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")
common=load("common",ROOT/"market-prediction-lab/scripts/hunter_v3_common.py")
BOUNDARY=pd.Timestamp("2025-04-01").date(); COST=0.002
FAMILIES=("ORB_RETEST","GAP_RVOL","OPENING_MOMENTUM"); TOP_NS=(1,3,5,10); TARGETS=(0.03,0.05)

def load_days():
    fs=[]; audits=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for month in census._month_iter(census.START,census.END_EXCLUSIVE):
            p=root/f"ohlcv_{month.strftime('%Y-%m')}.parquet"; census._download_us_month(month,p)
            con=duckdb.connect()
            q=f"""
            WITH b AS (
              SELECT upper(ticker) symbol, timezone('America/New_York', timestamp) ts,
                     CAST(open AS DOUBLE) open, CAST(high AS DOUBLE) high, CAST(low AS DOUBLE) low,
                     CAST(close AS DOUBLE) close, CAST(volume AS DOUBLE) volume
              FROM read_parquet('{p.as_posix()}')
            ), r AS (
              SELECT *, CAST(ts AS DATE) date, CAST(ts AS TIME) t FROM b
              WHERE CAST(ts AS TIME)>=TIME '09:30:00' AND CAST(ts AS TIME)<TIME '16:00:00'
                AND regexp_matches(symbol,'^[A-Z][A-Z0-9.\-]{{0,9}}$')
            )
            SELECT symbol,date,
              arg_min(open,ts) open,max(high) high,min(low) low,arg_max(close,ts) close,sum(volume) volume,
              max(high) FILTER(WHERE t<TIME '09:35:00') f5_high,
              min(low) FILTER(WHERE t<TIME '09:35:00') f5_low,
              arg_max(close,ts) FILTER(WHERE t<TIME '09:35:00') f5_close,
              sum(volume) FILTER(WHERE t<TIME '09:35:00') f5_volume,
              max(high) FILTER(WHERE t>=TIME '09:35:00' AND t<TIME '09:40:00') s5_high,
              min(low) FILTER(WHERE t>=TIME '09:35:00' AND t<TIME '09:40:00') s5_low,
              arg_max(close,ts) FILTER(WHERE t>=TIME '09:35:00' AND t<TIME '09:40:00') s5_close,
              sum(volume) FILTER(WHERE t>=TIME '09:35:00' AND t<TIME '09:40:00') s5_volume,
              max(high) FILTER(WHERE t>=TIME '09:40:00') post_high,
              min(low) FILTER(WHERE t>=TIME '09:40:00') post_low,
              arg_max(close,ts) FILTER(WHERE t>=TIME '09:40:00') post_close
            FROM r GROUP BY symbol,date
            """
            f=pl.from_arrow(con.execute(q).fetch_arrow_table()); con.close()
            fs.append(f); audits.append({"month":month.strftime("%Y-%m"),"rows":f.height})
            print(json.dumps({"usV3Month":month.strftime("%Y-%m"),"rows":f.height}),flush=True)
    return pl.concat(fs,how="vertical").sort(["symbol","date"]),audits

def rank01(e):
    r=e.rank("average",descending=True).over("date").cast(pl.Float64); n=pl.len().over("date").cast(pl.Float64)
    return pl.when(n>1).then(1-(r-1)/(n-1)).otherwise(1.0)

def prepare(x):
    x=x.with_columns([
      pl.col("close").shift(1).over("symbol").alias("prev_close"),
      pl.col("close").shift(6).over("symbol").alias("c6"),
      pl.col("close").shift(21).over("symbol").alias("c21"),
      pl.col("volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("v20"),
      (pl.col("close").shift(1)*pl.col("volume").shift(1)).rolling_mean(20,min_samples=10).over("symbol").alias("dv20"),
      ((pl.col("high").shift(1)-pl.col("low").shift(1))/pl.col("close").shift(1)).alias("prevRange")
    ])
    x=x.with_columns([
      (pl.col("open")/pl.col("prev_close")-1).alias("gap"),
      (pl.col("prev_close")/pl.col("c6")-1).alias("ret5"),
      (pl.col("prev_close")/pl.col("c21")-1).alias("ret20"),
      ((pl.col("f5_volume")+pl.col("s5_volume"))/(pl.col("v20")*(10/390))).alias("rvol10"),
      ((pl.col("f5_volume")+pl.col("s5_volume"))*pl.col("s5_close")).alias("dollar10"),
      (pl.col("s5_close")/pl.col("open")-1).alias("openRet10"),
      ((pl.col("s5_high")>pl.col("f5_high"))&(pl.col("s5_low")<=pl.col("f5_high")*1.003)&(pl.col("s5_close")>=pl.col("f5_high")*0.998)).alias("retest")
    ])
    x=x.filter(pl.col("s5_close").is_not_null()&pl.col("post_close").is_not_null()&(pl.col("open")>=2)&(pl.col("dv20")>=10_000_000)&pl.col("rvol10").is_finite())
    return x.with_columns([
      rank01(pl.col("gap")).alias("rg"),rank01(pl.col("rvol10")).alias("rv"),
      rank01(pl.col("dollar10")).alias("rd"),rank01(pl.col("openRet10")).alias("ro"),rank01(pl.col("ret20")).alias("rm")
    ]).with_columns(((pl.col("rg")+pl.col("rv")+pl.col("rd")+pl.col("ro")+pl.col("rm"))/5).alias("score"))

def mask(f):
    c=(pl.col("gap")>=0.01)&(pl.col("gap")<=0.30)&(pl.col("rvol10")>=1.5)&(pl.col("dollar10")>=1_000_000)&(pl.col("openRet10")>=-0.01)
    if f=="ORB_RETEST": return c&pl.col("retest")
    if f=="GAP_RVOL": return c&(pl.col("gap")>=0.02)&(pl.col("openRet10")>=0)
    return c&(pl.col("openRet10")>=0.01)&(pl.col("ret5")>=-0.05)

def sim(x,target):
    stop=pl.col("prevRange").mul(0.8).clip(0.012,0.035)
    sh=pl.col("post_low")<=pl.col("s5_close")*(1-stop); th=pl.col("post_high")>=pl.col("s5_close")*(1+target)
    ep=pl.when(sh).then(pl.col("s5_close")*(1-stop)).when(th).then(pl.col("s5_close")*(1+target)).otherwise(pl.col("post_close"))
    g=ep/pl.col("s5_close")-1
    return x.with_columns([pl.col("date").cast(pl.Datetime).alias("tradeTime"),pl.col("s5_close").alias("entryPrice"),ep.alias("exitPrice"),g.alias("grossReturn"),(g-COST).alias("netReturn"),stop.alias("stopPct"),pl.lit(target).alias("targetPct")])

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--out-dir",required=True); a=ap.parse_args(); out=Path(a.out_dir); out.mkdir(parents=True,exist_ok=True)
    raw,audits=load_days(); x=prepare(raw); reports={}; ledgers={}; grid=[]
    for f in FAMILIES:
      base=x.filter(mask(f))
      for n in TOP_NS:
        p=base.sort(["date","score"],descending=[False,True]).group_by("date",maintain_order=True).head(n)
        for t in TARGETS:
          name=f"{f}_TOP{n}_TP{int(t*100)}"; tr=sim(p,t).with_columns(pl.lit(name).alias("candidate"))
          train=tr.filter(pl.col("date")<pl.lit(BOUNDARY)); test=tr.filter(pl.col("date")>=pl.lit(BOUNDARY))
          tm=common.metrics(train,"US_STOCK"); hm=common.metrics(test,"US_STOCK"); fm=common.metrics(tr,"US_STOCK")
          reports[name]={"candidate":name,"family":f,"topN":n,"targetPct":t,"trainFirstTwoYears":tm,"heldoutLastYear":hm,"observedThreeYear":fm}; ledgers[name]=tr
          grid.append({"candidate":name,"trainReturn":tm["totalReturn"],"trainPF":tm["profitFactor"],"trainPositiveMonthRate":tm["positiveMonthRate"],"heldoutReturn":hm["totalReturn"],"heldoutPF":hm["profitFactor"],"heldoutPositiveMonthRate":hm["positiveMonthRate"],"threeYearReturn":fm["totalReturn"]})
    elig=[n for n,r in reports.items() if r["trainFirstTwoYears"]["tradeCount"]>=50]
    win=max(elig,key=lambda n:common.choose_key(reports[n]["trainFirstTwoYears"],n)); sel=reports[win]; sel["heldoutGate"]=common.gate(sel["heldoutLastYear"])
    ledgers[win].sort(["date","symbol"]).write_csv(out/"selected-ledger.csv"); pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    summary={"contract":"hunter-us-intraday-v3","market":"US_STOCK","source":{"provider":census.US_DATASET,"months":audits},"selected":sel,"truthBoundary":{"heldoutUsedForSelection":False,"profitabilityProven":False,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"); print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)
if __name__=="__main__": main()
