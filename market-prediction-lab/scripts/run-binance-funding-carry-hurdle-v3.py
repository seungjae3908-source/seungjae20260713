#!/usr/bin/env python3
from __future__ import annotations
import csv, hashlib, io, json, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT"]
MONTHS=[f"{y}-{m:02d}" for y,m0,m1 in [(2024,1,12),(2025,1,12),(2026,1,8)] for m in range(m0,m1+1)]
SPOT_BASE="https://data.binance.vision/data/spot/monthly/klines"
FUT_BASE="https://data.binance.vision/data/futures/um/monthly/klines"
FUND_BASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
UA={"User-Agent":"investment-platform-public-research/1.0"}
OUT=Path("market-prediction-lab/artifacts/binance-funding-carry-hurdle-v3")
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

def simulate_dynamic_top2(data,costs,lookback_days,rebalance_days):
    # Cross-sectional carry: rank trailing realized funding on a fixed schedule.
    # Hold up to the top 2 positive-funding delta-neutral pairs.
    row_maps={sym:{s.t:(s,f) for s,f in data[sym][0]} for sym in SYMBOLS}
    common=sorted(set.intersection(*(set(row_maps[sym]) for sym in SYMBOLS)))
    if len(common)<700:
        raise RuntimeError(f"dynamic common daily rows insufficient {len(common)}")
    eq=1.0; peak=1.0; mdd=0.0
    weights={sym:0.0 for sym in SYMBOLS}
    one_way_pair_cost=(costs["spot"]+costs["futures"])/2
    start=max(8,lookback_days+1)
    daily_returns=[]
    turnover_total=0.0; exposure_sum=0.0
    funding_contrib=0.0; basis_contrib=0.0
    selection_count={sym:0 for sym in SYMBOLS}

    for i in range(start,len(common)-1):
        t=common[i]; tn=common[i+1]
        eq_before=eq
        if (i-start)%rebalance_days==0:
            ranking=[]
            for sym in SYMBOLS:
                trailing=trailing_funding(data[sym][1],t,lookback_days)
                if trailing>0:
                    ranking.append((trailing,sym))
            ranking.sort(reverse=True)
            selected=[sym for _,sym in ranking[:2]]
            target={sym:0.0 for sym in SYMBOLS}
            if selected:
                w=1.0/len(selected)
                for sym in selected:
                    target[sym]=w
                    selection_count[sym]+=1
            turnover=sum(abs(target[sym]-weights[sym]) for sym in SYMBOLS)
            if turnover:
                eq*=max(0.0,1-turnover*one_way_pair_cost)
                turnover_total+=turnover
            weights=target
            peak=max(peak,eq); mdd=min(mdd,eq/peak-1)

        exposure_sum+=sum(weights.values())
        daily=0.0
        for sym,w in weights.items():
            if w<=0: continue
            s,f=row_maps[sym][t]; sn,fn=row_maps[sym][tn]
            spot_r=sn.o/s.o-1
            fut_r=fn.o/f.o-1
            fund=funding_between(data[sym][1],t,tn)
            pair_r=(spot_r-fut_r+fund)/2
            daily+=w*pair_r
            funding_contrib+=w*fund/2
            basis_contrib+=w*(spot_r-fut_r)/2
        daily=max(daily,-0.99)
        eq*=1+daily
        daily_returns.append(eq/eq_before-1)
        peak=max(peak,eq); mdd=min(mdd,eq/peak-1)

    closing_turnover=sum(weights.values())
    if closing_turnover:
        eq_before=eq
        eq*=max(0.0,1-closing_turnover*one_way_pair_cost)
        turnover_total+=closing_turnover
        daily_returns.append(eq/eq_before-1)
        peak=max(peak,eq); mdd=min(mdd,eq/peak-1)

    wins=[x for x in daily_returns if x>0]; losses=[x for x in daily_returns if x<0]
    gp=sum(wins); gl=-sum(losses)
    years=(common[-1]-common[start])/(365.25*86400000)
    return {
      "return":eq-1,
      "annualized_return":eq**(1/years)-1 if years>0 and eq>0 else None,
      "mdd":mdd,
      "lookback_days":lookback_days,
      "rebalance_days":rebalance_days,
      "daily_observations":len(daily_returns),
      "win_rate":len(wins)/len(daily_returns) if daily_returns else 0.0,
      "pf":gp/gl if gl else None,
      "avg_exposure":exposure_sum/max(1,len(common)-1-start),
      "turnover_units":turnover_total,
      "funding_contribution_simple":funding_contrib,
      "spot_minus_perp_contribution_simple":basis_contrib,
      "selection_count":selection_count,
    }

def simulate_dynamic_top2_hurdle(data,costs,hurdle_multiple):
    # Same 30d top-2 carry strategy, but require trailing 30d funding to cover
    # a cost-derived hurdle. Signal hurdle is frozen from BASE costs so Stress
    # changes execution cost only, not the trades selected.
    row_maps={sym:{s.t:(s,f) for s,f in data[sym][0]} for sym in SYMBOLS}
    common=sorted(set.intersection(*(set(row_maps[sym]) for sym in SYMBOLS)))
    if len(common)<700:
        raise RuntimeError(f"dynamic common daily rows insufficient {len(common)}")
    eq=1.0; peak=1.0; mdd=0.0
    weights={sym:0.0 for sym in SYMBOLS}
    one_way_pair_cost=(costs["spot"]+costs["futures"])/2
    base_one_way_pair_cost=(COSTS["base"]["spot"]+COSTS["base"]["futures"])/2
    # funding sum is on 1x perp notional; pair return divides by 2 total capital.
    # break-even: trailing_funding/2 > roundtrip_pair_cost (=2*one_way_pair_cost)
    # => trailing_funding > 4*one_way_pair_cost.
    raw_funding_hurdle=4*base_one_way_pair_cost*hurdle_multiple
    start=31
    daily_returns=[];turnover_total=0.0;exposure_sum=0.0
    selection_count={sym:0 for sym in SYMBOLS};cash_rebalances=0

    for i in range(start,len(common)-1):
        t=common[i];tn=common[i+1];eq_before=eq
        if (i-start)%30==0:
            ranking=[]
            for sym in SYMBOLS:
                trailing=trailing_funding(data[sym][1],t,30)
                if trailing>raw_funding_hurdle:
                    ranking.append((trailing,sym))
            ranking.sort(reverse=True)
            selected=[sym for _,sym in ranking[:2]]
            target={sym:0.0 for sym in SYMBOLS}
            if selected:
                w=1.0/len(selected)
                for sym in selected:
                    target[sym]=w;selection_count[sym]+=1
            else:
                cash_rebalances+=1
            turnover=sum(abs(target[sym]-weights[sym]) for sym in SYMBOLS)
            if turnover:
                eq*=max(0.0,1-turnover*one_way_pair_cost)
                turnover_total+=turnover
            weights=target
            peak=max(peak,eq);mdd=min(mdd,eq/peak-1)

        exposure_sum+=sum(weights.values())
        daily=0.0
        for sym,w in weights.items():
            if w<=0:continue
            s,f=row_maps[sym][t];sn,fn=row_maps[sym][tn]
            spot_r=sn.o/s.o-1;fut_r=fn.o/f.o-1
            fund=funding_between(data[sym][1],t,tn)
            daily+=w*(spot_r-fut_r+fund)/2
        daily=max(daily,-0.99);eq*=1+daily;daily_returns.append(eq/eq_before-1)
        peak=max(peak,eq);mdd=min(mdd,eq/peak-1)

    closing_turnover=sum(weights.values())
    if closing_turnover:
        eq_before=eq
        eq*=max(0.0,1-closing_turnover*one_way_pair_cost)
        turnover_total+=closing_turnover;daily_returns.append(eq/eq_before-1)
        peak=max(peak,eq);mdd=min(mdd,eq/peak-1)

    wins=[x for x in daily_returns if x>0];losses=[x for x in daily_returns if x<0]
    gp=sum(wins);gl=-sum(losses)
    years=(common[-1]-common[start])/(365.25*86400000)
    return {
      "return":eq-1,"annualized_return":eq**(1/years)-1 if years>0 and eq>0 else None,
      "mdd":mdd,"hurdle_multiple":hurdle_multiple,
      "raw_30d_funding_hurdle":raw_funding_hurdle,
      "pf":gp/gl if gl else None,
      "avg_exposure":exposure_sum/max(1,len(common)-1-start),
      "turnover_units":turnover_total,"cash_rebalances":cash_rebalances,
      "selection_count":selection_count,
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
        results[cname]["dynamic_top2_positive7d"]=simulate_dynamic_top2(data,costs,7,7)
        results[cname]["dynamic_top2_positive30d"]=simulate_dynamic_top2(data,costs,30,30)
        results[cname]["dynamic_top2_hurdle1x30d"]=simulate_dynamic_top2_hurdle(data,costs,1.0)
        results[cname]["dynamic_top2_hurdle2x30d"]=simulate_dynamic_top2_hurdle(data,costs,2.0)
    payload={
      "schemaVersion":1,"kind":"binance-funding-carry-hurdle-v3","research_only":True,"public_data_only":True,
      "live_trading":False,"private_api":False,"orders_submitted":0,
      "formula":{
        "legs":"long spot 1x + short USD-M perpetual 1x",
        "capital_measure":"fully funded two-leg capital; daily pnl divided by 2",
        "modes":["always","positive_7d","dynamic_top2_positive7d","dynamic_top2_positive30d","dynamic_top2_hurdle1x30d","dynamic_top2_hurdle2x30d"],
        "positive_7d":"hold only when trailing seven-day realized funding sum at decision time is positive",
        "dynamic_top2_positive7d":"every 7 days rank the four symbols by trailing realized 7d funding; hold up to top 2 with positive funding, equal-weighted",
        "dynamic_top2_positive30d":"every 30 days rank the four symbols by trailing realized 30d funding; hold up to top 2 with positive funding, equal-weighted",
        "dynamic_top2_hurdle1x30d":"same 30d ranking but funding/2 must exceed base modeled round-trip pair cost",
        "dynamic_top2_hurdle2x30d":"same 30d ranking but funding/2 must exceed 2x base modeled round-trip pair cost",
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
    lines+=["","## Dynamic top-2 positive funding","","| Cost | Mode | Return | Ann. | PF* | MDD | Exposure | Turnover |","|---|---|---:|---:|---:|---:|---:|---:|"]
    for cname in COSTS:
        for mode in ("dynamic_top2_positive7d","dynamic_top2_positive30d"):
            x=results[cname][mode]
            pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
            lines.append(f'| {cname} | {mode} | {x["return"]*100:.2f}% | {x["annualized_return"]*100:.2f}% | {pf} | {x["mdd"]*100:.2f}% | {x["avg_exposure"]*100:.1f}% | {x["turnover_units"]:.2f} |')
    lines+=["","*Dynamic PF is computed from daily net equity changes including rebalance costs. Contribution fields are simple sums for decomposition, not compounded attribution."]
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":
    main()
