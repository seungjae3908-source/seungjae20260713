#!/usr/bin/env python3
import argparse
import csv
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

THRESHOLDS = (0.10, 0.20, 0.50, 1.00, 2.00)
WINDOWS = (1, 3, 5)
STOP = -0.08
COOLDOWN_BARS = 5


def parse_date(value):
    s = str(value).strip()
    for fmt in ("%Y%m%d", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def iter_stock_files(root):
    root = Path(root)
    for p in root.rglob("*.txt"):
        low = str(p).lower()
        if " etfs" in low or "/etfs" in low or "\\etfs" in low:
            continue
        yield p


def read_bars(path):
    bars = []
    try:
        with open(path, "r", encoding="utf-8", errors="ignore", newline="") as f:
            reader = csv.reader(f)
            first = next(reader, None)
            if not first:
                return bars
            header = [x.strip().strip("<>").upper() for x in first]
            has_header = "DATE" in header and "OPEN" in header
            if has_header:
                idx = {name: header.index(name) for name in ("DATE", "OPEN", "HIGH", "LOW", "CLOSE", "VOL") if name in header}
                rows = reader
            else:
                idx = {"DATE": 2, "OPEN": 4, "HIGH": 5, "LOW": 6, "CLOSE": 7, "VOL": 8}
                rows = iter([first] + list(reader))
            required = ("DATE", "OPEN", "HIGH", "LOW", "CLOSE", "VOL")
            if any(k not in idx for k in required):
                return bars
            for row in rows:
                try:
                    d = parse_date(row[idx["DATE"]])
                    if d is None:
                        continue
                    o = float(row[idx["OPEN"]])
                    h = float(row[idx["HIGH"]])
                    l = float(row[idx["LOW"]])
                    c = float(row[idx["CLOSE"]])
                    v = float(row[idx["VOL"]])
                    if not all(math.isfinite(x) for x in (o, h, l, c, v)):
                        continue
                    if min(o, h, l, c) <= 0 or v < 0:
                        continue
                    if h + 1e-12 < max(o, c) or l - 1e-12 > min(o, c) or h < l:
                        continue
                    bars.append({"date": d, "open": o, "high": h, "low": l, "close": c, "volume": v})
                except (ValueError, IndexError, TypeError):
                    continue
    except (OSError, UnicodeError):
        return []
    bars.sort(key=lambda x: x["date"])
    dedup = {}
    for b in bars:
        dedup[b["date"]] = b
    return list(dedup.values())


def safe_mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def evaluate_window(bars, i, n):
    end = min(len(bars), i + n)
    chunk = bars[i:end]
    if not chunk:
        return None
    entry = bars[i]["open"]
    return {
        "max_return": max(b["high"] for b in chunk) / entry - 1,
        "min_return": min(b["low"] for b in chunk) / entry - 1,
        "close_return": chunk[-1]["close"] / entry - 1,
        "days": len(chunk),
    }


def conservative_first_touch(bars, i, n, target):
    """Daily OHLC cannot resolve intraday order; ambiguous bars count stop first."""
    entry = bars[i]["open"]
    target_px = entry * (1 + target)
    stop_px = entry * (1 + STOP)
    end = min(len(bars), i + n)
    for j in range(i, end):
        b = bars[j]
        hit_target = b["high"] >= target_px
        hit_stop = b["low"] <= stop_px
        if hit_stop:
            return "stop"
        if hit_target:
            return "target"
    return "neither"


def new_acc():
    return {
        "signals": 0,
        "symbols": set(),
        "first_date": None,
        "last_date": None,
        "max_returns": {w: [] for w in WINDOWS},
        "min_returns": {w: [] for w in WINDOWS},
        "close_returns": {w: [] for w in WINDOWS},
        "hits": {w: {t: 0 for t in THRESHOLDS} for w in WINDOWS},
        "stops": {w: 0 for w in WINDOWS},
        "both": {w: {t: 0 for t in THRESHOLDS} for w in WINDOWS},
        "first_touch_5d": {t: {"target": 0, "stop": 0, "neither": 0} for t in (0.20, 0.50, 1.00, 2.00)},
        "examples": [],
    }


def pct(v):
    return round(v * 100, 3)


def percentile(xs, q):
    if not xs:
        return None
    ys = sorted(xs)
    if len(ys) == 1:
        return ys[0]
    pos = (len(ys) - 1) * q
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return ys[lo]
    return ys[lo] * (hi - pos) + ys[hi] * (pos - lo)


def record(acc, symbol, bars, i, meta):
    acc["signals"] += 1
    acc["symbols"].add(symbol)
    d = bars[i]["date"].isoformat()
    if acc["first_date"] is None or d < acc["first_date"]:
        acc["first_date"] = d
    if acc["last_date"] is None or d > acc["last_date"]:
        acc["last_date"] = d
    for w in WINDOWS:
        ev = evaluate_window(bars, i, w)
        if not ev:
            continue
        acc["max_returns"][w].append(ev["max_return"])
        acc["min_returns"][w].append(ev["min_return"])
        acc["close_returns"][w].append(ev["close_return"])
        if ev["min_return"] <= STOP:
            acc["stops"][w] += 1
        for t in THRESHOLDS:
            if ev["max_return"] >= t:
                acc["hits"][w][t] += 1
            if ev["max_return"] >= t and ev["min_return"] <= STOP:
                acc["both"][w][t] += 1
    for t in (0.20, 0.50, 1.00, 2.00):
        outcome = conservative_first_touch(bars, i, 5, t)
        acc["first_touch_5d"][t][outcome] += 1
    if len(acc["examples"]) < 25:
        ex = {"symbol": symbol, "date": d, **meta}
        ev5 = evaluate_window(bars, i, 5)
        if ev5:
            ex["max5dPct"] = pct(ev5["max_return"])
            ex["min5dPct"] = pct(ev5["min_return"])
        acc["examples"].append(ex)


def finalize(acc):
    n = acc["signals"]
    out = {
        "signals": n,
        "uniqueSymbols": len(acc["symbols"]),
        "firstSignalDate": acc["first_date"],
        "lastSignalDate": acc["last_date"],
        "hitRatesPct": {},
        "stopTouchRatePct": {},
        "bothTargetAndStopRatePct": {},
        "maxReturnDistributionPct": {},
        "fiveDayConservativeFirstTouchPct": {},
        "examples": acc["examples"],
    }
    for w in WINDOWS:
        out["hitRatesPct"][f"{w}d"] = {
            f"+{int(t * 100)}%": pct(acc["hits"][w][t] / n) if n else None for t in THRESHOLDS
        }
        out["stopTouchRatePct"][f"{w}d"] = pct(acc["stops"][w] / n) if n else None
        out["bothTargetAndStopRatePct"][f"{w}d"] = {
            f"+{int(t * 100)}%": pct(acc["both"][w][t] / n) if n else None for t in THRESHOLDS
        }
        xs = acc["max_returns"][w]
        out["maxReturnDistributionPct"][f"{w}d"] = {
            "median": pct(percentile(xs, 0.5)) if xs else None,
            "p75": pct(percentile(xs, 0.75)) if xs else None,
            "p90": pct(percentile(xs, 0.9)) if xs else None,
            "p95": pct(percentile(xs, 0.95)) if xs else None,
        }
    for t, counts in acc["first_touch_5d"].items():
        out["fiveDayConservativeFirstTouchPct"][f"+{int(t * 100)}%"] = {
            k: pct(v / n) if n else None for k, v in counts.items()
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("roots", nargs="+", help="One or more Stooq stock directories")
    ap.add_argument("--output-json", default="microcap-proxy-backtest.json")
    ap.add_argument("--output-md", default="microcap-proxy-backtest.md")
    ap.add_argument("--years", type=float, default=10.0)
    ap.add_argument("--min-price", type=float, default=0.5)
    ap.add_argument("--max-price", type=float, default=10.0)
    ap.add_argument("--min-gap", type=float, default=0.10)
    ap.add_argument("--max-gap", type=float, default=0.40)
    ap.add_argument("--min-prev-dollar-volume", type=float, default=1_000_000)
    ap.add_argument("--min-rvol", type=float, default=5.0)
    args = ap.parse_args()

    files = []
    for root in args.roots:
        files.extend(iter_stock_files(root))
    files = sorted(set(files))
    if not files:
        raise SystemExit("No Stooq .txt stock files found")

    global_max = None
    valid_files = 0
    for p in files:
        bars = read_bars(p)
        if not bars:
            continue
        valid_files += 1
        d = bars[-1]["date"]
        if global_max is None or d > global_max:
            global_max = d
    if global_max is None:
        raise SystemExit("No valid bars found")
    start_date = global_max - timedelta(days=round(args.years * 365.2425))

    variants = {
        "GAP_LIQUID_OPEN": new_acc(),
        "PREV_RVOL5_OPEN": new_acc(),
        "DAY_RVOL5_ORACLE": new_acc(),
    }
    last_signal = {name: {} for name in variants}
    rows_seen = 0
    files_used = 0

    for p in files:
        bars = read_bars(p)
        if len(bars) < 25:
            continue
        files_used += 1
        symbol = p.stem.replace(".us", "").upper()
        for i in range(21, len(bars)):
            b = bars[i]
            prev = bars[i - 1]
            if b["date"] < start_date or b["date"] > global_max:
                continue
            rows_seen += 1
            prev_close = prev["close"]
            if not (args.min_price <= prev_close <= args.max_price):
                continue
            gap = b["open"] / prev_close - 1
            if not (args.min_gap <= gap <= args.max_gap):
                continue
            prior20 = [x["volume"] for x in bars[i - 21 : i - 1]]
            current_prev20 = [x["volume"] for x in bars[i - 20 : i]]
            avg_prior20 = safe_mean(prior20)
            avg_prev20 = safe_mean(current_prev20)
            if avg_prior20 <= 0 or avg_prev20 <= 0:
                continue
            prev_rvol = prev["volume"] / avg_prior20
            day_rvol = b["volume"] / avg_prev20
            prev_dollar = prev_close * prev["volume"]
            day_dollar = b["open"] * b["volume"]
            base = prev_dollar >= args.min_prev_dollar_volume
            conditions = {
                "GAP_LIQUID_OPEN": base,
                "PREV_RVOL5_OPEN": base and prev_rvol >= args.min_rvol,
                "DAY_RVOL5_ORACLE": day_dollar >= args.min_prev_dollar_volume and day_rvol >= args.min_rvol,
            }
            meta = {
                "entryOpen": round(b["open"], 6),
                "previousClose": round(prev_close, 6),
                "gapPct": pct(gap),
                "previousDollarVolume": round(prev_dollar, 2),
                "previousDayRvol": round(prev_rvol, 3),
                "signalDayRvol": round(day_rvol, 3),
            }
            for name, ok in conditions.items():
                if not ok:
                    continue
                prev_idx = last_signal[name].get(symbol, -10_000)
                if i - prev_idx < COOLDOWN_BARS:
                    continue
                last_signal[name][symbol] = i
                record(variants[name], symbol, bars, i, meta)

    result = {
        "schemaVersion": 1,
        "method": "US microcap explosive-move daily OHLCV proxy event study",
        "snapshotEndDate": global_max.isoformat(),
        "windowStartDate": start_date.isoformat(),
        "yearsRequested": args.years,
        "filesDiscovered": len(files),
        "validFilesPass1": valid_files,
        "filesUsed": files_used,
        "candidateRowsScanned": rows_seen,
        "signalDefinition": {
            "price": f"previous close in ${args.min_price}-${args.max_price}",
            "gap": f"open gap {pct(args.min_gap)}%-{pct(args.max_gap)}%",
            "liquidity": f"previous-day dollar volume >= ${args.min_prev_dollar_volume:,.0f}",
            "previousRvolVariant": f"previous-day volume / prior-20d average >= {args.min_rvol}",
            "oracleRvolVariant": f"signal-day full volume / previous-20d average >= {args.min_rvol} (LOOK-AHEAD; diagnostic only)",
            "cooldownBarsPerSymbol": COOLDOWN_BARS,
            "entry": "signal-day regular-session open",
            "outcomes": "maximum high from entry over 1/3/5 trading days",
            "stopDiagnostic": "-8% low touch; daily OHLC cannot resolve exact intraday order",
        },
        "variants": {name: finalize(acc) for name, acc in variants.items()},
        "limitations": [
            "No point-in-time float/market-cap filter.",
            "No archived fresh-news/catalyst filter.",
            "No premarket volume, spread, VWAP, or intraday breakout/retest data.",
            "DAY_RVOL5_ORACLE uses full-day volume and is not tradable; it is an optimistic diagnostic ceiling only.",
            "Stooq security classification may include ADRs or other stock-like listings and is not a CRSP/Sharadar common-stock master.",
            "Split/adjustment conventions can affect historical sub-$10 classification; this proxy is not yet point-in-time corporate-action-clean.",
            "The public mirror snapshot is not current to 2026 and may not be survivorship-bias-free.",
            "Daily OHLC cannot determine whether target or stop occurred first inside one bar; conservative first-touch counts stop first on ambiguous bars.",
        ],
    }

    out_json = Path(args.output_json)
    out_md = Path(args.output_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str), encoding="utf-8")

    lines = [
        "# US Microcap Explosive-Move Proxy Backtest",
        "",
        f"- Snapshot end: **{result['snapshotEndDate']}**",
        f"- Window start: **{result['windowStartDate']}**",
        f"- Files: **{result['filesUsed']:,}**",
        "",
        "## Main results",
        "",
        "| Variant | Signals | Symbols | +20% 1d | +50% 1d | +100% 1d | +200% 1d | +100% 5d | +200% 5d | -8% touch 1d |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name, v in result["variants"].items():
        h1 = v["hitRatesPct"]["1d"]
        h5 = v["hitRatesPct"]["5d"]
        lines.append(
            f"| {name} | {v['signals']:,} | {v['uniqueSymbols']:,} | {h1['+20%']}% | {h1['+50%']}% | {h1['+100%']}% | {h1['+200%']}% | {h5['+100%']}% | {h5['+200%']}% | {v['stopTouchRatePct']['1d']}% |"
        )
    lines += ["", "## Important limitations", ""]
    lines += [f"- {x}" for x in result["limitations"]]
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
