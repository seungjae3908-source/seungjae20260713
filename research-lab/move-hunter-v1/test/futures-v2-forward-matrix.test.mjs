import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFuturesV2ProspectiveDecisionMatrix } from '../src/futures-v2-forward-matrix.mjs';

const DECISION = '2026-09-29T00:00:00.000Z';

function observation(overrides = {}) {
  const symbol = overrides.symbol ?? 'BTCUSDT';
  const direction = overrides.direction ?? 'LONG';
  const timeframe = overrides.timeframe ?? '60m';
  return {
    schemaVersion: 'forward-recommendation-observation-v2',
    observationId: 'future-v2-1',
    source: 'LIVE_RECOMMENDATION',
    status: 'PENDING',
    identity: {
      strategyId: 'scanner-swing',
      strategyVersion: 'v1',
      parameterHash: 'p',
      researchCodeSha: 'a'.repeat(40),
      market: 'CRYPTO_FUTURES',
      symbol,
      timeframe,
      horizon: 24,
      direction,
    },
    dataTimestamp: DECISION,
    publicDataOnly: true,
    snapshot: {
      timestamp: DECISION,
      market: 'CRYPTO_FUTURES',
      symbol,
      direction,
      entryPrice: overrides.entryPrice ?? 100,
      stopLoss: overrides.stopLoss ?? 98.5,
    },
    outcome: null,
    settledAt: null,
    executionAuthority: 'NONE',
    simulatedOnly: true,
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  };
}

function featureSnapshot(overrides = {}) {
  const identity = {
    lineageId: 'ADAPTIVE_MULTI_EVIDENCE_V2',
    market: 'CRYPTO_FUTURES',
    symbol: overrides.symbol ?? 'BTCUSDT',
    timeframe: overrides.timeframe ?? '60m',
    side: overrides.side ?? 'LONG',
    temporal: { decisionTime: DECISION },
  };
  return {
    schemaVersion: 'adaptive-multi-evidence-market-features-v2',
    lineageId: 'ADAPTIVE_MULTI_EVIDENCE_V2',
    status: 'READY_FOR_SPECIALIST_RESEARCH_ONLY',
    decisionTime: DECISION,
    contentDigest: 'b'.repeat(64),
    decisionAuthority: 'EVIDENCE_ONLY',
    executionAuthority: 'NONE',
    features: {
      trend: {
        adx: 25,
        emaDirection: 'UP',
        adxDirection: 'UP',
        structureTrend: 'BULLISH',
        multiTimeframe: [],
      },
      momentum: {
        roc: 0.02,
        rsi: 58,
        macdHistogramPct: 0.01,
      },
      volume: {
        relativeVolume: 1.1,
        abnormalVolume: false,
        priceVolumeDisagreement: false,
      },
      volatility: {
        atrPct: 0.02,
        recentToPriorRangeRatio: 1,
        abnormalVolatility: false,
      },
      priceAction: {
        structureTrend: 'BULLISH',
        structureTransition: 'NONE',
        latestSwingLegDirection: 'UP',
        latestSwingLegAtr: 1.2,
        swingRetracementRatio: 0.5,
        swingSequence: ['HL', 'HH'],
        candlestickPatterns: [],
      },
    },
    evidence: {
      trend: { status: 'ADMISSIBLE', executionAuthority: 'NONE', evidence: { lineageId: 'ADAPTIVE_MULTI_EVIDENCE_V2', identity } },
      momentum: { status: 'ADMISSIBLE', executionAuthority: 'NONE', evidence: { lineageId: 'ADAPTIVE_MULTI_EVIDENCE_V2', identity } },
      volume: { status: 'ADMISSIBLE', executionAuthority: 'NONE', evidence: { lineageId: 'ADAPTIVE_MULTI_EVIDENCE_V2', identity } },
      volatility: { status: 'ADMISSIBLE', executionAuthority: 'NONE', evidence: { lineageId: 'ADAPTIVE_MULTI_EVIDENCE_V2', identity } },
    },
    missingEvidence: [],
  };
}

const costModel = Object.freeze({
  modelId: 'PUBLIC_RESEARCH_COST_MODEL_V1',
  feeBps: 5,
  slippageBps: 5,
  spreadBps: 6,
  canonicalFullCostProven: false,
});

test('prospective matrix compares preregistered futures candidates without choosing a winner', () => {
  const matrix = buildFuturesV2ProspectiveDecisionMatrix({
    observation: observation(),
    featureSnapshot: featureSnapshot(),
    costModel,
  });
  assert.equal(matrix.status, 'RESEARCH_EVIDENCE_ONLY');
  assert.equal(matrix.initialRiskPct, 0.015);
  assert.equal(matrix.costModel.roundTripCostRate, 0.0026);
  assert.equal(matrix.performanceWinner, null);
  assert.equal(matrix.winnerSelectionAllowed, false);
  assert.equal(Object.keys(matrix.preregisteredDecisions).length, 4);
  assert.equal(matrix.costRiskDecision.status, 'RESEARCH_EVIDENCE_ONLY');
  assert.equal(matrix.costRiskDecision.eligible, true);
  assert.equal(matrix.modeledCostOnly, true);
  assert.equal(matrix.canonicalFullCostProven, false);
  assert.equal(matrix.automaticScannerAdoptionAllowed, false);
  assert.equal(matrix.positionSizeOrLeverageOverrideAllowed, false);
  assert.equal(matrix.executionAuthority, 'NONE');
});

test('cost-risk guard blocks tight stop whose modeled friction consumes over 25 percent of initial risk', () => {
  const matrix = buildFuturesV2ProspectiveDecisionMatrix({
    observation: observation({ stopLoss: 99.2 }),
    featureSnapshot: featureSnapshot(),
    costModel,
  });
  assert.equal(matrix.status, 'RESEARCH_EVIDENCE_ONLY');
  assert.ok(matrix.costRiskDecision.costToInitialRiskRatio > 0.25);
  assert.equal(matrix.costRiskDecision.eligible, false);
  assert.equal(matrix.costRiskDecision.reason, 'COST_CONSUMES_TOO_MUCH_INITIAL_RISK');
});

test('missing cost model fails closed instead of assuming zero friction', () => {
  const matrix = buildFuturesV2ProspectiveDecisionMatrix({
    observation: observation(),
    featureSnapshot: featureSnapshot(),
  });
  assert.equal(matrix.status, 'BLOCKED_DATA');
  assert.equal(matrix.reason, 'EXPLICIT_COST_MODEL_REQUIRED');
});

test('identity mismatch and unsafe Forward envelope fail closed', () => {
  const mismatch = buildFuturesV2ProspectiveDecisionMatrix({
    observation: observation(),
    featureSnapshot: featureSnapshot({ symbol: 'ETHUSDT' }),
    costModel,
  });
  assert.equal(mismatch.status, 'BLOCKED_DATA');
  assert.equal(mismatch.reason, 'FORWARD_FEATURE_IDENTITY_MISMATCH');

  const unsafe = observation();
  unsafe.liveOrderAllowed = true;
  const blocked = buildFuturesV2ProspectiveDecisionMatrix({
    observation: unsafe,
    featureSnapshot: featureSnapshot(),
    costModel,
  });
  assert.equal(blocked.status, 'BLOCKED_DATA');
  assert.equal(blocked.reason, 'FORWARD_OBSERVATION_SAFETY_INVALID');
});
