#!/usr/bin/env python3
import argparse
import csv
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

TARGET = 0.10
HORIZONS = (1, 3, 5)
COOLDOWN_BARS = 5
COST_BPS = (0, 100, 200)


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
                    bars.append({"date": d, "open": o, "high": h, "low": l, "close": c, "volume": v})
                except (ValueError, IndexError, TypeError):
                    continue
    except (OSError, UnicodeError):
        return []
    bars.sort(key=lambda x: x["date"])
    dedup = {b["date"]: b for b in bars}
    return list(dedup.values())


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


def true_range(bar, prev_close):
    return max(bar["high"] - bar["low"], abs(bar["high"] - prev_close), abs(bar["low"] - prev_close))


def atr14_before(bars, i):
    if i < 15:
        return None
    trs = []
    for j in range(i - 14, i):
        trs.append(true_range(bars[j], bars[j - 1]["close"]))
    return mean(trs) if trs else None


def stop_specs(bars, i):
    entry = bars[i]["open"]
    atr = atr14_before(bars, i)
    prev_low = bars[i - 1]["low"]
    prev3_low = min(b["low"] for b in bars[i - 3 : i])
    specs = {
        "FIXED_-4%": entry * 0.96,
        "FIXED_-6%": entry * 0.94,
        "FIXED_-8%": entry * 0.92,
        "FIXED_-10%": entry * 0.90,
        "PREV_DAY_LOW": prev_low,
        "PREV_3D_LOW": prev3_low,
    }
    if atr and atr > 0:
        specs.update({
            "ATR_1.0X": entry - atr,
            "ATR_1.5X": entry - 1.5 * atr,
            "ATR_2.0X": entry - 2.0 * atr,
        })
    return {k: v for k, v in specs.items() if 0 < v < entry}


def simulate(bars, i, horizon, stop_px, ambiguous_policy):
    entry = bars[i]["open"]
    target_px = entry * (1 + TARGET)
    end = min(len(bars), i + horizon)
    ambiguous = False
    for j in range(i, end):
        b = bars[j]
        if j > i and b["open"] <= stop_px:
            fill = b["open"]
            return "stop", fill / entry - 1, ambiguous
        if j > i and b["open"] >= target_px:
            return "target", TARGET, ambiguous
        hit_stop = b["low"] <= stop_px
        hit_target = b["high"] >= target_px
        if hit_stop and hit_target:
            ambiguous = True
            if ambiguous_policy == "stop_first":
                return "stop", stop_px / entry - 1, ambiguous
            return "target", TARGET, ambiguous
        if hit_stop:
            return "stop", stop_px / entry - 1, ambiguous
        if hit_target:
            return "target", TARGET, ambiguous
    exit_close = bars[end - 1]["close"]
    return "timeout", exit_close / entry - 1, ambiguous


def new_acc():
    return {
        h: {
            name: {
                "risk_pct": [],
                "conservative": {"returns": [], "target": 0, "stop": 0, "timeout": 0, "ambiguous": 0},
                "optimistic": {"returns": [], "target": 0, "stop": 0, "timeout": 0, "ambiguous": 0},
            }
            for name in ("FIXED_-4%", "FIXED_-6%", "FIXED_-8%", "FIXED_-10%", "ATR_1.0X", "ATR_1.5X", "ATR_2.0X", "PREV_DAY_LOW", "PREV_3D_LOW")
        }
        for h in HORIZONS
    }


def add_trade(acc, horizon, name, entry, stop_px, cons, opt):
    cell = acc[horizon][name]
    cell["risk_pct"].append((entry - stop_px) / entry)
    for label, result in (("conservative", cons), ("optimistic", opt)):
        outcome, ret, amb = result
        side = cell[label]
        side["returns"].append(ret)
        side[outcome] += 1
        if amb:
            side["ambiguous"] += 1


def pct(x):
    return round(x * 100, 3)


def summarize_side(side):
    n = len(side["returns"])
    gross = side["returns"]
    out = {
        "trades": n,
        "targetRatePct": pct(side["target"] / n) if n else None,
        "stopRatePct": pct(side["stop"] / n) if n else None,
        "timeoutRatePct": pct(side["timeout"] / n) if n else None,
        "ambiguousRatePct": pct(side["ambiguous"] / n) if n else None,
        "grossMeanReturnPct": pct(mean(gross)) if n else None,
        "grossMedianReturnPct": pct(percentile(gross, 0.5)) if n else None,
    }
    out["costStress"] = {}
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


def finalize(acc):
    out = {}
    for h in HORIZONS:
        out[f"{h}d"] = {}
        for name, cell in acc[h].items():
            risks = cell["risk_pct"]
            if not risks:
                continue
            out[f"{h}d"][name] = {
                "medianStopDistancePct": pct(percentile(risks, 0.5)),
                "meanStopDistancePct": pct(mean(risks)),
                "p90StopDistancePct": pct(percentile(risks, 0.9)),
                "conservativeStopFirst": summarize_side(cell["conservative"]),
                "optimisticTargetFirst": summarize_side(cell["optimistic"]),
            }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("roots", nargs="+")
    ap.add_argument("--output-json", default="tp10-stop-matrix.json")
    ap.add_argument("--output-md", default="tp10-stop-matrix.md")
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

    acc = new_acc()
    signals = 0
    symbols = set()
    last_signal = {}
    files_used = 0

    for p in files:
        bars = read_bars(p)
        if len(bars) < 30:
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
            prior20 = [x["volume"] for x in bars[i - 21 : i - 1]]
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
            entry = b["open"]
            for name, stop_px in stop_specs(bars, i).items():
                for h in HORIZONS:
                    cons = simulate(bars, i, h, stop_px, "stop_first")
                    opt = simulate(bars, i, h, stop_px, "target_first")
                    add_trade(acc, h, name, entry, stop_px, cons, opt)

    matrix = finalize(acc)
    result = {
        "schemaVersion": 1,
        "method": "US microcap +10% take-profit stop-matrix daily OHLCV proxy",
        "snapshotEndDate": global_max.isoformat(),
        "windowStartDate": start_date.isoformat(),
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
            "takeProfit": "+10%",
            "cooldownBarsPerSymbol": COOLDOWN_BARS,
        },
        "stopDefinitions": {
            "FIXED": "entry minus 4/6/8/10%",
            "ATR": "entry minus 1.0/1.5/2.0 times previous 14-session SMA true range",
            "PREV_DAY_LOW": "previous regular-session low",
            "PREV_3D_LOW": "lowest low of previous 3 regular sessions",
        },
        "executionAssumptions": {
            "sameBarAmbiguityPrimary": "conservative stop-first; optimistic target-first also reported as an upper bound",
            "stopGap": "if a later session opens below stop, fill at that open",
            "targetGap": "target fill capped at +10% (no optimistic price improvement)",
            "timeout": "exit at horizon final close",
            "costStressBpsRoundTrip": list(COST_BPS),
        },
        "matrix": matrix,
        "limitations": [
            "Daily OHLC cannot resolve target-vs-stop intraday order; the conservative result counts same-bar ambiguity as stop first.",
            "Historical VWAP cannot be reconstructed from daily OHLCV and is therefore not tested here.",
            "No point-in-time float/market-cap, archived fresh-news/catalyst, premarket volume, spread, or dilution/ATM/offering filter.",
            "Stooq classification/corporate-action conventions and survivorship coverage are not equivalent to CRSP/Sharadar point-in-time data.",
            "This is research-only evidence and is not live-order authorization.",
        ],
    }

    out_json = Path(args.output_json)
    out_md = Path(args.output_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# US Microcap +10% TP Stop Matrix",
        "",
        f"- Window: **{result['windowStartDate']} → {result['snapshotEndDate']}**",
        f"- Signals: **{signals:,}** / symbols **{len(symbols):,}**",
        "- Primary interpretation: **conservative stop-first** on same-day target/stop ambiguity.",
        "- Cost stress: **0 / 1% / 2% round-trip**.",
        "",
    ]
    for h in HORIZONS:
        lines += [f"## {h}-trading-day exit", "", "| Stop | Median stop | TP first | Stop first | Timeout | Ambiguous | Gross EV | EV after 1% cost | PF after 1% | Optimistic EV after 1% |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
        rows = []
        for name, m in matrix[f"{h}d"].items():
            c = m["conservativeStopFirst"]
            o = m["optimisticTargetFirst"]
            net1 = c["costStress"]["100bps"]
            rows.append((net1["meanNetReturnPct"], name, m, c, o, net1))
        for _, name, m, c, o, net1 in sorted(rows, reverse=True):
            lines.append(
                f"| {name} | {m['medianStopDistancePct']}% | {c['targetRatePct']}% | {c['stopRatePct']}% | {c['timeoutRatePct']}% | {c['ambiguousRatePct']}% | {c['grossMeanReturnPct']}% | {net1['meanNetReturnPct']}% | {net1['profitFactor']} | {o['costStress']['100bps']['meanNetReturnPct']}% |"
            )
        lines.append("")
    lines += ["## Limitations", ""] + [f"- {x}" for x in result["limitations"]]
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"status": "success", "signals": signals, "matrix": matrix}, ensure_ascii=False))


if __name__ == "__main__":
    main()
