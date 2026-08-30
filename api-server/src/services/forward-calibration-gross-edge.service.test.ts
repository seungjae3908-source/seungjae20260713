import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScannerSignalCard } from './scanner-signal.types';
import {
  buildForwardCalibrationGrossEdgeEvidence,
} from './forward-calibration-gross-edge.service';
import {
  advanceForwardRecommendationObservation,
  buildForwardObservationProfitCalibration,
  prepareForwardRecommendationObservation,
  type ForwardObservationIdentity,
  type ForwardObservationProfitCalibration,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';

const T0 = Date.parse('2026-08-26T00:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const RESEARCH_SHA = 'a'.repeat(40);

const IDENTITY: ForwardObservationIdentity = Object.freeze({
  strategyId: 'CRYPTO_FUTURES_SWING_V1',
  strategyVersion: 'signal-profile-v1',
  parameterHash: 'params-v1',
  researchCodeSha: RESEARCH_SHA,
  market: 'CRYPTO_FUTURES',
  symbol: 'BTCUSDT',
  timeframe: '60m',
  horizon: 4,
  direction: 'LONG',
});

function card(signalId: string): ScannerSignalCard {
  return {
    signalId,
    assetClass: 'coin_futures',
    market: 'CRYPTO_FUTURES',
    exchange: 'bitget',
    symbol: 'BTCUSDT',
    name: 'Bitcoin perpetual',
    currency: 'USDT',
    assetType: 'crypto',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    action: 'LONG',
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
      entryZone: { from: 99.5, to: 100.5 },
      invalidation: 99,
      stopLoss: 99,
      targets: [102, 104],
      riskReward: 2,
    },
    dataState: 'complete',
    dataSources: ['bitget-public'],
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

function prepared(signalId: string): ForwardRecommendationObservation {
  const decision = prepareForwardRecommendationObservation({
    card: card(signalId),
    strategyIdentity: IDENTITY,
    dataTimestamp: iso(0),
    dataMaxAgeMs: 60_000,
    publicDataOnly: true,
  });
  assert.equal(decision.status, 'OBSERVATION_READY');
  assert.ok(decision.observation);
  return decision.observation;
}

function barAt(hours: number, high: number, low: number, close: number) {
  return { timestamp: iso(hours * 60 * 60 * 1000), high, low, close };
}

function settle(kind: 'TP' | 'SL' | 'EXPIRE', signalId: string): ForwardRecommendationObservation {
  const observation = prepared(signalId);
  const outcomeInput = kind === 'TP'
    ? { bars: [barAt(1, 102.5, 99.5, 102)], evaluatedAt: iso(60 * 60 * 1000), evidenceCompleteThrough: iso(60 * 60 * 1000) }
    : kind === 'SL'
      ? { bars: [barAt(1, 100.5, 98.5, 99)], evaluatedAt: iso(60 * 60 * 1000), evidenceCompleteThrough: iso(60 * 60 * 1000) }
      : { bars: [barAt(4, 101, 99.5, 100.1)], evaluatedAt: iso(4 * 60 * 60 * 1000), evidenceCompleteThrough: iso(4 * 60 * 60 * 1000) };
  const advanced = advanceForwardRecommendationObservation({ observation, ...outcomeInput });
  assert.equal(advanced.status, 'SETTLED');
  return advanced.observation;
}

function observations(tp = 18, sl = 8, expire = 4): ForwardRecommendationObservation[] {
  return [
    ...Array.from({ length: tp }, (_, index) => settle('TP', `tp-${index}`)),
    ...Array.from({ length: sl }, (_, index) => settle('SL', `sl-${index}`)),
    ...Array.from({ length: expire }, (_, index) => settle('EXPIRE', `expire-${index}`)),
  ];
}

function evidenceFrom(
  rows: readonly ForwardRecommendationObservation[],
  calibration: ForwardObservationProfitCalibration = buildForwardObservationProfitCalibration(rows),
  asOf = iso(6 * 60 * 60 * 1000),
) {
  return buildForwardCalibrationGrossEdgeEvidence({ observations: rows, calibration, asOf });
}

function mutateCalibration(
  calibration: ForwardObservationProfitCalibration,
  overrides: Partial<ForwardObservationProfitCalibration>,
): ForwardObservationProfitCalibration {
  return Object.freeze({ ...calibration, ...overrides });
}

test('rebuilds the canonical 30-observation TP/SL/EXPIRE distribution before producing gross edge', () => {
  const rows = observations();
  const calibration = buildForwardObservationProfitCalibration(rows);
  const result = evidenceFrom(rows, calibration);

  assert.equal(calibration.status, 'READY');
  assert.deepEqual(calibration.counts, { tp: 18, sl: 8, expire: 4, conservativeConflicts: 0 });
  assert.equal(result.schemaVersion, 'forward-calibration-gross-edge-v2');
  assert.equal(result.status, 'READY');
  assert.equal(result.sampleSize, 30);
  assert.deepEqual(result.counts, calibration.counts);
  assert.deepEqual(result.probabilities, calibration.probabilities);
  assert.deepEqual(result.returns, calibration.returns);
  assert.equal(result.expectedGrossEdgeBps, 94.666667);
  assert.equal(result.observationProvenance?.observationCount, 30);
  assert.equal(result.observationProvenance?.observationIds.length, 30);
  assert.equal(result.observationProvenance?.strategyHorizon, 'SWING');
  assert.deepEqual(result.observationProvenance?.dataSources, ['bitget-public']);
  assert.equal(result.netAlphaInput.expectedGrossEdgeBps, 94.666667);
  assert.equal(result.netAlphaInput.evidenceReady, true);
  assert.equal(result.netAlphaInput.market, 'CRYPTO_FUTURES');
  assert.equal(result.costAdjusted, false);
  assert.equal(result.conformalLowerEdgeBps, null);
  assert.equal(result.netAlphaInput.costPolicyVersion, null);
  assert.equal(result.netAlphaInput.costs, null);
  assert.equal(result.netAlphaReady, false);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.observationProvenance), true);
});

test('N=0 and N<30 never fabricate probabilities, edge, uncertainty, costs or readiness', () => {
  for (const rows of [[], observations(10, 10, 9)]) {
    const calibration = buildForwardObservationProfitCalibration(rows);
    const result = evidenceFrom(rows, calibration);
    assert.equal(result.status, 'NOT_AVAILABLE');
    assert.equal(result.expectedGrossEdgeBps, null);
    assert.equal(result.probabilities, null);
    assert.equal(result.returns, null);
    assert.equal(result.observationProvenance, null);
    assert.equal(result.conformalLowerEdgeBps, null);
    assert.equal(result.netAlphaInput.costPolicyVersion, null);
    assert.equal(result.netAlphaInput.costs, null);
    assert.equal(result.netAlphaReady, false);
    assert.equal(result.profitabilityClaimAllowed, false);
    assert.equal(result.netAlphaInput.evidenceReady, false);
  }
});

test('rejects duplicate settled observations even when aggregate counts still look valid', () => {
  const original = observations();
  const duplicated = [...original];
  duplicated[1] = duplicated[0]!;
  const supplied = buildForwardObservationProfitCalibration(original);
  const result = evidenceFrom(duplicated, supplied);

  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.expectedGrossEdgeBps, null);
  assert.ok(result.reasons.includes('FORWARD_OBSERVATION_DUPLICATE'));
});

test('rejects probability/count drift even when probabilities still sum to one', () => {
  const rows = observations();
  const canonical = buildForwardObservationProfitCalibration(rows);
  const corrupted = mutateCalibration(canonical, {
    probabilities: Object.freeze({ tp: 0.5, sl: 0.3, expire: 0.2 }),
  });
  const result = evidenceFrom(rows, corrupted);

  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.expectedGrossEdgeBps, null);
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_PROBABILITY_COUNT_MISMATCH'));
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_REBUILT_PROBABILITY_MISMATCH'));
});

test('rejects declared count/sample and TP-count mismatches rather than normalizing them', () => {
  const rows = observations();
  const canonical = buildForwardObservationProfitCalibration(rows);
  const corrupted = mutateCalibration(canonical, {
    calibration: Object.freeze({ status: 'READY', sampleSize: 30, tpFirstCount: 17 }),
    counts: Object.freeze({ tp: 18, sl: 8, expire: 3, conservativeConflicts: 0 }),
  });
  const result = evidenceFrom(rows, corrupted);

  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_COUNT_MISMATCH'));
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_TP_COUNT_MISMATCH'));
  assert.equal(result.expectedGrossEdgeBps, null);
});

test('rejects aggregate payoff drift and non-finite gross-edge inputs', () => {
  const rows = observations();
  const canonical = buildForwardObservationProfitCalibration(rows);
  const payoffDrift = mutateCalibration(canonical, {
    returns: Object.freeze({ ...canonical.returns, expire: 0.5 }),
  });
  const driftResult = evidenceFrom(rows, payoffDrift);
  assert.equal(driftResult.status, 'NOT_AVAILABLE');
  assert.ok(driftResult.reasons.includes('FORWARD_CALIBRATION_REBUILT_PAYOFF_MISMATCH'));

  const nonFinite = mutateCalibration(canonical, {
    returns: Object.freeze({ target: Number.POSITIVE_INFINITY, stop: -0.01, expire: 0 }),
  });
  const nonFiniteResult = evidenceFrom(rows, nonFinite);
  assert.equal(nonFiniteResult.status, 'NOT_AVAILABLE');
  assert.equal(nonFiniteResult.expectedGrossEdgeBps, null);
  assert.doesNotThrow(() => JSON.stringify(nonFiniteResult));
});

test('rejects future or malformed settled timestamp provenance', () => {
  const rows = observations();
  const calibration = buildForwardObservationProfitCalibration(rows);
  const future = evidenceFrom(rows, calibration, iso(30 * 60 * 1000));
  assert.equal(future.status, 'NOT_AVAILABLE');
  assert.ok(future.reasons.includes('FORWARD_OBSERVATION_FUTURE_TIMESTAMP'));

  const malformedRows = [...rows];
  malformedRows[0] = Object.freeze({ ...malformedRows[0]!, settledAt: 'not-a-time' });
  const malformed = evidenceFrom(malformedRows, calibration);
  assert.equal(malformed.status, 'NOT_AVAILABLE');
  assert.ok(malformed.reasons.includes('FORWARD_OBSERVATION_TIMESTAMP_INVALID'));
});

test('rejects stale source data and strategy lineage drift instead of treating them as current evidence', () => {
  const rows = observations();
  const calibration = buildForwardObservationProfitCalibration(rows);
  const staleRows = [...rows];
  const staleDataTimestamp = iso(-2 * 60_000);
  staleRows[0] = Object.freeze({
    ...staleRows[0]!,
    dataTimestamp: staleDataTimestamp,
    dataMaxAgeMs: 60_000,
    snapshot: Object.freeze({ ...staleRows[0]!.snapshot, dataTimestamp: staleDataTimestamp }),
  });
  const stale = evidenceFrom(staleRows, calibration);
  assert.equal(stale.status, 'NOT_AVAILABLE');
  assert.ok(stale.reasons.includes('FORWARD_OBSERVATION_SOURCE_DATA_STALE'));

  const mixedRows = [...rows];
  mixedRows[0] = Object.freeze({
    ...mixedRows[0]!,
    identity: Object.freeze({ ...mixedRows[0]!.identity, parameterHash: 'other-params' }),
  });
  const mixed = evidenceFrom(mixedRows, calibration);
  assert.equal(mixed.status, 'NOT_AVAILABLE');
  assert.ok(mixed.reasons.includes('FORWARD_OBSERVATION_IDENTITY_MISMATCH'));
});

test('rejects long-only market SELL identity and any fabricated authority/cost-adjusted flag', () => {
  const rows = observations();
  const canonical = buildForwardObservationProfitCalibration(rows);
  const invalidIdentity = mutateCalibration(canonical, {
    identity: Object.freeze({ ...canonical.identity!, market: 'CRYPTO_SPOT', direction: 'SELL' }),
  });
  const invalidIdentityResult = evidenceFrom(rows, invalidIdentity);
  assert.equal(invalidIdentityResult.status, 'NOT_AVAILABLE');
  assert.ok(invalidIdentityResult.reasons.includes('FORWARD_CALIBRATION_IDENTITY_INVALID'));

  const unsafe = Object.freeze({
    ...canonical,
    costAdjusted: true,
    profitabilityClaimAllowed: true,
  }) as unknown as ForwardObservationProfitCalibration;
  const unsafeResult = evidenceFrom(rows, unsafe);
  assert.equal(unsafeResult.status, 'NOT_AVAILABLE');
  assert.ok(unsafeResult.reasons.includes('FORWARD_CALIBRATION_AUTHORITY_INVALID'));
  assert.equal(unsafeResult.netAlphaInput.costs, null);
  assert.equal(unsafeResult.costAdjusted, false);
  assert.equal(unsafeResult.netAlphaReady, false);
  assert.equal(unsafeResult.profitabilityClaimAllowed, false);
});

test('invalid calculation timestamp never fabricates a replacement timestamp or gross edge', () => {
  const rows = observations();
  const result = evidenceFrom(rows, buildForwardObservationProfitCalibration(rows), 'not-a-time');

  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.asOf, null);
  assert.equal(result.asOfMs, null);
  assert.equal(result.expectedGrossEdgeBps, null);
  assert.equal(result.netAlphaInput.asOf, null);
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_AS_OF_INVALID'));
});

test('malformed aggregate structure fails closed without fabricating measured sample zero', () => {
  const rows = observations();
  const canonical = buildForwardObservationProfitCalibration(rows);
  const malformed = [
    { ...canonical, calibration: undefined },
    { ...canonical, counts: undefined },
    { ...canonical, probabilities: undefined },
    { ...canonical, returns: undefined },
  ];

  for (const value of malformed) {
    let result: ReturnType<typeof buildForwardCalibrationGrossEdgeEvidence> | null = null;
    assert.doesNotThrow(() => {
      result = buildForwardCalibrationGrossEdgeEvidence({
        observations: rows,
        calibration: value as unknown as ForwardObservationProfitCalibration,
        asOf: iso(6 * 60 * 60 * 1000),
      });
    });
    assert.ok(result);
    assert.equal(result.status, 'NOT_AVAILABLE');
    assert.equal(result.sampleSize, null);
    assert.equal(result.expectedGrossEdgeBps, null);
    assert.equal(result.netAlphaInput.evidenceReady, false);
    assert.ok(result.reasons.includes('FORWARD_CALIBRATION_STRUCTURE_INVALID'));
    assert.equal(result.executionAuthority, 'NONE');
    assert.equal(result.costAdjusted, false);
    assert.equal(result.profitabilityClaimAllowed, false);
  }
});

test('explicit measured N=0 remains zero while missing sample size remains unavailable', () => {
  const measuredZero = evidenceFrom([], buildForwardObservationProfitCalibration([]));
  assert.equal(measuredZero.status, 'NOT_AVAILABLE');
  assert.equal(measuredZero.sampleSize, 0);

  const rows = observations();
  const canonical = buildForwardObservationProfitCalibration(rows);
  const missingSample = Object.freeze({
    ...canonical,
    calibration: Object.freeze({ status: 'READY', tpFirstCount: canonical.calibration.tpFirstCount }),
  }) as unknown as ForwardObservationProfitCalibration;
  const result = buildForwardCalibrationGrossEdgeEvidence({
    observations: rows,
    calibration: missingSample,
    asOf: iso(6 * 60 * 60 * 1000),
  });
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.sampleSize, null);
  assert.ok(result.reasons.includes('FORWARD_CALIBRATION_SAMPLE_SIZE_INVALID_OR_MISSING'));
  assert.equal(result.expectedGrossEdgeBps, null);
});

test('malformed observation identity or snapshot fails closed instead of throwing', () => {
  const rows = observations();
  const calibration = buildForwardObservationProfitCalibration(rows);
  const malformedIdentity = [...rows];
  malformedIdentity[0] = Object.freeze({ ...malformedIdentity[0]!, identity: {} }) as unknown as ForwardRecommendationObservation;
  const malformedSnapshot = [...rows];
  malformedSnapshot[0] = Object.freeze({ ...malformedSnapshot[0]!, snapshot: undefined }) as unknown as ForwardRecommendationObservation;

  for (const malformedRows of [malformedIdentity, malformedSnapshot]) {
    let result: ReturnType<typeof buildForwardCalibrationGrossEdgeEvidence> | null = null;
    assert.doesNotThrow(() => {
      result = buildForwardCalibrationGrossEdgeEvidence({
        observations: malformedRows,
        calibration,
        asOf: iso(6 * 60 * 60 * 1000),
      });
    });
    assert.ok(result);
    assert.equal(result.status, 'NOT_AVAILABLE');
    assert.equal(result.sampleSize, 30);
    assert.ok(result.reasons.includes('FORWARD_OBSERVATION_STRUCTURE_INVALID'));
    assert.equal(result.expectedGrossEdgeBps, null);
    assert.equal(result.netAlphaInput.evidenceReady, false);
    assert.equal(result.executionAuthority, 'NONE');
  }
});
