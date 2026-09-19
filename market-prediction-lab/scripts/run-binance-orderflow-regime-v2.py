#!/usr/bin/env python3
from __future__ import annotations
import csv, hashlib, io, json, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","LINKUSDT","ADAUSDT"]
MONTHS=[f"{y}-{m:02d}" for y,m0,m1 in [(2025,1,12),(2026,1,7)] for m in range(m0,m1+1)]
KBASE="https://data.binance.vision/data/futures/um/monthly/klines"
FBASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
OUT=Path("market-prediction-lab/artifacts/binance-orderflow-regime-v2"); OUT.mkdir(parents=True,exist_ok=True)
UA={"User-Agent":"investment-platform-public-research/1.0"}
COSTS={"base":0.0008,"stress":0.0012}
FLOW_THRESHOLD=-0.05

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
            if n<retries: time.sleep(1.0*(2**n))
    raise RuntimeError(f"download failed {url}: {err}")

def checked(url,name):
    data=get_bytes(url)
    chk=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if chk.lower()!=actual.lower(): raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(data)),actual

def fetch_kline_month(sym,month):
    name=f"{sym}-5m-{month}.zip"
    z,digest=checked(f"{KBASE}/{sym}/5m/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"): continue
        for r in csv.reader(io.TextIOWrapper(z.open(member),encoding="utf-8")):
            if not r or not r[0].isdigit(): continue
            try:
                ts=int(r[0])
                if ts>100_000_000_000_000: ts//=1000
                rows.append(Bar(ts,float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5]),float(r[9])))
            except Exception: pass
    return month,rows,digest

def fetch_funding_month(sym,month):
    name=f"{sym}-fundingRate-{month}.zip"
    z,digest=checked(f"{FBASE}/{sym}/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"): continue
        rd=csv.DictReader(io.TextIOWrapper(z.open(member),encoding="utf-8"))
        for row in rd:
            try:
                ts=int(float(row.get("calc_time") or row.get("fundingTime") or 0))
                if ts>100_000_000_000_000: ts//=1000
                rate=float(row.get("last_funding_rate") or row.get("funding_rate") or row.get("fundingRate"))
                if ts>0: rows.append((ts,rate))
            except Exception: pass
    return month,rows,digest

def load(sym):
    parts={};kchecks={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_kline_month,sym,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,rows,d=f.result(); parts[m]=rows; kchecks[m]=d
    merged=[]
    for m in MONTHS: merged.extend(parts[m])
    ded={x.t:x for x in merged}; bars=[ded[k] for k in sorted(ded)]
    if any(b.t-a.t!=300000 for a,b in zip(bars,bars[1:])): raise RuntimeError(f"{sym} 5m gap")
    fparts={};fchecks={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_funding_month,sym,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,rows,d=f.result(); fparts[m]=rows; fchecks[m]=d
    fm=[]
    for m in MONTHS: fm.extend(fparts[m])
    funding=sorted({ts:r for ts,r in fm}.items())
    if not funding: raise RuntimeError(f"{sym} funding empty")
    return bars,funding,kchecks,fchecks

def ema(vals,n):
    k=2/(n+1); e=None; out=[]
    for x in vals:
        e=x if e is None else e*(1-k)+x*k
        out.append(e)
    return out

def sma(vals,n):
    out=[];s=0.0
    for i,x in enumerate(vals):
        s+=x
        if i>=n:s-=vals[i-n]
        out.append(s/n if i>=n-1 else None)
    return out

def atr(bars,n=14):
    vals=[]
    for i,b in enumerate(bars):
        pc=bars[i-1].c if i else b.c
        vals.append(max(b.h-b.l,abs(b.h-pc),abs(b.l-pc)))
    return sma(vals,n)

def flow_ratio(bars,i,n=12):
    if i<n-1:return None
    seg=bars[i-n+1:i+1]
    vol=sum(b.v for b in seg)
    if vol<=0:return None
    return sum(2*b.tb-b.v for b in seg)/vol

def roll_hilo(bars,n,i):
    if i<n:return None,None
    seg=bars[i-n:i]
    return max(x.h for x in seg),min(x.l for x in seg)

def fund_cost(funding,side,t0,t1):
    raw=sum(r for ts,r in funding if t0<ts<=t1)
    return raw if side>0 else -raw

def make_features(bars):
    closes=[b.c for b in bars]
    return {
        "atr":atr(bars,14),
        "vma":sma([b.v for b in bars],20),
        "ema_fast":ema(closes,960),
        "ema_slow":ema(closes,2400),
    }

def local_down(bars,F,i):
    return i>=2400 and bars[i].c<F["ema_fast"][i] and F["ema_fast"][i]<F["ema_slow"][i]

def base_signal(bars,F,i):
    if i<50 or F["atr"][i] is None or F["vma"][i] is None:return None
    hi,lo=roll_hilo(bars,36,i)
    A=F["atr"][i]
    ap=A/bars[i].c
    rv=bars[i].v/F["vma"][i] if F["vma"][i] else 0
    fl=flow_ratio(bars,i,12)
    if not(0.0035<=ap<=0.018):return None
    if (hi-lo)/bars[i].c>0.012 or rv<1.0 or bars[i].c>=lo:return None
    if fl is None or fl>FLOW_THRESHOLD:return None
    return {"side":-1,"stop":max(bars[i].h,lo+0.8*A),"rr":1.8,"hold":18,"flow":fl}

REGIMES=["NONE","LOCAL_4H_DOWN","BTC_4H_DOWN","DUAL_4H_DOWN"]

def allowed(regime,bars,F,i,btc_bars,btcF):
    if regime=="NONE": return True
    l=local_down(bars,F,i)
    b=local_down(btc_bars,btcF,i)
    if regime=="LOCAL_4H_DOWN":return l
    if regime=="BTC_4H_DOWN":return b
    if regime=="DUAL_4H_DOWN":return l and b
    return False

def simulate(bars,funding,F,btc_bars,btcF,regime,cost,start,end):
    eq=1.0;peak=1.0;mdd=0.0;trades=[];i=max(start,2400)
    while i<min(end,len(bars)-2):
        s=base_signal(bars,F,i)
        if not s or not allowed(regime,bars,F,i,btc_bars,btcF):
            i+=1;continue
        ei=i+1; entry=bars[ei].o
        risk=s["stop"]-entry
        if risk<=0 or risk/entry<0.001 or risk/entry>0.05:
            i+=1;continue
        tp=entry-s["rr"]*risk
        xi=min(ei+s["hold"]-1,end-1,len(bars)-1); exitp=bars[xi].c
        for k in range(ei,xi+1):
            x=bars[k]
            if x.h>=s["stop"]:
                exitp=s["stop"];xi=k;break
            if x.l<=tp:
                exitp=tp;xi=k;break
        gross=-(exitp/entry-1)
        fc=fund_cost(funding,-1,bars[ei].t,bars[xi].t)
        net=gross-2*cost-fc
        eq*=max(0.01,1+net); peak=max(peak,eq); mdd=min(mdd,eq/peak-1)
        trades.append(net)
        i=xi+1
    wins=[x for x in trades if x>0];loss=[x for x in trades if x<0]
    gp=sum(wins);gl=-sum(loss)
    return {"trades":len(trades),"return":eq-1,"mdd":mdd,"pf":gp/gl if gl else None,
            "win_rate":len(wins)/len(trades) if trades else 0,
            "gross_profit":gp,"gross_loss":gl}

def aggregate(by):
    rets=[x["return"] for x in by.values()]
    gp=sum(x["gross_profit"] for x in by.values());gl=sum(x["gross_loss"] for x in by.values())
    return {"equal_weight_return":sum(rets)/len(rets),"trades":sum(x["trades"] for x in by.values()),
            "positive_symbols":sum(r>0 for r in rets),"avg_mdd":sum(x["mdd"] for x in by.values())/len(by),
            "pooled_pf":gp/gl if gl else None}

def gate(p,min_trades=25):
    return p["trades"]>=min_trades and p["equal_weight_return"]>0 and (p["pooled_pf"] or 0)>1 and p["positive_symbols"]>=4

def main():
    data={};prov={}
    for sym in SYMBOLS:
        bars,funding,kc,fc=load(sym);F=make_features(bars)
        data[sym]=(bars,funding,F)
        prov[sym]={"bars":len(bars),"funding_rows":len(funding),"funding_status":"BINANCE_VISION_OK","kline_sha256":kc,"funding_sha256":fc}
        print(json.dumps({"loaded":sym,"bars":len(bars)}),flush=True)
    btc_bars,_,btcF=data["BTCUSDT"]
    n=len(btc_bars); design_end=int(n*0.50); validation_end=int(n*0.75)
    segments={"design":(0,design_end),"validation":(design_end,validation_end),"test":(validation_end,n)}
    results={}
    for regime in REGIMES:
        results[regime]={}
        for cname,cost in COSTS.items():
            segs={}
            for seg,(a,b) in segments.items():
                by={sym:simulate(*data[sym],btc_bars,btcF,regime,cost,a,b) for sym in SYMBOLS}
                segs[seg]={"portfolio":aggregate(by),"symbols":by}
            results[regime][cname]=segs
    verdict={}
    for regime in REGIMES:
        v=results[regime]["base"]["validation"]["portfolio"]
        t=results[regime]["base"]["test"]["portfolio"]
        ts=results[regime]["stress"]["test"]["portfolio"]
        verdict[regime]={"validation_pass":gate(v),"test_pass":gate(t),"stress_test_pass":gate(ts,20)}
    payload={"schemaVersion":1,"kind":"binance-orderflow-regime-v2","research_only":True,"public_data_only":True,
             "live_trading":False,"private_api":False,"orders_submitted":0,"leverage":1,"lookahead_free":True,
             "formula":{"base":"VOL_EXP_SHORT + 12-bar taker sell flow <= -0.05",
                        "regimes":{"NONE":"no trend filter","LOCAL_4H_DOWN":"local EMA960 < EMA2400 and price < EMA960",
                                   "BTC_4H_DOWN":"BTC EMA960 < EMA2400 and BTC price < EMA960",
                                   "DUAL_4H_DOWN":"local and BTC conditions both true"},
                        "split":"chronological 50% design / 25% validation / 25% untouched test"},
             "costs":COSTS,"segments":segments,"symbols":SYMBOLS,"provenance":prov,"results":results,"verdict":verdict}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# Binance Order Flow Regime V2","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Regime | Cost | Segment | Trades | EW return | PF | Positive | Avg MDD |",
           "|---|---|---|---:|---:|---:|---:|---:|"]
    for regime in REGIMES:
        for cname in COSTS:
            for seg in segments:
                p=results[regime][cname][seg]["portfolio"]
                pf="NA" if p["pooled_pf"] is None else f'{p["pooled_pf"]:.3f}'
                lines.append(f'| {regime} | {cname} | {seg} | {p["trades"]} | {p["equal_weight_return"]*100:.2f}% | {pf} | {p["positive_symbols"]}/8 | {p["avg_mdd"]*100:.2f}% |')
    lines+=["","## Verdict",json.dumps(verdict,indent=2)]
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":main()
