import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import {
  FORWARD_OBSERVER_LANES,
  createForwardObserverRuntimeState,
  latestCardEvidenceTimestamp,
  runForwardRecommendationObserverCycle,
  validateForwardObserverRuntimeState,
  type ForwardObserverLane,
} from './forward-recommendation-observer-runtime.service';

const SHA = 'a'.repeat(40);
const T0 = Date.parse('2026-08-16T00:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function card(): ScannerSignalCard {
  return {
    signalId: 'runtime-forward-1',
    assetClass: 'stock',
    market: 'KR',
    exchange: 'KRX',
    symbol: '005930',
    name: 'Samsung Electronics',
    currency: 'KRW',
    assetType: 'stock',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    action: 'BUY',
    signalState: 'CONFIRMED',
    score: 82,
    confidence: 76,
    dataCompleteness: 100,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 90,
    volume: 1000,
    tradingValue: 100000,
    spreadPercent: 0.1,
    volatilityPercent: 2,
    matched: ['trend'],
    notMatched: [],
    unverified: [],
    evidence: [
      { key: 'old', label: 'old', status: 'matched', source: 'yahoo-public', observedAt: iso(-60_000), reasons: [] },
      { key: 'new', label: 'new', status: 'matched', source: 'yahoo-public', observedAt: iso(0), reasons: [] },
      { key: 'future', label: 'future', status: 'matched', source: 'bad', observedAt: iso(60_000), reasons: [] },
    ],
    pricePlan: { entryZone: { from: 99, to: 101 }, invalidation: 95, stopLoss: 95, targets: [105, 110], riskReward: 1.5 },
    dataState: 'complete',
    dataSources: ['yahoo-public'],
    observedAt: iso(0),
    expiresAt: iso(4 * 60 * 60 * 1000),
    strongSignalEligible: true,
    warnings: [],
    strategyMode: 'swing',
    signalGrade: 'A',
    dataQuality: { state: 'TRUSTED', score: 100, strongSignalAllowed: true, issues: [] },
    quantScore: { technical: 80, trend: 85, momentum: 75, volume: 70, liquidity: 90, volatility: 65, marketRegime: 80, risk: 80 },
    aiValidation: { status: 'NOT_RUN', provider: null, counterEvidence: [], missingData: [], risks: [], explanation: null },
    backtestQuality: { status: 'verified', regime: 'Bull', costsIncluded: true, slippageIncluded: true, lookaheadGuarded: true, survivorshipGuarded: true, oos: true, walkForward: true },
  };
}

function response(lane: ForwardObserverLane, cards: ScannerSignalCard[]): ScannerResponse {
  const assetClass = lane.market === 'CRYPTO_SPOT' ? 'coin_spot' : lane.market === 'CRYPTO_FUTURES' ? 'coin_futures' : 'stock';
  return {
    ok: true,
    requestId: `request-${lane.id}`,
    assetClass,
    market: lane.scannerMarket,
    timeframe: lane.timeframe,
    cards,
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 20,
      startedCount: 20,
      completedCount: 20,
      excludedCount: Math.max(0, 20 - cards.length),
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 1,
      deadlineMs: 1000,
      itemTimeoutMs: 1000,
      maxConcurrency: 1,
    },
    universe: { totalCount: 40, cursor: 0, nextCursor: 20, source: 'public-test', partial: false, stale: false, listingStatusCoverage: 'listed-or-unknown' },
    dataState: 'complete',
    outcome: cards.length ? 'CANDIDATES_AVAILABLE' : 'VALID_ZERO_SIGNAL',
    message: 'test',
    generatedAt: iso(0),
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

test('runtime state is immutable-SHA scoped and fail-closed on identity or safety mixing', () => {
  const state = createForwardObserverRuntimeState(SHA, new Date(T0));
  validateForwardObserverRuntimeState(state, SHA);
  assert.throws(() => validateForwardObserverRuntimeState(state, 'b'.repeat(40)), /RESEARCH_SHA_MISMATCH/u);
  assert.throws(() => validateForwardObserverRuntimeState({ ...state, safety: { ...state.safety, financialMutationAllowed: true as false } }, SHA), /SAFETY_CONTRACT/u);
});

test('latest evidence timestamp never accepts evidence after signal observation time', () => {
  assert.equal(latestCardEvidenceTimestamp(card()), iso(0));
  assert.equal(latestCardEvidenceTimestamp({ ...card(), evidence: [] }), null);
});

test('cycle creates one idempotent public observation, ignores pre-signal bars and settles only on future evidence', async () => {
  const state = createForwardObserverRuntimeState(SHA, new Date(T0));
  const scanLane = async (lane: ForwardObserverLane) => response(lane, lane.id === 'KR_SWING_60M' ? [card()] : []);
  const first = await runForwardRecommendationObserverCycle({
    state,
    researchCodeSha: SHA,
    dependencies: {
      scanLane,
      loadFutureBars: async () => [],
      now: () => new Date(T0 + 60_000),
    },
  });
  assert.equal(first.summary.counts.createdThisCycle, 1);
  assert.equal(first.summary.counts.pending, 1);
  assert.equal(first.summary.counts.settled, 0);
  assert.deepEqual(first.state.cursors, {
    KR_SWING_60M: 20,
    US_SWING_60M: 20,
    SPOT_SWING_60M: 20,
    FUTURES_SWING_60M: 20,
  });
  assert.equal(first.summary.coverage.fullStrategyCoverage, false);
  assert.deepEqual(first.summary.coverage.strategies, ['SWING']);

  const second = await runForwardRecommendationObserverCycle({
    state: first.state,
    researchCodeSha: SHA,
    dependencies: {
      scanLane,
      loadFutureBars: async () => [
        { timestamp: iso(-60_000), high: 200, low: 1, close: 100 },
        { timestamp: iso(60 * 60 * 1000), high: 106, low: 99, close: 105 },
      ],
      now: () => new Date(T0 + 60 * 60 * 1000),
    },
  });
  assert.equal(second.summary.counts.total, 1);
  assert.equal(second.summary.counts.settled, 1);
  assert.equal(second.summary.counts.settledThisCycle, 1);
  assert.equal(second.summary.counts.replayedThisCycle, 1);
  assert.equal(second.state.observations[0]?.outcome?.outcome, 'WIN');
  assert.equal(second.summary.safety.executionAuthority, 'NONE');
  assert.equal(second.summary.safety.financialMutationAllowed, false);
  assert.equal(second.summary.safety.privateTradingApiAllowed, false);
  assert.equal(second.summary.safety.profitabilityClaimAllowed, false);
});

test('missing evidence timestamps are blocked instead of fabricated from now or signal time', async () => {
  const missing = { ...card(), signalId: 'missing-evidence', evidence: [] };
  const state = createForwardObserverRuntimeState(SHA, new Date(T0));
  const result = await runForwardRecommendationObserverCycle({
    state,
    researchCodeSha: SHA,
    dependencies: {
      scanLane: async (lane) => response(lane, lane.id === FORWARD_OBSERVER_LANES[0]?.id ? [missing] : []),
      loadFutureBars: async () => [],
      now: () => new Date(T0 + 60_000),
    },
  });
  assert.equal(result.summary.counts.total, 0);
  const kr = result.summary.lanes.find((lane) => lane.laneId === 'KR_SWING_60M');
  assert.equal(kr?.blocked, 1);
  assert.equal(kr?.blockers.DATA_TIMESTAMP_FROM_EVIDENCE_REQUIRED, 1);
});
