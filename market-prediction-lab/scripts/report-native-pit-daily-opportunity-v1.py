#!/usr/bin/env python3
"""Four-market PIT-native DAILY event labels via the EXISTING opportunity scorer.

Consumes only a locally saved, explicitly private native-PIT day receipt.
Never treats a 6-symbol pilot, current listings, Binance proxy or a test
fixture as all-market historical discovery. A daily high/low label is
retrospective GROUND TRUTH, never an as-of scanner candidate or tradable fill.
The existing ObservedDailyOpportunityAudit owns all 5/10/20 scoring.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
from pathlib import Path

import pandas as pd

from opportunity_coverage_audit_v1 import (
    ObservedDailyOpportunityAudit,
    THRESHOLDS_PCT,
)

VENUES = {
    "KR_STOCK": "KRX", "US_STOCK": "US_SIP",
    "CRYPTO_SPOT": "UPBIT_KRW",
    "CRYPTO_FUTURES": "BITGET_USDT_FUTURES",
}
DAY = 86_400_000
HEX_SHA = re.compile(r"^[a-f0-9]{64}$")


def blocked(reason: str, market: str | None = None) -> dict:
    return {
        "schemaVersion": "four-market-pit-native-daily-event-label-v1",
        "status": "BLOCKED_DATA", "reason": reason,
        "market": market,
        "sourceAttestedActiveNames": None,
        "observedSourcePriceEvents": None, "directions": None,
        "earlyScannerDetectedCount": None,
        "verifiedFalseNegativeCount": None,
        "fullMarketOpportunityDenominatorVerified": False,
        "actualMarketWideOpportunityCount": None,
        "trueMarketWideRecall": None,
        "actualFillCount": None, "netProfitPct": None,
        "profitabilityProven": False,
        "futureHighLowUsedForCandidateSelection": False,
        "executionAuthority": "NONE",
        "liveTrading": False, "autoTrading": False, "realOrders": False,
    }


def positive(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) \
        and math.isfinite(value) and value > 0


def check_bar(open_: float, high: float, low: float, close: float, volume: float) -> bool:
    return all(map(positive, (open_, high, low, close))) \
        and isinstance(volume, (int, float)) and not isinstance(volume, bool) \
        and math.isfinite(volume) and volume >= 0 \
        and high >= max(open_, close) and low <= min(open_, close) \
        and high >= low


def native_pit_daily_labels_v1(raw: dict) -> dict:
    r = raw.get("result") if isinstance(raw, dict) else None
    market = r.get("market") if isinstance(r, dict) else None
    venue = VENUES.get(market)
    receipt = r.get("privateNativeDaySource") if isinstance(r, dict) else None
    if venue is None:
        return blocked("NATIVE_PIT_SOURCE_MARKET_INVALID", market)
    fixture = r.get("status") == "TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY"
    source_attested = r.get("status") == "SOURCE_ATTESTED_FULL_NAME_DAILY_JOIN_ONLY"
    if raw.get("schemaVersion") != "native-historic-pit-day-read-only-cli-v1" \
       or raw.get("executionAuthority") != "NONE" \
       or raw.get("provenanceIndependentAuthentication") is not False \
       or raw.get("dataUsage") != "RESEARCH_ONLY_NO_COMMERCIAL_REPUBLICATION_AUTHORIZED" \
       or not (fixture or source_attested) \
       or r.get("executionAuthority") != "NONE" \
       or r.get("profitabilityProven") is not False \
       or r.get("fullMarketPITUniverseVerified") is not False \
       or r.get("actualMarketWideOpportunityCount") is not None \
       or r.get("trueMarketWideRecall") is not None \
       or r.get("privateNativeDayRowsEmitted") is not True \
       or r.get("sourceAttestedFullSymbolDayPriceJoin") is not True \
       or not isinstance(receipt, dict):
        return blocked("NATIVE_PIT_PRIVATE_SOURCE_RECEIPT_NOT_ATTESTED", market)
    day = receipt.get("dayStartMs")
    if not isinstance(day, int) or isinstance(day, bool) \
       or day <= 0 or day % DAY != 0 or receipt.get("dayEndMs") != day + DAY \
       or receipt.get("market") != market or receipt.get("venue") != venue \
       or receipt.get("sourceClass") != ("TEST_FIXTURE" if fixture else "VENUE_NATIVE_DAILY_ARCHIVE") \
       or not isinstance(receipt.get("sourceId"), str) or not receipt["sourceId"] \
       or receipt.get("sourcePriceConvention") != "NATIVE_UNADJUSTED" and market.startswith("CRYPTO") \
       or not isinstance(receipt.get("rows"), list) \
       or not HEX_SHA.fullmatch(str(receipt.get("rowsSha256", ""))) \
       or receipt.get("rowsSha256") != r.get("nativeRowsSha256"):
        return blocked("NATIVE_PIT_PRIVATE_SOURCE_WINDOW_OR_DIGEST_INVALID", market)
    # Verify the exact JSON bytes that Node hashed; reserializing a decoded
    # Python float could change scientific exponent notation (e.g. 1e-8).
    # This detects accidental/stale file mutation, not forged provider origin.
    canonical_text = receipt.get("canonicalRowsJSON")
    if not isinstance(canonical_text, str) or len(canonical_text) > 8*1024*1024:
        return blocked("NATIVE_PIT_PRIVATE_SOURCE_SERIALIZATION_MISSING", market)
    if hashlib.sha256(canonical_text.encode("utf-8")).hexdigest() != receipt["rowsSha256"]:
        return blocked("NATIVE_PIT_PRIVATE_SOURCE_HASH_MISMATCH", market)
    try:
        if json.loads(canonical_text) != receipt["rows"]:
            return blocked("NATIVE_PIT_PRIVATE_SOURCE_ROWS_CHANGED", market)
    except (ValueError, TypeError):
        return blocked("NATIVE_PIT_PRIVATE_SOURCE_SERIALIZATION_INVALID", market)
    rows = receipt["rows"]
    name_count = r.get("sourceAttestedHistoricalActiveSymbols")
    if not isinstance(name_count, int) or isinstance(name_count, bool) \
       or name_count < 1 or len(rows) != name_count \
       or r.get("sourceAttestedDailyBars") != len(rows) or len(rows) > 50_000:
        return blocked("NATIVE_PIT_ALL_NAME_DAILY_BAR_JOIN_INCOMPLETE", market)
    audit = ObservedDailyOpportunityAudit(
        market,
        pd.to_datetime(day, unit="ms", utc=True),
        pd.to_datetime(day, unit="ms", utc=True),
    )
    observed = set()
    try:
        for row in rows:
            symbol = row.get("symbol")
            if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9][A-Z0-9._:-]{0,39}", symbol) \
               or symbol in observed or row.get("market") != market \
               or row.get("venue") != venue \
               or row.get("timestampMs") != day \
               or row.get("priorBarTimestampMs") != day - DAY \
               or row.get("priorCloseAsOfMs") != day \
               or row.get("sourceId") != receipt["sourceId"] \
               or not HEX_SHA.fullmatch(str(row.get("evidenceSha256", ""))) \
               or not HEX_SHA.fullmatch(str(row.get("nativeProviderRowDigestSha256", ""))):
                return blocked("NATIVE_PIT_DAILY_ROW_IDENTITY_OR_PRIOR_TIME_INVALID", market)
            observed.add(symbol)
            if not check_bar(row.get("priorBarOpen"), row.get("priorBarHigh"),
                             row.get("priorBarLow"), row.get("priorClose"),
                             row.get("priorBarVolume")) \
               or not check_bar(row.get("open"), row.get("high"), row.get("low"),
                                row.get("close"), row.get("volume")):
                return blocked("NATIVE_PIT_DAILY_SOURCE_OHLCV_INVALID", market)
            # Two ACTUAL exchange candles, not an invented warmup day.
            frame = pd.DataFrame([
                {"symbol": symbol,
                 "timestamp": pd.to_datetime(day - DAY, unit="ms", utc=True),
                 "open": row["priorBarOpen"], "high": row["priorBarHigh"],
                 "low": row["priorBarLow"], "close": row["priorClose"],
                 "volume": row["priorBarVolume"]},
                {"symbol": symbol,
                 "timestamp": pd.to_datetime(day, unit="ms", utc=True),
                 "open": row["open"], "high": row["high"], "low": row["low"],
                 "close": row["close"], "volume": row["volume"]},
            ])
            audit.observe_history(frame)
    except (KeyError, ValueError, TypeError, OverflowError):
        return blocked("NATIVE_PIT_DAILY_SOURCE_SCORER_INPUT_INVALID", market)

    allowed = ["LONG", "SHORT"] if market == "CRYPTO_FUTURES" else ["LONG"]
    counts = {}
    for direction in allowed:
        counts[direction] = {}
        for threshold in THRESHOLDS_PCT:
            events = [e for e in audit.events if e[2] == direction and e[3] == threshold]
            counts[direction][str(threshold)] = {
                "sourceObservedPriceEventCount": len(events),
                "alreadyPastThresholdAtDailyOpen": sum(1 for e in events if e[4]),
                "historicalEarlyScannerSignals": None,
                "verifiedRecall": None,
                "actualExecutableFills": None,
                "costAdjustedReturnPct": None,
            }
    preview = [
        {"symbol": e[0], "dateUtc": e[1].strftime("%Y-%m-%d"),
         "direction": e[2], "thresholdPct": e[3],
         "alreadyPastThresholdAtDailyOpen": e[4]}
        for e in sorted(audit.events, key=lambda e: (str(e[0]), str(e[2]), e[3]))[:50]
    ]
    return {
        "schemaVersion": "four-market-pit-native-daily-event-label-v1",
        "status": "TEST_FIXTURE_DAILY_EVENT_LABEL_ONLY" if fixture
                  else "SOURCE_ATTESTED_DAILY_EVENT_LABEL_ONLY",
        "reason": "PRICE_SOURCE_ATTESTATION_IS_NOT_INDEPENDENT_MARKET_PROOF",
        "market": market, "venue": venue,
        "utcDate": pd.to_datetime(day, unit="ms", utc=True).strftime("%Y-%m-%d"),
        "sourceAttestedActiveNames": name_count,
        "actualRawCandleDaySymbols": len(observed),
        "observedSourcePriceEvents": len(audit.events),
        "observedFivePctDirectionalEpisodes":
            sum(1 for e in audit.events if e[3] == 5),
        "directions": counts, "eventPreview": preview,
        "eventPreviewTruncated": len(audit.events) > len(preview),
        "sourceRowsSha256": receipt["rowsSha256"],
        "sourceWasFixture": fixture,
        "sourceIndependentlyAuthenticated": False,
        "priceGroundTruthIsRetrospective": True,
        "futureHighLowUsedForCandidateSelection": False,
        "historicalFirstCrossingMinuteVerified": False,
        "originalScannerAsOfEvidenceAttached": False,
        "earlyScannerDetectedCount": None,
        "verifiedFalseNegativeCount": None,
        "fullMarketOpportunityDenominatorVerified": False,
        "actualMarketWideOpportunityCount": None,
        "trueMarketWideRecall": None,
        "actualFillCount": None, "netProfitPct": None,
        "OOSPassCount": 0, "profitabilityProven": False,
        "executionAuthority": "NONE", "liveTrading": False,
        "autoTrading": False, "realOrders": False,
    }


def self_test() -> None:
    day = 1_759_968_000_000  # 2025-10-09 UTC
    def fixture(market: str, high=121., low=79., open_=101., count=1):
        venue = VENUES[market]
        rows = [{
            "symbol": "ABCUSDT" if market == "CRYPTO_FUTURES" else "KRW-ABC",
            "market": market, "venue": venue, "timestampMs": day,
            "open": open_, "high": high, "low": low,
            "close": 102., "volume": 100., "priorClose": 100.,
            "priorCloseAsOfMs": day,
            "priorBarTimestampMs": day - DAY,
            "priorBarOpen": 100., "priorBarHigh": 101.,
            "priorBarLow": 99., "priorBarVolume": 100.,
            "sourceId": "TEST_ARCHIVE", "evidenceSha256": "a"*64,
            "nativeProviderRowDigestSha256": "b"*64,
        }]
        canonical = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return {
            "schemaVersion": "native-historic-pit-day-read-only-cli-v1",
            "executionAuthority": "NONE",
            "provenanceIndependentAuthentication": False,
            "dataUsage": "RESEARCH_ONLY_NO_COMMERCIAL_REPUBLICATION_AUTHORIZED",
            "result": {
                "market": market, "executionAuthority": "NONE",
                "profitabilityProven": False,
                "fullMarketPITUniverseVerified": False,
                "actualMarketWideOpportunityCount": None,
                "trueMarketWideRecall": None,
                "status": "TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY",
                "privateNativeDayRowsEmitted": True,
                "sourceAttestedFullSymbolDayPriceJoin": True,
                "sourceAttestedHistoricalActiveSymbols": count,
                "sourceAttestedDailyBars": count,
                "nativeRowsSha256": digest,
                "privateNativeDaySource": {
                    "sourceClass": "TEST_FIXTURE", "sourceId": "TEST_ARCHIVE",
                    "market": market, "venue": venue,
                    "dayStartMs": day, "dayEndMs": day + DAY,
                    "sourcePriceConvention": "NATIVE_UNADJUSTED",
                    "rows": rows, "rowsSha256": digest,
                    "canonicalRowsJSON": canonical,
                },
            },
        }
    future = native_pit_daily_labels_v1(fixture("CRYPTO_FUTURES"))
    assert future["status"] == "TEST_FIXTURE_DAILY_EVENT_LABEL_ONLY", future
    assert future["observedSourcePriceEvents"] == 6, future
    assert future["directions"]["LONG"]["20"]["sourceObservedPriceEventCount"] == 1
    assert future["directions"]["SHORT"]["20"]["sourceObservedPriceEventCount"] == 1
    assert future["trueMarketWideRecall"] is None
    spot = native_pit_daily_labels_v1(fixture("CRYPTO_SPOT",high=102.,low=79.,open_=100.))
    assert spot["observedSourcePriceEvents"] == 0, spot
    assert set(spot["directions"]) == {"LONG"}
    assert spot["profitabilityProven"] is False
    broken = fixture("CRYPTO_FUTURES",count=2)
    unavailable = native_pit_daily_labels_v1(broken)
    assert unavailable["status"] == "BLOCKED_DATA"
    assert unavailable["observedSourcePriceEvents"] is None
    wrong = fixture("CRYPTO_FUTURES")
    wrong["result"]["privateNativeDaySource"]["rows"][0]["priorBarTimestampMs"] += DAY
    assert native_pit_daily_labels_v1(wrong)["status"] == "BLOCKED_DATA"
    missing = fixture("CRYPTO_FUTURES")
    del missing["result"]["privateNativeDaySource"]
    assert native_pit_daily_labels_v1(missing)["status"] == "BLOCKED_DATA"
    modified = fixture("CRYPTO_FUTURES")
    modified["result"]["privateNativeDaySource"]["rows"][0]["high"] += 40.
    assert native_pit_daily_labels_v1(modified)["reason"] == (
        "NATIVE_PIT_PRIVATE_SOURCE_ROWS_CHANGED"
    )
    digest_forged = fixture("CRYPTO_FUTURES")
    digest_forged["result"]["privateNativeDaySource"]["canonicalRowsJSON"] += " "
    assert native_pit_daily_labels_v1(digest_forged)["reason"] == (
        "NATIVE_PIT_PRIVATE_SOURCE_HASH_MISMATCH"
    )
    print("FOUR_MARKET_PIT_NATIVE_DAILY_EVENT_SCORER_SELF_TEST_PASS")


def main() -> None:
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
    input_path, output_path = Path(args.input), Path(args.output)
    stats = input_path.lstat()
    if not input_path.is_file() or input_path.is_symlink() \
       or stats.st_nlink != 1 or stats.st_size > 8 * 1024 * 1024 \
       or stats.st_mode & 0o077:
        raise ValueError("PIT_NATIVE_PRIVATE_DAY_SOURCE_FILE_UNSAFE")
    raw = json.loads(input_path.read_text(encoding="utf-8"))
    result = native_pit_daily_labels_v1(raw)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(output_path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        file.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "status": result["status"], "market": result["market"],
        "observedSourcePriceEvents": result["observedSourcePriceEvents"],
        "trueMarketWideRecall": None, "profitabilityProven": False,
        "executionAuthority": "NONE",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
