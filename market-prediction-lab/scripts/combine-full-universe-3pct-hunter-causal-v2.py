#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

MARKET_ORDER = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]
WINDOWS = ["1D", "1W", "1M", "3M", "6M", "1Y", "3Y"]


def row_for(market: str, direction: str, report: dict) -> dict:
    held = report["heldoutLastYear"]
    full = report["observedThreeYear"]
    row = {
        "market": market,
        "direction": direction,
        "candidate": report["candidate"],
        "family": report["family"],
        "topN": report["topN"],
        "targetPct": report["targetPct"],
        "heldoutPass": report["heldoutGate"]["pass"],
        "heldoutReturn": held.get("totalReturn"),
        "heldoutMdd": held.get("mdd"),
        "heldoutProfitFactor": held.get("profitFactor"),
        "heldoutPositiveMonthRate": held.get("positiveMonthRate"),
        "heldoutTrades": held.get("tradeCount"),
        "threeYearReturn": full.get("totalReturn"),
        "threeYearMdd": full.get("mdd"),
        "threeYearProfitFactor": full.get("profitFactor"),
        "threeYearTrades": full.get("tradeCount"),
        "monthsPositive3Y": full.get("monthsPositive"),
        "monthsNegative3Y": full.get("monthsNegative"),
    }
    for window in WINDOWS:
        w = (full.get("windows") or {}).get(window, {})
        row[f"{window}_return"] = w.get("return")
        row[f"{window}_trades"] = w.get("tradeCount")
    return row


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
        if data.get("contract") != "full-universe-3pct-hunter-causal-v2":
            continue
        summaries[data["market"]] = data

    missing = [m for m in MARKET_ORDER if m not in summaries]
    if missing:
        raise RuntimeError(f"MISSING_V2_MARKETS:{','.join(missing)}")

    rows = []
    market_rows = []
    for market in MARKET_ORDER:
        data = summaries[market]
        for direction, report in data["selectedByDirection"].items():
            rows.append(row_for(market, direction, report))
        market_full = data["marketSelectedObservedThreeYear"]
        market_held = data["marketHeldoutLastYear"]
        market_rows.append({
            "market": market,
            "heldoutPass": data["marketHeldoutGate"]["pass"],
            "heldoutReturn": market_held.get("totalReturn"),
            "heldoutMdd": market_held.get("mdd"),
            "heldoutProfitFactor": market_held.get("profitFactor"),
            "heldoutPositiveMonthRate": market_held.get("positiveMonthRate"),
            "heldoutTrades": market_held.get("tradeCount"),
            "threeYearReturn": market_full.get("totalReturn"),
            "threeYearMdd": market_full.get("mdd"),
            "threeYearProfitFactor": market_full.get("profitFactor"),
            "threeYearTrades": market_full.get("tradeCount"),
            **{
                f"{window}_return": (market_full.get("windows") or {}).get(window, {}).get("return")
                for window in WINDOWS
            },
            **{
                f"{window}_trades": (market_full.get("windows") or {}).get(window, {}).get("tradeCount")
                for window in WINDOWS
            },
        })

    with (out / "selected-direction-table.csv").open("w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    with (out / "market-table.csv").open("w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.DictWriter(fp, fieldnames=list(market_rows[0].keys()))
        writer.writeheader()
        writer.writerows(market_rows)

    result = {
        "schemaVersion": 1,
        "contract": "full-universe-3pct-hunter-causal-v2-combined",
        "markets": summaries,
        "selectedDirectionTable": rows,
        "marketTable": market_rows,
        "passMarkets": [r["market"] for r in market_rows if r["heldoutPass"]],
        "truthBoundary": {
            "heldoutUsedForSelection": False,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "combined-summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
