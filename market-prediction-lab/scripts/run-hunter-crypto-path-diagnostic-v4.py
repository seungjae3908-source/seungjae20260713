#!/usr/bin/env python3
from __future__ import annotations
import argparse, importlib.util, json
from pathlib import Path
import numpy as np, pandas as pd, polars as pl
from huggingface_hub import hf_hub_download

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("common",ROOT/"market-prediction-lab/scripts/hunter_v3_common.py")
if spec is None or spec.loader is None: raise RuntimeError("COMMON_IMPORT_FAILED")
common=importlib.util.module_from_spec(spec); spec.loader.exec_module(common)

DATASET="rogerdehe/klines-binance"
BOUNDARY=pd.Timestamp("2025-04-01",tz="UTC")
COSTS={"CRYPTO_SPOT":0.0020,"CRYPTO_FUTURES":0.0012}

def source_file(symbol:str,market:str)->str:
    if not symbol.endswith("USDT"): raise RuntimeError("BAD_SYMBOL:"+symbol)
    base=symbol[:-4]
    if market=="CRYPTO_SPOT": return f"spot/15m/{base}_USDT.parquet"
    return f"futures/15m/{base}_USDT_USDT.parquet"

def ts_us(v)->int:
    t=pd.Timestamp(v)
    if t.tzinfo is None: t=t.tz_localize("UTC")
    else: t=t.tz_convert("UTC")
    return int(t.value//1000)

def execute_group(symbol:str,rows:list[dict],market:str)->tuple[list[dict],str|None]:
    file=source_file(symbol,market)
    try:
        path=hf_hub_download(repo_id=DATASET,repo_type="dataset",filename=file)
        bars=pl.read_parquet(path).select(["date","open","high","low","close"]).sort("date")
        bars=bars.with_columns(pl.col("date").dt.cast_time_unit("us").alias("date"))
    except Exception as exc:
        return [],f"{file}:{exc}"
    dates=bars["date"].to_list()
    keys={ts_us(v):i for i,v in enumerate(dates)}
    high=bars["high"].cast(pl.Float64).to_numpy()
    low=bars["low"].cast(pl.Float64).to_numpy()
    close=bars["close"].cast(pl.Float64).to_numpy()
    out=[]
    for row in rows:
        key=ts_us(row["entryTime"])
        idx=keys.get(key)
        if idx is None: continue
        h=int(float(row["horizonBars"]))
        target=float(row["targetPct"]); stop=float(row["stopPct"]); entry=float(row["entryPrice"])
        direction=row["direction"]
        end=min(idx+h,len(high))
        reason="HORIZON_CLOSE"; exit_px=float(close[end-1]) if end>idx else float(close[idx])
        exit_time=dates[end-1] if end>idx else dates[idx]
        for j in range(idx,end):
            if direction=="LONG":
                sh=float(low[j])<=entry*(1-stop); th=float(high[j])>=entry*(1+target)
                if sh:
                    exit_px=entry*(1-stop); reason="STOP"; exit_time=dates[j]; break
                if th:
                    exit_px=entry*(1+target); reason=f"TP{int(target*100)}"; exit_time=dates[j]; break
            else:
                sh=float(high[j])>=entry*(1+stop); th=float(low[j])<=entry*(1-target)
                if sh:
                    exit_px=entry*(1+stop); reason="STOP"; exit_time=dates[j]; break
                if th:
                    exit_px=entry*(1-target); reason=f"TP{int(target*100)}"; exit_time=dates[j]; break
        gross=(exit_px/entry-1) if direction=="LONG" else (1-exit_px/entry)
        out.append({
            "market":market,"symbol":symbol,"direction":direction,"candidate":row["candidate"],
            "entryTime":str(row["entryTime"]),"exitTime":str(exit_time),
            "entryPrice":entry,"exitPrice":exit_px,"horizonBars":h,"targetPct":target,"stopPct":stop,
            "grossReturn":gross,"netReturn":gross-COSTS[market],"exitReason":reason
        })
    return out,None

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--input-root",required=True)
    ap.add_argument("--out-dir",required=True)
    a=ap.parse_args()
    files=list(Path(a.input_root).glob("**/selected-ledger.csv"))
    if not files: raise RuntimeError("NO_SELECTED_LEDGER")
    ledger=pd.read_csv(files[0])
    ledger=ledger[ledger["market"]==a.market].copy()
    if ledger.empty: raise RuntimeError("EMPTY_MARKET_LEDGER")
    groups={s:g.to_dict("records") for s,g in ledger.groupby("symbol")}
    results=[]; failures=[]
    for i,(symbol,rows) in enumerate(groups.items(),1):
        part,err=execute_group(str(symbol),rows,a.market)
        results.extend(part)
        if err: failures.append(err)
        if i%25==0 or i==len(groups):
            print(json.dumps({"market":a.market,"symbolsDone":i,"symbols":len(groups),"tradesDone":len(results),"failures":len(failures)}),flush=True)
    if len(results)<int(len(ledger)*0.95):
        raise RuntimeError(f"PATH_COVERAGE_TOO_LOW:{len(results)}/{len(ledger)} failures={len(failures)}")
    out=Path(a.out_dir); out.mkdir(parents=True,exist_ok=True)
    frame=pl.DataFrame(results).with_columns(pl.col("entryTime").str.to_datetime(time_zone="UTC").alias("entryTime"))
    frame.write_csv(out/"path-ledger.csv")
    train=frame.filter(pl.col("entryTime")<pl.lit(BOUNDARY.to_pydatetime()))
    held=frame.filter(pl.col("entryTime")>=pl.lit(BOUNDARY.to_pydatetime()))
    tm=common.metrics(train,a.market,time_col="entryTime")
    hm=common.metrics(held,a.market,time_col="entryTime")
    fm=common.metrics(frame,a.market,time_col="entryTime")
    summary={"schemaVersion":1,"contract":"hunter-crypto-path-diagnostic-v4","market":a.market,
      "candidateSet":sorted(ledger["candidate"].dropna().unique().tolist()),
      "source":{"provider":DATASET,"timeframe":"15m","sourceTrades":int(len(ledger)),"pathTrades":int(len(results)),"failedSymbols":len(failures)},
      "execution":{"path":"chronological 15m bars","sameBarTie":"STOP_FIRST","roundTripCost":COSTS[a.market]},
      "trainFirstTwoYears":tm,"heldoutLastYear":hm,"observedThreeYear":fm,"heldoutGate":common.gate(hm),
      "truthBoundary":{"signalRefit":False,"heldoutUsedForSelection":False,"pathOrderingImproved":True,"profitabilityProven":False,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)
if __name__=="__main__":main()
