import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import {
  FORWARD_OBSERVER_LANES,
  canonicalForwardStrategyIdentityFromCard,
  createForwardObserverRuntimeState,
  latestCardEvidenceTimestamp,
  runForwardRecommendationObserverCycle,
  validateForwardObserverRuntimeState,
  type ForwardObserverLane,
} from './forward-recommendation-observer-runtime.service';

const SHA = 'a'.repeat(40);
const T0 = Date.parse('2026-08-16T00:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

type PaperCandidateCard = ScannerSignalCard & {
  paperCandidate?: {
    signal: {
      signalId: string;
      market: string;
      symbol: string;
      timeframe: string;
      horizon: number;
      direction: string;
      style: string;
      strategyIdentity: {
        strategyId: string;
        strategyVersion: string;
        parameterHash: string;
        researchCodeSha: string;
      };
    };
    paperIdentity?: {
      signalId: string;
      strategyId: string;
      strategyVersion: string;
      parameterHash: string;
      researchCodeSha: string;
      market: string;
      symbol: string;
      timeframe: string;
      horizon: number;
      direction: string;
      executionAuthority: 'NONE';
    };
    executionAuthority: 'NONE';
    liveOrderAllowed: false;
    privateTradingApiAllowed: false;
    orderSubmitted: false;
    exchangeRequestSent: false;
  };
};

function card(includePaperCandidate = true): PaperCandidateCard {
  const base: ScannerSignalCard = {
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
      { key: 'future', label: 'future', status: 'unverified', source: 'bad', observedAt: iso(60_000), reasons: [] },
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
  if (!includePaperCandidate) return { ...base };
  return {
    ...base,
    paperCandidate: {
      signal: {
        signalId: base.signalId,
        market: 'KR_STOCK',
        symbol: base.symbol,
        timeframe: '60m',
        horizon: 4,
        direction: 'BUY',
        style: 'SWING',
        strategyIdentity: {
          strategyId: 'kr-stock-swing-v1',
          strategyVersion: 'signal-profile-v1',
          parameterHash: 'kr-swing-params-v1',
          researchCodeSha: SHA,
        },
      },
      paperIdentity: {
        signalId: base.signalId,
        strategyId: 'kr-stock-swing-v1',
        strategyVersion: 'signal-profile-v1',
        parameterHash: 'kr-swing-params-v1',
        researchCodeSha: SHA,
        market: 'KR_STOCK',
        symbol: base.symbol,
        timeframe: '60m',
        horizon: 4,
        direction: 'BUY',
        executionAuthority: 'NONE',
      },
      executionAuthority: 'NONE',
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    },
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

test('runtime state is immutable-SHA scoped and fail-closed on cursor or safety mixing', () => {
  const state = createForwardObserverRuntimeState(SHA, new Date(T0));
  validateForwardObserverRuntimeState(state, SHA);
  assert.throws(() => validateForwardObserverRuntimeState(state, 'b'.repeat(40)), /RESEARCH_SHA_MISMATCH/u);
  assert.throws(() => validateForwardObserverRuntimeState({ ...state, safety: { ...state.safety, financialMutationAllowed: true as false } }, SHA), /SAFETY_CONTRACT/u);
  assert.throws(() => validateForwardObserverRuntimeState({ ...state, cursors: { ...state.cursors, KR_SWING_60M: -1 } }, SHA), /CURSOR_INVALID/u);
});

test('canonical paper candidate strategy identity is the only forward identity source', () => {
  const lane = FORWARD_OBSERVER_LANES[0]!;
  const resolved = canonicalForwardStrategyIdentityFromCard(card(), lane, SHA);
  assert.deepEqual(resolved.blockers, []);
  assert.deepEqual(resolved.identity, {
    strategyId: 'kr-stock-swing-v1',
    strategyVersion: 'signal-profile-v1',
    parameterHash: 'kr-swing-params-v1',
    researchCodeSha: SHA,
    market: 'KR_STOCK',
    symbol: '005930',
    timeframe: '60m',
    horizon: 4,
    direction: 'BUY',
  });

  const missing = canonicalForwardStrategyIdentityFromCard(card(false), lane, SHA);
  assert.equal(missing.identity, null);
  assert.ok(missing.blockers.includes('CANONICAL_PAPER_CANDIDATE_REQUIRED'));
});

test('strategyId strategyVersion parameterHash research SHA market timeframe horizon and direction mismatch all fail closed', () => {
  const lane = FORWARD_OBSERVER_LANES[0]!;
  const paperMismatchCases: Array<[string, string, unknown]> = [
    ['strategyId', 'STRATEGY_ID', 'other-strategy'],
    ['strategyVersion', 'STRATEGY_VERSION', 'v2'],
    ['parameterHash', 'PARAMETER_HASH', 'other-params'],
    ['market', 'MARKET', 'US_STOCK'],
    ['timeframe', 'TIMEFRAME', '4H'],
    ['horizon', 'HORIZON', 8],
    ['direction', 'DIRECTION', 'SELL'],
  ];
  for (const [field, blockerField, value] of paperMismatchCases) {
    const selected = card();
    assert.ok(selected.paperCandidate?.paperIdentity);
    (selected.paperCandidate.paperIdentity as Record<string, unknown>)[field] = value;
    const result = canonicalForwardStrategyIdentityFromCard(selected, lane, SHA);
    assert.equal(result.identity, null, field);
    assert.ok(result.blockers.includes(`PAPER_IDENTITY_${blockerField}_MISMATCH`), field);
  }

  const research = card();
  assert.ok(research.paperCandidate);
  research.paperCandidate.signal.strategyIdentity.researchCodeSha = 'b'.repeat(40);
  if (research.paperCandidate.paperIdentity) research.paperCandidate.paperIdentity.researchCodeSha = 'b'.repeat(40);
  const researchResult = canonicalForwardStrategyIdentityFromCard(research, lane, SHA);
  assert.equal(researchResult.identity, null);
  assert.ok(researchResult.blockers.includes('RESEARCH_CODE_SHA_MISMATCH'));
});

test('candidate signal market symbol timeframe and direction must also match the actual scanner lane/card', () => {
  const lane = FORWARD_OBSERVER_LANES[0]!;

  const market = card();
  assert.ok(market.paperCandidate);
  market.paperCandidate.signal.market = 'US_STOCK';
  if (market.paperCandidate.paperIdentity) market.paperCandidate.paperIdentity.market = 'US_STOCK';
  assert.ok(canonicalForwardStrategyIdentityFromCard(market, lane, SHA).blockers.includes('PAPER_MARKET_MISMATCH'));

  const symbol = card();
  assert.ok(symbol.paperCandidate);
  symbol.paperCandidate.signal.symbol = '000660';
  if (symbol.paperCandidate.paperIdentity) symbol.paperCandidate.paperIdentity.symbol = '000660';
  assert.ok(canonicalForwardStrategyIdentityFromCard(symbol, lane, SHA).blockers.includes('PAPER_SYMBOL_MISMATCH'));

  const timeframe = card();
  assert.ok(timeframe.paperCandidate);
  timeframe.paperCandidate.signal.timeframe = '4H';
  if (timeframe.paperCandidate.paperIdentity) timeframe.paperCandidate.paperIdentity.timeframe = '4H';
  assert.ok(canonicalForwardStrategyIdentityFromCard(timeframe, lane, SHA).blockers.includes('PAPER_TIMEFRAME_MISMATCH'));

  const direction = card();
  assert.ok(direction.paperCandidate);
  direction.paperCandidate.signal.direction = 'SELL';
  if (direction.paperCandidate.paperIdentity) direction.paperCandidate.paperIdentity.direction = 'SELL';
  const directionResolved = canonicalForwardStrategyIdentityFromCard(direction, lane, SHA);
  assert.equal(directionResolved.identity?.direction, 'SELL');
});

test('evidence cutoff uses oldest matched timestamp and rejects incomplete or future matched provenance', () => {
  assert.equal(latestCardEvidenceTimestamp(card()), iso(-60_000));
  assert.equal(latestCardEvidenceTimestamp({ ...card(), evidence: [] }), null);
  assert.equal(latestCardEvidenceTimestamp({
    ...card(),
    evidence: [{ key: 'missing', label: 'missing', status: 'matched', source: 'yahoo-public', observedAt: null, reasons: [] }],
  }), null);
  assert.equal(latestCardEvidenceTimestamp({
    ...card(),
    evidence: [{ key: 'future-matched', label: 'future', status: 'matched', source: 'yahoo-public', observedAt: iso(60_000), reasons: [] }],
  }), null);
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
  assert.equal(first.state.observations[0]?.identity.strategyId, 'kr-stock-swing-v1');
  assert.equal(first.state.observations[0]?.identity.parameterHash, 'kr-swing-params-v1');
  assert.equal(first.state.observations[0]?.snapshot.strategyProfileVersion, 'signal-profile-v1');
  assert.equal('strategyProfileVersion' in (first.state.observations[0]?.identity ?? {}), false);
  assert.deepEqual(first.state.cursors, {
    KR_SWING_60M: 20,
    US_SWING_60M: 20,
    SPOT_SWING_60M: 20,
    FUTURES_SWING_60M: 20,
  });

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
  assert.equal(second.summary.safety.profitabilityClaimAllowed, false);
});

test('missing canonical paper identity is blocked without consuming the scanner cursor or fabricating a lane hash', async () => {
  const state = createForwardObserverRuntimeState(SHA, new Date(T0));
  const result = await runForwardRecommendationObserverCycle({
    state,
    researchCodeSha: SHA,
    dependencies: {
      scanLane: async (lane) => response(lane, lane.id === 'KR_SWING_60M' ? [card(false)] : []),
      loadFutureBars: async () => [],
      now: () => new Date(T0 + 60_000),
    },
  });
  assert.equal(result.summary.counts.total, 0);
  assert.equal(result.state.cursors.KR_SWING_60M, 0);
  const kr = result.summary.lanes.find((lane) => lane.laneId === 'KR_SWING_60M');
  assert.equal(kr?.blocked, 1);
  assert.equal(kr?.blockers.CANONICAL_PAPER_CANDIDATE_REQUIRED, 1);
});

test('partial or provider-failed scan lanes are rejected without advancing cursor or creating biased samples', async () => {
  const state = createForwardObserverRuntimeState(SHA, new Date(T0));
  const result = await runForwardRecommendationObserverCycle({
    state,
    researchCodeSha: SHA,
    dependencies: {
      scanLane: async (lane) => {
        const clean = response(lane, lane.id === 'KR_SWING_60M' ? [card()] : []);
        if (lane.id !== 'KR_SWING_60M') return clean;
        return {
          ...clean,
          dataState: 'partial',
          failures: [{ symbol: '*', reason: 'provider_error', message: 'provider failed mid-scan' }],
          execution: { ...clean.execution, partial: true, providerErrorCount: 1 },
          universe: { ...clean.universe, partial: true },
        };
      },
      loadFutureBars: async () => [],
      now: () => new Date(T0 + 60_000),
    },
  });
  assert.equal(result.summary.counts.total, 0);
  assert.equal(result.state.cursors.KR_SWING_60M, 0);
  const kr = result.summary.lanes.find((lane) => lane.laneId === 'KR_SWING_60M');
  assert.equal(kr?.blockers.SCANNER_PARTIAL_RESULT, 1);
  assert.equal(kr?.blockers.SCANNER_PROVIDER_ERROR, 1);
  assert.equal(kr?.blockers.SCANNER_UNIVERSE_PARTIAL, 1);
});

test('missing matched evidence timestamps are blocked instead of fabricated from now signal time fake samples or backfill', async () => {
  const missing = { ...card(), signalId: 'missing-evidence', evidence: [] } as PaperCandidateCard;
  assert.ok(missing.paperCandidate);
  missing.paperCandidate.signal.signalId = 'missing-evidence';
  if (missing.paperCandidate.paperIdentity) missing.paperCandidate.paperIdentity.signalId = 'missing-evidence';
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
  assert.equal(kr?.blockers.DATA_TIMESTAMP_FROM_MATCHED_EVIDENCE_REQUIRED, 1);
});
