import assert from "node:assert/strict";
import test from "node:test";

import {
  CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
  CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
  buildPumpReversalPointInTimeProfile,
  detectPumpProspectiveExit,
  evaluatePumpReversalCleanV1,
  openPumpProspectiveResearchPosition,
  pumpReversalCleanV1Contract,
} from "../src/crypto-pump-reversal-clean-v1.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T08:00:00.000Z");

function dailySeries({
  count = 181,
  endAtMs = NOW - DAY,
  startPrice = 100,
  endPrice = 110,
  quoteVolume = 10_000_000,
  rangePercent = 4,
} = {}) {
  const first = endAtMs - (count - 1) * DAY;
  return Array.from({ length: count }, (_, index) => {
    const ratio = count === 1 ? 1 : index / (count - 1);
    const close = startPrice + (endPrice - startPrice) * ratio;
    const open = close;
    const half = rangePercent / 200;
    return {
      timestampMs: first + index * DAY,
      open,
      high: open * (1 + half),
      low: open * (1 - half),
      close,
      quoteVolume,
    };
  });
}

function hourlyPumpSeries({
  currentQuoteVolume = 20_000_000,
  baselineQuoteVolume = 10_000_000,
  pumpPercent = 30,
} = {}) {
  const count = 169;
  const first = NOW - count * HOUR;
  const rows = Array.from({ length: count }, (_, index) => ({
    timestampMs: first + index * HOUR,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    quoteVolume: baselineQuoteVolume,
  }));
  const latest = rows.at(-1);
  const reference = rows.at(-25);
  reference.open = 100;
  reference.high = 101;
  reference.low = 99;
  reference.close = 100;
  latest.open = 100;
  latest.close = 100 * (1 + pumpPercent / 100);
  latest.high = latest.close * 1.01;
  latest.low = 99;
  latest.quoteVolume = currentQuoteVolume;
  return rows;
}

function eligibleProfile() {
  return buildPumpReversalPointInTimeProfile({
    symbol: "ALTUSDT",
    observedAtMs: NOW,
    dailyCandles: dailySeries(),
    tradingStatus: "TRADABLE",
    liquidityReady: true,
  });
}

test("PIT universe uses only ex-ante profile fields and never performance exclusions", () => {
  const profile = eligibleProfile();
  assert.equal(profile.eligible, true);
  assert.deepEqual(profile.blockers, []);
  assert.equal(profile.performanceBasedExclusionUsed, false);
  assert.equal(profile.averageDailyQuoteVolumeUsd, 10_000_000);
  assert.ok(profile.averageDailyRangePercent < 7.5);
  assert.equal(profile.extremeMoveFrequencyPercent, 0);
  assert.ok(profile.historyDays >= 180);
});

test("PIT universe rejects an extreme-move-prone coin without reading strategy PnL", () => {
  const rows = dailySeries();
  rows[0] = { ...rows[0], open: 100, high: 160, low: 99, close: 155 };
  const profile = buildPumpReversalPointInTimeProfile({
    symbol: "ALTUSDT",
    observedAtMs: NOW,
    dailyCandles: rows,
    tradingStatus: "TRADABLE",
    liquidityReady: true,
  });
  assert.equal(profile.eligible, false);
  assert.ok(profile.blockers.includes("PIT_EXTREME_MOVE_FREQUENCY_TOO_HIGH"));
});

test("clean Pump signal requires 25% 24h rise, current-hour volume percentile and allowed BTC regime", () => {
  const signal = evaluatePumpReversalCleanV1({
    symbol: "ALTUSDT",
    observedAtMs: NOW,
    profile: eligibleProfile(),
    hourlyCandles: hourlyPumpSeries(),
    btcDailyCandles: dailySeries({ count: 31, startPrice: 100, endPrice: 110, quoteVolume: 1 }),
  });
  assert.equal(signal.decision, "PAPER_RESEARCH_SIGNAL");
  assert.equal(signal.direction, "SHORT");
  assert.equal(signal.eligibleForProspectiveResearchSample, true);
  assert.equal(signal.canonicalProfitAdmissionEligible, false);
  assert.equal(signal.profitabilityProven, false);
  assert.ok(signal.pump24hPercent >= 25);
  assert.ok(signal.currentHourVolumePercentile >= 0.5);
  assert.ok(signal.btc30dReturnPercent < 30);
  assert.match(signal.signalId, /^[0-9a-f]{64}$/);
});

test("BTC bear-rebound regime is a hard NO_TRADE", () => {
  const btc = dailySeries({ count: 31, startPrice: 120, endPrice: 100, quoteVolume: 1 });
  // Force the last seven days into a rebound while the 30d return stays negative.
  const last = btc.at(-1);
  for (let index = btc.length - 8; index < btc.length; index += 1) {
    const step = index - (btc.length - 8);
    const close = 94 + step;
    btc[index] = { ...btc[index], open: close, high: close * 1.01, low: close * 0.99, close };
  }
  last.close = btc.at(-1).close;
  const signal = evaluatePumpReversalCleanV1({
    symbol: "ALTUSDT",
    observedAtMs: NOW,
    profile: eligibleProfile(),
    hourlyCandles: hourlyPumpSeries(),
    btcDailyCandles: btc,
  });
  assert.equal(signal.decision, "NO_TRADE");
  assert.ok(signal.blockers.includes("BTC_BEAR_REBOUND_REGIME_BLOCK"));
});

test("same-symbol 24h cooldown blocks re-entry", () => {
  const signal = evaluatePumpReversalCleanV1({
    symbol: "ALTUSDT",
    observedAtMs: NOW,
    profile: eligibleProfile(),
    hourlyCandles: hourlyPumpSeries(),
    btcDailyCandles: dailySeries({ count: 31, startPrice: 100, endPrice: 110, quoteVolume: 1 }),
    lastEntryAtMs: NOW - 12 * HOUR,
  });
  assert.equal(signal.decision, "NO_TRADE");
  assert.ok(signal.blockers.includes("SYMBOL_24H_REENTRY_COOLDOWN"));
});

test("entry is the exact next 1h bar open and same-bar entry is impossible", () => {
  const signal = evaluatePumpReversalCleanV1({
    symbol: "ALTUSDT",
    observedAtMs: NOW,
    profile: eligibleProfile(),
    hourlyCandles: hourlyPumpSeries(),
    btcDailyCandles: dailySeries({ count: 31, startPrice: 100, endPrice: 110, quoteVolume: 1 }),
  });
  const position = openPumpProspectiveResearchPosition({
    signal,
    nextHourCandle: { timestampMs: signal.nextBarOpenTimestampMs, open: 120 },
  });
  assert.equal(position.entryPrice, 120);
  assert.equal(position.stopPrice, 150);
  assert.equal(position.timeExitAtMs, position.entryTimestampMs + 72 * HOUR);
  assert.throws(
    () => openPumpProspectiveResearchPosition({
      signal,
      nextHourCandle: { timestampMs: signal.sourceBarTimestampMs, open: 120 },
    }),
    /PUMP_NEXT_BAR_TIMESTAMP_MISMATCH|PUMP_SAME_BAR_ENTRY_FORBIDDEN/,
  );
});

test("1m stop trigger uses adverse gap price rather than optimistic stop fill", () => {
  const signal = evaluatePumpReversalCleanV1({
    symbol: "ALTUSDT",
    observedAtMs: NOW,
    profile: eligibleProfile(),
    hourlyCandles: hourlyPumpSeries(),
    btcDailyCandles: dailySeries({ count: 31, startPrice: 100, endPrice: 110, quoteVolume: 1 }),
  });
  const position = openPumpProspectiveResearchPosition({
    signal,
    nextHourCandle: { timestampMs: signal.nextBarOpenTimestampMs, open: 100 },
  });
  const exit = detectPumpProspectiveExit({
    position,
    observedAtMs: position.entryTimestampMs + 2 * 60_000,
    minuteCandles: [{
      timestampMs: position.entryTimestampMs,
      open: 130,
      high: 132,
      low: 129,
      close: 131,
      quoteVolume: 100_000,
    }],
  });
  assert.equal(exit.status, "EXIT_TRIGGERED");
  assert.equal(exit.reason, "STOP_25_PERCENT");
  assert.equal(exit.referenceExitPrice, 130);
  assert.equal(exit.settlementReady, false);
  assert.equal(exit.settlementBlocker, "CANONICAL_FULL_COST_SETTLEMENT_REQUIRED");
});

test("72h time exit is detected but cannot claim settlement before canonical full-cost evidence", () => {
  const signal = evaluatePumpReversalCleanV1({
    symbol: "ALTUSDT",
    observedAtMs: NOW,
    profile: eligibleProfile(),
    hourlyCandles: hourlyPumpSeries(),
    btcDailyCandles: dailySeries({ count: 31, startPrice: 100, endPrice: 110, quoteVolume: 1 }),
  });
  const position = openPumpProspectiveResearchPosition({
    signal,
    nextHourCandle: { timestampMs: signal.nextBarOpenTimestampMs, open: 100 },
  });
  const exit = detectPumpProspectiveExit({
    position,
    observedAtMs: position.timeExitAtMs + 60_000,
    minuteCandles: [{
      timestampMs: position.timeExitAtMs,
      open: 90,
      high: 91,
      low: 89,
      close: 90,
      quoteVolume: 100_000,
    }],
  });
  assert.equal(exit.reason, "TIME_EXIT_72H");
  assert.equal(exit.referenceExitPrice, 90);
  assert.equal(exit.settlementReady, false);
});

test("contract hard-codes no fake profitability bootstrap and zero execution authority", () => {
  const contract = pumpReversalCleanV1Contract();
  assert.equal(contract.strategyId, CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1);
  assert.equal(contract.parameterHash, CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH);
  assert.equal(contract.bootstrapPolicy.fabricatedExpectedEdgeAllowed, false);
  assert.equal(contract.bootstrapPolicy.fabricatedSampleSizeAllowed, false);
  assert.equal(contract.bootstrapPolicy.canonicalProfitAdmissionBeforeObservedCalibration, false);
  assert.equal(contract.bootstrapPolicy.profitabilityProven, false);
  assert.equal(contract.bootstrapPolicy.currentValidatedChampion, "NONE");
  assert.equal(contract.executionAuthority, "NONE");
  assert.equal(contract.liveOrderAllowed, false);
});
