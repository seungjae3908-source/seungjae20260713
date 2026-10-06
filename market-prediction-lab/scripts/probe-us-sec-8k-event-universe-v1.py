#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import pandas as pd
import requests

START=pd.Timestamp("2023-04-01")
END=pd.Timestamp("2026-10-01")
SEC_BASE="https://www.sec.gov"
HEADERS={
    "User-Agent":"market-prediction-lab/1.0 research-only contact=https://github.com/seungjae3908-source/seungjae20260713",
    "Accept-Encoding":"gzip, deflate",
}

def get_text(url:str, attempts:int=6)->str:
    last=None
    for i in range(attempts):
        try:
            r=requests.get(url,headers=HEADERS,timeout=60)
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            time.sleep(0.12)
            return r.text
        except Exception as exc:
            last=exc
            time.sleep(min(1+i*2,8))
    raise RuntimeError(f"SEC_FETCH_FAILED:{url}:{last}")

def get_json(url:str):
    return json.loads(get_text(url))

def quarters():
    for year in range(2023,2027):
        for q in range(1,5):
            qstart=pd.Timestamp(year,1+(q-1)*3,1)
            qend=qstart+pd.offsets.QuarterEnd(startingMonth=q*3)
            if qend < START or qstart >= END:
                continue
            yield year,q

def parse_form_idx(text:str):
    rows=[]
    bad=0
    in_body=False
    for raw in text.splitlines():
        line=raw.rstrip("\n")
        if not in_body:
            if re.match(r"^-{5,}",line.strip()):
                in_body=True
            continue
        if not line.strip():
            continue
        parts=re.split(r"\s{2,}",line.strip(),maxsplit=4)
        if len(parts)!=5:
            bad+=1
            continue
        form,company,cik,date_s,filename=parts
        if form not in {"8-K","8-K/A"}:
            continue
        try:
            d=pd.Timestamp(date_s)
            cik_i=int(cik)
        except Exception:
            bad+=1
            continue
        if d<START or d>=END:
            continue
        rows.append({
            "form":form,"company":company,"cik":cik_i,
            "filingDate":d.strftime("%Y-%m-%d"),"filename":filename,
        })
    return rows,bad

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    ticker_source="SEC_DIRECT"
    try:
        tickers=get_json(f"{SEC_BASE}/files/company_tickers.json")
        ticker_rows=[
            (int(rec["cik_str"]),str(rec.get("ticker") or "").upper().strip())
            for rec in tickers.values()
            if rec.get("ticker")
        ]
    except Exception:
        ticker_source="GITHUB_MIRROR_ANCALAGAN_SEC_DATA"
        mirror=get_json("https://raw.githubusercontent.com/Ancalagan/sec-data/main/company_tickers.json")
        fields=mirror.get("fields") or []
        data=mirror.get("data") or []
        idx={str(name):i for i,name in enumerate(fields)}
        ticker_rows=[]
        for row in data:
            try:
                cik=int(row[idx["cik"]])
                ticker=str(row[idx["ticker"]] or "").upper().strip()
            except Exception:
                continue
            if ticker:
                ticker_rows.append((cik,ticker))
    cik_to_tickers={}
    for cik,ticker in ticker_rows:
        cik_to_tickers.setdefault(cik,[]).append(ticker)

    all_rows=[]
    audit=[]
    for year,q in quarters():
        url=f"{SEC_BASE}/Archives/edgar/full-index/{year}/QTR{q}/form.idx"
        try:
            txt=get_text(url)
            rows,bad=parse_form_idx(txt)
            all_rows.extend(rows)
            audit.append({"year":year,"quarter":q,"status":"OK","rows8k":len(rows),"badLines":bad})
        except Exception as exc:
            audit.append({"year":year,"quarter":q,"status":"ERROR","error":repr(exc),"rows8k":0})
        print(json.dumps({"quartersComplete":len(audit),"last":audit[-1],"rawRows":len(all_rows)}),flush=True)

    if not all_rows:
        raise RuntimeError("SEC_8K_PROBE_NO_ROWS")

    df=pd.DataFrame(all_rows)
    df["tickerCandidates"]=df["cik"].map(lambda x:cik_to_tickers.get(int(x),[]))
    df["ticker"]=df["tickerCandidates"].map(lambda xs:xs[0] if xs else None)
    df["mapped"]=df["ticker"].notna()
    mapped=df[df["mapped"]].copy()
    mapped["month"]=pd.to_datetime(mapped["filingDate"]).dt.strftime("%Y-%m")
    mapped["tickerCandidateCount"]=mapped["tickerCandidates"].map(len)

    mapped.drop(columns=["tickerCandidates"]).to_csv(out/"mapped-8k-events.csv",index=False)
    pd.DataFrame(audit).to_csv(out/"quarter-audit.csv",index=False)

    raw=len(df);m=len(mapped)
    result={
        "schemaVersion":1,
        "contract":"us-sec-8k-event-universe-probe-v1",
        "period":[str(START.date()),str(END.date())],
        "tickerMapSource":ticker_source,
        "quartersRequested":len(audit),
        "quartersOk":sum(1 for x in audit if x.get("status")=="OK"),
        "quartersFailed":sum(1 for x in audit if x.get("status")!="OK"),
        "raw8kRows":raw,
        "mapped8kRows":m,
        "mappingCoverage":float(m/max(raw,1)),
        "uniqueMappedTickers":int(mapped["ticker"].nunique()),
        "uniqueMappedCiks":int(mapped["cik"].nunique()),
        "multiTickerCiks":int((mapped["tickerCandidateCount"]>1).sum()),
        "uniqueEventDates":int(mapped["filingDate"].nunique()),
        "byMonth":{str(k):int(v) for k,v in mapped.groupby("month").size().to_dict().items()},
        "quarterAudit":audit,
        "truthBoundary":{
            "probeOnlyNoReturnsLoaded":True,
            "secFullIndexFilingDateOnly":True,
            "sameDayTradingForbiddenInFutureBacktest":True,
            "futureBacktestMustUseNextTradeableSession":True,
            "currentSecTickerMapMayHaveSurvivorshipCoverageLimit":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False),flush=True)

if __name__=="__main__":
    main()
