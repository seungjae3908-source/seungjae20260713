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

ROOT = Path(__file__).resolve().parents[2]

def load_module(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

base = load_module(
    "dynamic_exit_v1",
    "market-prediction-lab/scripts/run-crypto-futures-dynamic-exit-v1.py",
)
v12 = load_module(
    "dynamic_exit_v12",
    "market-prediction-lab/scripts/run-crypto-futures-dynamic-exit-v12.py",
)

ENTRY_FIT_END = pd.Timestamp("2024-04-01").date()
ENTRY_CAL_END = pd.Timestamp("2024-10-01").date()
ENTRY_VALID_END = pd.Timestamp("2025-04-01").date()
REUSED_END = pd.Timestamp("2026-04-01").date()
POST_END = pd.Timestamp("2026-10-01").date()

REBOUND_PCTS = (0.005, 0.010, 0.015)
TAKER_SELL3_MINS = (0.53, 0.56)
BREAK_LOOKBACKS = (3, 5)
MAX_WAIT_MINUTES = (60, 120)

HOLD_MINUTES = 480
TP = 0.03
STOP = 0.015
COST = base.ROUND_TRIP_COST
MIN_REBOUND_TO_BREAK_MINUTES = 2
V12_POLICY = {
    "name":"STAGED_A3.5_T0.55_G0.8",
    "aiEnable":0.035,
    "threshold":0.55,
    "trailGap":0.008,
}


def load_source(root: Path):
    summary, signals, ledger_path = base.load_source(root)
    return summary, signals, ledger_path


def required_files(signals: pd.DataFrame):
    tasks=set()
    extra = pd.Timedelta(minutes=max(MAX_WAIT_MINUTES)+HOLD_MINUTES+30)
    for r in signals.itertuples(index=False):
        start=pd.Timestamp(r.timestamp)+pd.Timedelta(minutes=15)
        end=start+extra
        tasks.add((str(r.symbol),start.strftime("%Y-%m-%d")))
        if end.date()!=start.date():
            tasks.add((str(r.symbol),end.strftime("%Y-%m-%d")))
    return sorted(tasks)


def download_1m(signals: pd.DataFrame):
    tasks=required_files(signals)
    cache={}
    failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=18) as pool:
        futs={pool.submit(base.fetch_day,sym,day):(sym,day) for sym,day in tasks}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            key,data,err=fut.result()
            if data is not None and not data.empty:
                cache[key]=data
            else:
                failures.append({"symbol":key[0],"day":key[1],"error":err})
            if idx%100==0 or idx==len(futs):
                print(json.dumps({
                    "reaccel1mFilesComplete":idx,
                    "requested":len(futs),
                    "usable":len(cache),
                    "failed":len(failures),
                }),flush=True)
    return cache,{
        "requestedFiles":len(tasks),
        "usableFiles":len(cache),
        "failedFiles":len(failures),
        "failurePreview":failures[:40],
    }


def raw_search_window(cache: dict, symbol: str, signal_time: pd.Timestamp):
    start=pd.Timestamp(signal_time)+pd.Timedelta(minutes=15)
    if start.tzinfo is None:
        start=start.tz_localize("UTC")
    else:
        start=start.tz_convert("UTC")
    end=start+pd.Timedelta(minutes=max(MAX_WAIT_MINUTES)+HOLD_MINUTES+10)
    frames=[]
    for day in sorted({start.strftime("%Y-%m-%d"),end.strftime("%Y-%m-%d")}):
        x=cache.get((symbol,day))
        if x is not None:
            frames.append(x)
    if not frames:
        return None,"NO_1M_FILES"
    g=(pd.concat(frames,ignore_index=True)
       .drop_duplicates("timestamp")
       .sort_values("timestamp"))
    g=g[(g["timestamp"]>=start)&(g["timestamp"]<=end)].copy()
    if g.empty:
        return None,"NO_SEARCH_WINDOW"
    if pd.Timestamp(g["timestamp"].iloc[0])!=start:
        return None,f"START_MINUTE_MISSING:{g['timestamp'].iloc[0]}"
    # Fail closed on material gaps in the search/hold path.
    gaps=g["timestamp"].diff().dropna()
    if len(gaps) and gaps.max()>pd.Timedelta(minutes=2):
        return None,f"ONE_MINUTE_GAP:{gaps.max()}"
    return g.reset_index(drop=True),None


def rolling_sell_features(g: pd.DataFrame):
    x=g.copy()
    q=pd.to_numeric(x["quote_volume"],errors="coerce").astype(float)
    tq=pd.to_numeric(x["taker_buy_quote"],errors="coerce").astype(float)
    vol=pd.to_numeric(x["volume"],errors="coerce").astype(float)
    close=pd.to_numeric(x["close"],errors="coerce").astype(float)
    sell=q-tq
    x["takerSell3"]=sell.rolling(3,min_periods=3).sum()/q.rolling(3,min_periods=3).sum().replace(0,np.nan)
    x["vwap10"]=q.rolling(10,min_periods=3).sum()/vol.rolling(10,min_periods=3).sum().replace(0,np.nan)
    x["closeNum"]=close
    return x


def detect_entry(g0: pd.DataFrame, rebound: float, sell_min: float, lookback: int, max_wait: int):
    g=rolling_sell_features(g0)
    running_low=float("inf")
    rebound_i=None

    limit=min(len(g)-2,max_wait-1)
    for i in range(0,limit+1):
        lo=float(g["low"].iloc[i])
        close=float(g["close"].iloc[i])
        running_low=min(running_low,lo)

        if rebound_i is None:
            if running_low>0 and close>=running_low*(1.0+rebound):
                rebound_i=i
            continue

        if i < rebound_i + MIN_REBOUND_TO_BREAK_MINUTES:
            continue
        if i < lookback:
            continue
        if not np.isfinite(float(g["takerSell3"].iloc[i])):
            continue
        if not np.isfinite(float(g["vwap10"].iloc[i])):
            continue

        prev_low=float(pd.to_numeric(g["low"].iloc[i-lookback:i],errors="coerce").min())
        if not np.isfinite(prev_low) or prev_low<=0:
            continue

        breakdown = close < prev_low
        sell_reaccel = float(g["takerSell3"].iloc[i]) >= sell_min
        below_vwap = close < float(g["vwap10"].iloc[i])

        if breakdown and sell_reaccel and below_vwap:
            entry_i=i+1
            if entry_i>=len(g):
                return None
            return {
                "confirmIndex":int(i),
                "entryIndex":int(entry_i),
                "reboundIndex":int(rebound_i),
                "reboundPct":float(rebound),
                "takerSell3Min":float(sell_min),
                "breakLookback":int(lookback),
                "maxWaitMinutes":int(max_wait),
                "confirmTime":pd.Timestamp(g["timestamp"].iloc[i]),
                "entryTime":pd.Timestamp(g["timestamp"].iloc[entry_i]),
                "entryPrice":float(g["open"].iloc[entry_i]),
                "confirmTakerSell3":float(g["takerSell3"].iloc[i]),
                "confirmClose":close,
                "confirmPrevLow":prev_low,
                "minutesFromSignalStart":int(entry_i),
            }
    return None


def decorate_entry_path(g: pd.DataFrame, entry_i: int):
    x=g.iloc[entry_i:entry_i+HOLD_MINUTES].copy().reset_index(drop=True)
    if x.empty:
        return None
    entry=float(x["open"].iloc[0])
    if entry<=0:
        return None

    q=pd.to_numeric(x["quote_volume"],errors="coerce").astype(float)
    tq=pd.to_numeric(x["taker_buy_quote"],errors="coerce").astype(float)
    close=pd.to_numeric(x["close"],errors="coerce").astype(float)
    high=pd.to_numeric(x["high"],errors="coerce").astype(float)
    low=pd.to_numeric(x["low"],errors="coerce").astype(float)
    volume=pd.to_numeric(x["volume"],errors="coerce").astype(float)

    sell_quote=q-tq
    sell_flow=q-2.0*tq
    taker_sell=np.where(q>0,sell_quote/q,np.nan)

    x["profitClose"]=1.0-close/entry
    x["peakProfit"]=np.maximum.accumulate(1.0-low/entry)
    x["giveback"]=x["peakProfit"]-x["profitClose"]
    x["ret1Short"]=-(close.pct_change(1))
    x["ret3Short"]=-(close.pct_change(3))
    x["ret5Short"]=-(close.pct_change(5))
    x["takerSell1"]=taker_sell
    x["takerSell5"]=sell_quote.rolling(5,min_periods=1).sum()/q.rolling(5,min_periods=1).sum().replace(0,np.nan)
    x["takerSell15"]=sell_quote.rolling(15,min_periods=1).sum()/q.rolling(15,min_periods=1).sum().replace(0,np.nan)
    x["sellFlow5"]=sell_flow.rolling(5,min_periods=1).sum()/q.rolling(5,min_periods=1).sum().replace(0,np.nan)
    x["sellFlow15"]=sell_flow.rolling(15,min_periods=1).sum()/q.rolling(15,min_periods=1).sum().replace(0,np.nan)
    prior30=q.shift(1).rolling(30,min_periods=5).mean()
    x["quoteRvol5vs30"]=q.rolling(5,min_periods=1).mean()/prior30.replace(0,np.nan)
    vwap=q.cumsum()/volume.cumsum().replace(0,np.nan)
    x["vwapGapShort"]=1.0-close/vwap
    x["range1"]=(high-low)/close.replace(0,np.nan)
    x["minutesSinceEntry"]=np.arange(len(x),dtype=float)
    for c in base.FEATURES:
        x[c]=pd.to_numeric(x[c],errors="coerce")
    return x


def fixed_tp3(path: pd.DataFrame):
    entry=float(path["open"].iloc[0])
    tp=entry*(1.0-TP)
    sl=entry*(1.0+STOP)
    exit_i=len(path)-1
    exit_price=float(path["close"].iloc[-1])
    reason="MAX_HOLD"
    for i,row in path.iterrows():
        # Conservative same-minute ordering: stop wins if both touched.
        if float(row["high"])>=sl:
            exit_i=i; exit_price=sl; reason="HARD_STOP"; break
        if float(row["low"])<=tp:
            exit_i=i; exit_price=tp; reason="TP3"; break
    used=path.iloc[:exit_i+1]
    gross=1.0-exit_price/entry
    return {
        "entryPrice":entry,
        "exitPrice":exit_price,
        "grossReturn":gross,
        "roundTripCost":COST,
        "netReturn":gross-COST,
        "MFE":1.0-float(used["low"].min())/entry,
        "MAE":float(used["high"].max())/entry-1.0,
        "exitReason":reason,
        "exitTime":str(path["timestamp"].iloc[exit_i]),
        "holdMinutes":int(exit_i+1),
    }


def candidate_name(rebound,sell_min,lookback,max_wait):
    return f"REACCEL_R{rebound*100:.1f}_S{sell_min:.2f}_L{lookback}_W{max_wait}"


def build_candidates(signals: pd.DataFrame, windows: dict):
    defs=[]
    trades={}
    paths={}
    for rebound in REBOUND_PCTS:
        for sell_min in TAKER_SELL3_MINS:
            for lookback in BREAK_LOOKBACKS:
                for max_wait in MAX_WAIT_MINUTES:
                    name=candidate_name(rebound,sell_min,lookback,max_wait)
                    defs.append(name)
                    rows=[]
                    pmap={}
                    for r in signals.itertuples(index=False):
                        key=(str(r.symbol),pd.Timestamp(r.timestamp))
                        g=windows.get(key)
                        if g is None:
                            continue
                        det=detect_entry(g,rebound,sell_min,lookback,max_wait)
                        if det is None:
                            continue
                        path=decorate_entry_path(g,det["entryIndex"])
                        if path is None or len(path)<5:
                            continue
                        res=fixed_tp3(path)
                        rows.append({
                            "market":"CRYPTO_FUTURES",
                            "direction":"SHORT",
                            "candidate":name,
                            "date":pd.Timestamp(r.timestamp).date(),
                            "timestamp":pd.Timestamp(r.timestamp),
                            "symbol":str(r.symbol),
                            **det,
                            **res,
                        })
                        pmap[key]=path
                    trades[name]=pd.DataFrame(rows)
                    paths[name]=pmap
    return defs,trades,paths


def calc(pdf,start,end):
    return base.calc_metrics(pdf,start,end)


def eval_periods(pdf):
    if pdf.empty:
        empty=pdf.copy()
        return {
            "fit":calc(empty,"2023-05-01",str(ENTRY_FIT_END)),
            "calibration":calc(empty,str(ENTRY_FIT_END),str(ENTRY_CAL_END)),
            "validation":calc(empty,str(ENTRY_CAL_END),str(ENTRY_VALID_END)),
            "reused":calc(empty,str(ENTRY_VALID_END),str(REUSED_END)),
            "postHocBenchmark":calc(empty,str(REUSED_END),str(POST_END)),
        }
    d=pd.to_datetime(pdf["date"]).dt.date
    return {
        "fit":calc(pdf[d<ENTRY_FIT_END],"2023-05-01",str(ENTRY_FIT_END)),
        "calibration":calc(pdf[(d>=ENTRY_FIT_END)&(d<ENTRY_CAL_END)],str(ENTRY_FIT_END),str(ENTRY_CAL_END)),
        "validation":calc(pdf[(d>=ENTRY_CAL_END)&(d<ENTRY_VALID_END)],str(ENTRY_CAL_END),str(ENTRY_VALID_END)),
        "reused":calc(pdf[(d>=ENTRY_VALID_END)&(d<REUSED_END)],str(ENTRY_VALID_END),str(REUSED_END)),
        "postHocBenchmark":calc(pdf[(d>=REUSED_END)&(d<POST_END)],str(REUSED_END),str(POST_END)),
    }


def rank_key(m,name,retention):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 1),
        retention,
        name,
    )


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input-root",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)

    source_summary,signals,ledger_path=load_source(Path(args.input_root))
    cache,file_audit=download_1m(signals)

    windows={}
    failures=[]
    for r in signals.itertuples(index=False):
        key=(str(r.symbol),pd.Timestamp(r.timestamp))
        g,err=raw_search_window(cache,str(r.symbol),pd.Timestamp(r.timestamp))
        if g is None:
            failures.append({"symbol":str(r.symbol),"timestamp":str(r.timestamp),"error":err})
            continue
        windows[key]=g
    coverage=len(windows)/max(len(signals),1)
    if coverage<0.95:
        raise RuntimeError(f"REACCEL_WINDOW_COVERAGE_TOO_LOW:{len(windows)}/{len(signals)}")

    defs,trades_by_name,paths_by_name=build_candidates(signals,windows)
    grid=[]
    reports={}
    cal_source=len(signals[(signals["date"]>=ENTRY_FIT_END)&(signals["date"]<ENTRY_CAL_END)])

    for name in defs:
        pdf=trades_by_name[name]
        mm=eval_periods(pdf)
        cal_trades=int(mm["calibration"].get("tradeCount") or 0)
        retention=cal_trades/max(cal_source,1)
        gcal=base.gate(mm["calibration"],20)
        eligible=gcal["pass"] and retention>=0.20
        reports[name]={
            "fixedTp3":mm,
            "calibrationGate":gcal,
            "calibrationRetention":retention,
            "eligible":eligible,
        }
        grid.append({
            "candidate":name,
            "eligible":eligible,
            "calibrationRetention":retention,
            "fitReturn":mm["fit"].get("totalReturn"),
            "fitPF":mm["fit"].get("profitFactor"),
            "calibrationReturn":mm["calibration"].get("totalReturn"),
            "calibrationPF":mm["calibration"].get("profitFactor"),
            "calibrationMDD":mm["calibration"].get("mdd"),
            "calibrationPosMonthRate":mm["calibration"].get("positiveMonthRate"),
            "calibrationTrades":mm["calibration"].get("tradeCount"),
            "validationReturn":mm["validation"].get("totalReturn"),
            "validationPF":mm["validation"].get("profitFactor"),
            "validationMDD":mm["validation"].get("mdd"),
            "validationPosMonthRate":mm["validation"].get("positiveMonthRate"),
            "validationTrades":mm["validation"].get("tradeCount"),
            "reusedReturn":mm["reused"].get("totalReturn"),
            "postHocReturn":mm["postHocBenchmark"].get("totalReturn"),
            "postHocPF":mm["postHocBenchmark"].get("profitFactor"),
            "postHocMDD":mm["postHocBenchmark"].get("mdd"),
            "postHocPosMonthRate":mm["postHocBenchmark"].get("positiveMonthRate"),
            "postHocTrades":mm["postHocBenchmark"].get("tradeCount"),
        })

    eligible=[n for n,d in reports.items() if d["eligible"]]
    research_champion=sorted(
        defs,
        key=lambda n:rank_key(
            reports[n]["fixedTp3"]["calibration"],
            n,
            reports[n]["calibrationRetention"],
        ),
        reverse=True,
    )[0] if defs else None
    winner=sorted(
        eligible,
        key=lambda n:rank_key(
            reports[n]["fixedTp3"]["calibration"],
            n,
            reports[n]["calibrationRetention"],
        ),
        reverse=True,
    )[0] if eligible else None
    selected=winner or research_champion

    dynamic=None
    if selected:
        selected_trades=trades_by_name[selected].copy()
        pmap=paths_by_name[selected]
        fit_signals=selected_trades[selected_trades["date"]<ENTRY_FIT_END][["symbol","timestamp"]].copy()
        if len(fit_signals)>=30:
            x,y,_=base.make_model_rows(fit_signals,pmap)
            model=base.fit_model(x,y)
            probas={key:base.predict_proba(model,g) for key,g in pmap.items()}
            rows=[]
            for r in selected_trades.itertuples(index=False):
                key=(str(r.symbol),pd.Timestamp(r.timestamp))
                g=pmap.get(key)
                if g is None:
                    continue
                res=v12.simulate(g,probas[key],V12_POLICY)
                rows.append({
                    "market":"CRYPTO_FUTURES","direction":"SHORT",
                    "candidate":f"{selected}__V12",
                    "date":pd.Timestamp(r.date).date(),
                    "timestamp":pd.Timestamp(r.timestamp),
                    "symbol":str(r.symbol),
                    "confirmTime":r.confirmTime,
                    "entryTime":r.entryTime,
                    **res,
                })
            dyn_pdf=pd.DataFrame(rows)
            dyn_metrics=eval_periods(dyn_pdf)
            dynamic={
                "modelFitStates":int(len(x)),
                "modelPositiveRate":float(y.mean()),
                "metrics":dyn_metrics,
                "validationGate":base.gate(dyn_metrics["validation"],15),
                "postHocGate":base.gate(dyn_metrics["postHocBenchmark"],10),
            }
            dyn_pdf.to_csv(out/"selected-dynamic-ledger.csv",index=False)

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected:
        trades_by_name[selected].to_csv(out/"selected-fixed-tp3-ledger.csv",index=False)

    summary={
        "schemaVersion":1,
        "contract":"crypto-futures-reacceleration-v14",
        "sourceContract":source_summary.get("contract"),
        "sourceWinner":source_summary.get("winner"),
        "sourceLedger":ledger_path,
        "sourceSignals":int(len(signals)),
        "usableSignalWindows":int(len(windows)),
        "windowCoverage":coverage,
        "candidateCount":len(defs),
        "eligibleCalibrationPassCount":len(eligible),
        "winner":winner,
        "researchChampion":research_champion,
        "selectedForDynamicEvaluation":selected,
        "selectedFixedTp3":reports.get(selected) if selected else None,
        "selectedDynamicExit":dynamic,
        "fileAudit":file_audit,
        "windowFailures":len(failures),
        "windowFailurePreview":failures[:40],
        "truthBoundary":{
            "originalImmediateEntryReplacedByWaitForReboundAndReacceleration":True,
            "reboundMustOccurBeforeBreakdownConfirmation":True,
            "breakdownConfirmedOnCompletedOneMinuteClose":True,
            "takerSell3UsesOnlyCompletedBars":True,
            "entryExecutesNextMinuteOpen":True,
            "fixedTp3UsedForEntryRuleSelection":True,
            "entryRuleSelectedOnlyOn2024_04_to_2024_09Calibration":True,
            "2024_10_to_2025_03NotUsedForEntryRuleSelection":True,
            "dynamicExitRuleFrozenFromV12":True,
            "dynamicExitModelFitOnlyBefore2024_04_01ForSelectedEntry":True,
            "sourceEntryStrategyWasPreviouslySelectedUsingLaterValidation":True,
            "combinedSystemValidationFullyIndependent":False,
            "post2026AprilBenchmarkPreviouslyExposed":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
