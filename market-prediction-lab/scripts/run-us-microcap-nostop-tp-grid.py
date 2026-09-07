#!/usr/bin/env python3
import argparse
import csv
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

TARGETS = (0.03, 0.05, 0.07, 0.10, 0.15)
HORIZONS = (1, 3, 5)
COST_BPS = (0, 100, 200)
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
    for p in Path(root).rglob("*.txt"):
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
            if "DATE" in header and "OPEN" in header:
                idx = {name: header.index(name) for name in ("DATE", "OPEN", "HIGH", "LOW", "CLOSE", "VOL") if name in header}
                rows = reader
            else:
                idx = {"DATE": 2, "OPEN": 4, "HIGH": 5, "LOW": 6, "CLOSE": 7, "VOL": 8}
                rows = iter([first] + list(reader))
            if any(k not in idx for k in ("DATE", "OPEN", "HIGH", "LOW", "CLOSE", "VOL")):
                return bars
            for row in rows:
                try:
                    d = parse_date(row[idx["DATE"]])
                    if d is None:
                        continue
                    o, h, l, c, v = (float(row[idx[k]]) for k in ("OPEN", "HIGH", "LOW", "CLOSE", "VOL"))
                    if not all(math.isfinite(x) for x in (o, h, l, c, v)):
                        continue
                    if min(o, h, l, c) <= 0 or v < 0 or h < l:
                        continue
                    if h + 1e-12 < max(o, c) or l - 1e-12 > min(o, c):
                        continue
                    bars.append({"date": d, "open": o, "high": h, "low": l, "close": c, "volume": v})
                except (ValueError, IndexError, TypeError):
                    continue
    except (OSError, UnicodeError):
        return []
    bars.sort(key=lambda x: x["date"])
    return list({b["date"]: b for b in bars}.values())


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def percentile(xs, q):
    if not xs:
        return None
    ys = sorted(xs)
    if len(ys) == 1:
        return ys[0]
    pos = (len(ys) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    if lo == hi:
        return ys[lo]
    return ys[lo] * (hi - pos) + ys[hi] * (pos - lo)


def pct(x):
    return round(x * 100, 3)


def simulate_no_stop(bars, i, horizon, target):
    entry = bars[i]["open"]
    target_px = entry * (1 + target)
    end = min(len(bars), i + horizon)
    min_low = entry
    for j in range(i, end):
        b = bars[j]
        min_low = min(min_low, b["low"])
        if b["high"] >= target_px:
            return {
                "outcome": "target",
                "return": target,
                "mae": min_low / entry - 1,
                "bars_held": j - i + 1,
            }
    return {
        "outcome": "timeout",
        "return": bars[end - 1]["close"] / entry - 1,
        "mae": min_low / entry - 1,
        "bars_held": end - i,
    }


def new_cell():
    return {"returns": [], "mae": [], "bars": [], "target": 0, "timeout": 0}


def summarize(cell):
    n = len(cell["returns"])
    gross = cell["returns"]
    maes = cell["mae"]
    out = {
        "trades": n,
        "targetRatePct": pct(cell["target"] / n) if n else None,
        "timeoutRatePct": pct(cell["timeout"] / n) if n else None,
        "grossMeanReturnPct": pct(mean(gross)) if n else None,
        "grossMedianReturnPct": pct(percentile(gross, 0.5)) if n else None,
        "positiveTradeRatePct": pct(sum(1 for r in gross if r > 0) / n) if n else None,
        "medianMAEPct": pct(percentile(maes, 0.5)) if n else None,
        "p10MAEPct": pct(percentile(maes, 0.10)) if n else None,
        "p05MAEPct": pct(percentile(maes, 0.05)) if n else None,
        "worstMAEPct": pct(min(maes)) if n else None,
        "meanBarsHeld": round(mean(cell["bars"]), 3) if n else None,
        "costStress": {},
    }
    for bps in COST_BPS:
        cost = bps / 10000
        net = [r - cost for r in gross]
        gains = sum(r for r in net if r > 0)
        losses = -sum(r for r in net if r < 0)
        out["costStress"][f"{bps}bps"] = {
            "meanNetReturnPct": pct(mean(net)) if n else None,
            "medianNetReturnPct": pct(percentile(net, 0.5)) if n else None,
            "netWinRatePct": pct(sum(1 for r in net if r > 0) / n) if n else None,
            "profitFactor": round(gains / losses, 3) if losses > 0 else None,
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("roots", nargs="+")
    ap.add_argument("--output-json", default="nostop-tp-grid.json")
    ap.add_argument("--output-md", default="nostop-tp-grid.md")
    ap.add_argument("--years", type=float, default=10.0)
    ap.add_argument("--min-price", type=float, default=0.5)
    ap.add_argument("--max-price", type=float, default=10.0)
    ap.add_argument("--min-gap", type=float, default=0.10)
    ap.add_argument("--max-gap", type=float, default=0.40)
    ap.add_argument("--min-prev-dollar-volume", type=float, default=1_000_000)
    ap.add_argument("--min-rvol", type=float, default=5.0)
    args = ap.parse_args()

    files = sorted(set(p for root in args.roots for p in iter_stock_files(root)))
    if not files:
        raise SystemExit("No Stooq stock files found")

    global_max = None
    for p in files:
        bars = read_bars(p)
        if bars and (global_max is None or bars[-1]["date"] > global_max):
            global_max = bars[-1]["date"]
    if global_max is None:
        raise SystemExit("No valid bars found")
    start_date = global_max - timedelta(days=round(args.years * 365.2425))

    grid = {h: {t: new_cell() for t in TARGETS} for h in HORIZONS}
    signals = 0
    symbols = set()
    last_signal = {}
    files_used = 0

    for p in files:
        bars = read_bars(p)
        if len(bars) < 25:
            continue
        files_used += 1
        symbol = p.stem.replace(".us", "").upper()
        for i in range(21, len(bars)):
            b, prev = bars[i], bars[i - 1]
            if not (start_date <= b["date"] <= global_max):
                continue
            prev_close = prev["close"]
            if not (args.min_price <= prev_close <= args.max_price):
                continue
            gap = b["open"] / prev_close - 1
            if not (args.min_gap <= gap <= args.max_gap):
                continue
            prior20 = [x["volume"] for x in bars[i - 21:i - 1]]
            avg20 = mean(prior20)
            if avg20 <= 0:
                continue
            prev_rvol = prev["volume"] / avg20
            prev_dollar = prev_close * prev["volume"]
            if prev_dollar < args.min_prev_dollar_volume or prev_rvol < args.min_rvol:
                continue
            if i - last_signal.get(symbol, -10000) < COOLDOWN_BARS:
                continue
            last_signal[symbol] = i
            signals += 1
            symbols.add(symbol)
            for h in HORIZONS:
                for t in TARGETS:
                    sim = simulate_no_stop(bars, i, h, t)
                    cell = grid[h][t]
                    cell["returns"].append(sim["return"])
                    cell["mae"].append(sim["mae"])
                    cell["bars"].append(sim["bars_held"])
                    cell[sim["outcome"]] += 1

    matrix = {f"{h}d": {f"TP_{int(t*100)}%": summarize(grid[h][t]) for t in TARGETS} for h in HORIZONS}
    ranked = []
    for h in HORIZONS:
        for t in TARGETS:
            s = matrix[f"{h}d"][f"TP_{int(t*100)}%"]
            ranked.append({
                "horizonDays": h,
                "targetPct": int(t * 100),
                "netMeanAfter1PctCost": s["costStress"]["100bps"]["meanNetReturnPct"],
                "profitFactorAfter1PctCost": s["costStress"]["100bps"]["profitFactor"],
                "targetRatePct": s["targetRatePct"],
                "medianMAEPct": s["medianMAEPct"],
                "p05MAEPct": s["p05MAEPct"],
            })
    ranked.sort(key=lambda x: (x["netMeanAfter1PctCost"] if x["netMeanAfter1PctCost"] is not None else -999), reverse=True)

    result = {
        "schemaVersion": 1,
        "method": "US microcap no-stop take-profit grid daily OHLCV proxy",
        "windowStartDate": start_date.isoformat(),
        "snapshotEndDate": global_max.isoformat(),
        "filesDiscovered": len(files),
        "filesUsed": files_used,
        "signals": signals,
        "uniqueSymbols": len(symbols),
        "signalDefinition": {
            "price": f"previous close ${args.min_price}-${args.max_price}",
            "gap": f"regular-session open gap {pct(args.min_gap)}%-{pct(args.max_gap)}%",
            "previousDollarVolume": f">= ${args.min_prev_dollar_volume:,.0f}",
            "previousDayRvol": f">= {args.min_rvol}x prior-20d average",
            "entry": "signal-day regular-session open",
            "stop": "none",
            "targets": [f"+{int(x*100)}%" for x in TARGETS],
            "timeouts": "exit at 1/3/5 trading-day horizon close if target not reached",
            "cooldownBarsPerSymbol": COOLDOWN_BARS,
        },
        "matrix": matrix,
        "rankedBy1PctCostNetMean": ranked,
        "limitations": [
            "No stop means losses can be very large; MAE statistics are reported explicitly.",
            "Daily OHLC covers regular-session bars only and does not include exact premarket/after-hours price paths.",
            "No point-in-time float/market-cap, archived fresh-news/catalyst, premarket volume, spread, VWAP, or dilution/offering filter.",
            "Stooq classification/corporate-action conventions and survivorship coverage are not equivalent to CRSP/Sharadar point-in-time data.",
            "This is research-only evidence and is not live-order authorization.",
        ],
    }

    out_json = Path(args.output_json)
    out_md = Path(args.output_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# US Microcap No-Stop Take-Profit Grid",
        "",
        f"- Window: **{result['windowStartDate']} -> {result['snapshotEndDate']}**",
        f"- Signals: **{signals:,}** / symbols **{len(symbols):,}**",
        "- Stop: **none**",
        "- Cost stress: **0 / 1% / 2% round-trip**",
        "",
        "## Ranked by mean return after 1% round-trip cost",
        "",
        "| Hold max | TP | TP hit | Net EV after 1% | PF after 1% | Median MAE | 5% worst-tail MAE |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in ranked:
        lines.append(
            f"| {row['horizonDays']}d | +{row['targetPct']}% | {row['targetRatePct']}% | {row['netMeanAfter1PctCost']}% | {row['profitFactorAfter1PctCost']} | {row['medianMAEPct']}% | {row['p05MAEPct']}% |"
        )
    lines += ["", "## Limitations", ""] + [f"- {x}" for x in result["limitations"]]
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"status": "success", "signals": signals, "ranked": ranked[:15]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
