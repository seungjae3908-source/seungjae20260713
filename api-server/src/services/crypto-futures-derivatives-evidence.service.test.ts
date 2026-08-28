import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFuturesDerivativesEvidenceGate,
  normalizeBitgetPositionTierEvidence,
  type FuturesDirectionalDerivativesEvidence,
} from './crypto-futures-derivatives-evidence.service';
import type { ScannerSignalCard } from './scanner-signal.types';

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

function positionTierRows() {
  return [
    { tier: '1', minTierValue: '0', maxTierValue: '200000', leverage: '125', mmr: '0.004' },
    { tier: '2', minTierValue: '200000', maxTierValue: '500000', leverage: '100', mmr: '0.005' },
    { tier: '3', minTierValue: '500000', maxTierValue: '1000000', leverage: '75', mmr: '0.01' },
  ];
}

function readyEvidence(): FuturesDirectionalDerivativesEvidence {
  const tier = normalizeBitgetPositionTierEvidence({
    symbol: 'BTCUSDT',
    rows: positionTierRows(),
    requestTime: NOW - 1000,
    now: NOW,
  });
  return {
    symbol: 'BTCUSDT',
    status: 'READY',
    markPrice: 100,
    indexPrice: 99.5,
    fundingRate: 0.0001,
    openInterest: 10_000,
    basis: 0.5,
    basisPercent: (0.5 / 99.5) * 100,
    observedAt: new Date(NOW - 1000).toISOString(),
    positionTier: tier,
    liquidationRiskStructure: {
      status: 'READY_FOR_CANONICAL_RISK_SIZING',
      canonicalModelId: 'BITGET_CLASSIC_SINGLE_ASSET_ISOLATED_TIERED_V2025_11_10',
      canonicalModelOwner: 'market-prediction-lab/src/crypto-futures-isolated-liquidation-model-v1.js',
      currentPublicTierEvidenceReady: true,
      positionSpecificLiquidationPrice: null,
      positionSpecificRiskRequiresCanonicalSizing: true,
      historicalCoverageProven: false,
    },
    blockers: [],
    warnings: [],
    dataSources: ['bitget-public:/api/v3/market/position-tier'],
    publicDataOnly: true,
    privatePositionApiUsed: false,
    executionAuthority: 'NONE',
  };
}

function card(): ScannerSignalCard {
  return {
    signalId: 'signal:test',
    assetClass: 'coin_futures',
    market: 'futures',
    exchange: 'Bitget',
    symbol: 'BTCUSDT',
    name: 'BTCUSDT',
    currency: 'USDT',
    assetType: 'crypto_futures',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    action: 'LONG',
    signalState: 'CANDIDATE',
    score: 80,
    confidence: 80,
    dataCompleteness: 90,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 1_000_000,
    volume: 10_000,
    tradingValue: 1_000_000,
    spreadPercent: 0.1,
    volatilityPercent: 1,
    matched: [],
    notMatched: [],
    unverified: [],
    evidence: [{ key: 'long-derivatives', label: 'legacy derivatives', status: 'matched', source: 'legacy', observedAt: null, reasons: [] }],
    pricePlan: { entryZone: { from: 99, to: 100 }, invalidation: 95, stopLoss: 95, targets: [107, 110], riskReward: 1.5 },
    dataState: 'complete',
    dataSources: ['bitget-public'],
    observedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    strongSignalEligible: true,
    warnings: [],
  };
}

test('Bitget public position tiers preserve tier/MMR provenance and current-only truth', () => {
  const result = normalizeBitgetPositionTierEvidence({
    symbol: 'BTCUSDT',
    rows: positionTierRows(),
    requestTime: NOW - 1000,
    now: NOW,
  });
  assert.equal(result.status, 'live');
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[1].maintenanceMarginRate, 0.005);
  assert.match(result.rawEvidenceSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(result.currentRuleOnly, true);
  assert.equal(result.historicalCoverageProven, false);
  assert.equal(result.publicDataOnly, true);
  assert.equal(result.privatePositionApiUsed, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('position tier gaps, decreasing MMR, future timestamps, and malformed rows fail closed', () => {
  const gap = positionTierRows();
  gap[1] = { ...gap[1], minTierValue: '210000' };
  assert.equal(normalizeBitgetPositionTierEvidence({ symbol: 'BTCUSDT', rows: gap, requestTime: NOW, now: NOW }).status, 'insufficient');

  const decreasing = positionTierRows();
  decreasing[2] = { ...decreasing[2], mmr: '0.003' };
  assert.equal(normalizeBitgetPositionTierEvidence({ symbol: 'BTCUSDT', rows: decreasing, requestTime: NOW, now: NOW }).status, 'insufficient');

  assert.equal(normalizeBitgetPositionTierEvidence({ symbol: 'BTCUSDT', rows: positionTierRows(), requestTime: NOW + 1, now: NOW }).status, 'insufficient');
  assert.equal(normalizeBitgetPositionTierEvidence({ symbol: 'BTCUSDT', rows: [], requestTime: NOW, now: NOW }).status, 'insufficient');
});

test('full six-part public derivatives evidence preserves Candidate eligibility but never invents a liquidation price', () => {
  const gated = applyFuturesDerivativesEvidenceGate(card(), readyEvidence());
  assert.equal(gated.strongSignalEligible, true);
  assert.equal(gated.signalState, 'CANDIDATE');
  assert.equal(gated.action, 'LONG');
  for (const key of ['long-mark-price', 'long-index-price', 'long-funding', 'long-open-interest', 'long-basis', 'long-liquidation-risk']) {
    assert.equal(gated.evidence.find((row) => row.key === key)?.status, 'matched');
  }
  assert.equal(gated.evidence.some((row) => row.reasons.some((reason) => /positionSpecificLiquidationPrice=/u.test(reason))), false);
});

test('missing derivatives evidence blocks promotion and removes the price plan instead of treating unknown as zero', () => {
  const gated = applyFuturesDerivativesEvidenceGate(card(), null);
  assert.equal(gated.strongSignalEligible, false);
  assert.equal(gated.signalState, 'WATCHING');
  assert.equal(gated.action, 'NONE');
  assert.equal(gated.dataState, 'insufficient');
  assert.equal(gated.pricePlan.entryZone, null);
  assert.equal(gated.pricePlan.stopLoss, null);
  assert.deepEqual(gated.pricePlan.targets, []);
  assert.ok(gated.warnings.includes('BLOCKED_DERIVATIVES_EVIDENCE'));
  assert.ok(gated.unverified.includes('LONG LIQUIDATION_RISK'));
});
