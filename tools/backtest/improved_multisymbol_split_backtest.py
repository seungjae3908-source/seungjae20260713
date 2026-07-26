#!/usr/bin/env python3
"""Conservative multi-symbol Bitget futures backtest. Public candles only; no orders."""
from __future__ import annotations
import json, math, time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pandas as pd
import requests

SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
DAYS, BAR_MS = 45, 15 * 60 * 1000
START, MAX_CAP, MIN_CAP = 300_000.0, 30_000.0, 5_000.0
LEV, RISK, DAILY_STOP, TOTAL_STOP = 5.0, 3_000.0, 6_000.0, 15_000.0
FEE, SLIP = 12 / 10_000, 15 / 10_000
OUT = Path("docs/backtests")
STEM = "BITGET_3SYMBOL_45D_IMPROVED_COMPARISON"
STRATEGIES = {
    "BASELINE_SPLIT": dict(kind="base", threshold=80, gap=15, entry=(.4,.3,.3),
        exit=(.3,.3,.4), targets=(1.,2.,3.), stop="atr", add=True, hold=672, cooldown=4),
    "IMPROVED_SPLIT": dict(kind="improved", threshold=85, gap=20, entry=(.4,.3,.3),
        exit=(.3,.3,.4), targets=(1.5,2.5,4.), stop="structure", add=True, hold=288, cooldown=8),
    "IMPROVED_FULL": dict(kind="improved", threshold=85, gap=20, entry=(1.,),
        exit=(1.,), targets=(2.5,), stop="structure", add=False, hold=288, cooldown=8),
}

def fetch(symbol):
    url = "https://api.bitget.com/api/v2/mix/market/history-candles"
    now = int(datetime.now(timezone.utc).timestamp()*1000)
    current = now // BAR_MS * BAR_MS
    start, end, rows = current-DAYS*86_400_000, current-1, {}
    s = requests.Session(); s.headers["User-Agent"] = "seungjae-improved-backtest/2.0"
    while end >= start:
        params = dict(symbol=symbol, granularity="15m", endTime=end, limit=200,
                      productType="usdt-futures")
        payload = None; error = None
        for attempt in range(5):
            try:
                r = s.get(url, params=params, timeout=30); r.raise_for_status()
                payload = r.json()
                if payload.get("code") != "00000": raise RuntimeError(str(payload))
                break
            except Exception as exc:
                error = exc; time.sleep(min(8, 2**attempt))
        if not payload or payload.get("code") != "00000":
            raise RuntimeError(f"{symbol} request failed: {error}")
        batch = payload.get("data") or []
        if not batch: break
        oldest = end
        for x in batch:
            ts = int(x[0]); oldest = min(oldest, ts)
            if start <= ts < current: rows[ts] = [float(v) for v in x[1:7]]
        if oldest >= end: break
        end = oldest-1; time.sleep(.06)
    df = pd.DataFrame.from_dict(rows, orient="index",
        columns=["open","high","low","close","volume","quote_volume"]).sort_index()
    df.index = pd.to_datetime(df.index, unit="ms", utc=True)
    df = df[~df.index.duplicated(keep="last")]
    if len(df) < 3000: raise RuntimeError(f"{symbol} insufficient candles: {len(df)}")
    return df

def rsi(s, n=14):
    d=s.diff(); g=d.clip(lower=0); l=-d.clip(upper=0)
    ag=g.ewm(alpha=1/n,adjust=False,min_periods=n).mean()
    al=l.ewm(alpha=1/n,adjust=False,min_periods=n).mean()
    return 100-100/(1+ag/al.replace(0,np.nan))

def tr(df):
    pc=df.close.shift(1)
    return pd.concat([df.high-df.low,(df.high-pc).abs(),(df.low-pc).abs()],axis=1).max(axis=1)

def atr(df,n=14): return tr(df).ewm(alpha=1/n,adjust=False,min_periods=n).mean()

def adx(df,n=14):
    up=df.high.diff(); down=-df.low.diff()
    plus=up.where((up>down)&(up>0),0.); minus=down.where((down>up)&(down>0),0.)
    a=tr(df).ewm(alpha=1/n,adjust=False,min_periods=n).mean()
    p=100*plus.ewm(alpha=1/n,adjust=False,min_periods=n).mean()/a.replace(0,np.nan)
    m=100*minus.ewm(alpha=1/n,adjust=False,min_periods=n).mean()/a.replace(0,np.nan)
    dx=100*(p-m).abs()/(p+m).replace(0,np.nan)
    return dx.ewm(alpha=1/n,adjust=False,min_periods=n).mean()

def higher(df, rule, p):
    h=df[["open","high","low","close","volume"]].resample(
        rule,label="right",closed="right").agg(
        {"open":"first","high":"max","low":"min","close":"last","volume":"sum"}).dropna()
    h[f"{p}_e20"]=h.close.ewm(span=20,adjust=False).mean()
    h[f"{p}_e50"]=h.close.ewm(span=50,adjust=False).mean()
    h[f"{p}_slope"]=h[f"{p}_e20"].pct_change(3)
    h[f"{p}_adx"]=adx(h)
    return h[[f"{p}_e20",f"{p}_e50",f"{p}_slope",f"{p}_adx"]].shift(1)

def features(df):
    x=df.copy()
    for n in (12,20,26,50): x[f"e{n}"]=x.close.ewm(span=n,adjust=False).mean()
    x["rsi"]=rsi(x.close); x["atr"]=atr(x); x["adx"]=adx(x)
    x["vr"]=x.volume/x.volume.rolling(20).mean()
    for n in (10,20):
        x[f"hi{n}"]=x.high.shift(1).rolling(n).max()
        x[f"lo{n}"]=x.low.shift(1).rolling(n).min()
    x["swing_lo"]=x.low.shift(1).rolling(12).min()
    x["swing_hi"]=x.high.shift(1).rolling(12).max()
    x["slope15"]=x.e20.pct_change(5)
    macd=x.close.ewm(span=12,adjust=False).mean()-x.close.ewm(span=26,adjust=False).mean()
    x["hist"]=macd-macd.ewm(span=9,adjust=False).mean()
    x["range_atr"]=(x.high-x.low)/x.atr.replace(0,np.nan)
    x["shock"]=(x.range_atr>=2.8)|((x.range_atr>=2.0)&(x.vr>=4))
    for p,rule in (("h1","1h"),("h4","4h")):
        x=pd.merge_asof(x.sort_index(),higher(x,rule,p).sort_index(),
            left_index=True,right_index=True,direction="backward")
    return x

def base_score(r):
    need=[r.rsi,r.atr,r.vr,r.h1_e20,r.h1_e50,r.h4_e20,r.h4_e50]
    if any(pd.isna(v) for v in need): return 0,0,"BASELINE"
    lo=sh=0
    if r.h4_e20>r.h4_e50: lo+=25
    else: sh+=25
    if r.h1_e20>r.h1_e50: lo+=20
    else: sh+=20
    if r.close>r.e20 and r.e12>r.e26: lo+=20
    if r.close<r.e20 and r.e12<r.e26: sh+=20
    if 52<=r.rsi<=70: lo+=15
    if 30<=r.rsi<=48: sh+=15
    if r.vr>=1.10:
        if r.close>=r.open: lo+=10
        if r.close<=r.open: sh+=10
    if pd.notna(r.hi20) and r.close>r.hi20: lo+=10
    if pd.notna(r.lo20) and r.close<r.lo20: sh+=10
    return lo,sh,"BASELINE"

def improved_score(r):
    names=("rsi","atr","adx","vr","hist","slope15","h1_e20","h1_e50",
           "h1_slope","h1_adx","h4_e20","h4_e50","h4_slope","h4_adx")
    if any(pd.isna(r[n]) for n in names): return 0,0,"UNKNOWN"
    if bool(r.shock): return 0,0,"SHOCK"
    g4=abs(r.h4_e20/r.h4_e50-1); g1=abs(r.h1_e20/r.h1_e50-1)
    bull=r.h4_e20>r.h4_e50 and r.h4_slope>0 and r.h1_e20>r.h1_e50 and r.h1_slope>0
    bear=r.h4_e20<r.h4_e50 and r.h4_slope<0 and r.h1_e20<r.h1_e50 and r.h1_slope<0
    regime="RANGE" if r.h4_adx<17 or g4<.0015 or g1<.0008 else "BULL" if bull else "BEAR" if bear else "RANGE"
    lo=30 if regime=="BULL" else 0; sh=30 if regime=="BEAR" else 0
    if r.h1_e20>r.h1_e50 and r.h1_slope>0: lo+=20
    if r.h1_e20<r.h1_e50 and r.h1_slope<0: sh+=20
    if r.e12>r.e26 and r.close>r.e20>r.e50: lo+=15
    if r.e12<r.e26 and r.close<r.e20<r.e50: sh+=15
    if 53<=r.rsi<=67 and r["hist"]>0: lo+=15
    if 33<=r.rsi<=47 and r["hist"]<0: sh+=15
    if r.adx>=20 and r.h1_adx>=18:
        if r.close>r.e20: lo+=10
        if r.close<r.e20: sh+=10
    if r.vr>=1.15:
        if r.close>r.open: lo+=5
        if r.close<r.open: sh+=5
    long_loc=(pd.notna(r.hi20) and r.close>r.hi20) or (r.low<=r.e20*1.002 and r.close>r.e20 and r.close>r.open)
    short_loc=(pd.notna(r.lo20) and r.close<r.lo20) or (r.high>=r.e20*.998 and r.close<r.e20 and r.close<r.open)
    if long_loc: lo+=5
    if short_loc: sh+=5
    return lo,sh,regime

def score(cfg,r): return base_score(r) if cfg["kind"]=="base" else improved_score(r)

def choose(cfg,lo,sh,regime):
    if lo>=cfg["threshold"] and lo>=sh+cfg["gap"] and (cfg["kind"]=="base" or regime=="BULL"): return "LONG",lo
    if sh>=cfg["threshold"] and sh>=lo+cfg["gap"] and (cfg["kind"]=="base" or regime=="BEAR"): return "SHORT",sh
    return None

def price(raw,direction,entry):
    if direction=="LONG": return raw*(1+SLIP if entry else 1-SLIP)
    return raw*(1-SLIP if entry else 1+SLIP)

def plan(cfg,r,direction,next_open):
    e=price(next_open,direction,True)
    if cfg["stop"]=="atr": dist=1.5*float(r.atr)
    else:
        if direction=="LONG":
            if pd.isna(r.swing_lo): return None
            raw=e-(float(r.swing_lo)-.15*float(r.atr))
        else:
            if pd.isna(r.swing_hi): return None
            raw=(float(r.swing_hi)+.15*float(r.atr))-e
        if raw<=0 or raw>2.6*float(r.atr): return None
        dist=max(1.25*float(r.atr),min(raw,2.3*float(r.atr)))
    roundtrip=2*(FEE+SLIP)
    expected_r=sum(a*b for a,b in zip(cfg["exit"],cfg["targets"]))
    if cfg["kind"]=="improved" and expected_r*dist/e < 2.5*roundtrip: return None
    risk_fraction=LEV*(dist/e+roundtrip)
    cap=math.floor(min(MAX_CAP,RISK/risk_fraction)/100)*100
    if cap<MIN_CAP: return None
    stop=e-dist if direction=="LONG" else e+dist
    return dict(cap=cap,stop=stop,dist=dist)

def simulate(symbol,df,name,cfg):
    x=features(df); trades=[]; pos=None; pending=None; cooldown=0
    equity=peak=START; maxdd=0.; daily=defaultdict(float); locks=set()
    streak=maxstreak=0; total_lock=False

    def avg(p):
        q=sum(l["q"] for l in p["lots"])
        return sum(l["q"]*l["price"] for l in p["lots"])/q

    def add(p,stage,raw,ts):
        cap=p["cap"]*cfg["entry"][stage-1]; notion=cap*LEV; px=price(raw,p["dir"],True); q=notion/px
        p["lots"].append(dict(stage=stage,cap=cap,notion=notion,price=px,q=q,fee=notion*FEE,slip=abs(px-raw)*q,time=str(ts)))
        p["q"]+=q; p["entry_fee"]+=notion*FEE; p["stage"]=stage

    def exitq(p,q,raw,ts,reason,stage):
        q=min(q,p["q"])
        if q<=0:return
        before=p["q"]; fee_alloc=p["entry_fee"]*q/before; px=price(raw,p["dir"],False); a=avg(p)
        gross=(px-a)*q if p["dir"]=="LONG" else (a-px)*q
        fee=px*q*FEE; net=gross-fee_alloc-fee
        p["q"]-=q; p["entry_fee"]-=fee_alloc; p["gross"]+=gross; p["fees_out"]+=fee
        p["slip_out"]+=abs(px-raw)*q; p["net"]+=net
        p["exits"].append(dict(stage=stage,time=str(ts),price=px,q=q,net=net,reason=reason))

    def finish(p,ts,reason):
        used=sum(l["cap"] for l in p["lots"]); fees=sum(l["fee"] for l in p["lots"])+p["fees_out"]
        return dict(symbol=symbol,strategy=name,direction=p["dir"],regime=p["regime"],
            opened_at=str(p["opened"]),closed_at=str(ts),signal_score=p["score"],
            entry_stages_filled=p["stage"],planned_capital_krw=p["cap"],used_capital_krw=used,
            total_notional_krw=sum(l["notion"] for l in p["lots"]),average_entry=avg(p),
            net_pnl_krw=p["net"],gross_pnl_krw=p["gross"],fees_krw=fees,
            slippage_krw=sum(l["slip"] for l in p["lots"])+p["slip_out"],
            return_on_used_capital_pct=p["net"]/used*100 if used else 0,
            exit_reason=reason,bars_held=p["bars"],entry_events=p["lots"],exit_events=p["exits"])

    def register(t,day):
        nonlocal equity,streak,maxstreak
        trades.append(t); equity+=t["net_pnl_krw"]; daily[day]+=t["net_pnl_krw"]
        streak=streak+1 if t["net_pnl_krw"]<0 else 0; maxstreak=max(maxstreak,streak)
        if streak>=2: locks.add(day)

    for i,(ts,r) in enumerate(x.iterrows()):
        day=str(ts.date())
        if daily[day]<=-DAILY_STOP: locks.add(day)
        if equity<=START-TOTAL_STOP: total_lock=True

        if pending and not pos:
            if not total_lock and day not in locks and i>=cooldown:
                pp=plan(cfg,pending["row"],pending["dir"],float(r.open))
                if pp:
                    pos=dict(dir=pending["dir"],score=pending["score"],regime=pending["regime"],
                        cap=pp["cap"],stop=pp["stop"],dist=pp["dist"],opened=ts,lots=[],q=0.,
                        entry_fee=0.,stage=0,tp=0,baseq=None,high=-np.inf,low=np.inf,bars=0,
                        gross=0.,fees_out=0.,slip_out=0.,net=0.,exits=[],pending_add=None)
                    add(pos,1,float(r.open),ts)
            pending=None

        if pos and pos["pending_add"]:
            stage=pos["pending_add"]; pos["pending_add"]=None
            gap_stop=float(r.open)<=pos["stop"] if pos["dir"]=="LONG" else float(r.open)>=pos["stop"]
            if not gap_stop and pos["tp"]==0:add(pos,stage,float(r.open),ts)

        if pos:
            pos["bars"]+=1; pos["high"]=max(pos["high"],float(r.close)); pos["low"]=min(pos["low"],float(r.close))
            a=avg(pos); R=max(pos["dist"],a*.001)
            stop_hit=float(r.low)<=pos["stop"] if pos["dir"]=="LONG" else float(r.high)>=pos["stop"]
            if stop_hit:
                exitq(pos,pos["q"],pos["stop"],ts,"STOP",0); t=finish(pos,ts,"STOP"); register(t,day)
                pos=None; cooldown=i+cfg["cooldown"]
            else:
                targets=[a+m*R if pos["dir"]=="LONG" else a-m*R for m in cfg["targets"]]
                if pos["tp"]<len(targets):
                    target=targets[pos["tp"]]
                    hit=float(r.high)>=target if pos["dir"]=="LONG" else float(r.low)<=target
                    if hit:
                        if len(cfg["exit"])==1:
                            exitq(pos,pos["q"],target,ts,f"TP_FULL_{cfg['targets'][0]:.1f}R",1)
                            t=finish(pos,ts,f"TP_FULL_{cfg['targets'][0]:.1f}R"); register(t,day)
                            pos=None; cooldown=i+cfg["cooldown"]
                        else:
                            if pos["baseq"] is None:pos["baseq"]=pos["q"]
                            q=pos["q"] if pos["tp"]==len(cfg["exit"])-1 else pos["baseq"]*cfg["exit"][pos["tp"]]
                            reason=f"TP{pos['tp']+1}_{cfg['targets'][pos['tp']]:.1f}R"
                            exitq(pos,q,target,ts,reason,pos["tp"]+1); pos["tp"]+=1; pos["pending_add"]=None
                            if pos["tp"]==1:
                                be=a*(1+(2*FEE+SLIP)) if pos["dir"]=="LONG" else a*(1-(2*FEE+SLIP))
                                pos["stop"]=max(pos["stop"],be) if pos["dir"]=="LONG" else min(pos["stop"],be)
                            if pos["q"]<=1e-12:
                                t=finish(pos,ts,reason); register(t,day); pos=None; cooldown=i+cfg["cooldown"]

        lo,sh,regime=score(cfg,r)
        if pos:
            directional=lo if pos["dir"]=="LONG" else sh
            favorable=float(r.close)-avg(pos) if pos["dir"]=="LONG" else avg(pos)-float(r.close)
            breakout=(pd.notna(r.hi10) and r.close>r.hi10) if pos["dir"]=="LONG" else (pd.notna(r.lo10) and r.close<r.lo10)
            if cfg["add"] and pos["tp"]==0 and not pos["pending_add"]:
                s2,s3=(82,85) if cfg["kind"]=="base" else (88,92)
                m2,m3=(.5,.85) if cfg["kind"]=="base" else (.6,1.)
                if pos["stage"]==1 and favorable>=m2*pos["dist"] and directional>=s2 and breakout:pos["pending_add"]=2
                elif pos["stage"]==2 and favorable>=m3*pos["dist"] and directional>=s3 and breakout:pos["pending_add"]=3
            if len(cfg["exit"])>1 and pos["tp"]>=2 and pd.notna(r.atr):
                trail=pos["high"]-2.2*r.atr if pos["dir"]=="LONG" else pos["low"]+2.2*r.atr
                pos["stop"]=max(pos["stop"],trail) if pos["dir"]=="LONG" else min(pos["stop"],trail)
            opposite=(sh>=cfg["threshold"] and sh>=lo+cfg["gap"]) if pos["dir"]=="LONG" else (lo>=cfg["threshold"] and lo>=sh+cfg["gap"])
            if opposite or pos["bars"]>=cfg["hold"]:
                if i+1<len(x):
                    nts=x.index[i+1]; no=float(x.iloc[i+1].open); reason="OPPOSITE_SIGNAL" if opposite else "MAX_HOLD"
                    exitq(pos,pos["q"],no,nts,reason,9); t=finish(pos,nts,reason); register(t,str(nts.date()))
                    pos=None; cooldown=i+1+cfg["cooldown"]
        elif not pending and i>=cooldown and not total_lock and day not in locks and pd.notna(r.atr) and not bool(r.shock):
            selected=choose(cfg,lo,sh,regime)
            if selected:
                d,s=selected; pending=dict(dir=d,score=s,regime=regime,row=r.copy())

        marked=equity
        if pos:
            a=avg(pos); gross=(r.close-a)*pos["q"] if pos["dir"]=="LONG" else (a-r.close)*pos["q"]
            marked+=pos["net"]+gross-pos["entry_fee"]-r.close*pos["q"]*FEE
        peak=max(peak,marked); maxdd=min(maxdd,(marked-peak)/peak*100)

    if pos:
        ts=x.index[-1]; exitq(pos,pos["q"],float(x.iloc[-1].close),ts,"END_OF_DATA",9)
        register(finish(pos,ts,"END_OF_DATA"),str(ts.date()))

    wins=[t for t in trades if t["net_pnl_krw"]>0]; losses=[t for t in trades if t["net_pnl_krw"]<0]
    gp=sum(t["net_pnl_krw"] for t in wins); gl=abs(sum(t["net_pnl_krw"] for t in losses))
    def side(d):
        z=[t for t in trades if t["direction"]==d]
        return dict(trades=len(z),win_rate_pct=sum(t["net_pnl_krw"]>0 for t in z)/len(z)*100 if z else 0,
            net_pnl_krw=sum(t["net_pnl_krw"] for t in z))
    result=dict(symbol=symbol,strategy=name,initial_equity_krw=START,final_equity_krw=equity,
        net_pnl_krw=equity-START,return_pct=(equity/START-1)*100,trades=len(trades),
        wins=len(wins),losses=len(losses),win_rate_pct=len(wins)/len(trades)*100 if trades else 0,
        profit_factor=gp/gl if gl else None,average_win_krw=np.mean([t["net_pnl_krw"] for t in wins]) if wins else 0,
        average_loss_krw=np.mean([t["net_pnl_krw"] for t in losses]) if losses else 0,
        expectancy_per_trade_krw=np.mean([t["net_pnl_krw"] for t in trades]) if trades else 0,
        maximum_drawdown_pct=maxdd,maximum_consecutive_losses=maxstreak,
        total_fees_krw=sum(t["fees_krw"] for t in trades),
        estimated_slippage_krw=sum(t["slippage_krw"] for t in trades),long=side("LONG"),short=side("SHORT"),
        entry_stages_filled=dict(Counter(t["entry_stages_filled"] for t in trades)),
        exit_reasons=dict(Counter(t["exit_reason"] for t in trades)),daily_stop_days=sorted(locks),
        total_stop_triggered=total_lock)
    return result,trades

def segments(trades,start,end):
    bounds=[start,start+pd.Timedelta(days=15),start+pd.Timedelta(days=30),end+pd.Timedelta(minutes=15)]
    out=[]
    for i in range(3):
        z=[t for t in trades if bounds[i]<=pd.Timestamp(t["closed_at"])<bounds[i+1]]
        w=[t for t in z if t["net_pnl_krw"]>0]; l=[t for t in z if t["net_pnl_krw"]<0]
        gp=sum(t["net_pnl_krw"] for t in w); gl=abs(sum(t["net_pnl_krw"] for t in l))
        out.append(dict(segment=i+1,start=bounds[i].isoformat(),end=bounds[i+1].isoformat(),
            trades=len(z),net_pnl_krw=sum(t["net_pnl_krw"] for t in z),
            win_rate_pct=len(w)/len(z)*100 if z else 0,profit_factor=gp/gl if gl else None))
    return out

def aggregate(results,trades):
    out=[]
    for name in STRATEGIES:
        rr=[r for r in results if r["strategy"]==name]; tt=[t for t in trades if t["strategy"]==name]
        w=[t for t in tt if t["net_pnl_krw"]>0]; l=[t for t in tt if t["net_pnl_krw"]<0]
        gp=sum(t["net_pnl_krw"] for t in w); gl=abs(sum(t["net_pnl_krw"] for t in l))
        out.append(dict(strategy=name,profitable_symbols=sum(r["net_pnl_krw"]>0 for r in rr),
            average_return_pct=np.mean([r["return_pct"] for r in rr]),
            pooled_net_pnl_krw=sum(r["net_pnl_krw"] for r in rr),trades=len(tt),
            win_rate_pct=len(w)/len(tt)*100 if tt else 0,profit_factor=gp/gl if gl else None,
            worst_maximum_drawdown_pct=min(r["maximum_drawdown_pct"] for r in rr),
            total_fees_krw=sum(r["total_fees_krw"] for r in rr),
            estimated_slippage_krw=sum(r["estimated_slippage_krw"] for r in rr)))
    return out

def save(frames,results,trades,segs):
    OUT.mkdir(parents=True,exist_ok=True); ag=aggregate(results,trades); now=datetime.now(timezone.utc).isoformat()
    payload=dict(status="PRELIMINARY_MULTI_SYMBOL_NOT_LIVE_READY",generated_at=now,
        source=dict(exchange="Bitget",endpoint="/api/v2/mix/market/history-candles",timeframe="15m",
            symbols={s:dict(candles=len(d),period_start=d.index[0].isoformat(),
            period_end=(d.index[-1]+pd.Timedelta(minutes=15)).isoformat()) for s,d in frames.items()}),
        policy=dict(starting_capital_krw_per_run=START,max_planned_capital_krw=MAX_CAP,
            leverage=LEV,risk_budget_krw=RISK,daily_stop_krw=DAILY_STOP,total_stop_krw=TOTAL_STOP,
            fee_bps_per_fill=12,slippage_bps_per_fill=15,strategies=STRATEGIES),
        aggregate=ag,runs=results,segments=segs,
        limitations=["Price/volume-only provisional comparison; not the final app signal engine.",
        "Historical OI, funding, order book, liquidation and news data are not included.",
        "Funding payments, outages, partial fills and order failures are not modeled.",
        "Stop-first is used whenever intrabar order is ambiguous.",
        "BTC was seen in the first diagnostic; ETH and SOL are cross-symbol validation only.",
        "Forty-five days and three symbols are insufficient for live deployment.",
        "Past simulated performance does not guarantee future results."])
    (OUT/f"{STEM}.json").write_text(json.dumps({"summary":payload,"trades":trades},ensure_ascii=False,indent=2,default=str),encoding="utf-8")
    pd.DataFrame([{k:v for k,v in t.items() if k not in ("entry_events","exit_events")} for t in trades]).to_csv(
        OUT/f"{STEM}_TRADES.csv",index=False,encoding="utf-8-sig")
    pd.DataFrame(results).to_csv(OUT/f"{STEM}_RUNS.csv",index=False,encoding="utf-8-sig")
    def pf(v):return "-" if v is None else f"{v:.3f}"
    ar="\n".join(f"| {a['strategy']} | {a['profitable_symbols']}/3 | {a['average_return_pct']:+.2f}% | "
        f"{a['pooled_net_pnl_krw']:+,.0f}원 | {a['trades']} | {a['win_rate_pct']:.2f}% | "
        f"{pf(a['profit_factor'])} | {a['worst_maximum_drawdown_pct']:.2f}% |" for a in ag)
    rr="\n".join(f"| {r['symbol']} | {r['strategy']} | {r['return_pct']:+.2f}% | {r['net_pnl_krw']:+,.0f}원 | "
        f"{r['trades']} | {r['win_rate_pct']:.2f}% | {pf(r['profit_factor'])} | {r['maximum_drawdown_pct']:.2f}% |" for r in results)
    imp=next(a for a in ag if a["strategy"]=="IMPROVED_SPLIT")
    base=next(a for a in ag if a["strategy"]=="BASELINE_SPLIT")
    passed=imp["pooled_net_pnl_krw"]>0 and (imp["profit_factor"] or 0)>=1.2 and imp["profitable_symbols"]>=2 and imp["trades"]>=30 and imp["worst_maximum_drawdown_pct"]>=-5
    md=f"""# Bitget 3종목 45일 개선 전략 비교 백테스트

> 실제 주문·계좌 접근 없이 Bitget 공개 15분봉만 사용한 예비 검증입니다.

- 생성: {now}
- 종목: {", ".join(SYMBOLS)}
- 원금: 각 실행 300,000원 / 거래당 최대 30,000원 / 5배
- 비용: 매 체결 수수료 12bp + 슬리피지 15bp
- 확정봉 신호 → 다음 봉 시가 체결 / 동일 봉 충돌은 손절 우선

## 개선안
- 시장상태(BULL/BEAR/RANGE/SHOCK)와 방향 일치 필수
- 4시간·1시간·15분 추세, ADX, RSI, MACD, 거래량, 진입 위치 결합
- 예상수익폭이 비용 대비 작으면 거래 차단
- 구조적 지지·저항과 ATR 결합 손절
- 2·3차는 수익 진행과 재돌파 확인 후만 진입
- 분할청산 시작 후 추가진입 금지
- 개선 청산 1.5R / 2.5R / 4R, 2차 이후 ATR 추적

## 전체 비교
| 전략 | 수익 종목 | 평균 수익률 | 3종목 합산손익 | 거래 | 승률 | PF | 최악 MDD |
|---|---:|---:|---:|---:|---:|---:|---:|
{ar}

## 종목별
| 종목 | 전략 | 수익률 | 순손익 | 거래 | 승률 | PF | MDD |
|---|---|---:|---:|---:|---:|---:|---:|
{rr}

## 판정
- 기존 대비 개선 분할 합산손익 차이: {imp['pooled_net_pnl_krw']-base['pooled_net_pnl_krw']:+,.0f}원
- 통과조건: 순손익 양수, PF≥1.20, 2개 이상 종목 수익, 거래≥30, 최악 MDD≥-5%
- 결과: {"예비 통과" if passed else "탈락 또는 추가 개선 필요"}

## 제한
- OI·펀딩·호가·청산·뉴스는 미포함입니다.
- BTC는 기존 결과를 본 뒤 개선했으므로 완전한 미관측 표본이 아닙니다.
- ETH·SOL도 동일 시장기간을 공유하므로 장기 워크포워드 검증이 추가로 필요합니다.
"""
    (OUT/f"{STEM}.md").write_text(md,encoding="utf-8")
    print(json.dumps(payload,ensure_ascii=False,indent=2,default=str))

def main():
    frames={s:fetch(s) for s in SYMBOLS}; results=[]; trades=[]; segs=[]
    for s,df in frames.items():
        for name,cfg in STRATEGIES.items():
            r,t=simulate(s,df,name,cfg); results.append(r); trades+=t
            segs += [dict(symbol=s,strategy=name,**x) for x in segments(t,df.index[0],df.index[-1])]
    save(frames,results,trades,segs)

if __name__=="__main__": main()
