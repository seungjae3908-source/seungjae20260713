#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE_PATH = HERE / "run-us-microcap-intraday-ladder-v1.py"
spec = importlib.util.spec_from_file_location("microcap_intraday_ladder_v1", BASE_PATH)
base = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = base
spec.loader.exec_module(base)

RISK_CAPS = (0.04, 0.06, 0.08, 0.12)
MODES = ("TP5_ALL", "LADDER_5_10_15")


def simulate_cap(entry, bars, minutes: int, mode: str, risk_cap: float):
    entry_px = entry.price * 1.0025
    base_stop = min(entry.pullback_low * 0.995, entry_px * 0.995)
    base_stop = max(base_stop, entry_px * (1.0 - risk_cap))
    vwaps = base.rolling_vwap(bars)
    remaining = 1.0
    realized = 0.0
    tp1 = tp2 = tp3 = False
    exit_reason = "TIME_STOP"
    exit_price = None
    end_index = min(len(bars) - 1, entry.index + minutes)
    entry_session = bars[entry.index].session

    for i in range(entry.index + 1, min(len(bars), end_index + 1)):
        b = bars[i]
        if b.session != entry_session:
            end_index = i - 1
            exit_reason = "SESSION_END"
            break

        # Exact 1m ordering across bars. If target and stop are both inside the
        # same minute, remain conservative and assign stop/protection first.
        if not tp1 and b.low <= base_stop:
            realized += remaining * (base_stop / entry_px - 1.0)
            remaining = 0.0
            exit_reason = "STRUCTURAL_STOP"
            exit_price = base_stop
            break

        if mode == "TP5_ALL":
            if b.high >= entry_px * 1.05:
                realized += 0.05
                remaining = 0.0
                tp1 = True
                exit_reason = "TP5_ALL"
                exit_price = entry_px * 1.05
                break
            continue

        if tp1 and remaining > 0:
            protect = max(entry_px, vwaps[i])
            if b.low <= protect:
                realized += remaining * (protect / entry_px - 1.0)
                remaining = 0.0
                exit_reason = "BREAKEVEN_OR_VWAP_PROTECT"
                exit_price = protect
                break

        if not tp1 and b.high >= entry_px * 1.05:
            realized += 0.50 * 0.05
            remaining -= 0.50
            tp1 = True
        if tp1 and not tp2 and remaining > 0 and b.high >= entry_px * 1.10:
            realized += 0.30 * 0.10
            remaining -= 0.30
            tp2 = True
        if tp2 and not tp3 and remaining > 0 and b.high >= entry_px * 1.15:
            realized += remaining * 0.15
            remaining = 0.0
            tp3 = True
            exit_reason = "TP15_FINAL"
            exit_price = entry_px * 1.15
            break

    if remaining > 0:
        idx = max(entry.index, min(end_index, len(bars) - 1))
        px = bars[idx].close
        realized += remaining * (px / entry_px - 1.0)
        exit_price = px
        if exit_reason != "SESSION_END":
            exit_reason = "TIME_STOP"

    return {
        "grossReturn": realized,
        "tp1": tp1,
        "tp2": tp2,
        "tp3": tp3,
        "exitReason": exit_reason,
        "entryPrice": entry_px,
        "exitPrice": exit_price,
        "structuralStop": base_stop,
        "riskCapPct": risk_cap * 100,
    }


def sequential_equity_metrics(trades: list[dict], round_trip_cost: float) -> dict:
    """Diagnostic-only equal-weight sequential trade curve.

    This does not claim portfolio MDD because concurrent positions and capital
    sizing are not modeled. It gives a deterministic chronological drawdown
    diagnostic instead of leaving all drawdown evidence absent.
    """
    ordered = sorted(
        trades,
        key=lambda row: (
            int(row.get("entryTimestamp") or 0),
            str(row.get("symbol") or ""),
            str(row.get("date") or ""),
        ),
    )
    equity = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for trade in ordered:
        net_return = float(trade["grossReturn"]) - float(round_trip_cost)
        equity *= max(0.0, 1.0 + net_return)
        peak = max(peak, equity)
        drawdown = 0.0 if peak <= 0 else 1.0 - equity / peak
        max_drawdown = max(max_drawdown, drawdown)
    return {
        "assumption": "EQUAL_WEIGHT_SEQUENTIAL_TRADES_NO_CONCURRENCY",
        "tradeCount": len(ordered),
        "compoundedReturnPct": round((equity - 1.0) * 100, 3),
        "maxDrawdownPct": round(max_drawdown * 100, 3),
        "portfolioMddClaimAllowed": False,
    }


def drawdown_self_test() -> None:
    fixture = [
        {"grossReturn": 0.10, "entryTimestamp": 1, "symbol": "A", "date": "2026-01-01"},
        {"grossReturn": -0.05, "entryTimestamp": 2, "symbol": "B", "date": "2026-01-02"},
        {"grossReturn": -0.10, "entryTimestamp": 3, "symbol": "C", "date": "2026-01-03"},
        {"grossReturn": 0.20, "entryTimestamp": 4, "symbol": "D", "date": "2026-01-04"},
    ]
    metrics = sequential_equity_metrics(fixture, 0.0)
    if metrics["maxDrawdownPct"] != 14.5:
        raise AssertionError(f"unexpected diagnostic MDD: {metrics}")
    if metrics["portfolioMddClaimAllowed"] is not False:
        raise AssertionError("diagnostic curve must not claim portfolio MDD")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default=",".join(base.DEFAULT_SYMBOLS))
    ap.add_argument("--output-json", default="intraday-risk-grid-v1.json")
    ap.add_argument("--output-md", default="intraday-risk-grid-v1.md")
    args = ap.parse_args()
    base.fixture_self_test()
    drawdown_self_test()

    symbols = [x.strip().upper() for x in args.symbols.split(",") if x.strip()]
    trades = defaultdict(list)
    entries = []
    failures = {}

    for symbol in symbols:
        try:
            rows, _meta = base.fetch_yahoo_1m(symbol)
            days = base.group_days(rows)
            dates = list(days)
            for pos in range(1, len(dates)):
                prev = base.regular_close(days[dates[pos - 1]])
                if not prev:
                    continue
                entry = base.find_entry(symbol, dates[pos], days[dates[pos]], prev)
                if not entry:
                    continue
                entry_timestamp = days[dates[pos]][entry.index].ts
                entries.append({
                    "symbol": symbol,
                    "date": dates[pos],
                    "session": entry.session,
                    "entry": entry.price,
                    "entryTimestamp": entry_timestamp,
                })
                for cap in RISK_CAPS:
                    for minutes in base.TIME_STOPS:
                        for mode in MODES:
                            key = f"{mode}_STOP{int(cap*100)}_{minutes}m"
                            sim = simulate_cap(entry, days[dates[pos]], minutes, mode, cap)
                            trades[key].append({
                                **sim,
                                "symbol": symbol,
                                "date": dates[pos],
                                "session": entry.session,
                                "entryTimestamp": entry_timestamp,
                            })
        except Exception as exc:
            failures[symbol] = f"{type(exc).__name__}:{exc}"

    summaries = {k: base.summarize(v) for k, v in sorted(trades.items())}
    for key, summary in summaries.items():
        if not summary.get("trades"):
            continue
        summary["sequentialEquityDiagnostic"] = sequential_equity_metrics(trades[key], 0.0)
        for cost in base.COST_STRESS:
            cost_key = f"{int(cost * 10000)}bps"
            summary["costStress"][cost_key]["sequentialEquityDiagnostic"] = sequential_equity_metrics(trades[key], cost)

    ranking = []
    for key, s in summaries.items():
        if not s.get("trades"):
            continue
        net = s["costStress"]["100bps"]["meanNetReturnPct"]
        pf = s["costStress"]["100bps"]["profitFactor"]
        ranking.append((net, pf if pf is not None else -1, key))
    ranking.sort(reverse=True)
    best = ranking[0][2] if ranking else None

    result = {
        "schemaVersion": 2,
        "status": "RECENT_RISK_GRID_DIAGNOSTIC_ONLY",
        "source": "Yahoo public 1m range=7d includePrePost=true",
        "entries": entries,
        "riskCapsPct": [x * 100 for x in RISK_CAPS],
        "timeStopsMinutes": list(base.TIME_STOPS),
        "modes": list(MODES),
        "summaries": summaries,
        "bestBy1PctCost": best,
        "failures": failures,
        "limitations": [
            "Recent 7d selected-symbol diagnostic only; not 10-year profitability evidence.",
            "Same-minute target/stop ambiguity is conservatively stop-first.",
            "Historical point-in-time float/catalyst/dilution filters are unavailable in this diagnostic.",
            "Sequential drawdown assumes equal-weight non-concurrent trades and is not a canonical portfolio MDD claim.",
            "Choosing the best row on this tiny recent sample is exploratory and must not be promoted or live-traded.",
        ],
    }

    out_json = Path(args.output_json)
    out_md = Path(args.output_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# US Microcap Intraday Risk Grid V1",
        "",
        "**Recent exploratory diagnostic only — NOT 10-year profitability evidence.**",
        "",
        f"- Entries: {len(entries)}",
        f"- Best after 1% cost stress: **{best or 'N/A'}**",
        "- Drawdown shown below is an equal-weight sequential-trade diagnostic, not canonical portfolio MDD.",
        "",
        "| Config | Trades | Gross EV | Win | TP1 | 1% net EV | 1% PF | 1% seq MDD |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    rows = []
    for key, s in summaries.items():
        if not s.get("trades"):
            continue
        c = s["costStress"]["100bps"]
        rows.append((c["meanNetReturnPct"], key, s, c))
    for _, key, s, c in sorted(rows, reverse=True):
        mdd = c["sequentialEquityDiagnostic"]["maxDrawdownPct"]
        lines.append(f"| {key} | {s['trades']} | {s['grossMeanReturnPct']}% | {s['grossWinRatePct']}% | {s['tp1RatePct']}% | {c['meanNetReturnPct']}% | {c['profitFactor']} | {mdd}% |")
    lines += ["", "## Limitations", ""] + [f"- {x}" for x in result["limitations"]]
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "entries": len(entries), "best": best}, ensure_ascii=False))


if __name__ == "__main__":
    main()
