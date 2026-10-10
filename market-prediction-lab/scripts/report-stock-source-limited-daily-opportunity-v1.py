#!/usr/bin/env python3
"""KR/US *stock* source-limited all-as-of-date daily price-event labels.

Use the EXISTING opportunity_coverage_audit_v1.py scoring logic; never
duplicate it. Inputs are two REAL historical provider session bars from
complete dated sources, not a fabricated adjacent UTC-day candle.
Source-attested != independently complete historical PIT membership.
Daily future high/low is retrospective outcome ONLY; scanner as-of recall,
first-crossing minute, real entries/fills, OOS and PnL remain unproved.
"""
from __future__ import annotations

import argparse
from datetime import date
import hashlib
import json
import math
import os
import re
from pathlib import Path

import pandas as pd

from opportunity_coverage_audit_v1 import ObservedDailyOpportunityAudit, THRESHOLDS_PCT

VENUE = {"KR_STOCK": "KRX", "US_STOCK": "US_SIP"}
PROVIDER = {"KR_STOCK": "KRX_OPENAPI_AUTHORIZED_THREE_BOARDS",
            "US_STOCK": "MASSIVE_US_ASOF_ACTIVE_GROUPED_UNADJUSTED"}
SHA = re.compile(r"^[0-9a-f]{64}$")
TICKER = re.compile(r"^[A-Z0-9][A-Z0-9.:-]{0,39}$")
STABLE_ID = re.compile(r"^[A-Z0-9]{12}$")


def hold(reason, market=None):
    return {
        "schemaVersion": "four-market-stock-daily-opportunity-label-v1",
        "market": market, "status": "BLOCKED_DATA", "reason": reason,
        "sourceObservedDailyPriceEventCount": None,
        "sourceAttestedNameCount": None, "directions": None,
        "historicalScannerEarlyDetectionCount": None,
        "trueMarketWideRecall": None, "actualMarketWideOpportunityCount": None,
        "originalProspectiveWatchNegativeEvidenceVerified": False,
        "actualFillCount": None, "netProfitPct": None,
        "fullMarketOpportunityDenominatorVerified": False,
        "profitabilityProven": False, "executionAuthority": "NONE",
        "liveTrading": False, "autoTrading": False, "realOrders": False,
    }


def valid_day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return value if parsed.isoformat() == value else None


def good_ohlc(o, h, l, c, v):
    px = (o, h, l, c)
    return all(isinstance(x, (float, int)) and not isinstance(x, bool)
               and math.isfinite(x) and x > 0 for x in px) \
        and isinstance(v, (float, int)) and not isinstance(v, bool) \
        and math.isfinite(v) and v >= 0 and h >= max(o, c) and l <= min(o, c)


def score_source_limited_stock_daily_v1(source):
    market = source.get("market") if isinstance(source, dict) else None
    if market not in VENUE:
        return hold("STOCK_SOURCE_MARKET_INVALID", market)
    status = source.get("status")
    fixture = status == "TEST_FIXTURE_TWO_DATED_STOCK_PRICE_BARS_ONLY"
    if not (fixture or status == "SOURCE_ATTESTED_TWO_DATED_STOCK_PRICE_BARS_ONLY") \
       or source.get("schemaVersion") != "four-market-stock-source-limited-daily-evidence-v1" \
       or source.get("venue") != VENUE[market] \
       or source.get("sourceProvider") != PROVIDER[market] \
       or source.get("executionAuthority") != "NONE" \
       or source.get("profitabilityProven") is not False \
       or source.get("fullMarketOpportunityDenominatorVerified") is not False \
       or source.get("trueMarketWideRecall") is not None \
       or source.get("actualMarketWideOpportunityCount") is not None \
       or source.get("sourceObservedDailyEvents") is not None \
       or source.get("independentlyAuthenticHistoricPITAndDelistings") is not False \
       or source.get("officialAdjacentSessionsVerified") is not False \
       or source.get("corporateActionAdjustmentVerified") is not False \
       or source.get("priorCandidateIsOfficialPreviousSessionVerified") is not False \
       or not SHA.fullmatch(str(source.get("sourceReferenceSha256", ""))):
        return hold("STOCK_SOURCE_TWO_SESSION_ATTESTATION_INVALID", market)

    current = valid_day(source.get("date"))
    prior = valid_day(source.get("priorCandidateDate"))
    rows = source.get("rows")
    canonical = source.get("canonicalRowsJSON")
    digest = source.get("sourceRowsSha256")
    if not current or not prior or prior >= current or not isinstance(rows, list) \
       or not isinstance(canonical, str) or len(canonical.encode("utf-8")) > 48*1024*1024 \
       or not SHA.fullmatch(str(digest)) \
       or not isinstance(source.get("sourceAttestedNameCount"), int) \
       or isinstance(source["sourceAttestedNameCount"], bool) \
       or source["sourceAttestedNameCount"] <= 0 \
       or source["sourceAttestedNameCount"] > 50000 \
       or source["sourceAttestedNameCount"] != len(rows):
        return hold("STOCK_SOURCE_SESSION_DATES_OR_ROWS_MISSING", market)
    if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != digest:
        return hold("STOCK_SOURCE_SAVED_ROWS_HASH_MISMATCH", market)
    try:
        if json.loads(canonical) != rows:
            return hold("STOCK_SOURCE_SAVED_ROWS_CHANGED", market)
    except (ValueError, TypeError):
        return hold("STOCK_SOURCE_SAVED_ROWS_JSON_INVALID", market)

    audit = ObservedDailyOpportunityAudit(market, current, current)
    names, ids = set(), set()
    try:
        for record in rows:
            if not isinstance(record, dict):
                return hold("STOCK_PRICE_ROW_CONTRACT_INVALID", market)
            symbol, issue = record.get("symbol"), record.get("stableIssueId")
            if not isinstance(symbol, str) or not TICKER.fullmatch(symbol) \
               or (market == "KR_STOCK" and not re.fullmatch(r"\d{6}", symbol)) \
               or not isinstance(issue, str) or not STABLE_ID.fullmatch(issue) \
               or symbol in names or issue in ids or record.get("market") != market \
               or record.get("venue") != VENUE[market] \
               or record.get("sourceCurrentTradingDate") != current \
               or record.get("sourcePriorCandidateDate") != prior:
                return hold("STOCK_PRICE_ROW_IDENTITY_OR_SESSION_INVALID", market)
            if not good_ohlc(record.get("priorOpen"), record.get("priorHigh"),
                             record.get("priorLow"), record.get("priorClose"),
                             record.get("priorVolume")) \
               or not good_ohlc(record.get("open"), record.get("high"),
                                record.get("low"), record.get("close"),
                                record.get("volume")):
                return hold("STOCK_PRICE_ROW_OHLC_INVALID", market)
            names.add(symbol)
            ids.add(issue)
            # Source actual prior MARKET session DATE, not currentDate - 1 day.
            bars = pd.DataFrame([
                {"symbol": symbol, "timestamp": pd.Timestamp(prior),
                 "open": record["priorOpen"], "high": record["priorHigh"],
                 "low": record["priorLow"], "close": record["priorClose"],
                 "volume": record["priorVolume"]},
                {"symbol": symbol, "timestamp": pd.Timestamp(current),
                 "open": record["open"], "high": record["high"],
                 "low": record["low"], "close": record["close"],
                 "volume": record["volume"]},
            ])
            audit.observe_history(bars)
    except (ValueError, TypeError, OverflowError, KeyError):
        return hold("STOCK_SOURCE_SCORER_INPUT_INVALID", market)
    if len(audit.eval_symbols) != len(rows):
        return hold("STOCK_SOURCE_SCORER_EVALUATION_COVERAGE_GAP", market)

    levels = {}
    for n in THRESHOLDS_PCT:
        series = [event for event in audit.events if event[2] == "LONG"
                  and event[3] == n]
        levels[str(n)] = {
            "sourceObservedPriceEventCount": len(series),
            "alreadyBeyondAtDailyOpen": sum(1 for x in series if x[4]),
            "originalScannerFirstAlertBeforeCrossing": None,
            "verifiedEarlyDetectionRecall": None,
            "actualFillCount": None,
            "netProfitPct": None,
        }
    preview = [
        {"symbol": e[0], "marketDate": e[1].strftime("%Y-%m-%d"),
         "direction": e[2], "thresholdPct": e[3],
         "alreadyBeyondAtDailyOpen": e[4]}
        for e in sorted(audit.events, key=lambda x: (x[0], x[3]))[:60]
    ]
    return {
        "schemaVersion": "four-market-stock-daily-opportunity-label-v1",
        "status": "TEST_FIXTURE_STOCK_DAILY_EVENT_LABEL_ONLY" if fixture
                  else "SOURCE_ATTESTED_STOCK_DAILY_EVENT_LABEL_ONLY",
        "reason": "RETROSPECTIVE_UNADJUSTED_PRICE_SOURCE_NOT_TRADE_SIGNAL",
        "market": market, "venue": VENUE[market],
        "marketSessionDate": current,
        "priorCandidateSessionDate": prior,
        "sourceAttestedNameCount": len(rows),
        "sourceObservedDailyPriceEventCount": len(audit.events),
        "sourceObservedDistinctSymbolsWithAny5PctMove":
            len({e[0] for e in audit.events if e[3] == 5}),
        "directions": {"LONG": levels}, "eventPreview": preview,
        "eventPreviewTruncated": len(audit.events) > len(preview),
        "sourceRowsSha256": digest,
        "sourceWasTestFixture": fixture,
        "futureHighLowUsedForCandidateSelection": False,
        "firstCrossingTimestampEstablished": False,
        "officialAdjacentSessionsVerified": False,
        "corporateActionsAndDelistingReturnsVerified": False,
        "originalProspectiveWatchNegativeEvidenceVerified": False,
        "historicalScannerEarlyDetectionCount": None,
        "verifiedFalseNegativeCount": None,
        "fullMarketOpportunityDenominatorVerified": False,
        "actualMarketWideOpportunityCount": None,
        "trueMarketWideRecall": None,
        "actualFillCount": None, "netProfitPct": None,
        "OOSPassCount": 0, "profitabilityProven": False,
        "executionAuthority": "NONE", "liveTrading": False,
        "autoTrading": False, "realOrders": False,
    }


def self_test():
    def sample(market="KR_STOCK", prior="2025-02-07", current="2025-02-10"):
        def one(i):
            return {
                "symbol": f"{100000+i:06d}" if market == "KR_STOCK" else f"US{i}",
                "market": market, "venue": VENUE[market],
                "stableIssueId": f"KR{i:010d}" if market == "KR_STOCK"
                                 else f"BBG{i:09d}",
                "sourceCurrentTradingDate": current,
                "sourcePriorCandidateDate": prior,
                "priorOpen": 100., "priorHigh": 103., "priorLow": 97.,
                "priorClose": 100., "priorVolume": 500.,
                "open": 104., "high": 123. if i == 0 else 103.,
                "low": 101. if i == 0 else 100.,
                "close": 108., "volume": 1000.,
            }
        # Second test fixture is not a valid OHLC if high < close.
        rows = [one(0), one(1)]
        rows[1]["open"] = 102.
        rows[1]["close"] = 102.
        canonical = json.dumps(rows, separators=(",", ":"), ensure_ascii=False)
        return {
            "schemaVersion": "four-market-stock-source-limited-daily-evidence-v1",
            "status": "TEST_FIXTURE_TWO_DATED_STOCK_PRICE_BARS_ONLY",
            "market": market, "venue": VENUE[market],
            "sourceProvider": PROVIDER[market],
            "date": current, "priorCandidateDate": prior,
            "sourceReferenceSha256": "b"*64,
            "sourceAttestedNameCount": len(rows),
            "canonicalRowsJSON": canonical,
            "sourceRowsSha256": hashlib.sha256(canonical.encode()).hexdigest(),
            "rows": rows,
            "sourceObservedDailyEvents": None,
            "actualMarketWideOpportunityCount": None,
            "trueMarketWideRecall": None,
            "fullMarketOpportunityDenominatorVerified": False,
            "independentlyAuthenticHistoricPITAndDelistings": False,
            "officialAdjacentSessionsVerified": False,
            "corporateActionAdjustmentVerified": False,
            "priorCandidateIsOfficialPreviousSessionVerified": False,
            "profitabilityProven": False, "executionAuthority": "NONE",
        }
    for market in VENUE:
        x = sample(market)
        report = score_source_limited_stock_daily_v1(x)
        assert report["status"] == "TEST_FIXTURE_STOCK_DAILY_EVENT_LABEL_ONLY", report
        assert report["sourceAttestedNameCount"] == 2
        assert report["directions"]["LONG"]["20"]["sourceObservedPriceEventCount"] == 1
        assert report["directions"]["LONG"]["10"]["sourceObservedPriceEventCount"] == 1
        assert report["directions"]["LONG"]["5"]["sourceObservedPriceEventCount"] == 1
        assert report["sourceObservedDailyPriceEventCount"] == 3
        assert report["trueMarketWideRecall"] is None
        assert report["actualMarketWideOpportunityCount"] is None
        assert report["profitabilityProven"] is False
        changed = sample(market)
        changed["rows"][0]["high"] = 999.
        assert score_source_limited_stock_daily_v1(changed)["reason"] == \
            "STOCK_SOURCE_SAVED_ROWS_CHANGED"
        incomplete = sample(market)
        incomplete["sourceAttestedNameCount"] = 10
        assert score_source_limited_stock_daily_v1(incomplete)["status"] == "BLOCKED_DATA"
        unsafe = sample(market)
        unsafe["fullMarketOpportunityDenominatorVerified"] = True
        assert score_source_limited_stock_daily_v1(unsafe)["status"] == "BLOCKED_DATA"
    print("FOUR_MARKET_STOCK_SOURCE_LIMITED_DAILY_EVENT_SCORER_SELF_TEST_PASS")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.input or not args.output:
        parser.error("--input and --output are required outside --self-test")
    src, output = Path(args.input), Path(args.output)
    stat = src.lstat()
    if not src.is_file() or src.is_symlink() or stat.st_nlink != 1 \
       or stat.st_size <= 0 or stat.st_size > 96*1024*1024 \
       or stat.st_mode & 0o077:
        raise ValueError("STOCK_SOURCE_PRIVATE_INPUT_REQUIRED")
    result = score_source_limited_stock_daily_v1(
        json.loads(src.read_text(encoding="utf-8"))
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        file.write(json.dumps(result, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps({
        "market": result["market"], "status": result["status"],
        "sourceObservedDailyPriceEventCount":
            result["sourceObservedDailyPriceEventCount"],
        "trueMarketWideRecall": None, "profitabilityProven": False,
        "executionAuthority": "NONE",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
