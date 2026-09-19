#!/usr/bin/env python3
from __future__ import annotations

import csv
import io
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

OUT=Path("market-prediction-lab/artifacts/us-pit-residual-momentum-v1")
OUT.mkdir(parents=True,exist_ok=True)

PIT_URL="https://raw.githubusercontent.com/chinobing/historical_sp500_constituents/main/sp_500_historical_components.csv"
START_MONTH="2016-01"
END_MONTH="2026-07"
DATA_START="2012-12"
COSTS={"base":0.0010,"stress":0.0020}
UA={"User-Agent":"investment-platform-public-research/1.0"}

VARIANTS=[
    "TOTAL_12_1",
    "MARKET_RESIDUAL_12_1",
    "VOL_ADJ_MARKET_RESIDUAL_12_1",
]

def get_text(url,timeout=30,retries=4):
    err=None
    for n in range(retries+1):
        try:
            req=urllib.request.Request(url,headers=UA)
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return r.read().decode("utf-8","replace")
        except Exception as e:
            err=e
            if n<retries:
                time.sleep(1.2*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

def load_membership():
    text=get_text(PIT_URL,timeout=45)
    rows=[]
    for row in csv.DictReader(io.StringIO(text)):
        d=str(row.get("date") or "").strip()
        tickers=str(row.get("tickers") or "").strip()
        if not d or not tickers:
            continue
        try:
            dt=datetime.fromisoformat(d).replace(tzinfo=timezone.utc)
        except Exception:
            continue
        syms={x.strip().upper() for x in tickers.split(",") if x.strip()}
        if syms:
            rows.append((dt,syms))
    rows.sort(key=lambda x:x[0])
    if len(rows)<100:
        raise RuntimeError(f"PIT rows too small: {len(rows)}")
    return rows

def month_range(a,b):
    y,m=map(int,a.split("-"))
    y2,m2=map(int,b.split("-"))
    out=[]
    while (y,m)<=(y2,m2):
        out.append(f"{y:04d}-{m:02d}")
        m+=1
        if m==13:
            y+=1
            m=1
    return out

def membership_for_month(rows,m):
    y,mo=map(int,m.split("-"))
    end=datetime(y+(mo==12),(mo%12)+1,1,tzinfo=timezone.utc)
    chosen=None
    for dt,syms in rows:
        if dt<end:
            chosen=syms
        else:
            break
    return chosen or set()

def month_key(ts_ms):
    d=datetime.fromtimestamp(ts_ms/1000,tz=timezone.utc)
    return f"{d.year:04d}-{d.month:02d}"

def yahoo_symbol(s):
    return s.replace(".","-").replace("/","-")

def fetch_adj(symbol,start_s,end_s):
    ys=yahoo_symbol(symbol)
    q=urllib.parse.urlencode({
        "period1":start_s,
        "period2":end_s,
        "interval":"1d",
        "events":"history",
        "includeAdjustedClose":"true",
    })
    urls=[
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ys)}?{q}",
        f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ys)}?{q}",
    ]
    last=None
    for url in urls:
        for attempt in range(3):
            try:
                raw=get_text(url,timeout=15,retries=0)
                data=json.loads(raw)
                result=(data.get("chart") or {}).get("result")
                if not result:
                    raise RuntimeError("NO_RESULT")
                r=result[0]
                ts=r.get("timestamp") or []
                adj=(((r.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose") or [])
                close=(((r.get("indicators") or {}).get("quote") or [{}])[0].get("close") or [])
                monthly={}
                for i,t in enumerate(ts):
                    v=adj[i] if i<len(adj) else None
                    if v is None and i<len(close):
                        v=close[i]
                    try:
                        v=float(v)
                    except Exception:
                        continue
                    if not math.isfinite(v) or v<=0:
                        continue
                    monthly[month_key(int(t)*1000)]=v
                if len(monthly)>=24:
                    return symbol,monthly,None
                raise RuntimeError(f"INSUFFICIENT_MONTHS_{len(monthly)}")
            except Exception as e:
                last=e
                time.sleep(0.7*(attempt+1))
    return symbol,{},str(last)

def ols_alpha_beta(xs,ys):
    if len(xs)!=len(ys) or len(xs)<24:
        return None
    mx=statistics.mean(xs)
    my=statistics.mean(ys)
    var=sum((x-mx)**2 for x in xs)
    if var<=1e-12:
        return None
    beta=sum((x-mx)*(y-my) for x,y in zip(xs,ys))/var
    alpha=my-beta*mx
    return alpha,beta

def stock_score(variant,s,prices,spy,all_months,index):
    p=prices.get(s,{})
    # Need current m/next month for execution, 36 monthly return observations for regression,
    # and 12-1 formation data through prior month.
    if index<37:
        return None
    required=[all_months[index],all_months[index+1]]
    required += [all_months[index-j] for j in range(1,38)]
    if not all(k in p for k in required):
        return None

    prev1=all_months[index-1]
    prev12=all_months[index-12]
    total=p[prev1]/p[prev12]-1
    if variant=="TOTAL_12_1":
        return total

    xs=[]
    ys=[]
    # 36 monthly return intervals ending at prior month.
    for j in range(index-36,index):
        m0=all_months[j-1]
        m1=all_months[j]
        if m0 not in p or m1 not in p or m0 not in spy or m1 not in spy:
            return None
        sr=p[m1]/p[m0]-1
        mr=spy[m1]/spy[m0]-1
        if not (math.isfinite(sr) and math.isfinite(mr)):
            return None
        xs.append(mr)
        ys.append(sr)

    fit=ols_alpha_beta(xs,ys)
    if fit is None:
        return None
    alpha,beta=fit

    residuals=[]
    # Same conventional 12-1 formation: 11 monthly intervals from t-12 through t-1.
    for j in range(index-11,index):
        m0=all_months[j-1]
        m1=all_months[j]
        sr=p[m1]/p[m0]-1
        mr=spy[m1]/spy[m0]-1
        residuals.append(sr-(alpha+beta*mr))

    if variant=="MARKET_RESIDUAL_12_1":
        return sum(residuals)

    if len(residuals)<2:
        return None
    sd=statistics.stdev(residuals)
    if sd<=1e-8:
        return None
    return statistics.mean(residuals)/sd

def summarize(returns):
    eq=1.0
    peak=1.0
    mdd=0.0
    for r in returns:
        eq*=max(1e-9,1+r)
        peak=max(peak,eq)
        mdd=max(mdd,1-eq/peak)
    wins=[r for r in returns if r>0]
    losses=[r for r in returns if r<0]
    gp=sum(wins)
    gl=-sum(losses)
    years=len(returns)/12
    return {
        "months":len(returns),
        "return":eq-1,
        "annualized":eq**(1/years)-1 if years>0 else None,
        "mdd":mdd,
        "win_rate":len(wins)/len(returns) if returns else 0.0,
        "pf":gp/gl if gl>0 else None,
    }

def simulate(variant,trade_months,all_months,membership,prices,spy,cost):
    idx_map={m:i for i,m in enumerate(all_months)}
    returns=[]
    coverage=[]
    held_prev=set()
    turnover_sum=0.0
    skipped=[]
    details=[]

    for m in trade_months[:-1]:
        i=idx_map[m]
        nextm=all_months[i+1]
        universe=membership[m]
        scored=[]
        eligible_execution=0

        for s in universe:
            p=prices.get(s,{})
            if m in p and nextm in p:
                eligible_execution+=1
            score=stock_score(variant,s,prices,spy,all_months,i)
            if score is not None and math.isfinite(score):
                scored.append((score,s))

        cov=len(scored)/max(1,len(universe))
        coverage.append(cov)
        if cov<0.70 or len(scored)<150:
            skipped.append({"month":m,"coverage":cov,"scored":len(scored),"members":len(universe)})
            continue

        scored.sort(reverse=True)
        n=max(1,math.ceil(len(scored)*0.10))
        held={s for _,s in scored[:n]}

        gross=sum(prices[s][nextm]/prices[s][m]-1 for s in held)/len(held)
        if held_prev:
            overlap=len(held & held_prev)
            turnover=1-overlap/max(len(held),len(held_prev))
        else:
            turnover=1.0
        fee=turnover*2*cost
        net=gross-fee

        returns.append(net)
        turnover_sum+=turnover
        details.append({
            "month":m,
            "next":nextm,
            "members":len(universe),
            "scored":len(scored),
            "coverage":cov,
            "holdings":len(held),
            "gross":gross,
            "turnover":turnover,
            "cost":fee,
            "net":net,
        })
        held_prev=held

    return {
        "metrics":summarize(returns),
        "avg_coverage":sum(coverage)/len(coverage) if coverage else 0.0,
        "avg_turnover":turnover_sum/max(1,len(returns)),
        "skipped":skipped,
        "details":details,
    }

def simulate_spy(trade_months,spy,cost):
    rs=[]
    for m,n in zip(trade_months,trade_months[1:]):
        if m in spy and n in spy:
            rs.append(spy[n]/spy[m]-1)
    if rs:
        rs[0]-=cost
        rs[-1]-=cost
    return summarize(rs)

def main():
    rows=load_membership()
    all_months=month_range(DATA_START,END_MONTH)
    trade_months=month_range(START_MONTH,END_MONTH)
    membership={m:membership_for_month(rows,m) for m in trade_months}
    symbols=sorted(set().union(*membership.values()))

    start_s=int(datetime(2012,1,1,tzinfo=timezone.utc).timestamp())
    end_s=int(datetime(2026,9,1,tzinfo=timezone.utc).timestamp())
    prices={}
    failures={}

    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_adj,s,start_s,end_s):s for s in symbols+["SPY"]}
        for idx,f in enumerate(as_completed(futs),1):
            s,monthly,err=f.result()
            if monthly:
                prices[s]=monthly
            else:
                failures[s]=err
            if idx%50==0:
                print(json.dumps({
                    "stage":"prices",
                    "done":idx,
                    "total":len(futs),
                    "ok":len(prices),
                    "failed":len(failures),
                }),flush=True)

    spy=prices.pop("SPY",{})
    if not spy:
        raise RuntimeError("SPY price unavailable")

    results={}
    for variant in VARIANTS:
        results[variant]={}
        for cname,cost in COSTS.items():
            results[variant][cname]=simulate(
                variant,trade_months,all_months,membership,prices,spy,cost
            )

    benchmark={k:simulate_spy(trade_months,spy,c) for k,c in COSTS.items()}

    payload={
        "schemaVersion":1,
        "kind":"us-pit-residual-momentum-v1",
        "research_only":True,
        "public_data_only":True,
        "live_trading":False,
        "private_api":False,
        "orders_submitted":0,
        "lookahead_free":True,
        "membership_source":PIT_URL,
        "period":{"start":START_MONTH,"end":END_MONTH},
        "variants":{
            "TOTAL_12_1":"conventional 12-1 adjusted-price momentum",
            "MARKET_RESIDUAL_12_1":"sum of 12-1 residual monthly returns after rolling 36m OLS versus SPY",
            "VOL_ADJ_MARKET_RESIDUAL_12_1":"mean 12-1 residual divided by residual standard deviation",
        },
        "selection":"top decile of point-in-time S&P500 members, equal weight, monthly rebalance",
        "costs":COSTS,
        "symbol_count":len(symbols),
        "price_success":len(prices),
        "price_failures":len(failures),
        "failure_examples":dict(list(failures.items())[:30]),
        "results":results,
        "benchmark_spy":benchmark,
        "limitations":[
            "Residual model removes only SPY market exposure, not the full Fama-French factor set used by the original residual-momentum literature.",
            "Yahoo adjusted prices are public research data and may have provider-specific historical corrections.",
            "Turnover cost is a conservative research assumption, not a broker fee schedule.",
        ],
    }
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")

    lines=[
        "# US PIT Residual Momentum V1",
        "",
        "RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS",
        "",
        f"PIT symbols: {len(symbols)}; price success: {len(prices)}; failures: {len(failures)}",
        "",
        "| Variant | Cost | Ann. | Total | MDD | PF | Coverage | Turnover | SPY ann. |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for variant in VARIANTS:
        for cname in COSTS:
            x=results[variant][cname]
            m=x["metrics"]
            b=benchmark[cname]
            pf="NA" if m["pf"] is None else f'{m["pf"]:.3f}'
            lines.append(
                f'| {variant} | {cname} | {m["annualized"]*100:.2f}% | {m["return"]*100:.2f}% | '
                f'{m["mdd"]*100:.2f}% | {pf} | {x["avg_coverage"]*100:.1f}% | '
                f'{x["avg_turnover"]*100:.1f}% | {b["annualized"]*100:.2f}% |'
            )
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":
    main()
