#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import time
import urllib.request
import zipfile
from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

OUT=Path("market-prediction-lab/artifacts/cross-venue-hl-binance-v1")
OUT.mkdir(parents=True,exist_ok=True)

SYMBOLS={
    "BTC":{"hl":"BTC","binance":"BTCUSDT"},
    "ETH":{"hl":"ETH","binance":"ETHUSDT"},
    "SOL":{"hl":"SOL","binance":"SOLUSDT"},
}
MONTHS=[f"2026-{m:02d}" for m in range(3,9)]
START_MS=int(datetime(2026,3,1,tzinfo=timezone.utc).timestamp()*1000)
END_MS=int(datetime(2026,9,1,tzinfo=timezone.utc).timestamp()*1000)
DAY_MS=86_400_000
H4_MS=14_400_000
TRAIL_MS=7*DAY_MS

HL_INFO="https://api.hyperliquid.xyz/info"
KBASE="https://data.binance.vision/data/futures/um/monthly/klines"
FBASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
UA={"User-Agent":"investment-platform-public-research/1.0"}

COSTS={
    "base":{
        "hl_taker":0.00060,
        "binance_taker":0.00050,
        "daily_hedge_capital":0.000010,
    },
    "stress":{
        "hl_taker":0.00100,
        "binance_taker":0.00080,
        "daily_hedge_capital":0.000025,
    },
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
            if n<retries:
                time.sleep(pause*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

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
                t=int(row["time"])
                rate=float(row["fundingRate"])
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
        time.sleep(2.4)
    rows=sorted({t:r for t,r in out}.items())
    if len(rows)<500:
        raise RuntimeError(f"HL funding too short {coin}: {len(rows)}")
    return rows,calls

def fetch_hl_candles(coin):
    rows=hl_post({
        "type":"candleSnapshot",
        "req":{"coin":coin,"interval":"4h","startTime":START_MS,"endTime":END_MS-1},
    })
    out=[]
    for row in rows if isinstance(rows,list) else []:
        try:
            t=int(row["t"])
            c=float(row["c"])
            if START_MS<=t<END_MS and c>0 and math.isfinite(c):
                out.append(Candle(t,c))
        except Exception:
            pass
    arr=[x for _,x in sorted({x.t:x for x in out}.items())]
    if len(arr)<900:
        raise RuntimeError(f"HL candles too short {coin}: {len(arr)}")
    return arr

def checked_zip(url,name):
    data=get_bytes(url)
    checksum=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if checksum.lower()!=actual.lower():
        raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(data)),actual

def fetch_binance_kline_month(symbol,month):
    name=f"{symbol}-4h-{month}.zip"
    z,digest=checked_zip(f"{KBASE}/{symbol}/4h/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):
            continue
        rd=csv.reader(io.TextIOWrapper(z.open(member),encoding="utf-8"))
        for r in rd:
            if not r or not r[0].isdigit():
                continue
            try:
                t=int(r[0])
                if t>100_000_000_000_000:
                    t//=1000
                c=float(r[4])
                if START_MS<=t<END_MS and c>0 and math.isfinite(c):
                    rows.append(Candle(t,c))
            except Exception:
                pass
    return month,rows,digest

def fetch_binance_funding_month(symbol,month):
    name=f"{symbol}-fundingRate-{month}.zip"
    z,digest=checked_zip(f"{FBASE}/{symbol}/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):
            continue
        rd=csv.DictReader(io.TextIOWrapper(z.open(member),encoding="utf-8"))
        for row in rd:
            try:
                t=int(float(row.get("calc_time") or row.get("fundingTime") or 0))
                if t>100_000_000_000_000:
                    t//=1000
                rate=float(row.get("last_funding_rate") or row.get("funding_rate") or row.get("fundingRate"))
                if START_MS<=t<END_MS and math.isfinite(rate):
                    rows.append((t,rate))
            except Exception:
                pass
    return month,rows,digest

def fetch_binance(symbol):
    kparts={}
    fparts={}
    kchecks={}
    fchecks={}
    for m in MONTHS:
        km,krows,kd=fetch_binance_kline_month(symbol,m)
        fm,frows,fd=fetch_binance_funding_month(symbol,m)
        kparts[km]=krows
        fparts[fm]=frows
        kchecks[km]=kd
        fchecks[fm]=fd
        print(json.dumps({"stage":"binance_month","symbol":symbol,"month":m,"klines":len(krows),"funding":len(frows)}),flush=True)
    klines=[]
    funding=[]
    for m in MONTHS:
        klines.extend(kparts[m])
        funding.extend(fparts[m])
    kc=[x for _,x in sorted({x.t:x for x in klines}.items())]
    fr=sorted({t:r for t,r in funding}.items())
    if len(kc)<900:
        raise RuntimeError(f"Binance candles too short {symbol}: {len(kc)}")
    if len(fr)<100:
        raise RuntimeError(f"Binance funding too short {symbol}: {len(fr)}")
    return kc,fr,kchecks,fchecks

def window_sum(events,start,end):
    times=[x[0] for x in events]
    a=bisect_left(times,start)
    b=bisect_left(times,end)
    return sum(rate for _,rate in events[a:b])

def align(hc,bc):
    hm={x.t:x.close for x in hc}
    bm={x.t:x.close for x in bc}
    common=sorted(set(hm)&set(bm))
    segments=[]
    current=[]
    prev=None
    for t in common:
        if prev is None or t-prev==H4_MS:
            current.append(t)
        else:
            if current:
                segments.append(current)
            current=[t]
        prev=t
    if current:
        segments.append(current)
    seg=max(segments,key=len)
    if len(seg)<900:
        raise RuntimeError(f"aligned candles too short: {len(seg)}")
    return seg,hm,bm

def annualize(eq,days):
    return eq**(365.25/days)-1 if eq>0 and days>0 else None

def pair_event_cost(costs):
    return (costs["hl_taker"]+costs["binance_taker"])/2

def transition_cost(prev,new,costs):
    event=pair_event_cost(costs)
    if prev==new:
        return 0.0
    if prev==0 or new==0:
        return event
    return 2*event

def summarize(daily,curve,days,exposure,transitions,funding_sum,basis_sum,cost_sum):
    peak=curve[0] if curve else 1.0
    mdd=0.0
    for e in curve:
        peak=max(peak,e)
        if peak>0:
            mdd=min(mdd,e/peak-1)
    wins=[x for x in daily if x>0]
    losses=[x for x in daily if x<0]
    gp=sum(wins)
    gl=-sum(losses)
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

def simulate(times,hl_px,bin_px,hl_f,bin_f,costs,cost_aware):
    # +1: long HL / short Binance
    # -1: long Binance / short HL
    eq=1.0
    curve=[1.0]
    daily=[]
    prev_orientation=0
    exposure=0
    transitions=0
    funding_sum=0.0
    basis_sum=0.0
    cost_sum=0.0
    start_i=TRAIL_MS//H4_MS
    i=start_i
    while i+6<len(times):
        t=times[i]
        if (t//H4_MS)%6!=0:
            i+=1
            continue
        t2=times[i+6]
        if t2-t!=DAY_MS:
            i+=1
            continue

        hl7=window_sum(hl_f,t-TRAIL_MS,t)
        bin7=window_sum(bin_f,t-TRAIL_MS,t)
        spread7=hl7-bin7
        orientation=-1 if spread7>0 else (1 if spread7<0 else 0)

        if cost_aware and orientation!=0 and prev_orientation==0:
            expected_7d_capital_edge=abs(spread7)/2
            round_trip=2*pair_event_cost(costs)
            if expected_7d_capital_edge<=round_trip:
                orientation=0

        tc=transition_cost(prev_orientation,orientation,costs)
        if orientation!=prev_orientation:
            transitions+=1
        cost_sum-=tc

        day_hl=window_sum(hl_f,t,t2)
        day_bin=window_sum(bin_f,t,t2)
        r_hl=hl_px[t2]/hl_px[t]-1
        r_bin=bin_px[t2]/bin_px[t]-1

        if orientation==1:
            funding=(day_bin-day_hl)/2
            basis=(r_hl-r_bin)/2
            hedge=-costs["daily_hedge_capital"]
            exposure+=1
        elif orientation==-1:
            funding=(day_hl-day_bin)/2
            basis=(r_bin-r_hl)/2
            hedge=-costs["daily_hedge_capital"]
            exposure+=1
        else:
            funding=0.0
            basis=0.0
            hedge=0.0

        net=funding+basis+hedge-tc
        funding_sum+=funding
        basis_sum+=basis
        cost_sum+=hedge
        eq*=max(0.01,1+net)
        curve.append(eq)
        daily.append(net)
        prev_orientation=orientation
        i+=6

    if prev_orientation!=0:
        close_cost=pair_event_cost(costs)
        eq*=1-close_cost
        curve[-1]=eq
        cost_sum-=close_cost
        transitions+=1

    return summarize(daily,curve,len(daily),exposure,transitions,funding_sum,basis_sum,cost_sum)

def portfolio(by):
    vals=list(by.values())
    return {
        "equal_weight_return":sum(x["return"] for x in vals)/len(vals),
        "equal_weight_annualized":sum(x["annualized"] for x in vals)/len(vals),
        "avg_mdd":sum(x["mdd"] for x in vals)/len(vals),
        "positive_symbols":sum(x["return"]>0 for x in vals),
        "avg_exposure":sum(x["exposure"] for x in vals)/len(vals),
    }

def main():
    data={}
    provenance={}
    for coin,spec in SYMBOLS.items():
        print(json.dumps({"stage":"hyperliquid_funding","coin":coin}),flush=True)
        hlf,hl_calls=fetch_hl_funding(spec["hl"])
        hlc=fetch_hl_candles(spec["hl"])
        print(json.dumps({"stage":"binance","coin":coin}),flush=True)
        binc,binf,kchecks,fchecks=fetch_binance(spec["binance"])
        times,hpx,bpx=align(hlc,binc)
        data[coin]=(times,hpx,bpx,hlf,binf)
        provenance[coin]={
            "start":datetime.fromtimestamp(times[0]/1000,tz=timezone.utc).isoformat(),
            "end":datetime.fromtimestamp(times[-1]/1000,tz=timezone.utc).isoformat(),
            "aligned_4h_bars":len(times),
            "hyperliquid_funding_rows":len(hlf),
            "binance_funding_rows":len(binf),
            "hyperliquid_funding_calls":hl_calls,
            "binance_kline_monthly_sha256":kchecks,
            "binance_funding_monthly_sha256":fchecks,
            "sources":{
                "hyperliquid":"official public info endpoint",
                "binance":"official Binance Vision public archive",
            },
        }
        print(json.dumps({"stage":"loaded","coin":coin,**{k:v for k,v in provenance[coin].items() if k not in ("binance_kline_monthly_sha256","binance_funding_monthly_sha256")}}),flush=True)

    results={}
    for cname,cost in COSTS.items():
        results[cname]={}
        for mode,cost_aware in [("trailing7_orientation",False),("cost_aware_trailing7",True)]:
            by={coin:simulate(*data[coin],cost,cost_aware) for coin in SYMBOLS}
            results[cname][mode]={"portfolio":portfolio(by),"symbols":by}

    payload={
        "schemaVersion":1,
        "kind":"cross-venue-hl-binance-v1",
        "research_only":True,
        "public_data_only":True,
        "live_trading":False,
        "private_api":False,
        "orders_submitted":0,
        "leverage":1,
        "capital_measure":"fully funded two-leg capital; one notional collateral unit per leg",
        "period":{"start_ms":START_MS,"end_ms":END_MS},
        "formula":{
            "venues":["Hyperliquid","Binance"],
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
            "The cost fields are conservative research assumptions, not venue fee schedules.",
        ],
    }
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")

    lines=[
        "# Hyperliquid ↔ Binance Funding Carry V1",
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
