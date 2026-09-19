#!/usr/bin/env python3
from __future__ import annotations

import csv, hashlib, io, json, math, os, statistics, sys, time, urllib.parse, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","LINKUSDT","ADAUSDT"]
MONTHS = [f"{y}-{m:02d}" for y,m0,m1 in [(2025,1,12),(2026,1,7)] for m in range(m0,m1+1)]
BASE = "https://data.binance.vision/data/futures/um/monthly/klines"
FUND_BASE = "https://data.binance.vision/data/futures/um/monthly/fundingRate"
OUT = Path("market-prediction-lab/artifacts/frozen-scalp-swing-tournament-v1")
OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent":"investment-platform-public-research/1.0"}
SIDE_COSTS = {"base":0.0008, "stress":0.0012}
LEVERAGES = [1,3,5]

@dataclass
class Bar:
    t:int; o:float; h:float; l:float; c:float; v:float

def get_bytes(url, timeout=45, retries=4):
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

def fetch_month(symbol, month):
    name=f"{symbol}-5m-{month}.zip"
    url=f"{BASE}/{symbol}/5m/{name}"
    data=get_bytes(url)
    chk=get_bytes(url+".CHECKSUM").decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if chk.lower()!=actual.lower():
        raise RuntimeError(f"checksum mismatch {name}")
    z=zipfile.ZipFile(io.BytesIO(data))
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"): continue
        text=io.TextIOWrapper(z.open(member), encoding="utf-8")
        for r in csv.reader(text):
            if not r or not r[0].isdigit(): continue
            try:
                rows.append(Bar(int(r[0]),float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5])))
            except Exception:
                continue
    return month, rows, actual

def load_symbol(symbol):
    parts={}
    checks={}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs={ex.submit(fetch_month,symbol,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,rows,digest=f.result()
            parts[m]=rows; checks[m]=digest
            print(json.dumps({"stage":"download","symbol":symbol,"month":m,"rows":len(rows)}), flush=True)
    all_rows=[]
    for m in MONTHS: all_rows.extend(parts[m])
    ded={x.t:x for x in all_rows}
    bars=[ded[k] for k in sorted(ded)]
    gaps=0
    for a,b in zip(bars,bars[1:]):
        if b.t-a.t != 300000: gaps += 1
    if gaps:
        raise RuntimeError(f"{symbol} 5m gaps={gaps}")
    return bars, checks

def aggregate(bars, ms):
    out=[]; cur=None; source_end=[]
    for i,r in enumerate(bars):
        bucket=(r.t//ms)*ms
        if cur is None or cur.t != bucket:
            if cur is not None:
                out.append(cur); source_end.append(i-1)
            cur=Bar(bucket,r.o,r.h,r.l,r.c,r.v)
        else:
            cur.h=max(cur.h,r.h); cur.l=min(cur.l,r.l); cur.c=r.c; cur.v+=r.v
    if cur is not None:
        out.append(cur); source_end.append(len(bars)-1)
    return out,source_end

def ema(bars,n):
    k=2/(n+1); e=None; out=[]
    for x in bars:
        e=x.c if e is None else e*(1-k)+x.c*k; out.append(e)
    return out

def sma(vals,n):
    out=[]; s=0.0
    for i,x in enumerate(vals):
        s+=x
        if i>=n: s-=vals[i-n]
        out.append(s/n if i>=n-1 else None)
    return out

def atr(bars,n=14):
    tr=[];out=[];s=0.0
    for i,x in enumerate(bars):
        pc=bars[i-1].c if i else x.c
        z=max(x.h-x.l,abs(x.h-pc),abs(x.l-pc))
        tr.append(z);s+=z
        if i>=n:s-=tr[i-n]
        out.append(s/n if i>=n-1 else None)
    return out

def roll_hi_lo(bars,n,i):
    if i<n:return None,None
    seg=bars[i-n:i]
    return max(x.h for x in seg),min(x.l for x in seg)

def linreg(vals):
    n=len(vals); mx=(n-1)/2; my=sum(vals)/n
    den=sum((i-mx)**2 for i in range(n))
    slope=sum((i-mx)*(vals[i]-my) for i in range(n))/den if den else 0
    intercept=my-slope*mx
    return slope,intercept+slope*n

def higher_map(low_len, high_end):
    out=[-1]*low_len;j=0
    for i in range(low_len):
        while j+1<len(high_end) and high_end[j+1] <= i:j+=1
        if high_end and high_end[j] <= i:out[i]=j
    return out

def features(bars):
    return {"atr":atr(bars),"e20":ema(bars,20),"e50":ema(bars,50),"vma":sma([x.v for x in bars],20)}

def rvol(bars,F,i):
    return bars[i].v/F["vma"][i] if F["vma"][i] else 0

def trend(F,j):
    if j<0:return 0
    return 1 if F["e20"][j]>F["e50"][j] else -1 if F["e20"][j]<F["e50"][j] else 0

def sig_triangle_5m(ctx,i):
    b,F=ctx["b5"],ctx["F5"]
    if i<40 or not F["atr"][i]:return None
    n=24; hs=[x.h for x in b[i-n:i]]; ls=[x.l for x in b[i-n:i]]
    sh,up=linreg(hs); sl,dn=linreg(ls)
    old=max(hs)-min(ls)
    if not (sh<0 and sl>0 and up>dn and (up-dn)<old*0.75 and rvol(b,F,i)>=1.4):return None
    side=1 if b[i].c>up else -1 if b[i].c<dn else 0
    j=ctx["m5_60"][i]
    if not side or side!=trend(ctx["F60"],j):return None
    A=F["atr"][i]
    stop=(min(b[i].l,b[i].c-0.15*A) if side>0 else max(b[i].h,b[i].c+0.15*A))
    return {"side":side,"stop":stop,"rr":1.8,"hold":18}

def sig_breakout36_5m(ctx,i):
    b,F=ctx["b5"],ctx["F5"]
    if i<50 or not F["atr"][i]:return None
    hi,lo=roll_hi_lo(b,36,i)
    A=F["atr"][i]; ap=A/b[i].c
    comp=(hi-lo)/b[i].c
    if ap<0.002 or ap>0.02 or comp>0.012 or rvol(b,F,i)<1.3:return None
    side=1 if b[i].c>hi else -1 if b[i].c<lo else 0
    if not side:return None
    stop=min(b[i].l,hi-0.8*A) if side>0 else max(b[i].h,lo+0.8*A)
    return {"side":side,"stop":stop,"rr":2.2,"hold":18}

def sig_vol_exp_short_5m(ctx,i):
    b,F=ctx["b5"],ctx["F5"]
    if i<50 or not F["atr"][i]:return None
    hi,lo=roll_hi_lo(b,36,i)
    A=F["atr"][i]; ap=A/b[i].c
    if not (0.0035<=ap<=0.018) or (hi-lo)/b[i].c>0.012 or rvol(b,F,i)<1.0:return None
    if b[i].c>=lo:return None
    return {"side":-1,"stop":max(b[i].h,lo+0.8*A),"rr":1.8,"hold":18}

def sig_consensus_5m(ctx,i):
    votes=[]
    for f in (sig_triangle_5m,sig_breakout36_5m,sig_vol_exp_short_5m):
        for d in range(0,3):
            if i-d<0:continue
            s=f(ctx,i-d)
            if s:
                votes.append(s["side"]);break
    score=sum(votes)
    side=1 if score>=2 else -1 if score<=-2 else 0
    if not side:return None
    A=ctx["F5"]["atr"][i]
    return {"side":side,"stop":ctx["b5"][i].c-side*1.2*A,"rr":2.0,"hold":18}

def sig_darvas_15m(ctx,i):
    b,F=ctx["b15"],ctx["F15"]
    if i<60 or not F["atr"][i]:return None
    hi,lo=roll_hi_lo(b,48,i); A=F["atr"][i]
    if (hi-lo)/A>5 or rvol(b,F,i)<1.0:return None
    side=1 if b[i].c>hi else -1 if b[i].c<lo else 0
    if not side:return None
    stop=max(lo,b[i].c-A) if side>0 else min(hi,b[i].c+A)
    return {"side":side,"stop":stop,"rr":2.0,"hold":64}

def sig_vcp_15m(ctx,i):
    b,F=ctx["b15"],ctx["F15"]
    n=96
    if i<n or not F["atr"][i] or rvol(b,F,i)<1.3:return None
    q=n//3
    def rg(a,z):
        seg=b[a:z];return max(x.h for x in seg)-min(x.l for x in seg)
    r1,r2,r3=rg(i-n,i-n+q),rg(i-n+q,i-n+2*q),rg(i-n+2*q,i)
    if not (r2<r1*0.8 and r3<r2*0.8):return None
    hi,lo=roll_hi_lo(b,n,i)
    side=1 if b[i].c>hi else -1 if b[i].c<lo else 0
    j=ctx["m15_240"][i]
    if not side or side!=trend(ctx["F240"],j):return None
    A=F["atr"][i]
    return {"side":side,"stop":b[i].c-side*A,"rr":3.0,"hold":64}

def sig_turtle96_15m(ctx,i):
    b,F=ctx["b15"],ctx["F15"]
    if i<110 or not F["atr"][i]:return None
    hi,lo=roll_hi_lo(b,96,i)
    side=1 if b[i].c>hi else -1 if b[i].c<lo else 0
    j=ctx["m15_240"][i]
    if not side or side!=trend(ctx["F240"],j):return None
    A=F["atr"][i]
    return {"side":side,"stop":b[i].c-side*1.5*A,"rr":3.0,"hold":64}

def sig_raschke_15m(ctx,i):
    b,F=ctx["b15"],ctx["F15"]
    if i<80 or not F["atr"][i]:return None
    j=ctx["m15_240"][i]; d=trend(ctx["F240"],j)
    if not d or not ctx["F240"]["atr"][j]:return None
    strength=abs(ctx["F240"]["e20"][j]-ctx["F240"]["e50"][j])/ctx["F240"]["atr"][j]
    A=F["atr"][i]
    if strength<0.25 or abs(b[i].c-F["e20"][i])/A>1.0 or rvol(b,F,i)<1.1:return None
    if d>0 and b[i].c>b[i].o and b[i-1].l<=F["e20"][i]:
        return {"side":1,"stop":min(b[i].l,b[i-1].l)-0.5*A,"rr":2.0,"hold":48}
    if d<0 and b[i].c<b[i].o and b[i-1].h>=F["e20"][i]:
        return {"side":-1,"stop":max(b[i].h,b[i-1].h)+0.5*A,"rr":2.0,"hold":48}
    return None

STRATS = {
 "SCALP_TRIANGLE_RVOL_V1":("5m",sig_triangle_5m),
 "SCALP_BREAKOUT36_V1":("5m",sig_breakout36_5m),
 "SCALP_VOL_EXP_SHORT_V1":("5m",sig_vol_exp_short_5m),
 "SCALP_CONSENSUS_2OF3_V1":("5m",sig_consensus_5m),
 "SWING_DARVAS48_V1":("15m",sig_darvas_15m),
 "SWING_VCP96_V1":("15m",sig_vcp_15m),
 "SWING_TURTLE96_V1":("15m",sig_turtle96_15m),
 "SWING_RASCHKE_PULLBACK_V1":("15m",sig_raschke_15m),
}

def fetch_funding_month(symbol, month):
    name=f"{symbol}-fundingRate-{month}.zip"
    url=f"{FUND_BASE}/{symbol}/{name}"
    data=get_bytes(url, timeout=20, retries=3)
    chk=get_bytes(url+".CHECKSUM", timeout=20, retries=3).decode("utf-8","replace").strip().split()[0]
    actual=hashlib.sha256(data).hexdigest()
    if chk.lower()!=actual.lower():
        raise RuntimeError(f"funding checksum mismatch {name}")
    z=zipfile.ZipFile(io.BytesIO(data))
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"): continue
        text=io.TextIOWrapper(z.open(member), encoding="utf-8")
        reader=csv.DictReader(text)
        for row in reader:
            try:
                ts=int(float(row.get("calc_time") or row.get("fundingTime") or 0))
                rate=float(row.get("last_funding_rate") or row.get("funding_rate") or row.get("fundingRate"))
                if ts>0: rows.append((ts,rate))
            except Exception:
                continue
    return month, rows, actual

def fetch_funding(symbol,start_ms,end_ms):
    parts={}
    checks={}
    try:
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs={ex.submit(fetch_funding_month,symbol,m):m for m in MONTHS}
            for f in as_completed(futs):
                m,rows,digest=f.result()
                parts[m]=rows
                checks[m]=digest
        merged=[]
        for m in MONTHS: merged.extend(parts.get(m,[]))
        ded={ts:rate for ts,rate in merged if start_ms <= ts <= end_ms}
        rows=sorted(ded.items())
        return rows, "BINANCE_VISION_OK"
    except Exception as e:
        return [], f"UNAVAILABLE:{type(e).__name__}"

def funding_cost(funding,side,t0,t1):
    s=sum(rate for ts,rate in funding if t0<ts<=t1)
    return s if side>0 else -s

def simulate(ctx,tf,fn,cost,lev,funding):
    bars=ctx["b5"] if tf=="5m" else ctx["b15"]
    start=120 if tf=="5m" else 110
    eq=1.0; peak=1.0; mdd=0.0; trades=[]; i=start
    while i<len(bars)-2:
        sig=fn(ctx,i)
        if not sig:i+=1;continue
        ei=i+1; entry=bars[ei].o
        risk=entry-sig["stop"] if sig["side"]>0 else sig["stop"]-entry
        if risk<=0 or risk/entry<0.0015 or risk/entry>0.05:i+=1;continue
        tp=entry+sig["side"]*sig["rr"]*risk
        xi=min(ei+sig["hold"]-1,len(bars)-1); exitp=bars[xi].c; reason="TIME"
        for k in range(ei,xi+1):
            x=bars[k]
            if sig["side"]>0:
                sl=x.l<=sig["stop"]; hit=x.h>=tp
                if sl: exitp=sig["stop"];xi=k;reason="SL_FIRST" if hit else "SL";break
                if hit: exitp=tp;xi=k;reason="TP";break
            else:
                sl=x.h>=sig["stop"]; hit=x.l<=tp
                if sl: exitp=sig["stop"];xi=k;reason="SL_FIRST" if hit else "SL";break
                if hit: exitp=tp;xi=k;reason="TP";break
        gross=sig["side"]*(exitp/entry-1)
        fc=funding_cost(funding,sig["side"],bars[ei].t,bars[xi].t)
        net=lev*(gross-2*cost-fc)
        if net<=-0.99: net=-0.99
        eq*=1+net;peak=max(peak,eq);mdd=min(mdd,eq/peak-1)
        trades.append({"entry":bars[ei].t,"exit":bars[xi].t,"side":sig["side"],"gross":gross,"funding":fc,"net":net,"reason":reason})
        i=xi+1
    wins=[x for x in trades if x["net"]>0];loss=[x for x in trades if x["net"]<0]
    gw=sum(x["net"] for x in wins);gl=-sum(x["net"] for x in loss)
    return {"trades":len(trades),"return":eq-1,"mdd":mdd,"pf":gw/gl if gl else None,
            "win_rate":len(wins)/len(trades) if trades else 0,"avg":sum(x["net"] for x in trades)/len(trades) if trades else 0,
            "raw":trades}

def build_ctx(b5):
    b15,e15=aggregate(b5,900000);b60,e60=aggregate(b5,3600000);b240,e240=aggregate(b5,14400000)
    return {"b5":b5,"b15":b15,"b60":b60,"b240":b240,
            "F5":features(b5),"F15":features(b15),"F60":features(b60),"F240":features(b240),
            "m5_60":higher_map(len(b5),e60),"m15_240":higher_map(len(b15),[max(0,x//3) for x in e240])}

def iso(ms): return datetime.fromtimestamp(ms/1000,tz=timezone.utc).isoformat()

def summarize_strategy(per_symbol):
    names=list(per_symbol)
    if not names:return {}
    ret=sum(per_symbol[s]["return"] for s in names)/len(names)
    mdd=sum(per_symbol[s]["mdd"] for s in names)/len(names)
    trades=sum(per_symbol[s]["trades"] for s in names)
    wins=sum(per_symbol[s]["win_rate"]*per_symbol[s]["trades"] for s in names)
    gw=gl=0
    for s in names:
        for t in per_symbol[s]["raw"]:
            if t["net"]>0:gw+=t["net"]
            elif t["net"]<0:gl-=t["net"]
    return {"equal_weight_return":ret,"avg_symbol_mdd":mdd,"trades":trades,
            "pooled_win_rate":wins/trades if trades else 0,"pooled_pf":gw/gl if gl else None,
            "positive_symbols":sum(1 for s in names if per_symbol[s]["return"]>0)}

def main():
    data={}; provenance={}; funding_map={}; funding_status={}
    for sym in SYMBOLS:
        bars,checks=load_symbol(sym)
        data[sym]=build_ctx(bars)
        provenance[sym]={"rows":len(bars),"start":iso(bars[0].t),"end":iso(bars[-1].t),"monthly_sha256":checks}
        fund,status=fetch_funding(sym,bars[0].t,bars[-1].t)
        funding_map[sym]=fund; funding_status[sym]=status
        print(json.dumps({"stage":"funding","symbol":sym,"status":status,"rows":len(fund)}),flush=True)

    results={}
    for sname,(tf,fn) in STRATS.items():
        results[sname]={}
        for cost_name,cost in SIDE_COSTS.items():
            results[sname][cost_name]={}
            for lev in LEVERAGES:
                by={}
                for sym in SYMBOLS:
                    by[sym]=simulate(data[sym],tf,fn,cost,lev,funding_map[sym])
                results[sname][cost_name][str(lev)]={"portfolio":summarize_strategy(by),
                                                       "symbols":{k:{kk:vv for kk,vv in v.items() if kk!="raw"} for k,v in by.items()}}

    payload={"schemaVersion":1,"kind":"frozen-scalp-swing-tournament-v1","research_only":True,
             "live_trading":False,"private_api":False,"orders_submitted":0,
             "symbols":SYMBOLS,"months":MONTHS,"side_costs":SIDE_COSTS,"leverages":LEVERAGES,
             "funding_status":funding_status,"provenance":provenance,"results":results}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")

    lines=["# Frozen Scalp/Swing Tournament V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           f"Symbols: {', '.join(SYMBOLS)}",f"Months: {MONTHS[0]} .. {MONTHS[-1]}","",
           "| Strategy | cost | lev | trades | equal-weight return | pooled PF | positive symbols | avg symbol MDD |",
           "|---|---|---:|---:|---:|---:|---:|---:|"]
    for sname in STRATS:
        for cost_name in SIDE_COSTS:
            for lev in LEVERAGES:
                p=results[sname][cost_name][str(lev)]["portfolio"]
                pf="NA" if p["pooled_pf"] is None else f'{p["pooled_pf"]:.3f}'
                lines.append(f'| {sname} | {cost_name} | {lev}x | {p["trades"]} | {p["equal_weight_return"]*100:.2f}% | {pf} | {p["positive_symbols"]}/{len(SYMBOLS)} | {p["avg_symbol_mdd"]*100:.2f}% |')
    lines+=["","Funding status: "+json.dumps(funding_status,ensure_ascii=False),
            "","Notes: equal-weight return is the arithmetic mean of independent per-symbol compounded equities; it is not a concurrency-aware portfolio backtest. 3x/5x scale notional returns and costs and do not model intrabar liquidation or maintenance margin."]
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":
    main()
