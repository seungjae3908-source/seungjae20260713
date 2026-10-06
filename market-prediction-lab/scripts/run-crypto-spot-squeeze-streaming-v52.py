#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
from huggingface_hub import snapshot_download

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v5=load(
    "squeeze_v5",
    "market-prediction-lab/scripts/run-crypto-full-universe-squeeze-v5.py",
)
lead=v5.lead
v1=v5.v1

MARKET="CRYPTO_SPOT"
SUB="spot"
DATASET=v5.DATASET
COST=v5.COSTS[MARKET]
STOP=0.015
LOOKBACKS=v5.LOOKBACKS
COMP_MAX=v5.COMP_MAX
RVOLS=v5.RVOLS
TOP_NS=v5.TOP_NS
TARGETS=(0.03,0.05)
HOLDS=v5.HOLDS
TRAIN_END=v5.TRAIN_END
CAL_END=v5.CAL_END
VAL_END=v5.VAL_END
OOS_END=v5.OOS_END

def simulate_arrays(pdf:pd.DataFrame,i:int,target:float,hold:int):
    if i+1>=len(pdf):return None
    ei=i+1
    entry=float(pdf["open"].iloc[ei])
    if not np.isfinite(entry) or entry<=0:return None
    end=min(len(pdf)-1,ei+hold-1)
    highs=pdf["high"].iloc[ei:end+1].to_numpy(float)
    lows=pdf["low"].iloc[ei:end+1].to_numpy(float)
    closes=pdf["close"].iloc[ei:end+1].to_numpy(float)
    tp=entry*(1+target);sl=entry*(1-STOP)
    exit_px=float(closes[-1]);reason="TIME";exit_i=end
    for off,(hi,lo) in enumerate(zip(highs,lows)):
        j=ei+off
        if lo<=sl:
            exit_px=sl;reason="STOP";exit_i=j;break
        if hi>=tp:
            exit_px=tp;reason="TARGET";exit_i=j;break
    gross=exit_px/entry-1.0
    return {
        "entryPrice":entry,
        "exitPrice":exit_px,
        "grossReturn":gross,
        "netReturn":gross-COST,
        "MFE":float(np.max(highs))/entry-1.0,
        "MAE":1.0-float(np.min(lows))/entry,
        "exitReason":reason,
        "exitTime":pd.Timestamp(pdf["date"].iloc[exit_i]),
    }

def scan_symbol(path:Path):
    sym=lead.base_symbol(path,SUB)
    if sym=="BTC" or not lead.allowed_symbol(sym):
        return [],{"symbol":sym,"skipped":True}
    x=lead.load_15m(path)
    if x is None:
        return [],{"symbol":sym,"ok":False,"error":"NO_15M"}
    pdf=x.to_pandas()
    pdf["date"]=pd.to_datetime(pdf["date"],utc=True)
    imap={pd.Timestamp(t):i for i,t in enumerate(pdf["date"])}
    rows=[]
    for lb in LOOKBACKS:
        z=v5.feature_frame(x,lb).filter(
            (pl.col("priorDollar96")>=300_000.0)
            &pl.col("compression").is_not_null()
            &pl.col("rvol").is_not_null()
        )
        for comp in COMP_MAX:
            for rv in RVOLS:
                sig=z.filter(
                    (pl.col("compression")<=comp)
                    &(pl.col("rvol")>=rv)
                    &(pl.col("close")>=pl.col("priorHigh")*1.001)
                    &(pl.col("closeLoc")>=0.65)
                ).select([
                    "date",
                    "compression","rvol","closeLoc",
                    (
                        pl.col("rvol")
                        +(1.0-pl.col("compression"))*2
                        +pl.col("closeLoc")
                    ).alias("score"),
                ])
                if sig.is_empty():continue
                for r in sig.iter_rows(named=True):
                    ts=pd.Timestamp(r["date"])
                    i=imap.get(ts)
                    if i is None:continue
                    base={
                        "timestamp":ts,
                        "date":ts.date(),
                        "symbol":sym,
                        "lookback":lb,
                        "compMax":float(comp),
                        "rvolMin":float(rv),
                        "score":float(r["score"]),
                        "compression":float(r["compression"]),
                        "rvol":float(r["rvol"]),
                        "closeLoc":float(r["closeLoc"]),
                    }
                    for target in TARGETS:
                        for hold in HOLDS:
                            res=simulate_arrays(pdf,i,target,hold)
                            if res is None:continue
                            rows.append({
                                **base,
                                "target":target,
                                "hold":hold,
                                **res,
                            })
    return rows,{
        "symbol":sym,"ok":True,
        "sourceRows":int(len(pdf)),
        "signalOutcomeRows":int(len(rows)),
    }

def to_metrics(pdf,start,end):
    if pdf.empty:
        p=pl.DataFrame(schema={
            "date":pl.Date,"netReturn":pl.Float64,
            "MFE":pl.Float64,"MAE":pl.Float64,
        })
    else:
        p=pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))
    dates=[d.date() for d in pd.date_range(
        start,pd.Timestamp(end)-pd.Timedelta(days=1),freq="D"
    )]
    return v1.metrics(p,MARKET,dates)

def split_metrics(pdf):
    d=pd.to_datetime(pdf["date"]).dt.date if len(pdf) else pd.Series([],dtype=object)
    return {
        "train":to_metrics(
            pdf[d<TRAIN_END] if len(pdf) else pdf,
            "2023-05-01","2024-10-01",
        ),
        "calibration":to_metrics(
            pdf[(d>=TRAIN_END)&(d<CAL_END)] if len(pdf) else pdf,
            "2024-10-01","2025-04-01",
        ),
        "validation":to_metrics(
            pdf[(d>=CAL_END)&(d<VAL_END)] if len(pdf) else pdf,
            "2025-04-01","2026-04-01",
        ),
        "freshOos":to_metrics(
            pdf[(d>=VAL_END)&(d<OOS_END)] if len(pdf) else pdf,
            "2026-04-01","2026-08-01",
        ),
    }

def gate(m,min_trades):
    checks={
        "positiveReturn":float(m.get("totalReturn") or 0)>0,
        "profitFactorAbove1":float(m.get("profitFactor") or 0)>1,
        "positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,
        "mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,
        "minimumTrades":int(m.get("tradeCount") or 0)>=min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    folder=Path(snapshot_download(
        repo_id=DATASET,repo_type="dataset",
        allow_patterns=["spot/15m/*.parquet"],
    ))/"spot"/"15m"
    files=sorted(folder.glob("*.parquet"))
    if len(files)<500:
        raise RuntimeError(f"V52_TOO_FEW_SPOT_FILES:{len(files)}")

    rows=[];audits=[]
    for idx,p in enumerate(files,1):
        try:r,a=scan_symbol(p)
        except Exception as exc:
            r=[];a={"symbol":lead.base_symbol(p,SUB),"ok":False,"error":repr(exc)}
        rows.extend(r);audits.append(a)
        if idx%25==0 or idx==len(files):
            print(json.dumps({
                "spotSqueezeFilesComplete":idx,
                "files":len(files),
                "usable":sum(1 for x in audits if x.get("ok")),
                "rows":len(rows),
            }),flush=True)

    raw=pd.DataFrame(rows)
    if raw.empty:
        raise RuntimeError("V52_NO_SIGNAL_OUTCOMES")
    raw.to_parquet(out/"all-signal-outcomes.parquet",index=False)
    pd.DataFrame(audits).to_json(
        out/"source-audit.jsonl",orient="records",lines=True,force_ascii=False
    )

    reports={};grid=[];ledgers={}
    for lb in LOOKBACKS:
        for comp in COMP_MAX:
            for rv in RVOLS:
                base=raw[
                    (raw["lookback"]==lb)
                    &(raw["compMax"]==float(comp))
                    &(raw["rvolMin"]==float(rv))
                ].copy()
                if base.empty:continue
                for target in TARGETS:
                    for hold in HOLDS:
                        pool=base[
                            (base["target"]==target)&(base["hold"]==hold)
                        ].copy()
                        for topn in TOP_NS:
                            selected=(
                                pool.sort_values(
                                    ["timestamp","score","symbol"],
                                    ascending=[True,False,True],
                                )
                                .groupby("timestamp",group_keys=False)
                                .head(topn)
                                .reset_index(drop=True)
                            )
                            name=(
                                f"LONG_SQ_L{lb}_C{comp:g}_RV{rv:g}_"
                                f"TOP{topn}_TP{int(target*100)}_H{hold}"
                            )
                            mm=split_metrics(selected)
                            gt=gate(mm["train"],100)
                            gc=gate(mm["calibration"],30)
                            gv=gate(mm["validation"],50)
                            go=gate(mm["freshOos"],15)
                            eligible=gt["pass"] and gc["pass"]
                            reports[name]={
                                **mm,
                                "trainGate":gt,"calibrationGate":gc,
                                "validationGate":gv,"freshOosGate":go,
                                "eligibleAfterCalibration":eligible,
                            }
                            if eligible:ledgers[name]=selected
                            grid.append({
                                "candidate":name,
                                "lookback":lb,"compMax":comp,"rvolMin":rv,
                                "topN":topn,"target":target,"hold":hold,
                                "trainPass":gt["pass"],
                                "trainReturn":mm["train"].get("totalReturn"),
                                "trainPF":mm["train"].get("profitFactor"),
                                "calibrationPass":gc["pass"],
                                "calibrationReturn":mm["calibration"].get("totalReturn"),
                                "calibrationPF":mm["calibration"].get("profitFactor"),
                                "validationPass":gv["pass"],
                                "validationReturn":mm["validation"].get("totalReturn"),
                                "validationPF":mm["validation"].get("profitFactor"),
                                "freshOosPass":go["pass"],
                                "freshOosReturn":mm["freshOos"].get("totalReturn"),
                                "freshOosPF":mm["freshOos"].get("profitFactor"),
                                "distinctSymbols":int(selected["symbol"].nunique()) if len(selected) else 0,
                            })

    eligible=[n for n,d in reports.items() if d["eligibleAfterCalibration"]]
    val=[n for n in eligible if reports[n]["validationGate"]["pass"]]
    fresh=[n for n in val if reports[n]["freshOosGate"]["pass"]]
    selected=max(
        eligible,
        key=lambda n:(
            float(reports[n]["calibration"].get("positiveMonthRate") or 0),
            float(reports[n]["calibration"].get("totalReturn") or 0),
            float(reports[n]["calibration"].get("profitFactor") or 0),
            n,
        ),
    ) if eligible else None

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)
    if selected and selected in ledgers:
        ledgers[selected].to_csv(out/"selected-ledger.csv",index=False)

    result={
        "schemaVersion":1,
        "contract":"crypto-spot-squeeze-streaming-v52",
        "source15mFiles":len(files),
        "usableFiles":sum(1 for x in audits if x.get("ok")),
        "rawSignalOutcomeRows":int(len(raw)),
        "candidateCount":len(reports),
        "eligibleAfterCalibrationCount":len(eligible),
        "validationPassCount":len(val),
        "freshOosPassCount":len(fresh),
        "validationPassCandidates":val,
        "freshOosPassCandidates":fresh,
        "selectedByCalibration":selected,
        "selectedResults":reports.get(selected) if selected else None,
        "truthBoundary":{
            "sameSignalLogicAsCancelledV5":True,
            "implementationChangedToLoadEachSymbolOnce":True,
            "allAvailableSpot15mPairsScanned":True,
            "topNAppliedAfterFullUniverseSignalGeneration":True,
            "signalUsesCompleted15mBar":True,
            "entryNext15mOpen":True,
            "stopFirstConservativeWithin15mBar":True,
            "spotLongOnly":True,
            "candidateSelectionUsesTrainAndCalibrationOnly":True,
            "validationExcludedFromSelection":True,
            "freshOosExcludedFromSelection":True,
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
