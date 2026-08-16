import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScannerSignalCard } from './scanner-signal.types';
import {
  advanceForwardRecommendationObservation,
  buildForwardObservationProfitCalibration,
  prepareForwardRecommendationObservation,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';

const T0 = Date.parse('2026-08-16T00:00:00.000Z');
const RESEARCH_SHA = 'a'.repeat(40);
const PARAMETER_HASH = 'scanner-params-v1';
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

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
  overrides: Partial<Parameters<typeof prepareForwardRecommendationObservation>[0]> = {},
): Parameters<typeof prepareForwardRecommendationObservation>[0] {
  return {
    card: selectedCard,
    timeframe: '4H',
    strategyProfileVersion: 'scanner-swing-v1',
    parameterHash: PARAMETER_HASH,
    researchCodeSha: RESEARCH_SHA,
    dataTimestamp: iso(0),
    dataMaxAgeMs: 60_000,
    publicDataOnly: true,
    ...overrides,
  };
}

function prepared(
  id = 'forward-observation-1',
  identityOverrides: Partial<Parameters<typeof prepareForwardRecommendationObservation>[0]> = {},
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
  identityOverrides: Partial<Parameters<typeof prepareForwardRecommendationObservation>[0]> = {},
): ForwardRecommendationObservation {
  const observation = prepared(id, identityOverrides);
  const input = kind === 'WIN'
    ? { bars: [barAt(1, 106, 99, 105)], evaluatedAt: iso(60 * 60 * 1000), evidenceCompleteThrough: iso(60 * 60 * 1000) }
    : kind === 'LOSS'
      ? { bars: [barAt(1, 101, 94, 95)], evaluatedAt: iso(60 * 60 * 1000), evidenceCompleteThrough: iso(60 * 60 * 1000) }
      : { bars: [barAt(4, 102, 98, 100)], evaluatedAt: iso(4 * 60 * 60 * 1000), evidenceCompleteThrough: iso(4 * 60 * 60 * 1000) };
  const advanced = advanceForwardRecommendationObservation({ observation, ...input });
  assert.equal(advanced.status, 'SETTLED');
  assert.ok(advanced.observation.outcome);
  return advanced.observation;
}

test('only active S/A trusted strong public signals become non-financial forward observations', () => {
  const ready = prepareForwardRecommendationObservation(prepareInput(card()));
  assert.equal(ready.status, 'OBSERVATION_READY');
  assert.equal(ready.observation?.source, 'LIVE_RECOMMENDATION');
  assert.equal(ready.observation?.status, 'PENDING');
  assert.equal(ready.observation?.publicDataOnly, true);
  assert.equal(ready.observation?.identity.parameterHash, PARAMETER_HASH);
  assert.equal(ready.observation?.identity.researchCodeSha, RESEARCH_SHA);
  assert.equal(ready.observation?.financialMutationAllowed, false);
  assert.equal(ready.observation?.liveOrderAllowed, false);
  assert.equal(ready.observation?.privateTradingApiAllowed, false);
  assert.equal(ready.observation?.orderSubmitted, false);
  assert.equal(ready.observation?.snapshot.executionAuthority, 'NONE');

  const watch = prepareForwardRecommendationObservation(prepareInput(card({ signalGrade: 'B' })));
  assert.equal(watch.status, 'NO_TRADE');
  assert.equal(watch.observation, null);

  const untrusted = prepareForwardRecommendationObservation(prepareInput(card({ dataState: 'untrusted' })));
  assert.equal(untrusted.status, 'BLOCKED');
  assert.ok(untrusted.blockers.includes('DATA_STATE_NOT_COMPLETE'));
});

test('private authority, stale data and incomplete immutable lineage fail closed before observation creation', () => {
  const privateData = prepareForwardRecommendationObservation(prepareInput(card(), { publicDataOnly: false }));
  assert.equal(privateData.status, 'BLOCKED');
  assert.ok(privateData.blockers.includes('PUBLIC_DATA_AUTHORITY_REQUIRED'));

  const stale = prepareForwardRecommendationObservation(prepareInput(card({
    observedAt: iso(2 * 60 * 1000),
    expiresAt: iso(4 * 60 * 60 * 1000),
  }), {
    dataTimestamp: iso(0),
    dataMaxAgeMs: 60_000,
  }));
  assert.equal(stale.status, 'BLOCKED');
  assert.ok(stale.blockers.includes('DATA_EVIDENCE_STALE'));

  const missingParameter = prepareForwardRecommendationObservation(prepareInput(card(), { parameterHash: '' }));
  assert.equal(missingParameter.status, 'BLOCKED');
  assert.ok(missingParameter.blockers.includes('PARAMETER_HASH_REQUIRED'));

  const mutableResearchRef = prepareForwardRecommendationObservation(prepareInput(card(), { researchCodeSha: 'main' }));
  assert.equal(mutableResearchRef.status, 'BLOCKED');
  assert.ok(mutableResearchRef.blockers.includes('IMMUTABLE_RESEARCH_SHA_REQUIRED'));
});

test('future recommendation outcomes remain pending until a decisive barrier or complete expiry evidence exists', () => {
  const observation = prepared();
  const pending = advanceForwardRecommendationObservation({
    observation,
    bars: [barAt(1, 102, 98, 101)],
    evaluatedAt: iso(60 * 60 * 1000),
    evidenceCompleteThrough: iso(60 * 60 * 1000),
  });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.observation.outcome, null);

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

test('same-bar target and stop conflict settles conservatively as LOSS through canonical evaluator', () => {
  const observation = prepared();
  const advanced = advanceForwardRecommendationObservation({
    observation,
    bars: [barAt(1, 106, 94, 100)],
    evaluatedAt: iso(60 * 60 * 1000),
    evidenceCompleteThrough: iso(60 * 60 * 1000),
  });
  assert.equal(advanced.status, 'SETTLED');
  assert.equal(advanced.observation.outcome?.outcome, 'LOSS');
  assert.equal(advanced.observation.outcome?.conservativeIntrabarConflict, true);
  assert.equal(advanced.observation.outcome?.stopLossHit, true);
});

test('forward calibration stays insufficient below 30 and becomes READY only from real TP/SL/Expire classes', () => {
  const below = [
    ...Array.from({ length: 10 }, (_, index) => settle('WIN', `below-win-${index}`)),
    ...Array.from({ length: 10 }, (_, index) => settle('LOSS', `below-loss-${index}`)),
    ...Array.from({ length: 9 }, (_, index) => settle('EXPIRED', `below-expire-${index}`)),
  ];
  const insufficient = buildForwardObservationProfitCalibration(below);
  assert.equal(insufficient.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(insufficient.calibration.sampleSize, 29);
  assert.deepEqual(insufficient.probabilities, { tp: null, sl: null, expire: null });

  const ready = buildForwardObservationProfitCalibration([
    ...below,
    settle('EXPIRED', 'ready-expire-10'),
  ]);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.calibration.sampleSize, 30);
  assert.equal(ready.calibration.tpFirstCount, 10);
  assert.equal(ready.counts.tp, 10);
  assert.equal(ready.counts.sl, 10);
  assert.equal(ready.counts.expire, 10);
  assert.equal(ready.probabilities.tp, 1 / 3);
  assert.equal(ready.probabilities.sl, 1 / 3);
  assert.equal(ready.probabilities.expire, 1 / 3);
  assert.ok(ready.returns.target != null && Math.abs(ready.returns.target - 0.05) < 1e-12);
  assert.ok(ready.returns.stop != null && Math.abs(ready.returns.stop + 0.05) < 1e-12);
  assert.equal(ready.returns.expire, 0);
  assert.equal(ready.costAdjusted, false);
  assert.equal(ready.profitabilityClaimAllowed, false);
});

test('calibration refuses parameter-hash and research-SHA identity mixing even under the same profile version', () => {
  const parameterMixed = [
    settle('WIN', 'mixed-param-win'),
    settle('LOSS', 'mixed-param-loss', { parameterHash: 'scanner-params-v2' }),
  ];
  assert.throws(
    () => buildForwardObservationProfitCalibration(parameterMixed, 1),
    /FORWARD_OBSERVATION_IDENTITY_MIXING_FORBIDDEN/u,
  );

  const researchMixed = [
    settle('WIN', 'mixed-sha-win'),
    settle('LOSS', 'mixed-sha-loss', { researchCodeSha: 'b'.repeat(40) }),
  ];
  assert.throws(
    () => buildForwardObservationProfitCalibration(researchMixed, 1),
    /FORWARD_OBSERVATION_IDENTITY_MIXING_FORBIDDEN/u,
  );
});
