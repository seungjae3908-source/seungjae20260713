#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, rel: str):
    p = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, p)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"IMPORT_FAILED:{rel}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


activity = load(
    "flow_v4_activity",
    "market-prediction-lab/scripts/run-crypto-full-universe-flow-v4.py",
)

DATASET = activity.DATASET
SUB = "futures"
RVOL_MIN = float(activity.PRESCREEN_RVOL_MIN)
CAPS = (1, 3, 5, 10, 20, 50)
TARGET = 0.03
HOLD_BARS = 32


def forward_min_next_n(low: pd.Series, n: int) -> pd.Series:
    # Operates inside a continuous 15m segment. Current signal bar is excluded;
    # the next bar is the first executable bar and up to n bars are observed.
    shifted = low.shift(-1)
    return shifted.iloc[::-1].rolling(n, min_periods=1).min().iloc[::-1]


def process_file(path: Path):
    x = activity.load_hf_15m(path)
    if x is None or x.height < 100:
        return None

    symbol = activity.raw_symbol_from_path(path, SUB)
    pdf = x.select(["date", "open", "high", "low", "close", "volume"]).to_pandas()
    pdf["date"] = pd.to_datetime(pdf["date"], utc=True)
    for c in ("open", "high", "low", "close", "volume"):
        pdf[c] = pd.to_numeric(pdf[c], errors="coerce")
    pdf = pdf.dropna(subset=["date", "open", "high", "low", "close", "volume"])
    pdf = pdf.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    if len(pdf) < 100:
        return None

    vol = pdf["volume"].astype(float)
    close = pdf["close"].astype(float)
    high = pdf["high"].astype(float)
    low = pdf["low"].astype(float)

    prior_vol96 = vol.shift(1).rolling(96, min_periods=48).mean()
    ret60 = close / close.shift(4) - 1.0
    prior_high4h = high.shift(1).rolling(16, min_periods=8).max()
    prior_low4h = low.shift(1).rolling(16, min_periods=8).min()

    base_rvol = vol / prior_vol96.replace(0, np.nan)
    near_high4h = close / prior_high4h.replace(0, np.nan) - 1.0
    near_low4h = close / prior_low4h.replace(0, np.nan) - 1.0
    activity_score = (
        base_rvol.clip(0, 20)
        + ret60.abs().clip(0, 0.20) * 30.0
        + (near_high4h >= -0.01).astype(float) * 0.5
        + (near_low4h <= 0.01).astype(float) * 0.5
    )

    eligible = (base_rvol >= RVOL_MIN).fillna(False)
    onset = eligible & ~eligible.shift(1, fill_value=False)

    # Prevent the 8h opportunity window from crossing missing-data gaps.
    gap = pdf["date"].diff().gt(pd.Timedelta(minutes=30)).fillna(False)
    segment = gap.cumsum()

    entry_open = pd.Series(np.nan, index=pdf.index, dtype=float)
    future_min = pd.Series(np.nan, index=pdf.index, dtype=float)
    for _, idx in pdf.groupby(segment, sort=False).groups.items():
        loc = list(idx)
        gopen = pdf.loc[loc, "open"].astype(float)
        glow = pdf.loc[loc, "low"].astype(float)
        entry_open.loc[loc] = gopen.shift(-1)
        future_min.loc[loc] = forward_min_next_n(glow, HOLD_BARS)

    short_mfe = 1.0 - future_min / entry_open.replace(0, np.nan)
    opportunity = (short_mfe >= TARGET).fillna(False)

    out = pd.DataFrame(
        {
            "timestamp": pdf["date"],
            "symbol": symbol,
            "activityScore": activity_score,
            "baseRvol": base_rvol,
            "ret60": ret60,
            "shortMfe8h": short_mfe,
            "opportunity3pct": opportunity,
            "eventOnset": onset,
        }
    )
    out = out[out["eventOnset"]].dropna(
        subset=["timestamp", "activityScore", "baseRvol", "ret60"]
    )
    if out.empty:
        return None
    return out[
        [
            "timestamp",
            "symbol",
            "activityScore",
            "baseRvol",
            "ret60",
            "shortMfe8h",
            "opportunity3pct",
        ]
    ].copy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    folder = (
        Path(
            snapshot_download(
                repo_id=DATASET,
                repo_type="dataset",
                allow_patterns=[f"{SUB}/15m/*.parquet"],
            )
        )
        / SUB
        / "15m"
    )
    files = sorted(folder.glob("*.parquet"))
    frames = []
    failures = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(process_file, p): p for p in files}
        for idx, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            p = futs[fut]
            try:
                x = fut.result()
                if x is not None and len(x):
                    frames.append(x)
            except Exception as exc:
                failures.append({"file": p.name, "error": repr(exc)})
            if idx % 100 == 0 or idx == len(futs):
                print(
                    json.dumps(
                        {
                            "filesComplete": idx,
                            "files": len(futs),
                            "usableFrames": len(frames),
                            "failures": len(failures),
                        }
                    ),
                    flush=True,
                )

    if not frames:
        raise RuntimeError("V502_NO_CAUSAL_EVENT_ROWS")

    events = pd.concat(frames, ignore_index=True)
    events["timestamp"] = pd.to_datetime(events["timestamp"], utc=True)
    events["opportunity3pct"] = events["opportunity3pct"].astype(bool)
    events = events.sort_values(
        ["timestamp", "activityScore", "symbol"],
        ascending=[True, False, True],
    ).reset_index(drop=True)
    events["rankAtTimestamp"] = events.groupby("timestamp").cumcount() + 1

    total_events = int(len(events))
    total_opps = int(events["opportunity3pct"].sum())
    opp_times = int(
        events.loc[events["opportunity3pct"], "timestamp"].nunique()
    )

    cap_rows = []
    for cap in CAPS:
        z = events[events["rankAtTimestamp"] <= cap]
        captured = int(z["opportunity3pct"].sum())
        cap_rows.append(
            {
                "topPerTimestamp": cap,
                "detectedEvents": int(len(z)),
                "captured3pctOpportunities": captured,
                "all3pctOpportunities": total_opps,
                "detectionRecall3pct": float(
                    captured / max(total_opps, 1)
                ),
                "timestamps": int(z["timestamp"].nunique()),
                "symbols": int(z["symbol"].nunique()),
            }
        )

    pd.DataFrame(cap_rows).to_csv(out / "detection-recall-grid.csv", index=False)

    # Store only opportunity rows, not all ~millions of onset rows.
    opp = events[events["opportunity3pct"]].copy()
    opp.to_parquet(out / "all-short-3pct-opportunities.parquet", index=False)

    by_month = (
        opp.assign(month=opp["timestamp"].dt.strftime("%Y-%m"))
        .groupby("month", as_index=False)
        .agg(
            opportunities=("symbol", "size"),
            symbols=("symbol", "nunique"),
            timestamps=("timestamp", "nunique"),
        )
    )
    by_month.to_csv(out / "opportunities-by-month.csv", index=False)

    result = {
        "schemaVersion": 1,
        "contract": "crypto-futures-causal-opportunity-recall-v502",
        "dataset": DATASET,
        "sourceFiles": len(files),
        "usableSymbolFrames": len(frames),
        "fileFailures": len(failures),
        "causalEventOnsets": total_events,
        "shortMfe3pctOpportunities8h": total_opps,
        "opportunityTimestamps": opp_times,
        "targetPct": TARGET,
        "maxHoldBars15m": HOLD_BARS,
        "caps": cap_rows,
        "dateMin": str(events["timestamp"].min()),
        "dateMax": str(events["timestamp"].max()),
        "failurePreview": failures[:30],
        "truthBoundary": {
            "eventOnsetUsesCurrentAndPriorCompletedBarsOnly": True,
            "rankingUsesOnlySameCompletedTimestampActivityScore": True,
            "opportunityLabelUsesFutureOnlyAfterSelection": True,
            "opportunityIsMfeReachNotTradeProfit": True,
            "entryReferenceIsNext15mOpen": True,
            "missingDataGapSplitsForwardWindow": True,
            "sameThresholdAndActivityFormulaAsCausalV50": True,
            "noThresholdOrRankCapChosenUsingOutcome": True,
            "diagnosticOnly": True,
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
