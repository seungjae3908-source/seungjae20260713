import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBacktestPaperHandoffs } from './backtest-paper-handoff.service';
import { backtestPaperHandoffPath, readBacktestPaperHandoff, parseBacktestPaperHandoff } from '../../../packages/strategy-hypothesis/src/backtest-paper-handoff.js';
import type { BacktestRequest } from './backtest-engine.service';
import type { NormalizedCandle } from './futures-market-data.service';

const start = Date.UTC(2026, 0, 1);
const request: BacktestRequest = {
  market: 'crypto-futures', symbol: 'ETHUSDT', timeframe: '15m', startTime: start, endTime: start + 60_000,
  initialCapital: 10_000, strategy: 'breakout', side: 'both', parameters: { lookback: 20, volumeMultiplier: 1.2 },
  riskPercent: 0.5, leverage: 2, entryFeeRate: 0.0006, exitFeeRate: 0.0006, slippageRate: 0.0005,
  stopLossMode: 'percent', stopLossValue: 1, takeProfitMode: 'risk_multiple', takeProfitValue: 2,
  maximumConcurrentPositions: 1, maximumTradesPerDay: 10,
};
const candles: NormalizedCandle[] = [{
  symbol: 'ETHUSDT', market: 'crypto-futures', timeframe: '15m', timestamp: start,
  open: 100, high: 102, low: 99, close: 101, volume: 100, quoteVolume: 10000,
  source: 'fixture', isClosed: true, isDelayed: false, updatedAt: new Date(start).toISOString(),
}];
const sha = 'a'.repeat(40);

test('server snapshot preserves minimum identity, separates LONG/SHORT and grants no credit', () => {
  const handoffs = buildBacktestPaperHandoffs(request, candles, sha);
  assert.deepEqual(handoffs.map((value) => value.side), ['LONG', 'SHORT']);
  assert.notEqual(handoffs[0].candidateId, handoffs[1].candidateId);
  for (const value of handoffs) {
    assert.match(value.candidateId!, /^paper-candidate-v1:[0-9a-f]{64}$/u);
    assert.equal(value.symbol, request.symbol); assert.equal(value.timeframe, request.timeframe);
    assert.equal(value.leverage, request.leverage); assert.equal(value.market, 'CRYPTO_FUTURES');
    assert.equal(value.strategyId, 'BACKTEST_ENGINE:breakout');
    assert.equal(value.status, 'REFERENCE_ONLY'); assert.equal(value.evidenceCredit, 0);
    assert.equal(value.executionAuthority, 'NONE'); assert.equal(value.orderSubmitted, false);
    assert.equal(value.privateTradingApiAllowed, false);
    assert.ok(value.blockers.includes('CANONICAL_STRATEGY_PAPER_CONSUMER_UNAVAILABLE'));
    const path = backtestPaperHandoffPath(value);
    assert.deepEqual(readBacktestPaperHandoff(path.slice(path.indexOf('?'))).handoff, value);
  }
});

test('parameter ordering is stable while risk, cost, exit and symbol changes isolate candidates', () => {
  const baseline = buildBacktestPaperHandoffs(request, candles, sha)[0];
  assert.equal(buildBacktestPaperHandoffs({ ...request, parameters: { volumeMultiplier: 1.2, lookback: 20 } }, candles, sha)[0].candidateId, baseline.candidateId);
  for (const change of [{ leverage: 3 }, { riskPercent: 0.6 }, { entryFeeRate: 0.001 }, { stopLossValue: 2 }]) {
    const changed = buildBacktestPaperHandoffs({ ...request, ...change }, candles, sha)[0];
    assert.notEqual(changed.candidateId, baseline.candidateId); assert.notEqual(changed.parameterHash, baseline.parameterHash);
  }
  const changedSymbol = buildBacktestPaperHandoffs({ ...request, symbol: 'BTCUSDT' }, candles.map((row) => ({ ...row, symbol: 'BTCUSDT' })), sha)[0];
  assert.notEqual(changedSymbol.candidateId, baseline.candidateId);
});

test('missing code SHA or cross-symbol data never manufactures a complete candidate', () => {
  const missing = buildBacktestPaperHandoffs(request, candles, '')[0];
  assert.equal(missing.candidateId, null); assert.ok(missing.blockers.includes('MISSING:researchCodeSha'));
  const mismatch = buildBacktestPaperHandoffs(request, candles.map((row) => ({ ...row, symbol: 'BTCUSDT' })), sha)[0];
  assert.equal(mismatch.candidateId, null); assert.ok(mismatch.blockers.includes('BACKTEST_DATASET_IDENTITY_MISMATCH'));
});

test('route-parsed optional trailing fields are normalized before canonical hashing', () => {
  const parsed = { ...request, trailingStop: { enabled: false, activationR: undefined, distanceR: undefined } };
  assert.doesNotThrow(() => buildBacktestPaperHandoffs(parsed, candles, ''));
  const enabled = { ...request, trailingStop: { enabled: true, activationR: undefined, distanceR: undefined } };
  assert.equal(buildBacktestPaperHandoffs(enabled, candles, sha)[0].parameterHash,
    buildBacktestPaperHandoffs({ ...request, trailingStop: { enabled: true, activationR: 1, distanceR: 1 } }, candles, sha)[0].parameterHash);
});

test('null dimensions remain missing through URL roundtrip; malformed import never falls through to manual', () => {
  const baseline = buildBacktestPaperHandoffs(request, candles, '')[0];
  const missing = { ...baseline, strategyId: null, parameterHash: null, symbol: null, timeframe: null, side: null, leverage: null };
  const path = backtestPaperHandoffPath(missing);
  assert.deepEqual(readBacktestPaperHandoff(path.slice(path.indexOf('?'))).handoff, missing);
  for (const search of ['?backtestCandidate=', '?backtestCandidate=bad', '?backtestCandidate=%7B%7D', '?backtestCandidate=x&backtestCandidate=y']) {
    const imported = readBacktestPaperHandoff(search);
    assert.equal(imported.active, true); assert.equal(imported.handoff, null);
    assert.equal(imported.error, 'INVALID_BACKTEST_PAPER_HANDOFF');
  }
  assert.equal(readBacktestPaperHandoff('').active, false);
});

test('unknown, zero, invalid side and claimed authority are rejected without coercion', () => {
  const baseline = buildBacktestPaperHandoffs(request, candles, sha)[0];
  for (const change of [{ leverage: 0 }, { leverage: '2' }, { side: 'NO_TRADE' }, { side: 'both' },
    { candidateId: 'UNKNOWN' }, { parameterHash: 'MISSING' }, { executionAuthority: 'LIVE' },
    { evidenceCredit: 1 }, { orderSubmitted: true }, { privateTradingApiAllowed: true }]) {
    assert.equal(parseBacktestPaperHandoff({ ...baseline, ...change }), null);
  }
});
