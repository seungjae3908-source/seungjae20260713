#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

ROOT = Path(__file__).resolve().parents[2]

def load(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

v43 = load("crypto_v43","market-prediction-lab/scripts/run-crypto-orderflow-targetfirst-ai-v43.py")

MARKET="CRYPTO_SPOT"
DIRECTION="LONG"
TOP_PER_TIMESTAMP=10
SHARD_COUNT_DEFAULT=8
EXTRA_STRESS=0.0010

def shard_for(symbol: str, count: int) -> int:
    h=hashlib.sha256(symbol.encode("utf-8")).digest()
    return int.from_bytes(h[:8],"big")%count

def load_top10(path: Path) -> pd.DataFrame:
    df=pd.read_csv(path)
    req={"date","month","symbol","activityScore","baseRvol","ret60"}
    miss=req-set(df.columns)
    if miss: raise RuntimeError(f"V61_SELECTED_COLUMNS_MISSING:{sorted(miss)}")
    df["date"]=pd.to_datetime(df["date"],utc=True)
    df["month"]=df["month"].astype(str)
    df["symbol"]=df["symbol"].astype(str)
    for c in ("activityScore","baseRvol","ret60"):
        df[c]=pd.to_numeric(df[c],errors="coerce")
    df=df.dropna(subset=["date","activityScore","baseRvol","ret60"]).copy()
    df=df.sort_values(["date","activityScore","symbol"],ascending=[True,False,True])
    df["rankAtTimestamp"]=df.groupby("date").cumcount()+1
    df=df[df["rankAtTimestamp"]<=TOP_PER_TIMESTAMP].copy()
    return df.rename(columns={"date":"timestamp"}).reset_index(drop=True)

def process_symbol(symbol: str, candidates: pd.DataFrame):
    months=set(candidates["month"].astype(str))
    frames=[];failures=[]
    for m in v43.add_month_context(months):
        _,_,df,status=v43.flow.fetch_month_symbol(MARKET,symbol,m)
        if df is not None and not df.empty: frames.append(df)
        elif status!="404": failures.append({"month":m,"status":status})
    if not frames:
        return [],{"symbol":symbol,"ok":False,"error":"NO_RAW_FRAMES","failures":failures[:20]}
    raw=(pd.concat(frames,ignore_index=True).sort_values("timestamp")
         .drop_duplicates("timestamp").reset_index(drop=True))
    feat=v43.augment_features(raw)
    if feat.empty:
        return [],{"symbol":symbol,"ok":False,"error":"NO_FEATURES","failures":failures[:20]}
    feat["timestamp"]=pd.to_datetime(feat["timestamp"],utc=True)
    raw["timestamp"]=pd.to_datetime(raw["timestamp"],utc=True)
    idxmap={pd.Timestamp(t):i for i,t in enumerate(raw["timestamp"])}
    fidx=feat.set_index("timestamp",drop=False)
    rows=[]
    for _,cand in candidates.iterrows():
        t=pd.Timestamp(cand["timestamp"])
        if t.tzinfo is None:t=t.tz_localize("UTC")
        else:t=t.tz_convert("UTC")
        if t not in fidx.index: continue
        fr=fidx.loc[t]
        if isinstance(fr,pd.DataFrame): fr=fr.iloc[-1]
        i=idxmap.get(t)
        if i is None: continue
        vals={
            "activityScore":float(cand["activityScore"]),"baseRvol":float(cand["baseRvol"]),
            "ret60":float(cand["ret60"]),"flow1":fr.get("flow1"),"flow4":fr.get("flow4"),
            "flowAccel4":fr.get("flowAccel4"),"cvd12":fr.get("cvd12"),"cvd24":fr.get("cvd24"),
            "takerRatio":fr.get("takerRatio"),"takerAccel":fr.get("takerAccel"),
            "rvol":fr.get("rvol"),"ret4":fr.get("ret4"),"ret12":fr.get("ret12"),
            "vwapDist":fr.get("vwapDist"),"quoteAccel4":fr.get("quoteAccel4"),
            "rangePct":fr.get("rangePct"),"closeLoc":fr.get("closeLoc"),
        }
        if any(v is None or pd.isna(v) or not np.isfinite(float(v)) for v in vals.values()): continue
        oc=v43.path_outcome(raw,i,DIRECTION,v43.COSTS[MARKET])
        if oc is None: continue
        rows.append({
            "market":MARKET,"symbol":symbol,"timestamp":t,"date":t.date(),
            "month":t.strftime("%Y-%m"),"direction":DIRECTION,
            "rankAtTimestamp":int(cand["rankAtTimestamp"]),
            **{k:float(v) for k,v in vals.items()},**oc,
        })
    return rows,{
        "symbol":symbol,"ok":True,"candidateRows":int(len(candidates)),
        "labeledRows":int(len(rows)),"rawRows":int(len(raw)),"featureRows":int(len(feat)),
        "failures":failures[:20],
    }

def run_shard(selected_path: Path, shard_index: int, shard_count: int, out: Path):
    data=load_top10(selected_path)
    data["shard"]=[shard_for(s,shard_count) for s in data["symbol"].astype(str)]
    part=data[data["shard"]==shard_index].copy()
    if part.empty: raise RuntimeError(f"V61_EMPTY_SHARD:{shard_index}")
    by_symbol={str(s):g.drop(columns=["shard"]).copy() for s,g in part.groupby("symbol",sort=True)}
    rows=[];audits=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs={pool.submit(process_symbol,s,c):s for s,c in by_symbol.items()}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            s=futs[fut]
            try:r,a=fut.result()
            except Exception as exc:r=[];a={"symbol":s,"ok":False,"error":repr(exc)}
            rows.extend(r);audits.append(a)
            if idx%10==0 or idx==len(futs):
                print(json.dumps({"shard":shard_index,"symbolsComplete":idx,"symbols":len(futs),"labeledRows":len(rows)}),flush=True)
    if not rows: raise RuntimeError(f"V61_NO_LABELED_ROWS_SHARD:{shard_index}")
    events=pd.DataFrame(rows).sort_values(["timestamp","symbol"]).drop_duplicates(["timestamp","symbol","direction"])
    events.to_parquet(out/f"causal-long-events-shard-{shard_index}.parquet",index=False)
    pd.DataFrame(audits).to_json(out/f"source-audit-shard-{shard_index}.jsonl",orient="records",lines=True,force_ascii=False)
    result={"schemaVersion":1,"contract":"crypto-spot-causal-targetfirst-ai-v61-shard",
            "shardIndex":shard_index,"shardCount":shard_count,"topPerTimestamp":TOP_PER_TIMESTAMP,
            "candidateRows":int(len(part)),"symbols":int(len(by_symbol)),"labeledRows":int(len(events)),
            "truthBoundary":{"candidateUniverseFromCausalV60Top50":True,
            "rerankedTop10AtSameCompletedTimestampOnly":True,"noDailyHindsightRanking":True,
            "featuresUseCompletedSignalBarAndPastOnly":True,"longLabelUsesForwardBarsOnlyAsOutcome":True,
            "noOutcomeUsedForCandidateSelection":True,"executionAuthority":"NONE"}}
    (out/f"summary-shard-{shard_index}.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL_SHARD":result},ensure_ascii=False),flush=True)

def metrics(df: pd.DataFrame, score: np.ndarray, threshold: float, stress: float=0.0):
    pred=score>=threshold
    y=df["labelTargetFirst3"].astype(int).to_numpy()
    net=df["netReturn"].astype(float).to_numpy()-stress
    n=int(pred.sum())
    if n==0:
        return {"rows":int(len(df)),"selected":0,"meanNet":0.0,"profitFactor":0.0,
                "targetFirstRate":0.0,"recall":0.0,"positiveActiveMonthRate":0.0}
    yy=y[pred];nn=net[pred]
    pos=float(np.maximum(nn,0).sum());neg=float(np.maximum(-nn,0).sum())
    z=pd.DataFrame({"month":df.loc[pred,"month"].astype(str).to_numpy(),"net":nn})
    ms=z.groupby("month")["net"].sum()
    pm=int((ms>0).sum());nm=int((ms<0).sum())
    return {"threshold":float(threshold),"rows":int(len(df)),"selected":n,
            "meanNet":float(nn.mean()),"profitFactor":float(pos/max(neg,1e-12)),
            "targetFirstRate":float((yy==1).mean()),"recall":float((yy==1).sum()/max((y==1).sum(),1)),
            "selectedShare":float(n/max(len(df),1)),"positiveMonths":pm,"negativeMonths":nm,
            "positiveActiveMonthRate":float(pm/max(pm+nm,1))}

def choose_threshold(cal: pd.DataFrame, score: np.ndarray):
    qs=np.unique(np.concatenate([np.linspace(0.70,0.95,26),np.array([0.96,0.97,0.98,0.985,0.99,0.9925,0.995,0.9975])]))
    grid=[metrics(cal,score,float(t)) for t in np.unique(np.quantile(score,qs))]
    eligible=[r for r in grid if r["selected"]>=75 and r["meanNet"]>=0.0015 and
              r["profitFactor"]>=1.30 and r["targetFirstRate"]>=0.40 and
              r["positiveActiveMonthRate"]>=0.67 and r["selectedShare"]<=0.20]
    if eligible:
        return "S_CALIBRATION_GATE",max(eligible,key=lambda r:(r["profitFactor"],r["meanNet"],r["targetFirstRate"])),grid
    cand=[r for r in grid if r["selected"]>=75] or grid
    return "BEST_DIAGNOSTIC_ONLY",max(cand,key=lambda r:(r["meanNet"],r["profitFactor"],r["targetFirstRate"])),grid

def s_gate(m: dict, min_rows: int):
    checks={"minimumRows":int(m["selected"])>=min_rows,"meanNetAtLeast20bp":float(m["meanNet"])>=0.002,
            "profitFactorAtLeast1p5":float(m["profitFactor"])>=1.5,
            "targetFirstRateAtLeast42pct":float(m["targetFirstRate"])>=0.42,
            "positiveMonthRateAtLeast67pct":float(m["positiveActiveMonthRate"])>=0.67}
    return {"pass":bool(all(checks.values())),"checks":checks}

def run_merge(input_root: Path, out: Path):
    files=sorted(input_root.glob("**/causal-long-events-shard-*.parquet"))
    if not files: raise RuntimeError("V61_NO_SHARD_FILES")
    data=pd.concat([pd.read_parquet(p) for p in files],ignore_index=True)
    data["timestamp"]=pd.to_datetime(data["timestamp"],utc=True)
    data=data.sort_values(["timestamp","rankAtTimestamp","symbol"],ascending=[True,True,True]).drop_duplicates(["timestamp","symbol","direction"])
    data["period"]=v43.period_for(data["timestamp"])
    data=data[data["period"]!="outside"].replace([np.inf,-np.inf],np.nan).dropna(subset=v43.FEATURES+["netReturn","labelTargetFirst3"])
    split={p:data[data["period"]==p].copy() for p in ("train","calibration","validation","fresh_oos")}
    if min(len(x) for x in split.values())<100: raise RuntimeError("V61_PERIOD_TOO_SMALL")
    model=LGBMClassifier(objective="binary",n_estimators=650,learning_rate=0.025,num_leaves=24,
        max_depth=8,min_child_samples=120,subsample=0.8,colsample_bytree=0.8,reg_alpha=0.75,
        reg_lambda=2.5,random_state=611,n_jobs=4,verbosity=-1)
    model.fit(split["train"][v43.FEATURES],split["train"]["labelTargetFirst3"].astype(int))
    cal_score=model.predict_proba(split["calibration"][v43.FEATURES])[:,1]
    mode,winner,grid=choose_threshold(split["calibration"],cal_score)
    thr=float(winner["threshold"])
    val_score=model.predict_proba(split["validation"][v43.FEATURES])[:,1]
    fresh_score=model.predict_proba(split["fresh_oos"][v43.FEATURES])[:,1]
    validation=metrics(split["validation"],val_score,thr,0.0)
    fresh=metrics(split["fresh_oos"],fresh_score,thr,0.0)
    validation_stress=metrics(split["validation"],val_score,thr,EXTRA_STRESS)
    fresh_stress=metrics(split["fresh_oos"],fresh_score,thr,EXTRA_STRESS)
    vg=s_gate(validation,100);fg=s_gate(fresh,60);vsg=s_gate(validation_stress,100);fsg=s_gate(fresh_stress,60)
    s_pass=bool(mode=="S_CALIBRATION_GATE" and vg["pass"] and fg["pass"] and vsg["pass"] and fsg["pass"])
    data.to_parquet(out/"causal-long-events.parquet",index=False)
    result={"schemaVersion":1,"contract":"crypto-spot-causal-targetfirst-ai-v61","market":MARKET,
            "direction":DIRECTION,"sourceCausalPrescreenRun":37468226538,"topPerTimestamp":TOP_PER_TIMESTAMP,
            "rowCounts":{k:int(len(v)) for k,v in split.items()},"selectionMode":mode,"calibration":winner,
            "validation":validation,"freshOos":fresh,"validationPlus10bp":validation_stress,"freshOosPlus10bp":fresh_stress,
            "validationGate":vg,"freshOosGate":fg,"validationStressGate":vsg,"freshOosStressGate":fsg,
            "S_PASS":s_pass,"featureImportance":sorted([{"feature":f,"importance":float(v)} for f,v in zip(v43.FEATURES,model.feature_importances_)],key=lambda z:z["importance"],reverse=True)[:12],
            "truthBoundary":{"legacyDailyTopRankingNotUsed":True,"allAvailablePairsScannedByCausalV60BeforePromotion":True,
            "eventOnsetUsesCurrentAndPriorCompletedBarsOnly":True,"top10PromotionUsesSameCompletedTimestampOnly":True,
            "entryUsesNext15mOpen":True,"trainFitOnly":True,"thresholdSelectedFromCalibrationOnly":True,
            "validationAndFreshExcludedFromSelection":True,"plus10bpStressRequiredForS":True,
            "profitabilityProven":s_pass,"executionAuthority":"NONE"}}
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

def main():
    ap=argparse.ArgumentParser();ap.add_argument("--mode",required=True,choices=["shard","merge"])
    ap.add_argument("--selected");ap.add_argument("--shard-index",type=int);ap.add_argument("--shard-count",type=int,default=8)
    ap.add_argument("--input-root");ap.add_argument("--out-dir",required=True);args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    if args.mode=="shard":
        run_shard(Path(args.selected),int(args.shard_index),int(args.shard_count),out)
    else:
        run_merge(Path(args.input_root),out)

if __name__=="__main__": main()
