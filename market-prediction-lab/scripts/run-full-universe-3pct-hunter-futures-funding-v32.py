#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import requests

TRAIN_END = pd.Timestamp("2025-04-01").date()
VALID_END = pd.Timestamp("2026-04-01").date()
BENCH_END = pd.Timestamp("2026-10-01").date()

FUNDING_OVERLAYS = {
    "FUNDING_POS": lambda x: x["fundingPrev"] > 0.0,
    "FUNDING_GE_0_005PCT": lambda x: x["fundingPrev"] >= 0.00005,
    "FUNDING_GE_0_01PCT": lambda x: x["fundingPrev"] >= 0.00010,
    "FUNDING_GE_0_02PCT": lambda x: x["fundingPrev"] >= 0.00020,
    "FUNDING_NEG": lambda x: x["fundingPrev"] < 0.0,
    "FUNDING_LE_NEG_0_005PCT": lambda x: x["fundingPrev"] <= -0.00005,
    "MEAN3_POS": lambda x: x["fundingMean3"] > 0.0,
    "MEAN3_GE_0_005PCT": lambda x: x["fundingMean3"] >= 0.00005,
    "MEAN3_GE_0_01PCT": lambda x: x["fundingMean3"] >= 0.00010,
    "PREV_AND_MEAN3_POS": lambda x: (x["fundingPrev"] > 0.0) & (x["fundingMean3"] > 0.0),
    "PREV_POS_MEAN3_GE_0_005PCT": lambda x: (x["fundingPrev"] > 0.0) & (x["fundingMean3"] >= 0.00005),
    "ABS_FUNDING_GE_0_01PCT": lambda x: x["fundingPrev"].abs() >= 0.00010,
}

BASE_EXPECTED = "FLOW_RECLAIM_SHORT_T0.4_RV2.5_TOP1_TP5_SL0.015_H32__OI15_LT_NEG_0_3"
COST = 0.0012


def import_metrics():
    import importlib.util
    root = Path(__file__).resolve().parents[2]
    path = root / "market-prediction-lab" / "scripts" / "run-full-universe-3pct-hunter-causal-backtest-v1.py"
    spec = importlib.util.spec_from_file_location("hunter_v1", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("V1_IMPORT_FAILED")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.metrics


def archive_url(symbol: str, month: str) -> str:
    return (
        "https://data.binance.vision/data/futures/um/monthly/fundingRate/"
        f"{symbol}/{symbol}-fundingRate-{month}.zip"
    )


def previous_month(month: str) -> str:
    return str(pd.Period(month, freq="M") - 1)


def fetch_funding(symbol: str, month: str):
    url = archive_url(symbol, month)
    last = None
    for attempt in range(4):
        try:
            r = requests.get(
                url,
                timeout=45,
                headers={"User-Agent":"market-prediction-lab/futures-funding-v32"},
            )
            if r.status_code == 404:
                return (symbol, month), None, "404"
            if r.status_code in (429,500,502,503,504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
                names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
                if not names:
                    return (symbol, month), None, "NO_CSV"
                df = pd.read_csv(zf.open(names[0]))
            needed = {"calc_time","funding_interval_hours","last_funding_rate"}
            if not needed.issubset(df.columns):
                return (symbol, month), None, f"BAD_SCHEMA:{list(df.columns)}"
            df["calc_time"] = pd.to_numeric(df["calc_time"], errors="coerce")
            df["last_funding_rate"] = pd.to_numeric(df["last_funding_rate"], errors="coerce")
            df["funding_interval_hours"] = pd.to_numeric(df["funding_interval_hours"], errors="coerce")
            df = df.dropna(subset=["calc_time","last_funding_rate","funding_interval_hours"]).copy()
            if df.empty:
                return (symbol, month), None, "EMPTY"
            unit = "us" if float(df["calc_time"].median()) > 1e14 else "ms"
            df["fundingTime"] = pd.to_datetime(
                df["calc_time"].astype("int64"),
                unit=unit,
                utc=True,
                errors="coerce",
            )
            df = df.dropna(subset=["fundingTime"]).sort_values("fundingTime").reset_index(drop=True)
            return (symbol, month), df[["fundingTime","last_funding_rate","funding_interval_hours"]], None
        except Exception as exc:
            last = exc
            time.sleep(min(2 + attempt * 2, 8))
    return (symbol, month), None, repr(last)


def load_source(input_root: Path):
    summaries = list(input_root.glob("**/summary.json"))
    ledgers = list(input_root.glob("**/winner-ledger.csv"))
    if not summaries:
        raise RuntimeError("SOURCE_SUMMARY_MISSING")
    if not ledgers:
        raise RuntimeError("SOURCE_WINNER_LEDGER_MISSING")

    summary = None
    for p in summaries:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if data.get("contract") == "full-universe-3pct-hunter-futures-oi-v31":
            summary = data
            break
    if summary is None:
        raise RuntimeError("SOURCE_CONTRACT_MISMATCH")
    if summary.get("winner") != BASE_EXPECTED:
        raise RuntimeError(f"UNEXPECTED_SOURCE_WINNER:{summary.get('winner')}")
    if not summary.get("truthBoundary",{}).get("metricsAvailabilityShiftFrom2026_06_25Applied"):
        raise RuntimeError("SOURCE_OI_AVAILABILITY_SHIFT_NOT_PROVEN")

    ledger_path = ledgers[0]
    df = pd.read_csv(ledger_path)
    required = {
        "date","timestamp","symbol","direction","baseCandidate",
        "entryPrice","exitPrice","grossReturn","roundTripCost","netReturn",
        "MFE","MAE","oi15","oi60","topPosRatio","allAccountRatio",
    }
    missing = required - set(df.columns)
    if missing:
        raise RuntimeError(f"SOURCE_LEDGER_COLUMNS_MISSING:{sorted(missing)}")

    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["date","timestamp","symbol","netReturn"]).copy()
    if df.empty:
        raise RuntimeError("SOURCE_LEDGER_EMPTY")
    return summary, df, str(ledger_path)


def enrich_funding(df: pd.DataFrame):
    pairs = set()
    for row in df.itertuples(index=False):
        month = pd.Timestamp(row.timestamp).strftime("%Y-%m")
        pairs.add((str(row.symbol), month))
        pairs.add((str(row.symbol), previous_month(month)))

    cache = {}
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futs = {
            pool.submit(fetch_funding, sym, month):(sym,month)
            for sym,month in sorted(pairs)
        }
        for idx,fut in enumerate(concurrent.futures.as_completed(futs),1):
            key, data, err = fut.result()
            if data is not None and not data.empty:
                cache[key] = data
            else:
                failures.append({"symbol":key[0],"month":key[1],"error":err})
            if idx % 100 == 0 or idx == len(futs):
                print(json.dumps({
                    "fundingFilesComplete":idx,
                    "requested":len(futs),
                    "usable":len(cache),
                    "failed":len(failures),
                }), flush=True)

    out = []
    for row in df.to_dict("records"):
        t = pd.Timestamp(row["timestamp"])
        if t.tzinfo is None:
            t = t.tz_localize("UTC")
        else:
            t = t.tz_convert("UTC")
        signal_close = t + pd.Timedelta(minutes=15)
        month = t.strftime("%Y-%m")
        frames = []
        for m in (previous_month(month), month):
            x = cache.get((str(row["symbol"]), m))
            if x is not None:
                frames.append(x)
        if not frames:
            continue
        f = pd.concat(frames, ignore_index=True).sort_values("fundingTime").drop_duplicates("fundingTime")
        pos = int(f["fundingTime"].searchsorted(signal_close, side="right") - 1)
        if pos < 0:
            continue
        hist = f.iloc[:pos+1]
        cur = hist.iloc[-1]
        last3 = hist.tail(3)
        row.update({
            "signalCloseTime": signal_close,
            "fundingTime": cur["fundingTime"],
            "fundingPrev": float(cur["last_funding_rate"]),
            "fundingMean3": float(last3["last_funding_rate"].mean()),
            "fundingSum3": float(last3["last_funding_rate"].sum()),
            "fundingIntervalHours": float(cur["funding_interval_hours"]),
            "fundingObs3": int(len(last3)),
        })
        out.append(row)

    if not out:
        raise RuntimeError("FUNDING_ENRICHMENT_EMPTY")
    coverage = len(out) / max(len(df),1)
    if coverage < 0.90:
        raise RuntimeError(f"FUNDING_COVERAGE_TOO_LOW:{len(out)}/{len(df)}")
    return pd.DataFrame(out), {
        "requestedFiles":len(pairs),
        "usableFiles":len(cache),
        "failedFiles":len(failures),
        "failurePreview":failures[:30],
        "tradeRowsBeforeFunding":len(df),
        "tradeRowsWithFunding":len(out),
        "rowCoverage":coverage,
    }


def gate(m: dict, min_trades: int):
    checks = {
        "positiveReturn": float(m.get("totalReturn") or 0) > 0,
        "profitFactorAbove1": float(m.get("profitFactor") or 0) > 1,
        "positiveMonthRateAtLeast50pct": float(m.get("positiveMonthRate") or 0) >= 0.50,
        "mddAtMost35pct": float(m.get("mdd") or 1) <= 0.35,
        "minimumTrades": int(m.get("tradeCount") or 0) >= min_trades,
    }
    return {"pass":all(checks.values()),"checks":checks}


def rank_key(m: dict, name: str):
    return (
        float(m.get("positiveMonthRate") or 0),
        float(m.get("totalReturn") or 0),
        float(m.get("profitFactor") or 0),
        -float(m.get("mdd") or 0),
        int(m.get("tradeCount") or 0),
        name,
    )


def to_pl(pdf: pd.DataFrame) -> pl.DataFrame:
    if pdf.empty:
        return pl.DataFrame(schema={"date":pl.Date,"netReturn":pl.Float64})
    return pl.from_pandas(pdf).with_columns(pl.col("date").cast(pl.Date))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-root",required=True)
    ap.add_argument("--out-dir",required=True)
    args = ap.parse_args()

    input_root = Path(args.input_root)
    out = Path(args.out_dir)
    out.mkdir(parents=True,exist_ok=True)
    (out/"run-started.json").write_text(
        json.dumps({
            "contract":"full-universe-3pct-hunter-futures-funding-v32",
            "status":"STARTED",
            "executionAuthority":"NONE",
        },indent=2)+"\n",
        encoding="utf-8",
    )

    source_summary, ledger, ledger_path = load_source(input_root)
    enriched, funding_audit = enrich_funding(ledger)
    metrics_fn = import_metrics()

    train_dates=[d.date() for d in pd.date_range("2023-05-01","2025-03-31",freq="D")]
    valid_dates=[d.date() for d in pd.date_range("2025-04-01","2026-03-31",freq="D")]
    bench_dates=[d.date() for d in pd.date_range("2026-04-01","2026-09-30",freq="D")]

    grid=[]
    reports={}
    train_pdf=enriched[enriched["date"] < TRAIN_END].copy()
    valid_pdf=enriched[(enriched["date"] >= TRAIN_END) & (enriched["date"] < VALID_END)].copy()

    for name,fn in FUNDING_OVERLAYS.items():
        train_mask=fn(train_pdf).fillna(False)
        valid_mask=fn(valid_pdf).fillna(False)
        tr=train_pdf.loc[train_mask].copy()
        va=valid_pdf.loc[valid_mask].copy()

        mt=metrics_fn(to_pl(tr),"CRYPTO_FUTURES",train_dates)
        mv=metrics_fn(to_pl(va),"CRYPTO_FUTURES",valid_dates)
        gt=gate(mt,60)
        gv=gate(mv,30)

        reports[name]={"train":mt,"validation":mv,"trainGate":gt,"validationGate":gv}
        grid.append({
            "overlay":name,
            "trainPass":gt["pass"],
            "trainReturn":mt.get("totalReturn"),
            "trainPF":mt.get("profitFactor"),
            "trainMDD":mt.get("mdd"),
            "trainPosMonthRate":mt.get("positiveMonthRate"),
            "trainTrades":mt.get("tradeCount"),
            "validationPass":gv["pass"],
            "validationReturn":mv.get("totalReturn"),
            "validationPF":mv.get("profitFactor"),
            "validationMDD":mv.get("mdd"),
            "validationPosMonthRate":mv.get("positiveMonthRate"),
            "validationTrades":mv.get("tradeCount"),
        })

    train_pass=[n for n,d in reports.items() if d["trainGate"]["pass"]]
    valid_pass=[n for n in train_pass if reports[n]["validationGate"]["pass"]]
    winner=sorted(valid_pass,key=lambda n:rank_key(reports[n]["validation"],n),reverse=True)[0] if valid_pass else None

    summary={
        "schemaVersion":1,
        "contract":"full-universe-3pct-hunter-futures-funding-v32",
        "sourceOiWinner":source_summary.get("winner"),
        "sourceLedger":ledger_path,
        "fundingSource":"Binance Public Data monthly fundingRate archive",
        "candidateCount":len(grid),
        "trainPassCount":len(train_pass),
        "validationPassCount":len(valid_pass),
        "winner":winner,
        "benchmarkPreviouslyExposed":True,
        "benchmarkEvaluated":False,
        "fundingAudit":funding_audit,
        "truthBoundary":{
            "fundingUsesLastKnownRateAtOrBeforeSignalClose":True,
            "fundingArchiveUsedInsteadOfGeoBlockedRestApi":True,
            "fundingOverlaySelectedWithout2026_04_to_09Rows":True,
            "benchmark2026_04_to_09IsNotIndependentOos":True,
            "profitabilityProven":False,
            "executionAuthority":"NONE",
        },
    }

    pd.DataFrame(grid).to_csv(out/"candidate-grid.csv",index=False)

    if winner:
        fn=FUNDING_OVERLAYS[winner]
        bench_pdf=enriched[(enriched["date"] >= VALID_END) & (enriched["date"] < BENCH_END)].copy()
        bench=bench_pdf.loc[fn(bench_pdf).fillna(False)].copy()
        mb=metrics_fn(to_pl(bench),"CRYPTO_FUTURES",bench_dates)
        gb=gate(mb,15)
        summary["benchmarkEvaluated"]=True
        summary["winnerResults"]={
            "train":reports[winner]["train"],
            "trainGate":reports[winner]["trainGate"],
            "validation":reports[winner]["validation"],
            "validationGate":reports[winner]["validationGate"],
            "postHocBenchmark":mb,
            "postHocBenchmarkGate":gb,
        }
        bench.to_csv(out/"winner-benchmark-ledger.csv",index=False)
        chosen=pd.concat([
            train_pdf.loc[fn(train_pdf).fillna(False)],
            valid_pdf.loc[fn(valid_pdf).fillna(False)],
            bench,
        ],ignore_index=True)
        chosen.to_csv(out/"winner-ledger.csv",index=False)

    (out/"summary.json").write_text(
        json.dumps(summary,ensure_ascii=False,indent=2)+"\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL":summary},ensure_ascii=False),flush=True)


if __name__=="__main__":
    main()
