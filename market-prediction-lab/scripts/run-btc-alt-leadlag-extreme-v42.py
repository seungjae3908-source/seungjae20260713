#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import io
import json
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import requests

ROOT=Path(__file__).resolve().parents[2]
V1_SCRIPT=ROOT/"market-prediction-lab"/"scripts"/"run-full-universe-3pct-hunter-causal-backtest-v1.py"
SPEC=importlib.util.spec_from_file_location("hunter_v1",V1_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("V1_IMPORT_FAILED")
v1=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v1)
census=v1.census

MARKETS=("CRYPTO_SPOT","CRYPTO_FUTURES")
START=pd.Timestamp("2023-04-01",tz="UTC")
TRAIN_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()
POST_END=pd.Timestamp("2026-10-01").date()

BTC_EVENT_MIN=0.01
RESPONSE_RATIOS=(0.25,0.50,0.75)
LIQUIDITY_BANDS=(0.25,0.50,1.00)
TOP_NS=(1,3,5,10)
TARGETS=(0.03,0.05)
STOPS=(0.015,)
HOLDS=(15,30,60)
COSTS={"CRYPTO_SPOT":0.0020,"CRYPTO_FUTURES":0.0012}
EXCLUDED={"BTCUSDT","USDCUSDT","FDUSDUSDT","TUSDUSDT","BUSDUSDT","DAIUSDT","USDPUSDT"}


def month_range(start="2023-04",end="2026-10"):
    cur=pd.Period(start,freq="M"); stop=pd.Period(end,freq="M")
    while cur<stop:
        yield str(cur)
        cur+=1


def btc_month_url(market,month):
    if market=="CRYPTO_SPOT":
        return f"https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-{month}.zip"
    return f"https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-{month}.zip"


def alt_day_url(market,symbol,day):
    if market=="CRYPTO_SPOT":
        return f"https://data.binance.vision/data/spot/daily/klines/{symbol}/1m/{symbol}-1m-{day}.zip"
    return f"https://data.binance.vision/data/futures/um/daily/klines/{symbol}/1m/{symbol}-1m-{day}.zip"


def parse_kline_bytes(content):
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        names=[n for n in zf.namelist() if n.lower().endswith(".csv")]
        if not names:
            return None
        x=pd.read_csv(zf.open(names[0]),header=None)
    if x.empty:
        return None
    try: float(x.iloc[0,0])
    except Exception: x=x.iloc[1:].reset_index(drop=True)
    if x.shape[1]<11:
        return None
    x=x.iloc[:,:12]
    x.columns=["open_time","open","high","low","close","volume","close_time","quote_volume","trades","taker_buy_volume","taker_buy_quote","ignore"]
    for c in ["open_time","open","high","low","close","volume","quote_volume","trades","taker_buy_quote"]:
        x[c]=pd.to_numeric(x[c],errors="coerce")
    x=x.dropna(subset=["open_time","open","high","low","close","quote_volume"])
    if x.empty:
        return None
    unit="us" if float(x["open_time"].median())>1e14 else "ms"
    x["timestamp"]=pd.to_datetime(x["open_time"].astype("int64"),unit=unit,utc=True,errors="coerce")
    return x.dropna(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)


def fetch_url(url,attempts=4):
    last=None
    for i in range(attempts):
        try:
            r=requests.get(url,timeout=60,headers={"User-Agent":"market-prediction-lab/btc-alt-leadlag-v4"})
            if r.status_code==404:
                return None,"404"
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            return r.content,None
        except Exception as e:
            last=e
            time.sleep(min(1.5*(i+1),6))
    return None,repr(last)


def load_btc_events(market):
    frames=[]; failures=[]
    for month in month_range():
        content,err=fetch_url(btc_month_url(market,month))
        if content is None:
            failures.append({"month":month,"error":err}); continue
        x=parse_kline_bytes(content)
        if x is None or x.empty:
            failures.append({"month":month,"error":"EMPTY"}); continue
        frames.append(x[["timestamp","open","close"]])
    if len(frames)<40:
        raise RuntimeError(f"BTC_MONTH_COVERAGE_LOW:{len(frames)}")
    b=pd.concat(frames,ignore_index=True).sort_values("timestamp").drop_duplicates("timestamp")
    b["ret1"]=b["close"]/b["close"].shift(1)-1.0
    b=b[(b["timestamp"]>=START)&(b["timestamp"]<pd.Timestamp("2026-10-01",tz="UTC"))].copy()
    if market=="CRYPTO_SPOT":
        e=b[b["ret1"]>=BTC_EVENT_MIN].copy()
        e["direction"]="LONG"
    else:
        up=b[b["ret1"]>=BTC_EVENT_MIN].copy(); up["direction"]="LONG"
        dn=b[b["ret1"]<=-BTC_EVENT_MIN].copy(); dn["direction"]="SHORT"
        e=pd.concat([up,dn],ignore_index=True).sort_values("timestamp")
    e["day"]=e["timestamp"].dt.strftime("%Y-%m-%d")
    e["month"]=e["timestamp"].dt.strftime("%Y-%m")
    return e[["timestamp","ret1","direction","day","month"]].reset_index(drop=True),{
        "monthsLoaded":len(frames),"failures":failures,"eventCount":len(e),
        "eventDays":int(e["day"].nunique()),
    }


def universe_and_liquidity(market):
    raw,meta=census.load_crypto(market)
    pdf=raw.select(["symbol","date","close","volume"]).to_pandas()
    pdf["date"]=pd.to_datetime(pdf["date"])
    pdf=pdf[pdf["symbol"].astype(str).str.endswith("USDT")].copy()
    pdf=pdf[~pdf["symbol"].astype(str).isin(EXCLUDED)]
    pdf["dollar"]=pd.to_numeric(pdf["close"],errors="coerce")*pd.to_numeric(pdf["volume"],errors="coerce")
    pdf["month"]=pdf["date"].dt.to_period("M").astype(str)
    life=(pdf.groupby("symbol",as_index=False).agg(firstDate=("date","min"),lastDate=("date","max")))
    monthly=(pdf.groupby(["month","symbol"],as_index=False).agg(days=("date","nunique"),avgDollar=("dollar","mean")))
    monthly=monthly[(monthly["days"]>=5)&monthly["avgDollar"].notna()].copy()
    monthly["liqPct"]=monthly.groupby("month")["avgDollar"].rank(pct=True,method="average",ascending=True)
    liq={(str(r.symbol),str(r.month)):(float(r.avgDollar),float(r.liqPct)) for r in monthly.itertuples(index=False)}
    life_map={str(r.symbol):(pd.Timestamp(r.firstDate).date(),pd.Timestamp(r.lastDate).date()) for r in life.itertuples(index=False)}
    march=set(monthly[monthly["month"]=="2026-03"]["symbol"].astype(str))
    return sorted(life_map),life_map,liq,march,meta


def eligible_symbols_for_day(day,symbols,life_map,march):
    d=pd.Timestamp(day).date()
    if d < pd.Timestamp("2026-04-01").date():
        return [s for s in symbols if life_map[s][0] <= d <= life_map[s][1]]
    return [s for s in symbols if s in march]


def prior_liq(liq,symbol,event_month):
    prev=str(pd.Period(event_month,freq="M")-1)
    val=liq.get((symbol,prev))
    if val is None:
        val=liq.get((symbol,event_month))
    return val


def process_symbol_day(args):
    market,symbol,day,events,liq=args
    content,err=fetch_url(alt_day_url(market,symbol,day))
    if content is None:
        return [],{"symbol":symbol,"day":day,"error":err}
    g=parse_kline_bytes(content)
    if g is None or len(g)<3:
        return [],{"symbol":symbol,"day":day,"error":"EMPTY"}
    idx={pd.Timestamp(t):i for i,t in enumerate(g["timestamp"])}
    rows=[]
    for ev in events:
        t=pd.Timestamp(ev["timestamp"])
        i=idx.get(t)
        if i is None or i<1 or i+1>=len(g):
            continue
        prev=float(g["close"].iloc[i-1]); now=float(g["close"].iloc[i])
        if prev<=0: continue
        alt_ret=now/prev-1.0
        btc_ret=float(ev["ret1"])
        direction=str(ev["direction"])
        signed_alt=alt_ret if direction=="LONG" else -alt_ret
        btc_abs=abs(btc_ret)
        response_ratio=signed_alt/btc_abs if btc_abs>0 else np.nan
        entry_i=i+1
        entry=float(g["open"].iloc[entry_i])
        if entry<=0: continue
        liq_val=prior_liq(liq,symbol,str(ev["month"]))
        if liq_val is None:
            avg_dollar=np.nan; liq_pct=np.nan
        else:
            avg_dollar,liq_pct=liq_val
        for hold in HOLDS:
            end_i=min(len(g)-1,entry_i+hold-1)
            highs=g["high"].iloc[entry_i:end_i+1].to_numpy(float)
            lows=g["low"].iloc[entry_i:end_i+1].to_numpy(float)
            closes=g["close"].iloc[entry_i:end_i+1].to_numpy(float)
            for target in TARGETS:
                stop=STOPS[0]
                exit_price=float(closes[-1]); reason="TIME"; exit_i=end_i
                if direction=="LONG":
                    tp=entry*(1+target); sl=entry*(1-stop)
                    for k in range(entry_i,end_i+1):
                        if float(g["low"].iloc[k])<=sl:
                            exit_price=sl; reason="STOP"; exit_i=k; break
                        if float(g["high"].iloc[k])>=tp:
                            exit_price=tp; reason="TARGET"; exit_i=k; break
                    gross=exit_price/entry-1.0
                    mfe=float(np.max(highs))/entry-1.0
                    mae=1.0-float(np.min(lows))/entry
                else:
                    tp=entry*(1-target); sl=entry*(1+stop)
                    for k in range(entry_i,end_i+1):
                        if float(g["high"].iloc[k])>=sl:
                            exit_price=sl; reason="STOP"; exit_i=k; break
                        if float(g["low"].iloc[k])<=tp:
                            exit_price=tp; reason="TARGET"; exit_i=k; break
                    gross=1.0-exit_price/entry
                    mfe=1.0-float(np.min(lows))/entry
                    mae=float(np.max(highs))/entry-1.0
                rows.append({
                    "date":t.date(),"timestamp":t,"symbol":symbol,"direction":direction,
                    "btcRet1":btc_ret,"altRet1":alt_ret,"signedAltRet1":signed_alt,
                    "responseRatio":response_ratio,"lagGap":btc_abs-signed_alt,
                    "avgDollarPriorMonth":avg_dollar,"liquidityPct":liq_pct,
                    "holdMinutes":hold,"targetPct":target,"stopPct":stop,
                    "entryPrice":entry,"exitPrice":exit_price,"grossReturn":gross,
                    "roundTripCost":COSTS[market],"netReturn":gross-COSTS[market],
                    "MFE":mfe,"MAE":mae,"exitReason":reason,
                    "entryTime":pd.Timestamp(g["timestamp"].iloc[entry_i]),
                    "exitTime":pd.Timestamp(g["timestamp"].iloc[exit_i]),
                })
    return rows,None


def download_and_build_outcomes(market,events,symbols,life_map,liq,march):
    event_by_day={}
    for day,g in events.groupby("day"):
        event_by_day[str(day)]=g.to_dict("records")
    tasks=[]
    for day,evs in event_by_day.items():
        for s in eligible_symbols_for_day(day,symbols,life_map,march):
            tasks.append((market,s,day,evs,liq))
    rows=[]; failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
        futs=[pool.submit(process_symbol_day,t) for t in tasks]
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            r,err=fut.result()
            if r: rows.extend(r)
            if err and err.get("error")!="404": failures.append(err)
            if idx%1000==0 or idx==len(futs):
                print(json.dumps({
                    "leadLagDailyFilesComplete":idx,"tasks":len(futs),
                    "outcomeRows":len(rows),"non404Failures":len(failures),"market":market
                }),flush=True)
    if not rows:
        raise RuntimeError("NO_LEADLAG_OUTCOMES")
    return pd.DataFrame(rows),{
        "plannedSymbolDays":len(tasks),"outcomeRows":len(rows),
        "non404Failures":len(failures),"failurePreview":failures[:40],
    }


def deoverlap(pdf,hold):
    if pdf.empty: return pdf
    keep=[]
    for symbol,g in pdf.sort_values("timestamp").groupby("symbol",sort=False):
        next_ok=None
        for idx,row in g.iterrows():
            t=pd.Timestamp(row["timestamp"])
            if next_ok is not None and t<next_ok: continue
            keep.append(idx)
            next_ok=pd.Timestamp(row["entryTime"])+pd.Timedelta(minutes=int(hold))
    return pdf.loc[keep].copy()


def metrics_pdf(pdf,market,start,end):
    if pdf.empty:
        pl_df=pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    else:
        pl_df=pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))
    dates=[d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]
    return v1.metrics(pl_df,market,dates)


def active_month_rate(m):
    pos=int(m.get("monthsPositive") or 0)
    neg=int(m.get("monthsNegative") or 0)
    active=pos+neg
    return (pos/active) if active else 0.0

def gate(m,min_trades,min_active_months):
    amr=active_month_rate(m)
    active_months=int(m.get("monthsPositive") or 0)+int(m.get("monthsNegative") or 0)
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
        "positiveActiveMonthRateAtLeast50pct":amr>=0.50,
        "minimumActiveMonths":active_months>=min_active_months,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks,"activeMonthPositiveRate":amr,"activeMonths":active_months}


def candidate_rows(outcomes,response_max,liq_max,top_n,hold,target,direction):
    x=outcomes[
        (outcomes["direction"]==direction)
        &(outcomes["holdMinutes"]==hold)
        &(outcomes["targetPct"]==target)
        &(pd.to_numeric(outcomes["responseRatio"],errors="coerce")<=response_max)
        &(pd.to_numeric(outcomes["liquidityPct"],errors="coerce")<=liq_max)
    ].copy()
    if x.empty: return x
    x=x.sort_values(["timestamp","lagGap","avgDollarPriorMonth"],ascending=[True,False,True])
    x=x.groupby("timestamp",group_keys=False).head(top_n)
    return deoverlap(x,hold)


def rank_key(m,name):
    return (
        active_month_rate(m),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 1),
        int(m.get("tradeCount") or 0),
        name,
    )


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",required=True,choices=MARKETS)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    market=args.market
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    events,event_audit=load_btc_events(market)
    symbols,life_map,liq,march,source_meta=universe_and_liquidity(market)
    outcomes,download_audit=download_and_build_outcomes(market,events,symbols,life_map,liq,march)
    outcomes["date"]=pd.to_datetime(outcomes["date"]).dt.date

    directions=["LONG"] if market=="CRYPTO_SPOT" else ["LONG","SHORT"]
    reports={}; grid=[]; ledgers={}
    for direction in directions:
        for response_max in RESPONSE_RATIOS:
            for liq_max in LIQUIDITY_BANDS:
                for top_n in TOP_NS:
                    for hold in HOLDS:
                        for target in TARGETS:
                            name=f"{direction}_BTC1P_LAG{response_max:.2f}_LIQ{liq_max:.2f}_TOP{top_n}_H{hold}_TP{int(target*100)}"
                            trades=candidate_rows(outcomes,response_max,liq_max,top_n,hold,target,direction)
                            mt=metrics_pdf(trades[trades["date"]<TRAIN_END],market,"2023-04-01",str(TRAIN_END))
                            mc=metrics_pdf(trades[(trades["date"]>=TRAIN_END)&(trades["date"]<CAL_END)],market,str(TRAIN_END),str(CAL_END))
                            mv=metrics_pdf(trades[(trades["date"]>=CAL_END)&(trades["date"]<VAL_END)],market,str(CAL_END),str(VAL_END))
                            mp=metrics_pdf(trades[(trades["date"]>=VAL_END)&(trades["date"]<POST_END)],market,str(VAL_END),str(POST_END))
                            gt=gate(mt,30,6); gc=gate(mc,10,3); gv=gate(mv,10,4); gp=gate(mp,8,3)
                            eligible=gt["pass"] and gc["pass"]
                            reports[name]={
                                "direction":direction,"responseMax":response_max,"liquidityMax":liq_max,
                                "topN":top_n,"holdMinutes":hold,"targetPct":target,
                                "train":mt,"calibration":mc,"validation":mv,"postHocBenchmark":mp,
                                "trainGate":gt,"calibrationGate":gc,"validationGate":gv,"postHocGate":gp,
                                "eligibleAfterCalibration":eligible,
                            }
                            if eligible: ledgers[name]=trades
                            grid.append({
                                "candidate":name,"direction":direction,"responseMax":response_max,"liquidityMax":liq_max,"topN":top_n,"holdMinutes":hold,"targetPct":target,
                                "trainPass":gt["pass"],"trainReturn":mt.get("totalReturn"),"trainPF":mt.get("profitFactor"),"trainMDD":mt.get("mdd"),"trainPosMonthRate":mt.get("positiveMonthRate"),"trainActiveMonthRate":gt["activeMonthPositiveRate"],"trainActiveMonths":gt["activeMonths"],"trainTrades":mt.get("tradeCount"),
                                "calibrationPass":gc["pass"],"calibrationReturn":mc.get("totalReturn"),"calibrationPF":mc.get("profitFactor"),"calibrationMDD":mc.get("mdd"),"calibrationPosMonthRate":mc.get("positiveMonthRate"),"calibrationActiveMonthRate":gc["activeMonthPositiveRate"],"calibrationActiveMonths":gc["activeMonths"],"calibrationTrades":mc.get("tradeCount"),
                                "validationPass":gv["pass"],"validationReturn":mv.get("totalReturn"),"validationPF":mv.get("profitFactor"),"validationMDD":mv.get("mdd"),"validationPosMonthRate":mv.get("positiveMonthRate"),"validationActiveMonthRate":gv["activeMonthPositiveRate"],"validationActiveMonths":gv["activeMonths"],"validationTrades":mv.get("tradeCount"),
                                "postHocReturn":mp.get("totalReturn"),"postHocPF":mp.get("profitFactor"),"postHocMDD":mp.get("mdd"),"postHocPosMonthRate":mp.get("positiveMonthRate"),"postHocActiveMonthRate":gp["activeMonthPositiveRate"],"postHocActiveMonths":gp["activeMonths"],"postHocTrades":mp.get("tradeCount"),
                                "distinctSymbols":int(trades["symbol"].nunique()) if len(trades) else 0,
                                "activeEventTimes":int(trades["timestamp"].nunique()) if len(trades) else 0,
                            })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    passes=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None
    pdf=pd.DataFrame(grid)
    pdf.to_csv(out/"candidate-grid.csv",index=False)
    if len(pdf):
        pdf.sort_values(["calibrationPass","calibrationReturn","calibrationPF"],ascending=[False,False,False]).head(50).to_csv(out/"top50-calibration.csv",index=False)
        pdf.sort_values(["validationReturn","validationPF"],ascending=[False,False]).head(50).to_csv(out/"top50-validation-diagnostic.csv",index=False)
    if selected and selected in ledgers:
        ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)

    summary={
        "schemaVersion":1,
        "contract":"btc-alt-leadlag-extreme-v42",
        "market":market,
        "source":source_meta,
        "btcEventAudit":event_audit,
        "fullUSDTAltUniverse":len(symbols),
        "freshFrozenMarchUniverse":len(march),
        "downloadAudit":download_audit,
        "candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(passes),
        "validationPassCandidates":passes,
        "selectedByCalibration":selected,
        "selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "allUSDTAltSymbolsConsideredOnEachEligibleEventDay":True,
            "btcEventUsesCompletedOneMinuteReturn":True,
            "altResponseUsesSameCompletedMinuteOnly":True,
            "entryNextMinuteOpen":True,
            "btcThresholdAbsoluteOnePct":True,
            "spotLongOnly":market=="CRYPTO_SPOT",
            "futuresLongShort":market=="CRYPTO_FUTURES",
            "stopFirstConservativeWithinOneMinuteBar":True,
            "selectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "eventGateUsesPositiveActiveMonthsNotCalendarMonths":True,
            "noTradeMonthsAreNeutralNotFailures":True,
            "minimumActiveMonthsTrainCalibrationValidationPostHoc":[6,3,4,3],
            "gateCorrectionAppliedUniformlyBeforeReadingV42ValidationResults":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
