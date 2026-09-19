#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, json, sys
from pathlib import Path

BASE_PATH=Path("market-prediction-lab/scripts/run-binance-cross-sectional-orderflow-v1.py")
spec=importlib.util.spec_from_file_location("cs_orderflow_base",BASE_PATH)
base=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=base
spec.loader.exec_module(base)

OUT=Path("market-prediction-lab/artifacts/binance-cross-sectional-funding-carry-v1")
OUT.mkdir(parents=True,exist_ok=True)

def trailing_funding(funding,t,days):
    lo=t-days*86_400_000
    return sum(r for ts,r in funding if lo<ts<=t)

def target_weights(funding,ts,i,days):
    scores=[(trailing_funding(funding[s],ts[i],days),s) for s in base.SYMBOLS]
    scores.sort()
    w={s:0.0 for s in base.SYMBOLS}
    for _,s in scores[:2]:w[s]=0.25
    for _,s in scores[-2:]:w[s]=-0.25
    return w

def summarize(rs,curve,turnover,days):
    peak=1.0;mdd=0.0
    for e in curve:
        peak=max(peak,e);mdd=max(mdd,1-e/peak)
    wins=[x for x in rs if x>0];loss=[x for x in rs if x<0]
    gp=sum(wins);gl=-sum(loss)
    eq=curve[-1] if curve else 1.0
    years=days/365.25
    return {"days":days,"return":eq-1,
            "annualized":eq**(1/years)-1 if years>0 and eq>0 else None,
            "mdd":mdd,"win_rate":len(wins)/len(rs) if rs else 0,
            "pf":gp/gl if gl else None,
            "avg_daily":sum(rs)/len(rs) if rs else 0,
            "turnover":turnover}

def simulate(ts,bars,funding,lookback_days,cost,start_index):
    start=max(start_index,31)
    cur={s:0.0 for s in base.SYMBOLS};eq=1.0;curve=[1.0];rs=[];turn=0.0
    next_rebalance=start
    for i in range(start,len(ts)-1):
        if i>=next_rebalance:
            target=target_weights(funding,ts,i,lookback_days)
            tv=sum(abs(target[s]-cur[s]) for s in base.SYMBOLS)
            turn+=tv;eq*=max(0.01,1-tv*cost);cur=target;next_rebalance=i+7
        daily=0.0
        for s in base.SYMBOLS:
            if cur[s]==0:continue
            pr=bars[s][i+1].o/bars[s][i].o-1
            fr=base.funding_between(funding[s],ts[i],ts[i+1])
            daily+=cur[s]*pr-cur[s]*fr
        eq*=max(0.01,1+daily);curve.append(eq);rs.append(daily)
    tv=sum(abs(cur[s]) for s in base.SYMBOLS);turn+=tv
    eq*=max(0.01,1-tv*cost);curve.append(eq)
    return summarize(rs,curve,turn,len(rs))

def main():
    data={};fund={};prov={}
    for s in base.SYMBOLS:
        b,f,kc,fc=base.load(s)
        data[s]=(b,f);fund[s]=f
        prov[s]={"daily_rows":len(b),"funding_rows":len(f),"funding_status":"BINANCE_VISION_OK",
                 "kline_sha256":kc,"funding_sha256":fc}
        print(json.dumps({"loaded":s,"days":len(b),"funding":len(f)}),flush=True)
    ts,bars=base.align(data)
    recent=int(len(ts)*0.70)
    results={}
    for days in (7,30):
        name=f"CARRY_XS_{days}D"
        results[name]={}
        for cname,cost in base.COSTS.items():
            results[name][cname]={
              "full":simulate(ts,bars,fund,days,cost,31),
              "recent30pct":simulate(ts,bars,fund,days,cost,recent),
            }
    payload={"schemaVersion":1,"kind":"binance-cross-sectional-funding-carry-v1",
             "research_only":True,"public_data_only":True,"live_trading":False,
             "private_api":False,"orders_submitted":0,"lookahead_free":True,"leverage":1,
             "formula":{
               "ranking":"trailing realized funding known at rebalance time",
               "portfolio":"long 2 lowest-funding, short 2 highest-funding, 25% notional each; dollar-neutral gross 1.0",
               "rebalance_days":7,
               "lookbacks":[7,30],
               "selection_rule":"pre-registered both; robustness requires both variants rather than selecting the better one",
             },
             "symbols":base.SYMBOLS,"months":base.MONTHS,"costs":base.COSTS,
             "common_days":len(ts),"provenance":prov,"results":results}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# Binance Cross-Sectional Funding Carry V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Strategy | Cost | Window | Return | Ann. | PF | MDD | Turnover |",
           "|---|---|---|---:|---:|---:|---:|---:|"]
    for name in results:
        for cname in base.COSTS:
            for window in ("full","recent30pct"):
                x=results[name][cname][window]
                pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
                lines.append(f'| {name} | {cname} | {window} | {x["return"]*100:.2f}% | {x["annualized"]*100:.2f}% | {pf} | {x["mdd"]*100:.2f}% | {x["turnover"]:.1f} |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))
if __name__=="__main__":main()
