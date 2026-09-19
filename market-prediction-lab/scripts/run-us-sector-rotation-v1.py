#!/usr/bin/env python3
from __future__ import annotations
import json, math, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

SECTORS=["XLB","XLE","XLF","XLI","XLK","XLP","XLU","XLV","XLY"]
ALL=SECTORS+["SPY"]
OUT=Path("market-prediction-lab/artifacts/us-sector-rotation-v1"); OUT.mkdir(parents=True,exist_ok=True)
UA={"User-Agent":"investment-platform-public-research/1.0"}
COSTS={"base":0.0010,"stress":0.0015}
DAY=86400000

def get_json(url,retries=4):
    err=None
    for n in range(retries+1):
        try:
            req=urllib.request.Request(url,headers=UA)
            with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)
        except Exception as e:
            err=e
            if n<retries:time.sleep(1.0*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

def fetch(symbol,start_ms,end_ms):
    q=urllib.parse.urlencode({
        "period1":start_ms//1000,"period2":end_ms//1000,
        "interval":"1d","events":"history","includeAdjustedClose":"true"
    })
    data=get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?{q}")
    r=data["chart"]["result"][0]
    ts=r.get("timestamp") or []
    quote=r["indicators"]["quote"][0]
    adj=(r["indicators"].get("adjclose") or [{}])[0].get("adjclose") or []
    out={}
    for i,t in enumerate(ts):
        try:
            o=float(quote["open"][i]);c=float(quote["close"][i]);a=float(adj[i])
            if not all(math.isfinite(x) and x>0 for x in (o,c,a)):continue
            factor=a/c
            out[int(t)*1000]={"open":o*factor,"close":a}
        except Exception:continue
    if len(out)<2000:raise RuntimeError(f"{symbol} insufficient {len(out)}")
    return out

def sma(vals,i,n):
    if i<n-1:return None
    return sum(vals[i-n+1:i+1])/n

def month_rebalance_indices(dates):
    out=[]
    last=None
    for i,t in enumerate(dates):
        d=datetime.fromtimestamp(t/1000,tz=timezone.utc)
        key=(d.year,d.month)
        if key!=last:
            if i>252:out.append(i)
            last=key
    return out

def target_weights(prices,dates,i):
    sig=i-1
    spy=[prices["SPY"][t]["close"] for t in dates]
    ma=sma(spy,sig,200)
    if ma is None or spy[sig]<=ma:
        return {s:0.0 for s in SECTORS}
    # 12-1 momentum: close ~21 trading days ago / close ~252 trading days ago -1
    if sig<252:return {s:0.0 for s in SECTORS}
    scores=[]
    for s in SECTORS:
        p1=prices[s][dates[sig-21]]["close"]
        p12=prices[s][dates[sig-252]]["close"]
        mom=p1/p12-1
        if mom>0:scores.append((mom,s))
    scores.sort(reverse=True)
    chosen=[s for _,s in scores[:3]]
    w={s:0.0 for s in SECTORS}
    if chosen:
        each=1/len(chosen)
        for s in chosen:w[s]=each
    return w

def summarize(period_returns):
    eq=1.0;peak=1.0;mdd=0.0
    for r in period_returns:
        eq*=max(1e-9,1+r);peak=max(peak,eq);mdd=max(mdd,1-eq/peak)
    wins=[x for x in period_returns if x>0];loss=[x for x in period_returns if x<0]
    gp=sum(wins);gl=-sum(loss)
    years=len(period_returns)/12
    return {
        "months":len(period_returns),"return":eq-1,
        "annualized":eq**(1/years)-1 if years>0 else None,
        "mdd":mdd,"win_rate":len(wins)/len(period_returns) if period_returns else 0,
        "pf":gp/gl if gl else None,
    }

def simulate(prices,dates,cost,start_fraction=0.0):
    rb=month_rebalance_indices(dates)
    start_pos=max(0,int(len(rb)*start_fraction))
    rb=rb[start_pos:]
    weights={s:0.0 for s in SECTORS}
    eq=1.0;rets=[];turnover_total=0.0;cash_months=0
    for j in range(len(rb)-1):
        i,nxt=rb[j],rb[j+1]
        neww=target_weights(prices,dates,i)
        turnover=sum(abs(neww[s]-weights[s]) for s in SECTORS)
        eq_before=eq
        eq*=max(0,1-turnover*cost);turnover_total+=turnover
        if sum(neww.values())==0:cash_months+=1
        gross=0.0
        for s,w in neww.items():
            if w<=0:continue
            p0=prices[s][dates[i]]["open"];p1=prices[s][dates[nxt]]["open"]
            gross+=w*(p1/p0-1)
        eq*=1+gross
        rets.append(eq/eq_before-1)
        weights=neww
    if sum(weights.values())>0:
        eq_before=eq;eq*=max(0,1-sum(weights.values())*cost)
        rets.append(eq/eq_before-1)
    m=summarize(rets)
    m.update({"turnover_units":turnover_total,"cash_months":cash_months})
    return m

def benchmark(prices,dates,start_fraction=0.0,cost=0.0,kind="SPY"):
    rb=month_rebalance_indices(dates)
    rb=rb[max(0,int(len(rb)*start_fraction)):]
    rs=[]
    if len(rb)<2:return summarize(rs)
    for j in range(len(rb)-1):
        i,nxt=rb[j],rb[j+1]
        if kind=="SPY":
            r=prices["SPY"][dates[nxt]]["open"]/prices["SPY"][dates[i]]["open"]-1
        else:
            r=sum(prices[s][dates[nxt]]["open"]/prices[s][dates[i]]["open"]-1 for s in SECTORS)/len(SECTORS)
        if j==0:r-=cost
        if j==len(rb)-2:r-=cost
        rs.append(r)
    return summarize(rs)

def main():
    end=int(datetime(2026,9,1,tzinfo=timezone.utc).timestamp()*1000)
    start=int(datetime(2011,1,1,tzinfo=timezone.utc).timestamp()*1000)
    prices={}
    for s in ALL:
        prices[s]=fetch(s,start,end)
        print(json.dumps({"loaded":s,"rows":len(prices[s])}),flush=True)
    common=set(prices[ALL[0]])
    for s in ALL:common &= set(prices[s])
    dates=sorted(common)
    if len(dates)<2500:raise RuntimeError(f"common rows insufficient {len(dates)}")
    results={}
    for cname,cost in COSTS.items():
        results[cname]={
            "full":simulate(prices,dates,cost,0.0),
            "recent30pct":simulate(prices,dates,cost,0.70),
        }
    benchmarks={
        "SPY":{"full":benchmark(prices,dates,0.0,COSTS["base"],"SPY"),
               "recent30pct":benchmark(prices,dates,0.70,COSTS["base"],"SPY")},
        "EQUAL_SECTORS":{"full":benchmark(prices,dates,0.0,COSTS["base"],"EW"),
                         "recent30pct":benchmark(prices,dates,0.70,COSTS["base"],"EW")},
    }
    payload={
        "schemaVersion":1,"kind":"us-sector-rotation-v1","research_only":True,
        "public_data_only":True,"live_trading":False,"private_api":False,"orders_submitted":0,
        "lookahead_free":True,
        "formula":{"universe":SECTORS,"momentum":"12-1","top_n":3,
                   "market_gate":"SPY prior close > SMA200","rebalance":"monthly next session open",
                   "long_only":True},
        "period":{"start":"2011-01","end":"2026-08"},"common_rows":len(dates),
        "costs":COSTS,"results":results,"benchmarks":benchmarks,
        "limitations":["sector ETFs avoid individual-stock survivorship bias but dividends rely on Yahoo adjusted prices"],
    }
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# US Sector Rotation V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Case | Ann. | Total | MDD | PF |",
           "|---|---:|---:|---:|---:|"]
    for cname in COSTS:
        for seg in ("full","recent30pct"):
            x=results[cname][seg];pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
            lines.append(f'| Strategy {cname} {seg} | {x["annualized"]*100:.2f}% | {x["return"]*100:.2f}% | {x["mdd"]*100:.2f}% | {pf} |')
    for b in benchmarks:
        for seg in ("full","recent30pct"):
            x=benchmarks[b][seg];pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
            lines.append(f'| {b} {seg} | {x["annualized"]*100:.2f}% | {x["return"]*100:.2f}% | {x["mdd"]*100:.2f}% | {pf} |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":main()
