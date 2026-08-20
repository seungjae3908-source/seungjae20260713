#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import statistics
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
DYNAMIC_STOP_POLICIES = (
    "STRUCTURAL_CEIL12",
    "VWAP_STRUCTURAL_CEIL8",
    "ATR15_STRUCTURAL_CEIL8",
    "ATR20_STRUCTURAL_CEIL8",
)
MODES = ("TP5_ALL", "LADDER_5_10_15")
RISK_BUDGET_PER_TRADE = 0.01
MAX_CAPITAL_WEIGHT = 0.25


def pre_entry_atr(bars, entry_index: int, period: int = 14) -> float | None:
    """Point-in-time 1m ATR using only bars known by the entry close."""
    if entry_index < 1:
        return None
    start = max(1, entry_index - period + 1)
    trs = []
    for i in range(start, entry_index + 1):
        b = bars[i]
        prev_close = bars[i - 1].close
        tr = max(
            b.high - b.low,
            abs(b.high - prev_close),
            abs(b.low - prev_close),
        )
        if math.isfinite(tr) and tr > 0:
            trs.append(tr)
    return statistics.mean(trs) if trs else None


def _bounded_stop(entry_px: float, candidate: float, hard_cap: float) -> float:
    # Never allow a diagnostic stop above the entry-friction reference and
    # never expose more than the preregistered hard research ceiling.
    return min(entry_px * 0.995, max(candidate, entry_px * (1.0 - hard_cap)))


def resolve_stop(entry, bars, policy: str) -> dict:
    entry_px = entry.price * 1.0025
    structural_raw = min(entry.pullback_low * 0.995, entry_px * 0.995)
    atr = pre_entry_atr(bars, entry.index)

    if policy.startswith("FIXED_"):
        cap = float(policy.split("_", 1)[1]) / 100.0
        stop = _bounded_stop(entry_px, structural_raw, cap)
        return {
            "stopPrice": stop,
            "stopPolicy": policy,
            "hardRiskCeilingPct": cap * 100,
            "atrPct": round((atr / entry_px) * 100, 4) if atr else None,
        }

    if policy == "STRUCTURAL_CEIL12":
        stop = _bounded_stop(entry_px, structural_raw, 0.12)
        ceiling = 0.12
    elif policy == "VWAP_STRUCTURAL_CEIL8":
        vwap_stop = entry.vwap * 0.995
        stop = _bounded_stop(entry_px, max(structural_raw, vwap_stop), 0.08)
        ceiling = 0.08
    elif policy in ("ATR15_STRUCTURAL_CEIL8", "ATR20_STRUCTURAL_CEIL8"):
        multiplier = 1.5 if policy.startswith("ATR15") else 2.0
        if atr is None:
            # Fail closed to structural evidence rather than inventing ATR.
            atr_stop = structural_raw
        else:
            atr_stop = entry_px - atr * multiplier
        stop = _bounded_stop(entry_px, max(structural_raw, atr_stop), 0.08)
        ceiling = 0.08
    else:
        raise ValueError(f"UNKNOWN_STOP_POLICY:{policy}")

    return {
        "stopPrice": stop,
        "stopPolicy": policy,
        "hardRiskCeilingPct": ceiling * 100,
        "atrPct": round((atr / entry_px) * 100, 4) if atr else None,
    }


def forward_excursion(entry, bars, minutes: int) -> dict:
    """Outcome diagnostic only; never used to choose a same-run stop."""
    entry_px = entry.price * 1.0025
    entry_session = bars[entry.index].session
    end_index = min(len(bars) - 1, entry.index + minutes)
    lows = []
    highs = []
    for i in range(entry.index + 1, end_index + 1):
        b = bars[i]
        if b.session != entry_session:
            break
        lows.append(b.low)
        highs.append(b.high)
    if not lows:
        return {"maePct": 0.0, "mfePct": 0.0}
    mae = max(0.0, 1.0 - min(lows) / entry_px) * 100
    mfe = max(0.0, max(highs) / entry_px - 1.0) * 100
    return {"maePct": round(mae, 4), "mfePct": round(mfe, 4)}


def simulate_policy(entry, bars, minutes: int, mode: str, policy: str):
    entry_px = entry.price * 1.0025
    stop_meta = resolve_stop(entry, bars, policy)
    base_stop = float(stop_meta["stopPrice"])
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

        # Conservative exact-1m ordering: if target and stop share a bar,
        # stop/protection wins because tick order is unavailable.
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

    stop_distance = max(0.0, 1.0 - base_stop / entry_px)
    excursion = forward_excursion(entry, bars, minutes)
    return {
        "grossReturn": realized,
        "tp1": tp1,
        "tp2": tp2,
        "tp3": tp3,
        "exitReason": exit_reason,
        "entryPrice": entry_px,
        "exitPrice": exit_price,
        "structuralStop": base_stop,
        "stopDistancePct": stop_distance * 100,
        "stopPolicy": policy,
        "hardRiskCeilingPct": stop_meta["hardRiskCeilingPct"],
        "atrPct": stop_meta["atrPct"],
        **excursion,
    }


def sequential_equity_metrics(trades: list[dict], round_trip_cost: float) -> dict:
    """Diagnostic-only equal-weight sequential trade curve."""
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


def risk_normalized_metrics(
    trades: list[dict],
    round_trip_cost: float,
    risk_budget: float = RISK_BUDGET_PER_TRADE,
    max_weight: float = MAX_CAPITAL_WEIGHT,
) -> dict:
    """Risk-normalized capital curve so wider stops do not get free risk."""
    ordered = sorted(
        trades,
        key=lambda row: (
            int(row.get("entryTimestamp") or 0),
            str(row.get("symbol") or ""),
            str(row.get("date") or ""),
        ),
    )
    capital_returns = []
    weights = []
    stop_distances = []
    equity = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for trade in ordered:
        stop_distance = max(1e-9, float(trade.get("stopDistancePct") or 0.0) / 100.0)
        weight = min(max_weight, risk_budget / stop_distance)
        net_position_return = float(trade["grossReturn"]) - float(round_trip_cost)
        capital_return = weight * net_position_return
        weights.append(weight)
        stop_distances.append(stop_distance)
        capital_returns.append(capital_return)
        equity *= max(0.0, 1.0 + capital_return)
        peak = max(peak, equity)
        drawdown = 0.0 if peak <= 0 else 1.0 - equity / peak
        max_drawdown = max(max_drawdown, drawdown)

    gains = sum(x for x in capital_returns if x > 0)
    losses = -sum(x for x in capital_returns if x < 0)
    return {
        "assumption": "ONE_PERCENT_STOP_RISK_MAX_25_PERCENT_CAPITAL_SEQUENTIAL_NO_CONCURRENCY",
        "tradeCount": len(ordered),
        "riskBudgetPct": risk_budget * 100,
        "maxCapitalWeightPct": max_weight * 100,
        "meanCapitalReturnPct": round(statistics.mean(capital_returns) * 100, 3) if capital_returns else None,
        "capitalWinRatePct": round(sum(x > 0 for x in capital_returns) / len(capital_returns) * 100, 3) if capital_returns else None,
        "profitFactor": round(gains / losses, 3) if losses > 0 else None,
        "averageCapitalWeightPct": round(statistics.mean(weights) * 100, 3) if weights else None,
        "averageStopDistancePct": round(statistics.mean(stop_distances) * 100, 3) if stop_distances else None,
        "compoundedReturnPct": round((equity - 1.0) * 100, 3),
        "maxDrawdownPct": round(max_drawdown * 100, 3),
        "portfolioMddClaimAllowed": False,
    }


def nearest_rank(values: list[float], q: float) -> float | None:
    xs = sorted(float(x) for x in values if math.isfinite(float(x)))
    if not xs:
        return None
    index = max(0, min(len(xs) - 1, math.ceil(q * len(xs)) - 1))
    return xs[index]


def mae_mfe_diagnostics(trades: list[dict]) -> dict:
    if not trades:
        return {"trades": 0, "sameRunStopSelectionAllowed": False}
    # One record per entry identity because stop policies share the same raw path.
    by_identity = {}
    for trade in trades:
        key = (trade.get("symbol"), trade.get("date"), trade.get("session"), trade.get("entryTimestamp"))
        by_identity.setdefault(key, trade)
    rows = list(by_identity.values())
    maes = [float(x.get("maePct") or 0.0) for x in rows]
    mfes = [float(x.get("mfePct") or 0.0) for x in rows]
    return {
        "trades": len(rows),
        "maeMedianPct": round(statistics.median(maes), 3),
        "maeQ80Pct": round(nearest_rank(maes, 0.80), 3),
        "maeQ90Pct": round(nearest_rank(maes, 0.90), 3),
        "mfeMedianPct": round(statistics.median(mfes), 3),
        "mfeQ80Pct": round(nearest_rank(mfes, 0.80), 3),
        "mfeQ90Pct": round(nearest_rank(mfes, 0.90), 3),
        "sameRunStopSelectionAllowed": False,
        "interpretation": "OUTCOME_DIAGNOSTIC_ONLY_PREREGISTER_BEFORE_NEXT_INDEPENDENT_WINDOW",
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


def stop_and_sizing_self_test() -> None:
    start = base.datetime(2026, 1, 2, 9, 30, tzinfo=base.NY)
    bars = []
    for i in range(20):
        px = 10.0 + i * 0.03
        bars.append(base.Bar(int(start.timestamp()) + i * 60, start, "REG", px - 0.02, px + 0.05, px - 0.05, px, 100_000))
    entry = base.Entry("TEST", "2026-01-02", "REG", 15, 10.45, 9.85, 10.30, 0.12, 1_000_000)
    structural = resolve_stop(entry, bars, "STRUCTURAL_CEIL12")
    atr_stop = resolve_stop(entry, bars, "ATR20_STRUCTURAL_CEIL8")
    entry_px = entry.price * 1.0025
    if not (entry_px * 0.88 <= structural["stopPrice"] < entry_px):
        raise AssertionError(f"invalid structural stop: {structural}")
    if not (entry_px * 0.92 <= atr_stop["stopPrice"] < entry_px):
        raise AssertionError(f"invalid ATR stop: {atr_stop}")

    fixture = [
        {"grossReturn": -0.04, "stopDistancePct": 4.0, "entryTimestamp": 1, "symbol": "A", "date": "2026-01-01"},
        {"grossReturn": -0.08, "stopDistancePct": 8.0, "entryTimestamp": 2, "symbol": "B", "date": "2026-01-02"},
    ]
    metrics = risk_normalized_metrics(fixture, 0.0)
    if metrics["averageCapitalWeightPct"] != 18.75:
        raise AssertionError(f"unexpected risk-normalized weights: {metrics}")
    # 4%*25% and 8%*12.5% each risk about 1% of capital.
    if metrics["meanCapitalReturnPct"] != -1.0:
        raise AssertionError(f"risk normalization must equalize stop risk: {metrics}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default=",".join(base.DEFAULT_SYMBOLS))
    ap.add_argument("--output-json", default="intraday-risk-grid-v1.json")
    ap.add_argument("--output-md", default="intraday-risk-grid-v1.md")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    base.fixture_self_test()
    drawdown_self_test()
    stop_and_sizing_self_test()
    if args.self_test:
        print("MICROCAP_RISK_GRID_SELF_TEST_OK")
        return

    symbols = [x.strip().upper() for x in args.symbols.split(",") if x.strip()]
    trades = defaultdict(list)
    entries = []
    failures = {}
    stop_policies = tuple(f"FIXED_{int(cap * 100)}" for cap in RISK_CAPS) + DYNAMIC_STOP_POLICIES

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
                for policy in stop_policies:
                    for minutes in base.TIME_STOPS:
                        for mode in MODES:
                            key = f"{mode}_{policy}_{minutes}m"
                            sim = simulate_policy(entry, days[dates[pos]], minutes, mode, policy)
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
        summary["riskNormalized"] = {}
        for cost in base.COST_STRESS:
            cost_key = f"{int(cost * 10000)}bps"
            summary["costStress"][cost_key]["sequentialEquityDiagnostic"] = sequential_equity_metrics(trades[key], cost)
            summary["riskNormalized"][cost_key] = risk_normalized_metrics(trades[key], cost)

    ranking = []
    for key, s in summaries.items():
        if not s.get("trades"):
            continue
        rn = s["riskNormalized"]["100bps"]
        net = rn["meanCapitalReturnPct"]
        pf = rn["profitFactor"]
        ranking.append((net, pf if pf is not None else -1, key))
    ranking.sort(reverse=True)
    best = ranking[0][2] if ranking else None

    mae_by_horizon = {}
    for minutes in base.TIME_STOPS:
        horizon_trades = []
        for key, rows in trades.items():
            if key.endswith(f"_{minutes}m"):
                horizon_trades.extend(rows)
        mae_by_horizon[f"{minutes}m"] = mae_mfe_diagnostics(horizon_trades)

    result = {
        "schemaVersion": 3,
        "status": "RECENT_RISK_GRID_DIAGNOSTIC_ONLY",
        "source": "Yahoo public 1m range=7d includePrePost=true",
        "entries": entries,
        "fixedRiskCapsPct": [x * 100 for x in RISK_CAPS],
        "dynamicStopPolicies": list(DYNAMIC_STOP_POLICIES),
        "timeStopsMinutes": list(base.TIME_STOPS),
        "modes": list(MODES),
        "riskNormalization": {
            "riskBudgetPerTradePct": RISK_BUDGET_PER_TRADE * 100,
            "maxCapitalWeightPct": MAX_CAPITAL_WEIGHT * 100,
            "concurrencyModeled": False,
        },
        "maeMfeDiagnosticsByHorizon": mae_by_horizon,
        "summaries": summaries,
        "bestBy1PctCostRiskNormalized": best,
        "failures": failures,
        "limitations": [
            "Recent 7d selected-symbol diagnostic only; not 10-year profitability evidence.",
            "Same-minute target/stop ambiguity is conservatively stop-first.",
            "ATR uses point-in-time completed 1m bars only; no future bars enter the stop calculation.",
            "MAE/MFE are outcome diagnostics only and cannot select a stop on the same run/window.",
            "Risk-normalized sizing limits stop risk to about 1% capital with a 25% position cap but still assumes sequential non-concurrent trades.",
            "Historical point-in-time float/catalyst/dilution filters are unavailable in this diagnostic.",
            "Sequential drawdown is not a canonical concurrent-portfolio MDD claim.",
            "Choosing the best row on this tiny recent sample is exploratory and must not be promoted or live-traded.",
        ],
    }

    out_json = Path(args.output_json)
    out_md = Path(args.output_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# US Microcap Intraday Risk Grid V2",
        "",
        "**Recent exploratory diagnostic only — NOT 10-year profitability evidence.**",
        "",
        f"- Entries: {len(entries)}",
        f"- Best after 1% cost with 1%-risk sizing: **{best or 'N/A'}**",
        "- Dynamic stop challengers: structural, VWAP+structural, ATR1.5/2.0+structural.",
        "- Wider stops receive smaller position weights; stop-risk budget is capped near 1% of capital.",
        "- MAE/MFE are diagnostic only and cannot tune this same rolling window.",
        "",
        "| Config | Trades | Gross EV | Win | 1% full-notional EV | 1% PF | 1% seq MDD | 1%-risk capital EV | RN PF | RN MDD | Avg weight |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    rows = []
    for key, s in summaries.items():
        if not s.get("trades"):
            continue
        c = s["costStress"]["100bps"]
        rn = s["riskNormalized"]["100bps"]
        rows.append((rn["meanCapitalReturnPct"], key, s, c, rn))
    for _, key, s, c, rn in sorted(rows, reverse=True):
        mdd = c["sequentialEquityDiagnostic"]["maxDrawdownPct"]
        lines.append(
            f"| {key} | {s['trades']} | {s['grossMeanReturnPct']}% | {s['grossWinRatePct']}% | {c['meanNetReturnPct']}% | {c['profitFactor']} | {mdd}% | {rn['meanCapitalReturnPct']}% | {rn['profitFactor']} | {rn['maxDrawdownPct']}% | {rn['averageCapitalWeightPct']}% |"
        )
    lines += ["", "## MAE / MFE diagnostics", ""]
    for horizon, diag in mae_by_horizon.items():
        lines.append(
            f"- {horizon}: MAE median {diag.get('maeMedianPct')}%, q80 {diag.get('maeQ80Pct')}%, q90 {diag.get('maeQ90Pct')}%; MFE median {diag.get('mfeMedianPct')}%, q80 {diag.get('mfeQ80Pct')}%, q90 {diag.get('mfeQ90Pct')}% — same-run stop selection forbidden"
        )
    lines += ["", "## Limitations", ""] + [f"- {x}" for x in result["limitations"]]
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "entries": len(entries), "best": best}, ensure_ascii=False))


if __name__ == "__main__":
    main()
