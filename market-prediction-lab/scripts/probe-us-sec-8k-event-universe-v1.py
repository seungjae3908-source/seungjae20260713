#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import pandas as pd
import requests
import duckdb

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

    # Ticker map: SEC direct first, then public GitHub mirror.
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

    # SEC full-index is 403-blocked from GitHub Actions. Use a public
    # Hugging Face mirror of the SEC master index instead.
    dataset="DenyTranDFW/SEC_Master_Index_Files_Lists"
    meta_url="https://datasets-server.huggingface.co/parquet"
    meta=requests.get(
        meta_url,
        params={"dataset":dataset},
        timeout=60,
        headers={"User-Agent":"market-prediction-lab/1.0 research-only"},
    )
    meta.raise_for_status()
    payload=meta.json()
    parquet_urls=[
        str(x.get("url"))
        for x in payload.get("parquet_files") or []
        if x.get("split")=="train" and x.get("url")
    ]
    if not parquet_urls:
        raise RuntimeError("HF_SEC_MASTER_PARQUET_URLS_EMPTY")

    con=duckdb.connect()
    con.execute("SET threads=4")
    con.execute("SET enable_progress_bar=false")
    quoted="["+",".join(repr(u) for u in parquet_urls)+"]"
    query=f"""
      SELECT
        CAST(cik AS BIGINT) AS cik,
        CAST(company_name AS VARCHAR) AS company,
        CAST(form_type AS VARCHAR) AS form,
        CAST(date_filed AS DATE) AS filingDate,
        CAST(filename AS VARCHAR) AS filename,
        CAST(yr AS VARCHAR) AS yr,
        CAST(qtr AS VARCHAR) AS qtr
      FROM read_parquet({quoted})
      WHERE CAST(yr AS INTEGER) BETWEEN 2023 AND 2026
        AND CAST(date_filed AS DATE) >= DATE '2023-04-01'
        AND CAST(date_filed AS DATE) < DATE '2026-10-01'
        AND CAST(form_type AS VARCHAR) IN ('8-K','8-K/A')
    """
    df=con.execute(query).df()
    con.close()
    if df.empty:
        raise RuntimeError("HF_SEC_8K_PROBE_NO_ROWS")

    df["filingDate"]=pd.to_datetime(df["filingDate"],errors="coerce")
    df=df.dropna(subset=["cik","filingDate"]).copy()
    df["tickerCandidates"]=df["cik"].map(lambda x:cik_to_tickers.get(int(x),[]))
    df["ticker"]=df["tickerCandidates"].map(lambda xs:xs[0] if xs else None)
    df["mapped"]=df["ticker"].notna()
    mapped=df[df["mapped"]].copy()
    mapped["month"]=mapped["filingDate"].dt.strftime("%Y-%m")
    mapped["tickerCandidateCount"]=mapped["tickerCandidates"].map(len)
    mapped["filingDate"]=mapped["filingDate"].dt.strftime("%Y-%m-%d")

    mapped.drop(columns=["tickerCandidates"]).to_csv(out/"mapped-8k-events.csv",index=False)

    raw=len(df);m=len(mapped)
    by_q=(
        df.groupby(["yr","qtr"]).size().reset_index(name="rows8k")
        .sort_values(["yr","qtr"])
    )
    by_q.to_csv(out/"quarter-audit.csv",index=False)

    result={
        "schemaVersion":2,
        "contract":"us-sec-8k-event-universe-probe-v1",
        "period":[str(START.date()),str(END.date())],
        "masterIndexSource":"HF_MIRROR_DENYTRANDFW",
        "tickerMapSource":ticker_source,
        "parquetFiles":len(parquet_urls),
        "raw8kRows":raw,
        "mapped8kRows":m,
        "mappingCoverage":float(m/max(raw,1)),
        "uniqueMappedTickers":int(mapped["ticker"].nunique()),
        "uniqueMappedCiks":int(mapped["cik"].nunique()),
        "multiTickerRows":int((mapped["tickerCandidateCount"]>1).sum()),
        "uniqueEventDates":int(mapped["filingDate"].nunique()),
        "byMonth":{str(k):int(v) for k,v in mapped.groupby("month").size().to_dict().items()},
        "byQuarter":by_q.to_dict("records"),
        "truthBoundary":{
            "probeOnlyNoReturnsLoaded":True,
            "masterIndexMirrorDerivedFromSecMasterIdx":True,
            "sameDayTradingForbiddenInFutureBacktest":True,
            "futureBacktestMustUseNextTradeableSession":True,
            "currentTickerMapMayHaveSurvivorshipCoverageLimit":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
