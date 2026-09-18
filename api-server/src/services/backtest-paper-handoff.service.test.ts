import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBacktestPaperHandoffBundle, buildBacktestPaperHandoffs } from './backtest-paper-handoff.service';
import { backtestPaperHandoffPath, readBacktestPaperHandoff, parseBacktestPaperHandoff } from '../../../packages/strategy-hypothesis/src/backtest-paper-handoff.js';
import type { BacktestRequest } from './backtest-engine.service';
import type { NormalizedCandle } from './futures-market-data.service';
import { ProductPaperSourceRegistry } from './product-paper-source-registry.service';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import { getScannerStrategyProfile, type ScannerProfileMarket } from './scanner-strategy-profile.service';

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
    assert.equal(value.blockers.includes('CANONICAL_STRATEGY_PAPER_CONSUMER_UNAVAILABLE'), false);
    assert.ok(value.blockers.includes('NATURAL_PAPER_EVIDENCE_NOT_PROVEN'));
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

test('search dates and initialCapital do not remint canonical candidate identity', () => {
  const baseline = buildBacktestPaperHandoffs(request, candles, sha)[0];
  const changed = buildBacktestPaperHandoffs({ ...request, initialCapital: 20_000,
    startTime: request.startTime - 1, endTime: request.endTime + 1 }, candles, sha)[0];
  assert.equal(changed.candidateId, baseline.candidateId);
  assert.equal(changed.parameterHash, baseline.parameterHash);
});

const approval = { mode: 'approval', accountMode: 'paper', adapter: 'paper' };
test('server Backtest source keeps all eight fields and immutable accepted strategy parameters', () => {
  let now = start;
  const registry = new ProductPaperSourceRegistry(() => now);
  const accepted = structuredClone(request);
  const bundle = buildBacktestPaperHandoffBundle(accepted, candles, sha);
  const handoffs = bundle.handoffs;
  const run = registry.captureBacktest('owner', accepted, handoffs, sha, bundle.strategyIdentityInputs)!;
  accepted.parameters.lookback = 99;
  for (const handoff of handoffs) {
    const source = registry.resolveBacktest('owner', { ...approval, backtestRunId: run, backtestCandidate: handoff }, sha);
    assert.equal(source.request.parameters.lookback, 20);
    for (const field of ['candidateId', 'strategyId', 'parameterHash', 'market', 'symbol', 'timeframe', 'side', 'leverage'] as const) {
      assert.equal(source.handoff[field], handoff[field]);
    }
    assert.ok(Object.isFrozen(source.request.parameters));
  }
  assert.throws(() => registry.resolveBacktest('other', { ...approval, backtestRunId: run, backtestCandidate: handoffs[0] }, sha), /NOT_RESOLVABLE/);
  assert.throws(() => registry.resolveBacktest('owner', { ...approval, backtestRunId: run, backtestCandidate: handoffs[0] }, 'b'.repeat(40)), /SHA_MISMATCH/);
  now += 30_000;
  assert.throws(() => registry.resolveBacktest('owner', { ...approval, backtestRunId: run, backtestCandidate: handoffs[0] }, sha), /NOT_RESOLVABLE/);
});

test('Backtest modified dimensions, private authority, unresolved run and latest fallback fail closed', () => {
  const registry = new ProductPaperSourceRegistry(() => start);
  const bundle = buildBacktestPaperHandoffBundle(request, candles, sha);
  const handoff = bundle.handoffs[0];
  const run = registry.captureBacktest('owner', request, [handoff], sha, bundle.strategyIdentityInputs)!;
  const body = { ...approval, backtestRunId: run, backtestCandidate: handoff };
  for (const change of [{ candidateId: `paper-candidate-v1:${'f'.repeat(64)}` }, { strategyId: 'BACKTEST_ENGINE:vwap_reclaim' },
    { parameterHash: 'f'.repeat(64) }, { market: 'US_STOCK' }, { symbol: 'BTCUSDT' }, { timeframe: '4H' }, { side: 'SHORT' }, { leverage: 3 }]) {
    assert.throws(() => registry.resolveBacktest('owner', { ...body, backtestCandidate: { ...handoff, ...change } }, sha));
  }
  for (const change of [{ backtestRunId: 'latest' }, { backtestRunId: undefined }, { accountMode: 'live' }, { mode: 'automatic' },
    { receipt: { genuine: true } }, { canonicalEvidence: {} }, { privateTradingApiAllowed: true }]) {
    assert.throws(() => registry.resolveBacktest('owner', { ...body, ...change }, sha));
  }
  const path = backtestPaperHandoffPath(handoff, run);
  assert.equal(readBacktestPaperHandoff(path.slice(path.indexOf('?'))).runId, run);
  assert.throws(() => backtestPaperHandoffPath(handoff, 'latest'), /INVALID_BACKTEST_RUN_REFERENCE/);
});

function scannerSource(market: ScannerProfileMarket, side: 'BUY' | 'LONG' | 'SHORT', now: number): ScannerResponse {
  const profile = getScannerStrategyProfile(market, 'SWING');
  const card: ScannerSignalCard = {
    signalId: 'server-signal', assetClass: market === 'CRYPTO_FUTURES' ? 'coin_futures' : market === 'CRYPTO_SPOT' ? 'coin_spot' : 'stock',
    market, exchange: null, symbol: market === 'KR_STOCK' ? '005930' : market === 'US_STOCK' ? 'AAPL' : market === 'CRYPTO_SPOT' ? 'KRW-BTC' : 'BTCUSDT',
    name: 'fixture', currency: 'fixture', assetType: 'fixture', listingStatus: 'LISTED', price: 100, changePercent: 1,
    direction: side === 'SHORT' ? 'SHORT' : 'LONG', action: side, signalState: 'READY_FOR_APPROVAL',
    score: 80, confidence: 80, dataCompleteness: 100, riskScore: 10, riskLevel: 'LOW', liquidity: 100000, volume: 100,
    tradingValue: 100000, spreadPercent: 0.1, volatilityPercent: 1, matched: ['trend_alignment'], notMatched: [], unverified: [], evidence: [],
    pricePlan: { entryZone: { from: 99, to: 101 }, invalidation: 95, stopLoss: 95, targets: [110], riskReward: 2 },
    dataState: 'complete', dataSources: ['test-only-public-source'], observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), strongSignalEligible: true, warnings: [], strategyMode: 'swing',
  };
  return { ok: true, requestId: 'server-run', assetClass: card.assetClass, market, timeframe: profile.primaryTimeframe, cards: [card],
    alerts: [], failures: [], execution: { cancelled: false } as ScannerResponse['execution'], universe: {} as ScannerResponse['universe'],
    dataState: 'complete', message: '', generatedAt: new Date(now).toISOString(), orderSubmitted: false, exchangeRequestSent: false };
}
for (const [market, side] of [['KR_STOCK', 'BUY'], ['US_STOCK', 'BUY'], ['CRYPTO_SPOT', 'BUY'],
  ['CRYPTO_FUTURES', 'LONG'], ['CRYPTO_FUTURES', 'SHORT']] as const) {
  test(`server-owned ${market} ${side} source reaches existing canonical resolver, not Paper execution`, () => {
    const registry = new ProductPaperSourceRegistry(() => start);
    const response = scannerSource(market, side, start);
    registry.captureScanner('owner', response, sha);
    const card = response.cards[0];
    const resolved = registry.resolveScanner('owner', { ...approval, searchRunId: response.requestId, signalId: card.signalId,
      market, symbol: card.symbol, timeframe: response.timeframe, side }, sha);
    assert.equal(resolved.paperCandidate.signal.market, market);
    assert.equal(resolved.paperCandidate.signal.symbol, card.symbol);
    assert.equal(resolved.paperCandidate.signal.timeframe, response.timeframe);
    assert.equal(resolved.paperCandidate.signal.direction, side);
    assert.equal(resolved.originalSignalDirection, card.direction);
    assert.equal(resolved.paperCandidate.signal.strategyIdentity.parameterDigest, resolved.paperCandidate.signal.strategyIdentity.parameterHash);
    assert.equal(resolved.paperCandidate.executionAuthority, 'NONE');
    assert.equal(resolved.paperCandidate.orderSubmitted, false);
  });
}
test('Scanner substitution, missing side, conflicting signal and client leverage fail before consumer', () => {
  let now = start;
  const registry = new ProductPaperSourceRegistry(() => now);
  const response = scannerSource('CRYPTO_FUTURES', 'LONG', now);
  registry.captureScanner('owner', response, sha);
  const body = { ...approval, searchRunId: response.requestId, signalId: response.cards[0].signalId,
    market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', timeframe: response.timeframe, side: 'LONG' };
  for (const change of [{ side: undefined }, { side: 'NO_TRADE' }, { side: 'SIGNAL_CONFLICT' }, { side: 'SHORT' },
    { market: 'UNKNOWN' }, { market: 'US_STOCK', side: 'BUY' }, { symbol: 'ETHUSDT' }, { timeframe: '1D' },
    { strategyId: 'wrong' }, { candidateId: 'wrong' }, { parameterHash: 'wrong' }, { leverage: 2 },
    { selectedConditions: ['invented'] }, { executionEvidence: {} }]) {
    assert.throws(() => registry.resolveScanner('owner', { ...body, ...change }, sha));
  }
  response.cards[0].action = 'SHORT';
  response.cards[0].symbol = 'ETHUSDT';
  assert.equal(registry.resolveScanner('owner', body, sha).paperCandidate.signal.direction, 'LONG');
  assert.throws(() => registry.resolveScanner('other', body, sha));
  now += 30_000;
  assert.throws(() => registry.resolveScanner('owner', body, sha));
  const conflict = scannerSource('CRYPTO_FUTURES', 'LONG', now);
  conflict.cards[0].direction = 'NEUTRAL';
  registry.captureScanner('owner', conflict, sha);
  assert.throws(() => registry.resolveScanner('owner', body, sha), /CONFLICT/);
});

test('Scanner missing provenance and duplicate snapshot cannot refresh eligibility', () => {
  let now = start;
  const registry = new ProductPaperSourceRegistry(() => now);
  const response = scannerSource('KR_STOCK', 'BUY', now);
  response.cards[0].dataSources = [];
  registry.captureScanner('owner', response, sha);
  const body = { ...approval, searchRunId: response.requestId, signalId: 'server-signal', market: 'KR_STOCK',
    symbol: '005930', timeframe: response.timeframe, side: 'BUY' };
  response.cards[0].dataSources = ['test-only'];
  registry.captureScanner('owner', response, sha);
  assert.throws(() => registry.resolveScanner('owner', body, sha), /NOT_EXECUTION_ELIGIBLE/);
  now += 30_000;
  assert.throws(() => registry.resolveScanner('owner', body, sha), /NOT_RESOLVABLE/);
});

test('bounded source saturation cannot evict or substitute an unexpired Scanner reference', () => {
  let now = start;
  const registry = new ProductPaperSourceRegistry(() => now);
  const first = scannerSource('KR_STOCK', 'BUY', now);
  registry.captureScanner('owner', first, sha);
  const body = { ...approval, searchRunId: first.requestId, signalId: first.cards[0].signalId,
    market: 'KR_STOCK', symbol: '005930', timeframe: first.timeframe, side: 'BUY' };
  for (let index = 1; index < 256; index += 1) {
    const response = scannerSource('KR_STOCK', 'BUY', now);
    response.requestId = `capacity-${index}`;
    registry.captureScanner('owner', response, sha);
  }
  const overflow = scannerSource('KR_STOCK', 'BUY', now);
  overflow.requestId = 'capacity-overflow';
  registry.captureScanner('owner', overflow, sha);
  assert.equal(registry.resolveScanner('owner', body, sha).paperCandidate.signal.symbol, '005930');
  assert.throws(() => registry.resolveScanner('owner', { ...body, searchRunId: overflow.requestId }, sha), /NOT_RESOLVABLE/);
  const saturatedBacktestBundle = buildBacktestPaperHandoffBundle(request, candles, sha);
  assert.equal(registry.captureBacktest('owner', request, saturatedBacktestBundle.handoffs, sha, saturatedBacktestBundle.strategyIdentityInputs), null,
    'a saturated registry must not issue a Backtest run reference that it did not store');
  first.cards[0].dataSources = [];
  registry.captureScanner('owner', first, sha);
  assert.equal(registry.resolveScanner('owner', body, sha).source.card.dataSources.length, 1);
  now += 30_000;
  const fresh = scannerSource('KR_STOCK', 'BUY', now);
  fresh.requestId = 'fresh-after-expiry';
  registry.captureScanner('owner', fresh, sha);
  assert.equal(registry.resolveScanner('owner', { ...body, searchRunId: fresh.requestId }, sha).paperCandidate.signal.symbol, '005930');
  assert.throws(() => registry.resolveScanner('owner', body, sha), /NOT_RESOLVABLE/);
});
