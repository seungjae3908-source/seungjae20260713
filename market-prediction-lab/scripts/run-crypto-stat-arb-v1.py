#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import statistics
import time
import urllib.request
import zipfile
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

OUT=Path("market-prediction-lab/artifacts/crypto-stat-arb-v1")
OUT.mkdir(parents=True,exist_ok=True)

SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","LINKUSDT","ADAUSDT"]
MONTHS=[f"{y}-{m:02d}" for y,m0,m1 in [(2024,10,12),(2025,1,12),(2026,1,8)] for m in range(m0,m1+1)]
KBASE="https://data.binance.vision/data/futures/um/monthly/klines"
FBASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
UA={"User-Agent":"investment-platform-public-research/1.0"}

BAR_MS=4*60*60*1000
BARS_PER_DAY=6
FORMATION_BARS=90*BARS_PER_DAY
TRADE_BARS=30*BARS_PER_DAY
MAX_HOLD_BARS=7*BARS_PER_DAY
ENTRY_Z=2.0
EXIT_Z=0.5
STOP_Z=4.0
TOP_PAIRS=3
TRADE_START=int(datetime(2025,1,1,tzinfo=timezone.utc).timestamp()*1000)
TRADE_END=int(datetime(2026,9,1,tzinfo=timezone.utc).timestamp()*1000)
COSTS={"base":0.0008,"stress":0.0012}

@dataclass(frozen=True)
class Bar:
    t:int
    o:float
    c:float

def get_bytes(url,timeout=45,retries=4):
    err=None
    for n in range(retries+1):
        try:
            req=urllib.request.Request(url,headers=UA)
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return r.read()
        except Exception as e:
            err=e
            if n<retries:
                time.sleep(1.0*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

def checked_zip(url,name):
    data=get_bytes(url)
    checksum=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if checksum.lower()!=actual.lower():
        raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(data)),actual

def fetch_kline_month(symbol,month):
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
                o=float(r[1])
                c=float(r[4])
                if o>0 and c>0:
                    rows.append(Bar(t,o,c))
            except Exception:
                pass
    return month,rows,digest

def fetch_funding_month(symbol,month):
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
                if math.isfinite(rate):
                    rows.append((t,rate))
            except Exception:
                pass
    return month,rows,digest

def load_symbol(symbol):
    klines=[]
    funding=[]
    kchecks={}
    fchecks={}
    for m in MONTHS:
        km,kr,kd=fetch_kline_month(symbol,m)
        fm,fr,fd=fetch_funding_month(symbol,m)
        klines.extend(kr)
        funding.extend(fr)
        kchecks[km]=kd
        fchecks[fm]=fd
        print(json.dumps({"stage":"month","symbol":symbol,"month":m,"bars":len(kr),"funding":len(fr)}),flush=True)
    bars=[x for _,x in sorted({x.t:x for x in klines}.items())]
    frows=sorted({t:r for t,r in funding}.items())
    if len(bars)<3000:
        raise RuntimeError(f"{symbol} insufficient bars {len(bars)}")
    if not frows:
        raise RuntimeError(f"{symbol} funding empty")
    return bars,frows,kchecks,fchecks

def align(all_bars):
    maps={s:{b.t:b for b in bars} for s,bars in all_bars.items()}
    common=sorted(set.intersection(*(set(m) for m in maps.values())))
    if len(common)<3000:
        raise RuntimeError(f"common bars too short {len(common)}")
    # Fail closed on any gap in common history.
    for a,b in zip(common,common[1:]):
        if b-a!=BAR_MS:
            raise RuntimeError(f"4h gap {a}->{b}")
    opens={s:[maps[s][t].o for t in common] for s in SYMBOLS}
    closes={s:[maps[s][t].c for t in common] for s in SYMBOLS}
    return common,opens,closes

def ols(y,x):
    mx=statistics.mean(x)
    my=statistics.mean(y)
    vx=sum((v-mx)**2 for v in x)
    if vx<=1e-12:
        return None
    beta=sum((a-my)*(b-mx) for a,b in zip(y,x))/vx
    alpha=my-beta*mx
    return alpha,beta

def ar1_phi(resids):
    if len(resids)<20:
        return None
    x=resids[:-1]
    y=resids[1:]
    fit=ols(y,x)
    if fit is None:
        return None
    return fit[1]

def sign_crossings(vals):
    c=0
    prev=0
    for v in vals:
        s=1 if v>0 else (-1 if v<0 else 0)
        if s and prev and s!=prev:
            c+=1
        if s:
            prev=s
    return c

def pair_model(a,b,closes,start,end):
    ya=[math.log(x) for x in closes[a][start:end]]
    xb=[math.log(x) for x in closes[b][start:end]]
    fit=ols(ya,xb)
    if fit is None:
        return None
    alpha,beta=fit
    if not (0.20<=beta<=5.0):
        return None
    res=[y-(alpha+beta*x) for y,x in zip(ya,xb)]
    sd=statistics.stdev(res) if len(res)>1 else 0.0
    if sd<=1e-5:
        return None
    phi=ar1_phi(res)
    if phi is None or not (0.0<phi<0.98):
        return None
    half_life=-math.log(2)/math.log(phi)
    crosses=sign_crossings(res)
    if not (1.0<=half_life<=60.0) or crosses<6:
        return None
    return {
        "a":a,
        "b":b,
        "alpha":alpha,
        "beta":beta,
        "mean":statistics.mean(res),
        "sd":sd,
        "phi":phi,
        "half_life_bars":half_life,
        "crossings":crosses,
    }

def select_pairs(closes,start,end):
    candidates=[]
    for a,b in combinations(SYMBOLS,2):
        model=pair_model(a,b,closes,start,end)
        if model:
            candidates.append(model)
    # Fixed ranking: fastest valid mean reversion first, then more crossings.
    candidates.sort(key=lambda x:(x["half_life_bars"],-x["crossings"],x["a"],x["b"]))
    selected=[]
    used=set()
    for x in candidates:
        if x["a"] in used or x["b"] in used:
            continue
        selected.append(x)
        used.add(x["a"])
        used.add(x["b"])
        if len(selected)>=TOP_PAIRS:
            break
    return selected,candidates

def funding_sum(funding,times,start,end):
    # start exclusive, end inclusive
    vals=funding
    ts=[x[0] for x in vals]
    lo=bisect_right(ts,start)
    hi=bisect_right(ts,end)
    return sum(r for _,r in vals[lo:hi])

def zscore(model,a_close,b_close):
    spread=math.log(a_close)-(model["alpha"]+model["beta"]*math.log(b_close))
    return (spread-model["mean"])/model["sd"]

def simulate_pair(model,times,opens,closes,funding,start,end,cost):
    a=model["a"]
    b=model["b"]
    beta=model["beta"]
    wa=1/(1+beta)
    wb=beta/(1+beta)
    eq=1.0
    peak=1.0
    mdd=0.0
    trades=[]
    active=None
    k=start

    def close_trade(exit_idx,reason):
        nonlocal eq,peak,mdd,active
        ea=active["entry_a"]
        eb=active["entry_b"]
        xa=opens[a][exit_idx]
        xb=opens[b][exit_idx]
        sa=active["side_a"]
        sb=active["side_b"]
        price_pnl=wa*sa*(xa/ea-1)+wb*sb*(xb/eb-1)
        t0=times[active["entry_idx"]]
        t1=times[exit_idx]
        fa=funding_sum(funding[a],times,t0,t1)
        fb=funding_sum(funding[b],times,t0,t1)
        funding_cost=wa*sa*fa+wb*sb*fb
        net=price_pnl-funding_cost-2*cost
        eq*=max(0.01,1+net)
        peak=max(peak,eq)
        mdd=min(mdd,eq/peak-1)
        trades.append({
            "net":net,
            "price_pnl":price_pnl,
            "funding_cost":funding_cost,
            "bars":exit_idx-active["entry_idx"],
            "reason":reason,
        })
        active=None

    while k<end-1:
        z=zscore(model,closes[a][k],closes[b][k])
        next_idx=k+1

        if active is None:
            if z>=ENTRY_Z:
                active={
                    "entry_idx":next_idx,
                    "entry_a":opens[a][next_idx],
                    "entry_b":opens[b][next_idx],
                    "side_a":-1,
                    "side_b":1,
                }
                k=next_idx
                continue
            if z<=-ENTRY_Z:
                active={
                    "entry_idx":next_idx,
                    "entry_a":opens[a][next_idx],
                    "entry_b":opens[b][next_idx],
                    "side_a":1,
                    "side_b":-1,
                }
                k=next_idx
                continue
        else:
            held=k-active["entry_idx"]+1
            if abs(z)<=EXIT_Z:
                close_trade(next_idx,"MEAN")
                k=next_idx
                continue
            if abs(z)>=STOP_Z:
                close_trade(next_idx,"STOP_Z")
                k=next_idx
                continue
            if held>=MAX_HOLD_BARS:
                close_trade(next_idx,"TIME")
                k=next_idx
                continue
        k+=1

    if active is not None:
        # Last close proxy; one exit cost, no lookahead signal.
        exit_idx=end-1
        ea=active["entry_a"]
        eb=active["entry_b"]
        xa=closes[a][exit_idx]
        xb=closes[b][exit_idx]
        sa=active["side_a"]
        sb=active["side_b"]
        price_pnl=wa*sa*(xa/ea-1)+wb*sb*(xb/eb-1)
        t0=times[active["entry_idx"]]
        t1=times[exit_idx]
        fa=funding_sum(funding[a],times,t0,t1)
        fb=funding_sum(funding[b],times,t0,t1)
        funding_cost=wa*sa*fa+wb*sb*fb
        net=price_pnl-funding_cost-(2*cost)
        eq*=max(0.01,1+net)
        peak=max(peak,eq)
        mdd=min(mdd,eq/peak-1)
        trades.append({"net":net,"price_pnl":price_pnl,"funding_cost":funding_cost,"bars":exit_idx-active["entry_idx"],"reason":"BLOCK_END"})

    wins=[x["net"] for x in trades if x["net"]>0]
    losses=[x["net"] for x in trades if x["net"]<0]
    gp=sum(wins)
    gl=-sum(losses)
    return {
        "return":eq-1,
        "mdd":mdd,
        "trades":len(trades),
        "pf":gp/gl if gl else None,
        "win_rate":len(wins)/len(trades) if trades else 0.0,
        "trade_returns":[x["net"] for x in trades],
        "funding_cost_simple":sum(x["funding_cost"] for x in trades),
    }

def summarize_blocks(block_returns):
    eq=1.0
    peak=1.0
    mdd=0.0
    for r in block_returns:
        eq*=max(0.01,1+r)
        peak=max(peak,eq)
        mdd=min(mdd,eq/peak-1)
    wins=[r for r in block_returns if r>0]
    losses=[r for r in block_returns if r<0]
    gp=sum(wins)
    gl=-sum(losses)
    months=len(block_returns)
    ann=eq**(12/months)-1 if months else None
    return {
        "blocks":months,
        "return":eq-1,
        "annualized":ann,
        "mdd_block_level":mdd,
        "win_rate_blocks":len(wins)/months if months else 0.0,
        "pf_blocks":gp/gl if gl else None,
    }

def run_walkforward(times,opens,closes,funding,cost):
    first=max(FORMATION_BARS,next(i for i,t in enumerate(times) if t>=TRADE_START))
    last=next((i for i,t in enumerate(times) if t>=TRADE_END),len(times))
    block_records=[]
    selection_counts=Counter()
    all_scaled_trade_returns=[]

    block_start=first
    while block_start<last-12:
        formation_start=block_start-FORMATION_BARS
        block_end=min(block_start+TRADE_BARS,last)
        selected,candidates=select_pairs(closes,formation_start,block_start)
        if len(selected)<2:
            block_records.append({
                "start":times[block_start],
                "end":times[block_end-1],
                "selected":[],
                "candidate_count":len(candidates),
                "block_return":0.0,
                "status":"INSUFFICIENT_PAIRS",
            })
            block_start=block_end
            continue

        pair_results=[]
        for model in selected:
            key=f'{model["a"]}/{model["b"]}'
            selection_counts[key]+=1
            sim=simulate_pair(model,times,opens,closes,funding,block_start,block_end,cost)
            pair_results.append({"model":model,"result":sim})
        n=len(pair_results)
        block_return=sum(x["result"]["return"] for x in pair_results)/n
        for x in pair_results:
            all_scaled_trade_returns.extend([r/n for r in x["result"]["trade_returns"]])

        block_records.append({
            "start":times[block_start],
            "end":times[block_end-1],
            "candidate_count":len(candidates),
            "selected":[
                {
                    "pair":f'{x["model"]["a"]}/{x["model"]["b"]}',
                    "half_life_bars":x["model"]["half_life_bars"],
                    "crossings":x["model"]["crossings"],
                    "beta":x["model"]["beta"],
                    "return":x["result"]["return"],
                    "trades":x["result"]["trades"],
                    "pf":x["result"]["pf"],
                    "funding_cost_simple":x["result"]["funding_cost_simple"],
                }
                for x in pair_results
            ],
            "block_return":block_return,
            "status":"OK",
        })
        block_start=block_end

    valid=[x for x in block_records if x["status"]=="OK"]
    full_returns=[x["block_return"] for x in valid]
    recent_returns=full_returns[-6:] if len(full_returns)>=6 else full_returns

    wins=[r for r in all_scaled_trade_returns if r>0]
    losses=[r for r in all_scaled_trade_returns if r<0]
    gp=sum(wins)
    gl=-sum(losses)
    trade_pf=gp/gl if gl else None

    return {
        "full":summarize_blocks(full_returns),
        "recent6blocks":summarize_blocks(recent_returns),
        "blocks":block_records,
        "selection_counts":dict(selection_counts),
        "scaled_trade_count":len(all_scaled_trade_returns),
        "scaled_trade_pf":trade_pf,
    }

def main():
    all_bars={}
    funding={}
    provenance={}
    for s in SYMBOLS:
        bars,frows,kc,fc=load_symbol(s)
        all_bars[s]=bars
        funding[s]=frows
        provenance[s]={
            "bars":len(bars),
            "funding_rows":len(frows),
            "kline_monthly_sha256":kc,
            "funding_monthly_sha256":fc,
            "funding_status":"BINANCE_VISION_OK",
        }
        print(json.dumps({"stage":"loaded","symbol":s,"bars":len(bars),"funding":len(frows)}),flush=True)

    times,opens,closes=align(all_bars)
    results={cname:run_walkforward(times,opens,closes,funding,cost) for cname,cost in COSTS.items()}

    payload={
        "schemaVersion":1,
        "kind":"crypto-stat-arb-v1",
        "research_only":True,
        "public_data_only":True,
        "live_trading":False,
        "private_api":False,
        "orders_submitted":0,
        "leverage":1,
        "lookahead_free":True,
        "symbols":SYMBOLS,
        "months":MONTHS,
        "costs":COSTS,
        "formula":{
            "universe":"all 28 pairs from 8 liquid USD-M perpetuals",
            "formation":"previous 90 days of 4h closes",
            "pair_model":"log-price OLS residual; beta 0.2..5; AR(1) phi 0..0.98; half-life 1..60 bars; >=6 zero crossings",
            "selection":"monthly top 3 fastest valid mean-reverting pairs, greedily no shared symbols",
            "entry":"|formation-fixed z| >= 2.0; signal on close, execute next 4h open",
            "exit":"|z| <= 0.5",
            "stop":"|z| >= 4.0 or 7-day max hold",
            "weights":"beta-neutral gross 1x pair notional",
            "funding_included":True,
            "selection_uses_future":False,
        },
        "provenance":provenance,
        "results":results,
        "limitations":[
            "AR(1) mean-reversion screening is a cointegration proxy, not a formal ADF/Johansen test.",
            "Portfolio MDD is measured at 30-day block resolution and can understate intrablock drawdown.",
            "Selected pairs can create indirect factor exposures despite no shared symbols within each block.",
            "No liquidation model; gross exposure is fixed at 1x.",
        ],
    }
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")

    lines=[
        "# Crypto Statistical Arbitrage V1",
        "",
        "RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS",
        "",
        "| Cost | Full ann. | Full total | Block MDD | Block PF | Recent 6 blocks ann. | Recent total | Scaled trade PF | Trades |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for cname in COSTS:
        x=results[cname]
        f=x["full"]
        r=x["recent6blocks"]
        bpf="NA" if f["pf_blocks"] is None else f'{f["pf_blocks"]:.3f}'
        tpf="NA" if x["scaled_trade_pf"] is None else f'{x["scaled_trade_pf"]:.3f}'
        lines.append(
            f'| {cname} | {f["annualized"]*100:.2f}% | {f["return"]*100:.2f}% | '
            f'{f["mdd_block_level"]*100:.2f}% | {bpf} | {r["annualized"]*100:.2f}% | '
            f'{r["return"]*100:.2f}% | {tpf} | {x["scaled_trade_count"]} |'
        )
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":
    main()
