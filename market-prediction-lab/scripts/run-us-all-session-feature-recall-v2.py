#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
from pathlib import Path

import duckdb
import pandas as pd

ROOT=Path(__file__).resolve().parents[2]

def load(name:str, path:Path):
    spec=importlib.util.spec_from_file_location(name,path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{name}")
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

probe=load(
    "us_all_session_probe",
    ROOT/"market-prediction-lab/scripts/run-us-all-session-opportunity-probe-v1.py",
)
census=load(
    "census_v2",
    ROOT/"market-prediction-lab/scripts/run-full-universe-3pct-hunter-census-v2.py",
)

MONTHS_DEFAULT=("2023-06","2024-12","2026-03")

GATES={
    "BROAD_ACTIVITY": """
      rvol60 >= 1.10
      OR dollarAccel5 >= 1.10
      OR abs(ret5) >= 0.005
      OR abs(ret15) >= 0.010
      OR rangePct >= 0.005
      OR distHigh30 >= -0.020
      OR distLow30 <= 0.020
      OR closeLoc >= 0.70
    """,
    "FLOW_PROXY": """
      rvol60 >= 1.50
      OR dollarAccel5 >= 1.30
      OR abs(ret5) >= 0.010
      OR abs(ret15) >= 0.020
      OR rangePct >= 0.010
    """,
}

FEATURE_TESTS={
    "RVOL_GE_2":"rvol60 >= 2.0",
    "DOLLAR_ACCEL_GE_1_5":"dollarAccel5 >= 1.5",
    "ABS_RET5_GE_1PCT":"abs(ret5) >= 0.01",
    "ABS_RET15_GE_2PCT":"abs(ret15) >= 0.02",
    "NEAR_HIGH30":"distHigh30 >= -0.01",
    "NEAR_LOW30":"distLow30 <= 0.01",
    "ABOVE_VWAP":"vwapDist >= 0",
    "CLOSE_LOC_GE_0_8":"closeLoc >= 0.80",
}

ELIGIBLE="""
  close >= 1.0
  AND priorDollar60 >= 100000
"""

POSITIVE="futureHigh >= entryPrice*1.03"
STRICT="futureHigh >= entryPrice*1.03 AND futureLow > entryPrice*(1.0-0.015)"

def month_metrics(path:Path, month:str)->dict:
    con=duckdb.connect()
    base=probe.query_sql(path)

    overall_sql=base+f"""
    SELECT
      count(*) AS states,
      count(DISTINCT symbol) AS symbols,
      count(*) FILTER (WHERE {POSITIVE}) AS mfe3States,
      count(*) FILTER (WHERE {STRICT}) AS strict3States,
      count(DISTINCT symbol || ':' || CAST(date AS VARCHAR) || ':' || CAST(floor(epoch(ts)/900) AS VARCHAR))
        FILTER (WHERE {POSITIVE}) AS mfe3Buckets,
      count(*) FILTER (
        WHERE tm >= TIME '09:30:00' AND tm < TIME '09:35:00'
          AND {POSITIVE}
      ) AS opening5Mfe3,
      count(*) FILTER (
        WHERE NOT (tm >= TIME '09:30:00' AND tm < TIME '09:35:00')
          AND {POSITIVE}
      ) AS outsideOpening5Mfe3
    FROM f WHERE {ELIGIBLE}
    """
    row=con.execute(overall_sql).fetchone()
    cols=[d[0] for d in con.description]
    overall=dict(zip(cols,row))

    gates=[]
    for name,expr in GATES.items():
        q=base+f"""
        SELECT
          count(*) FILTER (WHERE ({expr})) AS keptStates,
          count(*) FILTER (WHERE ({expr}) AND {POSITIVE}) AS capturedMfe3,
          count(*) FILTER (WHERE ({expr}) AND {STRICT}) AS capturedStrict3,
          count(DISTINCT symbol || ':' || CAST(date AS VARCHAR) || ':' || CAST(floor(epoch(ts)/900) AS VARCHAR))
            FILTER (WHERE ({expr}) AND {POSITIVE}) AS capturedMfe3Buckets
        FROM f WHERE {ELIGIBLE}
        """
        r=con.execute(q).fetchone()
        c=[d[0] for d in con.description]
        z=dict(zip(c,r))
        gates.append({
            "gate":name,
            **{k:int(v or 0) for k,v in z.items()},
            "stateCompression":float((z["keptStates"] or 0)/max(overall["states"] or 0,1)),
            "mfe3Recall":float((z["capturedMfe3"] or 0)/max(overall["mfe3States"] or 0,1)),
            "strict3Recall":float((z["capturedStrict3"] or 0)/max(overall["strict3States"] or 0,1)),
            "mfe3BucketRecall":float((z["capturedMfe3Buckets"] or 0)/max(overall["mfe3Buckets"] or 0,1)),
        })

    feature_rows=[]
    base_positive_rate=float((overall["mfe3States"] or 0)/max(overall["states"] or 0,1))
    for name,expr in FEATURE_TESTS.items():
        q=base+f"""
        SELECT
          count(*) FILTER (WHERE ({expr})) AS states,
          count(*) FILTER (WHERE ({expr}) AND {POSITIVE}) AS mfe3
        FROM f WHERE {ELIGIBLE}
        """
        r=con.execute(q).fetchone()
        states=int(r[0] or 0); pos=int(r[1] or 0)
        rate=pos/max(states,1)
        feature_rows.append({
            "featureTest":name,
            "states":states,
            "mfe3":pos,
            "mfe3Rate":rate,
            "liftVsBaseline":rate/max(base_positive_rate,1e-12),
            "mfe3CaptureShare":pos/max(int(overall["mfe3States"] or 0),1),
        })
    con.close()

    return {
        "month":month,
        "overall":{k:int(v or 0) for k,v in overall.items()},
        "baselineMfe3Rate":base_positive_rate,
        "opening5ShareOfMfe3":float((overall["opening5Mfe3"] or 0)/max(overall["mfe3States"] or 0,1)),
        "outsideOpening5ShareOfMfe3":float((overall["outsideOpening5Mfe3"] or 0)/max(overall["mfe3States"] or 0,1)),
        "gates":gates,
        "featureTests":feature_rows,
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--month",action="append",default=[])
    ap.add_argument("--out-dir",required=True)
    args=ap.parse_args()
    months=tuple(args.month) if args.month else MONTHS_DEFAULT
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)

    results=[]
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        for month in months:
            m=pd.Timestamp(month+"-01",tz="UTC")
            p=root/f"ohlcv_{month}.parquet"
            census._download_us_month(m,p)
            met=month_metrics(p,month)
            results.append(met)
            print(json.dumps({
                "month":month,
                "states":met["overall"]["states"],
                "mfe3":met["overall"]["mfe3States"],
                "outsideOpening5Share":met["outsideOpening5ShareOfMfe3"],
                "gates":[
                    {"gate":g["gate"],"compression":g["stateCompression"],"recall":g["mfe3Recall"]}
                    for g in met["gates"]
                ],
            },ensure_ascii=False),flush=True)
            p.unlink(missing_ok=True)

    gate_summary={}
    for gate in GATES:
        kept=sum(next(x for x in r["gates"] if x["gate"]==gate)["keptStates"] for r in results)
        cap=sum(next(x for x in r["gates"] if x["gate"]==gate)["capturedMfe3"] for r in results)
        capb=sum(next(x for x in r["gates"] if x["gate"]==gate)["capturedMfe3Buckets"] for r in results)
        total_states=sum(r["overall"]["states"] for r in results)
        total_pos=sum(r["overall"]["mfe3States"] for r in results)
        total_buckets=sum(r["overall"]["mfe3Buckets"] for r in results)
        gate_summary[gate]={
            "keptStates":kept,
            "stateCompression":kept/max(total_states,1),
            "capturedMfe3":cap,
            "mfe3Recall":cap/max(total_pos,1),
            "capturedMfe3Buckets":capb,
            "mfe3BucketRecall":capb/max(total_buckets,1),
        }

    result={
        "schemaVersion":1,
        "contract":"us-all-session-feature-recall-v2",
        "months":list(months),
        "monthly":results,
        "gateSummary":gate_summary,
        "truthBoundary":{
            "allMinuteStatesScannedBeforeGate":True,
            "gateRecallMeasuredAgainstAllEligibleMfe3States":True,
            "opening5NotUsedAsRequirement":True,
            "featuresUseOnlyCurrentAndPastBars":True,
            "futureHighLowUsedOnlyForLabels":True,
            "clockTime60MinuteLabel":True,
            "thisStageOptimizesRecallBeforePrecision":True,
            "notYetATradingStrategy":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }
    (out/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+"\n",encoding="utf-8")
    pd.DataFrame([
        {"month":r["month"],**x}
        for r in results for x in r["featureTests"]
    ]).to_csv(out/"feature-lift.csv",index=False)
    pd.DataFrame([
        {"month":r["month"],**x}
        for r in results for x in r["gates"]
    ]).to_csv(out/"gate-recall.csv",index=False)
    print(json.dumps({"FINAL":result},ensure_ascii=False,default=str),flush=True)

if __name__=="__main__":
    main()
