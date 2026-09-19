#!/usr/bin/env python3
from __future__ import annotations
import csv, hashlib, io, json, math, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","LINKUSDT","ADAUSDT"]
WINDOWS={
  "BACKWARD_OOS_2024":[f"2024-{m:02d}" for m in range(1,13)],
  "FUTURE_OOS_2026_08":["2026-08"],
}
KBASE="https://data.binance.vision/data/futures/um/monthly/klines"
FBASE="https://data.binance.vision/data/futures/um/monthly/fundingRate"
OUT=Path("market-prediction-lab/artifacts/vol-exp-flow-frozen-oos-v1"); OUT.mkdir(parents=True,exist_ok=True)
UA={"User-Agent":"investment-platform-public-research/1.0"}
COSTS={"base":0.0008,"stress":0.0012}

@dataclass
class Bar:
    t:int;o:float;h:float;l:float;c:float;v:float;tb:float

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

def fetch_k(sym,month):
    name=f"{sym}-5m-{month}.zip";z,d=checked(f"{KBASE}/{sym}/5m/{name}",name);rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):continue
        rd=csv.reader(io.TextIOWrapper(z.open(member),encoding="utf-8"))
        for r in rd:
            if not r or not r[0].isdigit():continue
            try:
                ts=int(r[0]);ts=ts//1000 if ts>100_000_000_000_000 else ts
                rows.append(Bar(ts,float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5]),float(r[9])))
            except Exception:pass
    return month,rows,d

def fetch_f(sym,month):
    name=f"{sym}-fundingRate-{month}.zip";z,d=checked(f"{FBASE}/{sym}/{name}",name);rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):continue
        rd=csv.DictReader(io.TextIOWrapper(z.open(member),encoding="utf-8"))
        for row in rd:
            try:
                ts=int(float(row.get("calc_time") or row.get("fundingTime") or 0));ts=ts//1000 if ts>100_000_000_000_000 else ts
                rate=float(row.get("last_funding_rate") or row.get("funding_rate") or row.get("fundingRate"))
                if ts>0:rows.append((ts,rate))
            except Exception:pass
    return month,rows,d

def load(sym,months):
    kp={};kc={};fp={};fc={}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs={ex.submit(fetch_k,sym,m):("k",m) for m in months}
        futs.update({ex.submit(fetch_f,sym,m):("f",m) for m in months})
        for f in as_completed(futs):
            kind,m=futs[f];month,rows,d=f.result()
            if kind=="k":kp[m]=rows;kc[m]=d
            else:fp[m]=rows;fc[m]=d
    bars=[]
    for m in months:bars.extend(kp[m])
    bars=sorted({x.t:x for x in bars}.values(),key=lambda x:x.t)
    funding=[]
    for m in months:funding.extend(fp[m])
    funding=sorted({ts:r for ts,r in funding}.items())
    if not bars or not funding:raise RuntimeError(f"{sym} missing data")
    return bars,funding,kc,fc

def sma(vals,n):
    out=[];s=0.
    for i,x in enumerate(vals):
        s+=x
        if i>=n:s-=vals[i-n]
        out.append(s/n if i>=n-1 else None)
    return out

def atr(b,n=14):
    out=[];q=[];s=0.
    for i,x in enumerate(b):
        pc=b[i-1].c if i else x.c;tr=max(x.h-x.l,abs(x.h-pc),abs(x.l-pc));q.append(tr);s+=tr
        if i>=n:s-=q[i-n]
        out.append(s/n if i>=n-1 else None)
    return out

def flow(b,i,n=12):
    if i<n-1:return None
    seg=b[i-n+1:i+1];v=sum(x.v for x in seg)
    return sum(2*x.tb-x.v for x in seg)/v if v>0 else None

def fund(funding,t0,t1):
    # frozen strategy is short only: positive funding is income => subtracting short cost means -sum(rate)
    return -sum(r for ts,r in funding if t0<ts<=t1)

def simulate(b,funding,cost,flow_confirm):
    A=atr(b,14);V=sma([x.v for x in b],20)
    eq=1.;peak=1.;mdd=0.;tr=[];i=50
    while i<len(b)-2:
        if A[i] is None or V[i] is None:i+=1;continue
        seg=b[i-36:i]
        if len(seg)<36:i+=1;continue
        hi=max(x.h for x in seg);lo=min(x.l for x in seg)
        ap=A[i]/b[i].c;rv=b[i].v/V[i] if V[i] else 0
        fl=flow(b,i,12)
        ok=(0.0035<=ap<=0.018 and (hi-lo)/b[i].c<=0.012 and rv>=1.0 and b[i].c<lo)
        if flow_confirm:ok=ok and fl is not None and fl<=-0.05
        if not ok:i+=1;continue
        ei=i+1;entry=b[ei].o;stop=max(b[i].h,lo+0.8*A[i]);risk=stop-entry
        if risk<=0 or risk/entry<0.001 or risk/entry>0.05:i+=1;continue
        tp=entry-1.8*risk;xi=min(ei+17,len(b)-1);exitp=b[xi].c;reason="TIME"
        for k in range(ei,xi+1):
            x=b[k]
            if x.h>=stop:exitp=stop;xi=k;reason="SL";break
            if x.l<=tp:exitp=tp;xi=k;reason="TP";break
        gross=-(exitp/entry-1);fc=fund(funding,b[ei].t,b[xi].t);net=gross-2*cost-fc
        eq*=max(0.01,1+net);peak=max(peak,eq);mdd=min(mdd,eq/peak-1)
        tr.append(net);i=xi+1
    wins=[x for x in tr if x>0];loss=[x for x in tr if x<0]
    gp=sum(wins);gl=-sum(loss)
    return {"trades":len(tr),"return":eq-1,"mdd":mdd,"pf":gp/gl if gl else None,
            "win_rate":len(wins)/len(tr) if tr else 0,"avg_net":sum(tr)/len(tr) if tr else 0}

def port(by):
    vals=list(by.values());pfs=[x["pf"] for x in vals if x["pf"] is not None]
    return {"trades":sum(x["trades"] for x in vals),"equal_weight_return":sum(x["return"] for x in vals)/len(vals),
            "positive_symbols":sum(x["return"]>0 for x in vals),"avg_mdd":sum(x["mdd"] for x in vals)/len(vals),
            "median_pf":sorted(pfs)[len(pfs)//2] if pfs else None}

def main():
    result={};prov={}
    for w,months in WINDOWS.items():
        data={};prov[w]={}
        for s in SYMBOLS:
            b,f,kc,fc=load(s,months);data[s]=(b,f);prov[w][s]={"bars":len(b),"funding_rows":len(f),"kline_sha256":kc,"funding_sha256":fc,"funding_status":"BINANCE_VISION_OK"}
            print(json.dumps({"window":w,"loaded":s,"bars":len(b),"funding":len(f)}),flush=True)
        result[w]={}
        for name,confirm in [("V1_BASELINE",False),("V2_FLOW_CONFIRM_FROZEN",True)]:
            result[w][name]={}
            for cname,cost in COSTS.items():
                by={s:simulate(*data[s],cost,confirm) for s in SYMBOLS}
                result[w][name][cname]={"portfolio":port(by),"symbols":by}
    payload={"schemaVersion":1,"kind":"vol-exp-flow-frozen-oos-v1","research_only":True,"public_data_only":True,
             "live_trading":False,"private_api":False,"orders_submitted":0,"leverage":1,
             "frozen_before_oos":True,
             "source_design_period":"2025-01..2026-07",
             "frozen_formula":{"compression_bars":36,"atr_pct":[0.0035,0.018],"range_pct_max":0.012,"rvol_min":1.0,
                               "downside_break":True,"short_only":True,"flow_bars":12,"flow_max":-0.05,
                               "stop":"max(signal_high, prior36_low + 0.8*ATR)","reward_risk":1.8,"max_hold_bars":18},
             "windows":WINDOWS,"symbols":SYMBOLS,"costs":COSTS,"provenance":prov,"results":result}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# Frozen VOL_EXP + Flow OOS V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           "| Window | Strategy | Cost | Trades | EW return | Positive | Avg MDD | Median PF |",
           "|---|---|---|---:|---:|---:|---:|---:|"]
    for w in WINDOWS:
        for name in result[w]:
            for cname in COSTS:
                p=result[w][name][cname]["portfolio"];pf="NA" if p["median_pf"] is None else f'{p["median_pf"]:.3f}'
                lines.append(f'| {w} | {name} | {cname} | {p["trades"]} | {p["equal_weight_return"]*100:.2f}% | {p["positive_symbols"]}/8 | {p["avg_mdd"]*100:.2f}% | {pf} |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8");print("\n".join(lines))
if __name__=="__main__":main()
