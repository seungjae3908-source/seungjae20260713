import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KR_NO_STRUCTURE_60M_FORWARD_HYPOTHESIS_V1,
  buildMarketHypothesisForwardRecord,
  evaluateFrozenKrNoStructureDecisionV1,
  summarizeMarketHypothesisForwardRecords,
} from '../src/market-hypothesis-forward.mjs';

function observation({
  timestamp = '2026-09-28T07:00:00.000Z',
  symbol = '005930',
  timeframe = '60m',
  status = 'PENDING',
  outcome = null,
  liveOrderAllowed = false,
} = {}) {
  return {
    schemaVersion: 'forward-recommendation-observation-v2',
    observationId: 'obs-1',
    source: 'LIVE_RECOMMENDATION',
    status,
    identity: {
      strategyId: 'scanner-swing',
      strategyVersion: 'v1',
      parameterHash: 'param-hash',
      researchCodeSha: '1'.repeat(40),
      market: 'KR_STOCK',
      symbol,
      timeframe,
      horizon: 24,
      direction: 'BUY',
    },
    signalGrade: 'A',
    expiresAt: '2026-09-30T07:00:00.000Z',
    dataTimestamp: timestamp,
    dataMaxAgeMs: 90 * 60 * 1000,
    publicDataOnly: true,
    snapshot: {
      timestamp,
      market: 'KR_STOCK',
      symbol,
      direction: 'BUY',
      strategyProfileVersion: 'v1',
      timeframes: ['60m'],
    },
    outcome,
    settledAt: status === 'SETTLED' ? '2026-09-29T07:00:00.000Z' : null,
    executionAuthority: 'NONE',
    simulatedOnly: true,
    financialMutationAllowed: false,
    liveOrderAllowed,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  };
}

function featureSnapshot({
  timestamp = '2026-09-28T07:00:00.000Z',
  symbol = '005930',
  timeframe = '60m',
  roc = 0.03,
} = {}) {
  const identity = {
    market: 'KR_STOCK',
    symbol,
    timeframe,
    side: 'BUY',
    temporal: { decisionTime: timestamp },
  };
  return {
    status: 'READY_FOR_SPECIALIST_RESEARCH_ONLY',
    executionAuthority: 'NONE',
    decisionAuthority: 'EVIDENCE_ONLY',
    features: {
      trend: {
        emaDirection: 'UP',
        adx: 28,
        adxDirection: 'UP',
      },
      momentum: {
        roc,
        macdHistogramPct: roc > 0 ? 0.01 : -0.01,
        rsi: 58,
      },
      volume: {
        relativeVolume: 1.2,
        priceVolumeDisagreement: false,
      },
      volatility: {
        abnormalVolatility: false,
      },
      priceAction: {
        structureTrend: 'MIXED',
        structureTransition: 'NONE',
        latestSwingLegDirection: null,
        latestSwingLegAtr: null,
        swingRetracementRatio: null,
        swingSequence: [],
      },
    },
    evidence: {
      trend: { evidence: { identity } },
      momentum: { evidence: { identity } },
      volume: { evidence: { identity } },
      volatility: { evidence: { identity } },
    },
  };
}

test('frozen KR hypothesis is immutable research-only metadata', () => {
  const h = KR_NO_STRUCTURE_60M_FORWARD_HYPOTHESIS_V1;
  assert.equal(h.market, 'KR_STOCK');
  assert.equal(h.timeframe, '60M');
  assert.equal(h.selectedVariant, 'NO_STRUCTURE');
  assert.deepEqual(h.symbols, ['000660', '005930']);
  assert.deepEqual(h.disabledFamilies, ['STRUCTURE']);
  assert.equal(h.observedHistoryMayCountAsForward, false);
  assert.equal(h.automaticScannerAdoptionAllowed, false);
  assert.equal(h.automaticPromotionAllowed, false);
  assert.equal(h.economicSampleCredit, 0);
  assert.equal(h.executionAuthority, 'NONE');
});



test('frozen KR NO_STRUCTURE decision semantics are self-contained and structure-independent', () => {
  const base = featureSnapshot();
  const first = evaluateFrozenKrNoStructureDecisionV1(base, 'LONG');
  assert.equal(first.schemaVersion, 'move-hunter-kr-no-structure-decision/v1');
  assert.equal(first.maximumScore, 7);
  assert.equal(first.threshold, 6);
  assert.deepEqual(first.disabledFamilies, ['STRUCTURE']);
  assert.equal(first.components.ema, true);
  assert.equal(first.components.roc, true);
  assert.equal(first.matched, true);

  const changedStructure = featureSnapshot();
  changedStructure.features.priceAction.structureTrend = 'BEARISH';
  changedStructure.features.priceAction.structureTransition = 'CHOCH_DOWN';
  const second = evaluateFrozenKrNoStructureDecisionV1(changedStructure, 'LONG');
  assert.equal(second.matched, first.matched);
  assert.equal(second.score, first.score);

  const weakMomentum = featureSnapshot({ roc: -0.01 });
  const blocked = evaluateFrozenKrNoStructureDecisionV1(weakMomentum, 'LONG');
  assert.equal(blocked.matched, false);
  assert.equal(blocked.components.roc, false);
  assert.equal(blocked.executionAuthority, 'NONE');
});

test('pre-freeze observations are blocked from prospective credit', () => {
  const timestamp = '2026-09-28T06:30:00.000Z';
  const row = buildMarketHypothesisForwardRecord({
    observation: observation({ timestamp }),
    featureSnapshot: featureSnapshot({ timestamp }),
  });
  assert.equal(row.status, 'BLOCKED_DATA');
  assert.equal(row.reason, 'OBSERVATION_NOT_POST_FREEZE');
  assert.equal(row.economicSampleCredit, 0);
});

test('symbols outside the frozen two-symbol evidence scope fail closed', () => {
  const row = buildMarketHypothesisForwardRecord({
    observation: observation({ symbol: '035420' }),
    featureSnapshot: featureSnapshot({ symbol: '035420' }),
  });
  assert.equal(row.status, 'BLOCKED_DATA');
  assert.equal(row.reason, 'HYPOTHESIS_SYMBOL_OUT_OF_FROZEN_SCOPE');
});

test('post-freeze exact-identity observation can be compared without execution authority', () => {
  const row = buildMarketHypothesisForwardRecord({
    observation: observation(),
    featureSnapshot: featureSnapshot(),
  });
  assert.equal(row.status, 'PENDING');
  assert.equal(row.prefilterEligible, true);
  assert.equal(row.hypothesisEligible, true);
  assert.equal(row.selectedVariant, 'NO_STRUCTURE');
  assert.equal(row.historicalBackfillAllowed, false);
  assert.equal(row.observedHistoryMayCountAsForward, false);
  assert.equal(row.automaticScannerAdoptionAllowed, false);
  assert.equal(row.automaticPromotionAuthority, false);
  assert.equal(row.economicSampleCredit, 0);
  assert.equal(row.executionAuthority, 'NONE');
});



test('timeframe mismatch cannot borrow 4H evidence into frozen 60m hypothesis', () => {
  const row = buildMarketHypothesisForwardRecord({
    observation: observation({ timeframe: '4H' }),
    featureSnapshot: featureSnapshot({ timeframe: '4H' }),
  });
  assert.equal(row.status, 'BLOCKED_DATA');
  assert.equal(row.reason, 'HYPOTHESIS_TIMEFRAME_MISMATCH');
  assert.equal(row.economicSampleCredit, 0);
  assert.equal(row.executionAuthority, 'NONE');
});

test('canonical feature identity mismatch fails closed even within frozen symbol scope', () => {
  const row = buildMarketHypothesisForwardRecord({
    observation: observation({ symbol: '005930' }),
    featureSnapshot: featureSnapshot({ symbol: '000660' }),
  });
  assert.equal(row.status, 'BLOCKED_DATA');
  assert.equal(row.reason, 'FORWARD_FEATURE_IDENTITY_MISMATCH');
  assert.ok(row.details.mismatches.includes('SYMBOL'));
  assert.equal(row.economicSampleCredit, 0);
});

test('unsafe Forward observation envelope is rejected', () => {
  const row = buildMarketHypothesisForwardRecord({
    observation: observation({ liveOrderAllowed: true }),
    featureSnapshot: featureSnapshot(),
  });
  assert.equal(row.status, 'BLOCKED_DATA');
  assert.equal(row.reason, 'FORWARD_OBSERVATION_SAFETY_ENVELOPE_INVALID');
});

test('settled prospective records summarize eligible versus ineligible outcomes descriptively', () => {
  const winOutcome = {
    outcome: 'WIN',
    returnPercent: 2.4,
    mfePercent: 3.1,
    maePercent: -0.7,
    target1Hit: true,
    target2Hit: false,
    stopLossHit: false,
    timeToTargetMs: 3600000,
    timeToStopMs: null,
    conservativeIntrabarConflict: false,
  };
  const lossOutcome = {
    outcome: 'LOSS',
    returnPercent: -1.1,
    mfePercent: 0.3,
    maePercent: -1.4,
    target1Hit: false,
    target2Hit: false,
    stopLossHit: true,
    timeToTargetMs: null,
    timeToStopMs: 7200000,
    conservativeIntrabarConflict: false,
  };
  const eligible = buildMarketHypothesisForwardRecord({
    observation: observation({ status: 'SETTLED', outcome: winOutcome }),
    featureSnapshot: featureSnapshot(),
  });
  const ineligible = buildMarketHypothesisForwardRecord({
    observation: {
      ...observation({ status: 'SETTLED', outcome: lossOutcome }),
      observationId: 'obs-2',
    },
    featureSnapshot: featureSnapshot({ roc: -0.02 }),
  });
  assert.equal(eligible.hypothesisEligible, true);
  assert.equal(ineligible.hypothesisEligible, false);

  const summary = summarizeMarketHypothesisForwardRecords([eligible, ineligible]);
  assert.equal(summary.settledN, 2);
  assert.equal(summary.hypothesisEligible.n, 1);
  assert.equal(summary.hypothesisEligible.winCount, 1);
  assert.equal(summary.hypothesisIneligible.n, 1);
  assert.equal(summary.hypothesisIneligible.lossCount, 1);
  assert.equal(summary.economicSampleCredit, 0);
  assert.equal(summary.automaticPromotionAuthority, false);
  assert.equal(summary.executionAuthority, 'NONE');
});
