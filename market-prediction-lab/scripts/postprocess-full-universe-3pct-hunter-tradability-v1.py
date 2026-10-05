#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import polars as pl

THRESHOLDS = [0.03, 0.05, 0.10, 0.20, 0.50, 1.00]

PROFILES = {
    "US_STOCK": {
        "LOOSE": (pl.col("open") >= 1.0) & (pl.col("prior_dollar_volume20") >= 1_000_000)
                 & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
        "STRICT": (pl.col("open") >= 2.0) & (pl.col("prior_dollar_volume20") >= 5_000_000)
                  & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
    },
    "KR_STOCK": {
        "LOOSE": (pl.col("open") >= 1_000.0) & (pl.col("prior_dollar_volume20") >= 500_000_000)
                 & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
        "STRICT": (pl.col("open") >= 1_000.0) & (pl.col("prior_dollar_volume20") >= 2_000_000_000)
                  & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
    },
    "CRYPTO_SPOT": {
        "LOOSE": (pl.col("prior_dollar_volume20") >= 1_000_000)
                 & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
        "STRICT": (pl.col("prior_dollar_volume20") >= 5_000_000)
                  & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
    },
    "CRYPTO_FUTURES": {
        "LOOSE": (pl.col("prior_dollar_volume20") >= 1_000_000)
                 & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
        "STRICT": (pl.col("prior_dollar_volume20") >= 5_000_000)
                  & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
    },
}

def summarize(frame: pl.DataFrame, market: str) -> dict:
    out = {}
    for profile, predicate in PROFILES[market].items():
        x = frame.filter(predicate)
        stats = {
            "opportunityRows3pctPlus": x.height,
            "distinctSymbols": x.select("symbol").unique().height,
            "activeDates": x.select("date").unique().height,
            "thresholds": {},
        }
        for threshold in THRESHOLDS:
            y = x.filter(pl.col("max_move") >= threshold)
            stats["thresholds"][f"{int(threshold*100)}pct"] = {
                "count": y.height,
                "distinctSymbols": y.select("symbol").unique().height,
                "activeDates": y.select("date").unique().height,
            }
        if market == "CRYPTO_FUTURES":
            stats["directions"] = {}
            for direction in ["LONG", "SHORT"]:
                d = x.filter(pl.col("direction") == direction)
                stats["directions"][direction] = {
                    "3pct": d.height,
                    "5pct": d.filter(pl.col("max_move") >= 0.05).height,
                    "10pct": d.filter(pl.col("max_move") >= 0.10).height,
                    "20pct": d.filter(pl.col("max_move") >= 0.20).height,
                    "50pct": d.filter(pl.col("max_move") >= 0.50).height,
                }
        out[profile] = stats
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-root", required=True)
    ap.add_argument("--output-dir", required=True)
    args = ap.parse_args()

    root = Path(args.input_root)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(root.glob("**/all-opportunities-3pct-plus.parquet"))
    if not files:
        raise RuntimeError("NO_CENSUS_PARQUET_ARTIFACTS")

    result = {
        "schemaVersion": 1,
        "contract": "full-universe-3pct-hunter-tradability-v1",
        "note": "Filters are applied only after the raw opportunity census. They do not create profitability or execution authority.",
        "profiles": {
            "LOOSE": "broad liquidity/price/history screen",
            "STRICT": "higher-liquidity research screen",
        },
        "markets": {},
    }

    for file in files:
        frame = pl.read_parquet(file)
        if frame.is_empty():
            continue
        market = str(frame["market"][0])
        if market not in PROFILES:
            continue
        result["markets"][market] = summarize(frame, market)

        strict = frame.filter(PROFILES[market]["STRICT"])
        strict.sort("max_move", descending=True).head(5000).write_csv(
            out_dir / f"{market.lower()}-strict-top5000.csv"
        )

    missing = [m for m in PROFILES if m not in result["markets"]]
    result["missingMarkets"] = missing
    (out_dir / "tradability-summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
