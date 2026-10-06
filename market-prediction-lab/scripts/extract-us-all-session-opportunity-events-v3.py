#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[2]

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{name}")
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

probe=load("us_probe",ROOT/"market-prediction-lab/scripts/run-us-all-session-opportunity-probe-v1.py")
census=load("census",ROOT/"market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py")

FEATURES=[
    "ret1","ret5","ret15","rvol60","dollarAccel5","rangePct","closeLoc",
    "distHigh30","distLow30","vwapDist","minuteOfSession","logPrice","logPriorDollar",
]

def period_for(month:str)->str:
    if month<"2024-10": return "train"
    if month<"2025-04": return "calibration"
    if month<"2025-10": return "validation"
    if month<"2026-03": return "fresh_oos"
    return "diagnostic"

def extract_month(path:Path,month:str,negative_sample_pct:int)->tuple[pd.DataFrame,dict]:
    con=duckdb.connect()
    base=probe.query_sql(path)
    q=base+f"""
    , eligible AS (
      SELECT
        symbol,ts,date,tm,sessionPart,entryTime,entryPrice,futureHigh,futureLow,
        ret1,ret5,ret15,rvol60,dollarAccel5,rangePct,closeLoc,
        distHigh30,distLow30,vwapDist,priorDollar60,close,
        date_diff('minute', CAST(date AS TIMESTAMP)+INTERVAL '4 hours', ts) AS minuteOfSession,
        ln(greatest(close,0.000001)) AS logPrice,
        ln(greatest(priorDollar60,1.0)) AS logPriorDollar,
        floor(epoch(ts)/900) AS bucket15,
        CASE WHEN futureHigh >= entryPrice*1.03 THEN 1 ELSE 0 END AS labelMfe3,
        CASE WHEN futureHigh >= entryPrice*1.05 THEN 1 ELSE 0 END AS labelMfe5,
        CASE WHEN futureHigh >= entryPrice*1.10 THEN 1 ELSE 0 END AS labelMfe10,
        CASE WHEN futureHigh >= entryPrice*1.03 AND futureLow > entryPrice*0.985 THEN 1 ELSE 0 END AS labelStrict3,
        futureHigh/entryPrice-1.0 AS forwardMFE,
        1.0-futureLow/entryPrice AS forwardMAE
      FROM f
      WHERE close>=1.0
        AND priorDollar60>=100000
    ),
    ranked AS (
      SELECT
        *,
        max(labelMfe3) OVER (PARTITION BY symbol,bucket15) AS bucketHasMfe3,
        row_number() OVER (
          PARTITION BY symbol,bucket15
          ORDER BY labelMfe3 DESC, ts ASC
        ) AS bucketRow
      FROM eligible
    )
    SELECT
      symbol,ts AS timestamp,date,sessionPart,entryTime,entryPrice,
      {",".join(FEATURES)},
      labelMfe3,labelMfe5,labelMfe10,labelStrict3,forwardMFE,forwardMAE,
      bucketHasMfe3,bucket15
    FROM ranked
    WHERE bucketRow=1
      AND (
        bucketHasMfe3=1
        OR (hash(symbol || ':' || CAST(bucket15 AS VARCHAR)) % 100) < {int(negative_sample_pct)}
      )
    ORDER BY timestamp,symbol
    """
    df=con.execute(q).fetchdf()
    countq=base+"""
    , eligible_count AS (
      SELECT
        symbol,
        floor(epoch(ts)/900) AS bucket15,
        CASE WHEN futureHigh>=entryPrice*1.03 THEN 1 ELSE 0 END AS labelMfe3
      FROM f
      WHERE close>=1.0 AND priorDollar60>=100000
    ),
    bucket_count AS (
      SELECT symbol,bucket15,max(labelMfe3) AS bucketHasMfe3
      FROM eligible_count
      GROUP BY symbol,bucket15
    )
    SELECT
      (SELECT count(*) FROM eligible_count) AS states,
      (SELECT count(*) FROM eligible_count WHERE labelMfe3=1) AS mfe3States,
      (SELECT count(*) FROM bucket_count WHERE bucketHasMfe3=1) AS mfe3Buckets
    """
    cnt=con.execute(countq).fetchone()
    con.close()

    df["period"]=period_for(month)
    df["month"]=month
    df["sessionCode"]=df["sessionPart"].map({"PRE":0,"REG":1,"POST":2}).astype("int8")
    # Event-cluster ID for positive sampled buckets. Consecutive positive buckets
    # within <=60 clock minutes are one underlying opportunity episode.
    df["eventCluster"]=pd.NA
    pos=df[df["labelMfe3"]==1].copy()
    if len(pos):
        clusters=[]
        next_id=0
        for symbol,g in pos.sort_values("timestamp").groupby("symbol",sort=False):
            last=None
            for idx,row in g.iterrows():
                t=pd.Timestamp(row["timestamp"])
                if last is None or (t-last)>pd.Timedelta(minutes=60):
                    next_id+=1
                clusters.append((idx,next_id))
                last=t
        for idx,cid in clusters:
            df.at[idx,"eventCluster"]=cid

    audit={
        "month":month,
        "period":period_for(month),
        "allEligibleStates":int(cnt[0] or 0),
        "allMfe3States":int(cnt[1] or 0),
        "allMfe3Buckets":int(cnt[2] or 0),
        "sampleRows":int(len(df)),
        "samplePositiveBuckets":int((df["labelMfe3"]==1).sum()),
        "positiveBucketRepresentatives":int((df["bucketHasMfe3"]==1).sum()),
        "representativePositiveMismatch":int(((df["bucketHasMfe3"]==1)&(df["labelMfe3"]!=1)).sum()),
        "sampleNegativeBuckets":int((df["labelMfe3"]==0).sum()),
        "sampleStrict3":int(df["labelStrict3"].sum()) if len(df) else 0,
        "positiveEventClusters":int(df["eventCluster"].nunique(dropna=True)),
    }
    if audit["representativePositiveMismatch"] != 0:
        raise RuntimeError(
            f"POSITIVE_REPRESENTATIVE_MISMATCH:{month}:{audit['representativePositiveMismatch']}"
        )
    if audit["samplePositiveBuckets"] != audit["allMfe3Buckets"]:
        raise RuntimeError(
            f"POSITIVE_BUCKET_LOSS:{month}:{audit['samplePositiveBuckets']}/{audit['allMfe3Buckets']}"
        )
    return df,audit

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--month",action="append",required=True)
    ap.add_argument("--negative-sample-pct",type=int,default=3)
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    if not 1<=args.negative_sample_pct<=100:
        raise ValueError("negative-sample-pct must be 1..100")
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    frames=[];audits=[]

    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for month in args.month:
            p=root/f"ohlcv_{month}.parquet"
            census._download_us_month(pd.Timestamp(month+"-01",tz="UTC"),p)
            df,audit=extract_month(p,month,args.negative_sample_pct)
            frames.append(df);audits.append(audit)
            p.unlink(missing_ok=True)
            print(json.dumps({"extracted":audit},ensure_ascii=False),flush=True)

    data=pd.concat(frames,ignore_index=True) if frames else pd.DataFrame()
    if data.empty:
        raise RuntimeError("NO_US_ALL_SESSION_EVENT_SAMPLE")
    data.to_parquet(out/"events.parquet",index=False)
    pd.DataFrame(audits).to_csv(out/"month-audit.csv",index=False)

    result={
        "schemaVersion":1,
        "contract":"us-all-session-opportunity-events-v3",
        "months":list(args.month),
        "negativeSamplePct":args.negative_sample_pct,
        "featureColumns":FEATURES+["sessionCode"],
        "audits":audits,
        "totalRows":int(len(data)),
        "totalPositiveBuckets":int((data["labelMfe3"]==1).sum()),
        "totalNegativeBuckets":int((data["labelMfe3"]==0).sum()),
        "periodCounts":{str(k):int(v) for k,v in data["period"].value_counts().to_dict().items()},
        "truthBoundary":{
            "fullUniverseScannedBeforeSampling":True,
            "allPositive15mBucketsRetained":True,
            "onlyNegativeBucketsDownsampled":True,
            "sampleSelectionDoesNotUseValidationForModelChoice":True,
            "featuresUseCurrentAndPastOnly":True,
            "futureDataUsedOnlyAsLabels":True,
            "clockTime60MinuteLabels":True,
            "openingTimeNotRequired":True,
            "preRegularPostEligible":True,
            "freshOosEndsBefore2026MarchDiagnosticMonth":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
