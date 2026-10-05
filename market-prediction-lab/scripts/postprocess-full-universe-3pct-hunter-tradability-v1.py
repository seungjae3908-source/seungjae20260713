#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import polars as pl

THRESHOLDS = [0.03, 0.05, 0.10, 0.20, 0.50, 1.00]

WINDOW_SESSIONS = {
    "US_STOCK": [("1D", 1), ("1W", 5), ("1M", 21), ("3M", 63), ("6M", 126), ("1Y", 252), ("3Y", None)],
    "KR_STOCK": [("1D", 1), ("1W", 5), ("1M", 21), ("3M", 63), ("6M", 126), ("1Y", 252), ("3Y", None)],
    "CRYPTO_SPOT": [("1D", 1), ("1W", 7), ("1M", 30), ("3M", 90), ("6M", 183), ("1Y", 365), ("3Y", None)],
    "CRYPTO_FUTURES": [("1D", 1), ("1W", 7), ("1M", 30), ("3M", 90), ("6M", 183), ("1Y", 365), ("3Y", None)],
}

US_NOT_TEST = ~pl.col("symbol").str.contains(r"^(ZVZZ|ZWZZ)")

PROFILES = {
    "US_STOCK": {
        "LOOSE": US_NOT_TEST & (pl.col("open") >= 1.0) & (pl.col("prior_dollar_volume20") >= 1_000_000)
                 & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
        "STRICT": US_NOT_TEST & (pl.col("open") >= 2.0) & (pl.col("prior_dollar_volume20") >= 10_000_000)
                  & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
    },
    "KR_STOCK": {
        "LOOSE": (pl.col("open") >= 1_000.0) & (pl.col("prior_dollar_volume20") >= 500_000_000)
                 & pl.col("ret20_prev").is_not_null() & pl.col("prior_rvol").is_not_null(),
        "STRICT": (pl.col("open") >= 1_000.0) & (pl.col("prior_dollar_volume20") >= 1_000_000_000)
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

ALLOWED_DIRECTIONS = {
    "US_STOCK": {"LONG"},
    "KR_STOCK": {"LONG"},
    "CRYPTO_SPOT": {"LONG"},
    "CRYPTO_FUTURES": {"LONG", "SHORT"},
}


def threshold_counts(frame: pl.DataFrame) -> dict:
    out = {}
    for threshold in THRESHOLDS:
        y = frame.filter(pl.col("max_move") >= threshold)
        out[f"{int(threshold*100)}pct"] = {
            "count": y.height,
            "distinctSymbols": y.select("symbol").unique().height,
            "activeDates": y.select("date").unique().height,
            "maxMove": float(y.select(pl.col("max_move").max()).item()) if y.height else None,
        }
    return out


def assert_direction_policy(frame: pl.DataFrame, market: str) -> dict:
    observed = set(frame.get_column("direction").unique().to_list()) if frame.height else set()
    forbidden = observed - ALLOWED_DIRECTIONS[market]
    if forbidden:
        raise RuntimeError(f"DIRECTION_POLICY_VIOLATION:{market}:{sorted(forbidden)}")
    if market != "CRYPTO_FUTURES" and "SHORT" in observed:
        raise RuntimeError(f"SHORT_FORBIDDEN:{market}")
    return {
        "allowed": sorted(ALLOWED_DIRECTIONS[market]),
        "observed": sorted(observed),
        "verified": True,
    }


def load_source_summaries(root: Path) -> dict:
    summaries = {}
    for file in root.glob("**/summary.json"):
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if data.get("contract") != "full-universe-3pct-hunter-census-v2":
            continue
        for market, summary in (data.get("markets") or {}).items():
            summaries[market] = summary
    return summaries


def assert_source_coverage(market: str, market_summary: dict | None) -> dict:
    if not market_summary:
        raise RuntimeError(f"MISSING_SOURCE_SUMMARY:{market}")
    source = market_summary.get("source") or {}
    mode = str(source.get("coverageMode") or "")
    if market == "KR_STOCK":
        if "ALL_MARKET" not in mode or "FALLBACK" in mode:
            raise RuntimeError(f"KR_FULL_UNIVERSE_COVERAGE_REQUIRED:{mode}")
    elif market == "US_STOCK":
        if int(source.get("monthCount") or 0) < 34:
            raise RuntimeError(f"US_MONTH_COVERAGE_TOO_LOW:{source.get('monthCount')}")
    else:
        if int(source.get("usableFiles") or 0) <= 0:
            raise RuntimeError(f"{market}_SOURCE_FILES_MISSING")
    return {
        "provider": source.get("provider"),
        "coverageMode": mode,
        "verified": True,
    }


def top_symbols(frame: pl.DataFrame, market: str, limit: int = 50) -> list[dict]:
    if frame.is_empty():
        return []
    keys = ["symbol", "direction"] if market == "CRYPTO_FUTURES" else ["symbol"]
    return (
        frame.group_by(keys)
        .agg([
            pl.len().alias("count3pct"),
            (pl.col("max_move") >= 0.05).sum().alias("count5pct"),
            (pl.col("max_move") >= 0.10).sum().alias("count10pct"),
            (pl.col("max_move") >= 0.20).sum().alias("count20pct"),
            (pl.col("max_move") >= 0.50).sum().alias("count50pct"),
            (pl.col("max_move") >= 1.00).sum().alias("count100pct"),
            pl.col("max_move").max().alias("maxMove"),
            pl.col("max_move").mean().alias("meanMove"),
            pl.col("date").n_unique().alias("activeDates"),
        ])
        .sort(["count10pct", "count3pct", "maxMove"], descending=[True, True, True])
        .head(limit)
        .to_dicts()
    )


def window_breakdown(frame: pl.DataFrame, market: str, market_dates: list) -> dict:
    out = {}
    for label, n in WINDOW_SESSIONS[market]:
        selected_dates = market_dates if n is None else market_dates[-n:]
        x = frame.filter(pl.col("date").is_in(selected_dates)) if selected_dates else frame.head(0)
        out[label] = {
            "startDate": str(selected_dates[0]) if selected_dates else None,
            "endDate": str(selected_dates[-1]) if selected_dates else None,
            "sessions": len(selected_dates),
            "thresholds": threshold_counts(x),
            "topSymbols": top_symbols(x, market, 20),
        }
        if market == "CRYPTO_FUTURES":
            out[label]["directions"] = {
                direction: threshold_counts(x.filter(pl.col("direction") == direction))
                for direction in ["LONG", "SHORT"]
            }
    return out


def summarize(frame: pl.DataFrame, market: str, market_dates: list) -> dict:
    out = {}
    for profile, predicate in PROFILES[market].items():
        x = frame.filter(predicate)
        stats = {
            "opportunityRows3pctPlus": x.height,
            "distinctSymbols": x.select("symbol").unique().height,
            "activeDates": x.select("date").unique().height,
            "thresholds": threshold_counts(x),
        }
        if market == "CRYPTO_FUTURES":
            stats["directions"] = {
                direction: threshold_counts(x.filter(pl.col("direction") == direction))
                for direction in ["LONG", "SHORT"]
            }
        stats["windows"] = window_breakdown(x, market, market_dates)
        stats["topSymbols"] = top_symbols(x, market, 50)
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

    source_summaries = load_source_summaries(root)
    result = {
        "schemaVersion": 2,
        "contract": "full-universe-3pct-hunter-tradability-v1",
        "note": "Filters are applied only after the raw opportunity census. They do not create profitability or execution authority.",
        "profiles": {
            "LOOSE": "broad liquidity/price/history screen",
            "STRICT": "higher-liquidity research screen",
        },
        "markets": {},
        "directionPolicyAudit": {},
        "sourceCoverageAudit": {},
    }
    flat_rows = []

    for file in files:
        frame = pl.read_parquet(file)
        if frame.is_empty():
            continue
        markets = frame.get_column("market").unique().to_list()
        if len(markets) != 1:
            raise RuntimeError(f"MIXED_MARKETS_IN_ARTIFACT:{file}")
        market = str(markets[0])
        if market not in PROFILES:
            continue

        result["directionPolicyAudit"][market] = assert_direction_policy(frame, market)
        result["sourceCoverageAudit"][market] = assert_source_coverage(market, source_summaries.get(market))
        market_dates = frame.select("date").unique().sort("date").get_column("date").to_list()
        result["markets"][market] = summarize(frame, market, market_dates)

        strict = frame.filter(PROFILES[market]["STRICT"])
        strict.sort("max_move", descending=True).head(5000).write_csv(
            out_dir / f"{market.lower()}-strict-top5000.csv"
        )

        for profile, stats in result["markets"][market].items():
            for label, window in stats["windows"].items():
                row = {
                    "market": market,
                    "profile": profile,
                    "window": label,
                    "startDate": window["startDate"],
                    "endDate": window["endDate"],
                    "sessions": window["sessions"],
                    "topSymbols": json.dumps(window["topSymbols"][:10], ensure_ascii=False),
                }
                for threshold in THRESHOLDS:
                    key = f"{int(threshold*100)}pct"
                    row[key] = window["thresholds"][key]["count"]
                flat_rows.append(row)

    missing = [m for m in PROFILES if m not in result["markets"]]
    result["missingMarkets"] = missing

    (out_dir / "tradability-summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if flat_rows:
        fieldnames = list(flat_rows[0].keys())
        with (out_dir / "tradability-window-table.csv").open("w", newline="", encoding="utf-8-sig") as fp:
            writer = csv.DictWriter(fp, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(flat_rows)

    if missing:
        raise RuntimeError(f"MISSING_MARKETS:{','.join(missing)}")

    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
