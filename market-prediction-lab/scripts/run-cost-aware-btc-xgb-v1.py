#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import math
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from xgboost import XGBRegressor

START = pd.Timestamp("2023-08-10", tz="UTC")
END = pd.Timestamp("2026-08-09 23:59:59", tz="UTC")
WARMUP = pd.Timestamp("2022-01-01", tz="UTC")
SYMBOL = "BTCUSDT"
COST = 0.001
LAMBDA = 2.0

BASE_FEATURES = [
    "ret1", "ret2", "ret6", "ret12", "ret24", "ret72", "ret168",
    "ema10_ratio", "ema20_ratio", "ema50_ratio", "rsi14", "atr_pct",
    "vol_z24", "range_pct", "body_pct", "close_location",
]
RICH_FEATURES = BASE_FEATURES + [
    "structure_state", "bos_up", "bos_down", "latest_leg_dir", "latest_leg_atr",
    "retracement_ratio", "bullish_engulfing", "bearish_engulfing", "inside_bar",
    "bullish_pin", "bearish_pin", "bullish_harami", "bearish_harami",
    "flow_1", "flow_6", "flow_24",
]
SESSION=requests.Session()
SESSION.headers.update({"User-Agent":"market-prediction-lab/cost-aware-btc-xgb-v1"})


def months(start,end):
    cur=pd.Timestamp(start.year,start.month,1,tz="UTC")
    out=[]
    while cur<=end:
        out.append(cur.strftime("%Y-%m"))
        cur=cur+pd.offsets.MonthBegin(1)
    return out


def nts(raw):
    v=int(float(raw))
    return v//1000 if v>=100_000_000_000_000 else v


def fetch_month(month):
    base="https://data.binance.vision/data/futures/um/monthly/klines"
    url=f"{base}/{SYMBOL}/1h/{SYMBOL}-1h-{month}.zip"
    ck=SESSION.get(url+".CHECKSUM",timeout=30); ck.raise_for_status()
    expected=ck.text.strip().split()[0].lower()
    r=SESSION.get(url,timeout=60); r.raise_for_status()
    raw=r.content
    if hashlib.sha256(raw).hexdigest()!=expected:
        raise RuntimeError("CHECKSUM_MISMATCH:"+month)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names=[n for n in z.namelist() if n.lower().endswith(".csv")]
        text=z.read(names[0]).decode("utf-8-sig")
    rows=[]
    for i,line in enumerate(text.splitlines()):
        p=line.strip().split(",")
        if not p: continue
        if i==0 and not p[0].replace(".","",1).isdigit(): continue
        if len(p)<10: continue
        try:
            t=nts(p[0]); o,h,l,c,v=map(float,p[1:6]); tb=float(p[9])
        except: continue
        if min(o,h,l,c)<=0 or v<0 or tb<0: continue
        rows.append((pd.to_datetime(t,unit="ms",utc=True),o,h,l,c,v,tb))
    return pd.DataFrame(rows,columns=["timestamp","open","high","low","close","volume","taker_buy"])


def load():
    ms=months(WARMUP,END)
    frames={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        futs={ex.submit(fetch_month,m):m for m in ms}
        for f in concurrent.futures.as_completed(futs):
            frames[futs[f]]=f.result()
    df=pd.concat([frames[m] for m in ms],ignore_index=True)
    return df.drop_duplicates("timestamp").sort_values("timestamp").reset_index(drop=True)


def ema(s,n): return s.ewm(span=n,adjust=False,min_periods=n).mean()


def rsi(s,n=14):
    d=s.diff()
    up=d.clip(lower=0).ewm(alpha=1/n,adjust=False,min_periods=n).mean()
    dn=(-d.clip(upper=0)).ewm(alpha=1/n,adjust=False,min_periods=n).mean()
    rs=up/dn.replace(0,np.nan)
    return 100-100/(1+rs)


def structure(df):
    n=len(df); highs=df.high.to_numpy(); lows=df.low.to_numpy(); closes=df.close.to_numpy(); atr=df.atr.to_numpy()
    piv=[]
    for i in range(2,n-2):
        if highs[i]>max(highs[i-2:i]) and highs[i]>=max(highs[i+1:i+3]): piv.append((i+2,i,"H",highs[i]))
        if lows[i]<min(lows[i-2:i]) and lows[i]<=min(lows[i+1:i+3]): piv.append((i+2,i,"L",lows[i]))
    piv.sort()
    state=np.zeros(n); bosu=np.zeros(n); bosd=np.zeros(n); leg=np.zeros(n); lega=np.zeros(n); retr=np.zeros(n)
    p=0; lh=ll=None; ph=pl=None; confirmed=[]; prev=closes[0]
    for t in range(n):
        while p<len(piv) and piv[p][0]<=t:
            _,idx,k,price=piv[p]
            if k=="H":
                cls=None if ph is None else ("HH" if price>ph else "LH")
                ph=price; lh=(idx,price,cls)
            else:
                cls=None if pl is None else ("HL" if price>pl else "LL")
                pl=price; ll=(idx,price,cls)
            confirmed.append((idx,k,price,cls)); p+=1
        if lh and ll:
            if lh[2]=="HH" and ll[2]=="HL": state[t]=1
            elif lh[2]=="LH" and ll[2]=="LL": state[t]=-1
            if closes[t]>lh[1] and prev<=lh[1]: bosu[t]=1
            if closes[t]<ll[1] and prev>=ll[1]: bosd[t]=1
        u=[x for x in confirmed if x[0]<=t]
        if len(u)>=2 and np.isfinite(atr[t]) and atr[t]>0:
            a,b=u[-2],u[-1]
            leg[t]=1 if b[2]>a[2] else -1 if b[2]<a[2] else 0
            lega[t]=abs(b[2]-a[2])/atr[t]
            if len(u)>=3:
                c=u[-3]; prior=abs(a[2]-c[2]); retr[t]=abs(b[2]-a[2])/prior if prior else 0
        prev=closes[t]
    df["structure_state"]=state; df["bos_up"]=bosu; df["bos_down"]=bosd
    df["latest_leg_dir"]=leg; df["latest_leg_atr"]=lega; df["retracement_ratio"]=retr
    return df


def features(df):
    d=df.copy()
    c,o,h,l,v=d.close,d.open,d.high,d.low,d.volume
    prev=c.shift(1)
    for k in [1,2,6,12,24,72,168]: d[f"ret{k}"]=c.pct_change(k)
    for n in [10,20,50]: d[f"ema{n}_ratio"]=c/ema(c,n)-1
    d["rsi14"]=rsi(c)
    tr=pd.concat([(h-l),(h-prev).abs(),(l-prev).abs()],axis=1).max(axis=1)
    d["atr"]=tr.rolling(14).mean(); d["atr_pct"]=d.atr/c
    d["vol_z24"]=(v-v.rolling(24).mean())/v.rolling(24).std().replace(0,np.nan)
    d["range_pct"]=(h-l)/prev; d["body_pct"]=c/o-1
    d["close_location"]=(c-l)/(h-l).replace(0,np.nan)
    po,pc,ph,pl=o.shift(1),c.shift(1),h.shift(1),l.shift(1)
    bull,bear=c>o,c<o; pbull,pbear=pc>po,pc<po
    d["bullish_engulfing"]=(bull&pbear&(o<=pc)&(c>=po)).astype(float)
    d["bearish_engulfing"]=(bear&pbull&(o>=pc)&(c<=po)).astype(float)
    d["inside_bar"]=((h<ph)&(l>pl)).astype(float)
    rng=(h-l).replace(0,np.nan); body=(c-o).abs()
    upper=h-pd.concat([o,c],axis=1).max(axis=1); lower=pd.concat([o,c],axis=1).min(axis=1)-l
    d["bullish_pin"]=((body/rng<=.35)&(lower>=body*2)&(lower>=upper*1.5)).astype(float)
    d["bearish_pin"]=((body/rng<=.35)&(upper>=body*2)&(upper>=lower*1.5)).astype(float)
    d["bullish_harami"]=(pbear&bull&(o>=pc)&(c<=po)).astype(float)
    d["bearish_harami"]=(pbull&bear&(o<=pc)&(c>=po)).astype(float)
    flow=(2*d.taker_buy-v)/v.replace(0,np.nan)
    d["flow_1"]=flow; d["flow_6"]=flow.rolling(6).mean(); d["flow_24"]=flow.rolling(24).mean()
    d=structure(d)
    d["target_log_ret"]=np.log(c.shift(-1)/c)
    d["simple_ret_next"]=c.shift(-1)/c-1
    return d


def folds():
    out=[]; cur=START
    while cur<=END:
        test_end=min(cur+pd.DateOffset(months=3)-pd.Timedelta(seconds=1),END)
        val_end=cur-pd.Timedelta(seconds=1); val_start=val_end-pd.DateOffset(months=3)+pd.Timedelta(seconds=1)
        train_end=val_start-pd.Timedelta(seconds=1); train_start=train_end-pd.DateOffset(months=12)+pd.Timedelta(seconds=1)
        out.append((train_start,train_end,val_start,val_end,cur,test_end))
        cur=test_end+pd.Timedelta(seconds=1)
    return out


def metrics(rows,changes):
    if rows.empty:
        return {"positionChanges":0,"totalReturn":0,"cagr":0,"sharpe":None,"mdd":0,"profitFactor":0,"positiveHourRate":0}
    rs=rows.net_ret.to_numpy(); wealth=float(np.prod(1+rs))
    years=max((rows.timestamp.max()-rows.timestamp.min()).total_seconds()/(365.25*86400),1/365.25)
    cagr=wealth**(1/years)-1 if wealth>0 else -1
    eq=np.cumprod(1+rs); peak=np.maximum.accumulate(eq); mdd=float(np.max((peak-eq)/peak))
    daily=rows.assign(day=rows.timestamp.dt.floor("D")).groupby("day").net_ret.apply(lambda x:float(np.prod(1+x)-1))
    sharpe=float(daily.mean()/daily.std(ddof=1)*math.sqrt(365)) if len(daily)>1 and daily.std(ddof=1)>0 else None
    pos=rows.loc[rows.net_ret>0,"net_ret"].sum(); neg=-rows.loc[rows.net_ret<0,"net_ret"].sum()
    return {"positionChanges":int(changes),"totalReturn":wealth-1,"cagr":float(cagr),"sharpe":sharpe,"mdd":mdd,
            "profitFactor":float(pos/neg) if neg>0 else 999.0,"positiveHourRate":float((rows.net_ret>0).mean())}


def windows(rows):
    if rows.empty:return {}
    daily=rows.assign(day=rows.timestamp.dt.floor("D")).groupby("day").net_ret.apply(lambda x:float(np.prod(1+x)-1))
    daily=daily.reindex(pd.date_range(START.floor("D"),END.floor("D"),tz="UTC"),fill_value=0)
    w=(1+daily).cumprod()
    def tr(days):
        base=w[w.index<w.index[-1]-pd.Timedelta(days=days)]
        return float(w.iloc[-1]/(base.iloc[-1] if len(base) else 1)-1)
    return {"1d":float(daily.iloc[-1]),"1w":tr(7),"1m":tr(30),"6m":tr(182),"1y":tr(365),"3y":float(w.iloc[-1]-1)}


def run_variant(df,name,cols):
    clean=df.dropna(subset=cols+["target_log_ret","simple_ret_next"]).replace([np.inf,-np.inf],np.nan).dropna(subset=cols)
    pieces=[]; previous_position=0; changes=0; fold_stats=[]
    for train_start,train_end,val_start,val_end,test_start,test_end in folds():
        train=clean[(clean.timestamp>=train_start)&(clean.timestamp<=val_end)]
        test=clean[(clean.timestamp>=test_start)&(clean.timestamp<=test_end)].copy()
        if len(train)<5000 or test.empty: continue
        model=XGBRegressor(
            n_estimators=350,max_depth=4,learning_rate=.03,min_child_weight=20,
            subsample=.8,colsample_bytree=.8,reg_lambda=1.0,reg_alpha=0.0,
            objective="reg:squarederror",random_state=42,n_jobs=2,tree_method="hist",
        )
        model.fit(train[cols],train.target_log_ret)
        test["forecast"]=model.predict(test[cols])
        returns=[]
        for row in test.itertuples():
            desired=1 if row.forecast>0 else 0
            turnover=abs(desired-previous_position)
            if turnover>0 and abs(row.forecast)>LAMBDA*COST*turnover:
                position=desired; changes+=1
            else:
                position=previous_position
            net=position*row.simple_ret_next-COST*abs(position-previous_position)
            returns.append((row.timestamp,net,position,row.forecast))
            previous_position=position
        piece=pd.DataFrame(returns,columns=["timestamp","net_ret","position","forecast"])
        pieces.append(piece)
        fold_stats.append({"testStart":test_start.isoformat(),"testEnd":test_end.isoformat(),"rows":len(piece)})
    rows=pd.concat(pieces,ignore_index=True) if pieces else pd.DataFrame()
    if not rows.empty and previous_position!=0:
        rows.loc[rows.index[-1],"net_ret"]-=COST
        changes+=1
    m=metrics(rows,changes)
    return {"market":"CRYPTO_FUTURES","candidate":name,"metrics":m,"windows":windows(rows),
            "meta":{"kind":"XGBOOST_COST_AWARE","costPerTurnover":COST,"lambda":LAMBDA,"features":cols,
                    "walkForward":"12m_train+3m_validation_history_to_3m_test_fixed_params","folds":fold_stats},
            "survivor":m["totalReturn"]>0 and m["profitFactor"]>1 and m["positionChanges"]>=30 and m["mdd"]<.70}


def self_test():
    assert LAMBDA==2.0 and COST==0.001
    # Enter only when forecast clears 2x one-unit cost.
    assert not (0.0019 > LAMBDA*COST*1)
    assert 0.0021 > LAMBDA*COST*1
    print("SELF_TEST_PASS")


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--output",default="docs/cost-aware-btc-xgb-v1-result.json"); ap.add_argument("--self-test",action="store_true")
    args=ap.parse_args()
    if args.self_test: self_test(); return
    started=time.time(); df=features(load())
    results=[
        run_variant(df,"BTC_XGB_COST_AWARE_TECH",BASE_FEATURES),
        run_variant(df,"BTC_XGB_COST_AWARE_TECH_WAVE_CANDLE_FLOW",RICH_FEATURES),
    ]
    survivors=sorted([x for x in results if x["survivor"]],key=lambda x:x["metrics"]["totalReturn"],reverse=True)
    report={"schemaVersion":1,"contract":"cost-aware-btc-xgb/v1","generatedAt":datetime.now(timezone.utc).isoformat(),
            "period":{"start":START.isoformat(),"end":END.isoformat()},
            "source":{"paper":"Machine Learning-Based Bitcoin Trading Under Transaction Costs","arxiv":"2606.00060",
                      "adaptation":"fixed XGBoost params; paper cost-aware execution c=0.001 lambda=2.0; local 2023-2026 window"},
            "results":results,"profitableSurvivorsOnly":survivors,
            "safety":{"researchOnly":True,"profitabilityProven":False,"promotionEligible":False,"executionAuthority":"NONE",
                      "liveTrading":False,"autoTrading":False,"realOrderEnabled":False},
            "durationSeconds":time.time()-started}
    p=Path(args.output); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({"survivors":[{"candidate":x["candidate"],**x["metrics"],"windows":x["windows"]} for x in survivors],
                      "durationSeconds":report["durationSeconds"],"output":str(p)},indent=2))


if __name__=="__main__": main()
