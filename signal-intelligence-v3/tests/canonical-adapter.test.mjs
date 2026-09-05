import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptCanonicalScannerCard, stopDistancePercent } from '../src/canonical-adapter.mjs';
import { runSignalIntelligenceV3 } from '../src/engine.mjs';

const NOW = Date.parse('2026-08-17T01:00:00Z');
const RESEARCH_SHA = 'a'.repeat(40);

function card(overrides = {}) {
  return {
    signalId: 'sig-1',
    assetClass: 'stock',
    market: 'KR',
    symbol: '005930',
    action: 'BUY',
    direction: 'LONG',
    strategyMode: 'swing',
    price: 100,
    strongSignalEligible: true,
    signalGrade: 'A',
    riskLevel: 'LOW',
    dataState: 'complete',
    dataQuality: { state: 'TRUSTED', strongSignalAllowed: true },
    observedAt: '2026-08-17T00:59:00Z',
    expiresAt: '2026-08-17T02:00:00Z',
    dataSources: ['canonical'],
    pricePlan: { entryZone: { from: 99, to: 101 }, stopLoss: 95, targets: [110], invalidation: 95, riskReward: 2 },
    candidateRanking: { hardFilterPassed: true },
    backtestQuality: {
      status: 'verified', expectancyPercent: 1, profitFactor: 1.4, tradeCount: 80, minimumTradeCount: 50,
      maxDrawdownPercent: 8, costsIncluded: true, slippageIncluded: true,
      lookaheadGuarded: true, survivorshipGuarded: true, oos: true, walkForward: true,
    },
    ...overrides,
  };
}

function paperIdentity(overrides = {}) {
  return {
    signalId: 'sig-1',
    strategyId: 'scanner-swing-v1',
    strategyVersion: 'scanner-swing-v1',
    parameterHash: 'params-sha256:scanner-swing-v1',
    market: 'KR_STOCK',
    symbol: '005930',
    timeframe: '1D',
    horizon: 5,
    direction: 'BUY',
    costPolicyVersion: 'runtime-cost-v1',
    researchCodeSha: RESEARCH_SHA,
    executionAuthority: 'NONE',
    ...overrides,
  };
}

function profitEvidence(overrides = {}) {
  return {
    status: 'READY',
    market: 'KR_STOCK',
    strategyHorizon: 'SWING',
    direction: 'BUY',
    timeframe: '1D',
    strategyVersion: 'scanner-swing-v1',
    expectedNetEdge: 1,
    expectedNetReturn: 0.8,
    riskRewardRatio: 2,
    sampleSize: 80,
    costPolicyId: 'runtime-cost-v1',
    executionAuthority: 'NONE',
    ...overrides,
  };
}

function costPolicy(market = 'KR_STOCK', overrides = {}) {
  return {
    id: 'runtime-cost-v1',
    market,
    commissionPercent: 0.1,
    taxPercent: 0.1,
    spreadPercent: 0.1,
    slippagePercent: 0.1,
    fundingPercent: 0,
    latencyPercent: 0.05,
    liquidityImpactPercent: 0.05,
    partialFillImpactPercent: 0.05,
    source: 'EXPLICIT_RUNTIME_POLICY',
    ...overrides,
  };
}

function canonicalInput(cardValue = card(), overrides = {}) {
  return {
    card: cardValue,
    timeframe: '1D',
    paperIdentity: paperIdentity(),
    profitEvidence: profitEvidence(),
    costPolicy: costPolicy(),
    ...overrides,
  };
}

test('verified backtest alone cannot make a V3 candidate without canonical Profit-First evidence', () => {
  const adapted = adaptCanonicalScannerCard({ card: card(), timeframe: '1D' }, { nowMs: NOW });
  assert.equal(adapted.dataStatus, 'READY');
  assert.equal(adapted.quantEligible, true);
  assert.equal(adapted.riskReady, true);
  assert.equal(adapted.profitEligible, false);
  assert.equal(adapted.provenance.backtestQualityStatus, 'verified');
  assert.ok(adapted.provenance.profitBlockers.includes('PAPER_IDENTITY_REQUIRED'));
  assert.ok(adapted.provenance.profitBlockers.includes('CANONICAL_PROFIT_EVIDENCE_REQUIRED'));
  const snapshot = runSignalIntelligenceV3([adapted]);
  assert.equal(snapshot.rows[0].state, 'NO_TRADE');
  assert.equal(snapshot.lists.krBuy.length, 0);
});

test('canonical READY ProfitEvidence plus exact Paper Identity and explicit runtime cost policy can become candidate input', () => {
  const adapted = adaptCanonicalScannerCard(canonicalInput(), { nowMs: NOW });
  assert.equal(adapted.market, 'KR_STOCK');
  assert.equal(adapted.direction, 'BUY');
  assert.equal(adapted.strategy, 'SCANNER-SWING-V1');
  assert.equal(adapted.validationTier, 'RESEARCH_CANDIDATE');
  assert.equal(adapted.profitEligible, true);
  assert.equal(adapted.evidence.source, 'CANONICAL_PROFIT_EVIDENCE_READY');
  assert.equal(adapted.evidence.expectedNetEdgeR, 0.2);
  assert.equal(adapted.provenance.costPolicyId, 'runtime-cost-v1');
  assert.deepEqual(adapted.provenance.paperIdentity, paperIdentity());
  assert.deepEqual(adapted.provenance.profitBlockers, []);
  const snapshot = runSignalIntelligenceV3([adapted]);
  assert.equal(snapshot.lists.krBuy.length, 1);
  assert.equal(snapshot.lists.krBuy[0].utilityMode, 'NET_EDGE_ONLY_RISK_SEPARATE');
  assert.equal(snapshot.lists.krBuy[0].provenance.paperIdentity.parameterHash, paperIdentity().parameterHash);
  assert.equal(snapshot.lists.krBuy[0].provenance.paperIdentity.researchCodeSha, RESEARCH_SHA);
});

test('cash SELL is excluded from new-entry scanner', () => {
  const adapted = adaptCanonicalScannerCard({ card: card({ action: 'SELL', direction: 'SHORT' }) }, { nowMs: NOW });
  assert.equal(adapted, null);
});

test('futures LONG and SHORT preserve canonical directions only with market-matched evidence', () => {
  const base = card({ assetClass: 'coin_futures', market: 'futures', symbol: 'BTCUSDT' });
  const commonIdentity = { market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', timeframe: '15m', horizon: 4, strategyId: 'futures-scalping-v1', strategyVersion: 'futures-scalping-v1' };
  const commonProfit = { market: 'CRYPTO_FUTURES', timeframe: '15m', strategyVersion: 'futures-scalping-v1' };
  const long = adaptCanonicalScannerCard({
    card: { ...base, action: 'LONG', direction: 'LONG' },
    timeframe: '15m',
    paperIdentity: paperIdentity({ ...commonIdentity, direction: 'LONG' }),
    profitEvidence: profitEvidence({ ...commonProfit, direction: 'LONG' }),
    costPolicy: costPolicy('CRYPTO_FUTURES'),
  }, { nowMs: NOW });
  const short = adaptCanonicalScannerCard({
    card: { ...base, action: 'SHORT', direction: 'SHORT' },
    timeframe: '15m',
    paperIdentity: paperIdentity({ ...commonIdentity, direction: 'SHORT' }),
    profitEvidence: profitEvidence({ ...commonProfit, direction: 'SHORT' }),
    costPolicy: costPolicy('CRYPTO_FUTURES'),
  }, { nowMs: NOW });
  assert.equal(long.profitEligible, true);
  assert.equal(short.profitEligible, true);
  assert.equal(long.direction, 'LONG');
  assert.equal(short.direction, 'SHORT');
});

test('cost policy mismatch fails closed even when ProfitEvidence is READY', () => {
  const adapted = adaptCanonicalScannerCard(canonicalInput(card(), {
    costPolicy: costPolicy('KR_STOCK', { id: 'different-cost-policy' }),
  }), { nowMs: NOW });
  assert.equal(adapted.profitEligible, false);
  assert.ok(adapted.provenance.profitBlockers.includes('COST_POLICY_ID_MISMATCH'));
});

test('Paper Identity mismatch fails closed and is never exposed as canonical identity', () => {
  const adapted = adaptCanonicalScannerCard(canonicalInput(card(), {
    paperIdentity: paperIdentity({ parameterHash: '', researchCodeSha: 'not-a-sha' }),
  }), { nowMs: NOW });
  assert.equal(adapted.profitEligible, false);
  assert.equal(adapted.provenance.paperIdentity, null);
  assert.ok(adapted.provenance.profitBlockers.includes('PARAMETER_HASH_REQUIRED'));
  assert.ok(adapted.provenance.profitBlockers.includes('RESEARCH_CODE_SHA_REQUIRED'));
});

test('stale or untrusted canonical data is blocked even with complete Profit-First evidence', () => {
  const expired = adaptCanonicalScannerCard(canonicalInput(card({ expiresAt: '2026-08-17T00:30:00Z' })), { nowMs: NOW });
  assert.equal(expired.dataStatus, 'BLOCKED');
  const untrusted = adaptCanonicalScannerCard(canonicalInput(card({ dataQuality: { state: 'DATA_UNTRUSTED', strongSignalAllowed: false } })), { nowMs: NOW });
  assert.equal(untrusted.dataStatus, 'BLOCKED');
});

test('canonical AI veto can only abstain after deterministic gates pass', () => {
  const adapted = adaptCanonicalScannerCard(canonicalInput(card({ aiValidation: { status: 'VETO', risks: ['event-risk'], counterEvidence: [], missingData: [], provider: 'test', explanation: null } })), { nowMs: NOW });
  const snapshot = runSignalIntelligenceV3([adapted]);
  assert.equal(snapshot.rows[0].state, 'ABSTAIN');
});

test('stop distance derives from entry midpoint and stop loss', () => {
  assert.equal(stopDistancePercent(card()), 5);
});
