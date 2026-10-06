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


v22 = load(
    "kr_v22",
    "market-prediction-lab/scripts/run-kr-recent-all-session-recall-first-v22.py",
)
pathminer = v22.pathminer
trainer = v22.trainer
replay = v22.replay
miner = v22.miner

MAX_WORKERS = 16
MAX_STATE_GAP = pd.Timedelta(minutes=2)
TRAIN_FEATURES = [
    "rvol60",
    "dollarAccel5",
    "retAccel1v5",
    "retAccel5v15",
    "compression30",
    "closeRangeLoc",
    "vwapDist",
]


def split_dates(source: pd.DataFrame):
    prepared = trainer.prepare(source)
    dates = sorted(d for d in prepared["date"].dropna().unique())
    if len(dates) < 4:
        raise RuntimeError(f"KR_V24_TOO_FEW_DATES:{len(dates)}")
    n = len(dates)
    train_end = max(1, n - 3)
    train_dates = dates[:train_end]
    cal_date = dates[train_end]
    val_date = dates[train_end + 1] if train_end + 1 < n - 1 else cal_date
    fresh_date = dates[-1]
    return dates, train_dates, cal_date, val_date, fresh_date


def derived(f: pd.DataFrame) -> pd.DataFrame:
    z = f.copy()
    z["retAccel1v5"] = (
        pd.to_numeric(z["ret1"], errors="coerce")
        - pd.to_numeric(z["ret5"], errors="coerce") / 5.0
    )
    z["retAccel5v15"] = (
        pd.to_numeric(z["ret5"], errors="coerce") / 5.0
        - pd.to_numeric(z["ret15"], errors="coerce") / 15.0
    )
    z["compression30"] = (
        pd.to_numeric(z["distLow30"], errors="coerce")
        - pd.to_numeric(z["distHigh30"], errors="coerce")
    )
    for c in TRAIN_FEATURES + ["ret1", "ret5", "ret15", "close", "priorDollar60"]:
        z[c] = pd.to_numeric(z[c], errors="coerce")
    return z.replace([np.inf, -np.inf], np.nan)


def collect_symbol(symbol: str, market: str, train_dates: set):
    raw, err = miner.fetch_rows(symbol)
    if raw is None:
        return None, pd.DataFrame(), {
            "symbol": symbol,
            "market": market,
            "ok": False,
            "error": err,
        }

    raw["date"] = raw["timestamp"].dt.date
    history_tail = None
    train_frames = []
    scanner_states = 0

    for day, g in raw.groupby("date", sort=True):
        f, history_tail = pathminer.feature_day(g, history_tail)
        if f.empty:
            continue
        f = f[(f["close"] >= 500) & (f["priorDollar60"] >= 100000)].copy()
        if f.empty:
            continue
        if day in train_dates:
            z = derived(f)
            z = z.dropna(subset=TRAIN_FEATURES)
            if len(z):
                scanner_states += len(z)
                train_frames.append(z[TRAIN_FEATURES].astype("float32"))

    train = (
        pd.concat(train_frames, ignore_index=True)
        if train_frames
        else pd.DataFrame(columns=TRAIN_FEATURES)
    )
    return raw, train, {
        "symbol": symbol,
        "market": market,
        "ok": True,
        "rawRows": int(len(raw)),
        "trainScannerStates": int(scanner_states),
    }


def freeze_thresholds(train: pd.DataFrame) -> dict:
    if len(train) < 10000:
        raise RuntimeError(f"KR_V24_TRAIN_STATES_TOO_SMALL:{len(train)}")
    q = {
        "rvol60Min": float(train["rvol60"].quantile(0.65)),
        "dollarAccel5Min": float(train["dollarAccel5"].quantile(0.65)),
        "retAccel1v5Min": float(train["retAccel1v5"].quantile(0.55)),
        "retAccel5v15Min": float(train["retAccel5v15"].quantile(0.50)),
        "compression30Max": float(train["compression30"].quantile(0.50)),
        "closeRangeLocMin": float(train["closeRangeLoc"].quantile(0.55)),
        "vwapDistMin": float(train["vwapDist"].quantile(0.50)),
    }
    return q


def rule_mask(z: pd.DataFrame, q: dict) -> pd.Series:
    return (
        (z["rvol60"] >= q["rvol60Min"])
        & (z["dollarAccel5"] >= q["dollarAccel5Min"])
        & (z["retAccel1v5"] >= q["retAccel1v5Min"])
        & (z["retAccel5v15"] >= q["retAccel5v15Min"])
        & (z["compression30"] <= q["compression30Max"])
        & (z["closeRangeLoc"] >= q["closeRangeLocMin"])
        & (z["vwapDist"] >= q["vwapDistMin"])
        & (z["ret1"] > 0.0)
    ).fillna(False)


def evaluate_symbol(
    symbol: str,
    market: str,
    raw: pd.DataFrame,
    thresholds: dict,
    eval_dates: set,
):
    history_tail = None
    trades = []
    audit = {
        "symbol": symbol,
        "market": market,
        "ok": True,
        "scannerStates": 0,
        "ruleStates": 0,
        "eventOnsets": 0,
        "onsetsByDate": {},
    }

    for day, g in raw.groupby("date", sort=True):
        f, history_tail = pathminer.feature_day(g, history_tail)
        if f.empty or day not in eval_dates:
            continue
        f = f[(f["close"] >= 500) & (f["priorDollar60"] >= 100000)].copy()
        if f.empty:
            continue

        z = derived(f).dropna(subset=TRAIN_FEATURES + ["ret1"]).copy()
        if z.empty:
            continue
        z = z.sort_values("timestamp").reset_index(drop=True)
        audit["scannerStates"] += int(len(z))

        state = rule_mask(z, thresholds)
        audit["ruleStates"] += int(state.sum())

        prev_state = state.shift(1, fill_value=False)
        prev_ts = pd.to_datetime(z["timestamp"].shift(1), errors="coerce")
        ts = pd.to_datetime(z["timestamp"], errors="coerce")
        gap = ts - prev_ts
        onset = state & ((~prev_state) | prev_ts.isna() | (gap > MAX_STATE_GAP))
        selected = z.loc[onset].copy()
        audit["eventOnsets"] += int(len(selected))
        audit["onsetsByDate"][str(day)] = int(len(selected))
        if selected.empty:
            continue

        grid = miner.grid_day(g)
        for _, row in selected.iterrows():
            tr = replay.simulate_close_path(
                grid,
                pd.Timestamp(row["timestamp"]),
                1.0,
                symbol,
                market,
            )
            if tr is not None:
                trades.append(tr)

    return trades, audit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    source = pd.read_parquet(args.events)
    dates, train_dates, cal_date, val_date, fresh_date = split_dates(source)
    train_date_set = set(train_dates)
    eval_dates = {val_date, fresh_date}

    sym_market = (
        source[["symbol", "exchangeMarket"]]
        .dropna()
        .drop_duplicates("symbol")
        .set_index("symbol")["exchangeMarket"]
        .astype(str)
        .to_dict()
    )
    symbols = sorted(sym_market)

    raw_by_symbol = {}
    train_frames = []
    collect_audits = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {
            pool.submit(
                collect_symbol,
                s,
                sym_market[s],
                train_date_set,
            ): s
            for s in symbols
        }
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            s = futs[fut]
            try:
                raw, train, audit = fut.result()
            except Exception as exc:
                raw = None
                train = pd.DataFrame(columns=TRAIN_FEATURES)
                audit = {
                    "symbol": s,
                    "market": sym_market[s],
                    "ok": False,
                    "error": repr(exc),
                }
            collect_audits.append(audit)
            if raw is not None:
                raw_by_symbol[s] = raw
            if len(train):
                train_frames.append(train)
            if idx % 100 == 0 or idx == len(futs):
                print(
                    json.dumps(
                        {
                            "collectSymbols": idx,
                            "symbols": len(futs),
                            "usableRaw": len(raw_by_symbol),
                            "trainStates": int(sum(len(x) for x in train_frames)),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )

    if not train_frames:
        raise RuntimeError("KR_V24_NO_TRAIN_STATES")
    train_states = pd.concat(train_frames, ignore_index=True)
    thresholds = freeze_thresholds(train_states)
    del train_states
    del train_frames

    all_trades = []
    eval_audits = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {
            pool.submit(
                evaluate_symbol,
                s,
                sym_market[s],
                raw_by_symbol[s],
                thresholds,
                eval_dates,
            ): s
            for s in sorted(raw_by_symbol)
        }
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            s = futs[fut]
            try:
                trades, audit = fut.result()
            except Exception as exc:
                trades = []
                audit = {
                    "symbol": s,
                    "market": sym_market[s],
                    "ok": False,
                    "error": repr(exc),
                }
            all_trades.extend(trades)
            eval_audits.append(audit)
            if idx % 100 == 0 or idx == len(futs):
                print(
                    json.dumps(
                        {
                            "evalSymbols": idx,
                            "symbols": len(futs),
                            "eventOnsets": int(
                                sum(int(x.get("eventOnsets") or 0) for x in eval_audits)
                            ),
                            "trades": len(all_trades),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )

    trades = pd.DataFrame(all_trades)
    if trades.empty:
        raise RuntimeError("KR_V24_NO_EXACT_TRADES")
    trades["date"] = pd.to_datetime(trades["timestamp"]).dt.date
    trades.to_csv(out / "reaccel-event-trades.csv", index=False)
    pd.DataFrame(collect_audits).to_json(
        out / "collect-audit.jsonl",
        orient="records",
        lines=True,
        force_ascii=False,
    )
    pd.DataFrame(eval_audits).to_json(
        out / "eval-audit.jsonl",
        orient="records",
        lines=True,
        force_ascii=False,
    )

    by_date = {}
    for d in (val_date, fresh_date):
        sub = trades[trades["date"] == d].copy()
        by_date[str(d)] = {
            "tradeStats": replay.trade_stats(sub),
            "capacityGrid": replay.replay_capacity(sub) if len(sub) else [],
        }

    val_stats = by_date[str(val_date)]["tradeStats"]
    fresh_stats = by_date[str(fresh_date)]["tradeStats"]
    checks = {
        "validation": {
            "positiveMeanNet": float(val_stats.get("meanNetReturn") or 0) > 0,
            "profitFactorAbove1": float(val_stats.get("profitFactor") or 0) > 1,
            "minimumTrades": int(val_stats.get("tradeCount") or 0) >= 100,
        },
        "fresh": {
            "positiveMeanNet": float(fresh_stats.get("meanNetReturn") or 0) > 0,
            "profitFactorAbove1": float(fresh_stats.get("profitFactor") or 0) > 1,
            "minimumTrades": int(fresh_stats.get("tradeCount") or 0) >= 100,
        },
    }

    result = {
        "schemaVersion": 1,
        "contract": "kr-recent-all-session-reaccel-family-v24",
        "family": "TRAIN_QUANTILE_COMPRESSION_REACCEL",
        "split": {
            "allDates": [str(x) for x in dates],
            "trainDates": [str(x) for x in train_dates],
            "calibrationDateUnusedForThresholds": str(cal_date),
            "validationDate": str(val_date),
            "freshDate": str(fresh_date),
        },
        "thresholdsFrozenFromFullTrainScannerStates": thresholds,
        "requestedSymbols": len(symbols),
        "usableRawSymbols": len(raw_by_symbol),
        "trainScannerStates": int(
            sum(int(x.get("trainScannerStates") or 0) for x in collect_audits)
        ),
        "evalScannerStates": int(
            sum(int(x.get("scannerStates") or 0) for x in eval_audits)
        ),
        "evalRuleStates": int(
            sum(int(x.get("ruleStates") or 0) for x in eval_audits)
        ),
        "eventOnsets": int(
            sum(int(x.get("eventOnsets") or 0) for x in eval_audits)
        ),
        "exactTradeRows": int(len(trades)),
        "byDate": by_date,
        "combinedTradeStats": replay.trade_stats(trades),
        "combinedCapacityGrid": replay.replay_capacity(trades),
        "diagnosticGate": checks,
        "diagnosticPass": bool(all(all(v.values()) for v in checks.values())),
        "truthBoundary": {
            "thresholdsUseFullTrainScannerStateFeatureDistributionOnly": True,
            "labelsAndPnLNeverChooseThresholds": True,
            "calibrationValidationAndFreshNeverChooseThresholds": True,
            "scannerCoversEntire0900To1630Window": True,
            "openingFiveMinutesNotRequired": True,
            "eventOnsetOnlyWhenRuleTurnsFalseToTrueOrGapOverTwoMinutes": True,
            "exactReplayUsesMinuteClosePath": True,
            "target3Stop1p5RoundTripCost0p3pctApplied": True,
            "sourceRecentSevenTradingDaysOnly": True,
            "notThreeYearProfitabilityProof": True,
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
