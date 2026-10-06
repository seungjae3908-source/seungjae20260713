#!/usr/bin/env python3
from __future__ import annotations
import argparse, importlib.util, json, tempfile
from pathlib import Path
import duckdb, pandas as pd, polars as pl

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    s=importlib.util.spec_from_file_location(name,path)
    if s is None or s.loader is None: raise RuntimeError("IMPORT_FAILED:"+name)
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
census=load("census",ROOT/"market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")
common=load("common",ROOT/"market-prediction-lab/scripts/hunter_v3_common.py")

BOUNDARY=pd.Timestamp("2025-04-01").date()
FAMILIES=("PM_RVOL_GAP","PM_ORB_RETEST","PM_ACCEL_BREAK")
TOPS=(1,3,5,10)
TARGETS=(0.03,0.05)
STOPS=(0.015,0.020)
COST=0.002

def load_daily():
    frames=[]; audits=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for month in census._month_iter(census.START,census.END_EXCLUSIVE):
            p=root/f"ohlcv_{month.strftime('%Y-%m')}.parquet";census._download_us_month(month,p)
            con=duckdb.connect()
            q=f"""
            WITH b AS (
              SELECT upper(ticker) AS symbol, timezone('America/New_York', timestamp) AS ts,
                     CAST(open AS DOUBLE) AS o, CAST(high AS DOUBLE) AS h, CAST(low AS DOUBLE) AS l,
                     CAST(close AS DOUBLE) AS c, CAST(volume AS DOUBLE) AS v
              FROM read_parquet('{p.as_posix()}')
              WHERE regexp_matches(upper(ticker),'^[A-Z][A-Z0-9.\-]{{0,9}}$')
            ), x AS (
              SELECT *,CAST(ts AS DATE) AS date,CAST(ts AS TIME) AS t FROM b
            )
            SELECT symbol,date,
              arg_min(o,ts) FILTER(WHERE t>=TIME '09:30:00' AND t<TIME '16:00:00') AS open,
              max(h) FILTER(WHERE t>=TIME '09:30:00' AND t<TIME '16:00:00') AS high,
              min(l) FILTER(WHERE t>=TIME '09:30:00' AND t<TIME '16:00:00') AS low,
              arg_max(c,ts) FILTER(WHERE t>=TIME '09:30:00' AND t<TIME '16:00:00') AS close,
              sum(v) FILTER(WHERE t>=TIME '09:30:00' AND t<TIME '16:00:00') AS volume,
              sum(v) FILTER(WHERE t>=TIME '04:00:00' AND t<TIME '09:30:00') AS pm_volume,
              sum(c*v) FILTER(WHERE t>=TIME '04:00:00' AND t<TIME '09:30:00') AS pm_dollar,
              max(h) FILTER(WHERE t>=TIME '04:00:00' AND t<TIME '09:30:00') AS pm_high,
              min(l) FILTER(WHERE t>=TIME '04:00:00' AND t<TIME '09:30:00') AS pm_low,
              arg_max(c,ts) FILTER(WHERE t>=TIME '04:00:00' AND t<TIME '09:30:00') AS pm_last,
              count(*) FILTER(WHERE t>=TIME '04:00:00' AND t<TIME '09:30:00') AS pm_bars,
              max(h) FILTER(WHERE t>=TIME '09:30:00' AND t<TIME '09:35:00') AS f5_high,
              min(l) FILTER(WHERE t>=TIME '09:30:00' AND t<TIME '09:35:00') AS f5_low,
              sum(v) FILTER(WHERE t>=TIME '09:30:00' AND t<TIME '09:35:00') AS f5_volume,
              max(h) FILTER(WHERE t>=TIME '09:35:00' AND t<TIME '09:40:00') AS s5_high,
              min(l) FILTER(WHERE t>=TIME '09:35:00' AND t<TIME '09:40:00') AS s5_low,
              arg_max(c,ts) FILTER(WHERE t>=TIME '09:35:00' AND t<TIME '09:40:00') AS s5_close,
              sum(v) FILTER(WHERE t>=TIME '09:35:00' AND t<TIME '09:40:00') AS s5_volume
            FROM x GROUP BY symbol,date
            """
            f=pl.from_arrow(con.execute(q).fetch_arrow_table());con.close()
            frames.append(f);audits.append({"month":month.strftime("%Y-%m"),"rows":f.height})
            print(json.dumps({"phase":"daily","month":month.strftime("%Y-%m"),"rows":f.height}),flush=True)
    return pl.concat(frames,how="vertical_relaxed").sort(["symbol","date"]),audits

def rank01(e):
    r=e.rank("average",descending=True).over("date").cast(pl.Float64);n=pl.len().over("date").cast(pl.Float64)
    return pl.when(n>1).then(1-(r-1)/(n-1)).otherwise(1.0)

def prepare(x):
    x=x.with_columns([
      pl.col("close").shift(1).over("symbol").alias("prev_close"),
      pl.col("volume").shift(1).over("symbol").alias("prev_volume"),
      (pl.col("close").shift(1)*pl.col("volume").shift(1)).rolling_mean(20,min_samples=10).over("symbol").alias("priorDollar20"),
      pl.col("pm_volume").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorPmVol20"),
      pl.col("pm_dollar").shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorPmDollar20"),
      (pl.col("f5_volume")+pl.col("s5_volume")).shift(1).rolling_mean(20,min_samples=10).over("symbol").alias("priorOpen10Vol20"),
      ((pl.col("high").shift(1)-pl.col("low").shift(1))/pl.col("close").shift(1)).alias("prevRange")
    ])
    x=x.with_columns([
      (pl.col("open")/pl.col("prev_close")-1).alias("gap"),
      (pl.col("pm_last")/pl.col("prev_close")-1).alias("pmReturn"),
      (pl.col("pm_volume")/pl.col("priorPmVol20")).alias("pmRvol"),
      (pl.col("pm_dollar")/pl.col("priorPmDollar20")).alias("pmDollarAccel"),
      ((pl.col("f5_volume")+pl.col("s5_volume"))/pl.col("priorOpen10Vol20")).alias("open10Rvol"),
      (pl.col("s5_close")/pl.col("open")-1).alias("openRet10"),
      ((pl.col("s5_high")>pl.col("f5_high"))&(pl.col("s5_low")<=pl.col("f5_high")*1.003)&(pl.col("s5_close")>=pl.col("f5_high")*0.998)).alias("retest")
    ])
    x=x.filter(pl.col("s5_close").is_not_null()&(pl.col("open")>=2)&(pl.col("priorDollar20")>=10_000_000)&(pl.col("pm_bars")>=3)&pl.col("pmRvol").is_finite()&pl.col("open10Rvol").is_finite())
    return x.with_columns([
      rank01(pl.col("gap")).alias("rg"),rank01(pl.col("pmRvol")).alias("rpm"),
      rank01(pl.col("pm_dollar")).alias("rpd"),rank01(pl.col("open10Rvol")).alias("ror"),
      rank01(pl.col("openRet10")).alias("rot")
    ]).with_columns(((pl.col("rg")+pl.col("rpm")+pl.col("rpd")+pl.col("ror")+pl.col("rot"))/5).alias("score"))

def fam_mask(f):
    commonm=(pl.col("gap")>=0.015)&(pl.col("gap")<=0.30)&(pl.col("pm_dollar")>=250_000)&(pl.col("pmRvol")>=1.5)&(pl.col("open10Rvol")>=1.2)&(pl.col("openRet10")>=-0.01)
    if f=="PM_RVOL_GAP": return commonm&(pl.col("pmRvol")>=2.0)&(pl.col("gap")>=0.02)
    if f=="PM_ORB_RETEST": return commonm&(pl.col("pmRvol")>=2.0)&pl.col("retest")
    return commonm&(pl.col("pmRvol")>=3.0)&(pl.col("pmDollarAccel")>=2.0)&(pl.col("open10Rvol")>=1.5)&(pl.col("openRet10")>=0.005)

def candidate_base(x):
    frames=[]
    for f in FAMILIES:
        base=x.filter(fam_mask(f))
        for n in TOPS:
            p=(base.sort(["date","score"],descending=[False,True]).group_by("date",maintain_order=True).head(n)
               .with_columns([pl.lit(f).alias("family"),pl.lit(n).alias("topN"),pl.col("s5_close").alias("entryPrice")]))
            if p.height: frames.append(p.select(["symbol","date","family","topN","score","entryPrice"]))
    return pl.concat(frames,how="vertical_relaxed") if frames else pl.DataFrame()

def execute(base):
    outs=[]
    with tempfile.TemporaryDirectory() as td:
      root=Path(td)
      for month in census._month_iter(census.START,census.END_EXCLUSIVE):
        start=month.date();nxt=(month+pd.offsets.MonthBegin(1)).date()
        cm=base.filter((pl.col("date")>=pl.lit(start))&(pl.col("date")<pl.lit(nxt)))
        if cm.is_empty():continue
        p=root/f"ohlcv_{month.strftime('%Y-%m')}.parquet";census._download_us_month(month,p)
        con=duckdb.connect();con.register("cand",cm.to_arrow())
        q=f"""
        WITH b AS (
          SELECT upper(ticker) AS symbol, timezone('America/New_York', timestamp) AS ts,
                 CAST(high AS DOUBLE) AS h,CAST(low AS DOUBLE) AS l,CAST(close AS DOUBLE) AS c
          FROM read_parquet('{p.as_posix()}')
        ), post AS (
          SELECT b.*,CAST(ts AS DATE) date,cand.family,cand.topN,cand.score,cand.entryPrice
          FROM b JOIN cand ON b.symbol=cand.symbol AND CAST(b.ts AS DATE)=cand.date
          WHERE CAST(b.ts AS TIME)>=TIME '09:40:00' AND CAST(b.ts AS TIME)<TIME '16:00:00'
        )
        SELECT symbol,date,family,topN,score,entryPrice,
          min(ts) FILTER(WHERE l<=entryPrice*(1-.015)) AS stop15,
          min(ts) FILTER(WHERE l<=entryPrice*(1-.020)) AS stop20,
          min(ts) FILTER(WHERE h>=entryPrice*(1+.03)) AS tp3,
          min(ts) FILTER(WHERE h>=entryPrice*(1+.05)) AS tp5,
          arg_max(c,ts) AS eod
        FROM post GROUP BY symbol,date,family,topN,score,entryPrice
        """
        o=pl.from_arrow(con.execute(q).fetch_arrow_table());con.close()
        if o.height:outs.append(o)
        print(json.dumps({"phase":"path","month":month.strftime("%Y-%m"),"candidates":cm.height,"executed":o.height}),flush=True)
    if not outs:raise RuntimeError("NO_PATH_RESULTS")
    return pl.concat(outs,how="vertical_relaxed")

def materialize(x,stop,target):
    sc="stop15" if stop==.015 else "stop20";tc="tp3" if target==.03 else "tp5"
    sf=pl.col(sc).is_not_null()&(pl.col(tc).is_null()|(pl.col(sc)<=pl.col(tc)));tf=pl.col(tc).is_not_null()&~sf
    ep=pl.when(sf).then(pl.col("entryPrice")*(1-stop)).when(tf).then(pl.col("entryPrice")*(1+target)).otherwise(pl.col("eod"));g=ep/pl.col("entryPrice")-1
    name=pl.concat_str([pl.col("family"),pl.lit("_TOP"),pl.col("topN").cast(pl.Utf8),pl.lit(f"_SL{int(stop*1000):02d}_TP{int(target*100)}")])
    return x.with_columns([pl.col("date").cast(pl.Datetime).alias("tradeTime"),name.alias("candidate"),pl.lit(stop).alias("stopPct"),pl.lit(target).alias("targetPct"),ep.alias("exitPrice"),g.alias("grossReturn"),(g-COST).alias("netReturn")])

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--out-dir",required=True);a=ap.parse_args();out=Path(a.out_dir);out.mkdir(parents=True,exist_ok=True)
    daily,audits=load_daily();x=prepare(daily);base=candidate_base(x);path=execute(base)
    reports={};ledgers={};grid=[]
    for f in FAMILIES:
      for n in TOPS:
       sub=path.filter((pl.col("family")==f)&(pl.col("topN")==n))
       for stop in STOPS:
        for target in TARGETS:
         tr=materialize(sub,stop,target);name=f"{f}_TOP{n}_SL{int(stop*1000):02d}_TP{int(target*100)}"
         train=tr.filter(pl.col("date")<pl.lit(BOUNDARY));held=tr.filter(pl.col("date")>=pl.lit(BOUNDARY))
         tm=common.metrics(train,"US_STOCK");hm=common.metrics(held,"US_STOCK");fm=common.metrics(tr,"US_STOCK")
         reports[name]={"candidate":name,"family":f,"topN":n,"stopPct":stop,"targetPct":target,"trainFirstTwoYears":tm,"heldoutLastYear":hm,"observedThreeYear":fm};ledgers[name]=tr
         grid.append({"candidate":name,"trainReturn":tm["totalReturn"],"trainPF":tm["profitFactor"],"trainPositiveMonthRate":tm["positiveMonthRate"],"heldoutReturn":hm["totalReturn"],"heldoutPF":hm["profitFactor"],"heldoutPositiveMonthRate":hm["positiveMonthRate"],"threeYearReturn":fm["totalReturn"]})
    elig=[k for k,r in reports.items() if r["trainFirstTwoYears"]["tradeCount"]>=50]
    win=max(elig,key=lambda k:common.choose_key(reports[k]["trainFirstTwoYears"],k));sel=reports[win];sel["heldoutGate"]=common.gate(sel["heldoutLastYear"])
    ledgers[win].sort(["date","symbol"]).write_csv(out/"selected-ledger.csv");pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    summary={"schemaVersion":1,"contract":"hunter-us-premarket-v5","market":"US_STOCK","source":{"provider":census.US_DATASET,"months":audits},
      "design":{"signal":"premarket RVOL/gap + opening10 RVOL/ORB","entry":"09:40 ET","path":"chronological 1m","families":list(FAMILIES),"topN":list(TOPS),"stops":list(STOPS),"targets":list(TARGETS),"heldoutUsedForSelection":False},
      "selected":sel,"truthBoundary":{"profitabilityProven":False,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8");print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)
if __name__=="__main__":main()
