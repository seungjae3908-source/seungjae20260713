#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from datetime import date
from pathlib import Path

MARKET_ORDER = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]
WINDOWS = ["1D","1W","1M","3M","6M","1Y","3Y"]
COMBINED_WINDOW_DAYS = {
    "1D": 1,
    "1W": 7,
    "1M": 30,
    "3M": 90,
    "6M": 183,
    "1Y": 365,
    "3Y": None,
}
THRESHOLDS = [0.03, 0.05, 0.10, 0.20, 0.50, 1.00]
ALLOWED_DIRECTIONS = {
    "KR_STOCK": {"LONG"},
    "US_STOCK": {"LONG"},
    "CRYPTO_SPOT": {"LONG"},
    "CRYPTO_FUTURES": {"LONG", "SHORT"},
}


def compound(values: list[float]) -> float:
    wealth = 1.0
    for value in values:
        wealth *= 1.0 + float(value)
    return wealth - 1.0


def max_drawdown(values: list[float]) -> float:
    wealth = 1.0
    peak = 1.0
    worst = 0.0
    for value in values:
        wealth *= 1.0 + float(value)
        peak = max(peak, wealth)
        worst = max(worst, (peak - wealth) / peak)
    return worst


def longest_negative_streak(values: list[float]) -> int:
    current = 0
    best = 0
    for value in values:
        if value < 0:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return best


def load_daily(path: Path) -> dict[str, dict]:
    out = {}
    with path.open("r", encoding="utf-8-sig", newline="") as fp:
        for row in csv.DictReader(fp):
            key = row["date"][:10]
            out[key] = {
                "return": float(row["portfolioReturn"]),
                "trades": int(float(row["trades"])),
            }
    return out


def integrated_metrics(daily_by_market: dict[str, dict[str, dict]]) -> tuple[dict, list[dict]]:
    all_dates = sorted({d for rows in daily_by_market.values() for d in rows})
    combined_daily = []
    for d in all_dates:
        market_returns = []
        trades = 0
        for market in MARKET_ORDER:
            row = daily_by_market.get(market, {}).get(d)
            market_returns.append(float(row["return"]) if row else 0.0)
            trades += int(row["trades"]) if row else 0
        combined_daily.append({
            "date": d,
            "portfolioReturn": sum(market_returns) / 4.0,
            "trades": trades,
        })

    returns = [r["portfolioReturn"] for r in combined_daily]
    months = {}
    for row in combined_daily:
        month = row["date"][:7]
        months.setdefault(month, []).append(row["portfolioReturn"])
    monthly = {m: compound(v) for m, v in sorted(months.items())}
    monthly_values = list(monthly.values())

    metrics = {
        "tradeCount": sum(r["trades"] for r in combined_daily),
        "activeDays": sum(1 for r in combined_daily if r["trades"] > 0),
        "marketDays": len(combined_daily),
        "totalReturn": compound(returns),
        "mdd": max_drawdown(returns),
        "monthsPositive": sum(1 for v in monthly_values if v > 0),
        "monthsNegative": sum(1 for v in monthly_values if v < 0),
        "monthsFlat": sum(1 for v in monthly_values if v == 0),
        "monthsTotal": len(monthly_values),
        "positiveMonthRate": (
            sum(1 for v in monthly_values if v > 0) / len(monthly_values)
            if monthly_values else None
        ),
        "bestMonth": max(monthly, key=monthly.get) if monthly else None,
        "bestMonthReturn": max(monthly_values) if monthly_values else None,
        "worstMonth": min(monthly, key=monthly.get) if monthly else None,
        "worstMonthReturn": min(monthly_values) if monthly_values else None,
        "longestLosingMonthStreak": longest_negative_streak(monthly_values),
        "windows": {},
    }
    for threshold in THRESHOLDS:
        key = int(threshold * 100)
        metrics[f"days{key}pctPlus"] = sum(1 for r in returns if r >= threshold)
        metrics[f"months{key}pctPlus"] = sum(1 for r in monthly_values if r >= threshold)

    for label, n in COMBINED_WINDOW_DAYS.items():
        selected = combined_daily if n is None else combined_daily[-n:]
        vals = [r["portfolioReturn"] for r in selected]
        row = {
            "startDate": selected[0]["date"] if selected else None,
            "endDate": selected[-1]["date"] if selected else None,
            "marketDays": len(selected),
            "return": compound(vals) if vals else 0.0,
            "tradeCount": sum(r["trades"] for r in selected),
            "positiveDays": sum(1 for r in vals if r > 0),
            "negativeDays": sum(1 for r in vals if r < 0),
        }
        for threshold in THRESHOLDS:
            key = int(threshold * 100)
            row[f"days{key}pctPlus"] = sum(1 for r in vals if r >= threshold)
        metrics["windows"][label] = row

    return metrics, combined_daily


def audit_ledger(market: str, path: Path) -> dict:
    observed = set()
    trade_count = 0
    with path.open("r", encoding="utf-8-sig", newline="") as fp:
        reader = csv.DictReader(fp)
        for row in reader:
            if row.get("market") and row["market"] != market:
                raise RuntimeError(f"LEDGER_MARKET_MISMATCH:{market}:{row['market']}")
            direction = row.get("direction")
            if direction:
                observed.add(direction)
            trade_count += 1
    forbidden = observed - ALLOWED_DIRECTIONS[market]
    if forbidden:
        raise RuntimeError(f"DIRECTION_POLICY_VIOLATION:{market}:{sorted(forbidden)}")
    if market != "CRYPTO_FUTURES" and "SHORT" in observed:
        raise RuntimeError(f"SHORT_FORBIDDEN:{market}")
    return {
        "allowed": sorted(ALLOWED_DIRECTIONS[market]),
        "observed": sorted(observed),
        "tradeCount": trade_count,
        "verified": True,
    }


def table_row(label: str, direction: str, metrics: dict, selected_variant: str | None) -> dict:
    row = {
        "market": label,
        "direction": direction,
        "selectedVariant": selected_variant or "",
        "tradeCount": metrics.get("tradeCount", 0),
        "winRate3Y": metrics.get("winRate"),
        "profitFactor3Y": metrics.get("profitFactor"),
        "mdd3Y": metrics.get("mdd"),
        "monthsPositive3Y": metrics.get("monthsPositive"),
        "monthsNegative3Y": metrics.get("monthsNegative"),
        "monthsTotal3Y": metrics.get("monthsTotal"),
        "worstMonthReturn3Y": metrics.get("worstMonthReturn"),
        "longestLosingMonthStreak3Y": metrics.get("longestLosingMonthStreak"),
    }
    for window in WINDOWS:
        w = (metrics.get("windows") or {}).get(window, {})
        row[f"{window}_return"] = w.get("return")
        row[f"{window}_trades"] = w.get("tradeCount")
    for threshold in THRESHOLDS:
        key = int(threshold * 100)
        row[f"days{key}pctPlus"] = metrics.get(f"days{key}pctPlus")
        row[f"months{key}pctPlus"] = metrics.get(f"months{key}pctPlus")
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
    dirs = {}
    for file in root.glob("**/summary.json"):
        data = json.loads(file.read_text(encoding="utf-8"))
        if data.get("contract") != "full-universe-3pct-hunter-causal-backtest-v1":
            continue
        market = data.get("market")
        if market:
            summaries[market] = data
            dirs[market] = file.parent

    missing = [m for m in MARKET_ORDER if m not in summaries]
    if missing:
        raise RuntimeError(f"MISSING_MARKET_SUMMARIES:{','.join(missing)}")

    direction_audit = {}
    daily_by_market = {}
    for market in MARKET_ORDER:
        ledger = dirs[market] / "selected-ledger.csv"
        daily = dirs[market] / "daily-portfolio.csv"
        if not ledger.exists():
            raise RuntimeError(f"MISSING_LEDGER:{market}")
        if not daily.exists():
            raise RuntimeError(f"MISSING_DAILY_PORTFOLIO:{market}")
        direction_audit[market] = audit_ledger(market, ledger)
        daily_by_market[market] = load_daily(daily)

    # One combined ledger preserving every selected trade from every market.
    combined_ledger_path = out / "combined-selected-ledger.csv"
    writer = None
    fp_out = combined_ledger_path.open("w", newline="", encoding="utf-8-sig")
    try:
        expected_fields = None
        for market in MARKET_ORDER:
            with (dirs[market] / "selected-ledger.csv").open("r", encoding="utf-8-sig", newline="") as fp:
                reader = csv.DictReader(fp)
                fields = reader.fieldnames or []
                if expected_fields is None:
                    expected_fields = fields
                    writer = csv.DictWriter(fp_out, fieldnames=expected_fields)
                    writer.writeheader()
                elif fields != expected_fields:
                    raise RuntimeError(f"LEDGER_SCHEMA_MISMATCH:{market}")
                for row in reader:
                    writer.writerow(row)
    finally:
        fp_out.close()

    integrated, combined_daily = integrated_metrics(daily_by_market)
    with (out / "combined-daily-portfolio.csv").open("w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.DictWriter(fp, fieldnames=["date","portfolioReturn","trades"])
        writer.writeheader()
        writer.writerows(combined_daily)

    final_rows = []
    final_rows.append(table_row(
        "KR_STOCK", "LONG",
        summaries["KR_STOCK"]["selectedObservedThreeYear"],
        summaries["KR_STOCK"]["selectedVariantFromFirstTwoYears"],
    ))
    final_rows.append(table_row(
        "US_STOCK", "LONG",
        summaries["US_STOCK"]["selectedObservedThreeYear"],
        summaries["US_STOCK"]["selectedVariantFromFirstTwoYears"],
    ))
    final_rows.append(table_row(
        "CRYPTO_SPOT", "LONG",
        summaries["CRYPTO_SPOT"]["selectedObservedThreeYear"],
        summaries["CRYPTO_SPOT"]["selectedVariantFromFirstTwoYears"],
    ))

    futures = summaries["CRYPTO_FUTURES"]
    direction_breakdown = futures.get("selectedDirectionBreakdownThreeYear") or {}
    for direction in ("LONG","SHORT"):
        if direction not in direction_breakdown:
            raise RuntimeError(f"MISSING_FUTURES_DIRECTION_METRICS:{direction}")
        final_rows.append(table_row(
            "CRYPTO_FUTURES", direction,
            direction_breakdown[direction],
            futures["selectedVariantFromFirstTwoYears"],
        ))

    final_rows.append(table_row("ALL_4_MARKETS", "MIXED", integrated, None))

    with (out / "final-return-table.csv").open("w", newline="", encoding="utf-8-sig") as fp:
        fieldnames = list(final_rows[0].keys())
        writer = csv.DictWriter(fp, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(final_rows)

    combined = {
        "schemaVersion": 2,
        "contract": "full-universe-3pct-hunter-causal-combined-v1",
        "markets": summaries,
        "directionPolicyAudit": direction_audit,
        "finalTable": final_rows,
        "integratedFourMarket": {
            "allocation": "fixed 25% sleeve per market; closed/no-trade sleeve return is 0%",
            "metrics": integrated,
        },
        "truthBoundary": {
            "observedThreeYearIsIndependentOos": False,
            "heldoutLastYearSelectedWithoutUsingHeldoutForVariantChoice": True,
            "dailyOHLCExecutionApproximation": True,
            "crossMarketCalendarAlignmentUsesDateLabels": True,
            "intradayTMinusValidationStillRequired": True,
            "profitabilityProven": False,
            "executionAuthority": "NONE",
        },
    }
    (out / "combined-summary.json").write_text(
        json.dumps(combined, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(json.dumps(combined, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
