import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScannerSignalCard } from './scanner-signal.types';
import {
  advanceForwardRecommendationObservation,
  buildForwardObservationProfitCalibration,
  prepareForwardRecommendationObservation,
  type ForwardObservationIdentity,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';

const T0 = Date.parse('2026-08-16T00:00:00.000Z');
const RESEARCH_SHA = 'a'.repeat(40);
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const CANONICAL_IDENTITY: ForwardObservationIdentity = Object.freeze({
  strategyId: 'profit-first-swing',
  strategyVersion: 'signal-profile-v1',
  parameterHash: 'scanner-params-v1',
  researchCodeSha: RESEARCH_SHA,
  market: 'CRYPTO_SPOT',
  symbol: 'BTC',
  timeframe: '4H',
  horizon: 4,
  direction: 'BUY',
});

function card(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return {
    signalId: 'forward-observation-1',
    assetClass: 'coin_spot',
    market: 'CRYPTO_SPOT',
    exchange: 'upbit',
    symbol: 'BTC',
    name: 'Bitcoin',
    currency: 'KRW',
    assetType: 'crypto',
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
    evidence: [],
    pricePlan: {
      entryZone: { from: 99, to: 101 },
      invalidation: 95,
      stopLoss: 95,
      targets: [105, 110],
      riskReward: 1.5,
    },
    dataState: 'complete',
    dataSources: ['upbit-public'],
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
    ...overrides,
  };
}

function prepareInput(
  selectedCard: ScannerSignalCard,
  identityOverrides: Partial<ForwardObservationIdentity> = {},
  inputOverrides: Partial<Parameters<typeof prepareForwardRecommendationObservation>[0]> = {},
): Parameters<typeof prepareForwardRecommendationObservation>[0] {
  return {
    card: selectedCard,
    strategyIdentity: { ...CANONICAL_IDENTITY, ...identityOverrides },
    dataTimestamp: iso(0),
    dataMaxAgeMs: 60_000,
    publicDataOnly: true,
    ...inputOverrides,
  };
}

function prepared(
  id = 'forward-observation-1',
  identityOverrides: Partial<ForwardObservationIdentity> = {},
): ForwardRecommendationObservation {
  const result = prepareForwardRecommendationObservation(prepareInput(card({ signalId: id }), identityOverrides));
  assert.equal(result.status, 'OBSERVATION_READY');
  assert.ok(result.observation);
  return result.observation;
}

function barAt(hours: number, high: number, low: number, close: number) {
  return { timestamp: iso(hours * 60 * 60 * 1000), high, low, close };
}

function settle(
  kind: 'WIN' | 'LOSS' | 'EXPIRED',
  id: string,
  identityOverrides: Partial<ForwardObservationIdentity> = {},
): ForwardRecommendationObservation {
  const observation = prepared(id, identityOverrides);
  const input = kind === 'WIN'
    ? { bars: [barAt(1, 106, 99, 105)], evaluatedAt: iso(60 * 60 * 1000), evidenceCompleteThrough: iso(60 * 60 * 1000) }
    : kind === 'LOSS'
      ? { bars: [barAt(1, 101, 94, 95)], evaluatedAt: iso(60 * 60 * 1000), evidenceCompleteThrough: iso(60 * 60 * 1000) }
      : { bars: [barAt(4, 102, 98, 100)], evaluatedAt: iso(4 * 60 * 60 * 1000), evidenceCompleteThrough: iso(4 * 60 * 60 * 1000) };
  const advanced = advanceForwardRecommendationObservation({ observation, ...input });
  assert.equal(advanced.status, 'SETTLED');
  return advanced.observation;
}

test('only active S/A trusted public signals preserve the exact canonical strategy identity', () => {
  const ready = prepareForwardRecommendationObservation(prepareInput(card()));
  assert.equal(ready.status, 'OBSERVATION_READY');
  assert.deepEqual(ready.observation?.identity, CANONICAL_IDENTITY);
  assert.equal(ready.observation?.snapshot.strategyProfileVersion, CANONICAL_IDENTITY.strategyVersion);
  assert.equal(ready.observation?.snapshot.timeframes[0], CANONICAL_IDENTITY.timeframe);
  assert.equal(ready.observation?.snapshot.strategyHorizon, 'SWING');
  assert.equal(ready.observation?.schemaVersion, 'forward-recommendation-observation-v2');
  assert.equal(ready.observation?.financialMutationAllowed, false);
  assert.equal(ready.observation?.liveOrderAllowed, false);
  assert.equal(ready.observation?.privateTradingApiAllowed, false);
  assert.equal(ready.observation?.profitabilityClaimAllowed, false);
  assert.equal('strategyProfileVersion' in (ready.observation?.identity ?? {}), false);

  const watch = prepareForwardRecommendationObservation(prepareInput(card({ signalGrade: 'B' })));
  assert.equal(watch.status, 'NO_TRADE');
  assert.equal(watch.observation, null);
});

test('missing or mismatched exact identity fields fail closed before observation creation', () => {
  const cases: Array<[string, Partial<ForwardObservationIdentity>, string]> = [
    ['strategy id', { strategyId: '' }, 'STRATEGY_ID_REQUIRED'],
    ['strategy version', { strategyVersion: '' }, 'STRATEGY_VERSION_REQUIRED'],
    ['parameter hash', { parameterHash: '' }, 'PARAMETER_HASH_REQUIRED'],
    ['research sha', { researchCodeSha: 'main' }, 'IMMUTABLE_RESEARCH_SHA_REQUIRED'],
    ['market', { market: 'US_STOCK' }, 'MARKET_MISMATCH'],
    ['symbol', { symbol: 'ETH' }, 'SYMBOL_MISMATCH'],
    ['timeframe', { timeframe: '' }, 'TIMEFRAME_REQUIRED'],
    ['horizon', { horizon: 0 }, 'CANONICAL_HORIZON_REQUIRED'],
    ['direction', { direction: 'SELL' }, 'DIRECTION_MISMATCH'],
  ];
  for (const [label, overrides, blocker] of cases) {
    const result = prepareForwardRecommendationObservation(prepareInput(card(), overrides));
    assert.equal(result.status, 'BLOCKED', label);
    assert.ok(result.blockers.includes(blocker), `${label}:${blocker}`);
  }
});

test('private authority, stale or lookahead data fail closed and no synthetic fallback is created', () => {
  const privateData = prepareForwardRecommendationObservation(prepareInput(card(), {}, { publicDataOnly: false }));
  assert.equal(privateData.status, 'BLOCKED');
  assert.ok(privateData.blockers.includes('PUBLIC_DATA_AUTHORITY_REQUIRED'));

  const stale = prepareForwardRecommendationObservation(prepareInput(card({
    observedAt: iso(2 * 60 * 1000),
    expiresAt: iso(4 * 60 * 60 * 1000),
  }), {}, {
    dataTimestamp: iso(0),
    dataMaxAgeMs: 60_000,
  }));
  assert.equal(stale.status, 'BLOCKED');
  assert.ok(stale.blockers.includes('DATA_EVIDENCE_STALE'));

  const lookahead = prepareForwardRecommendationObservation(prepareInput(card(), {}, { dataTimestamp: iso(60_000) }));
  assert.equal(lookahead.status, 'BLOCKED');
  assert.ok(lookahead.blockers.includes('LOOKAHEAD_DATA_TIMESTAMP'));
});

test('future recommendation outcomes remain pending until decisive future evidence or complete expiry evidence exists', () => {
  const observation = prepared();
  const pending = advanceForwardRecommendationObservation({
    observation,
    bars: [barAt(1, 102, 98, 101)],
    evaluatedAt: iso(60 * 60 * 1000),
    evidenceCompleteThrough: iso(60 * 60 * 1000),
  });
  assert.equal(pending.status, 'PENDING');

  const incompleteExpiry = advanceForwardRecommendationObservation({
    observation,
    bars: [barAt(4, 102, 98, 100)],
    evaluatedAt: iso(4 * 60 * 60 * 1000),
    evidenceCompleteThrough: iso(3 * 60 * 60 * 1000),
  });
  assert.equal(incompleteExpiry.status, 'PENDING');
  assert.ok(incompleteExpiry.blockers.includes('FUTURE_EVIDENCE_INCOMPLETE'));

  const expired = advanceForwardRecommendationObservation({
    observation,
    bars: [barAt(4, 102, 98, 100)],
    evaluatedAt: iso(4 * 60 * 60 * 1000),
    evidenceCompleteThrough: iso(4 * 60 * 60 * 1000),
  });
  assert.equal(expired.status, 'SETTLED');
  assert.equal(expired.observation.outcome?.outcome, 'EXPIRED');
});

test('same-bar target and stop conflict settles conservatively as LOSS', () => {
  const advanced = advanceForwardRecommendationObservation({
    observation: prepared(),
    bars: [barAt(1, 106, 94, 100)],
    evaluatedAt: iso(60 * 60 * 1000),
    evidenceCompleteThrough: iso(60 * 60 * 1000),
  });
  assert.equal(advanced.status, 'SETTLED');
  assert.equal(advanced.observation.outcome?.outcome, 'LOSS');
  assert.equal(advanced.observation.outcome?.conservativeIntrabarConflict, true);
});

test('forward calibration stays insufficient below 30 and READY requires TP SL and Expire classes', () => {
  const below = [
    ...Array.from({ length: 10 }, (_, index) => settle('WIN', `below-win-${index}`)),
    ...Array.from({ length: 10 }, (_, index) => settle('LOSS', `below-loss-${index}`)),
    ...Array.from({ length: 9 }, (_, index) => settle('EXPIRED', `below-expire-${index}`)),
  ];
  const insufficient = buildForwardObservationProfitCalibration(below);
  assert.equal(insufficient.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(insufficient.calibration.sampleSize, 29);

  const ready = buildForwardObservationProfitCalibration([...below, settle('EXPIRED', 'ready-expire-10')]);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.calibration.sampleSize, 30);
  assert.equal(ready.counts.tp, 10);
  assert.equal(ready.counts.sl, 10);
  assert.equal(ready.counts.expire, 10);
  assert.equal(ready.costAdjusted, false);
  assert.equal(ready.profitabilityClaimAllowed, false);
});

test('calibration forbids mixing different canonical strategy identities', () => {
  for (const [label, overrides] of [
    ['strategyId', { strategyId: 'other-strategy' }],
    ['strategyVersion', { strategyVersion: 'v2' }],
    ['parameterHash', { parameterHash: 'other-params' }],
    ['researchCodeSha', { researchCodeSha: 'b'.repeat(40) }],
    ['horizon', { horizon: 8 }],
  ] as Array<[string, Partial<ForwardObservationIdentity>]>) {
    const mixed = [settle('WIN', `${label}-a`), settle('LOSS', `${label}-b`, overrides)];
    assert.throws(
      () => buildForwardObservationProfitCalibration(mixed, 1),
      /FORWARD_OBSERVATION_IDENTITY_MIXING_FORBIDDEN/u,
      label,
    );
  }
});
