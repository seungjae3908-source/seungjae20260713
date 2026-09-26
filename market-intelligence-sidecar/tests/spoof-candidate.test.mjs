import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSpoofCandidate } from '../src/spoof-candidate.mjs';

const now = 1_800_000_000_000;

function book(ts, { bidWall = 0, askWall = 0, bidWallPrice = 100, askWallPrice = 100.1 } = {}) {
  return {
    ts,
    bids: [[100, bidWall || 10], [99.9, 8], [99.8, 7], [99.7, 6], [99.6, 5], [99.5, 4]],
    asks: [[100.1, askWall || 10], [100.2, 8], [100.3, 7], [100.4, 6], [100.5, 5], [100.6, 4]].map((row, index) => index === 0 ? [askWallPrice, row[1]] : row),
  };
}

function persistentHistory(side = 'ask', price = 100.1, size = 100) {
  return [
    { asOf: now - 3_000, orderBook: book(now - 3_000, side === 'ask' ? { askWall: size, askWallPrice: price } : { bidWall: size, bidWallPrice: price }) },
    { asOf: now - 2_000, orderBook: book(now - 2_000, side === 'ask' ? { askWall: size, askWallPrice: price } : { bidWall: size, bidWallPrice: price }) },
    { asOf: now - 1_000, orderBook: book(now - 1_000, side === 'ask' ? { askWall: size, askWallPrice: price } : { bidWall: size, bidWallPrice: price }) },
  ];
}

test('persistent ask-wall withdrawal becomes bullish spoof candidate only as observe-only evidence', () => {
  const result = evaluateSpoofCandidate({
    currentBook: book(now, { askWall: 5 }),
    previousBook: book(now - 1_000, { askWall: 100 }),
    history: persistentHistory('ask', 100.1, 100),
    withdrawal: {
      score: 88,
      side: 'ask',
      cancellationRatio: 0.95,
      executedRatio: 0.05,
      wallPrice: 100.1,
      wallNotional: 10_010,
    },
    maxDataAgeMs: 15_000,
    ofi: 0.35,
    cvdNormalized: 0.25,
    micropriceBiasBps: 1.5,
  });
  assert.equal(result.state, 'CANDIDATE');
  assert.equal(result.direction, 'BULLISH_SUPPORT');
  assert.equal(result.mode, 'OBSERVE_ONLY');
  assert.equal(result.parentGateImpact, 'NONE');
  assert.equal(result.orderAllowed, false);
  assert.equal(result.executionAuthority, 'NONE');
  assert.ok(result.evidence.persistenceSnapshots >= 2);
  assert.ok(result.evidenceScore > 0);
});

test('single-snapshot withdrawal is insufficient rather than confirmed spoof', () => {
  const result = evaluateSpoofCandidate({
    currentBook: book(now, { bidWall: 5 }),
    previousBook: book(now - 1_000, { bidWall: 100 }),
    history: [{ asOf: now - 1_000, orderBook: book(now - 1_000, { bidWall: 100 }) }],
    withdrawal: {
      score: 85,
      side: 'bid',
      cancellationRatio: 0.95,
      executedRatio: 0.05,
      wallPrice: 100,
      wallNotional: 10_000,
    },
    ofi: -0.2,
    cvdNormalized: -0.1,
    micropriceBiasBps: -1,
  });
  assert.equal(result.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.direction, 'BEARISH_SUPPORT');
  assert.ok(result.missingEvidence.includes('MULTI_SNAPSHOT_HISTORY'));
  assert.ok(result.confounders.includes('WALL_PERSISTENCE_NOT_PROVEN'));
});

test('nearby quote migration is treated as a false-positive confounder', () => {
  const current = book(now, { askWall: 5 });
  current.asks[1] = [100.15, 90];
  const result = evaluateSpoofCandidate({
    currentBook: current,
    previousBook: book(now - 1_000, { askWall: 100 }),
    history: persistentHistory('ask', 100.1, 100),
    withdrawal: {
      score: 88,
      side: 'ask',
      cancellationRatio: 0.95,
      executedRatio: 0.05,
      wallPrice: 100.1,
      wallNotional: 10_010,
    },
    ofi: 0.2,
    cvdNormalized: 0.1,
    micropriceBiasBps: 1,
  });
  assert.equal(result.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.confounders.includes('NEARBY_QUOTE_MIGRATION'));
  assert.equal(result.parentGateImpact, 'NONE');
});

test('missing trade execution evidence never becomes a spoof candidate', () => {
  const result = evaluateSpoofCandidate({
    currentBook: book(now, { askWall: 5 }),
    previousBook: book(now - 1_000, { askWall: 100 }),
    history: persistentHistory('ask', 100.1, 100),
    withdrawal: {
      score: 88,
      side: 'ask',
      cancellationRatio: 0.95,
      executedRatio: null,
      wallPrice: 100.1,
      wallNotional: 10_010,
    },
  });
  assert.equal(result.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.missingEvidence.includes('TRADE_EXECUTION_EVIDENCE'));
  assert.equal(result.orderAllowed, false);
});

test('out-of-order and stale snapshot gaps fail closed', () => {
  const result = evaluateSpoofCandidate({
    currentBook: book(now - 40_000, { bidWall: 5 }),
    previousBook: book(now - 1_000, { bidWall: 100 }),
    history: persistentHistory('bid', 100, 100),
    withdrawal: {
      score: 80,
      side: 'bid',
      cancellationRatio: 0.9,
      executedRatio: 0.05,
      wallPrice: 100,
      wallNotional: 10_000,
    },
    maxDataAgeMs: 15_000,
  });
  assert.equal(result.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.confounders.includes('OUT_OF_ORDER_SNAPSHOT'));
});
