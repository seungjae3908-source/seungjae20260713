import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAntiChurn,
  evaluateExpectedShortfall,
  evaluateGlobalKillSwitch,
  evaluatePortfolioRisk,
  evaluatePortfolioSafety,
  evaluateSignalFreshness,
} from '../src/portfolio-safety.mjs';

const NOW = Date.UTC(2026, 7, 17, 7, 45, 0);
function lossSamples() { return Array.from({ length: 300 }, (_, index) => 0.2 + (index % 30) * 0.1); }

test('portfolio risk checks gross and single-name limits without inventing correlation', () => {
  const result = evaluatePortfolioRisk({
    equityKrw: 1_000_000,
    positions: [
      { symbol: 'BTCUSDT', market: 'CRYPTO_FUTURES', notionalKrw: 300_000, cluster: 'CRYPTO_BETA' },
      { symbol: 'ETHUSDT', market: 'CRYPTO_FUTURES', notionalKrw: 200_000, cluster: 'CRYPTO_BETA' },
    ],
    proposedSymbol: 'SOLUSDT', proposedCluster: 'CRYPTO_BETA', proposedNotionalKrw: 100_000, correlationEvidenceVerified: false,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.grossExposurePct, 60);
  assert.equal(result.clusterExposurePct, null);
  assert.equal(result.clusterEvidenceStatus, 'NOT_AVAILABLE');
  assert.equal(result.correlationInvented, false);
});

test('verified correlation cluster exposure can veto concentrated correlated entries', () => {
  const result = evaluatePortfolioRisk({
    equityKrw: 1_000_000,
    positions: [
      { symbol: 'BTCUSDT', notionalKrw: 200_000, cluster: 'CRYPTO_BETA' },
      { symbol: 'ETHUSDT', notionalKrw: 100_000, cluster: 'CRYPTO_BETA' },
    ],
    proposedSymbol: 'SOLUSDT', proposedCluster: 'CRYPTO_BETA', proposedNotionalKrw: 100_000, correlationEvidenceVerified: true,
  });
  assert.equal(result.status, 'VETO');
  assert.ok(result.reasons.includes('CORRELATION_CLUSTER_LIMIT_EXCEEDED'));
});

test('expected shortfall requires enough empirical loss samples', () => {
  const unavailable = evaluateExpectedShortfall({ lossSamplesPct: [1, 2, 3] });
  assert.equal(unavailable.status, 'NOT_AVAILABLE');
  assert.equal(unavailable.reason, 'EXPECTED_SHORTFALL_SAMPLE_INSUFFICIENT');
  const available = evaluateExpectedShortfall({ lossSamplesPct: lossSamples() }, { maxExpectedShortfallPct: 10 });
  assert.equal(available.status, 'PASS');
  assert.equal(available.empiricalOnly, true);
  assert.ok(available.expectedShortfallPct >= available.varPct);
});

test('signal TTL and revalidation independently protect against stale entries', () => {
  const expired = evaluateSignalFreshness({ generatedAt: NOW - 20 * 60_000, revalidatedAt: NOW - 10_000 }, {}, NOW);
  assert.equal(expired.status, 'VETO');
  assert.equal(expired.reason, 'SIGNAL_TTL_EXPIRED');
  const staleRevalidation = evaluateSignalFreshness({ generatedAt: NOW - 60_000, revalidatedAt: NOW - 5 * 60_000 }, {}, NOW);
  assert.equal(staleRevalidation.status, 'VETO');
  assert.equal(staleRevalidation.reason, 'SIGNAL_REVALIDATION_STALE');
});

test('anti-churn blocks immediate re-entry and repeated same-direction cycling', () => {
  const result = evaluateAntiChurn({
    direction: 'LONG', lastExitAt: NOW - 2 * 60_000,
    recentEntries: [
      { at: NOW - 10 * 60_000, direction: 'LONG' },
      { at: NOW - 20 * 60_000, direction: 'LONG' },
      { at: NOW - 30 * 60_000, direction: 'LONG' },
    ],
  }, {}, NOW);
  assert.equal(result.status, 'VETO');
  assert.ok(result.reasons.includes('REENTRY_COOLDOWN_ACTIVE'));
  assert.ok(result.reasons.includes('SAME_DIRECTION_CHURN_LIMIT_EXCEEDED'));
});

test('global kill switch blocks new entries but has no liquidation/cancel/order authority', () => {
  const result = evaluateGlobalKillSwitch({ dailyDrawdownPct: 5, dataIntegrityCritical: true });
  assert.equal(result.state, 'BLOCK_NEW_ENTRIES');
  assert.ok(result.reasons.includes('DAILY_DRAWDOWN_KILL'));
  assert.ok(result.reasons.includes('DATA_INTEGRITY_KILL'));
  assert.equal(result.forcedLiquidationAuthority, false);
  assert.equal(result.cancelAuthority, false);
  assert.equal(result.orderAuthority, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('latched kill remains a block until explicit state reset is supplied externally', () => {
  const result = evaluateGlobalKillSwitch({ latchedKill: true });
  assert.equal(result.state, 'BLOCK_NEW_ENTRIES');
  assert.ok(result.reasons.includes('LATCHED_KILL_REQUIRES_EXPLICIT_RESET'));
});

test('observe-only portfolio safety preserves scanner visibility and never grants an order', () => {
  const result = evaluatePortfolioSafety({
    now: NOW,
    portfolio: { equityKrw: 1_000_000, positions: [], proposedSymbol: 'BTCUSDT', proposedNotionalKrw: 100_000 },
    expectedShortfall: {}, signal: {}, churn: {}, killSwitch: {},
  });
  assert.equal(result.autoTrading.state, 'PASS');
  assert.equal(result.scanner.candidateDeletionAllowed, false);
  assert.equal(result.autoTrading.orderAllowed, false);
  assert.equal(result.safety.forcedLiquidationAllowed, false);
});

test('required mode keeps missing ES/signal evidence out of parent eligibility', () => {
  const result = evaluatePortfolioSafety({
    now: NOW,
    portfolio: { equityKrw: 1_000_000, positions: [], proposedSymbol: 'BTCUSDT', proposedNotionalKrw: 100_000 },
    expectedShortfall: {}, signal: {}, churn: {}, killSwitch: {},
  }, { enforcement: 'REQUIRED_FOR_PARENT_GATE' });
  assert.equal(result.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.autoTrading.orderAllowed, false);
});
