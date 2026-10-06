#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl

ROOT=Path(__file__).resolve().parents[2]

def load_module(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

dyn=load_module("dynamic_exit_v1","market-prediction-lab/scripts/run-crypto-futures-dynamic-exit-v1.py")
v1=load_module("hunter_v1","market-prediction-lab/scripts/run-full-universe-3pct-hunter-causal-backtest-v1.py")

SOURCE_CONTRACT="crypto-listing-event-v6"
SOURCE_MARKET="CRYPTO_FUTURES"
SOURCE_WINNER="SHORT_LIST_OBS16_M0.00_TP5_SL0.015_H32"

FIT_END=pd.Timestamp("2024-10-01").date()
CAL_END=pd.Timestamp("2025-04-01").date()
VAL_END=pd.Timestamp("2026-04-01").date()
OOS_END=pd.Timestamp("2026-08-01").date()

HOLD_MINUTES=480
HARD_STOP=0.015
ARM_PROFIT=0.03
PROFIT_FLOOR=0.02
TRAIL_START=0.05
ROUND_TRIP_COST=0.0012

AI_ENABLE_LEVELS=(0.035,0.040,0.045)
AI_THRESHOLDS=(0.45,0.55,0.65)
TRAIL_GAPS=(0.008,0.010)


def find_source(root:Path):
    summary=None
    for p in root.glob("**/summary.json"):
        try:x=json.loads(p.read_text(encoding="utf-8"))
        except Exception:continue
        if x.get("contract")==SOURCE_CONTRACT and x.get("market")==SOURCE_MARKET:
            summary=x;break
    if summary is None:
        raise RuntimeError("LISTING_SOURCE_SUMMARY_MISSING")
    if summary.get("selectedByCalibration")!=SOURCE_WINNER:
        raise RuntimeError(f"UNEXPECTED_LISTING_WINNER:{summary.get('selectedByCalibration')}")
    ledgers=list(root.glob("**/selected-ledger.csv"))
    if not ledgers:
        raise RuntimeError("LISTING_SELECTED_LEDGER_MISSING")
    df=pd.read_csv(ledgers[0])
    need={"symbol","date","timestamp","entryTime","entryPrice"}
    missing=need-set(df.columns)
    if missing:
        raise RuntimeError(f"LISTING_LEDGER_COLUMNS_MISSING:{sorted(missing)}")
    df["date"]=pd.to_datetime(df["date"],errors="coerce").dt.date
    df["timestamp"]=pd.to_datetime(df["timestamp"],utc=True,errors="coerce")
    df["entryTime"]=pd.to_datetime(df["entryTime"],utc=True,errors="coerce")
    df["entryPrice"]=pd.to_numeric(df["entryPrice"],errors="coerce")
    df=df.dropna(subset=["symbol","date","timestamp","entryTime","entryPrice"]).copy()
    df=df.sort_values(["entryTime","symbol"]).drop_duplicates(["entryTime","symbol"],keep="first")
    return summary,df,str(ledgers[0])


def required_files(df):
    tasks=set()
    for r in df.itertuples(index=False):
        start=pd.Timestamp(r.entryTime)
        end=start+pd.Timedelta(minutes=HOLD_MINUTES-1)
        bsym=f"{str(r.symbol)}USDT"
        tasks.add((bsym,start.strftime("%Y-%m-%d")))
        if end.date()!=start.date():
            tasks.add((bsym,end.strftime("%Y-%m-%d")))
    return sorted(tasks)


def download(df):
    tasks=required_files(df)
    cache={}
    failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=18) as pool:
        futs={pool.submit(dyn.fetch_day,s,d):(s,d) for s,d in tasks}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            key,data,err=fut.result()
            if data is not None and not data.empty:
                cache[key]=data
            else:
                failures.append({"symbol":key[0],"day":key[1],"error":err})
            if idx%100==0 or idx==len(futs):
                print(json.dumps({
                    "listingDynamic1mFiles":idx,"requested":len(tasks),
                    "usable":len(cache),"failed":len(failures)
                }),flush=True)
    return cache,{"requestedFiles":len(tasks),"usableFiles":len(cache),"failedFiles":len(failures),"failurePreview":failures[:30]}


def build_path(cache,row):
    start=pd.Timestamp(row.entryTime)
    if start.tzinfo is None:start=start.tz_localize("UTC")
    else:start=start.tz_convert("UTC")
    end=start+pd.Timedelta(minutes=HOLD_MINUTES-1)
    bsym=f"{str(row.symbol)}USDT"
    frames=[]
    for day in sorted({start.strftime("%Y-%m-%d"),end.strftime("%Y-%m-%d")}):
        x=cache.get((bsym,day))
        if x is not None:frames.append(x)
    if not frames:return None,"NO_1M_FILES"
    g=(pd.concat(frames,ignore_index=True).drop_duplicates("timestamp").sort_values("timestamp"))
    g=g[(g["timestamp"]>=start)&(g["timestamp"]<=end)].copy()
    if g.empty:return None,"NO_ENTRY_WINDOW"
    if pd.Timestamp(g["timestamp"].iloc[0])!=start:
        return None,f"ENTRY_MINUTE_MISSING:{g['timestamp'].iloc[0]}"
    entry=float(g["open"].iloc[0])
    if entry<=0:return None,"BAD_ENTRY"
    diff=abs(entry/float(row.entryPrice)-1.0)
    if diff>0.002:
        return None,f"ENTRY_MISMATCH:{diff:.6f}"

    q=g["quote_volume"].astype(float)
    tq=g["taker_buy_quote"].astype(float)
    close=g["close"].astype(float)
    high=g["high"].astype(float)
    low=g["low"].astype(float)
    volume=g["volume"].astype(float)
    sell_quote=q-tq
    sell_flow=q-2.0*tq
    taker_sell=np.where(q>0,sell_quote/q,np.nan)

    g["profitClose"]=1.0-close/entry
    g["peakProfit"]=np.maximum.accumulate(1.0-low/entry)
    g["giveback"]=g["peakProfit"]-g["profitClose"]
    g["ret1Short"]=-(close.pct_change(1))
    g["ret3Short"]=-(close.pct_change(3))
    g["ret5Short"]=-(close.pct_change(5))
    g["takerSell1"]=taker_sell
    g["takerSell5"]=sell_quote.rolling(5,min_periods=1).sum()/q.rolling(5,min_periods=1).sum().replace(0,np.nan)
    g["takerSell15"]=sell_quote.rolling(15,min_periods=1).sum()/q.rolling(15,min_periods=1).sum().replace(0,np.nan)
    g["sellFlow5"]=sell_flow.rolling(5,min_periods=1).sum()/q.rolling(5,min_periods=1).sum().replace(0,np.nan)
    g["sellFlow15"]=sell_flow.rolling(15,min_periods=1).sum()/q.rolling(15,min_periods=1).sum().replace(0,np.nan)
    prior30=q.shift(1).rolling(30,min_periods=5).mean()
    g["quoteRvol5vs30"]=q.rolling(5,min_periods=1).mean()/prior30.replace(0,np.nan)
    vwap=q.cumsum()/volume.cumsum().replace(0,np.nan)
    g["vwapGapShort"]=1.0-close/vwap
    g["range1"]=(high-low)/close.replace(0,np.nan)
    g["minutesSinceEntry"]=np.arange(len(g),dtype=float)
    for c in dyn.FEATURES:
        g[c]=pd.to_numeric(g[c],errors="coerce")
    return g.reset_index(drop=True),None


def make_fit_rows(df,paths):
    rows=[];labels=[]
    for r in df.itertuples(index=False):
        key=(str(r.symbol),pd.Timestamp(r.entryTime))
        g=paths.get(key)
        if g is None:continue
        for i,y in dyn.reachable_state_indices(g):
            rows.append([float(g[c].iloc[i]) if pd.notna(g[c].iloc[i]) else np.nan for c in dyn.FEATURES])
            labels.append(int(y))
    if not rows:raise RuntimeError("NO_LISTING_DYNAMIC_STATES")
    return np.asarray(rows,float),np.asarray(labels,int)


def policies():
    out=[
        {"name":"FIXED_TP3","kind":"fixed","target":0.03},
        {"name":"FIXED_TP5","kind":"fixed","target":0.05},
    ]
    for enable in AI_ENABLE_LEVELS:
        for threshold in AI_THRESHOLDS:
            for gap in TRAIL_GAPS:
                out.append({
                    "name":f"STAGED_A{enable*100:.1f}_T{threshold:.2f}_G{gap*100:.1f}",
                    "kind":"staged","aiEnable":enable,"threshold":threshold,"trailGap":gap,
                })
    return out


def simulate(g,proba,policy):
    entry=float(g["open"].iloc[0])
    hard_stop=entry*(1.0+HARD_STOP)
    armed=False
    peak=0.0
    pending_ai=False
    exit_i=len(g)-1
    exit_px=float(g["close"].iloc[-1])
    reason="MAX_HOLD"

    for i in range(len(g)):
        op=float(g["open"].iloc[i]);hi=float(g["high"].iloc[i]);lo=float(g["low"].iloc[i])
        if pending_ai:
            exit_i=i;exit_px=op;reason="AI_TREND_DIED";break

        if policy["kind"]=="fixed":
            tp=entry*(1.0-float(policy["target"]))
            if hi>=hard_stop:
                exit_i=i;exit_px=hard_stop;reason="HARD_STOP";break
            if lo<=tp:
                exit_i=i;exit_px=tp;reason=f"TP{int(policy['target']*100)}";break
            continue

        if not armed and hi>=hard_stop:
            exit_i=i;exit_px=hard_stop;reason="HARD_STOP";break

        if armed:
            lock=PROFIT_FLOOR
            if peak>=TRAIL_START:
                lock=max(lock,peak-float(policy["trailGap"]))
            floor=entry*(1.0-lock)
            if hi>=floor:
                exit_i=i;exit_px=floor
                reason="TRAIL_PROTECT" if peak>=TRAIL_START else "PROFIT_FLOOR"
                break

        peak=max(peak,1.0-lo/entry)
        if not armed and peak>=ARM_PROFIT:
            armed=True
        if armed and peak>=float(policy["aiEnable"]) and float(proba[i])<float(policy["threshold"]):
            pending_ai=True

    used=g.iloc[:exit_i+1]
    gross=1.0-exit_px/entry
    return {
        "entryPrice":entry,"exitPrice":exit_px,"grossReturn":gross,
        "roundTripCost":ROUND_TRIP_COST,"netReturn":gross-ROUND_TRIP_COST,
        "MFE":1.0-float(used["low"].min())/entry,
        "MAE":float(used["high"].max())/entry-1.0,
        "exitReason":reason,"exitTime":str(g["timestamp"].iloc[exit_i]),
        "holdMinutes":int(exit_i+1),"armed3pct":bool(armed),"peakProfit":peak,
    }


def replay(df,paths,probas,policy):
    rows=[]
    for r in df.itertuples(index=False):
        key=(str(r.symbol),pd.Timestamp(r.entryTime))
        g=paths.get(key)
        if g is None:continue
        res=simulate(g,probas[key],policy)
        rows.append({
            "market":"CRYPTO_FUTURES","direction":"SHORT","candidate":policy["name"],
            "date":r.date,"timestamp":r.timestamp,"symbol":str(r.symbol),
            "sourceEntryTime":str(r.entryTime),**res,
        })
    return pd.DataFrame(rows)


def to_pl(pdf):
    if pdf.empty:return pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    return pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))


def calc(pdf,start,end):
    dates=[d.date() for d in pd.date_range(start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D")]
    return v1.metrics(to_pl(pdf),"CRYPTO_FUTURES",dates)


def split(pdf):
    d=pd.to_datetime(pdf["date"]).dt.date if len(pdf) else pd.Series([],dtype=object)
    return {
        "fit":calc(pdf[d<FIT_END] if len(pdf) else pdf,"2023-04-01","2024-10-01"),
        "calibration":calc(pdf[(d>=FIT_END)&(d<CAL_END)] if len(pdf) else pdf,"2024-10-01","2025-04-01"),
        "validation":calc(pdf[(d>=CAL_END)&(d<VAL_END)] if len(pdf) else pdf,"2025-04-01","2026-04-01"),
        "freshOos":calc(pdf[(d>=VAL_END)&(d<OOS_END)] if len(pdf) else pdf,"2026-04-01","2026-08-01"),
    }


def gate(m,min_trades):
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.50,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def rank_key(m,name):
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 1),name)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input-root",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    source_summary,df,ledger_path=find_source(Path(args.input_root))
    cache,file_audit=download(df)

    paths={};fails=[]
    for r in df.itertuples(index=False):
        key=(str(r.symbol),pd.Timestamp(r.entryTime))
        g,err=build_path(cache,r)
        if g is None:
            fails.append({"symbol":str(r.symbol),"entryTime":str(r.entryTime),"error":err})
            continue
        paths[key]=g
    coverage=len(paths)/max(len(df),1)
    if coverage<0.95:
        raise RuntimeError(f"LISTING_DYNAMIC_COVERAGE_LOW:{len(paths)}/{len(df)}")

    fit_df=df[df["date"]<FIT_END].copy()
    X,y=make_fit_rows(fit_df,paths)
    model=dyn.fit_model(X,y)
    probas={key:dyn.predict_proba(model,g) for key,g in paths.items()}

    reports={};grid=[];ledgers={}
    for policy in policies():
        trades=replay(df,paths,probas,policy)
        mm=split(trades)
        gc=gate(mm["calibration"],15)
        gv=gate(mm["validation"],30)
        go=gate(mm["freshOos"],10)
        eligible=policy["kind"]=="staged" and gc["pass"]
        reports[policy["name"]]={
            "policy":policy,**mm,
            "calibrationGate":gc,"validationGate":gv,"freshOosGate":go,
            "eligibleAfterCalibration":eligible,
        }
        if eligible:ledgers[policy["name"]]=trades
        grid.append({
            "policy":policy["name"],"kind":policy["kind"],
            "fitReturn":mm["fit"].get("totalReturn"),"fitPF":mm["fit"].get("profitFactor"),"fitMDD":mm["fit"].get("mdd"),"fitPosMonthRate":mm["fit"].get("positiveMonthRate"),"fitTrades":mm["fit"].get("tradeCount"),
            "calibrationPass":gc["pass"],"calibrationReturn":mm["calibration"].get("totalReturn"),"calibrationPF":mm["calibration"].get("profitFactor"),"calibrationMDD":mm["calibration"].get("mdd"),"calibrationPosMonthRate":mm["calibration"].get("positiveMonthRate"),"calibrationTrades":mm["calibration"].get("tradeCount"),
            "validationPass":gv["pass"],"validationReturn":mm["validation"].get("totalReturn"),"validationPF":mm["validation"].get("profitFactor"),"validationMDD":mm["validation"].get("mdd"),"validationPosMonthRate":mm["validation"].get("positiveMonthRate"),"validationTrades":mm["validation"].get("tradeCount"),
            "freshOosPass":go["pass"],"freshOosReturn":mm["freshOos"].get("totalReturn"),"freshOosPF":mm["freshOos"].get("profitFactor"),"freshOosMDD":mm["freshOos"].get("mdd"),"freshOosPosMonthRate":mm["freshOos"].get("positiveMonthRate"),"freshOosTrades":mm["freshOos"].get("tradeCount"),
        })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    fresh=[n for n in val if reports[n]["freshOosGate"]["pass"]]
    selected=sorted(eligible,key=lambda n:rank_key(reports[n]["calibration"],n),reverse=True)[0] if eligible else None

    pd.DataFrame(grid).to_csv(out/"policy-grid.csv",index=False)
    if selected and selected in ledgers:ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)
    summary={
        "schemaVersion":1,"contract":"crypto-listing-dynamic-exit-v61",
        "sourceWinner":source_summary.get("selectedByCalibration"),
        "sourceLedger":ledger_path,"sourceTrades":len(df),
        "replayedTrades":len(paths),"replayCoverage":coverage,
        "modelFitStates":int(len(X)),"modelFitPositiveRate":float(y.mean()),
        "candidatePolicies":len(reports),"eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(val),"freshOosPassCount":len(fresh),
        "validationPassCandidates":val,"freshOosPassCandidates":fresh,
        "selectedByCalibration":selected,"selectedResults":reports.get(selected) if selected else None,
        "baselineFixed3":reports.get("FIXED_TP3"),"baselineFixed5":reports.get("FIXED_TP5"),
        "fileAudit":file_audit,"pathFailures":len(fails),"pathFailurePreview":fails[:30],
        "truthBoundary":{
            "entryCandidateFrozenFromListingV6":True,
            "oneMinuteExitReplay":True,
            "aiModelFitOnlyBefore2024_10_01":True,
            "policySelectedOnlyOn2024_10_to_2025_03Calibration":True,
            "validationExcludedFromExitPolicySelection":True,
            "freshOosExcludedFromExitPolicySelection":True,
            "profitProtectionArmsAt3pct":True,
            "aiStartsOnlyAfter3p5To4p5pctCandidateZone":True,
            "trailingStartsAfter5pctPeak":True,
            "entrySignalSelectionAlsoUsedCalibrationBefore2025_04":True,
            "combinedValidationFrom2025_04ForwardIndependentOfSelection":True,
            "profitabilityProven":False,"executionAuthority":"NONE",
        }
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
