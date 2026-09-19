#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

OUT=Path("market-prediction-lab/artifacts/cross-venue-funding-v1")
OUT.mkdir(parents=True,exist_ok=True)

SYMBOLS={
    "BTC":{"hl":"BTC","bybit":"BTCUSDT"},
    "ETH":{"hl":"ETH","bybit":"ETHUSDT"},
    "SOL":{"hl":"SOL","bybit":"SOLUSDT"},
}
START_MS=int(datetime(2026,3,1,tzinfo=timezone.utc).timestamp()*1000)
END_MS=int(datetime(2026,9,1,tzinfo=timezone.utc).timestamp()*1000)
DAY_MS=86_400_000
H4_MS=14_400_000
TRAIL_MS=7*DAY_MS

HL_INFO="https://api.hyperliquid.xyz/info"
BYBIT="https://api.bybit.com"

COSTS={
    "base":{"taker_per_leg":0.00050,"daily_hedge_capital":0.000010},
    "stress":{"taker_per_leg":0.00080,"daily_hedge_capital":0.000025},
}
UA={"User-Agent":"investment-platform-public-research/1.0"}

@dataclass(frozen=True)
class Candle:
    t:int
    close:float

def request_json(url, *, method="GET", body=None, timeout=30, retries=4, pause=0.8):
    err=None
    for n in range(retries+1):
        try:
            data=None
            headers={**UA,"accept":"application/json"}
            if body is not None:
                data=json.dumps(body).encode()
                headers["content-type"]="application/json"
            req=urllib.request.Request(url,data=data,headers=headers,method=method)
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8","replace"))
        except Exception as e:
            err=e
            if n<retries:
                time.sleep(pause*(2**n))
    raise RuntimeError(f"request failed {url}: {err}")

def hl_post(body):
    return request_json(HL_INFO,method="POST",body=body,timeout=30,retries=4,pause=1.0)

def fetch_hl_funding(coin):
    cursor=START_MS
    out=[]
    calls=0
    while cursor<END_MS:
        rows=hl_post({"type":"fundingHistory","coin":coin,"startTime":cursor,"endTime":END_MS-1})
        calls+=1
        if not isinstance(rows,list):
            raise RuntimeError(f"HL funding invalid {coin}")
        batch=[]
        for row in rows:
            try:
                t=int(row["time"]); rate=float(row["fundingRate"])
                if START_MS<=t<END_MS and math.isfinite(rate):
                    batch.append((t,rate))
            except Exception:
                pass
        out.extend(batch)
        if len(rows)<500:
            break
        mx=max((int(x.get("time",0)) for x in rows),default=0)
        if mx<cursor:
            raise RuntimeError(f"HL funding pagination stalled {coin}")
        cursor=mx+1
        # fundingHistory has response-size based weight; deliberately pace.
        time.sleep(2.4)
    ded={t:r for t,r in out}
    rows=sorted(ded.items())
    if len(rows)<500:
        raise RuntimeError(f"HL funding too short {coin}: {len(rows)}")
    return rows,calls

def fetch_hl_candles(coin):
    rows=hl_post({"type":"candleSnapshot","req":{"coin":coin,"interval":"4h","startTime":START_MS,"endTime":END_MS-1}})
    out=[]
    for row in rows if isinstance(rows,list) else []:
        try:
            t=int(row["t"]); c=float(row["c"])
            if START_MS<=t<END_MS and c>0 and math.isfinite(c):
                out.append(Candle(t,c))
        except Exception:
            pass
    ded={x.t:x for x in out}
    arr=[ded[k] for k in sorted(ded)]
    if len(arr)<900:
        raise RuntimeError(f"HL candles too short {coin}: {len(arr)}")
    return arr

def bybit_get(path,params):
    q=urllib.parse.urlencode(params)
    payload=request_json(f"{BYBIT}{path}?{q}",timeout=30,retries=5,pause=1.0)
    if int(payload.get("retCode",-1))!=0:
        raise RuntimeError(f"BYBIT error {path}: {payload.get('retMsg')}")
    return payload.get("result") or {}

def fetch_bybit_funding(symbol):
    end=END_MS-1
    out=[]
    calls=0
    while end>=START_MS:
        result=bybit_get("/v5/market/funding/history",{
            "category":"linear","symbol":symbol,"endTime":end,"limit":200
        })
        rows=result.get("list") or []
        calls+=1
        if not rows:
            break
        times=[]
        for row in rows:
            try:
                t=int(row["fundingRateTimestamp"]); rate=float(row["fundingRate"])
                times.append(t)
                if START_MS<=t<END_MS and math.isfinite(rate):
                    out.append((t,rate))
            except Exception:
                pass
        oldest=min(times) if times else 0
        if not oldest or oldest>=end:
            break
        if oldest<=START_MS:
            break
        end=oldest-1
        time.sleep(0.15)
    ded={t:r for t,r in out}
    rows=sorted(ded.items())
    if len(rows)<100:
        raise RuntimeError(f"BYBIT funding too short {symbol}: {len(rows)}")
    return rows,calls

def fetch_bybit_candles(symbol):
    end=END_MS-1
    out=[]
    while end>=START_MS:
        result=bybit_get("/v5/market/kline",{
            "category":"linear","symbol":symbol,"interval":"240","end":end,"limit":1000
        })
        rows=result.get("list") or []
        if not rows:
            break
        times=[]
        for row in rows:
            try:
                t=int(row[0]); c=float(row[4])
                times.append(t)
                if START_MS<=t<END_MS and c>0 and math.isfinite(c):
                    out.append(Candle(t,c))
            except Exception:
                pass
        oldest=min(times) if times else 0
        if not oldest or oldest>=end:
            break
        if oldest<=START_MS:
            break
        end=oldest-1
        time.sleep(0.1)
    ded={x.t:x for x in out}
    arr=[ded[k] for k in sorted(ded)]
    if len(arr)<900:
        raise RuntimeError(f"BYBIT candles too short {symbol}: {len(arr)}")
    return arr

def window_sum(events, start, end):
    # events sorted (time, rate)
    times=[x[0] for x in events]
    a=bisect_left(times,start)
    b=bisect_left(times,end)
    return sum(rate for _,rate in events[a:b])

def align(hc,bc):
    hm={x.t:x.close for x in hc}; bm={x.t:x.close for x in bc}
    common=sorted(set(hm)&set(bm))
    # Keep only exact 4h-contiguous observations.
    segments=[]
    current=[]
    prev=None
    for t in common:
        if prev is None or t-prev==H4_MS:
            current.append(t)
        else:
            if current: segments.append(current)
            current=[t]
        prev=t
    if current: segments.append(current)
    seg=max(segments,key=len)
    if len(seg)<900:
        raise RuntimeError(f"aligned candles too short: {len(seg)}")
    return seg,hm,bm

def annualize(eq,days):
    return eq**(365.25/days)-1 if eq>0 and days>0 else None

def summarize(daily,curve,days,exposure,transitions,funding_sum,basis_sum,cost_sum):
    peak=curve[0] if curve else 1.0
    mdd=0.0
    for e in curve:
        peak=max(peak,e)
        if peak>0:mdd=min(mdd,e/peak-1)
    wins=[x for x in daily if x>0]; losses=[x for x in daily if x<0]
    gp=sum(wins); gl=-sum(losses)
    eq=curve[-1] if curve else 1.0
    return {
        "days":days,
        "return":eq-1,
        "annualized":annualize(eq,days),
        "mdd":mdd,
        "win_rate":len(wins)/len(daily) if daily else 0.0,
        "pf":gp/gl if gl else None,
        "exposure":exposure/days if days else 0.0,
        "orientation_transitions":transitions,
        "funding_contribution_simple":funding_sum,
        "basis_contribution_simple":basis_sum,
        "cost_contribution_simple":cost_sum,
    }

def transition_cost(prev,new,c):
    # Returns cost as fraction of TOTAL fully-funded two-leg capital.
    # Open or close two legs: (2*c)/2 = c. Flip: close two + open two = 2*c.
    if prev==new:return 0.0
    if prev==0 or new==0:return c
    return 2*c

def simulate(times,hl_px,by_px,hl_f,by_f,costs,cost_aware):
    # orientation: +1 = LONG HL / SHORT BYBIT; -1 = LONG BYBIT / SHORT HL.
    eq=1.0; curve=[1.0]; daily=[]; prev_orientation=0
    exposure=0; transitions=0; funding_sum=0.0; basis_sum=0.0; cost_sum=0.0
    # start at first daily timestamp with at least 7d trail; decide at UTC-aligned 4h index.
    start_i=TRAIL_MS//H4_MS
    i=start_i
    while i+6 < len(times):
        t=times[i]
        # Only make 24h decisions at UTC 00:00.
        if (t//H4_MS)%6!=0:
            i+=1;continue
        t2=times[i+6]
        if t2-t!=DAY_MS:
            i+=1;continue

        hl7=window_sum(hl_f,t-TRAIL_MS,t)
        by7=window_sum(by_f,t-TRAIL_MS,t)
        spread7=hl7-by7
        orientation=-1 if spread7>0 else (1 if spread7<0 else 0)

        if cost_aware and orientation!=0 and prev_orientation==0:
            # Expected 7d capital funding edge = abs(spread7)/2.
            # Require it to cover one open + one eventual close.
            round_trip=2*costs["taker_per_leg"]
            if abs(spread7)/2 <= round_trip:
                orientation=0

        tc=transition_cost(prev_orientation,orientation,costs["taker_per_leg"])
        if orientation!=prev_orientation:
            transitions+=1
        cost_sum-=tc

        day_f_hl=window_sum(hl_f,t,t2)
        day_f_by=window_sum(by_f,t,t2)
        r_hl=hl_px[t2]/hl_px[t]-1
        r_by=by_px[t2]/by_px[t]-1

        if orientation==1:
            funding=(day_f_by-day_f_hl)/2
            basis=(r_hl-r_by)/2
            hedge=-costs["daily_hedge_capital"]
            exposure+=1
        elif orientation==-1:
            funding=(day_f_hl-day_f_by)/2
            basis=(r_by-r_hl)/2
            hedge=-costs["daily_hedge_capital"]
            exposure+=1
        else:
            funding=basis=hedge=0.0

        net=funding+basis+hedge-tc
        funding_sum+=funding; basis_sum+=basis; cost_sum+=hedge
        eq*=max(0.01,1+net)
        curve.append(eq); daily.append(net)
        prev_orientation=orientation
        i+=6

    # close any open pair
    if prev_orientation!=0:
        close_cost=costs["taker_per_leg"]
        eq*=1-close_cost
        curve[-1]=eq
        cost_sum-=close_cost
        transitions+=1
    return summarize(daily,curve,len(daily),exposure,transitions,funding_sum,basis_sum,cost_sum)

def portfolio(symbol_results):
    vals=list(symbol_results.values())
    return {
        "equal_weight_return":sum(x["return"] for x in vals)/len(vals),
        "equal_weight_annualized":sum(x["annualized"] for x in vals)/len(vals),
        "avg_mdd":sum(x["mdd"] for x in vals)/len(vals),
        "positive_symbols":sum(x["return"]>0 for x in vals),
        "avg_exposure":sum(x["exposure"] for x in vals)/len(vals),
    }

def main():
    data={}; provenance={}
    for coin,spec in SYMBOLS.items():
        print(json.dumps({"stage":"hyperliquid_funding","coin":coin}),flush=True)
        hlf,hl_calls=fetch_hl_funding(spec["hl"])
        print(json.dumps({"stage":"hyperliquid_candles","coin":coin,"funding_rows":len(hlf)}),flush=True)
        hlc=fetch_hl_candles(spec["hl"])
        print(json.dumps({"stage":"bybit_funding","coin":coin}),flush=True)
        byf,by_calls=fetch_bybit_funding(spec["bybit"])
        byc=fetch_bybit_candles(spec["bybit"])
        times,hpx,bpx=align(hlc,byc)
        data[coin]=(times,hpx,bpx,hlf,byf)
        provenance[coin]={
            "start":datetime.fromtimestamp(times[0]/1000,tz=timezone.utc).isoformat(),
            "end":datetime.fromtimestamp(times[-1]/1000,tz=timezone.utc).isoformat(),
            "aligned_4h_bars":len(times),
            "hyperliquid_funding_rows":len(hlf),
            "bybit_funding_rows":len(byf),
            "hyperliquid_funding_calls":hl_calls,
            "bybit_funding_calls":by_calls,
            "sources":{"hyperliquid":"official public info endpoint","bybit":"official public V5 market endpoints"},
        }
        print(json.dumps({"stage":"loaded","coin":coin,**provenance[coin]}),flush=True)

    results={}
    for cname,cost in COSTS.items():
        results[cname]={}
        for mode,cost_aware in [("trailing7_orientation",False),("cost_aware_trailing7",True)]:
            by={coin:simulate(*data[coin],cost,cost_aware) for coin in SYMBOLS}
            results[cname][mode]={"portfolio":portfolio(by),"symbols":by}

    payload={
        "schemaVersion":1,
        "kind":"cross-venue-funding-v1",
        "research_only":True,
        "public_data_only":True,
        "live_trading":False,
        "private_api":False,
        "orders_submitted":0,
        "leverage":1,
        "capital_measure":"fully funded two-leg capital; one notional collateral unit per leg",
        "period":{"start_ms":START_MS,"end_ms":END_MS},
        "formula":{
            "venues":["Hyperliquid","Bybit"],
            "decision":"daily using only trailing 7-day realized funding",
            "orientation":"LONG lower-funding venue / SHORT higher-funding venue",
            "cost_aware_entry":"expected 7-day capital funding edge must exceed one open+close round trip",
            "basis_pnl_included":True,
            "funding_pnl_included":True,
            "price_source":"4h public traded-price candles",
        },
        "costs":COSTS,
        "symbols":list(SYMBOLS),
        "provenance":provenance,
        "results":results,
        "limitations":[
            "Historical bid/ask depth is not modeled.",
            "Daily equal-notional hedge maintenance is approximated with an explicit capital cost assumption.",
            "Liquidation and maintenance-margin mechanics are not modeled; leverage is fixed at 1x per leg.",
            "This is cross-venue research and is not connected to the app's execution providers.",
        ],
    }
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")

    lines=[
        "# Cross-Venue Funding V1",
        "",
        "RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS",
        "",
        "| Cost | Mode | EW total | EW ann. | Positive | Avg MDD | Avg exposure |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for cname in COSTS:
        for mode in results[cname]:
            p=results[cname][mode]["portfolio"]
            lines.append(
                f'| {cname} | {mode} | {p["equal_weight_return"]*100:.2f}% | '
                f'{p["equal_weight_annualized"]*100:.2f}% | {p["positive_symbols"]}/3 | '
                f'{p["avg_mdd"]*100:.2f}% | {p["avg_exposure"]*100:.1f}% |'
            )
    lines+=["","## Base cost-aware by symbol","","| Coin | Return | Ann. | MDD | PF | Exposure | Funding* | Basis* | Costs* |","|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for coin,x in results["base"]["cost_aware_trailing7"]["symbols"].items():
        pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
        lines.append(
            f'| {coin} | {x["return"]*100:.2f}% | {x["annualized"]*100:.2f}% | {x["mdd"]*100:.2f}% | '
            f'{pf} | {x["exposure"]*100:.1f}% | {x["funding_contribution_simple"]*100:.2f}% | '
            f'{x["basis_contribution_simple"]*100:.2f}% | {x["cost_contribution_simple"]*100:.2f}% |'
        )
    lines+=["","*Simple contribution sums are decomposition diagnostics, not compounded attribution."]
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":
    main()
