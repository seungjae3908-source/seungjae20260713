#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from pathlib import Path
import pandas as pd, polars as pl
from huggingface_hub import hf_hub_download,list_repo_files
DATASET="rogerdehe/klines-binance"; START=pd.Timestamp("2023-04-01",tz="UTC"); END=pd.Timestamp("2026-04-01",tz="UTC")
def sym(path,market):
 s=Path(path).stem.upper()
 return s.replace("_USDT","USDT") if market=="CRYPTO_SPOT" else s.replace("_USDT_USDT","USDT")
def fexpr(c,h,kind):
 b=pl.col(c).shift(-1).reverse()
 return (b.rolling_max(h,min_samples=1) if kind=="max" else b.rolling_min(h,min_samples=1)).reverse()
def one(file,market):
 p=hf_hub_download(repo_id=DATASET,repo_type="dataset",filename=file)
 x=(pl.scan_parquet(p).select(["date","open","high","low","close","volume"])
    .filter((pl.col("date")>=pl.lit(START.to_pydatetime()))&(pl.col("date")<pl.lit(END.to_pydatetime()))).collect().sort("date"))
 if x.height<100:return pl.DataFrame()
 x=x.with_columns([((pl.col("high")+pl.col("low")+pl.col("close"))/3).alias("typ"),((pl.col("high")-pl.col("low"))/pl.col("close")).alias("rangePct")])
 x=x.with_columns([
  pl.col("volume").shift(1).rolling_mean(20,min_samples=10).alias("pv20"),pl.col("high").shift(1).rolling_max(20,min_samples=10).alias("h20"),pl.col("low").shift(1).rolling_min(20,min_samples=10).alias("l20"),
  pl.col("rangePct").shift(1).rolling_mean(4,min_samples=3).alias("r4"),pl.col("rangePct").shift(1).rolling_mean(20,min_samples=10).alias("r20"),
  (pl.col("typ")*pl.col("volume")).rolling_sum(20,min_samples=10).alias("pvsum"),pl.col("volume").rolling_sum(20,min_samples=10).alias("vsum"),
  (pl.col("close")/pl.col("close").shift(4)-1).alias("ret4"),(pl.col("close")/pl.col("close").shift(16)-1).alias("ret16"),
  pl.col("open").shift(-1).alias("entryPrice"),pl.col("date").shift(-1).alias("entryTime"),
  fexpr("high",16,"max").alias("hi16"),fexpr("low",16,"min").alias("lo16"),pl.col("close").shift(-16).alias("cl16"),
  fexpr("high",32,"max").alias("hi32"),fexpr("low",32,"min").alias("lo32"),pl.col("close").shift(-32).alias("cl32")
 ])
 x=x.with_columns([(pl.col("volume")/pl.col("pv20")).alias("vr"),(pl.col("pvsum")/pl.col("vsum")).alias("vwap"),(pl.col("close")/(pl.col("pvsum")/pl.col("vsum"))-1).alias("pv"),(pl.col("r4")/pl.col("r20")).alias("comp")])
 x=x.filter(pl.col("entryPrice").is_not_null()&pl.col("cl32").is_not_null()&pl.col("vr").is_finite()&pl.col("pv").is_finite())
 out=[]; directions=["LONG","SHORT"] if market=="CRYPTO_FUTURES" else ["LONG"]; symbol=sym(file,market)
 for d in directions:
  if d=="LONG":
   masks={"BREAKOUT_VOLUME":(pl.col("close")>=pl.col("h20")*1.001)&(pl.col("vr")>=1.5)&(pl.col("ret4")>0)&(pl.col("pv")>0),
          "COMPRESSION_BREAK":(pl.col("comp")<=.7)&(pl.col("close")>=pl.col("h20"))&(pl.col("vr")>=1.2),
          "TREND_WAVE":(pl.col("ret4")>=.01)&(pl.col("ret16")>=.02)&(pl.col("pv")>=.003)&(pl.col("vr")>=1.2)}
   score=pl.col("vr").clip(0,5)+pl.col("ret4").clip(0,.2)*20+pl.col("ret16").clip(0,.5)*8+pl.col("pv").clip(0,.2)*20
  else:
   masks={"BREAKOUT_VOLUME":(pl.col("close")<=pl.col("l20")*.999)&(pl.col("vr")>=1.5)&(pl.col("ret4")<0)&(pl.col("pv")<0),
          "COMPRESSION_BREAK":(pl.col("comp")<=.7)&(pl.col("close")<=pl.col("l20"))&(pl.col("vr")>=1.2),
          "TREND_WAVE":(pl.col("ret4")<=-.01)&(pl.col("ret16")<=-.02)&(pl.col("pv")<=-.003)&(pl.col("vr")>=1.2)}
   score=pl.col("vr").clip(0,5)+(-pl.col("ret4")).clip(0,.2)*20+(-pl.col("ret16")).clip(0,.5)*8+(-pl.col("pv")).clip(0,.2)*20
  for fam,m in masks.items():
   q=x.filter(m).with_columns([pl.lit(market).alias("market"),pl.lit(symbol).alias("symbol"),pl.lit(d).alias("direction"),pl.lit(fam).alias("family"),score.alias("score")]).select(["market","symbol","date","entryTime","direction","family","score","entryPrice","hi16","lo16","cl16","hi32","lo32","cl32","vr","ret4","ret16","pv","comp"])
   if q.height:
    q=q.with_columns([
     pl.col("date").dt.cast_time_unit("us").alias("date"),
     pl.col("entryTime").dt.cast_time_unit("us").alias("entryTime")
    ])
    out.append(q)
 return pl.concat(out,how="vertical") if out else pl.DataFrame()
def main():
 ap=argparse.ArgumentParser();ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"]);ap.add_argument("--shard-index",type=int,required=True);ap.add_argument("--shard-count",type=int,required=True);ap.add_argument("--out-dir",required=True);a=ap.parse_args()
 sub="spot" if a.market=="CRYPTO_SPOT" else "futures"; fs=sorted([f for f in list_repo_files(DATASET,repo_type="dataset") if f.startswith(f"{sub}/15m/") and f.endswith(".parquet") and "-mark" not in f and "-funding_rate" not in f and "-index" not in f]); mine=[f for i,f in enumerate(fs) if i%a.shard_count==a.shard_index]
 out=Path(a.out_dir);out.mkdir(parents=True,exist_ok=True);frames=[];fail=[]
 for i,f in enumerate(mine,1):
  try:
   q=one(f,a.market)
   if q.height:frames.append(q)
  except Exception as e:fail.append({"file":f,"error":str(e)[:240]})
  if i%10==0 or i==len(mine):print(json.dumps({"market":a.market,"shard":a.shard_index,"done":i,"assigned":len(mine),"frames":len(frames),"failures":len(fail)}),flush=True)
 c=pl.concat(frames,how="vertical") if frames else pl.DataFrame()
 if c.height:c.write_parquet(out/"candidates.parquet",compression="zstd")
 meta={"market":a.market,"shardIndex":a.shard_index,"sourceFiles":len(fs),"assignedFiles":len(mine),"candidateRows":c.height,"failedFiles":len(fail),"failurePreview":fail[:10]};(out/"meta.json").write_text(json.dumps(meta,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
 if len(fail)>max(3,int(len(mine)*.05)):raise RuntimeError(f"TOO_MANY_FAILURES:{len(fail)}/{len(mine)}")
 print(json.dumps({"FINAL":meta},ensure_ascii=False),flush=True)
if __name__=="__main__":main()
