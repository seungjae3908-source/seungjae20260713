#!/usr/bin/env python3
from __future__ import annotations
import csv, hashlib, io, json, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","LINKUSDT","ADAUSDT"]
MONTHS=[f"{y}-{m:02d}" for y,m0,m1 in [(2022,1,12),(2023,1,12),(2024,1,12),(2025,1,12),(2026,1,7)] for m in range(m0,m1+1)]
KLINE_BASE="https://data.binance.vision/data/futures/um/monthly/klines"
FUND_BASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
UA={"User-Agent":"investment-platform-public-research/1.0"}
COSTS={"base":0.0008,"stress":0.0012}
OUT=Path("market-prediction-lab/artifacts/crypto-futures-cs-momentum-v1")
OUT.mkdir(parents=True,exist_ok=True)

@dataclass
class Bar:
    t:int; o:float; h:float; l:float; c:float; v:float

def get_bytes(url,timeout=30,retries=4):
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
    expected=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if expected.lower()!=actual.lower():
        raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(data)),actual

def fetch_kline_month(symbol,month):
    name=f"{symbol}-1d-{month}.zip"
    z,digest=checked_zip(f"{KLINE_BASE}/{symbol}/1d/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"): continue
        text=io.TextIOWrapper(z.open(member),encoding="utf-8")
        for r in csv.reader(text):
            if not r or not r[0].isdigit(): continue
            ts=int(r[0])
            if ts>100_000_000_000_000: ts//=1000
            rows.append(Bar(ts,float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5])))
    return month,rows,digest

def fetch_funding_month(symbol,month):
    name=f"{symbol}-fundingRate-{month}.zip"
    z,digest=checked_zip(f"{FUND_BASE}/{symbol}/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"): continue
        reader=csv.DictReader(io.TextIOWrapper(z.open(member),encoding="utf-8"))
        for row in reader:
            try:
                ts=int(float(row.get("calc_time") or row.get("fundingTime") or 0))
                rate=float(row.get("last_funding_rate") or row.get("funding_rate") or row.get("fundingRate"))
                if ts>0: rows.append((ts,rate))
            except Exception:
                pass
    return month,rows,digest

def load(symbol,kind):
    parts={}; checks={}
    fn=fetch_kline_month if kind=="kline" else fetch_funding_month
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs={ex.submit(fn,symbol,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,rows,digest=f.result()
            parts[m]=rows;checks[m]=digest
    merged=[]
    for m in MONTHS: merged.extend(parts[m])
    if kind=="kline":
        ded={x.t:x for x in merged}
        return [ded[t] for t in sorted(ded)],checks
    ded={t:r for t,r in merged}
    return sorted(ded.items()),checks

def funding_between(funding,t0,t1):
    return sum(r for t,r in funding if t0<t<=t1)

def prepare():
    bars={}; funding={}; provenance={}
    for sym in SYMBOLS:
        b,kchk=load(sym,"kline")
        f,fchk=load(sym,"funding")
        if len(b)<1500 or not f:
            raise RuntimeError(f"{sym} insufficient data bars={len(b)} funding={len(f)}")
        bars[sym]=b;funding[sym]=f
        provenance[sym]={
          "bars":len(b),"funding_rows":len(f),
          "kline_monthly_sha256":kchk,"funding_monthly_sha256":fchk,
          "funding_status":"BINANCE_VISION_OK",
        }
        print(json.dumps({"loaded":sym,"bars":len(b),"funding":len(f)}),flush=True)
    maps={sym:{x.t:x for x in bars[sym]} for sym in SYMBOLS}
    common=sorted(set.intersection(*(set(maps[s]) for s in SYMBOLS)))
    if len(common)<1500: raise RuntimeError(f"common rows insufficient {len(common)}")
    return maps,funding,common,provenance

def summarize(equity_curve,daily_returns,years,turnover,cost_paid,funding_pnl):
    peak=equity_curve[0];mdd=0
    for e in equity_curve:
        peak=max(peak,e);mdd=max(mdd,(peak-e)/peak if peak>0 else 0)
    wins=[r for r in daily_returns if r>0];losses=[r for r in daily_returns if r<0]
    gp=sum(wins);gl=-sum(losses)
    ret=equity_curve[-1]-1
    return {
      "return":ret,
      "annualized_return":(equity_curve[-1]**(1/years)-1) if years>0 and equity_curve[-1]>0 else None,
      "max_drawdown":mdd,
      "daily_win_rate":len(wins)/len(daily_returns) if daily_returns else 0,
      "profit_factor":gp/gl if gl else None,
      "turnover_units":turnover,
      "cost_paid_simple":cost_paid,
      "funding_pnl_simple":funding_pnl,
      "days":len(daily_returns),
    }

def simulate(maps,funding,common,lookback_days,cost,start_index=0):
    # Canonical crypto cross-sectional momentum:
    # formation lookback, skip one completed day, weekly rebalance,
    # long top-2 and short bottom-2, equal gross weights, 1x gross exposure.
    skip=1;rebalance=7
    minimum=lookback_days+skip+2
    start=max(minimum,start_index)
    weights={s:0.0 for s in SYMBOLS}
    eq=1.0;curve=[eq];daily_returns=[]
    turnover_total=0.0;cost_paid=0.0;funding_pnl=0.0
    long_counts={s:0 for s in SYMBOLS};short_counts={s:0 for s in SYMBOLS}

    for i in range(start,len(common)-1):
        t=common[i];tn=common[i+1]
        eq_before=eq
        if (i-start)%rebalance==0:
            formation_end=i-1-skip
            formation_start=formation_end-lookback_days
            ranked=[]
            for sym in SYMBOLS:
                c1=maps[sym][common[formation_end]].c
                c0=maps[sym][common[formation_start]].c
                ranked.append((c1/c0-1,sym))
            ranked.sort()
            shorts=[s for _,s in ranked[:2]]
            longs=[s for _,s in ranked[-2:]]
            target={s:0.0 for s in SYMBOLS}
            for s in longs:
                target[s]=0.25;long_counts[s]+=1
            for s in shorts:
                target[s]=-0.25;short_counts[s]+=1
            turnover=sum(abs(target[s]-weights[s]) for s in SYMBOLS)
            fee=turnover*cost
            eq*=max(0.0,1-fee)
            turnover_total+=turnover;cost_paid+=fee
            weights=target

        pnl=0.0
        for sym,w in weights.items():
            if w==0: continue
            b=maps[sym][t];bn=maps[sym][tn]
            price_r=bn.o/b.o-1
            fr=funding_between(funding[sym],t,tn)
            # Long pays positive funding; short receives it.
            pnl+=w*price_r-w*fr
            funding_pnl+=-w*fr
        pnl=max(pnl,-0.99)
        eq*=1+pnl
        daily_returns.append(eq/eq_before-1)
        curve.append(eq)

    closing=sum(abs(w) for w in weights.values())
    if closing:
        eq_before=eq
        fee=closing*cost
        eq*=max(0.0,1-fee)
        cost_paid+=fee;turnover_total+=closing
        daily_returns.append(eq/eq_before-1);curve.append(eq)

    years=(common[-1]-common[start])/(365.25*86400000)
    out=summarize(curve,daily_returns,years,turnover_total,cost_paid,funding_pnl)
    out["lookback_days"]=lookback_days
    out["long_selection_count"]=long_counts
    out["short_selection_count"]=short_counts
    return out

def build_plain_weeks(maps,funding,common,lookback_days):
    skip=1;rebalance=7
    start=lookback_days+skip+2
    weeks=[]
    for i in range(start,len(common)-1,rebalance):
        formation_end=i-1-skip
        formation_start=formation_end-lookback_days
        if formation_start<0: continue
        ranked=[]
        for sym in SYMBOLS:
            c1=maps[sym][common[formation_end]].c
            c0=maps[sym][common[formation_start]].c
            ranked.append((c1/c0-1,sym))
        ranked.sort()
        target={s:0.0 for s in SYMBOLS}
        for _,s in ranked[-2:]: target[s]=0.25
        for _,s in ranked[:2]: target[s]=-0.25
        end=min(i+rebalance,len(common)-1)
        plain_eq=1.0
        for d in range(i,end):
            t=common[d];tn=common[d+1]
            r=0.0
            for sym,w in target.items():
                if w==0: continue
                b=maps[sym][t];bn=maps[sym][tn]
                fr=funding_between(funding[sym],t,tn)
                r+=w*(bn.o/b.o-1)-w*fr
            plain_eq*=1+max(r,-0.99)
        weeks.append({"start_index":i,"end_index":end,"weights":target,"plain_return":plain_eq-1})
    return weeks

def simulate_risk_managed(maps,funding,common,lookback_days,cost,start_index=0,vol_window_weeks=8,target_weekly_vol=0.10,max_gross=3.0):
    # Barroso/Santa-Clara-style inverse-volatility scaling applied to the
    # canonical 2-week crypto WML factor, with a practical gross cap.
    weeks=build_plain_weeks(maps,funding,common,lookback_days)
    first_week=next((k for k,w in enumerate(weeks) if w["start_index"]>=start_index and k>=vol_window_weeks),None)
    if first_week is None:
        raise RuntimeError("risk-managed window has insufficient weekly history")
    eq=1.0;curve=[1.0];daily_returns=[];prev={s:0.0 for s in SYMBOLS}
    turnover_total=0.0;cost_paid=0.0;funding_pnl=0.0
    scales=[];gross_days=0.0;day_count=0

    for k in range(first_week,len(weeks)):
        wspec=weeks[k]
        hist=[weeks[j]["plain_return"] for j in range(k-vol_window_weeks,k)]
        sigma=(sum(r*r for r in hist)/vol_window_weeks)**0.5
        scale=max_gross if sigma<=1e-12 else min(max_gross,target_weekly_vol/sigma)
        scales.append(scale)
        target={s:wspec["weights"][s]*scale for s in SYMBOLS}
        turnover=sum(abs(target[s]-prev[s]) for s in SYMBOLS)
        eq_before=eq
        fee=turnover*cost
        eq*=max(0.0,1-fee)
        turnover_total+=turnover;cost_paid+=fee
        if fee:
            daily_returns.append(eq/eq_before-1);curve.append(eq)

        for d in range(wspec["start_index"],wspec["end_index"]):
            t=common[d];tn=common[d+1]
            eq_before=eq;r=0.0
            for sym,weight in target.items():
                if weight==0: continue
                b=maps[sym][t];bn=maps[sym][tn]
                fr=funding_between(funding[sym],t,tn)
                r+=weight*(bn.o/b.o-1)-weight*fr
                funding_pnl+=-weight*fr
            r=max(r,-0.99)
            eq*=1+r
            daily_returns.append(eq/eq_before-1);curve.append(eq)
            gross_days+=sum(abs(x) for x in target.values());day_count+=1
        prev=target

    closing=sum(abs(x) for x in prev.values())
    if closing:
        eq_before=eq;fee=closing*cost
        eq*=max(0.0,1-fee);cost_paid+=fee;turnover_total+=closing
        daily_returns.append(eq/eq_before-1);curve.append(eq)

    start_t=common[weeks[first_week]["start_index"]]
    years=(common[-1]-start_t)/(365.25*86400000)
    out=summarize(curve,daily_returns,years,turnover_total,cost_paid,funding_pnl)
    out.update({
      "lookback_days":lookback_days,
      "vol_window_weeks":vol_window_weeks,
      "target_weekly_vol":target_weekly_vol,
      "gross_cap":max_gross,
      "avg_gross_exposure":gross_days/max(1,day_count),
      "avg_scale":sum(scales)/len(scales) if scales else 0,
      "max_scale_used":max(scales) if scales else 0,
      "min_scale_used":min(scales) if scales else 0,
      "paper_exact":False,
      "paper_difference":"inverse 8-week RMS scaling with 10% weekly target, but gross exposure capped at 3x for practical safety",
    })
    return out

def main():
    maps,funding,common,provenance=prepare()
    recent_start=int(len(common)*0.70)
    results={}
    for name,lookback in (("MOM14",14),("MOM28",28)):
        results[name]={}
        for cname,cost in COSTS.items():
            results[name][cname]={
              "full":simulate(maps,funding,common,lookback,cost,0),
              "recent30pct":simulate(maps,funding,common,lookback,cost,recent_start),
            }
    results["MOM14_RM8_CAP3"]={}
    for cname,cost in COSTS.items():
        results["MOM14_RM8_CAP3"][cname]={
          "full":simulate_risk_managed(maps,funding,common,14,cost,0,8,0.10,3.0),
          "recent30pct":simulate_risk_managed(maps,funding,common,14,cost,recent_start,8,0.10,3.0),
        }

    payload={
      "schemaVersion":1,"kind":"crypto-futures-cross-sectional-momentum-v1",
      "research_only":True,"public_data_only":True,"live_trading":False,"private_api":False,"orders_submitted":0,
      "lookahead_free":True,
      "formula":{
        "formation":["14d","28d"],"skip_days":1,"rebalance_days":7,
        "portfolio":"long top2 + short bottom2, each 25% absolute weight, gross exposure 1x, net 0",
        "execution":"rank from completed daily closes ending one skipped day before rebalance; trade at next scheduled daily open",
        "funding":"historical Binance Vision funding applied with correct long/short sign",
        "risk_managed":"MOM14_RM8_CAP3 scales the 14d factor by inverse prior 8-week RMS return volatility toward a 10% weekly target, capped at 3x gross",
      },
      "symbols":SYMBOLS,"months":MONTHS,"costs":COSTS,"common_rows":len(common),"provenance":provenance,"results":results,
    }
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# Crypto Futures Cross-Sectional Momentum V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
      "| Strategy | Cost | Window | Return | Ann. | PF | MDD | Turnover |",
      "|---|---|---|---:|---:|---:|---:|---:|"]
    for strat in ("MOM14","MOM28","MOM14_RM8_CAP3"):
        for cname in ("base","stress"):
            for window in ("full","recent30pct"):
                x=results[strat][cname][window]
                pf="NA" if x["profit_factor"] is None else f'{x["profit_factor"]:.3f}'
                lines.append(f'| {strat} | {cname} | {window} | {x["return"]*100:.2f}% | {x["annualized_return"]*100:.2f}% | {pf} | {x["max_drawdown"]*100:.2f}% | {x["turnover_units"]:.1f} |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":
    main()
