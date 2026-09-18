import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScannerSignalCard } from './scanner-signal.types';
import {
  StrategyPromotionService,
  strategyCandidateId,
  type StrategyPromotionRecord,
} from './strategy-promotion.service';
import {
  advanceForwardRecommendationObservation,
  prepareForwardRecommendationObservation,
  type ForwardObservationIdentity,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';
import type { ForwardObserverRuntimeState } from './forward-recommendation-observer-runtime.service';
import {
  FAST_PROFITABILITY_ACTIVATION_SELECTION_RULE_V1,
  FAST_PROFITABILITY_COLLECTOR_CADENCE_MINUTES,
  buildFastProfitabilityActivationBundleV1,
  collectFastProfitabilityForwardEvidenceV1,
  verifyFastProfitabilityActivationBundleV1,
} from './fast-profitability-activation.service';

const SOURCE_SHA = 'a'.repeat(40);
const ACTIVATION_AT = Date.parse('2026-09-18T12:00:00.000Z');

function promotion(): StrategyPromotionRecord {
  const items = new StrategyPromotionService({ sourceSha: SOURCE_SHA })
    .list({ market: 'CRYPTO_FUTURES', strategyHorizon: 'SWING' }).items;
  const matches = items.filter((record) => record.identity.direction === 'LONG');
  assert.ok(matches.length >= 1, 'canonical futures LONG promotion fixture required');
  return matches[0]!;
}

function cardAt(
  record: StrategyPromotionRecord,
  signalId: string,
  observedAtMs: number,
  horizonHours = 8,
): ScannerSignalCard {
  return {
    signalId,
    assetClass: 'coin_futures',
    market: 'CRYPTO_FUTURES',
    exchange: 'bitget',
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    currency: 'USDT',
    assetType: 'crypto',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    action: 'LONG',
    signalState: 'CONFIRMED',
    score: 85,
    confidence: 80,
    dataCompleteness: 100,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 95,
    volume: 1_000,
    tradingValue: 100_000,
    spreadPercent: 0.05,
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
    dataSources: ['bitget-public-v2'],
    observedAt: new Date(observedAtMs).toISOString(),
    expiresAt: new Date(observedAtMs + horizonHours * 60 * 60_000).toISOString(),
    strongSignalEligible: true,
    warnings: [],
    strategyMode: 'swing',
    signalGrade: 'A',
    dataQuality: {
      state: 'TRUSTED',
      score: 100,
      strongSignalAllowed: true,
      issues: [],
    },
    quantScore: {
      technical: 80,
      trend: 85,
      momentum: 75,
      volume: 70,
      liquidity: 90,
      volatility: 65,
      marketRegime: 80,
      risk: 80,
    },
    aiValidation: {
      status: 'NOT_RUN',
      provider: null,
      counterEvidence: [],
      missingData: [],
      risks: [],
      explanation: null,
    },
    backtestQuality: {
      status: 'verified',
      regime: 'Bull',
      costsIncluded: true,
      slippageIncluded: true,
      lookaheadGuarded: true,
      survivorshipGuarded: true,
      oos: true,
      walkForward: true,
    },
  };
}

function observationAt(
  record: StrategyPromotionRecord,
  signalId: string,
  observedAtMs: number,
  horizon = 8,
): ForwardRecommendationObservation {
  const card = cardAt(record, signalId, observedAtMs, horizon);
  const identity: ForwardObservationIdentity = {
    strategyId: record.identity.strategyId,
    strategyVersion: record.identity.strategyVersion,
    parameterHash: record.identity.parameterHash,
    researchCodeSha: SOURCE_SHA,
    market: 'CRYPTO_FUTURES',
    symbol: card.symbol,
    timeframe: record.identity.timeframe,
    horizon,
    direction: 'LONG',
  };
  const decision = prepareForwardRecommendationObservation({
    card,
    strategyIdentity: identity,
    dataTimestamp: card.observedAt,
    dataMaxAgeMs: 60_000,
    publicDataOnly: true,
  });
  assert.equal(decision.status, 'OBSERVATION_READY');
  assert.ok(decision.observation);
  return decision.observation;
}

function observerState(observations: ForwardRecommendationObservation[]): ForwardObserverRuntimeState {
  return {
    schemaVersion: 1,
    researchCodeSha: SOURCE_SHA,
    createdAt: new Date(ACTIVATION_AT - 60_000).toISOString(),
    updatedAt: new Date(ACTIVATION_AT).toISOString(),
    cursors: {
      KR_SWING_60M: 0,
      US_SWING_60M: 0,
      SPOT_SWING_60M: 0,
      FUTURES_SWING_60M: 0,
    },
    observations,
    safety: {
      publicDataOnly: true,
      artifactOnly: true,
      executionAuthority: 'NONE',
      financialMutationAllowed: false,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      profitabilityClaimAllowed: false,
    },
  };
}

function approval() {
  return {
    issueNumber: 1102 as const,
    commentId: '5729990000',
    actor: 'seungjae3908-source',
    command: `/activate-fast-profitability-v1 ${SOURCE_SHA}`,
  };
}

function settleTp(observation: ForwardRecommendationObservation): ForwardRecommendationObservation {
  const signalAt = Date.parse(observation.snapshot.timestamp);
  const barAt = new Date(signalAt + 60 * 60_000).toISOString();
  const advanced = advanceForwardRecommendationObservation({
    observation,
    bars: [{ timestamp: barAt, high: 106, low: 99, close: 105 }],
    evaluatedAt: barAt,
    evidenceCompleteThrough: barAt,
  });
  assert.equal(advanced.status, 'SETTLED');
  return advanced.observation;
}

test('activation freezes the exact existing StrategyPromotion candidate without creating a second candidate identity', () => {
  const record = promotion();
  const pending = observationAt(record, 'activation-pending', ACTIVATION_AT - 5 * 60_000);
  const knownOutcomeSource = settleTp(
    observationAt(record, 'already-settled', ACTIVATION_AT - 6 * 60 * 60_000),
  );
  const bundle = buildFastProfitabilityActivationBundleV1({
    targetSha: SOURCE_SHA,
    observerState: observerState([knownOutcomeSource, pending]),
    frozenAtMs: ACTIVATION_AT,
    approval: approval(),
  });

  verifyFastProfitabilityActivationBundleV1(bundle);
  assert.equal(bundle.binding.status, 'ACTIVE_FUTURE_ONLY');
  assert.equal(bundle.binding.selectionRule, FAST_PROFITABILITY_ACTIVATION_SELECTION_RULE_V1);
  assert.equal(bundle.binding.collectorCadenceMinutes, FAST_PROFITABILITY_COLLECTOR_CADENCE_MINUTES);
  assert.equal(bundle.binding.sourceObservationId, pending.observationId);
  assert.equal(bundle.binding.candidateId, strategyCandidateId(record.identity));
  assert.equal(bundle.policy.candidate.candidateId, strategyCandidateId(record.identity));
  assert.equal(bundle.policy.candidate.strategyId, record.identity.strategyId);
  assert.equal(bundle.policy.candidate.strategyVersion, record.identity.strategyVersion);
  assert.equal(bundle.policy.candidate.parameterHash, record.identity.parameterHash);
  assert.equal(bundle.policy.candidate.riskPolicyRef, record.identity.riskPolicyVersion);
  assert.equal(bundle.policy.candidate.costPolicyRef, record.identity.costPolicyVersion);
  assert.equal(bundle.binding.eligibleAfterMs - bundle.binding.activationFrozenAtMs, 24 * 60 * 60_000);
  assert.equal(bundle.binding.safety.outcomeAwareSelectionAllowed, false);
  assert.equal(bundle.binding.safety.executionAuthority, 'NONE');
  assert.equal(bundle.binding.economicTruth.activationCreatesValidationCredit, 0);
  assert.equal(bundle.binding.economicTruth.activationCreatesOosCredit, 0);
  assert.equal(bundle.binding.economicTruth.activationCreatesProfitabilityCredit, 0);
});

test('activation rejects wrong commands, expired candidates, and non-current research identity', () => {
  const record = promotion();
  const pending = observationAt(record, 'activation-pending', ACTIVATION_AT - 5 * 60_000);

  assert.throws(
    () => buildFastProfitabilityActivationBundleV1({
      targetSha: SOURCE_SHA,
      observerState: observerState([pending]),
      frozenAtMs: ACTIVATION_AT,
      approval: { ...approval(), command: `/activate-fast-profitability-v1 ${'b'.repeat(40)}` },
    }),
    /FAST_PROFITABILITY_ACTIVATION_COMMAND_MISMATCH/,
  );

  const expired = observationAt(record, 'expired-before-activation', ACTIVATION_AT - 10 * 60 * 60_000, 1);
  assert.throws(
    () => buildFastProfitabilityActivationBundleV1({
      targetSha: SOURCE_SHA,
      observerState: observerState([expired]),
      frozenAtMs: ACTIVATION_AT,
      approval: approval(),
    }),
    /FAST_PROFITABILITY_ACTIVATION_PENDING_CANONICAL_CANDIDATE_MISSING/,
  );

  const wrongState = observerState([pending]);
  wrongState.researchCodeSha = 'b'.repeat(40);
  assert.throws(
    () => buildFastProfitabilityActivationBundleV1({
      targetSha: SOURCE_SHA,
      observerState: wrongState,
      frozenAtMs: ACTIVATION_AT,
      approval: approval(),
    }),
    /FAST_PROFITABILITY_ACTIVATION_FORWARD_STATE_INVALID/,
  );
});

test('collector never credits pre-boundary observations and stores only settled independent future representatives', async () => {
  const record = promotion();
  const activationPending = observationAt(record, 'activation-pending', ACTIVATION_AT - 5 * 60_000);
  const bundle = buildFastProfitabilityActivationBundleV1({
    targetSha: SOURCE_SHA,
    observerState: observerState([activationPending]),
    frozenAtMs: ACTIVATION_AT,
    approval: approval(),
  });

  const preBoundary = settleTp(
    observationAt(record, 'pre-boundary', bundle.binding.eligibleAfterMs - 60 * 60_000),
  );
  const futurePending = observationAt(
    record,
    'future-pending',
    bundle.binding.eligibleAfterMs + 60 * 60_000,
  );
  const futureSettled = settleTp(futurePending);

  const validation: unknown[] = [];
  const sealed: unknown[] = [];
  const result = await collectFastProfitabilityForwardEvidenceV1({
    bundle,
    observerState: observerState([activationPending, preBoundary, futureSettled]),
    recordedAtMs: Date.parse(futureSettled.settledAt!) + 1,
    store: {
      async recordValidation(value) {
        validation.push(value);
        return value;
      },
      async recordSealedOos(value) {
        sealed.push(value);
        return value;
      },
    },
  });

  assert.equal(result.observedMatchingCount, 3);
  assert.equal(result.eligibleMatchingCount, 1);
  assert.equal(result.settledMatchingCount, 1);
  assert.equal(result.independentComponentCount, 1);
  assert.equal(result.guardRejectedCount, 0);
  assert.equal(result.admittedValidationRecords + result.admittedSealedOosRecords, 1);
  assert.equal(validation.length + sealed.length, 1);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('collector cleanly reports no future credit before the immutable 24-hour boundary', async () => {
  const record = promotion();
  const activationPending = observationAt(record, 'activation-pending', ACTIVATION_AT - 5 * 60_000);
  const bundle = buildFastProfitabilityActivationBundleV1({
    targetSha: SOURCE_SHA,
    observerState: observerState([activationPending]),
    frozenAtMs: ACTIVATION_AT,
    approval: approval(),
  });
  const result = await collectFastProfitabilityForwardEvidenceV1({
    bundle,
    observerState: observerState([activationPending]),
    recordedAtMs: ACTIVATION_AT + 60_000,
    store: {
      async recordValidation(value) { return value; },
      async recordSealedOos(value) { return value; },
    },
  });

  assert.equal(result.eligibleMatchingCount, 0);
  assert.equal(result.admittedValidationRecords, 0);
  assert.equal(result.admittedSealedOosRecords, 0);
  assert.deepEqual(result.blockers, [
    'FAST_PROFITABILITY_FUTURE_BOUNDARY_NOT_REACHED_OR_NO_MATCHING_OBSERVATION',
  ]);
});
