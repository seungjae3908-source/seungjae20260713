#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


v45 = load(
    "v45",
    "market-prediction-lab/scripts/audit-crypto-futures-v44-robustness-capital-v45.py",
)

BASE = "https://api.bitget.com/api/v2/mix/market/history-fund-rate"
PRODUCT_TYPE = "usdt-futures"
PAGE_SIZE = 100
MAX_PAGES = 100
MAX_WORKERS = 8
MIN_FRESH_ROWS = 100
MIN_FRESH_SYMBOLS = 20
EXTRA_STRESS = 0.0010


class GlobalRateLimiter:
    def __init__(self, limit: int = 12, window: float = 1.0):
        self.limit = limit
        self.window = window
        self.times = deque()
        self.lock = threading.Lock()

    def acquire(self):
        while True:
            wait = 0.0
            with self.lock:
                now = time.monotonic()
                while self.times and now - self.times[0] >= self.window:
                    self.times.popleft()
                if len(self.times) < self.limit:
                    self.times.append(now)
                    return
                wait = max(0.01, self.window - (now - self.times[0]) + 0.01)
            time.sleep(wait)


RATE = GlobalRateLimiter()


def _utc(v) -> pd.Timestamp:
    t = pd.Timestamp(v)
    if t.tzinfo is None:
        return t.tz_localize("UTC")
    return t.tz_convert("UTC")


def fetch_page(symbol: str, page_no: int):
    params = {
        "symbol": symbol,
        "productType": PRODUCT_TYPE,
        "pageSize": str(PAGE_SIZE),
        "pageNo": str(page_no),
    }
    last = None
    for attempt in range(6):
        try:
            RATE.acquire()
            r = requests.get(
                BASE,
                params=params,
                timeout=30,
                headers={"User-Agent": "market-prediction-lab/bitget-actual-funding-v411"},
            )
            if r.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP_{r.status_code}")
            r.raise_for_status()
            payload = r.json()
            if str(payload.get("code")) != "00000":
                return None, f"CODE:{payload.get('code')}:{payload.get('msg')}"
            return payload.get("data") or [], None
        except Exception as exc:
            last = exc
            time.sleep(min(0.5 * (attempt + 1), 3.0))
    return None, repr(last)


def fetch_symbol(symbol: str, target_start: pd.Timestamp):
    rows = []
    failures = []
    empty_page = None
    target_start = _utc(target_start)

    for page in range(1, MAX_PAGES + 1):
        data, err = fetch_page(symbol, page)
        if data is None:
            failures.append({"page": page, "error": err})
            break
        if not data:
            empty_page = page
            break

        for x in data:
            try:
                rows.append(
                    {
                        "symbol": str(x.get("symbol") or symbol),
                        "fundingRate": float(x["fundingRate"]),
                        "fundingTime": pd.to_datetime(
                            int(x["fundingTime"]), unit="ms", utc=True
                        ),
                    }
                )
            except Exception:
                continue

        if rows and min(r["fundingTime"] for r in rows) <= target_start:
            break
        if len(data) < PAGE_SIZE:
            break

    if not rows:
        return (
            {
                "symbol": symbol,
                "ok": False,
                "rows": 0,
                "error": failures[-1]["error"] if failures else "EMPTY",
                "failures": failures[:10],
            },
            None,
        )

    df = (
        pd.DataFrame(rows)
        .drop_duplicates("fundingTime")
        .sort_values("fundingTime")
        .reset_index(drop=True)
    )
    earliest = _utc(df["fundingTime"].min())
    latest = _utc(df["fundingTime"].max())
    audit = {
        "symbol": symbol,
        "ok": True,
        "rows": int(len(df)),
        "earliest": str(earliest),
        "latest": str(latest),
        "reachesFirstFrozenEvent": bool(earliest <= target_start),
        "emptyPage": empty_page,
        "failures": failures[:10],
    }
    return audit, df


def attach_actual_funding(events: pd.DataFrame, histories: dict[str, pd.DataFrame]):
    rows = []
    coverage_rows = []
    for r in events.to_dict("records"):
        symbol = str(r["symbol"])
        a = _utc(r["entryTime"])
        b = _utc(r["exitTime"])
        f = histories.get(symbol)

        covered = False
        reason = None
        actual = None
        obs = 0
        source_earliest = None
        source_latest = None

        if f is None or f.empty:
            reason = "NO_BITGET_FUNDING_HISTORY"
        else:
            source_earliest = _utc(f["fundingTime"].min())
            source_latest = _utc(f["fundingTime"].max())
            if source_earliest > a:
                reason = "HISTORY_STARTS_AFTER_ENTRY"
            elif source_latest < b:
                reason = "HISTORY_ENDS_BEFORE_EXIT"
            else:
                covered = True
                held = f[(f["fundingTime"] > a) & (f["fundingTime"] <= b)]
                actual = float(held["fundingRate"].sum()) if len(held) else 0.0
                obs = int(len(held))

        coverage_rows.append(
            {
                "symbol": symbol,
                "period": str(r["period"]),
                "entryTime": a,
                "exitTime": b,
                "covered": covered,
                "reason": reason,
                "sourceEarliest": source_earliest,
                "sourceLatest": source_latest,
                "fundingObservations": obs,
            }
        )

        if not covered:
            continue

        proxy = float(r.get("fundingReturnShortProxy", 0.0) or 0.0)
        before = float(r["netReturnBeforeFunding"])
        r["entryTime"] = a
        r["exitTime"] = b
        r["fundingReturnShortActualBitget"] = actual
        r["fundingReturnShortProxyFrozen"] = proxy
        r["fundingErrorActualMinusProxy"] = actual - proxy
        r["fundingObservationsActualBitget"] = obs
        r["netReturnWithActualBitgetFunding"] = before + actual
        r["netReturnWithFrozenProxy"] = before + proxy
        rows.append(r)

    return pd.DataFrame(rows), pd.DataFrame(coverage_rows)


def _compact_period_audit(df: pd.DataFrame):
    if df.empty:
        return None

    actual = df.copy()
    actual["netReturn"] = pd.to_numeric(
        actual["netReturnWithActualBitgetFunding"], errors="coerce"
    )
    proxy = df.copy()
    proxy["netReturn"] = pd.to_numeric(
        proxy["netReturnWithFrozenProxy"], errors="coerce"
    )
    stressed = actual.copy()
    stressed["netReturn"] = pd.to_numeric(stressed["netReturn"], errors="coerce") - EXTRA_STRESS

    aa = v45.period_audit(actual)
    pa = v45.period_audit(proxy)
    sa = v45.period_audit(stressed)

    err = pd.to_numeric(df["fundingErrorActualMinusProxy"], errors="coerce").dropna()
    actual_f = pd.to_numeric(
        df["fundingReturnShortActualBitget"], errors="coerce"
    ).dropna()
    proxy_f = pd.to_numeric(
        df["fundingReturnShortProxyFrozen"], errors="coerce"
    ).dropna()

    return {
        "rows": int(len(df)),
        "symbols": int(df["symbol"].astype(str).nunique()),
        "dateRange": {
            "entryMin": str(pd.to_datetime(df["entryTime"], utc=True).min()),
            "exitMax": str(pd.to_datetime(df["exitTime"], utc=True).max()),
        },
        "fundingComparison": {
            "actualMean": float(actual_f.mean()) if len(actual_f) else None,
            "proxyMean": float(proxy_f.mean()) if len(proxy_f) else None,
            "actualSum": float(actual_f.sum()) if len(actual_f) else None,
            "proxySum": float(proxy_f.sum()) if len(proxy_f) else None,
            "meanErrorActualMinusProxy": float(err.mean()) if len(err) else None,
            "meanAbsError": float(err.abs().mean()) if len(err) else None,
            "medianAbsError": float(err.abs().median()) if len(err) else None,
            "p95AbsError": float(err.abs().quantile(0.95)) if len(err) else None,
            "maxAbsError": float(err.abs().max()) if len(err) else None,
        },
        "actualBitgetFunding": {
            "exactMetrics": aa["exactMetrics"],
            "slotCapital": aa["slotCapital"],
            "robustnessGate": aa["robustnessGate"],
        },
        "frozenProxySameOverlap": {
            "exactMetrics": pa["exactMetrics"],
            "slotCapital": pa["slotCapital"],
            "robustnessGate": pa["robustnessGate"],
        },
        "actualBitgetFundingPlus10bp": {
            "exactMetrics": sa["exactMetrics"],
            "slotCapital": sa["slotCapital"],
            "robustnessGate": sa["robustnessGate"],
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--v49-events", required=True)
    ap.add_argument("--v49-summary", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    prior = json.loads(Path(args.v49_summary).read_text(encoding="utf-8"))
    if prior.get("contract") != "crypto-futures-v48-bitget-exact1m-v49":
        raise RuntimeError("V411_WRONG_V49_SOURCE")
    if not bool(prior.get("promotionGate", {}).get("pass")):
        raise RuntimeError("V411_V49_PROMOTION_GATE_NOT_PASS")
    truth = prior.get("truthBoundary", {})
    if not bool(truth.get("signalTimesAndThresholdFrozenBeforeBitgetReplay")):
        raise RuntimeError("V411_V49_SIGNAL_FREEZE_NOT_PROVEN")
    if not bool(truth.get("noThresholdRetuning")):
        raise RuntimeError("V411_V49_RETUNING_BOUNDARY_MISSING")

    events = pd.read_parquet(args.v49_events)
    required = {
        "symbol",
        "period",
        "entryTime",
        "exitTime",
        "netReturnBeforeFunding",
        "fundingReturnShortProxy",
        "score",
        "MFE",
        "MAE",
    }
    missing = required - set(events.columns)
    if missing:
        raise RuntimeError(f"V411_REQUIRED_COLUMNS_MISSING:{sorted(missing)}")

    events["entryTime"] = pd.to_datetime(events["entryTime"], utc=True)
    events["exitTime"] = pd.to_datetime(events["exitTime"], utc=True)
    events["symbol"] = events["symbol"].astype(str)
    events = events.sort_values(
        ["entryTime", "score", "symbol"], ascending=[True, False, True]
    ).reset_index(drop=True)

    first_by_symbol = events.groupby("symbol")["entryTime"].min().to_dict()
    audits = []
    histories = {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {
            pool.submit(fetch_symbol, symbol, first_by_symbol[symbol]): symbol
            for symbol in sorted(first_by_symbol)
        }
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            symbol = futs[fut]
            try:
                audit, df = fut.result()
            except Exception as exc:
                audit = {
                    "symbol": symbol,
                    "ok": False,
                    "rows": 0,
                    "error": repr(exc),
                }
                df = None
            audits.append(audit)
            if df is not None and not df.empty:
                histories[symbol] = df
            if idx % 25 == 0 or idx == len(futs):
                print(
                    json.dumps(
                        {
                            "bitgetFundingSymbolsComplete": idx,
                            "symbols": len(futs),
                            "usable": len(histories),
                        }
                    ),
                    flush=True,
                )

    audit_df = pd.DataFrame(audits).sort_values("symbol")
    audit_df.to_json(
        out / "funding-source-audit.jsonl",
        orient="records",
        lines=True,
        force_ascii=False,
        date_format="iso",
    )

    overlap, coverage = attach_actual_funding(events, histories)
    coverage.to_csv(out / "event-coverage.csv", index=False)

    if overlap.empty:
        raise RuntimeError("V411_NO_FULLY_COVERED_EVENTS")

    overlap.to_parquet(out / "bitget-actual-funding-overlap.parquet", index=False)

    usable_audits = [x for x in audits if x.get("ok")]
    global_earliest = min(
        (_utc(x["earliest"]) for x in usable_audits if x.get("earliest")),
        default=None,
    )
    global_latest = max(
        (_utc(x["latest"]) for x in usable_audits if x.get("latest")),
        default=None,
    )

    period_results = {}
    for period in ("validation", "fresh_oos"):
        all_p = events[events["period"].astype(str) == period].copy()
        cov_p = overlap[overlap["period"].astype(str) == period].copy()
        period_results[period] = {
            "requestedRows": int(len(all_p)),
            "coveredRows": int(len(cov_p)),
            "coverage": float(len(cov_p) / max(len(all_p), 1)),
            "audit": _compact_period_audit(cov_p),
        }

    if global_earliest is not None:
        post_boundary = events[events["entryTime"] >= global_earliest].copy()
        post_cov = overlap[overlap["entryTime"] >= global_earliest].copy()
    else:
        post_boundary = events.iloc[0:0].copy()
        post_cov = overlap.iloc[0:0].copy()

    fresh = period_results["fresh_oos"]
    fresh_audit = fresh["audit"]
    support_checks = {
        "freshOverlapRowsAtLeast100": bool(
            fresh_audit is not None and fresh_audit["rows"] >= MIN_FRESH_ROWS
        ),
        "freshOverlapSymbolsAtLeast20": bool(
            fresh_audit is not None and fresh_audit["symbols"] >= MIN_FRESH_SYMBOLS
        ),
        "freshActualFundingRobustnessPass": bool(
            fresh_audit is not None
            and fresh_audit["actualBitgetFunding"]["robustnessGate"]["pass"]
        ),
        "freshActualFundingPlus10bpRobustnessPass": bool(
            fresh_audit is not None
            and fresh_audit["actualBitgetFundingPlus10bp"]["robustnessGate"]["pass"]
        ),
    }

    result = {
        "schemaVersion": 1,
        "contract": "crypto-futures-v49-bitget-actual-funding-v411",
        "sourceRunV49": 37458393512,
        "sourceV49Head": "0889474af32db16ee16c796d34a29eac67a68f19",
        "requestedEvents": int(len(events)),
        "requestedSymbols": int(events["symbol"].nunique()),
        "fundingSymbolsUsable": int(len(histories)),
        "fundingSymbolCoverage": float(
            len(histories) / max(events["symbol"].nunique(), 1)
        ),
        "actualFundingCoveredEvents": int(len(overlap)),
        "actualFundingEventCoverage": float(len(overlap) / max(len(events), 1)),
        "fundingHistoryBoundary": {
            "earliestOverall": str(global_earliest) if global_earliest is not None else None,
            "latestOverall": str(global_latest) if global_latest is not None else None,
            "postBoundaryRequestedRows": int(len(post_boundary)),
            "postBoundaryCoveredRows": int(len(post_cov)),
            "postBoundaryCoverage": float(len(post_cov) / max(len(post_boundary), 1)),
        },
        "periods": period_results,
        "supportingEvidenceGate": {
            "pass": bool(all(support_checks.values())),
            "checks": support_checks,
        },
        "truthBoundary": {
            "usesFrozenV49ExactBitgetPricePaths": True,
            "usesFrozenV49SignalTimesAndThresholds": True,
            "usesBitgetPublicFundingHistoryOnly": True,
            "shortReceivesPositiveAndPaysNegativeFunding": True,
            "fundingAppliedOnlyForFundingTimestampsInsideHeldInterval": True,
            "onlyFullyCoveredFundingIntervalsEnterActualFundingAudit": True,
            "actualFundingComparedAgainstFrozenBinanceProxyOnSameEvents": True,
            "plus10bpStressIsAdditionalHaircut": True,
            "noThresholdRetuning": True,
            "noCandidateReselection": True,
            "overlapWindowIsAvailabilityConstrainedNotAReplacementValidationPeriod": True,
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
