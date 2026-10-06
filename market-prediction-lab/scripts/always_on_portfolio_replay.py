#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

MARKET_DIRECTION_POLICY = {
    "KR_STOCK": {"LONG"},
    "US_STOCK": {"LONG"},
    "CRYPTO_SPOT": {"LONG"},
    "CRYPTO_FUTURES": {"LONG", "SHORT"},
}

REQUIRED_COLUMNS = {
    "market", "timestamp", "symbol", "direction", "score",
    "entryTime", "exitTime", "netReturn", "MFE", "MAE",
}

DEFAULT_OPPORTUNITY_TARGET = 0.03


def _utc(x: pd.Series) -> pd.Series:
    return pd.to_datetime(x, utc=True, errors="coerce")


def normalize_events(events: pd.DataFrame) -> pd.DataFrame:
    x = events.copy()
    missing = sorted(REQUIRED_COLUMNS - set(x.columns))
    if missing:
        raise ValueError(f"ALWAYS_ON_MISSING_COLUMNS:{','.join(missing)}")

    x["market"] = x["market"].astype(str)
    x["symbol"] = x["symbol"].astype(str)
    x["direction"] = x["direction"].astype(str).str.upper()
    x["timestamp"] = _utc(x["timestamp"])
    x["entryTime"] = _utc(x["entryTime"])
    x["exitTime"] = _utc(x["exitTime"])
    for c in ["score", "netReturn", "MFE", "MAE"]:
        x[c] = pd.to_numeric(x[c], errors="coerce")

    x = x.dropna(
        subset=[
            "market", "timestamp", "symbol", "direction", "score",
            "entryTime", "exitTime", "netReturn", "MFE", "MAE",
        ]
    ).copy()

    bad_market = sorted(set(x["market"]) - set(MARKET_DIRECTION_POLICY))
    if bad_market:
        raise ValueError(f"ALWAYS_ON_UNKNOWN_MARKET:{','.join(bad_market)}")

    allowed = x.apply(
        lambda r: r["direction"] in MARKET_DIRECTION_POLICY[r["market"]], axis=1
    )
    x = x.loc[allowed].copy()

    x = x[x["entryTime"] >= x["timestamp"]].copy()
    x = x[x["exitTime"] >= x["entryTime"]].copy()

    # Same symbol + same signal time can be emitted by multiple feature families.
    # Keep the highest-scoring independent opportunity for portfolio-level replay.
    x = (
        x.sort_values(
            ["timestamp", "market", "symbol", "direction", "score"],
            ascending=[True, True, True, True, False],
        )
        .drop_duplicates(
            subset=["timestamp", "market", "symbol", "direction"], keep="first"
        )
        .reset_index(drop=True)
    )
    return x


def _position_key(row: pd.Series) -> tuple[str, str]:
    # A spot/stock symbol cannot have simultaneous duplicated positions.
    # Futures also use one symbol slot in this research replay; a later opposite-side
    # event is allowed after the current position is closed.
    return str(row["market"]), str(row["symbol"])


def replay_always_on(
    events: pd.DataFrame,
    *,
    max_positions: int | None,
    opportunity_target: float = DEFAULT_OPPORTUNITY_TARGET,
    min_score: float | None = None,
) -> dict:
    x = normalize_events(events)
    if max_positions is not None and max_positions < 1:
        raise ValueError("max_positions must be >= 1 or None")

    signal_times = list(x["timestamp"].drop_duplicates().sort_values())
    active: dict[tuple[str, str], dict] = {}
    last_closed: dict[tuple[str, str], pd.Timestamp] = {}
    # Capacity-blocked candidates are not forgotten. They remain on a watchlist
    # until their original opportunity horizon expires. A stale watchlist item is
    # never executed by itself; execution still requires a fresh scanner signal.
    watchlist: dict[tuple[str, str], dict] = {}
    watchlist_adds = 0
    watchlist_recheck_ticks = 0
    watchlist_refresh_signals = 0
    watchlist_refresh_entries = 0
    watchlist_expired = 0
    entered_rows: list[dict] = []
    miss_reasons = Counter()
    scan_ticks_while_position_open = 0
    new_entries_while_other_position_open = 0
    reentries = 0
    max_concurrent = 0
    opportunity_total = 0
    opportunity_entered = 0
    opportunity_missed = 0
    opportunity_missed_reasons = Counter()
    market_signal_count = Counter()
    market_entry_count = Counter()
    market_opportunity_count = Counter()
    market_opportunity_entered = Counter()
    concurrency_samples: list[int] = []

    grouped = {t: g.copy() for t, g in x.groupby("timestamp", sort=True)}

    for t in signal_times:
        # Position monitor runs independently from scanner. Positions whose actual
        # exit time is at/before this scanner tick are released before new entries.
        closing = [k for k, p in active.items() if p["exitTime"] <= t]
        for k in closing:
            last_closed[k] = active[k]["exitTime"]
            del active[k]

        expired_watch = [
            k for k, w in watchlist.items() if w["validUntil"] <= t
        ]
        for k in expired_watch:
            del watchlist[k]
            watchlist_expired += 1
        if watchlist:
            watchlist_recheck_ticks += 1

        had_open_before_scan = bool(active)
        if had_open_before_scan:
            scan_ticks_while_position_open += 1

        batch = grouped[t].sort_values(
            ["score", "market", "symbol"], ascending=[False, True, True]
        )

        for _, row in batch.iterrows():
            market = str(row["market"])
            market_signal_count[market] += 1
            is_opportunity = float(row["MFE"]) >= float(opportunity_target)
            if is_opportunity:
                opportunity_total += 1
                market_opportunity_count[market] += 1

            if min_score is not None and float(row["score"]) < min_score:
                miss_reasons["below_score"] += 1
                if is_opportunity:
                    opportunity_missed += 1
                    opportunity_missed_reasons["below_score"] += 1
                continue

            key = _position_key(row)
            if key in watchlist:
                watchlist_refresh_signals += 1

            if key in active:
                miss_reasons["already_open"] += 1
                if is_opportunity:
                    opportunity_missed += 1
                    opportunity_missed_reasons["already_open"] += 1
                continue

            if max_positions is not None and len(active) >= max_positions:
                miss_reasons["portfolio_capacity"] += 1
                watchlist[key] = {
                    "market": market,
                    "symbol": str(row["symbol"]),
                    "direction": str(row["direction"]),
                    "lastSignalTime": row["timestamp"],
                    "validUntil": row["exitTime"],
                    "score": float(row["score"]),
                    "isOpportunity": bool(is_opportunity),
                }
                watchlist_adds += 1
                if is_opportunity:
                    opportunity_missed += 1
                    opportunity_missed_reasons["portfolio_capacity"] += 1
                continue

            was_reentry = key in last_closed and row["entryTime"] > last_closed[key]
            if was_reentry:
                reentries += 1

            if active:
                new_entries_while_other_position_open += 1

            pos = {
                "market": market,
                "symbol": str(row["symbol"]),
                "direction": str(row["direction"]),
                "signalTime": row["timestamp"],
                "entryTime": row["entryTime"],
                "exitTime": row["exitTime"],
                "score": float(row["score"]),
                "netReturn": float(row["netReturn"]),
                "MFE": float(row["MFE"]),
                "MAE": float(row["MAE"]),
                "isOpportunity": bool(is_opportunity),
                "reentry": bool(was_reentry),
            }
            active[key] = pos
            if key in watchlist:
                # This entry is based on the current fresh event, not the stale
                # watchlist entry. The watchlist only preserves attention.
                del watchlist[key]
                watchlist_refresh_entries += 1
            entered_rows.append(pos)
            market_entry_count[market] += 1

            if is_opportunity:
                opportunity_entered += 1
                market_opportunity_entered[market] += 1

            max_concurrent = max(max_concurrent, len(active))

        concurrency_samples.append(len(active))

    entered = pd.DataFrame(entered_rows)
    booked_net_sum = float(entered["netReturn"].sum()) if len(entered) else 0.0
    positive_entry_rate = (
        float((entered["netReturn"] > 0).mean()) if len(entered) else None
    )
    recall = (
        float(opportunity_entered / opportunity_total)
        if opportunity_total
        else None
    )

    market_rows = []
    for market in MARKET_DIRECTION_POLICY:
        opp = int(market_opportunity_count[market])
        got = int(market_opportunity_entered[market])
        market_rows.append(
            {
                "market": market,
                "signals": int(market_signal_count[market]),
                "entries": int(market_entry_count[market]),
                "opportunities3pct": opp,
                "captured3pct": got,
                "opportunityRecall": (got / opp) if opp else None,
            }
        )

    return {
        "contract": "always-on-opportunity-position-replay-v1",
        "scanner": {
            "signalTimestamps": len(signal_times),
            "signalEvents": int(len(x)),
            "scanTicksWhilePositionOpen": int(scan_ticks_while_position_open),
            "scannerContinuesWhilePositionOpen": bool(
                scan_ticks_while_position_open > 0 or len(signal_times) <= 1
            ),
            "newEntriesWhileOtherPositionOpen": int(
                new_entries_while_other_position_open
            ),
        },
        "positions": {
            "entries": int(len(entered_rows)),
            "reentriesAfterPriorExit": int(reentries),
            "maxConcurrent": int(max_concurrent),
            "meanConcurrentAtScannerTicks": (
                float(np.mean(concurrency_samples)) if concurrency_samples else 0.0
            ),
            "bookedNetReturnSum": booked_net_sum,
            "positiveEntryRate": positive_entry_rate,
        },
        "opportunities": {
            "target": float(opportunity_target),
            "total": int(opportunity_total),
            "detected": int(opportunity_total),
            "detectedRecall": 1.0 if opportunity_total else None,
            "captured": int(opportunity_entered),
            "executed": int(opportunity_entered),
            "missed": int(opportunity_missed),
            "recall": recall,
            "executionRecall": recall,
            "missReasons": dict(opportunity_missed_reasons),
        },
        "watchlist": {
            "capacityBlockedAdds": int(watchlist_adds),
            "recheckTicks": int(watchlist_recheck_ticks),
            "freshSignalRefreshes": int(watchlist_refresh_signals),
            "entriesOnLaterFreshSignal": int(watchlist_refresh_entries),
            "expiredWithoutFreshExecution": int(watchlist_expired),
            "remainingAtEnd": int(len(watchlist)),
        },
        "allMissReasons": dict(miss_reasons),
        "markets": market_rows,
        "truthBoundary": {
            "scannerNeverSuspendedByOpenPosition": True,
            "positionMonitorRunsIndependently": True,
            "sameSymbolOverlapDeduplicated": True,
            "sameSymbolReentryAllowedAfterExit": True,
            "stocksAndSpotLongOnly": True,
            "futuresLongShort": True,
            "portfolioCapacityCanBeAudited": True,
            "capacityBlockedSignalsKeptOnWatchlist": True,
            "staleWatchlistNeverExecutedWithoutFreshSignal": True,
            "detectionSeparatedFromExecution": True,
            "opportunityRecallUsesMFEAtLeast3pct": float(opportunity_target) == 0.03,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }


def scenario_grid(
    events: pd.DataFrame,
    capacities: Iterable[int | None] = (1, 3, 5, 10, 20, None),
    opportunity_target: float = DEFAULT_OPPORTUNITY_TARGET,
) -> list[dict]:
    rows = []
    for cap in capacities:
        r = replay_always_on(
            events,
            max_positions=cap,
            opportunity_target=opportunity_target,
        )
        rows.append(
            {
                "maxPositions": "UNLIMITED" if cap is None else cap,
                "entries": r["positions"]["entries"],
                "reentries": r["positions"]["reentriesAfterPriorExit"],
                "maxConcurrent": r["positions"]["maxConcurrent"],
                "newEntriesWhileOtherOpen": r["scanner"][
                    "newEntriesWhileOtherPositionOpen"
                ],
                "opportunities3pct": r["opportunities"]["total"],
                "captured3pct": r["opportunities"]["captured"],
                "opportunityRecall": r["opportunities"]["recall"],
                "bookedNetReturnSum": r["positions"]["bookedNetReturnSum"],
            }
        )
    return rows


def contract_fixture() -> pd.DataFrame:
    # A stays open while B appears. B must still be scanned and entered.
    # A later exits and receives a genuinely new event; re-entry must be allowed.
    t0 = pd.Timestamp("2026-01-05T00:00:00Z")
    rows = [
        {
            "market": "CRYPTO_FUTURES",
            "timestamp": t0,
            "symbol": "AUSDT",
            "direction": "LONG",
            "score": 0.95,
            "entryTime": t0 + pd.Timedelta(minutes=1),
            "exitTime": t0 + pd.Timedelta(minutes=20),
            "netReturn": 0.04,
            "MFE": 0.06,
            "MAE": 0.01,
        },
        {
            "market": "CRYPTO_FUTURES",
            "timestamp": t0 + pd.Timedelta(minutes=5),
            "symbol": "BUSDT",
            "direction": "SHORT",
            "score": 0.90,
            "entryTime": t0 + pd.Timedelta(minutes=6),
            "exitTime": t0 + pd.Timedelta(minutes=16),
            "netReturn": 0.035,
            "MFE": 0.05,
            "MAE": 0.008,
        },
        {
            "market": "US_STOCK",
            "timestamp": t0 + pd.Timedelta(minutes=10),
            "symbol": "XYZ",
            "direction": "LONG",
            "score": 0.85,
            "entryTime": t0 + pd.Timedelta(minutes=11),
            "exitTime": t0 + pd.Timedelta(minutes=18),
            "netReturn": -0.01,
            "MFE": 0.01,
            "MAE": 0.02,
        },
        {
            "market": "CRYPTO_FUTURES",
            "timestamp": t0 + pd.Timedelta(minutes=25),
            "symbol": "AUSDT",
            "direction": "LONG",
            "score": 0.92,
            "entryTime": t0 + pd.Timedelta(minutes=26),
            "exitTime": t0 + pd.Timedelta(minutes=40),
            "netReturn": 0.05,
            "MFE": 0.08,
            "MAE": 0.005,
        },
    ]
    return pd.DataFrame(rows)


def contract_smoke() -> dict:
    result = replay_always_on(contract_fixture(), max_positions=3)
    checks = {
        "scannerContinuesDuringOpenPosition": result["scanner"][
            "scanTicksWhilePositionOpen"
        ] >= 2,
        "canEnterNewSymbolWhileOtherOpen": result["scanner"][
            "newEntriesWhileOtherPositionOpen"
        ] >= 2,
        "reentryAfterExit": result["positions"]["reentriesAfterPriorExit"] == 1,
        "capturesAllThreePctFixtureOpportunities": result["opportunities"][
            "recall"
        ] == 1.0,
        "concurrencyObserved": result["positions"]["maxConcurrent"] >= 2,
    }
    return {
        "contract": "always-on-contract-smoke-v1",
        "pass": all(checks.values()),
        "checks": checks,
        "replay": result,
    }


def load_inputs(paths: list[str]) -> pd.DataFrame:
    frames = []
    for raw in paths:
        p = Path(raw)
        if p.suffix.lower() == ".parquet":
            frames.append(pd.read_parquet(p))
        else:
            frames.append(pd.read_csv(p))
    if not frames:
        raise ValueError("NO_ALWAYS_ON_INPUTS")
    return pd.concat(frames, ignore_index=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", action="append", default=[])
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--contract-smoke", action="store_true")
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    if args.contract_smoke:
        smoke = contract_smoke()
        (out / "contract-smoke.json").write_text(
            json.dumps(smoke, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )
        print(json.dumps({"FINAL": smoke}, ensure_ascii=False, default=str), flush=True)
        if not smoke["pass"]:
            raise SystemExit(1)
        return

    events = load_inputs(args.input)
    normalized = normalize_events(events)
    grid = scenario_grid(normalized)
    pd.DataFrame(grid).to_csv(out / "capacity-grid.csv", index=False)

    result = replay_always_on(normalized, max_positions=None)
    (out / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": result}, ensure_ascii=False, default=str), flush=True)


if __name__ == "__main__":
    main()
