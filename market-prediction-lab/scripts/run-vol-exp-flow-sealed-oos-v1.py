#!/usr/bin/env python3
from __future__ import annotations
import csv, importlib.util, io, json, sys
from datetime import datetime, timezone
from pathlib import Path

BASE_PATH=Path("market-prediction-lab/scripts/run-binance-orderflow-v1.py")
spec=importlib.util.spec_from_file_location("orderflow_base",BASE_PATH)
base=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=base
spec.loader.exec_module(base)

OUT=Path("market-prediction-lab/artifacts/vol-exp-flow-sealed-oos-v1")
OUT.mkdir(parents=True,exist_ok=True)
OOS_START=int(datetime(2026,8,1,tzinfo=timezone.utc).timestamp()*1000)
OOS_END=int(datetime(2026,9,19,tzinfo=timezone.utc).timestamp()*1000)
MIN_OOS_TRADES=20
DAILY_KBASE="https://data.binance.vision/data/futures/um/daily/klines"
DAILY_FBASE="https://data.binance.vision/data/futures/um/daily/fundingRate"

def fetch_daily_kline(sym,date):
    name=f"{sym}-5m-{date}.zip"
    z,digest=base.checked(f"{DAILY_KBASE}/{sym}/5m/{name}",name)
    rows=[]
    for member in z.namelist():
        if not member.endswith(".csv"):continue
        for r in csv.reader(io.TextIOWrapper(z.open(member),encoding="utf-8")):
            if not r or not r[0].isdigit():continue
            try:
                ts=int(r[0])
                if ts>100_000_000_000_000:ts//=1000
                rows.append(base.Bar(ts,float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5]),float(r[9])))
            except Exception:pass
    return date,rows,digest

def fetch_daily_funding(sym,date):
    name=f"{sym}-fundingRate-{date}.zip"
    z,digest=base.checked(f"{DAILY_FBASE}/{sym}/{name}",name)
    rows=[]
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
    return date,rows,digest

def load_sealed(sym):
    bars=[];fund=[];kchecks={};fchecks={}
    for month in ("2026-07","2026-08"):
        _,rows,d=base.fetch_kline_month(sym,month);bars.extend(rows);kchecks[month]=d
        _,fr,fd=base.fetch_funding_month(sym,month);fund.extend(fr);fchecks[month]=fd
    for day in range(1,19):
        date=f"2026-09-{day:02d}"
        _,rows,d=fetch_daily_kline(sym,date);bars.extend(rows);kchecks[date]=d
        _,fr,fd=fetch_daily_funding(sym,date);fund.extend(fr);fchecks[date]=fd
    bars=sorted({b.t:b for b in bars}.values(),key=lambda b:b.t)
    fund=sorted({t:r for t,r in fund}.items())
    if not bars or not fund:raise RuntimeError(f"{sym} sealed data empty")
    if any(b.t-a.t!=300000 for a,b in zip(bars,bars[1:])):raise RuntimeError(f"{sym} sealed 5m gap")
    return bars,fund,kchecks,fchecks

def raw_signal(b,F,i):
    return base.sig_vol_base(b,F,i,False)
def threshold_signal(b,F,i):
    return base.sig_vol_base(b,F,i,True)
def sign_signal(b,F,i):
    s=raw_signal(b,F,i)
    if not s:return None
    fl=base.flow_ratio(b,i,12)
    if fl is None or fl>=0:return None
    return {**s,"flow":fl}
def acceleration_signal(b,F,i):
    s=raw_signal(b,F,i)
    if not s or i<24:return None
    cur=base.flow_ratio(b,i,12);prev=base.flow_ratio(b,i-12,12)
    if cur is None or prev is None or cur>=0 or cur>=prev:return None
    return {**s,"flow":cur,"prev_flow":prev}

STRATS={
 "VOL_EXP_SHORT_BASELINE":raw_signal,
 "FLOW_THRESHOLD_M005":threshold_signal,
 "FLOW_SIGN_ONLY":sign_signal,
 "FLOW_SIGN_ACCELERATING":acceleration_signal,
}

def simulate_oos(bars,funding,F,fn,cost):
    start=next((i for i,b in enumerate(bars) if b.t>=OOS_START),None)
    end=next((i for i,b in enumerate(bars) if b.t>=OOS_END),len(bars))
    if start is None:raise RuntimeError("OOS start unavailable")
    eq=1.;peak=1.;mdd=0.;trades=[];i=max(60,start)
    while i<end-2:
        s=fn(bars,F,i)
        if not s:i+=1;continue
        ei=i+1
        if ei>=end:break
        entry=bars[ei].o
        risk=entry-s["stop"] if s["side"]>0 else s["stop"]-entry
        if risk<=0 or risk/entry<0.001 or risk/entry>0.05:i+=1;continue
        tp=entry+s["side"]*s["rr"]*risk
        xi=min(ei+s["hold"]-1,end-1);exitp=bars[xi].c;reason="TIME"
        for k in range(ei,xi+1):
            x=bars[k]
            if s["side"]>0:
                if x.l<=s["stop"]:exitp=s["stop"];xi=k;reason="SL";break
                if x.h>=tp:exitp=tp;xi=k;reason="TP";break
            else:
                if x.h>=s["stop"]:exitp=s["stop"];xi=k;reason="SL";break
                if x.l<=tp:exitp=tp;xi=k;reason="TP";break
        gross=s["side"]*(exitp/entry-1)
        fc=base.fund_cost(funding,s["side"],bars[ei].t,bars[xi].t)
        net=gross-2*cost-fc
        eq*=max(.01,1+net);peak=max(peak,eq);mdd=min(mdd,eq/peak-1)
        trades.append({"entry":bars[ei].t,"exit":bars[xi].t,"net":net,"gross":gross,"funding":fc,"reason":reason})
        i=xi+1
    wins=[t for t in trades if t["net"]>0];loss=[t for t in trades if t["net"]<0]
    gp=sum(t["net"] for t in wins);gl=-sum(t["net"] for t in loss)
    return {"trades":len(trades),"return":eq-1,"mdd":mdd,"pf":gp/gl if gl else None,
            "win_rate":len(wins)/len(trades) if trades else 0,
            "avg_net":sum(t["net"] for t in trades)/len(trades) if trades else 0}

def main():
    data={};prov={}
    for sym in base.SYMBOLS:
        bars,fund,kc,fc=load_sealed(sym)
        data[sym]=(bars,fund,base.features(bars))
        prov[sym]={"bars":len(bars),"funding_rows":len(fund),"funding_status":"BINANCE_VISION_OK",
                   "kline_sha256":kc,"funding_sha256":fc}
        print(json.dumps({"loaded":sym,"bars":len(bars),"funding":len(fund)}),flush=True)
    results={}
    for name,fn in STRATS.items():
        results[name]={}
        for cname,cost in base.COSTS.items():
            by={s:simulate_oos(*data[s],fn,cost) for s in base.SYMBOLS}
            results[name][cname]={"portfolio":base.portfolio(by),"symbols":by}
    candidate_trades=results["FLOW_THRESHOLD_M005"]["base"]["portfolio"]["trades"]
    evidence_status="SUFFICIENT_FOR_INITIAL_OOS_READ" if candidate_trades>=MIN_OOS_TRADES else "SAMPLE_INSUFFICIENT"
    payload={"schemaVersion":1,"kind":"vol-exp-flow-sealed-oos-v1","research_only":True,"public_data_only":True,
             "live_trading":False,"private_api":False,"orders_submitted":0,"lookahead_free":True,"leverage":1,
             "sealed_contract":{
               "source_research_end":"2026-07-31",
               "oos_start":"2026-08-01T00:00:00Z",
               "oos_end_exclusive":"2026-09-19T00:00:00Z",
               "opened_once":True,
               "min_candidate_trades":MIN_OOS_TRADES,
               "candidate":"FLOW_THRESHOLD_M005",
               "no_post_oos_retuning":True,
             },
             "evidence_status":evidence_status,"symbols":base.SYMBOLS,"costs":base.COSTS,
             "provenance":prov,"results":results}
    (OUT/"result.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    lines=["# VOL_EXP Flow Sealed OOS V1","","RESEARCH ONLY / PUBLIC DATA ONLY / NO ORDERS","",
           f"Sealed window: 2026-08-01 through 2026-09-18; status: **{evidence_status}**","",
           "| Strategy | Cost | Trades | EW return | Positive | Avg MDD | Median PF |",
           "|---|---|---:|---:|---:|---:|---:|"]
    for name in STRATS:
        for cname in base.COSTS:
            p=results[name][cname]["portfolio"]
            pf="NA" if p["median_symbol_pf"] is None else f'{p["median_symbol_pf"]:.3f}'
            lines.append(f'| {name} | {cname} | {p["trades"]} | {p["equal_weight_return"]*100:.2f}% | {p["positive_symbols"]}/8 | {p["avg_mdd"]*100:.2f}% | {pf} |')
    (OUT/"summary.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))
if __name__=="__main__":main()
