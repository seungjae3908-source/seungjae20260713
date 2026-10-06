from __future__ import annotations
import numpy as np, pandas as pd, polars as pl

def compound(vals):
    w=1.0
    for v in vals: w*=1.0+float(v)
    return w-1.0

def metrics(trades, market, time_col="tradeTime"):
    if trades.is_empty():
        return {"tradeCount":0,"totalReturn":0.0,"mdd":0.0,"winRate":None,"profitFactor":None,"monthsPositive":0,"monthsNegative":0,"monthsTotal":0,"positiveMonthRate":None,"windows":{}}
    x=trades.with_columns(pl.col(time_col).cast(pl.Datetime,strict=False).alias("_ts")).sort("_ts")
    daily=(x.with_columns(pl.col("_ts").dt.date().alias("_day")).group_by("_day").agg([pl.col("netReturn").mean().alias("r"),pl.len().alias("trades")]).sort("_day").to_pandas())
    daily["_day"]=pd.to_datetime(daily["_day"]); daily["r"]=daily["r"].astype(float)
    w=1.0; peak=1.0; mdd=0.0
    for r in daily["r"]:
        w*=1+float(r); peak=max(peak,w); mdd=max(mdd,(peak-w)/peak)
    arr=x["netReturn"].to_numpy(); pos=float(arr[arr>0].sum()) if np.any(arr>0) else 0.0; neg=float(-arr[arr<0].sum()) if np.any(arr<0) else 0.0
    daily["month"]=daily["_day"].dt.to_period("M")
    monthly=daily.groupby("month")["r"].apply(lambda s: float(np.prod(1+s.to_numpy())-1))
    wins=[("1D",1),("1W",5 if market in ("US_STOCK","KR_STOCK") else 7),("1M",21 if market in ("US_STOCK","KR_STOCK") else 30),("3M",63 if market in ("US_STOCK","KR_STOCK") else 90),("6M",126 if market in ("US_STOCK","KR_STOCK") else 183),("1Y",252 if market in ("US_STOCK","KR_STOCK") else 365),("3Y",None)]
    outw={}
    for k,n in wins:
        sub=daily if n is None else daily.tail(n)
        outw[k]={"return":compound(sub["r"].tolist()) if len(sub) else 0.0,"tradeCount":int(sub["trades"].sum()) if len(sub) else 0}
    return {"tradeCount":int(x.height),"totalReturn":float(w-1),"mdd":float(mdd),"winRate":float((arr>0).mean()),"profitFactor":pos/neg if neg>0 else (999.0 if pos>0 else 0.0),"monthsPositive":int((monthly>0).sum()),"monthsNegative":int((monthly<0).sum()),"monthsTotal":int(len(monthly)),"positiveMonthRate":float((monthly>0).mean()) if len(monthly) else None,"windows":outw}

def choose_key(m,name):
    return (float(m.get("positiveMonthRate") or 0),float(m.get("totalReturn") or 0),float(m.get("profitFactor") or 0),-float(m.get("mdd") or 1),int(m.get("tradeCount") or 0),name)

def gate(m):
    c={"positiveReturn":float(m.get("totalReturn") or 0)>0,"profitFactorAbove1":float(m.get("profitFactor") or 0)>1,"positiveMonthRateAtLeast50pct":float(m.get("positiveMonthRate") or 0)>=0.5,"mddAtMost35pct":float(m.get("mdd") or 1)<=0.35,"atLeast50Trades":int(m.get("tradeCount") or 0)>=50}
    return {"pass":all(c.values()),"checks":c}
