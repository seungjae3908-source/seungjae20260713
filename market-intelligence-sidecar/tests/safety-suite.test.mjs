import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarketIntelligence } from '../src/engine.mjs';

const NOW = Date.UTC(2026, 7, 17, 8, 0, 0);

function baseInput() {
  return {
    now: NOW,
    asOf: NOW,
    market: 'CRYPTO_SPOT',
    symbol: 'KRW-BTC',
    orderBook: { bids: [[100, 10]], asks: [[100.1, 10]], ts: NOW },
    trades: [
      { side: 'buy', price: 100.05, size: 1, ts: NOW - 1_000 },
      { side: 'sell', price: 100.04, size: 1, ts: NOW },
    ],
    validation: {
      forwardSamples: 500,
      profitFactor: 1.5,
      expectedNetEdgeBps: 5,
      maxDrawdownPct: 8,
      regimeCount: 3,
    },
  };
}

function calibrationScores() {
  return Array.from({ length: 120 }, (_, index) => 1 + (index % 10) * 0.1);
}

test('default observe-only safety suite is backward-compatible with existing parent eligibility', () => {
  const result = evaluateMarketIntelligence(baseInput());
  assert.equal(result.autoTrading.evidenceReady, true);
  assert.equal(result.autoTrading.parentEligibilityReady, true);
  assert.equal(result.autoTrading.mode, 'ELIGIBLE_FOR_PARENT_GATE');
  assert.equal(result.advancedGates.policy.enforcement, 'OBSERVE_ONLY');
  assert.equal(result.executionQuality.policy.enforcement, 'OBSERVE_ONLY');
  assert.equal(result.portfolioSafety.policy.enforcement, 'OBSERVE_ONLY');
  assert.equal(result.scanner.candidateDeletionAllowed, false);
  assert.equal(result.autoTrading.orderAllowed, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
});

test('required execution-quality evidence can keep a forward-ready strategy in paper-only without deleting it', () => {
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    executionQualityPolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE' },
  });
  assert.equal(result.autoTrading.mode, 'PAPER_ONLY');
  assert.equal(result.autoTrading.parentEligibilityReady, false);
  assert.equal(result.autoTrading.hardBlockReason, null);
  assert.equal(result.scanner.candidateDeletionAllowed, false);
});

test('required low calibrated fill probability becomes risk block but never grants execution authority', () => {
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    executionQuality: {
      bookWalk: { direction: 'BUY', targetQty: 1, arrivalPrice: 100.1, asks: [[100.1, 10]] },
      fillModel: {
        modelId: 'fill-v1',
        fillProbability: 0.2,
        evaluationSamples: 1_000,
        brierScore: 0.15,
        calibrationError: 0.04,
        evaluatedAt: NOW - 30_000,
      },
    },
    executionQualityPolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE' },
  });
  assert.equal(result.autoTrading.mode, 'BLOCKED_RISK');
  assert.equal(result.autoTrading.hardBlockReason, 'FILL_PROBABILITY_TOO_LOW');
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('required verified high-impact event veto is composed with existing profit evidence', () => {
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    advancedGates: {
      uncertainty: { expectedDirectionalEdgeBps: 10, calibrationNonconformityBps: calibrationScores() },
      metaLabel: {
        modelId: 'meta-v1', takeProbability: 0.7, evaluationSamples: 800,
        brierScore: 0.15, calibrationError: 0.05, evaluatedAt: NOW - 60_000,
      },
      events: [{
        id: 'macro', type: 'FOMC', severity: 'HIGH', verified: true,
        markets: ['CRYPTO_SPOT'], startsAt: NOW + 5 * 60_000, endsAt: NOW + 10 * 60_000,
      }],
    },
    advancedGatePolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE' },
  });
  assert.equal(result.autoTrading.mode, 'BLOCKED_RISK');
  assert.equal(result.autoTrading.hardBlockReason, 'VERIFIED_HIGH_IMPACT_EVENT_WINDOW');
});

test('required portfolio kill switch blocks only new-entry eligibility and has no liquidation authority', () => {
  const losses = Array.from({ length: 300 }, (_, index) => 0.1 + (index % 20) * 0.05);
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    portfolioSafety: {
      portfolio: { equityKrw: 1_000_000, positions: [], proposedSymbol: 'KRW-BTC', proposedNotionalKrw: 100_000 },
      expectedShortfall: { lossSamplesPct: losses },
      signal: { generatedAt: NOW - 60_000, revalidatedAt: NOW - 30_000 },
      churn: { direction: 'BUY', recentEntries: [] },
      killSwitch: { dataIntegrityCritical: true },
    },
    portfolioSafetyPolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE', maxExpectedShortfallPct: 10 },
  });
  assert.equal(result.autoTrading.mode, 'BLOCKED_RISK');
  assert.equal(result.autoTrading.hardBlockReason, 'DATA_INTEGRITY_KILL');
  assert.equal(result.portfolioSafety.killSwitch.forcedLiquidationAuthority, false);
  assert.equal(result.portfolioSafety.killSwitch.cancelAuthority, false);
  assert.equal(result.autoTrading.orderAllowed, false);
});
