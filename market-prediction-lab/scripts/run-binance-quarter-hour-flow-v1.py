#!/usr/bin/env python3
from __future__ import annotations
import bisect, csv, hashlib, io, json, time, urllib.request, zipfile
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SYMBOLS=["BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT","DOGEUSDT","ADAUSDT"]
MONTHS=[f"{y}-{m:02d}" for y,m0,m1 in [(2025,1,12),(2026,1,8)] for m in range(m0,m1+1)]
KBASE="https://data.binance.vision/data/futures/um/monthly/klines"
FBASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
OUT=Path("market-prediction-lab/artifacts/binance-quarter-hour-flow-v1"); OUT.mkdir(parents=True,exist_ok=True)
UA={"User-Agent":"investment-platform-public-research/1.0"}
COSTS={"base":0.0008,"stress":0.0012}
HORIZONS={"H4":48,"H8":96,"H12":144}
ROLL_BOUNDARIES=30*24*4

@dataclass
class Bar:
    t:int; o:float; c:float; v:float; tb:float

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
    if chk.lower()!=actual.lower():raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(data)),actual

def fetch_kline_month(sym,month):
    name=f"{sym}-5m-{month}.zip"; z,d=checked(f"{KBASE}/{sym}/5m/{name}",name);rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):continue
        for r in csv.reader(io.TextIOWrapper(z.open(member),encoding="utf-8")):
            if not r or not r[0].isdigit():continue
            try:
                ts=int(r[0])
                if ts>100_000_000_000_000:ts//=1000
                rows.append(Bar(ts,float(r[1]),float(r[4]),float(r[5]),float(r[9])))
            except Exception:pass
    return month,rows,d

def fetch_funding_month(sym,month):
    name=f"{sym}-fundingRate-{month}.zip";z,d=checked(f"{FBASE}/{sym}/{name}",name);rows=[]
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
    return month,rows,d

def load(sym):
    parts={};kc={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_kline_month,sym,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,r,d=f.result();parts[m]=r;kc[m]=d
    merged=[]
    for m in MONTHS:merged.extend(parts[m])
    ded={x.t:x for x in merged};bars=[ded[k] for k in sorted(ded)]
    if any(b.t-a.t!=300000 for a,b in zip(bars,bars[1:])):raise RuntimeError(f"{sym} gap")
    fp={};fc={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_funding_month,sym,m):m for m in MONTHS}
        for f in as_completed(futs):
            m,r,d=f.result();fp[m]=r;fc[m]=d
    rr=[]
    for m in MONTHS:rr.extend(fp[m])
    funding=sorted({t:r for t,r in rr}.items())
    return bars,funding,kc,fc

def flow(b):
    return (2*b.tb-b.v)/b.v if b.v>0 else 0.0

def boundary(b):
    dt=datetime.fromtimestamp(b.t/1000,tz=timezone.utc)
    return dt.minute in (0,15,30,45)

def rolling_q80(bars):
    out={};dq=deque();sorted_vals=[]
    for i,b in enumerate(bars):
        if not boundary(b):continue
        if len(dq)>=200:
            pos=int(0.80*(len(sorted_vals)-1))
            out[i]=sorted_vals[pos]
        val=abs(flow(b));bisect.insort(sorted_vals,val);dq.append(val)
        if len(dq)>ROLL_BOUNDARIES:
            old=dq.popleft();j=bisect.bisect_left(sorted_vals,old);sorted_vals.pop(j)
    return out

def fund(funding,side,t0,t1):
    raw=sum(r for t,r in funding if t0<t<=t1)
    return raw if side>0 else -raw

def eligible_time(bar,hours):
    dt=datetime.fromtimestamp(bar.t/1000,tz=timezone.utc)
    return dt.minute==0 and dt.hour%hours==0

def simulate(bars,funding,q80,hours,hold,mode,cost,start,end):
    eq=1.0;peak=1.0;mdd=0.0;rets=[];i=max(start,200)
    while i<min(end-hold-2,len(bars)-hold-2):
        if not eligible_time(bars[i],hours):
            i+=1;continue
        f=flow(bars[i])
        if mode=="EXTREME80":
            th=q80.get(i)
            if th is None or abs(f)<th:
                i+=1;continue
        side=1 if f>0 else -1 if f<0 else 0
        if side==0:
            i+=1;continue
        ei=i+1;xi=ei+hold
        entry=bars[ei].o;exitp=bars[xi].o
        gross=side*(exitp/entry-1)
        net=gross-2*cost-fund(funding,side,bars[ei].t,bars[xi].t)
        eq*=max(0.01,1+net);peak=max(peak,eq);mdd=min(mdd,eq/peak-1);rets.append(net)
        i=xi
    wins=[x for x in rets if x>0];loss=[x for x in rets if x<0]
    gp=sum(wins);gl=-sum(loss)
    return {"trades":len(rets),"return":eq-1,"mdd":mdd,"pf":gp/gl if gl else None,
            "win_rate":len(wins)/len(rets) if rets else 0,"gross_profit":gp,"gross_loss":gl}

def aggregate(by):
    gp=sum(x["gross_profit"] for x in by.values());gl=sum(x["gross_loss"] for x in by.values())
    rs=[x["return"] for x in by.values()]
    return {"trades":sum(x["trades"] for x in by.values()),"equal_weight_return":sum(rs)/len(rs),
            "positive_symbols":sum(r>0 for r in rs),"avg_mdd":sum(x["mdd"] for x in by.values())/len(by),
            "pooled_pf":gp/gl if gl else None}

def main():
    data={};prov={}
    for sym in SYMBOLS:
        bars,fr,kc,fc=load(sym);data[sym]=(bars,fr,rolling_q80(bars))
        prov[sym]={"bars":len(bars),"funding_rows":len(fr),"funding_status":"BINANCE_VISION_OK","kline_sha256":kc,"funding_sha256":fc}
        print(json.dumps({"loaded":sym,"bars":len(bars)}),flush=True)
    n=len(data["BTCUSDT"][0]);d=int(n*.5);v=int(n*.75)
    segments={"design":(0,d),"validation":(d,v),"test":(v,n)}
    results={}
    for hname,hold in HORIZONS.items():
        hours=hold//12
        for mode in ("ALL_SIGN","EXTREME80"):
            key=f"{hname}_{mode}";results[key]={}
            for cname,cost in COSTS.items():
                results[key][cname]={}
                for seg,(a,b) in segments.items():
                    by={s:simulate(*data[s],hours,hold,mode,cost,a,b) for s in SYMBOLS}
                    results[key][cname][seg]={"portfolio":aggregate(by),"symbols":by}
    payload={"schemaVersion":1,"kind":"binance-quarter-hour-flow-v1","research_only":True,"public_data_only":True,
             "live_trading":False,"private_api":False,"orders_submitted":0,"leverage":1,"lookahead_free":True,
             "approximation_note":"Uses the first 5-minute Binance kline at fixed UTC boundaries, not the paper's first 10-second trade window.",
             "formula":{"flow":"(2*taker_buy_volume-total_volume)/total_volume on completed boundary bar",
                        "entry":"next 5-minute open","horizons_hours":[4,8,12],
                        "ALL_SIGN":"trade sign of flow at non-overlapping boundary",
                        "EXTREME80":"same only when absolute flow exceeds rolling prior-30d 80th percentile of quarter-hour boundary flows",
                        "split":"chronological 50/25/25"},
             "symbols":SYMBOLS,"costs":COSTS,"segments":segments,"provenance":prov,"results":results}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# Binance Quarter-Hour Flow V1","","COARSE 5-MINUTE REPLICATION / RESEARCH ONLY / NO ORDERS","",
           "| Strategy | Cost | Segment | Trades | EW return | PF | Positive | MDD |",
           "|---|---|---|---:|---:|---:|---:|---:|"]
    for key in results:
        for cname in COSTS:
            for seg in segments:
                p=results[key][cname][seg]["portfolio"];pf="NA" if p["pooled_pf"] is None else f'{p["pooled_pf"]:.3f}'
                lines.append(f'| {key} | {cname} | {seg} | {p["trades"]} | {p["equal_weight_return"]*100:.2f}% | {pf} | {p["positive_symbols"]}/6 | {p["avg_mdd"]*100:.2f}% |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8");print("\n".join(lines))

if __name__=="__main__":main()
