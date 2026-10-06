#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

CAPS = (1, 3, 5, 10, 20, 50)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selected", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(args.selected)
    required = {"date", "month", "symbol", "activityScore"}
    missing = required - set(df.columns)
    if missing:
        raise RuntimeError(f"V501_MISSING_COLUMNS:{sorted(missing)}")

    df["date"] = pd.to_datetime(df["date"], utc=True)
    df["month"] = df["month"].astype(str)
    df["symbol"] = df["symbol"].astype(str)
    df["activityScore"] = pd.to_numeric(df["activityScore"], errors="coerce")
    df = df.dropna(subset=["date", "activityScore"]).copy()
    df = df.sort_values(
        ["date", "activityScore", "symbol"],
        ascending=[True, False, True],
    ).reset_index(drop=True)
    df["rankAtTimestamp"] = df.groupby("date").cumcount() + 1

    rows = []
    for cap in CAPS:
        z = df[df["rankAtTimestamp"] <= cap].copy()
        tasks = z[["month", "symbol"]].drop_duplicates()
        symbol_days = (
            z.assign(day=z["date"].dt.strftime("%Y-%m-%d"))[
                ["day", "symbol"]
            ].drop_duplicates()
        )
        rows.append(
            {
                "topPerTimestamp": cap,
                "selectedRows": int(len(z)),
                "selectedSymbols": int(z["symbol"].nunique()),
                "selectedTimestamps": int(z["date"].nunique()),
                "rawSymbolMonthTasks": int(len(tasks)),
                "rawSymbolDayPairs": int(len(symbol_days)),
                "meanRowsPerTimestamp": float(
                    len(z) / max(z["date"].nunique(), 1)
                ),
            }
        )
        tasks.to_csv(out / f"raw-month-tasks-top{cap}.csv", index=False)

    result_df = pd.DataFrame(rows)
    result_df.to_csv(out / "capacity-grid.csv", index=False)

    result = {
        "schemaVersion": 1,
        "contract": "crypto-futures-causal-prescreen-capacity-v501",
        "sourceRun": 37466870802,
        "sourceRowsTop50": int(len(df)),
        "caps": rows,
        "truthBoundary": {
            "usesOnlyCausalTop50PrescreenArtifact": True,
            "noOutcomeOrReturnColumnsUsed": True,
            "capacityChoiceMustBeBasedOnComputeAndCoverageNotPnL": True,
            "noThresholdRetuning": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"FINAL": result}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
