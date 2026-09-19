#!/usr/bin/env python3
from __future__ import annotations
import csv, hashlib, io, json, math, statistics, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","LINKUSDT","ADAUSDT"]
MONTHS=[f"{y}-{m:02d}" for y,m0,m1 in [(2025,1,12),(2026,1,7)] for m in range(m0,m1+1)]
KBASE="https://data.binance.vision/data/futures/um/monthly/klines"
FBASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
OUT=Path("market-prediction-lab/artifacts/binance-orderflow-v1"); OUT.mkdir(parents=True,exist_ok=True)
UA={"User-Agent":"investment-platform-public-research/1.0"}
COSTS={"base":0.0008,"stress":0.0012}

@dataclass
class Bar:
    t:int; o:float; h:float; l:float; c:float; v:float; tb:float

def get_bytes(url,timeout=45,retries=4):
    err=None
    for n in range(retries+1):
        try:
            req=urllib.request.Request(url,headers=UA)
            with urllib.request.urlopen(req,timeout=timeout) as r:return r.read()
        except Exception as e:
            err=e
            if n<retries:time.sleep(1.0*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

def checked(url,name):
    data=get_bytes(url); chk=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if chk.lower()!=actual.lower():raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(data)),actual

def fetch_kline_month(sym,month):
    name=f"{sym}-5m-{month}.zip"; z,digest=checked(f"{KBASE}/{sym}/5m/{name}",name); rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):continue
        text=io.TextIOWrapper(z.open(member),encoding="utf-8")
        for r in csv.reader(text):
            if not r or not r[0].isdigit():continue
            try:
                ts=int(r[0])
                if ts>100_000_000_000_000:ts//=1000
                rows.append(Bar(ts,float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5]),float(r[9])))
            except Exception:pass
    return month,rows,digest

def fetch_funding_month(sym,month):
    name=f"{sym}-fundingRate-{month}.zip"; z,digest=checked(f"{FBASE}/{sym}/{name}",name); rows=[]
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
    return month,rows,digest

def load(sym):
    parts={};checks={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_kline_month,sym,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,rows,d=f.result();parts[m]=rows;checks[m]=d
    merged=[]
    for m in MONTHS:merged.extend(parts[m])
    ded={x.t:x for x in merged}; bars=[ded[k] for k in sorted(ded)]
    if any(b.t-a.t!=300000 for a,b in zip(bars,bars[1:])):raise RuntimeError(f"{sym} 5m gap")
    fparts={};fchecks={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_funding_month,sym,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,rows,d=f.result();fparts[m]=rows;fchecks[m]=d
    fm=[]
    for m in MONTHS:fm.extend(fparts[m])
    funding=sorted({ts:r for ts,r in fm}.items())
    if not funding:raise RuntimeError(f"{sym} funding empty")
    return bars,funding,checks,fchecks

def ema(bars,n):
    k=2/(n+1);e=None;out=[]
    for b in bars:
        e=b.c if e is None else e*(1-k)+b.c*k;out.append(e)
    return out

def sma(vals,n):
    out=[];s=0
    for i,x in enumerate(vals):
        s+=x
        if i>=n:s-=vals[i-n]
        out.append(s/n if i>=n-1 else None)
    return out

def atr(bars,n=14):
    out=[];q=[];s=0
    for i,b in enumerate(bars):
        pc=bars[i-1].c if i else b.c
        tr=max(b.h-b.l,abs(b.h-pc),abs(b.l-pc));q.append(tr);s+=tr
        if i>=n:s-=q[i-n]
        out.append(s/n if i>=n-1 else None)
    return out

def flow_ratio(bars,i,n=12):
    if i<n-1:return None
    seg=bars[i-n+1:i+1];vol=sum(b.v for b in seg)
    if vol<=0:return None
    signed=sum(2*b.tb-b.v for b in seg)
    return signed/vol

def roll_hilo(bars,n,i):
    if i<n:return None,None
    seg=bars[i-n:i];return max(x.h for x in seg),min(x.l for x in seg)

def fund_cost(funding,side,t0,t1):
    s=sum(r for ts,r in funding if t0<ts<=t1)
    return s if side>0 else -s

def features(bars):
    return {"e20":ema(bars,20),"e50":ema(bars,50),"atr":atr(bars,14),"vma":sma([b.v for b in bars],20)}

def sig_vol_base(b,F,i,flow_confirm=False):
    if i<50 or not F["atr"][i] or not F["vma"][i]:return None
    hi,lo=roll_hilo(b,36,i);A=F["atr"][i]; ap=A/b[i].c
    rv=b[i].v/F["vma"][i] if F["vma"][i] else 0
    if not(0.0035<=ap<=0.018) or (hi-lo)/b[i].c>0.012 or rv<1.0 or b[i].c>=lo:return None
    fl=flow_ratio(b,i,12)
    if flow_confirm and (fl is None or fl>-0.05):return None
    return {"side":-1,"stop":max(b[i].h,lo+0.8*A),"rr":1.8,"hold":18,"flow":fl}

def sig_flow_trend(b,F,i):
    if i<60 or not F["atr"][i] or not F["vma"][i]:return None
    fl=flow_ratio(b,i,12)
    if fl is None:return None
    rv=b[i].v/F["vma"][i]
    A=F["atr"][i]
    if rv<1.0:return None
    if F["e20"][i]>F["e50"][i] and b[i].c>F["e20"][i] and fl>=0.08:
        return {"side":1,"stop":b[i].c-1.2*A,"rr":1.8,"hold":18,"flow":fl}
    if F["e20"][i]<F["e50"][i] and b[i].c<F["e20"][i] and fl<=-0.08:
        return {"side":-1,"stop":b[i].c+1.2*A,"rr":1.8,"hold":18,"flow":fl}
    return None

STRATS={
 "VOL_EXP_SHORT_BASELINE":lambda b,F,i:sig_vol_base(b,F,i,False),
 "VOL_EXP_SHORT_FLOW_CONFIRM":lambda b,F,i:sig_vol_base(b,F,i,True),
 "FLOW_TREND_SYMMETRIC":sig_flow_trend,
}

def simulate(bars,funding,F,fn,cost):
    eq=1.;peak=1.;mdd=0.;trades=[];i=60
    while i<len(bars)-2:
        s=fn(bars,F,i)
        if not s:i+=1;continue
        ei=i+1;entry=bars[ei].o
        risk=entry-s["stop"] if s["side"]>0 else s["stop"]-entry
        if risk<=0 or risk/entry<0.001 or risk/entry>0.05:i+=1;continue
        tp=entry+s["side"]*s["rr"]*risk
        xi=min(ei+s["hold"]-1,len(bars)-1);exitp=bars[xi].c;reason="TIME"
        for k in range(ei,xi+1):
            x=bars[k]
            if s["side"]>0:
                sl=x.l<=s["stop"];hit=x.h>=tp
                if sl:exitp=s["stop"];xi=k;reason="SL";break
                if hit:exitp=tp;xi=k;reason="TP";break
            else:
                sl=x.h>=s["stop"];hit=x.l<=tp
                if sl:exitp=s["stop"];xi=k;reason="SL";break
                if hit:exitp=tp;xi=k;reason="TP";break
        gross=s["side"]*(exitp/entry-1);fc=fund_cost(funding,s["side"],bars[ei].t,bars[xi].t)
        net=gross-2*cost-fc
        eq*=max(0.01,1+net);peak=max(peak,eq);mdd=min(mdd,eq/peak-1)
        trades.append({"net":net,"gross":gross,"funding":fc,"side":s["side"],"flow":s.get("flow"),"reason":reason})
        i=xi+1
    wins=[t for t in trades if t["net"]>0];loss=[t for t in trades if t["net"]<0]
    gp=sum(t["net"] for t in wins);gl=-sum(t["net"] for t in loss)
    return {"trades":len(trades),"return":eq-1,"mdd":mdd,"pf":gp/gl if gl else None,
            "win_rate":len(wins)/len(trades) if trades else 0,
            "avg_net":sum(t["net"] for t in trades)/len(trades) if trades else 0,
            "funding_sum":sum(t["funding"] for t in trades)}

def portfolio(by):
    syms=list(by);rets=[by[s]["return"] for s in syms];mdds=[by[s]["mdd"] for s in syms]
    # pooled PF from approximate per-symbol avg/trade is unavailable; weighted by direct PF not valid, report median PF.
    pfs=[by[s]["pf"] for s in syms if by[s]["pf"] is not None]
    return {"equal_weight_return":sum(rets)/len(rets),"avg_mdd":sum(mdds)/len(mdds),
            "trades":sum(by[s]["trades"] for s in syms),"positive_symbols":sum(r>0 for r in rets),
            "median_symbol_pf":statistics.median(pfs) if pfs else None}

def main():
    data={};prov={}
    for sym in SYMBOLS:
        bars,funding,kchk,fchk=load(sym);data[sym]=(bars,funding,features(bars))
        prov[sym]={"bars":len(bars),"funding_rows":len(funding),"funding_status":"BINANCE_VISION_OK",
                   "kline_sha256":kchk,"funding_sha256":fchk}
        print(json.dumps({"loaded":sym,"bars":len(bars),"funding":len(funding)}),flush=True)
    results={}
    for name,fn in STRATS.items():
        results[name]={}
        for cname,cost in COSTS.items():
            by={s:simulate(*data[s],fn,cost) for s in SYMBOLS}
            results[name][cname]={"portfolio":portfolio(by),"symbols":by}
    payload={"schemaVersion":1,"kind":"binance-orderflow-v1","research_only":True,"public_data_only":True,
             "live_trading":False,"private_api":False,"orders_submitted":0,"leverage":1,
             "formula":{"flow":"12-bar signed taker flow = sum(2*taker_buy_volume-total_volume)/sum(total_volume)",
                        "variants":["VOL_EXP_SHORT_BASELINE","VOL_EXP_SHORT_FLOW_CONFIRM","FLOW_TREND_SYMMETRIC"]},
             "symbols":SYMBOLS,"months":MONTHS,"costs":COSTS,"provenance":prov,"results":results}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# Binance Order Flow V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Strategy | Cost | Trades | EW return | Positive | Avg MDD | Median symbol PF |",
           "|---|---|---:|---:|---:|---:|---:|"]
    for name in STRATS:
        for cname in COSTS:
            p=results[name][cname]["portfolio"];pf="NA" if p["median_symbol_pf"] is None else f'{p["median_symbol_pf"]:.3f}'
            lines.append(f'| {name} | {cname} | {p["trades"]} | {p["equal_weight_return"]*100:.2f}% | {p["positive_symbols"]}/8 | {p["avg_mdd"]*100:.2f}% | {pf} |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":main()
