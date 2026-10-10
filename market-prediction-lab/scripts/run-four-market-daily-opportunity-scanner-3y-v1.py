#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import math
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from opportunity_coverage_audit_v1 import ObservedDailyOpportunityAudit, self_test as opportunity_audit_self_test

ROOT = Path(__file__).resolve().parents[2]
US_SCRIPT = ROOT / "market-prediction-lab" / "scripts" / "run-us-daily-opportunity-scanner-3y-v1.py"
SPEC = importlib.util.spec_from_file_location("us_daily_opportunity_v1", US_SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("US_SCANNER_IMPORT_FAILED")
us = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(us)

START = us.START
END = us.END
WARMUP = us.WARMUP
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "market-prediction-lab/four-market-daily-opportunity-v1"})

MARKETS = ("US_STOCK", "KR_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES")
COSTS = {
    "US_STOCK": 0.0020,
    "KR_STOCK": 0.0030,
    "CRYPTO_SPOT": 0.0020,
    "CRYPTO_FUTURES": 0.0012,
}
MIN_GAPS = {
    "US_STOCK": 0.015,
    "KR_STOCK": 0.010,
    "CRYPTO_SPOT": 0.0,
    "CRYPTO_FUTURES": 0.0,
}
MIN_DOLLAR_VOLUME = {
    "US_STOCK": 1_000_000.0,
    "KR_STOCK": 1_000_000_000.0,
    "CRYPTO_SPOT": 5_000_000.0,
    "CRYPTO_FUTURES": 10_000_000.0,
}
CALENDAR_DAYS = {"US_STOCK": 252, "KR_STOCK": 252, "CRYPTO_SPOT": 365, "CRYPTO_FUTURES": 365}
SIX_MONTH_DAYS = {"US_STOCK": 126, "KR_STOCK": 126, "CRYPTO_SPOT": 183, "CRYPTO_FUTURES": 183}


def configure_us_module(market: str) -> None:
    us.ROUND_TRIP_COST = COSTS[market]
    us.MIN_GAP = MIN_GAPS[market]
    us.MAX_GAP = 0.30 if "STOCK" in market else 1.0
    us.MIN_PRICE = 1.0 if market == "US_STOCK" else (100.0 if market == "KR_STOCK" else 1e-12)
    us.MIN_AVG_DOLLAR_VOLUME = MIN_DOLLAR_VOLUME[market]
    us.MAX_DAILY_SELECTIONS = 3


def parse_catalog_kr_symbols() -> list[str]:
    text = (ROOT / "api-server" / "src" / "data" / "catalog.ts").read_text(encoding="utf-8")
    return sorted(set(re.findall(r'ticker:\s*"([0-9]{6})"[^\n]+market:\s*"KR"', text)))


def yahoo_history(symbol: str, suffixes: tuple[str, ...]) -> pd.DataFrame:
    params = {
        "period1": int(WARMUP.timestamp()),
        "period2": int((END + pd.Timedelta(days=2)).timestamp()),
        "interval": "1d",
        "events": "history",
        "includeAdjustedClose": "true",
    }
    errors = []
    for suffix in suffixes:
        ticker = f"{symbol}{suffix}"
        for host in ("https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"):
            try:
                r = SESSION.get(f"{host}/v8/finance/chart/{ticker}", params=params, timeout=20)
                if r.status_code in (404, 429, 500, 502, 503, 504):
                    errors.append(f"{ticker}:{r.status_code}")
                    continue
                r.raise_for_status()
                result = r.json().get("chart", {}).get("result")
                if not result:
                    continue
                row = result[0]
                quote = row.get("indicators", {}).get("quote", [{}])[0]
                timestamps = row.get("timestamp") or []
                frame = pd.DataFrame({
                    "symbol": symbol,
                    "timestamp": pd.to_datetime(timestamps, unit="s", utc=True),
                    "open": quote.get("open", []),
                    "high": quote.get("high", []),
                    "low": quote.get("low", []),
                    "close": quote.get("close", []),
                    "volume": quote.get("volume", []),
                })
                frame = frame.dropna(subset=["open", "high", "low", "close", "volume"])
                frame = frame[(frame.timestamp >= WARMUP) & (frame.timestamp <= END)]
                # Two valid bars are enough to OBSERVE a day-over-day event.
                # Candidate training still requires its own past 20d+ window.
                # Excluding young listings here loses the surge denominator.
                if len(frame) >= 2:
                    return frame.sort_values("timestamp").reset_index(drop=True)
            except Exception as exc:
                errors.append(f"{ticker}:{str(exc)[:80]}")
    raise RuntimeError("YAHOO_KR_FAILED:" + "|".join(errors[-6:]))


def load_kr_universe() -> tuple[pd.DataFrame, list[pd.Timestamp], dict]:
    configure_us_module("KR_STOCK")
    symbols = parse_catalog_kr_symbols()
    frames: list[pd.DataFrame] = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(yahoo_history, symbol, (".KS", ".KQ")): symbol for symbol in symbols}
        for future in concurrent.futures.as_completed(futures):
            symbol = futures[future]
            try:
                frames.append(future.result())
            except Exception as exc:
                failures.append({"symbol": symbol, "error": str(exc)[:160]})
    candidates = []
    dates: set[pd.Timestamp] = set()
    candidate_symbols = 0
    for g in frames:
        dates.update(g.loc[(g.timestamp >= START) & (g.timestamp <= END), "timestamp"].tolist())
        c = us.candidate_features(g)
        if not c.empty:
            candidates.append(c)
            candidate_symbols += 1
    if not candidates:
        raise RuntimeError("KR_NO_CANDIDATES")
    data = pd.concat(candidates, ignore_index=True).sort_values(["timestamp", "symbol"]).reset_index(drop=True)
    return data, sorted(dates), {
        "catalogSymbols": len(symbols),
        "usableSymbols": len(frames),
        "failedSymbols": len(failures),
        "candidateSymbols": candidate_symbols,
        "candidateRows": int(len(data)),
        "failurePreview": failures[:10],
    }


def binance_get(url: str, params: dict | None = None) -> requests.Response:
    last = None
    for attempt in range(6):
        try:
            r = SESSION.get(url, params=params, timeout=25)
            if r.status_code in (418, 429, 500, 502, 503, 504):
                last = RuntimeError(f"HTTP_{r.status_code}")
                time.sleep(1.0 + attempt * 1.2)
                continue
            r.raise_for_status()
            return r
        except Exception as exc:
            last = exc
            time.sleep(0.6 + attempt * 0.8)
    raise RuntimeError(f"BINANCE_GET_FAILED:{url}:{last}")


def spot_exchange_symbols() -> list[str]:
    errors = []
    for host in ("https://data-api.binance.vision", "https://api.binance.com"):
        try:
            payload = binance_get(host + "/api/v3/exchangeInfo").json()
            out = []
            for row in payload.get("symbols", []):
                base = str(row.get("baseAsset", "")).upper()
                if row.get("status") != "TRADING" or row.get("quoteAsset") != "USDT":
                    continue
                if any(base.endswith(x) for x in ("UP", "DOWN", "BULL", "BEAR")):
                    continue
                out.append(str(row["symbol"]).upper())
            if len(out) >= 50:
                return sorted(set(out))
        except Exception as exc:
            errors.append(str(exc))
    raise RuntimeError("SPOT_EXCHANGE_INFO_FAILED:" + "|".join(errors))


def current_usdt_perpetual_contracts(rows: list[dict]) -> list[str]:
    """Source-limited CURRENT-list proxy; historical delistings are NOT proven.

    A contract listed DURING the evaluation window must not be excluded just
    because it did not exist at the first date. Post-evaluation listings have
    no eligible observations and may be omitted to limit public API requests.
    """
    end_ms = int(END.timestamp() * 1000)
    out = []
    for row in rows:
        if row.get("status") != "TRADING" or row.get("quoteAsset") != "USDT":
            continue
        if row.get("contractType") != "PERPETUAL":
            continue
        onboard = int(row.get("onboardDate") or 0)
        if onboard and onboard > end_ms:
            continue
        out.append(str(row["symbol"]).upper())
    return sorted(set(out))


def futures_exchange_symbols() -> list[str]:
    payload = binance_get("https://fapi.binance.com/fapi/v1/exchangeInfo").json()
    out = current_usdt_perpetual_contracts(payload.get("symbols", []))
    if len(out) < 20:
        raise RuntimeError(f"FUTURES_EXCHANGE_INFO_TOO_SMALL:{len(out)}")
    return out


def binance_klines(symbol: str, futures: bool) -> pd.DataFrame:
    base = "https://fapi.binance.com/fapi/v1/klines" if futures else "https://data-api.binance.vision/api/v3/klines"
    start_ms = int(WARMUP.timestamp() * 1000)
    end_ms = int(END.timestamp() * 1000)
    cursor = start_ms
    rows = []
    while cursor <= end_ms:
        params = {"symbol": symbol, "interval": "1d", "startTime": cursor, "endTime": end_ms, "limit": 1000}
        try:
            batch = binance_get(base, params=params).json()
        except Exception:
            if not futures:
                batch = binance_get("https://api.binance.com/api/v3/klines", params=params).json()
            else:
                raise
        if not isinstance(batch, list) or not batch:
            break
        rows.extend(batch)
        last_open = int(batch[-1][0])
        nxt = last_open + 86_400_000
        if nxt <= cursor:
            break
        cursor = nxt
        if len(batch) < 1000:
            break
    # Preserve valid young-symbol day pairs for the raw high/low opportunity
    # audit. Lack of indicator warmup is a SEPARATE preselection exclusion.
    if len(rows) < 2:
        raise RuntimeError(f"KLINES_TOO_SHORT:{symbol}:{len(rows)}")
    frame = pd.DataFrame(rows, columns=[
        "open_time", "open", "high", "low", "close", "volume",
        "close_time", "quote_volume", "trades", "taker_base", "taker_quote", "ignore",
    ])
    frame["symbol"] = symbol
    frame["timestamp"] = pd.to_datetime(frame["open_time"], unit="ms", utc=True)
    for col in ("open", "high", "low", "close", "volume"):
        frame[col] = pd.to_numeric(frame[col], errors="coerce")
    frame = frame[["symbol", "timestamp", "open", "high", "low", "close", "volume"]].dropna()
    frame = frame[(frame.timestamp >= WARMUP) & (frame.timestamp <= END)]
    return frame.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)


def load_crypto_universe(market: str) -> tuple[pd.DataFrame, list[pd.Timestamp], dict]:
    futures = market == "CRYPTO_FUTURES"
    configure_us_module(market)
    symbols = futures_exchange_symbols() if futures else spot_exchange_symbols()
    frames = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        jobs = {pool.submit(binance_klines, symbol, futures): symbol for symbol in symbols}
        for future in concurrent.futures.as_completed(jobs):
            symbol = jobs[future]
            try:
                frame = future.result()
                if not frame.empty:
                    frames.append(frame)
            except Exception as exc:
                failures.append({"symbol": symbol, "error": str(exc)[:180]})
    candidates = []
    dates: set[pd.Timestamp] = set()
    candidate_symbols = 0
    for g in frames:
        dates.update(g.loc[(g.timestamp >= START) & (g.timestamp <= END), "timestamp"].tolist())
        c = us.candidate_features(g)
        if not c.empty:
            candidates.append(c)
            candidate_symbols += 1
    if not candidates:
        raise RuntimeError(f"{market}_NO_CANDIDATES")
    data = pd.concat(candidates, ignore_index=True).sort_values(["timestamp", "symbol"]).reset_index(drop=True)
    return data, sorted(dates), {
        "currentExchangeSymbols": len(symbols),
        "usableSymbols": len(frames),
        "failedSymbols": len(failures),
        "candidateSymbols": candidate_symbols,
        "candidateRows": int(len(data)),
        "failurePreview": failures[:10],
    }


def load_us_universe() -> tuple[pd.DataFrame, list[pd.Timestamp], dict]:
    configure_us_module("US_STOCK")
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "d_us_txt.zip"
        try:
            us.download_bulk(path)
            data, dates, meta = us.load_universe(path)
            meta = {**meta, "provider": "Stooq bulk daily US ASCII", "fallbackUsed": False}
            return data, dates, meta
        except Exception as stooq_error:
            print(json.dumps({"usStooqUnavailable": str(stooq_error), "fallback": "STRATOS_US_DAILY"}), flush=True)
            try:
                data, dates, meta = us.load_stratos_us_universe()
                meta = {**meta, "provider": "Hugging Face stratos-org/ohlcv-750", "fallbackUsed": True, "stooqError": str(stooq_error)}
                return data, dates, meta
            except Exception as stratos_error:
                print(json.dumps({"usStratosUnavailable": str(stratos_error), "fallback": "HF_YAHOO_DAILY"}), flush=True)
                try:
                    data, dates, meta = us.load_hf_yahoo_universe()
                    meta = {**meta, "provider": "Hugging Face AmirTrader/YahooFinance", "fallbackUsed": True, "stooqError": str(stooq_error), "stratosError": str(stratos_error)}
                    return data, dates, meta
                except Exception as hf_error:
                    print(json.dumps({"usHfYahooUnavailable": str(hf_error), "fallback": "APP_CATALOG_YAHOO"}), flush=True)
                    data, dates, meta = us.load_catalog_yahoo_universe()
                    meta = {**meta, "provider": "Yahoo Finance via app US catalog", "fallbackUsed": True, "stooqError": str(stooq_error), "stratosError": str(stratos_error), "hfYahooError": str(hf_error)}
                    return data, dates, meta


def custom_metrics(daily: pd.Series, trade_count: int, market: str) -> dict:
    daily = daily.sort_index().astype(float)
    wealth = (1 + daily).cumprod()
    total = float(wealth.iloc[-1] - 1) if len(wealth) else 0.0
    years = max((daily.index[-1] - daily.index[0]).days / 365.25, 1 / 365.25) if len(daily) > 1 else 1 / 365.25
    cagr = float(wealth.iloc[-1] ** (1 / years) - 1) if len(wealth) and wealth.iloc[-1] > 0 else -1.0
    std = daily.std(ddof=1)
    annual = CALENDAR_DAYS[market]
    sharpe = float(daily.mean() / std * math.sqrt(annual)) if len(daily) > 1 and std > 0 else None
    peak = wealth.cummax()
    mdd = float(((peak - wealth) / peak).max()) if len(wealth) else 0.0
    positive = float(daily[daily > 0].sum())
    negative = float(-daily[daily < 0].sum())
    pf = positive / negative if negative > 0 else (999.0 if positive > 0 else 0.0)
    active_days = int((daily != 0).sum())
    return {
        "tradeCount": int(trade_count),
        "days": int(len(daily)),
        "activeDays": active_days,
        "noTradeDayRate": float(1 - active_days / len(daily)) if len(daily) else 1.0,
        "tradesPerDay": float(trade_count / len(daily)) if len(daily) else 0.0,
        "tradesPerActiveDay": float(trade_count / active_days) if active_days else 0.0,
        "totalReturn": total,
        "cagr": cagr,
        "sharpe": sharpe,
        "mdd": mdd,
        "dailyProfitFactor": float(pf),
        "positiveTradingDayRate": float((daily > 0).mean()) if len(daily) else 0.0,
    }


def period_table(daily: pd.Series, market: str) -> dict:
    daily = daily.sort_index()
    weekly = daily.groupby(daily.index.to_period("W-FRI")).apply(us.compound_period)
    monthly = daily.groupby(daily.index.to_period("M")).apply(us.compound_period)

    def rolling(window: int) -> pd.Series:
        return (1 + daily).rolling(window).apply(np.prod, raw=True) - 1

    six = rolling(SIX_MONTH_DAYS[market]).dropna()
    year = rolling(CALENDAR_DAYS[market]).dropna()

    def stats(s: pd.Series) -> dict:
        if s.empty:
            return {"average": None, "median": None, "latest": None, "positiveRate": None, "best": None, "worst": None, "samples": 0}
        return {
            "average": float(s.mean()),
            "median": float(s.median()),
            "latest": float(s.iloc[-1]),
            "positiveRate": float((s > 0).mean()),
            "best": float(s.max()),
            "worst": float(s.min()),
            "samples": int(len(s)),
        }

    three = us.compound_period(daily) if len(daily) else 0.0
    return {
        "DAILY": stats(daily),
        "WEEKLY": stats(weekly),
        "MONTHLY": stats(monthly),
        "SIX_MONTH": stats(six),
        "YEARLY": stats(year),
        "THREE_YEAR": {
            "average": three, "median": three, "latest": three,
            "positiveRate": 1.0 if three > 0 else 0.0,
            "best": three, "worst": three, "samples": 1,
        },
    }


def strategies_for_market(market: str, data: pd.DataFrame, dates: list[pd.Timestamp]) -> list[dict]:
    configure_us_module(market)
    out = []
    if market == "US_STOCK":
        # US stocks are BUY/LONG-only. SHORT diagnostics in the source U.S.
        # runner are not executable or comparable for this user's market policy.
        # Exclude BOTH short rule families and directional AI (which may short).
        out.extend(x for x in us.rule_candidates(data, dates)
                   if "SHORT" not in x["candidate"] and "DIRECTIONAL" not in x["candidate"])
        out.extend([
            us.walk_forward_ai(data, us.BASIC_FEATURES, "AI_BASIC_LONG", dates),
            us.walk_forward_ai(data, us.RICH_FEATURES, "AI_WAVE_CANDLE_LONG", dates),
            us.walk_forward_ai_bracket(data, us.RICH_FEATURES, "AI_WAVE_CANDLE_LONG_BRACKET_1R_2R", dates),
        ])
    elif market == "KR_STOCK":
        rules = [x for x in us.rule_candidates(data, dates) if "SHORT" not in x["candidate"]]
        out.extend(rules)
        out.extend([
            us.walk_forward_ai(data, us.BASIC_FEATURES, "AI_BASIC_LONG", dates),
            us.walk_forward_ai(data, us.RICH_FEATURES, "AI_WAVE_CANDLE_LONG", dates),
            us.walk_forward_ai_bracket(data, us.RICH_FEATURES, "AI_WAVE_CANDLE_LONG_BRACKET_1R_2R", dates),
        ])
    elif market == "CRYPTO_SPOT":
        out.extend([
            us.walk_forward_ai(data, us.BASIC_FEATURES, "AI_BASIC_LONG", dates),
            us.walk_forward_ai(data, us.RICH_FEATURES, "AI_WAVE_CANDLE_LONG", dates),
            us.walk_forward_ai_bracket(data, us.RICH_FEATURES, "AI_WAVE_CANDLE_LONG_BRACKET_1R_2R", dates),
        ])
    else:
        out.extend([
            us.walk_forward_ai_directional(data, us.BASIC_FEATURES, "AI_BASIC_DIRECTIONAL", dates),
            us.walk_forward_ai_directional(data, us.RICH_FEATURES, "AI_WAVE_CANDLE_DIRECTIONAL", dates),
        ])
    return out


def load_market(market: str):
    if market == "US_STOCK":
        return load_us_universe()
    if market == "KR_STOCK":
        return load_kr_universe()
    return load_crypto_universe(market)


def load_market_with_observed_opportunities(market: str, audit: ObservedDailyOpportunityAudit):
    """Capture raw provider OHLC before candidate_features filters by gap.

    This hook is scoped to a single serial research-market load. Restore
    the source function even when the market provider fails.
    """
    original = us.candidate_features

    def observed_candidate_features(frame: pd.DataFrame) -> pd.DataFrame:
        audit.observe_history(frame, selection_gates={
            "min_abs_gap": us.MIN_GAP,
            "max_abs_gap": us.MAX_GAP,
            "min_price": us.MIN_PRICE,
            "min_prior_avg_dollar_volume": us.MIN_AVG_DOLLAR_VOLUME,
        })
        return original(frame)

    us.candidate_features = observed_candidate_features
    try:
        return load_market(market)
    finally:
        us.candidate_features = original


def expected_market_source_failure(error: Exception) -> bool:
    """Only known public-data failures may be recorded as BLOCKED_DATA.

    Strategy/math/type errors must still abort; never silently turn a broken
    calculation into a zero return or successful four-market benchmark.
    """
    if isinstance(error, requests.exceptions.RequestException):
        return True
    if not isinstance(error, RuntimeError):
        return False
    return str(error).startswith((
        "BINANCE_GET_FAILED:", "SPOT_EXCHANGE_INFO_FAILED:",
        "FUTURES_EXCHANGE_INFO_TOO_SMALL:",
        "CRYPTO_SPOT_NO_CANDIDATES", "CRYPTO_FUTURES_NO_CANDIDATES",
        "KR_NO_CANDIDATES", "US_NO_CANDIDATES",
    ))


def blocked_market_report(market: str, error: Exception) -> dict:
    if market not in MARKETS or not expected_market_source_failure(error):
        raise ValueError("UNEXPECTED_MARKET_BLOCK")
    message = str(error)
    if "451 Client Error" in message:
        reason = "PUBLIC_PROVIDER_HTTP_451"
    elif "401 Client Error" in message:
        reason = "PUBLIC_PROVIDER_HTTP_401"
    elif "429 Client Error" in message or "HTTP_429" in message:
        reason = "PUBLIC_PROVIDER_RATE_LIMIT"
    elif "NO_CANDIDATES" in message:
        reason = "NO_VALID_HISTORICAL_CANDIDATES"
    else:
        reason = "HISTORICAL_PUBLIC_DATA_UNAVAILABLE"
    return {
        "status": "BLOCKED_DATA",
        "source": None,
        "universe": {
            "status": "BLOCKED_DATA",
            "blocker": reason,
            "candidateRows": None,
            "coverageComplete": False,
        },
        "costAssumptionRoundTrip": COSTS[market],
        "pointInTimeMembershipProven": False,
        "delistedCoverageProven": False,
        "results": [],
        "profitableSurvivorsOnly": [],
    }


def self_test() -> None:
    old = int(START.timestamp() * 1000) - 1
    during = int(START.timestamp() * 1000) + 1
    after_end = int(END.timestamp() * 1000) + 1
    def contract(symbol, onboard, status="TRADING", quote="USDT"):
        return {"symbol": symbol, "status": status, "quoteAsset": quote,
                "contractType": "PERPETUAL", "onboardDate": onboard}
    included = current_usdt_perpetual_contracts([
        contract("OLDUSDT", old),
        contract("NEWUSDT", during),
        contract("AFTERENDUSDT", after_end),
        contract("DELISTEDUSDT", old, status="CLOSED"),
        contract("WRONGQUOTE", old, quote="BTC"),
    ])
    assert included == ["NEWUSDT", "OLDUSDT"]
    assert set(MARKETS) == {"US_STOCK", "KR_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"}
    assert all(COSTS[m] > 0 for m in MARKETS)
    assert us.START == START and us.END == END
    assert "gross_return" not in us.RICH_FEATURES
    assert "close" not in us.RICH_FEATURES
    assert "volume" not in us.RICH_FEATURES
    opportunity_audit_self_test()
    assert us.candidate_features is not None
    fake_failure = RuntimeError(
        "BINANCE_GET_FAILED:https://fapi.binance.com/fapi/v1/exchangeInfo:451 Client Error"
    )
    blocked = blocked_market_report("CRYPTO_FUTURES", fake_failure)
    assert blocked["status"] == "BLOCKED_DATA"
    assert blocked["universe"]["blocker"] == "PUBLIC_PROVIDER_HTTP_451"
    assert blocked["profitableSurvivorsOnly"] == []
    assert blocked["results"] == []
    assert blocked["pointInTimeMembershipProven"] is False
    assert not expected_market_source_failure(ValueError("BUG_IN_STRATEGY_MATH"))
    assert not expected_market_source_failure(RuntimeError("BUG_IN_STRATEGY_MATH"))
    print("FOUR_MARKET_SELF_TEST_PASS")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="market-prediction-lab/docs/four-market-daily-opportunity-scanner-3y-v1-result.json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return

    started = time.time()
    reports = {}
    fixed_series = {}
    fixed_trades = 0

    for market in MARKETS:
        print(json.dumps({"marketStart": market}), flush=True)
        raw_opportunities = ObservedDailyOpportunityAudit(market, START, END)
        try:
            data, dates, universe = load_market_with_observed_opportunities(market, raw_opportunities)
        except Exception as error:
            if not expected_market_source_failure(error):
                raise
            reports[market] = blocked_market_report(market, error)
            reports[market]["opportunityAudit"] = {
                "status": "BLOCKED_DATA",
                "market": market,
                "reason": reports[market]["universe"]["blocker"],
                "fullMarketOpportunityDenominator": None,
                "verifiedEarlyDetectionRecall": None,
                "executionAuthority": "NONE",
            }
            print(json.dumps({
                "marketBlocked": market,
                "reason": reports[market]["universe"]["blocker"],
                "profitabilityProven": False,
            }, ensure_ascii=False), flush=True)
            continue
        opportunity_audit = raw_opportunities.summarize(data)
        # OHLC highs/lows label a historical opportunity only. They are NOT
        # pre-entry signal features and cannot establish exact first-crossing.
        strategies = strategies_for_market(market, data, dates)
        rows = []
        for item in strategies:
            metrics = custom_metrics(item["daily"], item["trades"], market)
            periods = period_table(item["daily"], market)
            survivor = (
                metrics["totalReturn"] > 0
                and metrics["dailyProfitFactor"] > 1
                and metrics["tradeCount"] >= 100
                and metrics["mdd"] < 0.70
            )
            rows.append({
                "candidate": item["candidate"],
                "metrics": metrics,
                "periods": periods,
                "meta": item["meta"],
                "survivor": survivor,
            })
            fixed_name = "AI_WAVE_CANDLE_DIRECTIONAL" if market == "CRYPTO_FUTURES" else "AI_WAVE_CANDLE_LONG"
            if item["candidate"] == fixed_name:
                fixed_series[market] = item["daily"]
                fixed_trades += int(item["trades"])
        rows.sort(key=lambda x: (x["metrics"]["totalReturn"], x["metrics"]["sharpe"] or -99), reverse=True)
        reports[market] = {
            "status": "MEASURED_PROXY_ONLY",
            # Reflect the *actual* US fallback provider (Stooq may return HTTP 401).
            "source": universe.get("provider") if market == "US_STOCK" else {
                "KR_STOCK": "Yahoo Finance daily via current app KR catalog (.KS/.KQ probe)",
                "CRYPTO_SPOT": "Binance public spot USDT daily klines",
                "CRYPTO_FUTURES": "Binance public USDT perpetual daily klines",
            }[market],
            "universeScope": (
                "CURRENT_APP_KR_CATALOG_NOT_FULL_PIT_KRX" if market == "KR_STOCK"
                else "CURRENT_PROVIDER_LISTINGS_NOT_FULL_PIT" if market != "US_STOCK"
                else "HISTORICAL_BAR_PRESENCE_NOT_PIT_DELISTING_PROOF"
            ),
            "universe": universe,
            "costAssumptionRoundTrip": COSTS[market],
            "pointInTimeMembershipProven": market == "US_STOCK" and False,
            "delistedCoverageProven": False,
            "opportunityAudit": opportunity_audit,
            "results": rows,
            "profitableSurvivorsOnly": [x for x in rows if x["survivor"]],
        }
        print(json.dumps({
            "marketDone": market,
            "candidateRows": universe.get("candidateRows"),
            "opportunityAudit": {
                "status": opportunity_audit["status"],
                "observedEvalSymbolCount": opportunity_audit["observedEvalSymbolCount"],
                "observedSymbolDays": opportunity_audit["observedSymbolDays"],
                "LONG_10": opportunity_audit["directions"]["LONG"]["10"],
                **({"SHORT_10": opportunity_audit["directions"]["SHORT"]["10"]}
                    if market == "CRYPTO_FUTURES" else {}),
            },
            "topObserved": [
                {"candidate": x["candidate"], **x["metrics"]}
                for x in rows[:3]
            ],
        }, ensure_ascii=False), flush=True)

    combined = None
    if set(fixed_series) == set(MARKETS):
        idx = sorted(set().union(*(set(s.index) for s in fixed_series.values())))
        frame = pd.DataFrame({
            market: fixed_series[market].reindex(idx, fill_value=0.0)
            for market in MARKETS
        }, index=pd.DatetimeIndex(idx))
        combined_daily = frame.mean(axis=1)
        combined = {
            "family": "FIXED_AI_WAVE_CANDLE_EQUAL_25PCT_PER_MARKET",
            "construction": "25% capital per market; market return is zero on closed/no-trade days; no full-period winner selection",
            "metrics": custom_metrics(combined_daily, fixed_trades, "CRYPTO_SPOT"),
            "periods": period_table(combined_daily, "CRYPTO_SPOT"),
        }

    measured_market_count = sum(
        reports[m]["status"] == "MEASURED_PROXY_ONLY" for m in MARKETS
    )
    result_status = (
        "MEASURED_PROXY_ONLY" if measured_market_count == len(MARKETS)
        else "PARTIAL_BLOCKED_DATA" if measured_market_count > 0
        else "BLOCKED_DATA"
    )
    report = {
        "schemaVersion": 1,
        "status": result_status,
        "marketStatus": {m: reports[m]["status"] for m in MARKETS},
        "contract": "four-market-daily-opportunity-scanner-3y/v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "period": {"start": START.isoformat(), "end": END.isoformat()},
        "markets": reports,
        "combinedFixedFamily": combined,
        "truthBoundary": {
            "purpose": "comparative broad-opportunity diagnostic, not canonical profitability proof",
            "stockDecisionTime": "same-day open",
            "cryptoDecisionTime": "00:00 UTC daily open using prior-bar information",
            "sameDayHighLowCloseVolumeUsedForSelection": False,
            "historicalMembershipAndDelistingComplete": False,
            "observedOHLCOpportunityAuditOnly": True,
            "marketWideOpportunityDenominatorEstablished": False,
            "intradayFirstCrossingAndEarlyRecallEstablished": False,
            "openCandidatePoolIsNotTradeEntry": True,
            "intraday0935Replication": False,
            "shortBorrowModeledForUS": False,
            "fundingIncludedForFutures": False,
            "futuresLiquidationTierHistoryIncluded": False,
            "corporateActionsCanonicalizedForKR": False,
        },
        "safety": {
            "researchOnly": True,
            "profitabilityProven": False,
            "promotionEligible": False,
            "executionAuthority": "NONE",
            "liveTrading": False,
            "autoTrading": False,
            "realOrderEnabled": False,
            "privateTradingApiAllowed": False,
        },
        "durationSeconds": time.time() - started,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "marketStatus": report["marketStatus"],
        "markets": {
            m: {
                "topObserved": [
                    {"candidate": x["candidate"], **x["metrics"]}
                    for x in reports[m]["results"][:3]
                ],
                "survivors": len(reports[m]["profitableSurvivorsOnly"]),
            }
            for m in MARKETS
        },
        "combinedFixedFamily": combined,
        "output": str(out),
        "durationSeconds": report["durationSeconds"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
