#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


bitget = load(
    "bitget_v49",
    "market-prediction-lab/scripts/run-crypto-futures-v48-bitget-exact1m-v49.py",
)

TARGET = 0.03
STOP = 0.015
ENTRY_SLIPPAGE = 0.0005
ROUND_TRIP_COST = 0.0012
EXTRA_STRESS = 0.0010
MAX_WORKERS = 6


def replay_long(row: dict):
    symbol = str(row["symbol"])
    entry_time = pd.Timestamp(row["entryTime"])
    bars, audit = bitget.fetch_event_path(symbol, entry_time)
    if bars is None:
        return None, {"symbol": symbol, "entryTime": str(entry_time), **audit}

    expected = pd.Timestamp(entry_time)
    if expected.tzinfo is None:
        expected = expected.tz_localize("UTC")
    else:
        expected = expected.tz_convert("UTC")
    expected = expected.floor("min")

    first = bars[bars["timestamp"] == expected]
    if first.empty:
        return None, {"symbol": symbol, "entryTime": str(entry_time), "error": "NO_EXACT_ENTRY_CANDLE"}
    raw_open = float(first.iloc[0]["open"])
    entry = raw_open * (1.0 + ENTRY_SLIPPAGE)
    if not np.isfinite(entry) or entry <= 0:
        return None, {"symbol": symbol, "entryTime": str(entry_time), "error": "BAD_ENTRY"}

    tp = entry * (1.0 + TARGET)
    sl = entry * (1.0 - STOP)
    exit_px = None
    exit_t = None
    reason = None
    highs = []
    lows = []
    prev = None

    for _, b in bars.iterrows():
        ts = pd.Timestamp(b["timestamp"])
        if prev is not None and ts - prev > pd.Timedelta(minutes=2):
            return None, {
                "symbol": symbol,
                "entryTime": str(entry_time),
                "error": f"PATH_GAP:{prev}->{ts}",
            }
        prev = ts
        hi = float(b["high"])
        lo = float(b["low"])
        highs.append(hi)
        lows.append(lo)
        # Conservative ambiguity: stop first.
        if lo <= sl:
            exit_px = sl
            exit_t = ts
            reason = "STOP"
            break
        if hi >= tp:
            exit_px = tp
            exit_t = ts
            reason = "TARGET"
            break

    hold_end = expected + pd.Timedelta(hours=8)
    if exit_px is None:
        last = bars.iloc[-1]
        last_t = pd.Timestamp(last["timestamp"])
        if last_t < hold_end - pd.Timedelta(minutes=2):
            return None, {
                "symbol": symbol,
                "entryTime": str(entry_time),
                "error": f"INCOMPLETE_TIME_PATH:{last_t}<{hold_end}",
            }
        exit_px = float(last["close"])
        exit_t = last_t
        reason = "TIME"

    gross = exit_px / entry - 1.0
    net = gross - ROUND_TRIP_COST
    binance_raw = float(row["entryPriceExec"]) / (1.0 + ENTRY_SLIPPAGE)
    basis = raw_open / binance_raw - 1.0 if binance_raw > 0 else np.nan

    return {
        "timestamp": pd.Timestamp(row["timestamp"]),
        "symbol": symbol,
        "period": str(row["period"]),
        "score": float(row.get("score", np.nan)),
        "entryTime": expected,
        "exitTime": exit_t,
        "bitgetEntryOpen": raw_open,
        "entryPriceExec": entry,
        "exitPrice": float(exit_px),
        "exitReason": reason,
        "grossReturn": float(gross),
        "netReturn": float(net),
        "MFE": float(np.nanmax(highs)) / entry - 1.0,
        "MAE": 1.0 - float(np.nanmin(lows)) / entry,
        "targetFirst3": 1 if reason == "TARGET" else 0,
        "binanceReferenceOpen": binance_raw,
        "openBasis": float(basis),
        "bitgetBarsUsed": int(len(highs)),
    }, {"symbol": symbol, "entryTime": str(entry_time), "ok": True, **audit}


def metrics(df: pd.DataFrame, extra_cost: float = 0.0):
    if df.empty:
        return {
            "rows": 0,
            "meanNet": 0.0,
            "profitFactor": 0.0,
            "targetFirstRate": 0.0,
            "positiveMonths": 0,
            "negativeMonths": 0,
            "positiveActiveMonthRate": 0.0,
        }
    net = pd.to_numeric(df["netReturn"], errors="coerce").to_numpy(float) - float(extra_cost)
    gp = float(np.maximum(net, 0).sum())
    gl = float(np.maximum(-net, 0).sum())
    months = pd.to_datetime(df["entryTime"], utc=True).dt.strftime("%Y-%m")
    ms = pd.DataFrame({"month": months.to_numpy(), "net": net}).groupby("month")["net"].sum()
    pm = int((ms > 0).sum())
    nm = int((ms < 0).sum())
    return {
        "rows": int(len(df)),
        "meanNet": float(net.mean()),
        "profitFactor": float(gp / max(gl, 1e-12)),
        "targetFirstRate": float(pd.to_numeric(df["targetFirst3"], errors="coerce").fillna(0).mean()),
        "positiveMonths": pm,
        "negativeMonths": nm,
        "positiveActiveMonthRate": float(pm / max(pm + nm, 1)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh-events", required=True)
    ap.add_argument("--source-summary", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    prior = json.loads(Path(args.source_summary).read_text(encoding="utf-8"))
    if prior.get("contract") != "crypto-futures-causal-long-opportunity-ranker-v542":
        raise RuntimeError("V544_WRONG_SOURCE_CONTRACT")

    events = pd.read_parquet(args.fresh_events)
    events["timestamp"] = pd.to_datetime(events["timestamp"], utc=True)
    events["entryTime"] = pd.to_datetime(events["entryTime"], utc=True)
    events = events[events["period"].astype(str) == "fresh_oos"].copy()
    events = events.sort_values(["entryTime", "score", "symbol"], ascending=[True, False, True])
    if events.empty:
        raise RuntimeError("V544_NO_FRESH_EVENTS")

    rows = []
    audits = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = [pool.submit(replay_long, r) for r in events.to_dict("records")]
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            try:
                rr, aa = fut.result()
            except Exception as exc:
                rr = None
                aa = {"error": repr(exc)}
            if rr is not None:
                rows.append(rr)
            audits.append(aa)
            if idx % 20 == 0 or idx == len(futs):
                print(
                    json.dumps(
                        {
                            "eventsComplete": idx,
                            "events": len(futs),
                            "exactRows": len(rows),
                            "failed": idx - len(rows),
                        }
                    ),
                    flush=True,
                )

    exact = pd.DataFrame(rows)
    pd.DataFrame(audits).to_csv(out / "source-audit.csv", index=False)
    if exact.empty:
        raise RuntimeError("V544_NO_BITGET_EXACT_ROWS")
    exact.to_parquet(out / "bitget-fresh-exact-events.parquet", index=False)

    requested = int(len(events))
    coverage = float(len(exact) / max(requested, 1))
    basis = pd.to_numeric(exact["openBasis"], errors="coerce").dropna().abs()
    base = metrics(exact, 0.0)
    stress = metrics(exact, EXTRA_STRESS)

    checks = {
        "pathCoverageAtLeast80pct": coverage >= 0.80,
        "medianAbsOpenBasisAtMost50bp": bool(len(basis) and float(basis.median()) <= 0.005),
        "positiveEV": base["meanNet"] > 0,
        "profitFactorAbove1": base["profitFactor"] > 1,
        "plus10bpPositiveEV": stress["meanNet"] > 0,
        "plus10bpProfitFactorAbove1": stress["profitFactor"] > 1,
    }

    result = {
        "schemaVersion": 1,
        "contract": "crypto-futures-v542-bitget-fresh-v544",
        "sourceRunV542": 37475568221,
        "sourceThreshold": prior.get("calibrationSelection", {}).get("winner", {}).get("threshold"),
        "requestedFreshEvents": requested,
        "exactBitgetRows": int(len(exact)),
        "pathCoverage": coverage,
        "distinctSymbols": int(exact["symbol"].astype(str).nunique()),
        "basisDiagnostic": {
            "medianAbsOpenBasis": float(basis.median()) if len(basis) else None,
            "p95AbsOpenBasis": float(basis.quantile(0.95)) if len(basis) else None,
        },
        "metrics": base,
        "plus10bp": stress,
        "portabilityDiagnostic": {"pass": bool(all(checks.values())), "checks": checks},
        "promotionPass": False,
        "truthBoundary": {
            "signalsAndThresholdFrozenFromV542": True,
            "freshEventsPreviouslyExposedDiagnosticOnly": True,
            "bitgetPublicExactOneMinutePath": True,
            "entryUsesFrozenV542EntryTime": True,
            "longEntrySlippageApplied": ENTRY_SLIPPAGE,
            "roundTripCostApplied": ROUND_TRIP_COST,
            "sameMinuteTargetStopUsesStopFirst": True,
            "noThresholdRetuning": True,
            "noCandidateReselection": True,
            "fundingNotYetApplied": True,
            "requiresPostFreezeForwardForPromotion": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": result}, ensure_ascii=False, default=str), flush=True)


if __name__ == "__main__":
    main()
