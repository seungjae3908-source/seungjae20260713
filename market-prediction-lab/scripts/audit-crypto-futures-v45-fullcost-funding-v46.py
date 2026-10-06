#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import pandas as pd

ROOT=Path(__file__).resolve().parents[2]

def load(name,rel):
    p=ROOT/rel
    spec=importlib.util.spec_from_file_location(name,p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

fund=load(
    "funding_v32",
    "market-prediction-lab/scripts/run-full-universe-3pct-hunter-futures-funding-v32.py",
)
v45=load(
    "robust_v45",
    "market-prediction-lab/scripts/audit-crypto-futures-v44-robustness-capital-v45.py",
)

STRESS_EXTRA_COSTS={
    "actualFunding":0.0,
    "actualFundingPlus5bp":0.0005,
    "actualFundingPlus10bp":0.0010,
    "actualFundingPlus20bp":0.0020,
    "actualFundingPlus30bp":0.0030,
}

def months_between(a:pd.Timestamp,b:pd.Timestamp)->list[str]:
    p0=pd.Period(a.strftime("%Y-%m"),freq="M")
    p1=pd.Period(b.strftime("%Y-%m"),freq="M")
    out=[]
    p=p0
    while p<=p1:
        out.append(str(p));p+=1
    return out

def load_funding_cache(events:pd.DataFrame):
    pairs=set()
    for r in events.itertuples(index=False):
        a=pd.Timestamp(r.entryTime);b=pd.Timestamp(r.exitTime)
        if a.tzinfo is None:a=a.tz_localize("UTC")
        else:a=a.tz_convert("UTC")
        if b.tzinfo is None:b=b.tz_localize("UTC")
        else:b=b.tz_convert("UTC")
        for m in months_between(a,b):
            pairs.add((str(r.symbol),m))
    cache={};failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
        futs={pool.submit(fund.fetch_funding,s,m):(s,m) for s,m in sorted(pairs)}
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            key,df,err=fut.result()
            if df is not None and not df.empty:
                cache[key]=df
            else:
                failures.append({"symbol":key[0],"month":key[1],"error":err})
            if idx%100==0 or idx==len(futs):
                print(json.dumps({
                    "fundingFilesComplete":idx,"requested":len(futs),
                    "usable":len(cache),"failed":len(failures)
                }),flush=True)
    return cache,{
        "requestedFiles":len(pairs),
        "usableFiles":len(cache),
        "failedFiles":len(failures),
        "failurePreview":failures[:40],
    }

def apply_funding(events:pd.DataFrame,cache:dict):
    rows=[];covered=0;funding_obs=0
    for r in events.to_dict("records"):
        a=pd.Timestamp(r["entryTime"]);b=pd.Timestamp(r["exitTime"])
        if a.tzinfo is None:a=a.tz_localize("UTC")
        else:a=a.tz_convert("UTC")
        if b.tzinfo is None:b=b.tz_localize("UTC")
        else:b=b.tz_convert("UTC")
        frames=[];has_source=True
        for m in months_between(a,b):
            x=cache.get((str(r["symbol"]),m))
            if x is None:
                has_source=False
            else:
                frames.append(x)
        if has_source:
            covered+=1
        fsum=0.0;obs=0
        if frames:
            f=pd.concat(frames,ignore_index=True).sort_values("fundingTime").drop_duplicates("fundingTime")
            held=f[(f["fundingTime"]>a)&(f["fundingTime"]<=b)]
            fsum=float(held["last_funding_rate"].sum()) if len(held) else 0.0
            obs=int(len(held))
        # SHORT receives positive funding and pays negative funding.
        r["fundingReturnShort"]=fsum
        r["fundingObservations"]=obs
        r["netReturnWithFunding"]=float(r["netReturn"])+fsum
        rows.append(r);funding_obs+=obs
    out=pd.DataFrame(rows)
    return out,{
        "eventRows":len(out),
        "rowsWithMonthlyFundingSource":covered,
        "sourceCoverage":covered/max(len(out),1),
        "fundingObservationsDuringHeldPositions":funding_obs,
        "meanFundingReturnShort":float(out["fundingReturnShort"].mean()) if len(out) else 0.0,
        "sumFundingReturnShort":float(out["fundingReturnShort"].sum()) if len(out) else 0.0,
    }

def stress_period(df:pd.DataFrame)->dict:
    scenarios={}
    for name,extra in STRESS_EXTRA_COSTS.items():
        z=df.copy()
        z["netReturn"]=pd.to_numeric(z["netReturnWithFunding"],errors="coerce")-extra
        scenarios[name]=v45.period_audit(z)
    return scenarios

def stress_gate(scenarios:dict)->dict:
    actual=scenarios["actualFunding"]
    plus10=scenarios["actualFundingPlus10bp"]
    checks={
        "actualFundingRobustnessPass":actual["robustnessGate"]["pass"],
        "plus10bpPositiveEV":plus10["exactMetrics"]["meanNet"]>0,
        "plus10bpProfitFactorAbove1":plus10["exactMetrics"]["profitFactor"]>1,
        "plus10bpThreeSlotPositive":next(
            x for x in plus10["slotCapital"] if x["maxPositions"]==3
        )["totalReturn"]>0,
        "plus10bpThreeSlotMddAtMost35pct":next(
            x for x in plus10["slotCapital"] if x["maxPositions"]==3
        )["mdd"]<=0.35,
    }
    return {"pass":all(checks.values()),"checks":checks}

def compact_scenarios(s:dict)->dict:
    out={}
    for k,v in s.items():
        out[k]={
            "exactMetrics":v["exactMetrics"],
            "slotCapital":v["slotCapital"],
            "robustnessGate":v["robustnessGate"],
        }
    return out

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--exact-events",required=True)
    ap.add_argument("--v45-summary",required=True)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    prior=json.loads(Path(args.v45_summary).read_text(encoding="utf-8"))
    if prior.get("contract")!="crypto-futures-v44-robustness-capital-v45":
        raise RuntimeError("V46_WRONG_PRIOR")
    if not bool(prior.get("robustnessPass")):
        raise RuntimeError("V46_PRIOR_NOT_ROBUST")

    events=pd.read_parquet(args.exact_events)
    events["entryTime"]=pd.to_datetime(events["entryTime"],utc=True)
    events["exitTime"]=pd.to_datetime(events["exitTime"],utc=True)
    cache,file_audit=load_funding_cache(events)
    enriched,row_audit=apply_funding(events,cache)
    if row_audit["sourceCoverage"]<0.95:
        raise RuntimeError(
            f"V46_FUNDING_SOURCE_COVERAGE_LOW:{row_audit['sourceCoverage']}"
        )
    enriched.to_parquet(out/"fullcost-events.parquet",index=False)

    val=enriched[enriched["period"].astype(str)=="validation"].copy()
    fresh=enriched[enriched["period"].astype(str)=="fresh_oos"].copy()
    vs=stress_period(val);fs=stress_period(fresh)
    vg=stress_gate(vs);fg=stress_gate(fs)

    result={
        "schemaVersion":1,
        "contract":"crypto-futures-v45-fullcost-funding-v46",
        "sourceRunV44":37453972448,
        "fundingFileAudit":file_audit,
        "fundingRowAudit":row_audit,
        "stressExtraCosts":STRESS_EXTRA_COSTS,
        "validation":compact_scenarios(vs),
        "freshOos":compact_scenarios(fs),
        "validationFullCostGate":vg,
        "freshFullCostGate":fg,
        "fullCostPass":bool(vg["pass"] and fg["pass"]),
        "truthBoundary":{
            "usesFrozenV44Exact1mEvents":True,
            "usesBinancePublicHistoricalFundingArchives":True,
            "shortReceivesPositiveAndPaysNegativeFunding":True,
            "fundingAppliedOnlyWhenFundingTimestampOccursDuringHold":True,
            "baseV44RoundTripCostAndEntrySlippageAlreadyIncluded":True,
            "stressCostsAreAdditionalRoundTripHaircuts":True,
            "noThresholdRetuning":True,
            "noCandidateReselection":True,
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
