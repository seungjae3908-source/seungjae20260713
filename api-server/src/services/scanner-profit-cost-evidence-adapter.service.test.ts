import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScannerTradingCostPolicy,
  type PercentCostEvidence,
  type SupplementalExecutionCostEvidence,
} from './scanner-profit-cost-evidence-adapter.service.js';
import type { PaperReadinessEvidence } from './trade-paper-market-contract.service.js';

const NOW = Date.parse('2026-08-16T00:00:00.000Z');

function component(valuePercent: number, quality: PercentCostEvidence['quality'] = 'OBSERVED'): PercentCostEvidence {
  return Object.freeze({ valuePercent, quality, source: `test:${quality}`, observedAtMs: NOW - 1_000 });
}

function supplemental(overrides: Partial<SupplementalExecutionCostEvidence> = {}): SupplementalExecutionCostEvidence {
  return Object.freeze({
    costPolicyId: 'cost-policy-v1',
    observedAtMs: NOW - 1_000,
    latency: component(0.01, 'ESTIMATED'),
    liquidityImpact: component(0.02, 'ESTIMATED'),
    partialFillImpact: component(0.03, 'ESTIMATED'),
    ...overrides,
  });
}

function krPaper(overrides: Partial<PaperReadinessEvidence> = {}): PaperReadinessEvidence {
  return {
    market: 'KR_STOCK',
    provider: 'toss',
    providerProvenance: 'toss-public-paper-evidence',
    direction: 'BUY',
    observedAtMs: NOW - 1_000,
    costPolicyVersion: 'paper-cost-v1',
    feePercent: 0.01,
    spreadPercent: 0.02,
    slippagePercent: 0.03,
    tickSize: 1,
    liquidity: 10_000,
    partialFillModel: 'PRO_RATA',
    sessionCalendarVersion: 'kr-session-v1',
    marketStatus: 'OPEN',
    taxPolicyVersion: 'kr-tax-v1',
    taxPercent: 0.15,
    ...overrides,
  } as PaperReadinessEvidence;
}

function futuresPaper(overrides: Partial<PaperReadinessEvidence> = {}): PaperReadinessEvidence {
  return {
    market: 'CRYPTO_FUTURES',
    provider: 'bitget',
    providerProvenance: 'bitget-public-evidence',
    direction: 'LONG',
    observedAtMs: NOW - 1_000,
    costPolicyVersion: 'futures-cost-v1',
    feePercent: 0.06,
    spreadPercent: 0.02,
    slippagePercent: 0.04,
    tickSize: 0.1,
    liquidity: 1_000_000,
    partialFillModel: 'ORDER_BOOK',
    minimumOrderQuantity: 0.001,
    quantityStep: 0.001,
    quantityPrecision: 3,
    markPrice: 100,
    fundingRate: 0.0001,
    leverage: 2,
    marginMode: 'isolated',
    liquidationDistancePercent: 25,
    ...overrides,
  } as PaperReadinessEvidence;
}

test('cash-market funding is explicit not-applicable zero, never an implicit unknown default', () => {
  const result = buildScannerTradingCostPolicy({ paperEvidence: krPaper(), supplemental: supplemental(), nowMs: NOW });
  assert.equal(result.status, 'READY');
  assert.equal(result.policy?.fundingPercent, 0);
  assert.equal(result.provenance?.components.funding.quality, 'NOT_APPLICABLE');
  assert.match(result.provenance?.components.funding.source ?? '', /funding-not-applicable/u);
  assert.equal(result.liveTrading, false);
  assert.equal(result.orderSubmitted, false);
});

test('KR paper cost evidence maps fee/tax/spread/slippage plus explicit execution impacts without hidden components', () => {
  const result = buildScannerTradingCostPolicy({ paperEvidence: krPaper(), supplemental: supplemental(), nowMs: NOW });
  assert.deepEqual(result.policy, {
    id: 'cost-policy-v1',
    market: 'KR_STOCK',
    commissionPercent: 0.01,
    taxPercent: 0.15,
    spreadPercent: 0.02,
    slippagePercent: 0.03,
    fundingPercent: 0,
    latencyPercent: 0.01,
    liquidityImpactPercent: 0.02,
    partialFillImpactPercent: 0.03,
    source: 'EXPLICIT_RUNTIME_POLICY',
  });
});

test('missing execution impact evidence fails closed instead of fabricating zero cost', () => {
  const value = supplemental();
  const broken = { ...value, latency: undefined } as unknown as SupplementalExecutionCostEvidence;
  const result = buildScannerTradingCostPolicy({ paperEvidence: krPaper(), supplemental: broken, nowMs: NOW });
  assert.equal(result.status, 'NOT_EVIDENCED');
  assert.equal(result.policy, null);
  assert.ok(result.blockers.includes('LATENCY_EVIDENCE_REQUIRED'));
});

test('stale supplemental evidence fails closed', () => {
  const result = buildScannerTradingCostPolicy({
    paperEvidence: krPaper(),
    supplemental: supplemental({ observedAtMs: NOW - 120_000 }),
    nowMs: NOW,
    maxEvidenceAgeMs: 30_000,
  });
  assert.equal(result.status, 'NOT_EVIDENCED');
  assert.ok(result.blockers.includes('SUPPLEMENTAL_EVIDENCE_STALE'));
});

test('futures requires explicit funding cost evidence and does not reuse raw signed fundingRate as cost', () => {
  const missing = buildScannerTradingCostPolicy({ paperEvidence: futuresPaper(), supplemental: supplemental(), nowMs: NOW });
  assert.equal(missing.status, 'NOT_EVIDENCED');
  assert.ok(missing.blockers.includes('FUNDING_EVIDENCE_REQUIRED'));

  const ready = buildScannerTradingCostPolicy({
    paperEvidence: futuresPaper(),
    supplemental: supplemental({ funding: component(0.01, 'OBSERVED') }),
    nowMs: NOW,
  });
  assert.equal(ready.status, 'READY');
  assert.equal(ready.policy?.fundingPercent, 0.01);
});

test('explicit zero futures funding is valid only when caller supplies provenance rather than omission', () => {
  const ready = buildScannerTradingCostPolicy({
    paperEvidence: futuresPaper(),
    supplemental: supplemental({ funding: component(0, 'NOT_APPLICABLE') }),
    nowMs: NOW,
  });
  assert.equal(ready.status, 'READY');
  assert.equal(ready.policy?.fundingPercent, 0);
  assert.equal(ready.provenance?.components.funding.quality, 'NOT_APPLICABLE');
});

test('blocked paper readiness blocks Profit-First cost policy propagation', () => {
  const result = buildScannerTradingCostPolicy({
    paperEvidence: krPaper({ providerProvenance: '' }),
    supplemental: supplemental(),
    nowMs: NOW,
  });
  assert.equal(result.status, 'NOT_EVIDENCED');
  assert.ok(result.blockers.includes('PAPER_READINESS_BLOCKED'));
});

test('negative supplemental cost cannot be used to make EV look better', () => {
  const result = buildScannerTradingCostPolicy({
    paperEvidence: krPaper(),
    supplemental: supplemental({ latency: component(-0.01, 'ESTIMATED') }),
    nowMs: NOW,
  });
  assert.equal(result.status, 'NOT_EVIDENCED');
  assert.ok(result.blockers.includes('COST_COMPONENT_INVALID'));
});
