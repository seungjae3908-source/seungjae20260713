#!/usr/bin/env python3
"""Preliminary BTCUSDT split-entry/split-exit backtest (no orders, public data only)."""
from __future__ import annotations

import json, math, time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

SYMBOL = "BTCUSDT"
DAYS = 45
START = 300_000.0
MAX_CAPITAL = 30_000.0
MIN_CAPITAL = 5_000.0
LEV = 5.0
RISK_BUDGET = 3_000.0
DAILY_STOP = 6_000.0
TOTAL_STOP = 15_000.0
FEE = 12 / 10_000
SLIP = 15 / 10_000
ENTRY_SPLITS = [0.40, 0.30, 0.30]
EXIT_SPLITS = [0.30, 0.30, 0.40]
BAR_MS = 15 * 60 * 1000
OUT = Path("docs/backtests")


def fetch_candles() -> pd.DataFrame:
    endpoint = "https://api.bitget.com/api/v2/mix/market/history-candles"
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    current_open = now_ms // BAR_MS * BAR_MS
    start_ms, end_ms = current_open - DAYS * 86400_000, current_open - 1
    rows: dict[int, list[float]] = {}
    session = requests.Session()
    session.headers["User-Agent"] = "seungjae-preliminary-backtest/1.0"
    while end_ms >= start_ms:
        params = dict(symbol=SYMBOL, granularity="15m", endTime=end_ms, limit=200, productType="usdt-futures")
        last_error = None
        for attempt in range(5):
            try:
                payload = session.get(endpoint, params=params, timeout=30).json()
                if payload.get("code") != "00000": raise RuntimeError(str(payload))
                break
            except Exception as exc:
                last_error = exc; time.sleep(min(8, 2 ** attempt))
        else:
            raise RuntimeError(f"Bitget request failed: {last_error}")
        batch = payload.get("data") or []
        if not batch: break
        oldest = end_ms
        for r in batch:
            ts = int(r[0]); oldest = min(oldest, ts)
            if start_ms <= ts < current_open:
                rows[ts] = [float(x) for x in r[1:7]]
        if oldest >= end_ms: break
        end_ms = oldest - 1
        time.sleep(0.06)
    df = pd.DataFrame.from_dict(rows, orient="index", columns=["open","high","low","close","volume","quote_volume"]).sort_index()
    df.index = pd.to_datetime(df.index, unit="ms", utc=True)
    if len(df) < 1000: raise RuntimeError(f"Insufficient candles: {len(df)}")
    return df


def rsi(s: pd.Series, n=14) -> pd.Series:
    d = s.diff(); gain = d.clip(lower=0); loss = -d.clip(upper=0)
    ag = gain.ewm(alpha=1/n, adjust=False, min_periods=n).mean()
    al = loss.ewm(alpha=1/n, adjust=False, min_periods=n).mean()
    return 100 - 100 / (1 + ag / al.replace(0, np.nan))


def atr(df: pd.DataFrame, n=14) -> pd.Series:
    pc = df.close.shift(1)
    tr = pd.concat([(df.high-df.low), (df.high-pc).abs(), (df.low-pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1/n, adjust=False, min_periods=n).mean()


def features(df: pd.DataFrame) -> pd.DataFrame:
    x = df.copy()
    for n in [12,20,26]: x[f"ema{n}"] = x.close.ewm(span=n, adjust=False).mean()
    x["rsi"] = rsi(x.close); x["atr"] = atr(x)
    x["vol_ratio"] = x.volume / x.volume.rolling(20).mean()
    x["prev_hi20"] = x.high.shift(1).rolling(20).max(); x["prev_lo20"] = x.low.shift(1).rolling(20).min()
    x["prev_hi10"] = x.high.shift(1).rolling(10).max(); x["prev_lo10"] = x.low.shift(1).rolling(10).min()
    for label, rule in [("1h","1h"),("4h","4h")]:
        h = x[["open","high","low","close","volume"]].resample(rule, label="right", closed="right").agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum"}).dropna()
        h[f"{label}_e20"] = h.close.ewm(span=20, adjust=False).mean(); h[f"{label}_e60"] = h.close.ewm(span=60, adjust=False).mean()
        x = pd.merge_asof(x.sort_index(), h[[f"{label}_e20",f"{label}_e60"]].sort_index(), left_index=True, right_index=True, direction="backward")
    return x


def scores(row) -> tuple[int,int]:
    needed = [row.rsi,row.atr,row.vol_ratio,row["1h_e20"],row["1h_e60"],row["4h_e20"],row["4h_e60"]]
    if any(pd.isna(v) for v in needed): return 0,0
    lo=sh=0
    if row["4h_e20"] > row["4h_e60"]: lo+=25
    else: sh+=25
    if row["1h_e20"] > row["1h_e60"]: lo+=20
    else: sh+=20
    if row.close > row.ema20 and row.ema12 > row.ema26: lo+=20
    if row.close < row.ema20 and row.ema12 < row.ema26: sh+=20
    if 52 <= row.rsi <= 70: lo+=15
    if 30 <= row.rsi <= 48: sh+=15
    if row.vol_ratio >= 1.10:
        if row.close >= row.open: lo+=10
        if row.close <= row.open: sh+=10
    if pd.notna(row.prev_hi20) and row.close > row.prev_hi20: lo+=10
    if pd.notna(row.prev_lo20) and row.close < row.prev_lo20: sh+=10
    return lo,sh


def fill(raw, direction, entry):
    if direction == "LONG": return raw * (1 + SLIP if entry else 1 - SLIP)
    return raw * (1 - SLIP if entry else 1 + SLIP)


def run(df: pd.DataFrame):
    x = features(df); trades=[]; pos=None; pending=None; cooldown=0
    equity=START; peak=START; max_dd=0; daily={}; day_lock=set(); loss_streak=0; max_loss_streak=0; total_locked=False

    def avg(p): return sum(l["qty"]*l["price"] for l in p["lots"])/sum(l["qty"] for l in p["lots"])
    def add(p, stage, raw, ts):
        cap=p["plan"]*ENTRY_SPLITS[stage-1]; notion=cap*LEV; price=fill(raw,p["dir"],True); qty=notion/price
        p["lots"].append(dict(stage=stage,cap=cap,notion=notion,price=price,qty=qty,fee=notion*FEE,slip=abs(price-raw)*qty,ts=ts)); p["qty"]+=qty; p["entry_fee"]+=notion*FEE; p["stage"]=stage
    def exit_qty(p, qty, raw, ts, reason, stage):
        qty=min(qty,p["qty"]); before=p["qty"]; alloc=p["entry_fee"]*qty/before; price=fill(raw,p["dir"],False); a=avg(p)
        gross=(price-a)*qty if p["dir"]=="LONG" else (a-price)*qty; fee=price*qty*FEE; net=gross-alloc-fee
        p["qty"]-=qty; p["entry_fee"]-=alloc; p["gross"]+=gross; p["fees_out"]+=fee; p["slip_out"]+=abs(price-raw)*qty; p["net"]+=net
        p["legs"].append(dict(kind="EXIT",stage=stage,time=str(ts),price=price,qty=qty,net=net,reason=reason))
    def finish(p, ts, reason):
        used=sum(l["cap"] for l in p["lots"]); fees=sum(l["fee"] for l in p["lots"])+p["fees_out"]; slippage=sum(l["slip"] for l in p["lots"])+p["slip_out"]
        return dict(direction=p["dir"],opened_at=str(p["opened"]),closed_at=str(ts),signal_score=p["score"],stages=p["stage"],planned_capital=p["plan"],used_capital=used,total_notional=sum(l["notion"] for l in p["lots"]),average_entry=avg(p),net_pnl=p["net"],gross_pnl=p["gross"],fees=fees,slippage=slippage,return_pct=p["net"]/used*100 if used else 0,exit_reason=reason,bars=p["bars"],legs=p["legs"])

    for i,(ts,row) in enumerate(x.iterrows()):
        day=str(ts.date())
        if daily.get(day,0)<=-DAILY_STOP: day_lock.add(day)
        if equity<=START-TOTAL_STOP: total_locked=True
        if pos and pos.get("pending_exit"):
            exit_qty(pos,pos["qty"],row.open,ts,pos["pending_exit"],9); t=finish(pos,ts,pos["pending_exit"]); trades.append(t); equity+=t["net_pnl"]; daily[day]=daily.get(day,0)+t["net_pnl"]
            loss_streak=loss_streak+1 if t["net_pnl"]<0 else 0; max_loss_streak=max(max_loss_streak,loss_streak)
            if loss_streak>=2: day_lock.add(day)
            pos=None; cooldown=i+4
        if pos and pos.get("pending_add"):
            add(pos,pos.pop("pending_add"),row.open,ts)
        if pending and not pos:
            if not total_locked and day not in day_lock:
                direction,score,a=pending; entry=fill(row.open,direction,True); risk_pct=LEV*((1.5*a/entry)+2*FEE+2*SLIP); plan=min(MAX_CAPITAL,RISK_BUDGET/risk_pct) if risk_pct>0 else 0; plan=math.floor(plan/100)*100
                if plan>=MIN_CAPITAL:
                    stop=entry-1.5*a if direction=="LONG" else entry+1.5*a
                    pos=dict(dir=direction,score=score,plan=plan,stop=stop,opened=ts,first=entry,first_atr=a,lots=[],qty=0,entry_fee=0,stage=0,tp=0,base_qty=None,highest=-np.inf,lowest=np.inf,bars=0,gross=0,fees_out=0,slip_out=0,net=0,legs=[])
                    add(pos,1,row.open,ts)
            pending=None
        if pos:
            pos["bars"]+=1; pos["highest"]=max(pos["highest"],row.close); pos["lowest"]=min(pos["lowest"],row.close); a=avg(pos); R=max(1.5*pos["first_atr"],a*.001)
            stop_hit=row.low<=pos["stop"] if pos["dir"]=="LONG" else row.high>=pos["stop"]
            if stop_hit:
                exit_qty(pos,pos["qty"],pos["stop"],ts,"STOP",0); t=finish(pos,ts,"STOP"); trades.append(t); equity+=t["net_pnl"]; daily[day]=daily.get(day,0)+t["net_pnl"]
                loss_streak=loss_streak+1 if t["net_pnl"]<0 else 0; max_loss_streak=max(max_loss_streak,loss_streak)
                if loss_streak>=2: day_lock.add(day)
                pos=None; cooldown=i+4
            else:
                targets=[a+R,a+2*R,a+3*R] if pos["dir"]=="LONG" else [a-R,a-2*R,a-3*R]
                hits=[row.high>=z for z in targets] if pos["dir"]=="LONG" else [row.low<=z for z in targets]
                if pos["tp"]==0 and hits[0]:
                    pos["base_qty"]=pos["qty"]; exit_qty(pos,pos["base_qty"]*.30,targets[0],ts,"TP1_1R",1); pos["tp"]=1; buffer=2*FEE+SLIP; pos["stop"]=max(pos["stop"],a*(1+buffer)) if pos["dir"]=="LONG" else min(pos["stop"],a*(1-buffer))
                elif pos["tp"]==1 and hits[1]: exit_qty(pos,pos["base_qty"]*.30,targets[1],ts,"TP2_2R",2); pos["tp"]=2
                elif pos["tp"]>=2 and hits[2]:
                    exit_qty(pos,pos["qty"],targets[2],ts,"TP3_3R",3); t=finish(pos,ts,"TP3_3R"); trades.append(t); equity+=t["net_pnl"]; daily[day]=daily.get(day,0)+t["net_pnl"]; loss_streak=0; pos=None; cooldown=i+4
        lo,sh=scores(row)
        if pos:
            favorable=(row.close-pos["first"]) if pos["dir"]=="LONG" else (pos["first"]-row.close); baseR=1.5*pos["first_atr"]; dscore=lo if pos["dir"]=="LONG" else sh
            breakout=(row.close>row.prev_hi10) if pos["dir"]=="LONG" and pd.notna(row.prev_hi10) else (row.close<row.prev_lo10) if pos["dir"]=="SHORT" and pd.notna(row.prev_lo10) else False
            if pos["tp"]==0 and not pos.get("pending_add"):
                if pos["stage"]==1 and favorable>=.5*baseR and dscore>=82 and breakout: pos["pending_add"]=2
                elif pos["stage"]==2 and favorable>=.85*baseR and dscore>=85 and breakout: pos["pending_add"]=3
            if pos["tp"]>=2 and pd.notna(row.atr):
                trail=pos["highest"]-2*row.atr if pos["dir"]=="LONG" else pos["lowest"]+2*row.atr; pos["stop"]=max(pos["stop"],trail) if pos["dir"]=="LONG" else min(pos["stop"],trail)
            opposite=(sh>=80 and sh>=lo+15) if pos["dir"]=="LONG" else (lo>=80 and lo>=sh+15)
            if opposite: pos["pending_exit"]="OPPOSITE_SIGNAL"
            elif pos["bars"]>=672: pos["pending_exit"]="MAX_HOLD"
        elif not pending and i>=cooldown and not total_locked and day not in day_lock and pd.notna(row.atr):
            if lo>=80 and lo>=sh+15: pending=("LONG",lo,row.atr)
            elif sh>=80 and sh>=lo+15: pending=("SHORT",sh,row.atr)
        mark=equity
        if pos:
            a=avg(pos); gross=(row.close-a)*pos["qty"] if pos["dir"]=="LONG" else (a-row.close)*pos["qty"]; mark+=pos["net"]+gross-pos["entry_fee"]-row.close*pos["qty"]*FEE
        peak=max(peak,mark); max_dd=min(max_dd,(mark-peak)/peak*100)
    if pos:
        ts=x.index[-1]; row=x.iloc[-1]; exit_qty(pos,pos["qty"],row.close,ts,"END_OF_DATA",9); t=finish(pos,ts,"END_OF_DATA"); trades.append(t); equity+=t["net_pnl"]
    wins=[t for t in trades if t["net_pnl"]>0]; losses=[t for t in trades if t["net_pnl"]<0]; gp=sum(t["net_pnl"] for t in wins); gl=abs(sum(t["net_pnl"] for t in losses))
    side=lambda d: {"trades":len([t for t in trades if t["direction"]==d]),"win_rate_pct":(sum(t["net_pnl"]>0 for t in trades if t["direction"]==d)/len([t for t in trades if t["direction"]==d])*100) if any(t["direction"]==d for t in trades) else 0,"net_pnl_krw":sum(t["net_pnl"] for t in trades if t["direction"]==d)}
    result=dict(initial_equity_krw=START,final_equity_krw=equity,net_pnl_krw=equity-START,return_pct=(equity/START-1)*100,trades=len(trades),wins=len(wins),losses=len(losses),win_rate_pct=len(wins)/len(trades)*100 if trades else 0,profit_factor=gp/gl if gl else None,average_win_krw=np.mean([t["net_pnl"] for t in wins]) if wins else 0,average_loss_krw=np.mean([t["net_pnl"] for t in losses]) if losses else 0,expectancy_per_trade_krw=np.mean([t["net_pnl"] for t in trades]) if trades else 0,maximum_drawdown_pct=max_dd,maximum_consecutive_losses=max_loss_streak,total_fees_krw=sum(t["fees"] for t in trades),estimated_slippage_cost_krw=sum(t["slippage"] for t in trades),long=side("LONG"),short=side("SHORT"),stages_filled=dict(Counter(t["stages"] for t in trades)),exit_reasons=dict(Counter(t["exit_reason"] for t in trades)),daily_stop_days=sorted(day_lock),total_stop_triggered=total_locked)
    return result,trades


def save(df,result,trades):
    OUT.mkdir(parents=True,exist_ok=True); start,end=df.index[0].isoformat(),(df.index[-1]+pd.Timedelta(minutes=15)).isoformat()
    report={"status":"PRELIMINARY_NOT_FINAL_STRATEGY","generated_at":datetime.now(timezone.utc).isoformat(),"source":{"exchange":"Bitget","endpoint":"/api/v2/mix/market/history-candles","symbol":SYMBOL,"timeframe":"15m","candles":len(df),"period_start":start,"period_end":end},"policy":{"starting_capital_krw":START,"max_planned_capital_krw":MAX_CAPITAL,"leverage":LEV,"risk_budget_krw":RISK_BUDGET,"entry_splits":ENTRY_SPLITS,"exit_splits":EXIT_SPLITS,"fee_bps_per_side":12,"slippage_bps_per_fill":15},"results":result,"limitations":["Price/volume-only provisional baseline; not the final app signal engine.","Historical OI, funding, order book, news and liquidation data are not included.","Funding payments, outages and real fill failures are not modeled.","Stop-first is used when candle-level order is ambiguous.","One symbol and 45 days are insufficient for live deployment.","Past simulated performance does not guarantee future results."]}
    (OUT/"BTCUSDT_15M_45D_PRELIMINARY.json").write_text(json.dumps({"summary":report,"trades":trades},ensure_ascii=False,indent=2,default=str),encoding="utf-8")
    pd.DataFrame([{k:v for k,v in t.items() if k!="legs"} for t in trades]).to_csv(OUT/"BTCUSDT_15M_45D_PRELIMINARY_TRADES.csv",index=False,encoding="utf-8-sig")
    r=result; pf="-" if r["profit_factor"] is None else f'{r["profit_factor"]:.3f}'
    md=f'''# BTCUSDT 15분봉 45일 예비 백테스트

> 최종 자동매매 전략 성과가 아니라 가격·거래량 기반 임시 규칙의 1차 기준선입니다.

- 기간: {start} ~ {end}
- 캔들: {len(df):,}개
- 초기 원금 300,000원 / 거래당 최대 30,000원 / 5배
- 분할진입 40·30·30 / 분할청산 30·30·40
- 수수료 편도 12bp / 슬리피지 매회 15bp

| 항목 | 결과 |
|---|---:|
| 최종 평가금액 | {r['final_equity_krw']:,.0f}원 |
| 순손익 | {r['net_pnl_krw']:+,.0f}원 |
| 순수익률 | {r['return_pct']:+.2f}% |
| 거래 수 | {r['trades']}회 |
| 승률 | {r['win_rate_pct']:.2f}% |
| Profit Factor | {pf} |
| 거래당 기대값 | {r['expectancy_per_trade_krw']:+,.0f}원 |
| 최대낙폭 | {r['maximum_drawdown_pct']:.2f}% |
| 최대 연속손실 | {r['maximum_consecutive_losses']}회 |
| 총 수수료 | {r['total_fees_krw']:,.0f}원 |
| 추정 슬리피지 비용 | {r['estimated_slippage_cost_krw']:,.0f}원 |

## 롱·숏

| 방향 | 거래 | 승률 | 순손익 |
|---|---:|---:|---:|
| 롱 | {r['long']['trades']} | {r['long']['win_rate_pct']:.2f}% | {r['long']['net_pnl_krw']:+,.0f}원 |
| 숏 | {r['short']['trades']} | {r['short']['win_rate_pct']:.2f}% | {r['short']['net_pnl_krw']:+,.0f}원 |

## 판정

- {'비용 차감 후 양수였지만 표본이 부족해 실주문 근거로 사용할 수 없습니다.' if r['net_pnl_krw']>0 else '비용 차감 후 음수이므로 현재 임시 규칙 그대로는 실주문 후보로 채택하면 안 됩니다.'}
- 다음에는 다종목·다시장 구간·워크포워드 검증이 필요합니다.
'''
    (OUT/"BTCUSDT_15M_45D_PRELIMINARY.md").write_text(md,encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False,indent=2,default=str))

if __name__=="__main__":
    data=fetch_candles(); result,trades=run(data); save(data,result,trades)
