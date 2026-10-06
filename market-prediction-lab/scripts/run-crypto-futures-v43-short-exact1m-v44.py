#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v43=load("crypto_v43","market-prediction-lab/scripts/run-crypto-orderflow-targetfirst-ai-v43.py")
lead=load("lead_v42","market-prediction-lab/scripts/run-btc-alt-leadlag-extreme-v42.py")
common=load("always_on","market-prediction-lab/scripts/always_on_portfolio_replay.py")

MARKET="CRYPTO_FUTURES"
DIRECTION="SHORT"
TARGET=0.03
STOP=0.015
HOLD=pd.Timedelta(hours=8)
ENTRY_SLIPPAGE=0.0005
ROUND_TRIP_COST=0.0012

def frozen_selected(events_path:Path,summary_path:Path)->tuple[pd.DataFrame,float,dict]:
    data=pd.read_parquet(events_path)
    summary=json.loads(summary_path.read_text(encoding="utf-8"))
    if summary.get("contract")!="crypto-orderflow-targetfirst-ai-v43":
        raise RuntimeError("V44_WRONG_SOURCE_SUMMARY")
    if summary.get("market")!=MARKET:
        raise RuntimeError("V44_WRONG_MARKET")
    src=summary["directions"][DIRECTION]
    if not src["validationGate"]["pass"] or not src["freshOosGate"]["pass"]:
        raise RuntimeError("V44_SOURCE_SHORT_NOT_PROMOTED")
    threshold=float(src["calibrationSelection"]["winner"]["threshold"])

    d=data[data["direction"].astype(str)==DIRECTION].copy()
    train=d[d["period"].astype(str)=="train"].copy()
    if train.empty:
        raise RuntimeError("V44_TRAIN_EMPTY")
    model=LGBMClassifier(
        objective="binary",n_estimators=550,learning_rate=0.03,
        num_leaves=31,min_child_samples=80,subsample=0.80,
        colsample_bytree=0.85,reg_alpha=0.20,reg_lambda=1.75,
        random_state=113,n_jobs=4,verbosity=-1,
    )
    model.fit(train[v43.FEATURES],train["labelTargetFirst3"].astype(int))
    score=model.predict_proba(d[v43.FEATURES])[:,1]
    d["score"]=score
    sel=d[
        d["period"].astype(str).isin(["validation","fresh_oos"])
        & (d["score"]>=threshold)
    ].copy()
    if sel.empty:
        raise RuntimeError("V44_NO_SELECTED_ROWS")
    return sel,threshold,{
        "sourceValidation":src["validation"],
        "sourceFreshOos":src["freshOos"],
        "sourceValidationGate":src["validationGate"],
        "sourceFreshOosGate":src["freshOosGate"],
    }

def day_frame(symbol:str,day:str):
    content,err=lead.fetch_url(lead.alt_day_url(MARKET,symbol,day))
    if content is None:
        return None,err
    x=lead.parse_kline_bytes(content)
    if x is None or x.empty:
        return None,"EMPTY"
    return x,None

def exact_group(symbol:str,day:str,events:pd.DataFrame):
    d0=pd.Timestamp(day,tz="UTC")
    days=[d0.strftime("%Y-%m-%d"),(d0+pd.Timedelta(days=1)).strftime("%Y-%m-%d")]
    frames=[]; failures=[]
    for dd in days:
        x,err=day_frame(symbol,dd)
        if x is not None and not x.empty:
            frames.append(x)
        elif err!="404":
            failures.append({"day":dd,"error":err})
    if not frames:
        return [],{"symbol":symbol,"day":day,"error":"NO_1M_DATA","failures":failures}
    bars=pd.concat(frames,ignore_index=True).sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    bars["timestamp"]=pd.to_datetime(bars["timestamp"],utc=True)
    rows=[]
    for _,ev in events.iterrows():
        entry_t=pd.Timestamp(ev["entryTime"])
        if entry_t.tzinfo is None:
            entry_t=entry_t.tz_localize("UTC")
        else:
            entry_t=entry_t.tz_convert("UTC")
        cand=bars[(bars["timestamp"]>=entry_t)&(bars["timestamp"]<=entry_t+pd.Timedelta(minutes=1))]
        if cand.empty:
            continue
        i=int(cand.index[0])
        entry=float(bars.loc[i,"open"])*(1.0-ENTRY_SLIPPAGE)
        if not np.isfinite(entry) or entry<=0:
            continue
        tp=entry*(1.0-TARGET)
        sl=entry*(1.0+STOP)
        end_t=entry_t+HOLD
        exit_i=i
        exit_px=float(bars.loc[i,"close"])
        reason="TIME"
        highs=[];lows=[]
        for j in range(i,len(bars)):
            t=pd.Timestamp(bars.loc[j,"timestamp"])
            if t>=end_t:
                break
            hi=float(bars.loc[j,"high"]);lo=float(bars.loc[j,"low"])
            highs.append(hi);lows.append(lo)
            exit_i=j;exit_px=float(bars.loc[j,"close"])
            # conservative same-minute ambiguity: stop first
            if hi>=sl:
                exit_px=sl;reason="STOP";break
            if lo<=tp:
                exit_px=tp;reason="TARGET";break
        if not highs:
            continue
        gross=1.0-exit_px/entry
        net=gross-ROUND_TRIP_COST
        rows.append({
            "market":MARKET,
            "timestamp":pd.Timestamp(ev["timestamp"]),
            "symbol":symbol,
            "direction":DIRECTION,
            "score":float(ev["score"]),
            "period":str(ev["period"]),
            "entryTime":entry_t,
            "exitTime":pd.Timestamp(bars.loc[exit_i,"timestamp"]),
            "entryPriceExec":entry,
            "exitPrice":exit_px,
            "exitReason":reason,
            "netReturn":net,
            "MFE":1.0-float(np.nanmin(lows))/entry,
            "MAE":float(np.nanmax(highs))/entry-1.0,
            "targetFirst3":1 if reason=="TARGET" else 0,
        })
    return rows,{"symbol":symbol,"day":day,"events":int(len(events)),"exactRows":int(len(rows)),"failures":failures}

def exact_metrics(df:pd.DataFrame)->dict:
    if df.empty:
        return {
            "rows":0,"targetFirst3":0,"targetFirstRate":0.0,"meanNet":0.0,
            "profitFactor":0.0,"positiveMonths":0,"negativeMonths":0,
            "positiveActiveMonthRate":0.0,
        }
    net=pd.to_numeric(df["netReturn"],errors="coerce").dropna().to_numpy(float)
    pos=float(np.maximum(net,0).sum());neg=float(np.maximum(-net,0).sum())
    months=pd.to_datetime(df["entryTime"],utc=True).dt.strftime("%Y-%m")
    ms=pd.DataFrame({"month":months,"net":df["netReturn"].astype(float)}).groupby("month")["net"].sum()
    p=int((ms>0).sum());n=int((ms<0).sum());active=p+n
    return {
        "rows":int(len(df)),
        "targetFirst3":int(df["targetFirst3"].sum()),
        "targetFirstRate":float(df["targetFirst3"].mean()),
        "meanNet":float(np.mean(net)) if len(net) else 0.0,
        "profitFactor":float(pos/max(neg,1e-12)) if len(net) else 0.0,
        "positiveMonths":p,"negativeMonths":n,
        "positiveActiveMonthRate":float(p/max(active,1)),
    }

def gate(m:dict)->dict:
    checks={
        "minimumRows":m["rows"]>=100,
        "positiveEV":m["meanNet"]>0,
        "profitFactorAbove1":m["profitFactor"]>1,
        "positiveActiveMonthRateAtLeast50pct":m["positiveActiveMonthRate"]>=0.50,
    }
    return {"pass":all(checks.values()),"checks":checks}

def portfolio_grid(df:pd.DataFrame)->list[dict]:
    rows=[]
    for cap in (1,3,5,10,20,None):
        r=common.replay_always_on(df,max_positions=cap,opportunity_target=TARGET)
        rows.append({
            "maxPositions":"UNLIMITED" if cap is None else cap,
            "signals":r["scanner"]["signalEvents"],
            "entries":r["positions"]["entries"],
            "reentries":r["positions"]["reentriesAfterPriorExit"],
            "maxConcurrent":r["positions"]["maxConcurrent"],
            "newEntriesWhileOtherOpen":r["scanner"]["newEntriesWhileOtherPositionOpen"],
            "bookedNetReturnSum":r["positions"]["bookedNetReturnSum"],
            "positiveEntryRate":r["positions"]["positiveEntryRate"],
            "detected3pct":r["opportunities"]["detected"],
            "executed3pct":r["opportunities"]["executed"],
            "executionRecall":r["opportunities"]["executionRecall"],
        })
    return rows

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--events",required=True)
    ap.add_argument("--summary",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    selected,threshold,source=frozen_selected(Path(args.events),Path(args.summary))
    selected["entryTime"]=pd.to_datetime(selected["entryTime"],utc=True)
    selected["timestamp"]=pd.to_datetime(selected["timestamp"],utc=True)
    selected["day"]=selected["entryTime"].dt.strftime("%Y-%m-%d")

    tasks=[(sym,day,g.copy()) for (sym,day),g in selected.groupby(["symbol","day"],sort=False)]
    rows=[];audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
        futs={pool.submit(exact_group,sym,day,g):(sym,day) for sym,day,g in tasks}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            sym,day=futs[fut]
            try:
                rr,aa=fut.result()
            except Exception as exc:
                rr=[];aa={"symbol":sym,"day":day,"error":repr(exc)}
            rows.extend(rr);audits.append(aa)
            if idx%100==0 or idx==len(futs):
                print(json.dumps({
                    "v44TasksComplete":idx,"tasks":len(futs),
                    "exactRows":len(rows)
                }),flush=True)

    if not rows:
        raise RuntimeError("V44_NO_EXACT_ROWS")
    exact=pd.DataFrame(rows)
    exact.to_parquet(out/"exact-events.parquet",index=False)
    pd.DataFrame(audits).to_csv(out/"source-audit.csv",index=False)

    val=exact[exact["period"]=="validation"].copy()
    fresh=exact[exact["period"]=="fresh_oos"].copy()
    vm=exact_metrics(val);fm=exact_metrics(fresh)
    vg=gate(vm);fg=gate(fm)
    grid={
        "validation":portfolio_grid(val),
        "freshOos":portfolio_grid(fresh),
        "combined":portfolio_grid(exact),
    }
    for k,v in grid.items():
        pd.DataFrame(v).to_csv(out/f"capacity-{k}.csv",index=False)

    result={
        "schemaVersion":1,
        "contract":"crypto-futures-v43-short-exact1m-v44",
        "sourceRun":37443253984,
        "threshold":threshold,
        "selected15mRows":int(len(selected)),
        "exact1mRows":int(len(exact)),
        "sourceV43":source,
        "exactValidation":vm,
        "exactFreshOos":fm,
        "exactValidationGate":vg,
        "exactFreshOosGate":fg,
        "promotionPass":bool(vg["pass"] and fg["pass"]),
        "capacityGrid":grid,
        "truthBoundary":{
            "sourceDirectionShortOnly":True,
            "thresholdFrozenFromV43Calibration":True,
            "validationAndFreshNotUsedForSelection":True,
            "entryUsesFrozenNext15mEntryTimeThenExact1mOpen":True,
            "shortEntrySlippageApplied":ENTRY_SLIPPAGE,
            "roundTripCostIncluded":True,
            "exact1mTargetStopPath":True,
            "sameMinuteTargetStopUsesStopFirst":True,
            "maxHoldHours":8,
            "alwaysOnPortfolioReplay":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(
        json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
