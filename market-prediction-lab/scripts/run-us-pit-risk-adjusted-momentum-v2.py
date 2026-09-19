#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, json, math, statistics, sys
from datetime import datetime, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_PATH=Path("market-prediction-lab/scripts/run-us-pit-sp500-momentum-v1.py")
spec=importlib.util.spec_from_file_location("pit_base",BASE_PATH)
base=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=base
spec.loader.exec_module(base)

OUT=Path("market-prediction-lab/artifacts/us-pit-risk-adjusted-momentum-v2")
OUT.mkdir(parents=True,exist_ok=True)

def score_raw(p,months,i):
    return p[months[i-1]]/p[months[i-12]]-1

def score_risk_adjusted(p,months,i):
    mom=score_raw(p,months,i)
    rs=[]
    for k in range(i-12,i):
        a,b=months[k-1],months[k]
        if a not in p or b not in p:return None
        rs.append(p[b]/p[a]-1)
    vol=statistics.stdev(rs) if len(rs)>=2 else 0
    if not math.isfinite(vol) or vol<=1e-9:return None
    return mom/vol

def summarize(rs):
    eq=1.;peak=1.;mdd=0.
    for r in rs:
        eq*=max(1e-9,1+r);peak=max(peak,eq);mdd=max(mdd,1-eq/peak)
    wins=[x for x in rs if x>0];loss=[x for x in rs if x<0]
    gp=sum(wins);gl=-sum(loss);years=len(rs)/12
    return {"months":len(rs),"return":eq-1,"annualized":eq**(1/years)-1 if years>0 else None,
            "mdd":mdd,"win_rate":len(wins)/len(rs) if rs else 0,"pf":gp/gl if gl else None}

def simulate(months,membership,prices,cost,mode):
    rs=[];coverage=[];prev=set();turns=[];skipped=[]
    for i in range(13,len(months)-1):
        m=months[i];nextm=months[i+1];universe=membership[m]
        scored=[];available=0
        for s in universe:
            p=prices.get(s,{})
            needed=(m,nextm,months[i-1],months[i-12],months[i-13])
            if not all(x in p for x in needed):continue
            available+=1
            score=score_raw(p,months,i) if mode=="RAW_12_1" else score_risk_adjusted(p,months,i)
            if score is not None and math.isfinite(score):scored.append((score,s))
        cov=available/max(1,len(universe));coverage.append(cov)
        if cov<0.70 or len(scored)<150:
            skipped.append({"month":m,"coverage":cov,"eligible":len(scored)});continue
        scored.sort(reverse=True)
        n=max(1,math.ceil(len(scored)*0.10))
        held={s for _,s in scored[:n]}
        gross=sum(prices[s][nextm]/prices[s][m]-1 for s in held)/len(held)
        turnover=1.0 if not prev else 1-len(held&prev)/max(len(held),len(prev))
        net=gross-2*cost*turnover
        rs.append(net);turns.append(turnover);prev=held
    return {"metrics":summarize(rs),"avg_coverage":sum(coverage)/len(coverage) if coverage else 0,
            "avg_turnover":sum(turns)/len(turns) if turns else 0,"skipped":skipped}

def main():
    rows,_=base.load_membership()
    months=base.month_range(f"{base.START_YEAR}-01",base.END_MONTH)
    membership={m:base.membership_for_month(rows,m) for m in months}
    symbols=sorted(set().union(*membership.values()))
    start_s=int(datetime(2014,1,1,tzinfo=timezone.utc).timestamp())
    end_s=int(datetime(2026,9,1,tzinfo=timezone.utc).timestamp())
    prices={};failures={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(base.fetch_adj,s,start_s,end_s):s for s in symbols+["SPY"]}
        for idx,f in enumerate(as_completed(futs),1):
            s,p,err=f.result()
            if p:prices[s]=p
            else:failures[s]=err
            if idx%50==0:print(json.dumps({"prices_done":idx,"ok":len(prices),"failed":len(failures)}),flush=True)
    spy=prices.pop("SPY",{})
    if not spy:raise RuntimeError("SPY unavailable")
    results={}
    for mode in ("RAW_12_1","RISK_ADJ_12_1"):
        results[mode]={k:simulate(months,membership,prices,c,mode) for k,c in base.COSTS.items()}
    benchmark={k:base.simulate_spy(months,spy,c) for k,c in base.COSTS.items()}
    payload={"schemaVersion":1,"kind":"us-pit-risk-adjusted-momentum-v2",
             "research_only":True,"public_data_only":True,"live_trading":False,
             "private_api":False,"orders_submitted":0,"lookahead_free":True,
             "formula":{"RAW_12_1":"top decile point-in-time S&P500 by 12-1 adjusted-close momentum",
                        "RISK_ADJ_12_1":"same 12-1 momentum divided by stdev of preceding 12 monthly returns",
                        "selection":"top decile monthly, equal weight, long only"},
             "period":{"start":months[0],"end":months[-1]},"symbol_count":len(symbols),
             "price_success":len(prices),"price_failures":len(failures),
             "results":results,"benchmark_spy":benchmark}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# US PIT Risk-Adjusted Momentum V2","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Strategy | Cost | Ann. | Total | MDD | PF | Coverage | Turnover |",
           "|---|---|---:|---:|---:|---:|---:|---:|"]
    for mode in results:
        for cname in base.COSTS:
            x=results[mode][cname];m=x["metrics"];pf="NA" if m["pf"] is None else f'{m["pf"]:.3f}'
            lines.append(f'| {mode} | {cname} | {m["annualized"]*100:.2f}% | {m["return"]*100:.2f}% | {m["mdd"]*100:.2f}% | {pf} | {x["avg_coverage"]*100:.1f}% | {x["avg_turnover"]*100:.1f}% |')
    b=benchmark["base"];lines+=["",f'SPY base benchmark: {b["annualized"]*100:.2f}% ann., MDD {b["mdd"]*100:.2f}%']
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))
if __name__=="__main__":main()
