#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import io
import json
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","LINKUSDT","ADAUSDT"]
MONTHS = [f"{y}-{m:02d}" for y,m0,m1 in [(2025,1,12),(2026,1,7)] for m in range(m0,m1+1)]
KLINE_BASE = "https://data.binance.vision/data/futures/um/monthly/klines"
FUND_BASE = "https://data.binance.vision/data/futures/um/monthly/fundingRate"
OUT = Path("market-prediction-lab/artifacts/tsmom28-long-flat-v1")
OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent":"investment-platform-public-research/1.0"}
SIDE_COSTS = {"base":0.0008, "stress":0.0012}
LOOKBACK_DAYS = 28
REBALANCE_DAYS = 5

@dataclass
class Bar:
    t:int
    o:float
    h:float
    l:float
    c:float
    v:float

def get_bytes(url, timeout=30, retries=4):
    err=None
    for attempt in range(retries+1):
        try:
            req=urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            err=e
            if attempt < retries:
                time.sleep(1.0*(2**attempt))
    raise RuntimeError(f"download failed {url}: {err}")

def fetch_kline_month(symbol, month):
    name=f"{symbol}-1d-{month}.zip"
    url=f"{KLINE_BASE}/{symbol}/1d/{name}"
    data=get_bytes(url)
    chk=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if chk.lower()!=actual.lower():
        raise RuntimeError(f"kline checksum mismatch {name}")
    z=zipfile.ZipFile(io.BytesIO(data))
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):
            continue
        text=io.TextIOWrapper(z.open(member), encoding="utf-8")
        for r in csv.reader(text):
            if not r or not r[0].isdigit():
                continue
            rows.append(Bar(int(r[0]),float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5])))
    return month, rows, actual

def load_symbol(symbol):
    parts={}
    checks={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_kline_month,symbol,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,rows,digest=f.result()
            parts[m]=rows
            checks[m]=digest
            print(json.dumps({"stage":"kline","symbol":symbol,"month":m,"rows":len(rows)}), flush=True)
    all_rows=[]
    for m in MONTHS:
        all_rows.extend(parts[m])
    ded={x.t:x for x in all_rows}
    bars=[ded[k] for k in sorted(ded)]
    for a,b in zip(bars,bars[1:]):
        if b.t-a.t != 86400000:
            raise RuntimeError(f"{symbol} daily gap {a.t}->{b.t}")
    if len(bars) < LOOKBACK_DAYS + REBALANCE_DAYS + 2:
        raise RuntimeError(f"{symbol} insufficient daily bars={len(bars)}")
    return bars, checks

def fetch_funding_month(symbol, month):
    name=f"{symbol}-fundingRate-{month}.zip"
    url=f"{FUND_BASE}/{symbol}/{name}"
    data=get_bytes(url)
    chk=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if chk.lower()!=actual.lower():
        raise RuntimeError(f"funding checksum mismatch {name}")
    z=zipfile.ZipFile(io.BytesIO(data))
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):
            continue
        text=io.TextIOWrapper(z.open(member), encoding="utf-8")
        reader=csv.DictReader(text)
        for row in reader:
            try:
                ts=int(float(row.get("calc_time") or row.get("fundingTime") or 0))
                rate=float(row.get("last_funding_rate") or row.get("funding_rate") or row.get("fundingRate"))
                if ts>0:
                    rows.append((ts,rate))
            except Exception:
                continue
    return month, rows, actual

def load_funding(symbol, start_ms, end_ms):
    parts={}
    checks={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_funding_month,symbol,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,rows,digest=f.result()
            parts[m]=rows
            checks[m]=digest
    merged=[]
    for m in MONTHS:
        merged.extend(parts[m])
    ded={ts:rate for ts,rate in merged if start_ms <= ts <= end_ms+86400000}
    rows=sorted(ded.items())
    if not rows:
        raise RuntimeError(f"{symbol} funding empty")
    return rows, checks

def funding_cost(funding, t0, t1):
    # Long pays positive funding and receives negative funding.
    return sum(rate for ts,rate in funding if t0 < ts <= t1)

def iso(ms):
    return datetime.fromtimestamp(ms/1000,tz=timezone.utc).isoformat()

def simulate(bars, funding, side_cost):
    # Signal uses only completed bars:
    # at day i open, compare previous close with close 28 completed days earlier.
    # Re-evaluate every 5 days. Positive trailing return => LONG, otherwise FLAT.
    first_i=LOOKBACK_DAYS+1
    state=0
    target=0
    equity=1.0
    peak=1.0
    mdd=0.0
    long_days=0
    eligible_days=0
    funding_sum=0.0
    trades=[]
    active=None

    def mark():
        nonlocal peak,mdd
        peak=max(peak,equity)
        mdd=min(mdd,equity/peak-1.0)

    for i in range(first_i, len(bars)-1):
        eligible_days += 1
        if (i-first_i) % REBALANCE_DAYS == 0:
            trailing = bars[i-1].c / bars[i-1-LOOKBACK_DAYS].c - 1.0
            target = 1 if trailing > 0 else 0

        if target != state:
            if state == 1:
                equity *= (1.0-side_cost)
                if active is not None:
                    trade_ret=equity/active["entry_equity"]-1.0
                    trades.append({
                        "entry":active["entry"],
                        "exit":bars[i].t,
                        "return":trade_ret,
                        "funding_sum":active["funding_sum"],
                    })
                    active=None
                mark()
            if target == 1:
                equity *= (1.0-side_cost)
                active={"entry":bars[i].t,"entry_equity":equity,"funding_sum":0.0}
                mark()
            state=target

        if state == 1:
            long_days += 1
            gross = bars[i+1].o / bars[i].o - 1.0
            fc = funding_cost(funding, bars[i].t, bars[i+1].t)
            funding_sum += fc
            if active is not None:
                active["funding_sum"] += fc
            interval = gross - fc
            if interval <= -0.99:
                interval = -0.99
            equity *= (1.0+interval)
            mark()

    if state == 1:
        equity *= (1.0-side_cost)
        if active is not None:
            trade_ret=equity/active["entry_equity"]-1.0
            trades.append({
                "entry":active["entry"],
                "exit":bars[-1].t,
                "return":trade_ret,
                "funding_sum":active["funding_sum"],
            })
        mark()

    wins=[t["return"] for t in trades if t["return"]>0]
    losses=[t["return"] for t in trades if t["return"]<0]
    gw=sum(wins)
    gl=-sum(losses)
    return {
        "trades":len(trades),
        "return":equity-1.0,
        "mdd":mdd,
        "pf":gw/gl if gl else None,
        "win_rate":len(wins)/len(trades) if trades else 0.0,
        "exposure":long_days/eligible_days if eligible_days else 0.0,
        "funding_rate_sum":funding_sum,
        "trade_returns":[t["return"] for t in trades],
    }

def portfolio_summary(by_symbol):
    names=list(by_symbol)
    returns=[by_symbol[s]["return"] for s in names]
    mdds=[by_symbol[s]["mdd"] for s in names]
    trade_returns=[]
    for s in names:
        trade_returns.extend(by_symbol[s]["trade_returns"])
    gw=sum(x for x in trade_returns if x>0)
    gl=-sum(x for x in trade_returns if x<0)
    return {
        "equal_weight_return":sum(returns)/len(returns),
        "avg_symbol_mdd":sum(mdds)/len(mdds),
        "trades":sum(by_symbol[s]["trades"] for s in names),
        "pooled_pf":gw/gl if gl else None,
        "positive_symbols":sum(1 for x in returns if x>0),
        "avg_exposure":sum(by_symbol[s]["exposure"] for s in names)/len(names),
    }

def main():
    bars_map={}
    funding_map={}
    provenance={}
    funding_status={}
    for sym in SYMBOLS:
        bars,kchecks=load_symbol(sym)
        funding,fchecks=load_funding(sym,bars[0].t,bars[-1].t)
        bars_map[sym]=bars
        funding_map[sym]=funding
        funding_status[sym]="BINANCE_VISION_OK"
        provenance[sym]={
            "rows":len(bars),
            "start":iso(bars[0].t),
            "end":iso(bars[-1].t),
            "kline_monthly_sha256":kchecks,
            "funding_monthly_sha256":fchecks,
            "funding_rows":len(funding),
        }
        print(json.dumps({"stage":"loaded","symbol":sym,"daily_rows":len(bars),"funding_rows":len(funding)}), flush=True)

    results={}
    for cost_name,cost in SIDE_COSTS.items():
        by={}
        for sym in SYMBOLS:
            by[sym]=simulate(bars_map[sym], funding_map[sym], cost)
        results[cost_name]={
            "portfolio":portfolio_summary(by),
            "symbols":{s:{k:v for k,v in by[s].items() if k!="trade_returns"} for s in SYMBOLS},
        }

    payload={
        "schemaVersion":1,
        "kind":"tsmom28-long-flat-v1",
        "research_only":True,
        "public_data_only":True,
        "live_trading":False,
        "private_api":False,
        "orders_submitted":0,
        "leverage":1,
        "formula":{
            "lookback_days":LOOKBACK_DAYS,
            "rebalance_days":REBALANCE_DAYS,
            "signal":"trailing_28d_return > 0 => LONG, else FLAT",
            "execution":"signal from completed daily bars, target applied at next daily open",
            "shorting":False,
        },
        "symbols":SYMBOLS,
        "months":MONTHS,
        "side_costs":SIDE_COSTS,
        "funding_status":funding_status,
        "provenance":provenance,
        "results":results,
    }
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")

    lines=[
        "# TSMOM28 Long/Flat V1",
        "",
        "RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS",
        "",
        "Formula: trailing 28-day return > 0 => LONG; otherwise FLAT. Re-evaluate every 5 days. 1x only.",
        "",
        "| Cost | Trades | Equal-weight return | Pooled PF | Positive symbols | Avg MDD | Avg exposure |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for cost_name in SIDE_COSTS:
        p=results[cost_name]["portfolio"]
        pf="NA" if p["pooled_pf"] is None else f'{p["pooled_pf"]:.3f}'
        lines.append(f'| {cost_name} | {p["trades"]} | {p["equal_weight_return"]*100:.2f}% | {pf} | {p["positive_symbols"]}/8 | {p["avg_symbol_mdd"]*100:.2f}% | {p["avg_exposure"]*100:.1f}% |')
    lines += ["", "## Per-symbol base", "", "| Symbol | Trades | Return | PF | Win rate | MDD | Exposure | Funding rate sum |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for sym in SYMBOLS:
        x=results["base"]["symbols"][sym]
        pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
        lines.append(f'| {sym} | {x["trades"]} | {x["return"]*100:.2f}% | {pf} | {x["win_rate"]*100:.1f}% | {x["mdd"]*100:.2f}% | {x["exposure"]*100:.1f}% | {x["funding_rate_sum"]*100:.3f}% |')
    lines += ["", "Funding status: "+json.dumps(funding_status,ensure_ascii=False)]
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":
    main()
