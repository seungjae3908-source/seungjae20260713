#!/usr/bin/env python3
from __future__ import annotations

import csv, hashlib, io, json, math, time, urllib.request, zipfile
from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

OUT=Path("market-prediction-lab/artifacts/hl-spot-perp-carry-v1")
OUT.mkdir(parents=True,exist_ok=True)

SYMBOLS={
    "BTC":{"hl":"BTC","spot":"BTCUSDT"},
    "ETH":{"hl":"ETH","spot":"ETHUSDT"},
    "SOL":{"hl":"SOL","spot":"SOLUSDT"},
}
MONTHS=[f"2026-{m:02d}" for m in range(3,9)]
START_MS=int(datetime(2026,3,1,tzinfo=timezone.utc).timestamp()*1000)
END_MS=int(datetime(2026,9,1,tzinfo=timezone.utc).timestamp()*1000)
DAY_MS=86_400_000
H4_MS=14_400_000

HL_INFO="https://api.hyperliquid.xyz/info"
SPOT_BASE="https://data.binance.vision/data/spot/monthly/klines"
UA={"User-Agent":"investment-platform-public-research/1.0"}

COSTS={
    "base":{"hl_taker":0.00060,"spot_taker":0.00100,"daily_hedge_capital":0.000010},
    "stress":{"hl_taker":0.00100,"spot_taker":0.00150,"daily_hedge_capital":0.000025},
}

@dataclass(frozen=True)
class Candle:
    t:int
    close:float

def get_bytes(url,timeout=45,retries=4,pause=1.0):
    err=None
    for n in range(retries+1):
        try:
            req=urllib.request.Request(url,headers=UA)
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return r.read()
        except Exception as e:
            err=e
            if n<retries: time.sleep(pause*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

def request_json(url,body,timeout=30,retries=4):
    err=None
    for n in range(retries+1):
        try:
            data=json.dumps(body).encode()
            req=urllib.request.Request(url,data=data,headers={**UA,"accept":"application/json","content-type":"application/json"},method="POST")
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8","replace"))
        except Exception as e:
            err=e
            if n<retries: time.sleep(1.0*(2**n))
    raise RuntimeError(f"request failed {url}: {err}")

def hl_post(body):
    return request_json(HL_INFO,body)

def fetch_hl_funding(coin):
    cursor=START_MS
    out=[]
    calls=0
    while cursor<END_MS:
        rows=hl_post({"type":"fundingHistory","coin":coin,"startTime":cursor,"endTime":END_MS-1})
        calls+=1
        if not isinstance(rows,list): raise RuntimeError(f"HL funding invalid {coin}")
        for row in rows:
            try:
                t=int(row["time"]); r=float(row["fundingRate"])
                if START_MS<=t<END_MS and math.isfinite(r): out.append((t,r))
            except Exception: pass
        if len(rows)<500: break
        mx=max((int(x.get("time",0)) for x in rows),default=0)
        if mx<cursor: raise RuntimeError(f"HL pagination stalled {coin}")
        cursor=mx+1
        time.sleep(2.4)
    arr=sorted({t:r for t,r in out}.items())
    if len(arr)<500: raise RuntimeError(f"HL funding short {coin}: {len(arr)}")
    return arr,calls

def fetch_hl_candles(coin):
    rows=hl_post({"type":"candleSnapshot","req":{"coin":coin,"interval":"4h","startTime":START_MS,"endTime":END_MS-1}})
    out=[]
    for row in rows if isinstance(rows,list) else []:
        try:
            t=int(row["t"]); c=float(row["c"])
            if START_MS<=t<END_MS and c>0 and math.isfinite(c): out.append(Candle(t,c))
        except Exception: pass
    arr=[x for _,x in sorted({x.t:x for x in out}.items())]
    if len(arr)<900: raise RuntimeError(f"HL candles short {coin}: {len(arr)}")
    return arr

def checked_zip(url,name):
    data=get_bytes(url)
    chk=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if chk.lower()!=actual.lower(): raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(data)),actual

def fetch_spot_month(symbol,month):
    name=f"{symbol}-4h-{month}.zip"
    z,digest=checked_zip(f"{SPOT_BASE}/{symbol}/4h/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"): continue
        rd=csv.reader(io.TextIOWrapper(z.open(member),encoding="utf-8"))
        for r in rd:
            if not r or not r[0].isdigit(): continue
            try:
                t=int(r[0])
                if t>100_000_000_000_000: t//=1000
                c=float(r[4])
                if START_MS<=t<END_MS and c>0 and math.isfinite(c): rows.append(Candle(t,c))
            except Exception: pass
    return month,rows,digest

def fetch_spot(symbol):
    rows=[]; checks={}
    for m in MONTHS:
        _,part,d=fetch_spot_month(symbol,m)
        rows.extend(part); checks[m]=d
        print(json.dumps({"stage":"spot_month","symbol":symbol,"month":m,"bars":len(part)}),flush=True)
    arr=[x for _,x in sorted({x.t:x for x in rows}.items())]
    if len(arr)<900: raise RuntimeError(f"spot candles short {symbol}: {len(arr)}")
    return arr,checks

def window_sum(events,start,end):
    ts=[x[0] for x in events]
    a=bisect_left(ts,start); b=bisect_left(ts,end)
    return sum(r for _,r in events[a:b])

def align(hlc,spotc):
    hm={x.t:x.close for x in hlc}; sm={x.t:x.close for x in spotc}
    common=sorted(set(hm)&set(sm))
    segments=[]; cur=[]; prev=None
    for t in common:
        if prev is None or t-prev==H4_MS: cur.append(t)
        else:
            if cur: segments.append(cur)
            cur=[t]
        prev=t
    if cur: segments.append(cur)
    seg=max(segments,key=len)
    if len(seg)<900: raise RuntimeError(f"aligned bars short {len(seg)}")
    return seg,hm,sm

def event_cost(cost):
    return (cost["hl_taker"]+cost["spot_taker"])/2

def annualize(eq,days):
    return eq**(365.25/days)-1 if days>0 and eq>0 else None

def simulate(times,hl_px,spot_px,hl_f,cost):
    # Static classic carry: LONG Binance spot / SHORT Hyperliquid perpetual.
    # Returns measured on fully funded two-leg capital.
    eq=1.0; curve=[1.0]; daily=[]
    funding_sum=0.0; basis_sum=0.0; costs_sum=0.0
    open_cost=event_cost(cost)
    eq*=1-open_cost; curve[-1]=eq; costs_sum-=open_cost
    days=0; i=0
    while i+6<len(times):
        t=times[i]
        if (t//H4_MS)%6!=0:
            i+=1; continue
        t2=times[i+6]
        if t2-t!=DAY_MS:
            i+=1; continue
        # Short perp receives positive HL funding.
        funding=window_sum(hl_f,t,t2)/2
        r_spot=spot_px[t2]/spot_px[t]-1
        r_hl=hl_px[t2]/hl_px[t]-1
        basis=(r_spot-r_hl)/2
        hedge=-cost["daily_hedge_capital"]
        net=funding+basis+hedge
        funding_sum+=funding; basis_sum+=basis; costs_sum+=hedge
        eq*=max(0.01,1+net); curve.append(eq); daily.append(net)
        days+=1; i+=6
    close_cost=event_cost(cost)
    eq*=1-close_cost; curve[-1]=eq; costs_sum-=close_cost

    peak=curve[0]; mdd=0.0
    for e in curve:
        peak=max(peak,e); mdd=min(mdd,e/peak-1)
    wins=[x for x in daily if x>0]; losses=[x for x in daily if x<0]
    gp=sum(wins); gl=-sum(losses)
    return {
        "days":days,"return":eq-1,"annualized":annualize(eq,days),"mdd":mdd,
        "pf":gp/gl if gl else None,"win_rate":len(wins)/len(daily) if daily else 0.0,
        "exposure":1.0,"funding_contribution_simple":funding_sum,
        "basis_contribution_simple":basis_sum,"cost_contribution_simple":costs_sum,
    }

def portfolio(by):
    xs=list(by.values())
    return {
        "equal_weight_return":sum(x["return"] for x in xs)/len(xs),
        "equal_weight_annualized":sum(x["annualized"] for x in xs)/len(xs),
        "avg_mdd":sum(x["mdd"] for x in xs)/len(xs),
        "positive_symbols":sum(x["return"]>0 for x in xs),
    }

def main():
    data={}; provenance={}
    for coin,spec in SYMBOLS.items():
        print(json.dumps({"stage":"hl","coin":coin}),flush=True)
        hlf,calls=fetch_hl_funding(spec["hl"]); hlc=fetch_hl_candles(spec["hl"])
        spotc,checks=fetch_spot(spec["spot"])
        times,hpx,spx=align(hlc,spotc)
        data[coin]=(times,hpx,spx,hlf)
        provenance[coin]={
            "start":datetime.fromtimestamp(times[0]/1000,tz=timezone.utc).isoformat(),
            "end":datetime.fromtimestamp(times[-1]/1000,tz=timezone.utc).isoformat(),
            "aligned_4h_bars":len(times),"hyperliquid_funding_rows":len(hlf),
            "hyperliquid_funding_calls":calls,"binance_spot_monthly_sha256":checks,
            "sources":{"hyperliquid":"official public info endpoint","binance_spot":"official Binance Vision public archive"},
        }
    results={}
    for cname,cost in COSTS.items():
        by={coin:simulate(*data[coin],cost) for coin in SYMBOLS}
        results[cname]={"portfolio":portfolio(by),"symbols":by}
    payload={
        "schemaVersion":1,"kind":"hl-spot-perp-carry-v1","research_only":True,"public_data_only":True,
        "live_trading":False,"private_api":False,"orders_submitted":0,"leverage":1,
        "capital_measure":"fully funded two-leg capital; one notional spot + one notional perp collateral",
        "period":{"start_ms":START_MS,"end_ms":END_MS},
        "formula":{"orientation":"STATIC LONG Binance spot / SHORT Hyperliquid perpetual",
                   "holding":"entire six-month sample","funding_pnl_included":True,"basis_pnl_included":True,
                   "hedging":"daily equal-notional hedge maintenance approximation"},
        "costs":COSTS,"symbols":list(SYMBOLS),"provenance":provenance,"results":results,
        "limitations":["Historical bid/ask depth is not modeled.","Daily hedge maintenance is approximated with an explicit cost.","No leverage/liquidation model; 1x per leg only.","Cost fields are conservative research assumptions, not venue fee schedules."]
    }
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# Hyperliquid Perp + Binance Spot Carry V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Cost | EW total | EW ann. | Positive | Avg MDD |","|---|---:|---:|---:|---:|"]
    for cname in COSTS:
        p=results[cname]["portfolio"]
        lines.append(f'| {cname} | {p["equal_weight_return"]*100:.2f}% | {p["equal_weight_annualized"]*100:.2f}% | {p["positive_symbols"]}/3 | {p["avg_mdd"]*100:.2f}% |')
    lines+=["","## Base by symbol","","| Coin | Return | Ann. | MDD | PF | Funding* | Basis* | Costs* |","|---|---:|---:|---:|---:|---:|---:|---:|"]
    for coin,x in results["base"]["symbols"].items():
        pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
        lines.append(f'| {coin} | {x["return"]*100:.2f}% | {x["annualized"]*100:.2f}% | {x["mdd"]*100:.2f}% | {pf} | {x["funding_contribution_simple"]*100:.2f}% | {x["basis_contribution_simple"]*100:.2f}% | {x["cost_contribution_simple"]*100:.2f}% |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__": main()
