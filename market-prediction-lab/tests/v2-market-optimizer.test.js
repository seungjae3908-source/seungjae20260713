import test from "node:test";
import assert from "node:assert/strict";
import {
  buildV2ParameterCandidates,
  optimizeV2MarketParameters,
} from "../src/v2-market-optimizer.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function candles(symbol) {
  const start = Date.UTC(2019, 8, 1);
  return Array.from({ length: 2_350 }, (_, index) => {
    const cycle = Math.sin(index / 20) * 8;
    const trend = index * 0.035;
    const close = 100 + trend + cycle;
    const previousCycle = Math.sin(Math.max(0, index - 1) / 20) * 8;
    const open = index === 0 ? close : 100 + (index - 1) * 0.035 + previousCycle;
    const high = Math.max(open, close) + 2;
    const low = Math.max(1, Math.min(open, close) - 2);
    return Object.freeze({
      symbol,
      timestamp: start + index * DAY_MS,
      observedAt: start + index * DAY_MS,
      isClosed: true,
      open,
      high,
      low,
      close,
      volume: 1000 + (index % 30) * 10,
    });
  });
}

const SMALL_GRID = Object.freeze({
  fastPeriod: Object.freeze([10, 20]),
  slowPeriod: Object.freeze([40, 50]),
  atrPeriod: Object.freeze([14]),
  pullbackTolerancePct: Object.freeze([0.25, 0.5]),
  stopAtrMultiple: Object.freeze([1.25, 1.5]),
  targetRiskMultiple: Object.freeze([1.5, 2]),
});

test("candidate grid is deterministic, unique and respects slow > fast", () => {
  const first = buildV2ParameterCandidates("CRYPTO_SPOT", SMALL_GRID);
  const second = buildV2ParameterCandidates("CRYPTO_SPOT", SMALL_GRID);
  assert.deepEqual(first, second);
  assert.equal(first.length, 32);
  assert.ok(first.every((row) => row.slowPeriod > row.fastPeriod));
  assert.equal(new Set(first.map((row) => JSON.stringify(row))).size, first.length);
});

test("V2 optimizer never uses 2026 holdout for parameter selection and never uses a weighted score", () => {
  const result = optimizeV2MarketParameters({
    backtestInput: {
      market: "CRYPTO_SPOT",
      symbol: "USDT-BTC",
      side: "long",
      timeframe: "1d",
      initialCapital: 1_000_000,
      candles: candles("USDT-BTC"),
      costModel: { entryFeeRate: 0.001, exitFeeRate: 0.001, slippageRate: 0.0002, spreadRate: 0.0002 },
      riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
    },
    grid: SMALL_GRID,
  });
  assert.equal(result.objective.weightedScoreUsed, false);
  assert.equal(result.periods.finalHoldoutUsedForSelection, false);
  assert.equal(result.periods.validation.endTime, Date.UTC(2026, 0, 1) - 1);
  assert.equal(result.candidateCount, 31);
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateAccountRequestAllowed, false);
  assert.ok(["v2_candidate_frozen_for_holdout", "v2_research_hold"].includes(result.status));
  for (const leader of result.leaders) {
    assert.equal(leader.comparison.weightedScoreUsed, false);
    assert.ok(["adopt_candidate", "risk_review", "tradeoff_review", "reject"].includes(leader.comparison.verdict));
  }
});

test("futures use a distinct search grid from spot", () => {
  const spot = buildV2ParameterCandidates("CRYPTO_SPOT");
  const futures = buildV2ParameterCandidates("CRYPTO_FUTURES");
  assert.notDeepEqual(spot[0], futures[0]);
  assert.ok(futures.some((row) => row.fastPeriod === 8));
  assert.ok(spot.some((row) => row.fastPeriod === 30));
});
