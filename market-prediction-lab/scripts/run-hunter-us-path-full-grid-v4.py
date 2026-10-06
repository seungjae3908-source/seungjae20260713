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

v3=load("us_v3",ROOT/"market-prediction-lab/scripts/run-hunter-us-intraday-v3c.py")
common=load("common",ROOT/"market-prediction-lab/scripts/hunter_v3_common.py")
BOUNDARY=pd.Timestamp("2025-04-01").date()
FAMILIES=("ORB_RETEST","GAP_RVOL","OPENING_MOMENTUM")
TOPS=(1,3,5,10)
TARGETS=(0.03,0.05)
COST=0.002

def build_base(x:pl.DataFrame)->pl.DataFrame:
    frames=[]
    for family in FAMILIES:
        fam=x.filter(v3.mask(family))
        for n in TOPS:
            p=(fam.sort(["date","score"],descending=[False,True])
               .group_by("date",maintain_order=True).head(n)
               .with_columns([
                   pl.lit(family).alias("family"),
                   pl.lit(n).alias("topN"),
                   pl.col("s5_close").cast(pl.Float64).alias("entryPrice"),
                   pl.col("prevRange").mul(0.8).clip(0.012,0.035).alias("stopPct"),
               ])
               .select(["symbol","date","family","topN","score","entryPrice","stopPct"]))
            if p.height: frames.append(p)
    if not frames: raise RuntimeError("NO_V4_GRID_BASE")
    return pl.concat(frames,how="vertical_relaxed")

def execute(base:pl.DataFrame)->pl.DataFrame:
    outs=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for month in v3.census._month_iter(v3.census.START,v3.census.END_EXCLUSIVE):
            start=month.date(); nxt=(month+pd.offsets.MonthBegin(1)).date()
            cm=base.filter((pl.col("date")>=pl.lit(start))&(pl.col("date")<pl.lit(nxt)))
            if cm.is_empty(): continue
            p=root/f"ohlcv_{month.strftime('%Y-%m')}.parquet"
            v3.census._download_us_month(month,p)
            con=duckdb.connect(); con.register("cand",cm.to_arrow())
            q=f"""
            WITH b AS (
              SELECT upper(ticker) AS symbol,
                     timezone('America/New_York',timestamp) AS ts,
                     CAST(high AS DOUBLE) AS h,CAST(low AS DOUBLE) AS l,CAST(close AS DOUBLE) AS c
              FROM read_parquet('{p.as_posix()}')
            ), post AS (
              SELECT b.*,CAST(ts AS DATE) AS date,
                     cand.family,cand.topN,cand.score,cand.entryPrice,cand.stopPct
              FROM b JOIN cand
                ON b.symbol=cand.symbol AND CAST(b.ts AS DATE)=cand.date
              WHERE CAST(b.ts AS TIME)>=TIME '09:40:00' AND CAST(b.ts AS TIME)<TIME '16:00:00'
            )
            SELECT symbol,date,family,topN,score,entryPrice,stopPct,
              min(ts) FILTER(WHERE l<=entryPrice*(1-stopPct)) AS stop_ts,
              min(ts) FILTER(WHERE h>=entryPrice*1.03) AS tp3_ts,
              min(ts) FILTER(WHERE h>=entryPrice*1.05) AS tp5_ts,
              arg_max(c,ts) AS eod_close
            FROM post
            GROUP BY symbol,date,family,topN,score,entryPrice,stopPct
            """
            o=pl.from_arrow(con.execute(q).fetch_arrow_table()); con.close()
            if o.height: outs.append(o)
            print(json.dumps({"month":month.strftime("%Y-%m"),"baseRows":cm.height,"pathRows":o.height}),flush=True)
    if not outs: raise RuntimeError("NO_V4_GRID_PATH")
    return pl.concat(outs,how="vertical_relaxed")

def materialize(x:pl.DataFrame,target:float)->pl.DataFrame:
    tc="tp3_ts" if target==0.03 else "tp5_ts"
    sf=pl.col("stop_ts").is_not_null()&(pl.col(tc).is_null()|(pl.col("stop_ts")<=pl.col(tc)))
    tf=pl.col(tc).is_not_null()&~sf
    exitp=(pl.when(sf).then(pl.col("entryPrice")*(1-pl.col("stopPct")))
           .when(tf).then(pl.col("entryPrice")*(1+target))
           .otherwise(pl.col("eod_close")))
    gross=exitp/pl.col("entryPrice")-1
    name=pl.concat_str([pl.col("family"),pl.lit("_TOP"),pl.col("topN").cast(pl.Utf8),pl.lit(f"_TP{int(target*100)}")])
    return x.with_columns([
      pl.col("date").cast(pl.Datetime).alias("tradeTime"),name.alias("candidate"),
      pl.lit(target).alias("targetPct"),exitp.alias("exitPrice"),
      gross.alias("grossReturn"),(gross-COST).alias("netReturn"),
      pl.when(sf).then(pl.lit("STOP")).when(tf).then(pl.lit(f"TP{int(target*100)}")).otherwise(pl.lit("EOD")).alias("exitReason")
    ])

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--out-dir",required=True);a=ap.parse_args()
    out=Path(a.out_dir);out.mkdir(parents=True,exist_ok=True)
    raw,audits=v3.load_days();x=v3.prepare(raw);base=build_base(x);path=execute(base)
    reports={};ledgers={};grid=[]
    for family in FAMILIES:
      for n in TOPS:
        sub=path.filter((pl.col("family")==family)&(pl.col("topN")==n))
        for target in TARGETS:
          name=f"{family}_TOP{n}_TP{int(target*100)}";tr=materialize(sub,target)
          train=tr.filter(pl.col("date")<pl.lit(BOUNDARY));held=tr.filter(pl.col("date")>=pl.lit(BOUNDARY))
          tm=common.metrics(train,"US_STOCK");hm=common.metrics(held,"US_STOCK");fm=common.metrics(tr,"US_STOCK")
          reports[name]={"candidate":name,"family":family,"topN":n,"targetPct":target,"trainFirstTwoYears":tm,"heldoutLastYear":hm,"observedThreeYear":fm}
          ledgers[name]=tr
          grid.append({"candidate":name,"trainReturn":tm["totalReturn"],"trainMdd":tm["mdd"],"trainPF":tm["profitFactor"],"trainPositiveMonthRate":tm["positiveMonthRate"],"heldoutReturn":hm["totalReturn"],"heldoutMdd":hm["mdd"],"heldoutPF":hm["profitFactor"],"heldoutPositiveMonthRate":hm["positiveMonthRate"],"threeYearReturn":fm["totalReturn"]})
    elig=[k for k,r in reports.items() if r["trainFirstTwoYears"]["tradeCount"]>=50]
    winner=max(elig,key=lambda k:common.choose_key(reports[k]["trainFirstTwoYears"],k))
    sel=reports[winner];sel["heldoutGate"]=common.gate(sel["heldoutLastYear"])
    ledgers[winner].sort(["date","symbol"]).write_csv(out/"selected-ledger.csv")
    pd.DataFrame(grid).sort_values(["trainPositiveMonthRate","trainReturn"],ascending=[False,False]).to_csv(out/"candidate-grid.csv",index=False)
    summary={"schemaVersion":1,"contract":"hunter-us-path-full-grid-v4","market":"US_STOCK","source":{"provider":v3.census.US_DATASET,"months":audits},
      "design":{"families":list(FAMILIES),"topN":list(TOPS),"targets":list(TARGETS),"entry":"09:40 ET","path":"chronological 1m","sameMinuteTie":"STOP_FIRST","cost":COST,"heldoutUsedForSelection":False},
      "selected":sel,"truthBoundary":{"profitabilityProven":False,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)
if __name__=="__main__":main()
