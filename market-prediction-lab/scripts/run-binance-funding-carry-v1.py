#!/usr/bin/env python3
from __future__ import annotations
import csv, hashlib, io, json, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT"]
MONTHS=[f"{y}-{m:02d}" for y,m0,m1 in [(2024,1,12),(2025,1,12),(2026,1,7)] for m in range(m0,m1+1)]
SPOT_BASE="https://data.binance.vision/data/spot/monthly/klines"
FUT_BASE="https://data.binance.vision/data/futures/um/monthly/klines"
FUND_BASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
UA={"User-Agent":"investment-platform-public-research/1.0"}
OUT=Path("market-prediction-lab/artifacts/binance-funding-carry-v1")
OUT.mkdir(parents=True,exist_ok=True)
COSTS={
  "base":{"spot":0.0010,"futures":0.0008},
  "stress":{"spot":0.0015,"futures":0.0012},
}

@dataclass
class Bar:
    t:int; o:float; h:float; l:float; c:float; v:float

def get_bytes(url, timeout=30, retries=4):
    err=None
    for n in range(retries+1):
        try:
            req=urllib.request.Request(url,headers=UA)
            with urllib.request.urlopen(req,timeout=timeout) as r:
                return r.read()
        except Exception as e:
            err=e
            if n<retries: time.sleep(1.0*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

def checked_zip(url,name):
    data=get_bytes(url)
    chk=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if chk.lower()!=actual.lower(): raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(data)),actual

def fetch_kline_month(symbol,month,kind):
    base=SPOT_BASE if kind=="spot" else FUT_BASE
    name=f"{symbol}-1d-{month}.zip"
    z,digest=checked_zip(f"{base}/{symbol}/1d/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"): continue
        text=io.TextIOWrapper(z.open(member),encoding="utf-8")
        for r in csv.reader(text):
            if not r or not r[0].isdigit(): continue
            ts=int(r[0])
            # Binance Spot archive switched to microsecond timestamps for newer files;
            # normalize both spot and USD-M futures to milliseconds before alignment.
            if ts > 100_000_000_000_000:
                ts //= 1000
            rows.append(Bar(ts,float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5])))
    return month,rows,digest

def fetch_funding_month(symbol,month):
    name=f"{symbol}-fundingRate-{month}.zip"
    z,digest=checked_zip(f"{FUND_BASE}/{symbol}/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"): continue
        text=io.TextIOWrapper(z.open(member),encoding="utf-8")
        reader=csv.DictReader(text)
        for row in reader:
            try:
                ts=int(float(row.get("calc_time") or row.get("fundingTime") or 0))
                rate=float(row.get("last_funding_rate") or row.get("funding_rate") or row.get("fundingRate"))
                if ts>0: rows.append((ts,rate))
            except Exception:
                pass
    return month,rows,digest

def load_series(symbol,kind):
    parts={}; checks={}
    fn=fetch_funding_month if kind=="funding" else (lambda s,m:fetch_kline_month(s,m,kind))
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fn,symbol,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,rows,digest=f.result()
            parts[m]=rows; checks[m]=digest
    merged=[]
    for m in MONTHS: merged.extend(parts[m])
    if kind=="funding":
        ded={ts:rate for ts,rate in merged}
        return sorted(ded.items()),checks
    ded={x.t:x for x in merged}
    bars=[ded[k] for k in sorted(ded)]
    return bars,checks

def funding_between(funding,t0,t1):
    return sum(rate for ts,rate in funding if t0<ts<=t1)

def trailing_funding(funding,t,days=7):
    lo=t-days*86400000
    return sum(rate for ts,rate in funding if lo<ts<=t)

def iso(ms):
    return datetime.fromtimestamp(ms/1000,tz=timezone.utc).isoformat()

def align(spot,fut):
    fs={x.t:x for x in fut}
    rows=[]
    for s in spot:
        f=fs.get(s.t)
        if f: rows.append((s,f))
    return rows

def simulate(rows,funding,costs,mode):
    # Two fully funded legs: +1x spot and -1x perpetual.
    # Return is measured on total capital of 2 notional units.
    eq=1.0; peak=1.0; mdd=0.0; state=False; entry_eq=None; trades=[]
    exposure_days=0; funding_contrib=0.0; basis_contrib=0.0
    start=8
    for i in range(start,len(rows)-1):
        s,f=rows[i]; sn,fn=rows[i+1]
        signal=True if mode=="always" else trailing_funding(funding,s.t,7)>0
        if signal!=state:
            turnover_cost=(costs["spot"]+costs["futures"])/2
            eq*=1-turnover_cost
            if state and entry_eq is not None:
                trades.append(eq/entry_eq-1)
                entry_eq=None
            if signal:
                entry_eq=eq
            state=signal
            peak=max(peak,eq); mdd=min(mdd,eq/peak-1)
        if state:
            exposure_days+=1
            spot_r=sn.o/s.o-1
            fut_r=fn.o/f.o-1
            fund=funding_between(funding,s.t,sn.t)
            daily=(spot_r-fut_r+fund)/2
            funding_contrib+=fund/2
            basis_contrib+=(spot_r-fut_r)/2
            if daily<=-0.99: daily=-0.99
            eq*=1+daily
            peak=max(peak,eq); mdd=min(mdd,eq/peak-1)
    if state:
        turnover_cost=(costs["spot"]+costs["futures"])/2
        eq*=1-turnover_cost
        if entry_eq is not None: trades.append(eq/entry_eq-1)
        peak=max(peak,eq); mdd=min(mdd,eq/peak-1)
    wins=[x for x in trades if x>0]; losses=[x for x in trades if x<0]
    gw=sum(wins); gl=-sum(losses)
    years=(rows[-1][0].t-rows[start][0].t)/(365.25*86400000)
    ann=(eq**(1/years)-1) if years>0 and eq>0 else None
    return {
      "return":eq-1,"annualized_return":ann,"mdd":mdd,"trades":len(trades),
      "pf":gw/gl if gl else None,"win_rate":len(wins)/len(trades) if trades else 0.0,
      "exposure":exposure_days/max(1,len(rows)-1-start),
      "funding_contribution_simple":funding_contrib,
      "spot_minus_perp_contribution_simple":basis_contrib,
    }

def portfolio(symres):
    names=list(symres)
    return {
      "equal_weight_return":sum(symres[s]["return"] for s in names)/len(names),
      "equal_weight_annualized":sum(symres[s]["annualized_return"] for s in names if symres[s]["annualized_return"] is not None)/len(names),
      "avg_mdd":sum(symres[s]["mdd"] for s in names)/len(names),
      "positive_symbols":sum(1 for s in names if symres[s]["return"]>0),
      "avg_exposure":sum(symres[s]["exposure"] for s in names)/len(names),
    }

def main():
    data={}; provenance={}
    for sym in SYMBOLS:
        spot,schk=load_series(sym,"spot")
        fut,fchk=load_series(sym,"futures")
        funding,fdchk=load_series(sym,"funding")
        rows=align(spot,fut)
        if len(rows)<700: raise RuntimeError(f"{sym} insufficient aligned rows {len(rows)}")
        if not funding: raise RuntimeError(f"{sym} empty funding")
        data[sym]=(rows,funding)
        provenance[sym]={
          "aligned_daily_rows":len(rows),"start":iso(rows[0][0].t),"end":iso(rows[-1][0].t),
          "spot_monthly_sha256":schk,"futures_monthly_sha256":fchk,"funding_monthly_sha256":fdchk,
          "funding_rows":len(funding),"funding_status":"BINANCE_VISION_OK",
        }
        print(json.dumps({"loaded":sym,"daily":len(rows),"funding":len(funding)}),flush=True)
    results={}
    for cname,costs in COSTS.items():
        results[cname]={}
        for mode in ("always","positive_7d"):
            by={sym:simulate(*data[sym],costs,mode) for sym in SYMBOLS}
            results[cname][mode]={"portfolio":portfolio(by),"symbols":by}
    payload={
      "schemaVersion":1,"kind":"binance-funding-carry-v1","research_only":True,"public_data_only":True,
      "live_trading":False,"private_api":False,"orders_submitted":0,
      "formula":{
        "legs":"long spot 1x + short USD-M perpetual 1x",
        "capital_measure":"fully funded two-leg capital; daily pnl divided by 2",
        "modes":["always","positive_7d"],
        "positive_7d":"hold only when trailing seven-day realized funding sum at decision time is positive",
        "execution":"daily UTC open-to-open; signals use funding observed at or before decision time",
      },
      "symbols":SYMBOLS,"months":MONTHS,"costs":COSTS,"provenance":provenance,"results":results,
    }
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# Binance Funding Carry V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
      "| Cost | Mode | EW Return | EW Ann. | Positive | Avg MDD | Exposure |",
      "|---|---|---:|---:|---:|---:|---:|"]
    for cname in COSTS:
        for mode in ("always","positive_7d"):
            p=results[cname][mode]["portfolio"]
            lines.append(f'| {cname} | {mode} | {p["equal_weight_return"]*100:.2f}% | {p["equal_weight_annualized"]*100:.2f}% | {p["positive_symbols"]}/{len(SYMBOLS)} | {p["avg_mdd"]*100:.2f}% | {p["avg_exposure"]*100:.1f}% |')
    lines+=["","## Base positive_7d by symbol","","| Symbol | Return | Ann. | PF | MDD | Exposure | Funding contribution* | Spot-Perp contribution* |","|---|---:|---:|---:|---:|---:|---:|---:|"]
    for sym in SYMBOLS:
        x=results["base"]["positive_7d"]["symbols"][sym]
        pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
        lines.append(f'| {sym} | {x["return"]*100:.2f}% | {x["annualized_return"]*100:.2f}% | {pf} | {x["mdd"]*100:.2f}% | {x["exposure"]*100:.1f}% | {x["funding_contribution_simple"]*100:.2f}% | {x["spot_minus_perp_contribution_simple"]*100:.2f}% |')
    lines+=["","*Contribution fields are simple sums for decomposition, not compounded attribution."]
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":
    main()
