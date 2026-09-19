#!/usr/bin/env python3
from __future__ import annotations
import csv, io, json, math, statistics, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

OUT=Path("market-prediction-lab/artifacts/us-pit-momentum-v1"); OUT.mkdir(parents=True,exist_ok=True)
PIT_URL="https://raw.githubusercontent.com/chinobing/historical_sp500_constituents/main/sp_500_historical_components.csv"
START_YEAR=2016
END_MONTH="2026-07"
COSTS={"base":0.0010,"stress":0.0020}
UA={"User-Agent":"investment-platform-public-research/1.0"}

def get_text(url,timeout=30,retries=4):
    err=None
    for n in range(retries+1):
        try:
            req=urllib.request.Request(url,headers=UA)
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return r.read().decode("utf-8","replace")
        except Exception as e:
            err=e
            if n<retries: time.sleep(1.5*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

def load_membership():
    text=get_text(PIT_URL,timeout=45)
    rows=[]
    reader=csv.DictReader(io.StringIO(text))
    for row in reader:
        d=str(row.get("date") or "").strip()
        tickers=str(row.get("tickers") or "").strip()
        if not d or not tickers: continue
        try: dt=datetime.fromisoformat(d).replace(tzinfo=timezone.utc)
        except Exception: continue
        syms={x.strip().upper() for x in tickers.split(",") if x.strip()}
        if syms: rows.append((dt,syms))
    rows.sort(key=lambda x:x[0])
    if len(rows)<100: raise RuntimeError(f"PIT rows too small: {len(rows)}")
    return rows,text

def month_key(ts_ms):
    d=datetime.fromtimestamp(ts_ms/1000,tz=timezone.utc)
    return f"{d.year:04d}-{d.month:02d}"

def yahoo_symbol(s):
    return s.replace(".","-").replace("/","-")

def fetch_adj(symbol,start_s,end_s):
    ys=yahoo_symbol(symbol)
    q=urllib.parse.urlencode({"period1":start_s,"period2":end_s,"interval":"1d","events":"history","includeAdjustedClose":"true"})
    urls=[f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ys)}?{q}",
          f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ys)}?{q}"]
    last=None
    for base in urls:
        for attempt in range(3):
            try:
                raw=get_text(base,timeout=15,retries=0)
                data=json.loads(raw); result=(data.get("chart") or {}).get("result")
                if not result: raise RuntimeError("NO_RESULT")
                r=result[0]; ts=r.get("timestamp") or []
                adj=(((r.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose") or [])
                close=(((r.get("indicators") or {}).get("quote") or [{}])[0].get("close") or [])
                monthly={}
                for i,t in enumerate(ts):
                    v=adj[i] if i<len(adj) else None
                    if v is None and i<len(close): v=close[i]
                    try: v=float(v)
                    except Exception: continue
                    if not math.isfinite(v) or v<=0: continue
                    monthly[month_key(int(t)*1000)]=v
                if len(monthly)>=24: return symbol,monthly,None
                raise RuntimeError(f"INSUFFICIENT_MONTHS_{len(monthly)}")
            except Exception as e:
                last=e; time.sleep(0.8*(attempt+1))
    return symbol,{},str(last)

def month_range(a,b):
    y,m=map(int,a.split("-")); y2,m2=map(int,b.split("-")); out=[]
    while (y,m)<=(y2,m2):
        out.append(f"{y:04d}-{m:02d}"); m+=1
        if m==13:y+=1;m=1
    return out

def membership_for_month(rows,m):
    y,mo=map(int,m.split("-"))
    end=datetime(y+(mo==12),(mo%12)+1,1,tzinfo=timezone.utc)
    chosen=None
    for dt,syms in rows:
        if dt<end: chosen=syms
        else: break
    return chosen or set()

def summarize(returns):
    eq=1.0; peak=1.0; mdd=0.0
    for r in returns:
        eq*=max(1e-9,1+r); peak=max(peak,eq); mdd=max(mdd,1-eq/peak)
    wins=[r for r in returns if r>0]; losses=[r for r in returns if r<0]
    gp=sum(wins); gl=-sum(losses)
    years=len(returns)/12
    return {"months":len(returns),"return":eq-1,"annualized":eq**(1/years)-1 if years>0 else None,
            "mdd":mdd,"win_rate":len(wins)/len(returns) if returns else 0,
            "pf":gp/gl if gl>0 else None}

def simulate(months,membership,prices,cost):
    rets=[]; coverage=[]; held_prev=set(); turnover_sum=0.0; missing_months=[]
    details=[]
    for i in range(12,len(months)-1):
        m=months[i]; prev1=months[i-1]; prev12=months[i-12]; nextm=months[i+1]
        universe=membership[m]
        scored=[]; available=0
        for s in universe:
            p=prices.get(s,{})
            if all(k in p for k in (m,prev1,prev12,nextm)):
                available+=1
                mom=p[prev1]/p[prev12]-1
                if math.isfinite(mom): scored.append((mom,s))
        cov=available/max(1,len(universe)); coverage.append(cov)
        if cov<0.70 or len(scored)<150:
            missing_months.append({"month":m,"coverage":cov,"eligible":len(scored),"members":len(universe)})
            continue
        scored.sort(reverse=True)
        n=max(1,math.ceil(len(scored)*0.10))
        held={s for _,s in scored[:n]}
        gross=sum(prices[s][nextm]/prices[s][m]-1 for s in held)/len(held)
        if held_prev:
            overlap=len(held & held_prev)
            turnover=1-overlap/max(len(held),len(held_prev))
        else: turnover=1.0
        # entry/exit equivalent cost on changed notional; approximate one-way turnover * 2 sides.
        fee=turnover*2*cost
        net=gross-fee
        rets.append(net); turnover_sum+=turnover
        details.append({"month":m,"next":nextm,"members":len(universe),"eligible":len(scored),"coverage":cov,
                        "holdings":len(held),"gross":gross,"turnover":turnover,"cost":fee,"net":net})
        held_prev=held
    return {"metrics":summarize(rets),"avg_coverage":sum(coverage)/len(coverage) if coverage else 0,
            "avg_turnover":turnover_sum/max(1,len(rets)),"skipped":missing_months,"details":details}

def simulate_spy(months,spy,cost):
    rs=[]
    for i in range(12,len(months)-1):
        m,n=months[i],months[i+1]
        if m in spy and n in spy: rs.append(spy[n]/spy[m]-1)
    if rs: rs[0]-=cost; rs[-1]-=cost
    return summarize(rs)

def main():
    rows,pit_text=load_membership()
    months=month_range(f"{START_YEAR}-01",END_MONTH)
    membership={m:membership_for_month(rows,m) for m in months}
    symbols=sorted(set().union(*membership.values()))
    start_s=int(datetime(2014,1,1,tzinfo=timezone.utc).timestamp())
    end_s=int(datetime(2026,9,1,tzinfo=timezone.utc).timestamp())
    prices={}; failures={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_adj,s,start_s,end_s):s for s in symbols+["SPY"]}
        for idx,f in enumerate(as_completed(futs),1):
            s,monthly,err=f.result()
            if monthly: prices[s]=monthly
            else: failures[s]=err
            if idx%50==0: print(json.dumps({"stage":"prices","done":idx,"total":len(futs),"ok":len(prices),"failed":len(failures)}),flush=True)
    spy=prices.pop("SPY",{})
    if not spy: raise RuntimeError("SPY price unavailable")
    results={k:simulate(months,membership,prices,c) for k,c in COSTS.items()}
    bench={k:simulate_spy(months,spy,c) for k,c in COSTS.items()}
    payload={"schemaVersion":1,"kind":"us-pit-sp500-momentum-v1","research_only":True,"public_data_only":True,
             "live_trading":False,"private_api":False,"orders_submitted":0,"lookahead_free":True,
             "formula":{"signal":"12-1 momentum = adjclose[t-1m]/adjclose[t-12m]-1","selection":"top decile of point-in-time S&P500 members",
                        "rebalance":"monthly","weight":"equal","long_only":True},
             "membership_source":PIT_URL,"period":{"start":months[0],"end":months[-1]},"symbol_count":len(symbols),
             "price_success":len(prices),"price_failures":len(failures),"failure_examples":dict(list(failures.items())[:30]),
             "results":results,"benchmark_spy":bench}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# US PIT S&P500 Momentum V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           f"Symbols in PIT universe: {len(symbols)}; price success: {len(prices)}; failures: {len(failures)}","",
           "| Cost | Strategy ann. | Strategy total | MDD | PF | Avg coverage | Avg turnover | SPY ann. | SPY MDD |",
           "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for k in COSTS:
        x=results[k]; m=x["metrics"]; b=bench[k]
        pf="NA" if m["pf"] is None else f'{m["pf"]:.3f}'
        lines.append(f'| {k} | {m["annualized"]*100:.2f}% | {m["return"]*100:.2f}% | {m["mdd"]*100:.2f}% | {pf} | {x["avg_coverage"]*100:.1f}% | {x["avg_turnover"]*100:.1f}% | {b["annualized"]*100:.2f}% | {b["mdd"]*100:.2f}% |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__": main()
