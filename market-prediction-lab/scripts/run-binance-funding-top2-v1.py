#!/usr/bin/env python3
from __future__ import annotations
import csv, hashlib, io, json, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","BNBUSDT","LINKUSDT","ADAUSDT"]
MONTHS=[f"{y}-{m:02d}" for y,m0,m1 in [(2025,1,12),(2026,1,7)] for m in range(m0,m1+1)]
SPOT="https://data.binance.vision/data/spot/monthly/klines"
FUT="https://data.binance.vision/data/futures/um/monthly/klines"
FUND="https://data.binance.vision/data/futures/um/monthly/fundingRate"
UA={"User-Agent":"investment-platform-public-research/1.0"}
OUT=Path("market-prediction-lab/artifacts/binance-funding-top2-v1");OUT.mkdir(parents=True,exist_ok=True)
COSTS={"base":{"spot":0.0010,"fut":0.0008},"stress":{"spot":0.0015,"fut":0.0012}}
DAY=86400000

def get(url,timeout=30,retries=4):
    err=None
    for n in range(retries+1):
        try:
            req=urllib.request.Request(url,headers=UA)
            with urllib.request.urlopen(req,timeout=timeout) as r:return r.read()
        except Exception as e:
            err=e
            if n<retries:time.sleep(2**n)
    raise RuntimeError(f"download failed {url}: {err}")

def zchecked(url,name):
    b=get(url); expected=get(url+".CHECKSUM").decode().strip().split()[0]; actual=hashlib.sha256(b).hexdigest()
    if expected.lower()!=actual.lower():raise RuntimeError(f"checksum mismatch {name}")
    return zipfile.ZipFile(io.BytesIO(b)),actual

def normts(x):
    t=int(float(x))
    return t//1000 if t>100_000_000_000_000 else t

def kmonth(sym,m,kind):
    base=SPOT if kind=="spot" else FUT
    name=f"{sym}-1d-{m}.zip";z,d=zchecked(f"{base}/{sym}/1d/{name}",name);rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):continue
        for r in csv.reader(io.TextIOWrapper(z.open(member),encoding="utf-8")):
            if r and r[0].isdigit():rows.append((normts(r[0]),float(r[1])))
    return m,rows,d

def fmonth(sym,m):
    name=f"{sym}-fundingRate-{m}.zip";z,d=zchecked(f"{FUND}/{sym}/{name}",name);rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):continue
        for r in csv.DictReader(io.TextIOWrapper(z.open(member),encoding="utf-8")):
            try:
                t=normts(r.get("calc_time") or r.get("fundingTime") or 0)
                rate=float(r.get("last_funding_rate") or r.get("funding_rate") or r.get("fundingRate"))
                if t>0:rows.append((t,rate))
            except Exception:pass
    return m,rows,d

def load(sym,kind):
    parts={};checks={}
    fn=fmonth if kind=="fund" else (lambda s,m:kmonth(s,m,kind))
    with ThreadPoolExecutor(max_workers=8) as ex:
        fs={ex.submit(fn,sym,m):m for m in MONTHS}
        for f in as_completed(fs):
            m,rows,d=f.result();parts[m]=rows;checks[m]=d
    merged=[]
    for m in MONTHS:merged+=parts[m]
    if kind=="fund":
        return sorted({t:r for t,r in merged}.items()),checks
    return sorted({t:o for t,o in merged}.items()),checks

def fsumpast(funding,t,days=7):
    lo=t-days*DAY
    return sum(r for ts,r in funding if lo<ts<t)

def fsum(funding,t0,t1):
    return sum(r for ts,r in funding if t0<ts<=t1)

def simulate(data,cost,start_fraction=0.0):
    dates=data["dates"];start=max(7,int(len(dates)*start_fraction))
    cash=1.0;pair={s:0.0 for s in SYMBOLS};peak=1.0;mdd=0.0;fees=0.0;selections=[];curve=[1.0]
    avg_cost=(cost["spot"]+cost["fut"])/2
    for i in range(start,len(dates)-1):
        t,t1=dates[i],dates[i+1]
        if (i-start)%7==0:
            equity=cash+sum(pair.values())
            scores=sorted([(fsumpast(data["fund"][s],t,7),s) for s in SYMBOLS],reverse=True)
            chosen=[s for score,s in scores[:2] if score>0]
            target={s:(1/len(chosen) if s in chosen and chosen else 0.0) for s in SYMBOLS}
            current={s:(pair[s]/equity if equity>0 else 0) for s in SYMBOLS}
            turnover=sum(abs(target[s]-current[s]) for s in SYMBOLS)
            fee=equity*turnover*avg_cost;fees+=fee;equity-=fee
            pair={s:target[s]*equity for s in SYMBOLS};cash=equity-sum(pair.values())
            selections.append({"t":t,"chosen":chosen,"scores":{s:score for score,s in scores}})
        for s in SYMBOLS:
            if pair[s]<=0:continue
            so0,so1=data["spot"][s][t],data["spot"][s][t1]
            fu0,fu1=data["fut"][s][t],data["fut"][s][t1]
            pr=(so1/so0-1)-(fu1/fu0-1)+fsum(data["fund"][s],t,t1)
            pair[s]*=max(0.01,1+pr/2)
        equity=cash+sum(pair.values());peak=max(peak,equity);mdd=min(mdd,equity/peak-1);curve.append(equity)
    equity=cash+sum(pair.values())
    turnover=sum(pair.values())/equity if equity>0 else 0
    fee=equity*turnover*avg_cost;fees+=fee;equity-=fee;curve.append(equity)
    years=(dates[-1]-dates[start])/(365.25*DAY)
    ret=equity-1
    return {"return":ret,"annualized":(equity**(1/years)-1 if years>0 and equity>0 else None),"mdd":mdd,
            "fees":fees,"weeks":len(selections),"cashWeeks":sum(1 for x in selections if not x["chosen"]),
            "selectionCounts":{s:sum(s in x["chosen"] for x in selections) for s in SYMBOLS}}

def main():
    spot={};fut={};fund={};prov={}
    for s in SYMBOLS:
        sp,sh=load(s,"spot");fu,fh=load(s,"fut");fr,rh=load(s,"fund")
        spot[s]=dict(sp);fut[s]=dict(fu);fund[s]=fr
        prov[s]={"spotSha":sh,"futSha":fh,"fundSha":rh,"fundingStatus":"BINANCE_VISION_OK"}
        print(json.dumps({"loaded":s,"spot":len(sp),"fut":len(fu),"fund":len(fr)}),flush=True)
    common=set(spot[SYMBOLS[0]]) & set(fut[SYMBOLS[0]])
    for s in SYMBOLS:common &= set(spot[s]) & set(fut[s])
    dates=sorted(common)
    if len(dates)<500:raise RuntimeError(f"insufficient common dates {len(dates)}")
    data={"dates":dates,"spot":spot,"fut":fut,"fund":fund}
    results={k:{"full":simulate(data,v,0.0),"recent30pct":simulate(data,v,0.70)} for k,v in COSTS.items()}
    out={"schemaVersion":1,"kind":"binance-funding-top2-v1","researchOnly":True,"publicDataOnly":True,
         "liveTrading":False,"privateApi":False,"ordersSubmitted":0,
         "formula":{"rank":"trailing realized 7d funding sum","select":"top 2 positive","rebalanceDays":7,
                    "legs":"long spot + short USD-M perpetual, fully funded pair capital","lookahead":False},
         "symbols":SYMBOLS,"months":MONTHS,"costs":COSTS,"commonDays":len(dates),"provenance":prov,"results":results}
    (OUT/"result.json").write_text(json.dumps(out,indent=2),encoding="utf-8")
    print(json.dumps(out,indent=2))
if __name__=="__main__":main()
