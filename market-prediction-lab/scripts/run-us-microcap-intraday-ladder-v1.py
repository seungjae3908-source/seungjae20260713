#!/usr/bin/env python3
"""Research-only US microcap intraday ladder diagnostic.

Purpose:
- exercise the intended extended-hours entry/exit mechanics on real public 1m bars
- keep the engine reusable for a future point-in-time 10y minute corpus
- NEVER claim 10y profitability from Yahoo's bounded recent-history diagnostic

Default live diagnostic source: Yahoo chart 1m, range=7d, includePrePost=true.
No account/private/order API is used.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, time as dtime
from pathlib import Path
from typing import Iterable
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
DEFAULT_SYMBOLS = ("FEMY", "EHGO", "BIVI", "RCON", "VRAX", "MSS")
TIME_STOPS = (30, 60, 90)
COST_STRESS = (0.0, 0.005, 0.01, 0.02)


@dataclass(frozen=True)
class Bar:
    ts: int
    dt: datetime
    session: str
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class Entry:
    symbol: str
    date: str
    session: str
    index: int
    price: float
    pullback_low: float
    vwap: float
    trigger_gap: float
    trigger_dollar_volume: float


def safe_num(value, default=0.0):
    try:
        x = float(value)
        return x if math.isfinite(x) else default
    except (TypeError, ValueError):
        return default


def session_of(dt: datetime) -> str | None:
    t = dt.timetz().replace(tzinfo=None)
    if dtime(4, 0) <= t < dtime(9, 30):
        return "PRE"
    if dtime(9, 30) <= t < dtime(16, 0):
        return "REG"
    if dtime(16, 0) <= t < dtime(20, 0):
        return "POST"
    return None


def fetch_yahoo_1m(symbol: str) -> tuple[list[Bar], dict]:
    encoded = urllib.parse.quote(symbol.upper())
    query = "range=7d&interval=1m&includePrePost=true&events=div%2Csplits"
    urls = [
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?{query}",
        f"https://query2.finance.yahoo.com/v8/finance/chart/{encoded}?{query}",
    ]
    errors = []
    payload = None
    for attempt in range(3):
        for url in urls:
            try:
                req = urllib.request.Request(
                    url,
                    headers={
                        "Accept": "application/json,text/plain,*/*",
                        "User-Agent": "Mozilla/5.0 research-microcap-ladder/1.0",
                    },
                )
                with urllib.request.urlopen(req, timeout=15) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                break
            except Exception as exc:  # network diagnostic only
                errors.append(f"{type(exc).__name__}:{exc}")
        if payload is not None:
            break
        time.sleep(1 + attempt)
    if payload is None:
        raise RuntimeError("YAHOO_FETCH_FAILED:" + "|".join(errors[-6:]))

    result = ((payload.get("chart") or {}).get("result") or [None])[0]
    if not result:
        raise RuntimeError("YAHOO_EMPTY_RESULT")
    ts = result.get("timestamp") or []
    quote = (((result.get("indicators") or {}).get("quote") or [{}])[0])
    arrays = {k: quote.get(k) or [] for k in ("open", "high", "low", "close", "volume")}
    rows: list[Bar] = []
    for i, epoch in enumerate(ts):
        try:
            dt = datetime.fromtimestamp(int(epoch), NY)
            sess = session_of(dt)
            if sess is None:
                continue
            o, h, l, c, v = (safe_num(arrays[k][i]) if i < len(arrays[k]) else 0.0 for k in arrays)
            if min(o, h, l, c) <= 0 or h < l:
                continue
            rows.append(Bar(int(epoch), dt, sess, o, h, l, c, max(v, 0.0)))
        except Exception:
            continue
    rows.sort(key=lambda b: b.ts)
    meta = result.get("meta") or {}
    return rows, {
        "currency": meta.get("currency"),
        "exchangeName": meta.get("exchangeName"),
        "dataGranularity": meta.get("dataGranularity"),
        "range": meta.get("range"),
        "regularMarketPrice": meta.get("regularMarketPrice"),
    }


def group_days(rows: Iterable[Bar]) -> dict[str, list[Bar]]:
    out: dict[str, list[Bar]] = defaultdict(list)
    for b in rows:
        out[b.dt.date().isoformat()].append(b)
    return dict(sorted(out.items()))


def regular_close(day: list[Bar]) -> float | None:
    regs = [b for b in day if b.session == "REG"]
    return regs[-1].close if regs else None


def rolling_vwap(bars: list[Bar]) -> list[float]:
    pv = 0.0
    vol = 0.0
    out = []
    last = None
    for b in bars:
        typical = (b.high + b.low + b.close) / 3.0
        if b.volume > 0:
            pv += typical * b.volume
            vol += b.volume
        if vol > 0:
            last = pv / vol
        out.append(last if last is not None else b.close)
    return out


def positive_median(values: list[float]) -> float:
    xs = [x for x in values if x > 0 and math.isfinite(x)]
    return statistics.median(xs) if xs else 0.0


def find_entry(symbol: str, date: str, bars: list[Bar], prev_close: float) -> Entry | None:
    if not (0.50 <= prev_close <= 10.0):
        return None
    vwaps = rolling_vwap(bars)
    cum_dollar = 0.0
    trigger = None
    hod = 0.0
    pullback_low = None
    pullback_index = None

    for i, b in enumerate(bars):
        cum_dollar += b.close * b.volume
        hod = max(hod, b.high)
        gap = b.close / prev_close - 1.0

        if trigger is None:
            # A bounded discovery trigger. Historical catalyst/float evidence is NOT
            # available in the Yahoo diagnostic, so this is intentionally price/liquidity only.
            if gap >= 0.10 and cum_dollar >= 100_000:
                trigger = i
                hod = b.high
            continue

        hod = max(hod, b.high)
        drawdown = b.close / hod - 1.0 if hod > 0 else 0.0
        if pullback_low is None:
            if -0.12 <= drawdown <= -0.03:
                pullback_low = b.low
                pullback_index = i
            continue

        pullback_low = min(pullback_low, b.low)
        if i - int(pullback_index) > 30:
            return None
        if i < 12:
            continue
        prior3_high = max(x.high for x in bars[i - 3 : i])
        prior10_vol = positive_median([x.volume for x in bars[i - 10 : i]])
        volume_reaccel = b.volume > 0 and (prior10_vol <= 0 or b.volume >= prior10_vol * 1.10)
        reclaim = b.close >= vwaps[i] and b.close > prior3_high
        not_overextended = b.close <= hod * 1.03
        if reclaim and volume_reaccel and not_overextended:
            return Entry(
                symbol=symbol,
                date=date,
                session=b.session,
                index=i,
                price=b.close,
                pullback_low=float(pullback_low),
                vwap=vwaps[i],
                trigger_gap=bars[trigger].close / prev_close - 1.0,
                trigger_dollar_volume=sum(x.close * x.volume for x in bars[: trigger + 1]),
            )
    return None


def simulate(entry: Entry, bars: list[Bar], minutes: int, mode: str) -> dict:
    # 25 bps entry friction to reduce optimistic close-fill bias.
    entry_px = entry.price * 1.0025
    base_stop = min(entry.pullback_low * 0.995, entry_px * 0.995)
    # Fail-closed cap: a structural stop may not expose >12% before TP1.
    base_stop = max(base_stop, entry_px * 0.88)
    vwaps = rolling_vwap(bars)
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

        # Before TP1: first-pullback structural invalidation.
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

        # Conservative ordering after TP1: protection is checked before higher targets.
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
        if exit_reason not in ("SESSION_END",):
            exit_reason = "TIME_STOP"
        remaining = 0.0

    return {
        "grossReturn": realized,
        "tp1": tp1,
        "tp2": tp2,
        "tp3": tp3,
        "exitReason": exit_reason,
        "entryPrice": entry_px,
        "exitPrice": exit_price,
        "structuralStop": base_stop,
    }


def summarize(trades: list[dict]) -> dict:
    if not trades:
        return {"trades": 0}
    returns = [t["grossReturn"] for t in trades]
    gains = sum(x for x in returns if x > 0)
    losses = -sum(x for x in returns if x < 0)
    out = {
        "trades": len(trades),
        "grossMeanReturnPct": round(statistics.mean(returns) * 100, 3),
        "grossMedianReturnPct": round(statistics.median(returns) * 100, 3),
        "grossWinRatePct": round(sum(x > 0 for x in returns) / len(returns) * 100, 3),
        "profitFactor": round(gains / losses, 3) if losses > 0 else None,
        "tp1RatePct": round(sum(bool(t["tp1"]) for t in trades) / len(trades) * 100, 3),
        "tp2RatePct": round(sum(bool(t["tp2"]) for t in trades) / len(trades) * 100, 3),
        "tp3RatePct": round(sum(bool(t["tp3"]) for t in trades) / len(trades) * 100, 3),
        "exitReasons": dict(sorted({k: sum(t["exitReason"] == k for t in trades) for k in set(t["exitReason"] for t in trades)}.items())),
        "costStress": {},
    }
    for cost in COST_STRESS:
        net = [x - cost for x in returns]
        ng = sum(x for x in net if x > 0)
        nl = -sum(x for x in net if x < 0)
        out["costStress"][f"{int(cost * 10000)}bps"] = {
            "meanNetReturnPct": round(statistics.mean(net) * 100, 3),
            "netWinRatePct": round(sum(x > 0 for x in net) / len(net) * 100, 3),
            "profitFactor": round(ng / nl, 3) if nl > 0 else None,
        }
    return out


def fixture_self_test() -> None:
    # Deterministic sanity check for ladder accounting, independent of network.
    start = datetime(2026, 1, 2, 9, 30, tzinfo=NY)
    bars = []
    price = 1.20
    for i in range(50):
        dt = start.replace(minute=(30 + i) % 60, hour=9 + (30 + i) // 60)
        close = price * (1 + min(i, 20) * 0.008)
        bars.append(Bar(int(dt.timestamp()), dt, "REG", close * 0.998, close * 1.012, close * 0.995, close, 100_000 + i * 1000))
    e = Entry("TEST", "2026-01-02", "REG", 0, bars[0].close, bars[0].close * 0.97, bars[0].close, 0.12, 1_000_000)
    result = simulate(e, bars, 30, "LADDER_5_10_15")
    if not result["tp1"]:
        raise AssertionError("fixture must reach TP1")
    if not math.isfinite(result["grossReturn"]):
        raise AssertionError("fixture return invalid")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    ap.add_argument("--output-json", default="intraday-ladder-v1.json")
    ap.add_argument("--output-md", default="intraday-ladder-v1.md")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    fixture_self_test()
    if args.self_test:
        print("INTRADAY_LADDER_SELF_TEST_OK")
        return

    symbols = [x.strip().upper() for x in args.symbols.split(",") if x.strip()]
    diagnostics = {}
    trades_by_key: dict[str, list[dict]] = defaultdict(list)
    entries = []
    failures = {}
    session_counts = defaultdict(int)

    for symbol in symbols:
        try:
            rows, meta = fetch_yahoo_1m(symbol)
            days = group_days(rows)
            dates = list(days)
            symbol_entries = 0
            for pos in range(1, len(dates)):
                date = dates[pos]
                prev = regular_close(days[dates[pos - 1]])
                if not prev:
                    continue
                entry = find_entry(symbol, date, days[date], prev)
                if not entry:
                    continue
                symbol_entries += 1
                session_counts[entry.session] += 1
                entries.append({
                    "symbol": symbol,
                    "date": date,
                    "session": entry.session,
                    "entryPriceRaw": round(entry.price, 6),
                    "pullbackLow": round(entry.pullback_low, 6),
                    "vwapAtEntry": round(entry.vwap, 6),
                    "triggerGapPct": round(entry.trigger_gap * 100, 3),
                    "triggerDollarVolume": round(entry.trigger_dollar_volume, 2),
                })
                for minutes in TIME_STOPS:
                    for mode in ("TP5_ALL", "LADDER_5_10_15"):
                        sim = simulate(entry, days[date], minutes, mode)
                        trades_by_key[f"{mode}_{minutes}m"].append({
                            **sim,
                            "symbol": symbol,
                            "date": date,
                            "session": entry.session,
                        })
            diagnostics[symbol] = {
                "bars": len(rows),
                "days": len(days),
                "entries": symbol_entries,
                "sessionsPresent": sorted(set(b.session for b in rows)),
                "firstBar": rows[0].dt.isoformat() if rows else None,
                "lastBar": rows[-1].dt.isoformat() if rows else None,
                "meta": meta,
            }
        except Exception as exc:
            failures[symbol] = f"{type(exc).__name__}:{exc}"

    summaries = {k: summarize(v) for k, v in sorted(trades_by_key.items())}
    ranked = sorted(
        (
            (summary.get("costStress", {}).get("100bps", {}).get("meanNetReturnPct"), key)
            for key, summary in summaries.items()
            if summary.get("trades", 0)
        ),
        reverse=True,
    )
    best = ranked[0][1] if ranked else None

    result = {
        "schemaVersion": 1,
        "status": "RECENT_EXTENDED_HOURS_DIAGNOSTIC_ONLY",
        "source": "Yahoo public chart 1m range=7d includePrePost=true",
        "symbols": symbols,
        "entryModel": "10% discovery trigger + first 3-12% pullback + VWAP reclaim + 3-bar rebreak + >=1.1x recent volume",
        "exitModels": {
            "TP5_ALL": "+5% full exit; first-pullback structural invalidation; time/session stop",
            "LADDER_5_10_15": "50% at +5%, 30% at +10%, 20% at +15%; after TP1 protect remainder at max(breakeven,VWAP); structural/time/session stop",
        },
        "timeStopsMinutes": list(TIME_STOPS),
        "costStressRoundTrip": list(COST_STRESS),
        "entries": entries,
        "entrySessionCounts": dict(session_counts),
        "summaries": summaries,
        "bestRecentBy1PctCost": best,
        "diagnostics": diagnostics,
        "failures": failures,
        "validationState": {
            "extendedHoursBars": True,
            "vwap": True,
            "firstPullback": True,
            "rebreak": True,
            "volumeReacceleration": True,
            "ladderExit": True,
            "breakevenVwapProtection": True,
            "timeStop": True,
            "tenYearMinuteHistory": False,
            "pointInTimeFloat": False,
            "archivedFreshCatalyst": False,
            "pointInTimeDilutionOfferingFilter": False,
        },
        "limitations": [
            "Yahoo 1m public history is bounded to recent days; this run is not a 10-year profitability backtest.",
            "The current repository has no configured 10-year all-session US minute corpus/provider.",
            "Point-in-time float, archived same-day catalyst/news and dilution/ATM/offering evidence are not supplied to this recent Yahoo diagnostic.",
            "A small recent symbol set can validate mechanics but cannot establish profitability or promotion eligibility.",
            "No live/private/account/order authority is granted by this research run.",
        ],
    }

    out_json = Path(args.output_json)
    out_md = Path(args.output_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# US Microcap Extended-Hours Intraday Ladder V1",
        "",
        "**Status: RECENT_EXTENDED_HOURS_DIAGNOSTIC_ONLY — not 10-year profitability evidence.**",
        "",
        f"- Symbols: {', '.join(symbols)}",
        f"- Entries found: {len(entries)}",
        f"- Entry sessions: {dict(session_counts)}",
        f"- Best recent configuration after 1% cost stress: **{best or 'N/A'}**",
        "",
        "| Configuration | Trades | Gross mean | TP1 | TP2 | TP3 | EV after 0.5% cost | EV after 1% cost | PF after 1% |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for key, summary in summaries.items():
        if not summary.get("trades"):
            continue
        c50 = summary["costStress"]["50bps"]
        c100 = summary["costStress"]["100bps"]
        lines.append(
            f"| {key} | {summary['trades']} | {summary['grossMeanReturnPct']}% | {summary['tp1RatePct']}% | {summary['tp2RatePct']}% | {summary['tp3RatePct']}% | {c50['meanNetReturnPct']}% | {c100['meanNetReturnPct']}% | {c100['profitFactor']} |"
        )
    lines += ["", "## Validation state", ""]
    for k, v in result["validationState"].items():
        lines.append(f"- {k}: **{'YES' if v else 'NO'}**")
    lines += ["", "## Limitations", ""] + [f"- {x}" for x in result["limitations"]]
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "entries": len(entries), "best": best, "summaries": summaries}, ensure_ascii=False))


if __name__ == "__main__":
    main()
