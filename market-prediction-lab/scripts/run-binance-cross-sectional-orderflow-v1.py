#!/usr/bin/env python3
from __future__ import annotations
import csv, hashlib, io, json, math, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","LINKUSDT","ADAUSDT"]
MONTHS=[f"{y}-{m:02d}" for y,m0,m1 in [(2022,1,12),(2023,1,12),(2024,1,12),(2025,1,12),(2026,1,7)] for m in range(m0,m1+1)]
KBASE="https://data.binance.vision/data/futures/um/monthly/klines"
FBASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
OUT=Path("market-prediction-lab/artifacts/binance-cross-sectional-orderflow-v1");OUT.mkdir(parents=True,exist_ok=True)
UA={"User-Agent":"investment-platform-public-research/1.0"}
COSTS={"base":0.0008,"stress":0.0012}

@dataclass
class Bar:
    t:int;o:float;c:float;v:float;tb:float

def get_bytes(url,timeout=30,retries=4):
    err=None
    for n in range(retries+1):
        try:
            req=urllib.request.Request(url,headers=UA)
            with urllib.request.urlopen(req,timeout=timeout) as r:return r.read()
        except Exception as e:
            err=e
            if n<retries:time.sleep(0.8*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

def checked(url,name):
    data=get_bytes(url);chk=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if actual.lower()!=chk.lower():raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(data)),actual

def fetch_k(sym,m):
    name=f"{sym}-1d-{m}.zip";z,d=checked(f"{KBASE}/{sym}/1d/{name}",name);rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):continue
        for r in csv.reader(io.TextIOWrapper(z.open(member),encoding="utf-8")):
            if not r or not r[0].isdigit():continue
            try:
                ts=int(r[0]); 
                if ts>100_000_000_000_000:ts//=1000
                rows.append(Bar(ts,float(r[1]),float(r[4]),float(r[5]),float(r[9])))
            except Exception:pass
    return m,rows,d

def fetch_f(sym,m):
    name=f"{sym}-fundingRate-{m}.zip";z,d=checked(f"{FBASE}/{sym}/{name}",name);rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):continue
        rd=csv.DictReader(io.TextIOWrapper(z.open(member),encoding="utf-8"))
        for row in rd:
            try:
                ts=int(float(row.get("calc_time") or row.get("fundingTime") or 0))
                if ts>100_000_000_000_000:ts//=1000
                rate=float(row.get("last_funding_rate") or row.get("funding_rate") or row.get("fundingRate"))
                if ts>0:rows.append((ts,rate))
            except Exception:pass
    return m,rows,d

def load(sym):
    kp={};kc={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        fs={ex.submit(fetch_k,sym,m):m for m in MONTHS}
        for f in as_completed(fs):
            m,r,d=f.result();kp[m]=r;kc[m]=d
    bars=[]
    for m in MONTHS:bars.extend(kp[m])
    bars=sorted({b.t:b for b in bars}.values(),key=lambda b:b.t)
    fp={};fc={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        fs={ex.submit(fetch_f,sym,m):m for m in MONTHS}
        for f in as_completed(fs):
            m,r,d=f.result();fp[m]=r;fc[m]=d
    funding=[]
    for m in MONTHS:funding.extend(fp[m])
    funding=sorted({t:r for t,r in funding}.items())
    return bars,funding,kc,fc

def funding_between(f,t0,t1):
    return sum(r for ts,r in f if t0<ts<=t1)

def flow(b):
    return (2*b.tb-b.v)/b.v if b.v>0 else 0.0

def align(data):
    common=set(b.t for b in data[SYMBOLS[0]][0])
    for s in SYMBOLS[1:]:common &= {b.t for b in data[s][0]}
    ts=sorted(common)
    maps={s:{b.t:b for b in data[s][0]} for s in SYMBOLS}
    return ts,{s:[maps[s][t] for t in ts] for s in SYMBOLS}

def target_daily(bars,i,mode,market_idx=None):
    if mode=="OFI_D1_LS_TOP2":
        ranked=sorted(((flow(bars[s][i-1]),s) for s in SYMBOLS),reverse=True)
        w={s:0.0 for s in SYMBOLS}
        for _,s in ranked[:2]:w[s]=0.25
        for _,s in ranked[-2:]:w[s]=-0.25
        return w
    if mode in ("OFI_5D_LONG_TOP2","OFI_5D_LONG_TOP2_REGIME"):
        if mode=="OFI_5D_LONG_TOP2_REGIME":
            if market_idx is None or i<201:
                return {s:0.0 for s in SYMBOLS}
            ma=sum(market_idx[i-200:i])/200
            if market_idx[i-1] <= ma:
                return {s:0.0 for s in SYMBOLS}
        vals=[]
        for s in SYMBOLS:
            avg=sum(flow(bars[s][j]) for j in range(i-5,i))/5
            vals.append((avg,s))
        vals.sort(reverse=True)
        w={s:0.0 for s in SYMBOLS}
        chosen=[(v,s) for v,s in vals[:2] if v>0]
        for _,s in chosen:w[s]=0.5
        return w
    raise KeyError(mode)

def summarize(rs,curve,turnover,days):
    peak=1.0;mdd=0.0
    for e in curve:peak=max(peak,e);mdd=max(mdd,1-e/peak)
    wins=[x for x in rs if x>0];loss=[x for x in rs if x<0];gp=sum(wins);gl=-sum(loss)
    eq=curve[-1] if curve else 1
    years=days/365.25
    return {"days":days,"return":eq-1,"annualized":eq**(1/years)-1 if years>0 and eq>0 else None,
            "mdd":mdd,"win_rate":len(wins)/len(rs) if rs else 0,"pf":gp/gl if gl else None,
            "avg_daily":sum(rs)/len(rs) if rs else 0,"turnover":turnover}

def simulate(ts,bars,funding,mode,cost,start_index=5,market_idx=None):
    cur={s:0.0 for s in SYMBOLS};eq=1.;curve=[1.];rs=[];turn=0.;i=max(5,start_index)
    next_rebalance=i
    while i<len(ts)-1:
        reb=(mode=="OFI_D1_LS_TOP2") or (i>=next_rebalance)
        if reb:
            target=target_daily(bars,i,mode,market_idx)
            tv=sum(abs(target[s]-cur[s]) for s in SYMBOLS);turn+=tv
            eq*=max(0.01,1-tv*cost);cur=target
            if mode in ("OFI_5D_LONG_TOP2","OFI_5D_LONG_TOP2_REGIME"):next_rebalance=i+5
        daily=0.
        for s in SYMBOLS:
            if cur[s]==0:continue
            pr=bars[s][i+1].o/bars[s][i].o-1
            fr=funding_between(funding[s],ts[i],ts[i+1])
            daily+=cur[s]*pr-cur[s]*fr
        eq*=max(0.01,1+daily);curve.append(eq);rs.append(daily)
        i+=1
    tv=sum(abs(cur[s]) for s in SYMBOLS);turn+=tv;eq*=max(0.01,1-tv*cost);curve.append(eq)
    return summarize(rs,curve,turn,len(rs))

def benchmark(ts,bars,funding,cost,start_index=5):
    cur={s:1/len(SYMBOLS) for s in SYMBOLS};eq=1-cost;curve=[eq];rs=[]
    for i in range(max(5,start_index),len(ts)-1):
        daily=0
        for s in SYMBOLS:
            pr=bars[s][i+1].o/bars[s][i].o-1;fr=funding_between(funding[s],ts[i],ts[i+1])
            daily+=cur[s]*pr-cur[s]*fr
        eq*=max(0.01,1+daily);curve.append(eq);rs.append(daily)
    eq*=1-cost;curve.append(eq)
    return summarize(rs,curve,2.0,len(rs))

def main():
    data={};prov={};fund={}
    for s in SYMBOLS:
        b,f,kc,fc=load(s);data[s]=(b,f);fund[s]=f
        prov[s]={"daily_rows":len(b),"funding_rows":len(f),"funding_status":"BINANCE_VISION_OK","kline_sha256":kc,"funding_sha256":fc}
        print(json.dumps({"loaded":s,"days":len(b),"funding":len(f)}),flush=True)
    ts,bars=align(data)
    if len(ts)<1200:raise RuntimeError(f"common days too small {len(ts)}")
    recent=int(len(ts)*0.70)
    market_idx=[]
    base_close={s:bars[s][0].c for s in SYMBOLS}
    for i in range(len(ts)):
        market_idx.append(sum(bars[s][i].c/base_close[s] for s in SYMBOLS)/len(SYMBOLS))
    results={}
    for mode in ["OFI_D1_LS_TOP2","OFI_5D_LONG_TOP2","OFI_5D_LONG_TOP2_REGIME"]:
        results[mode]={}
        for cname,cost in COSTS.items():
            results[mode][cname]={"full":simulate(ts,bars,fund,mode,cost,5,market_idx),"recent30pct":simulate(ts,bars,fund,mode,cost,recent,market_idx)}
    bench={c:{"full":benchmark(ts,bars,fund,cost,5),"recent30pct":benchmark(ts,bars,fund,cost,recent)} for c,cost in COSTS.items()}
    payload={"schemaVersion":1,"kind":"binance-cross-sectional-orderflow-v1","research_only":True,"public_data_only":True,
             "live_trading":False,"private_api":False,"orders_submitted":0,"lookahead_free":True,
             "formula":{"daily_flow":"(2*taker_buy_volume-total_volume)/total_volume from completed UTC day",
                        "OFI_D1_LS_TOP2":"next-open long top2 / short bottom2, gross 1.0, daily rebalance",
                        "OFI_5D_LONG_TOP2":"5-day mean flow, positive top2 long only, rebalance every 5 days",
                        "OFI_5D_LONG_TOP2_REGIME":"same, but only while equal-weight crypto index completed close is above its 200-day SMA"},
             "symbols":SYMBOLS,"months":MONTHS,"costs":COSTS,"common_days":len(ts),"provenance":prov,"results":results,"benchmark_equal_weight_long":bench}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# Binance Cross-Sectional Order Flow V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Strategy | Cost | Window | Return | Ann. | PF | MDD | Turnover |",
           "|---|---|---|---:|---:|---:|---:|---:|"]
    for mode in results:
        for cname in COSTS:
            for window in ["full","recent30pct"]:
                x=results[mode][cname][window];pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
                lines.append(f'| {mode} | {cname} | {window} | {x["return"]*100:.2f}% | {x["annualized"]*100:.2f}% | {pf} | {x["mdd"]*100:.2f}% | {x["turnover"]:.1f} |')
    lines+=["","## Equal-weight long futures benchmark","","| Cost | Window | Return | Ann. | PF | MDD |","|---|---|---:|---:|---:|---:|"]
    for cname in COSTS:
        for window in ["full","recent30pct"]:
            x=bench[cname][window];pf="NA" if x["pf"] is None else f'{x["pf"]:.3f}'
            lines.append(f'| {cname} | {window} | {x["return"]*100:.2f}% | {x["annualized"]*100:.2f}% | {pf} | {x["mdd"]*100:.2f}% |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))
if __name__=="__main__":main()
