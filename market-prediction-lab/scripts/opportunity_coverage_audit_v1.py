#!/usr/bin/env python3
"""Source-limited DAILY opportunity denominator audit for the 4-market proxy.

Never label same-day open-candidate overlap as first-crossing recall: the
intraday time of an OHLC high/low is unknown. No PIT membership, trade
execution, strategy promotion, or profitability evidence is created.
"""
from __future__ import annotations

import pandas as pd

MARKETS = frozenset(("KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"))
THRESHOLDS_PCT = (5, 10, 20)
REQUIRED_BARS = ("symbol", "timestamp", "open", "high", "low", "close", "volume")


def utc_day(value):
    timestamp = pd.to_datetime(value, utc=True, errors="coerce")
    if pd.isna(timestamp):
        return None
    return timestamp.normalize()


class ObservedDailyOpportunityAudit:
    """Counts *observed* raw-day price events BEFORE any gap/volume prefilter.

    This is a sample-denominator coverage diagnostic. It is neither a
    full historical market universe nor proof a scanner pre-detected an event.
    """

    def __init__(self, market: str, start, end):
        if market not in MARKETS:
            raise ValueError("OPPORTUNITY_AUDIT_MARKET_INVALID")
        self.market = market
        self.start = utc_day(start)
        self.end = utc_day(end)
        if self.start is None or self.end is None or self.start > self.end:
            raise ValueError("OPPORTUNITY_AUDIT_PERIOD_INVALID")
        self.source_symbols = set()
        self.eval_symbols = set()
        self.eval_days = set()
        self.observed_symbol_days = 0
        self.invalid_bars = 0
        self.duplicate_bars = 0
        self.duplicate_symbol_sources = 0
        self.events = []

    def observe_history(self, frame: pd.DataFrame) -> None:
        if not isinstance(frame, pd.DataFrame) or not set(REQUIRED_BARS).issubset(frame.columns):
            raise ValueError("OPPORTUNITY_RAW_HISTORY_SCHEMA_INVALID")
        if frame.empty:
            return
        names = frame["symbol"].dropna().astype(str).str.strip().str.upper().unique().tolist()
        if len(names) != 1 or not names[0]:
            raise ValueError("OPPORTUNITY_RAW_HISTORY_MIXED_SYMBOLS")
        symbol = names[0]
        if symbol in self.source_symbols:
            # Never count two versions of a survivor as independent events.
            self.duplicate_symbol_sources += 1
            return
        self.source_symbols.add(symbol)
        bars = frame.loc[:, list(REQUIRED_BARS)].copy()
        bars["timestamp"] = pd.to_datetime(bars["timestamp"], utc=True, errors="coerce")
        for key in ("open", "high", "low", "close", "volume"):
            bars[key] = pd.to_numeric(bars[key], errors="coerce")
        malformed = bars["timestamp"].isna()
        malformed |= (bars["open"] <= 0) | (bars["close"] <= 0)
        malformed |= (bars["high"] < bars[["open", "close"]].max(axis=1))
        malformed |= (bars["low"] > bars[["open", "close"]].min(axis=1))
        malformed |= (bars["low"] <= 0) | (bars["volume"] < 0)
        malformed |= bars[["open", "high", "low", "close", "volume"]].isna().any(axis=1)
        self.invalid_bars += int(malformed.sum())
        bars = bars.loc[~malformed].sort_values("timestamp").copy()
        self.duplicate_bars += int(bars.duplicated("timestamp").sum())
        bars = bars.drop_duplicates("timestamp", keep="last")
        bars["prior_close"] = bars["close"].shift(1)
        evaluated = bars.loc[
            (bars["timestamp"] >= self.start)
            & (bars["timestamp"] <= self.end + pd.Timedelta(days=1) - pd.Timedelta(nanoseconds=1))
            & (bars["prior_close"] > 0)
        ]
        if evaluated.empty:
            return
        self.eval_symbols.add(symbol)
        self.observed_symbol_days += len(evaluated)
        for timestamp, open_, high, low, prior_close in evaluated[
            ["timestamp", "open", "high", "low", "prior_close"]
        ].itertuples(index=False, name=None):
            day = utc_day(timestamp)
            self.eval_days.add(day)
            up = (high / prior_close - 1) * 100
            down = (1 - low / prior_close) * 100
            up_at_open = (open_ / prior_close - 1) * 100
            down_at_open = (1 - open_ / prior_close) * 100
            for threshold in THRESHOLDS_PCT:
                if up >= threshold:
                    self.events.append((symbol, day, "LONG", threshold, up_at_open >= threshold))
                if self.market == "CRYPTO_FUTURES" and down >= threshold:
                    self.events.append((symbol, day, "SHORT", threshold, down_at_open >= threshold))

    def summarize(self, preselected_frame: pd.DataFrame) -> dict:
        if not isinstance(preselected_frame, pd.DataFrame):
            raise ValueError("OPPORTUNITY_PRESELECTION_INVALID")
        if not {"symbol", "timestamp"}.issubset(preselected_frame.columns):
            raise ValueError("OPPORTUNITY_PRESELECTION_SCHEMA_INVALID")
        pool = {
            (str(symbol).strip().upper(), utc_day(timestamp))
            for symbol, timestamp in preselected_frame[["symbol", "timestamp"]].itertuples(index=False, name=None)
        }
        pool = {(symbol, day) for symbol, day in pool if symbol and day is not None
                and self.start <= day <= self.end}
        events_by_direction = {}
        for direction in (("LONG", "SHORT") if self.market == "CRYPTO_FUTURES" else ("LONG",)):
            levels = {}
            for pct in THRESHOLDS_PCT:
                subset = [e for e in self.events if e[2] == direction and e[3] == pct]
                matched = [e for e in subset if (e[0], e[1]) in pool]
                before_open = [e for e in subset if e[4]]
                levels[str(pct)] = {
                    "observedHighLowEventCount": len(subset),
                    "openAlreadyBeyondThreshold": len(before_open),
                    "candidatePoolOverlapCount": len(matched),
                    "candidatePoolMissingCount": len(subset) - len(matched),
                    "candidatePoolOverlapPercent": (
                        round(100 * len(matched) / len(subset), 3) if subset else None
                    ),
                    # High/low-only bars CANNOT prove event first-crossing time.
                    "verifiedEarlyDetectionCount": None,
                    "verifiedEarlyDetectionRecall": None,
                    "trueMarketWideRecall": None,
                    "actualFillCount": None,
                }
            events_by_direction[direction] = levels
        status = "OBSERVED_DAILY_COHORT_ONLY" if self.eval_symbols else "BLOCKED_DATA"
        return {
            "contract": "four-market-observed-daily-opportunity-audit-v1",
            "status": status,
            "market": self.market,
            "decisionTime": "DAILY_OPEN_CANDIDATE_POOL",
            "eventPriceField": "DAY_HIGH_FOR_LONG_DAY_LOW_FOR_SHORT",
            "futureHighLowUsedForSelection": False,
            "futureHighLowUsedForScoringOnly": True,
            "sourceSymbolCount": len(self.source_symbols),
            "observedEvalSymbolCount": len(self.eval_symbols),
            "observedSymbolDays": self.observed_symbol_days,
            "observedSessionDays": len(self.eval_days),
            "preselectionSymbolDays": len(pool),
            "invalidBars": self.invalid_bars,
            "duplicateBars": self.duplicate_bars,
            "duplicateSymbolSources": self.duplicate_symbol_sources,
            "directions": events_by_direction,
            "pointInTimeUniverseAndDelistingsVerified": False,
            "fullMarketOpportunityDenominator": None,
            "intradayFirstCrossingTimestampKnown": False,
            "fullMarketRecallAttested": False,
            "backtestTradeEntryAndFillProven": False,
            "costAdjustedProfitabilityProven": False,
            "executionAuthority": "NONE",
            "blockers": [
                "CURRENT_SURVIVOR_OR_LISTED_SOURCE_COHORT_ONLY",
                "HISTORIC_POINT_IN_TIME_LISTING_AND_DELISTING_NOT_PROVEN",
                "INTRADAY_FIRST_CROSSING_TIMESTAMP_MISSING",
                "OPEN_CANDIDATE_POOL_IS_NOT_EXECUTABLE_ENTRY",
                "VENUE_SPECIFIC_QUOTES_FILLS_COSTS_NOT_BOUND",
            ],
        }


def self_test() -> None:
    bars = pd.DataFrame([
        ("BTCUSDT", "2025-01-01", 100, 101, 99, 100, 10),
        ("BTCUSDT", "2025-01-02", 101, 112, 99, 105, 20),
        ("BTCUSDT", "2025-01-03", 105, 106, 88, 95, 30),
        ("BTCUSDT", "2025-01-04", 120, 124, 119, 122, 40),
    ], columns=REQUIRED_BARS)
    observed = pd.DataFrame([{"symbol": "BTCUSDT", "timestamp": "2025-01-02"}])
    spot = ObservedDailyOpportunityAudit("CRYPTO_SPOT", "2025-01-01", "2025-01-04")
    spot.observe_history(bars)
    spot_report = spot.summarize(observed)
    assert set(spot_report["directions"]) == {"LONG"}
    assert spot_report["directions"]["LONG"]["10"]["observedHighLowEventCount"] == 2
    assert spot_report["directions"]["LONG"]["10"]["candidatePoolOverlapCount"] == 1
    assert spot_report["directions"]["LONG"]["20"]["openAlreadyBeyondThreshold"] == 1
    assert spot_report["directions"]["LONG"]["10"]["verifiedEarlyDetectionRecall"] is None
    assert spot_report["fullMarketOpportunityDenominator"] is None
    futures = ObservedDailyOpportunityAudit("CRYPTO_FUTURES", "2025-01-01", "2025-01-04")
    futures.observe_history(bars)
    fut_report = futures.summarize(observed)
    assert fut_report["directions"]["SHORT"]["10"]["observedHighLowEventCount"] == 1
    assert fut_report["directions"]["SHORT"]["10"]["candidatePoolOverlapCount"] == 0
    assert fut_report["pointInTimeUniverseAndDelistingsVerified"] is False
    stocks = ObservedDailyOpportunityAudit("KR_STOCK", "2025-01-01", "2025-01-04")
    stocks.observe_history(bars)
    assert set(stocks.summarize(observed)["directions"]) == {"LONG"}
    assert ObservedDailyOpportunityAudit("US_STOCK", "2025-01-01", "2025-01-04").summarize(observed)["status"] == "BLOCKED_DATA"
    assert spot_report["executionAuthority"] == "NONE"
    print("FOUR_MARKET_OBSERVED_DAILY_OPPORTUNITY_AUDIT_SELF_TEST_PASS")


if __name__ == "__main__":
    self_test()
