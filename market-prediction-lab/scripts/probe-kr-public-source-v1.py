#!/usr/bin/env python3
from __future__ import annotations
import json
import traceback
import requests
import pandas as pd

START="2023-04-01"
END="2026-04-01"

def emit(kind, **payload):
    print(json.dumps({"kind": kind, **payload}, ensure_ascii=False), flush=True)

def frame_meta(name, df):
    if df is None:
        emit(name, ok=False, error="NONE")
        return
    emit(
        name,
        ok=True,
        rows=int(len(df)),
        columns=[str(c) for c in df.columns],
        firstIndex=str(df.index.min()) if len(df) else None,
        lastIndex=str(df.index.max()) if len(df) else None,
        head=df.head(2).reset_index().astype(str).to_dict("records") if len(df) else [],
    )

def naver_direct(symbol):
    url="https://api.finance.naver.com/siseJson.naver"
    params={
        "symbol": symbol,
        "requestType": "1",
        "startTime": "20230401",
        "endTime": "20260401",
        "timeframe": "day",
    }
    r=requests.get(url, params=params, timeout=30, headers={"User-Agent":"Mozilla/5.0"})
    emit("naver_direct_http", symbol=symbol, status=r.status_code, bytes=len(r.content), preview=r.text[:180])
    r.raise_for_status()

def main():
    import FinanceDataReader as fdr
    emit("version", financeDataReader=getattr(fdr, "__version__", "unknown"))

    listing_results={}
    for market, args in [
        ("KRX", ("KRX",)),
        ("KOSPI", ("KOSPI",)),
        ("KOSDAQ", ("KOSDAQ",)),
        ("KRX_DELISTING_ALL", ("KRX-DELISTING",)),
        ("KRX_DELISTING_FROM_2023", ("KRX-DELISTING", "2023")),
        ("KRX_DELISTING_3Y", ("KRX-DELISTING", "2023", "2026")),
    ]:
        try:
            df=fdr.StockListing(*args)
            listing_results[market]=df
            frame_meta("listing_"+market, df)
        except Exception as exc:
            emit("listing_"+market, ok=False, error=repr(exc), trace=traceback.format_exc()[-1200:])

    for label, symbol, kwargs in [
        ("samsung", "005930", {}),
        ("ecoprobm", "247540", {}),
        ("delisted", "068400", {"exchange":"KRX-DELISTING"}),
    ]:
        try:
            df=fdr.DataReader(symbol, START, END, **kwargs)
            frame_meta("price_"+label, df)
        except Exception as exc:
            emit("price_"+label, ok=False, error=repr(exc), trace=traceback.format_exc()[-1200:])

    for symbol in ["005930","247540"]:
        try:
            naver_direct(symbol)
        except Exception as exc:
            emit("naver_direct_error", symbol=symbol, ok=False, error=repr(exc))

    current = listing_results.get("KRX")
    kosdaq = listing_results.get("KOSDAQ")
    samsung_ok=False
    kosdaq_px_ok=False
    try:
        samsung_ok=len(fdr.DataReader("005930", START, END)) >= 600
    except Exception:
        pass
    try:
        kosdaq_px_ok=len(fdr.DataReader("247540", START, END)) >= 400
    except Exception:
        pass

    verdict={
        "currentListingUsable": current is not None and len(current) >= 2000,
        "kosdaqListingUsable": kosdaq is not None and len(kosdaq) >= 1000,
        "currentPriceUsable": samsung_ok,
        "kosdaqPriceUsable": kosdaq_px_ok,
    }
    emit("VERDICT", **verdict)

if __name__=="__main__":
    main()
