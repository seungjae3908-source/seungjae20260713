#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import io
import json
import math
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import requests

ROOT = Path(__file__).resolve().parents[2]
V1_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC = importlib.util.spec_from_file_location("hunter_v1", V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v1)
census = v1.census

TRAIN_END = pd.Timestamp("2025-04-01").date()
VALID_END = pd.Timestamp("2026-04-01").date()
OOS_END = pd.Timestamp("2026-10-01").date()
TOP_LIQUID = 30

FLOW_THRESHOLDS = (0.08, 0.15)
RVOL_THRESHOLDS = (1.5, 2.5)
RET_THRESHOLDS = (0.00, 0.01)
TAKER_LONG = (0.55, 0.60)
TAKER_SHORT = (0.45, 0.40)
TOP_NS = (1, 3)
TARGETS = (0.03, 0.05)
STOPS = (0.015, 0.025)
HOLDS = (16, 32)

COSTS = {"CRYPTO_SPOT":0.0020, "CRYPTO_FUTURES":0.0012}


def month_range(start: str, end_exclusive: str):
    cur = pd.Period(start, freq="M")
    end = pd.Period(end_exclusive, freq="M")
    while cur < end:
        yield str(cur)
        cur += 1


def monthly_universe(market: str) -> dict[str, list[str]]:
    loaded, _ = census.load_crypto(market)
    pdf = loaded.select(["symbol","date","close","volume"]).to_pandas()
    pdf["date"] = pd.to_datetime(pdf["date"])
    pdf["month"] = pdf["date"].dt.to_period("M").astype(str)
    pdf["dollar"] = pdf["close"].astype(float) * pdf["volume"].astype(float)
    monthly = (
        pdf.groupby(["month","symbol"], as_index=False)["dollar"].mean()
        .sort_values(["month","dollar"], ascending=[True,False])
    )
    top_by_month = {
        month: g.head(TOP_LIQUID)["symbol"].astype(str).tolist()
        for month,g in monthly.groupby("month")
    }
    result = {}
    for m in month_range("2023-05","2026-04"):
        prev = str(pd.Period(m,freq="M") - 1)
        result[m] = top_by_month.get(prev, [])
    frozen = top_by_month.get("2026-03", [])
    for m in month_range("2026-04","2026-10"):
        result[m] = list(frozen)
    return result


def data_url(market: str, symbol: str, month: str) -> str:
    if market == "CRYPTO_SPOT":
        return f"https://data.binance.vision/data/spot/monthly/klines/{symbol}/15m/{symbol}-15m-{month}.zip"
    return f"https://data.binance.vision/data/futures/um/monthly/klines/{symbol}/15m/{symbol}-15m-{month}.zip"


def fetch_month_symbol(market: str, symbol: str, month: str):
    url = data_url(market,symbol,month)
    last = None
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=45, headers={"User-Agent":"market-prediction-lab/crypto-flow-v3"})
            if r.status_code == 404:
                return month,symbol,None,"404"
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            z = zipfile.ZipFile(io.BytesIO(r.content))
            name = z.namelist()[0]
            raw = pd.read_csv(z.open(name), header=None)
            if raw.empty:
                return month,symbol,None,"EMPTY"
            try:
                float(raw.iloc[0,0])
            except Exception:
                raw = raw.iloc[1:].reset_index(drop=True)
            if raw.shape[1] < 11:
                return month,symbol,None,f"BAD_COLUMNS:{raw.shape[1]}"
            raw = raw.iloc[:,:12]
            raw.columns=["open_time","open","high","low","close","volume","close_time","quote_volume","trades","taker_buy_volume","taker_buy_quote","ignore"]
            for c in ["open_time","open","high","low","close","volume","quote_volume","taker_buy_quote"]:
                raw[c]=pd.to_numeric(raw[c],errors="coerce")
            raw=raw.dropna(subset=["open_time","open","high","low","close","volume","quote_volume","taker_buy_quote"])
            if raw.empty:
                return month,symbol,None,"NO_NUMERIC"
            unit = "us" if float(raw["open_time"].median()) > 1e14 else "ms"
            raw["timestamp"]=pd.to_datetime(raw["open_time"].astype("int64"),unit=unit,utc=True)
            raw["symbol"]=symbol
            return month,symbol,raw[["timestamp","symbol","open","high","low","close","volume","quote_volume","taker_buy_quote"]],"OK"
        except Exception as exc:
            last=exc
            time.sleep(min(2*(attempt+1),8))
    return month,symbol,None,repr(last)


def load_bars(market: str) -> tuple[pd.DataFrame, dict]:
    universe = monthly_universe(market)
    tasks=[(m,s) for m,syms in universe.items() for s in syms]
    frames=[]
    failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futs={pool.submit(fetch_month_symbol,market,s,m):(m,s) for m,s in tasks}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            m,s=futs[fut]
            mm,ss,df,status=fut.result()
            if df is not None and not df.empty:
                frames.append(df)
            else:
                failures.append({"month":m,"symbol":s,"status":status})
            if idx%100==0 or idx==len(tasks):
                print(json.dumps({"cryptoV3DownloadComplete":idx,"tasks":len(tasks),"usableFiles":len(frames),"failures":len(failures),"market":market}),flush=True)
    if len(frames) < int(len(tasks)*0.80):
        raise RuntimeError(f"CRYPTO_V3_FILE_COVERAGE_TOO_LOW:{len(frames)}/{len(tasks)}")
    bars=pd.concat(frames,ignore_index=True).sort_values(["symbol","timestamp"])
    return bars,{"plannedFiles":len(tasks),"usableFiles":len(frames),"failedFiles":len(failures),"failurePreview":failures[:30],"topLiquidPerMonth":TOP_LIQUID}


def add_features(pdf: pd.DataFrame) -> pd.DataFrame:
    out=[]
    for symbol,g in pdf.groupby("symbol",sort=False):
        g=g.sort_values("timestamp").copy()
        q=g["quote_volume"].astype(float)
        tq=g["taker_buy_quote"].astype(float)
        base=g["volume"].astype(float)
        g["takerRatio"]=np.where(q>0,tq/q,np.nan)
        g["deltaQuote"]=2.0*tq-q
        g["prevQuoteMean96"]=q.shift(1).rolling(96,min_periods=48).mean()
        g["rvol"]=q/g["prevQuoteMean96"]
        g["vwap96"]=q.rolling(96,min_periods=48).sum()/base.rolling(96,min_periods=48).sum().replace(0,np.nan)
        g["prevClose"]=g["close"].shift(1)
        g["prevVwap"]=g["vwap96"].shift(1)
        g["flow4"]=g["deltaQuote"].rolling(4,min_periods=4).sum()/q.rolling(4,min_periods=4).sum().replace(0,np.nan)
        g["ret4"]=g["close"]/g["close"].shift(4)-1.0
        g["date"]=g["timestamp"].dt.date
        out.append(g)
    return pd.concat(out,ignore_index=True).dropna(subset=["rvol","vwap96","flow4","ret4","takerRatio","prevClose","prevVwap"])


def signal_frame(features: pl.DataFrame, market: str, family: str, direction: str, a: float, rv: float, ret: float|None, top_n: int) -> pl.DataFrame:
    if direction=="LONG":
        if family=="FLOW_TREND":
            mask=(pl.col("flow4")>=a)&(pl.col("rvol")>=rv)&(pl.col("ret4")>=float(ret))&(pl.col("close")>pl.col("vwap96"))
            score=pl.col("flow4")*3 + pl.col("rvol").clip(0,10)/10 + pl.col("ret4").clip(-0.2,0.2)
        else:
            mask=(pl.col("takerRatio")>=a)&(pl.col("rvol")>=rv)&(pl.col("prevClose")<=pl.col("prevVwap"))&(pl.col("close")>pl.col("vwap96"))
            score=(pl.col("takerRatio")-0.5)*4 + pl.col("rvol").clip(0,10)/10
    else:
        if family=="FLOW_TREND":
            mask=(pl.col("flow4")<=-a)&(pl.col("rvol")>=rv)&(pl.col("ret4")<=-float(ret))&(pl.col("close")<pl.col("vwap96"))
            score=(-pl.col("flow4"))*3 + pl.col("rvol").clip(0,10)/10 + (-pl.col("ret4")).clip(-0.2,0.2)
        else:
            mask=(pl.col("takerRatio")<=a)&(pl.col("rvol")>=rv)&(pl.col("prevClose")>=pl.col("prevVwap"))&(pl.col("close")<pl.col("vwap96"))
            score=(0.5-pl.col("takerRatio"))*4 + pl.col("rvol").clip(0,10)/10
    x=features.filter(mask).with_columns([
        score.alias("score"),
        pl.lit(direction).alias("direction"),
    ])
    if x.is_empty():
        return x
    x=(
        x.sort(["date","symbol","timestamp"])
        .group_by(["date","symbol"],maintain_order=True).head(1)
        .sort(["timestamp","score"],descending=[False,True])
        .group_by("timestamp",maintain_order=True).head(top_n)
    )
    return x


def union_signals(features: pl.DataFrame, market: str):
    directions=["LONG","SHORT"] if market=="CRYPTO_FUTURES" else ["LONG"]
    defs=[]
    frames=[]
    for direction in directions:
        for flow in FLOW_THRESHOLDS:
            for rv in RVOL_THRESHOLDS:
                for ret in RET_THRESHOLDS:
                    for top_n in TOP_NS:
                        key=f"FLOW_TREND_{direction}_F{flow:g}_RV{rv:g}_R{ret:g}_TOP{top_n}"
                        s=signal_frame(features,market,"FLOW_TREND",direction,flow,rv,ret,top_n)
                        defs.append((key,"FLOW_TREND",direction,flow,rv,ret,top_n))
                        if not s.is_empty():
                            frames.append(s.select(["timestamp","symbol","date"]).with_columns(pl.lit(key).alias("baseCandidate")))
        ratios=TAKER_LONG if direction=="LONG" else TAKER_SHORT
        for ratio in ratios:
            for rv in RVOL_THRESHOLDS:
                for top_n in TOP_NS:
                    key=f"FLOW_RECLAIM_{direction}_T{ratio:g}_RV{rv:g}_TOP{top_n}"
                    s=signal_frame(features,market,"FLOW_RECLAIM",direction,ratio,rv,None,top_n)
                    defs.append((key,"FLOW_RECLAIM",direction,ratio,rv,None,top_n))
                    if not s.is_empty():
                        frames.append(s.select(["timestamp","symbol","date"]).with_columns(pl.lit(key).alias("baseCandidate")))
    if not frames:
        raise RuntimeError(f"NO_V3_SIGNALS:{market}")
    union=pl.concat(frames,how="vertical").unique(subset=["timestamp","symbol"])
    return defs,union


def simulate_union(pdf: pd.DataFrame, union: pl.DataFrame, market: str) -> pl.DataFrame:
    sig={(str(r.symbol),pd.Timestamp(r.timestamp)):True for r in union.select(["symbol","timestamp"]).iter_rows(named=True)}
    rows=[]
    cost=COSTS[market]
    for symbol,g in pdf.groupby("symbol",sort=False):
        g=g.sort_values("timestamp").reset_index(drop=True)
        ts=list(g["timestamp"])
        opens=g["open"].to_numpy(float); highs=g["high"].to_numpy(float); lows=g["low"].to_numpy(float); closes=g["close"].to_numpy(float)
        for i,t in enumerate(ts[:-1]):
            if (str(symbol),pd.Timestamp(t)) not in sig:
                continue
            entry_i=i+1
            entry=float(opens[entry_i])
            if entry<=0: continue
            for hold in HOLDS:
                end_i=min(len(g)-1,entry_i+hold-1)
                for target in TARGETS:
                    for stop in STOPS:
                        tp=entry*(1+target); sl=entry*(1-stop)
                        exit_price=float(closes[end_i]); reason="TIME"; exit_i=end_i
                        for j in range(entry_i,end_i+1):
                            if lows[j]<=sl:
                                exit_price=sl; reason="STOP"; exit_i=j; break
                            if highs[j]>=tp:
                                exit_price=tp; reason="TARGET"; exit_i=j; break
                        gross=(exit_price/entry-1.0) if market=="CRYPTO_SPOT" else None
                        # direction is applied later; precompute both directions from same price path.
                        mfe_long=float(np.max(highs[entry_i:end_i+1]))/entry-1.0
                        mae_long=1.0-float(np.min(lows[entry_i:end_i+1]))/entry
                        rows.append({"timestamp":pd.Timestamp(t),"symbol":str(symbol),"holdBars":hold,"targetPct":target,"stopPct":stop,
                                     "entryPrice":entry,"longExitPrice":exit_price,"longExitReason":reason,"longExitTime":pd.Timestamp(ts[exit_i]),
                                     "longGross":exit_price/entry-1.0,"longNet":exit_price/entry-1.0-cost,"longMFE":mfe_long,"longMAE":mae_long})
                        # short path separately
                        tp_s=entry*(1-target); sl_s=entry*(1+stop)
                        exit_s=float(closes[end_i]); reason_s="TIME"; exit_si=end_i
                        for j in range(entry_i,end_i+1):
                            if highs[j]>=sl_s:
                                exit_s=sl_s; reason_s="STOP"; exit_si=j; break
                            if lows[j]<=tp_s:
                                exit_s=tp_s; reason_s="TARGET"; exit_si=j; break
                        rows[-1].update({"shortExitPrice":exit_s,"shortExitReason":reason_s,"shortExitTime":pd.Timestamp(ts[exit_si]),
                                         "shortGross":1.0-exit_s/entry,"shortNet":1.0-exit_s/entry-cost,
                                         "shortMFE":1.0-float(np.min(lows[entry_i:end_i+1]))/entry,
                                         "shortMAE":float(np.max(highs[entry_i:end_i+1]))/entry-1.0})
    if not rows:
        raise RuntimeError(f"NO_V3_OUTCOMES:{market}")
    return pl.from_pandas(pd.DataFrame(rows)).with_columns(pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")))


def gate(m: dict,min_trades:int):
    checks={"positiveReturn":float(m.get("totalReturn") or 0)>0,
            "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
            "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,
            "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
            "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades}
    return {"pass":all(checks.values()),"checks":checks}


def rank_key(m:dict,name:str):
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 0),int(m.get("tradeCount") or 0),name)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=["CRYPTO_SPOT","CRYPTO_FUTURES"])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    raw,source=load_bars(market)
    features_pd=add_features(raw)
    features=pl.from_pandas(features_pd).with_columns([
        pl.col("timestamp").cast(pl.Datetime(time_zone="UTC")),
        pl.col("date").cast(pl.Date),
    ])
    defs,union=union_signals(features,market)
    outcomes=simulate_union(features_pd,union,market)
    directions=["LONG","SHORT"] if market=="CRYPTO_FUTURES" else ["LONG"]

    train_dates=[d.date() for d in pd.date_range("2023-05-01","2025-03-31",freq="D")]
    valid_dates=[d.date() for d in pd.date_range("2025-04-01","2026-03-31",freq="D")]
    oos_dates=[d.date() for d in pd.date_range("2026-04-01","2026-09-30",freq="D")]

    grid=[]; reports={}
    for key,family,direction,a,rv,ret,top_n in defs:
        sig=signal_frame(features,market,family,direction,a,rv,ret,top_n)
        if sig.is_empty(): continue
        for target in TARGETS:
            for stop in STOPS:
                for hold in HOLDS:
                    name=f"{key}_TP{int(target*100)}_SL{stop:g}_H{hold}"
                    oc=outcomes.filter((pl.col("targetPct")==target)&(pl.col("stopPct")==stop)&(pl.col("holdBars")==hold))
                    joined=sig.join(oc,on=["timestamp","symbol"],how="inner")
                    if direction=="LONG":
                        trades=joined.with_columns([
                            pl.lit(market).alias("market"),pl.lit("LONG").alias("direction"),pl.lit(name).alias("candidate"),
                            pl.col("timestamp").dt.date().alias("date"),pl.col("entryPrice"),
                            pl.col("longExitPrice").alias("exitPrice"),pl.col("longGross").alias("grossReturn"),pl.col("longNet").alias("netReturn"),
                            pl.col("longMFE").alias("MFE"),pl.col("longMAE").alias("MAE"),pl.col("longExitReason").alias("exitReason"),
                            pl.lit(COSTS[market]).alias("roundTripCost"),
                        ])
                    else:
                        trades=joined.with_columns([
                            pl.lit(market).alias("market"),pl.lit("SHORT").alias("direction"),pl.lit(name).alias("candidate"),
                            pl.col("timestamp").dt.date().alias("date"),pl.col("entryPrice"),
                            pl.col("shortExitPrice").alias("exitPrice"),pl.col("shortGross").alias("grossReturn"),pl.col("shortNet").alias("netReturn"),
                            pl.col("shortMFE").alias("MFE"),pl.col("shortMAE").alias("MAE"),pl.col("shortExitReason").alias("exitReason"),
                            pl.lit(COSTS[market]).alias("roundTripCost"),
                        ])
                    train=trades.filter(pl.col("date")<pl.lit(TRAIN_END))
                    valid=trades.filter((pl.col("date")>=pl.lit(TRAIN_END))&(pl.col("date")<pl.lit(VALID_END)))
                    oos=trades.filter((pl.col("date")>=pl.lit(VALID_END))&(pl.col("date")<pl.lit(OOS_END)))
                    mt=v1.metrics(train,market,train_dates); mv=v1.metrics(valid,market,valid_dates); mo=v1.metrics(oos,market,oos_dates)
                    gt,gv,go=gate(mt,100),gate(mv,50),gate(mo,25)
                    reports[name]={"direction":direction,"family":family,"trades":trades,"train":mt,"validation":mv,"oos":mo,"trainGate":gt,"validationGate":gv,"oosGate":go}
                    grid.append({"candidate":name,"direction":direction,"family":family,"trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainTrades":mt.get("tradeCount"),
                                 "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationTrades":mv.get("tradeCount"),
                                 "oosReturn":mo.get("totalReturn"),"oosPF":mo.get("profitFactor"),"oosMDD":mo.get("mdd"),"oosPosMonthRate":mo.get("positiveMonthRate"),"oosTrades":mo.get("tradeCount")})

    winners={}
    for direction in directions:
        train_pass=[n for n,d in reports.items() if d["direction"]==direction and d["trainGate"]["pass"]]
        valid_pass=[n for n in train_pass if reports[n]["validationGate"]["pass"]]
        winner=sorted(valid_pass,key=lambda n:rank_key(reports[n]["validation"],n),reverse=True)[0] if valid_pass else None
        winners[direction]={"trainPassCount":len(train_pass),"validationPassCount":len(valid_pass),"winner":winner}
        if winner:
            d=reports[winner]
            winners[direction]["results"]={"train":d["train"],"validation":d["validation"],"freshOos":d["oos"],"freshOosGate":d["oosGate"]}
            cols=["market","date","timestamp","symbol","direction","candidate","entryPrice","exitPrice","grossReturn","roundTripCost","netReturn","MFE","MAE","exitReason","flow4","rvol","ret4","takerRatio","vwap96"]
            d["trades"].select(cols).write_csv(out/f"winner-{direction.lower()}-ledger.csv")

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    summary={"schemaVersion":1,"contract":"full-universe-3pct-hunter-crypto-flow-v3","market":market,"source":source,
             "periods":{"train":["2023-05-01","2025-04-01"],"validation":["2025-04-01","2026-04-01"],"freshOos":["2026-04-01","2026-10-01"]},
             "bars":len(features_pd),"unionSignals":union.height,"outcomeRows":outcomes.height,"candidateCount":len(grid),"winners":winners,
             "truthBoundary":{"signalUsesCompleted15mBar":True,"entryNext15mOpen":True,"freshOosAfterPriorResearch":True,"oiOverlayApplied":False,"profitabilityProven":False,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
