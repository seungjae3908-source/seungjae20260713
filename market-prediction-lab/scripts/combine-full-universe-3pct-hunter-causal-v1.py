#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

MARKET_ORDER = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]
WINDOWS = ["1D","1W","1M","3M","6M","1Y","3Y"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-root", required=True)
    ap.add_argument("--output-dir", required=True)
    args = ap.parse_args()

    root = Path(args.input_root)
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    summaries = {}
    for file in root.glob("**/summary.json"):
        data = json.loads(file.read_text(encoding="utf-8"))
        if data.get("contract") != "full-universe-3pct-hunter-causal-backtest-v1":
            continue
        market = data.get("market")
        if market:
            summaries[market] = data

    missing = [m for m in MARKET_ORDER if m not in summaries]
    if missing:
        raise RuntimeError(f"MISSING_MARKET_SUMMARIES:{','.join(missing)}")

    rows = []
    for market in MARKET_ORDER:
        d = summaries[market]
        obs = d["selectedObservedThreeYear"]
        held = d["heldoutLastYear"]
        row = {
            "market": market,
            "directionPolicy": d["directionPolicy"],
            "selectedVariant": d["selectedVariantFromFirstTwoYears"],
            "tradeCount3Y": obs["tradeCount"],
            "winRate3Y": obs["winRate"],
            "profitFactor3Y": obs["profitFactor"],
            "mdd3Y": obs["mdd"],
            "monthsPositive3Y": obs["monthsPositive"],
            "monthsTotal3Y": obs["monthsTotal"],
            "months3pctPlus3Y": obs["months3pctPlus"],
            "months5pctPlus3Y": obs["months5pctPlus"],
            "months10pctPlus3Y": obs["months10pctPlus"],
            "days3pctPlus3Y": obs["days3pctPlus"],
            "heldout1YReturn": held["totalReturn"],
            "heldout1YMdd": held["mdd"],
            "heldout1YTradeCount": held["tradeCount"],
            "heldout1YProfitFactor": held["profitFactor"],
        }
        for window in WINDOWS:
            w = obs["windows"].get(window, {})
            row[f"{window}_return"] = w.get("return")
            row[f"{window}_trades"] = w.get("tradeCount")
        rows.append(row)

    combined = {
        "schemaVersion": 1,
        "contract": "full-universe-3pct-hunter-causal-combined-v1",
        "markets": summaries,
        "table": rows,
        "truthBoundary": {
            "observedThreeYearIsIndependentOos": False,
            "heldoutLastYearSelectedWithoutUsingHeldoutForVariantChoice": True,
            "dailyOHLCExecutionApproximation": True,
            "intradayTMinusValidationStillRequired": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "combined-summary.json").write_text(
        json.dumps(combined, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    fieldnames = list(rows[0].keys())
    with (out / "combined-table.csv").open("w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.DictWriter(fp, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(json.dumps(combined, ensure_ascii=False))

if __name__ == "__main__":
    main()
