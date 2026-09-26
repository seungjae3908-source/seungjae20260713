import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildLiveProfitabilityPromotionCertificate,
  createLiveProfitabilityPromotionReader,
  verifyLiveProfitabilityPromotionCertificate,
} from './trade-live-profitability-certificate.service';
import type { StrategyPromotionRecord } from './strategy-promotion.service';

const SHA = '1111111111111111111111111111111111111111';
const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = '2026-09-26T01:00:00.000Z';
const STRATEGY = 'CRYPTO_FUTURES_SCALP_V1_LONG';

function record(): StrategyPromotionRecord {
  return {
    identity: {
      strategyFamily: 'CANONICAL_SCANNER_PROFILE',
      strategyId: STRATEGY,
      strategyVersion: 'v1',
      version: 'v1',
      parameterHash: HASH,
      market: 'CRYPTO_FUTURES',
      assetClass: 'CRYPTO_FUTURES',
      symbol: null,
      universe: 'CRYPTO_FUTURES_CANONICAL_UNIVERSE',
      timeframe: '15m',
      strategyHorizon: 'SCALP',
      horizon: 'SCALP',
      direction: 'LONG',
      researchCodeSha: SHA,
      costPolicyVersion: 'FULL_COST_V1',
      riskPolicyVersion: 'CANONICAL_RISK_ENGINE_V1',
    },
    promotionState: 'PROMOTION_CANDIDATE',
    stages: [
      {
        stage: 'REGIME',
        status: 'PASS',
        startedAt: NOW,
        completedAt: NOW,
        observedAt: NOW,
        source: 'verified-runtime',
        provider: 'CANONICAL',
        sourceSha: SHA,
        datasetId: 'regime-v1',
        dataRange: null,
        sampleSize: 80,
        sampleCount: 80,
        tradeCount: 80,
        metrics: { marketRegime: 'bull' },
        gate: 'PASS',
        gateResult: 'PASS',
        failureReason: null,
        failureReasons: [],
        provenance: ['canonical'],
        costAssumptions: null,
        costPolicy: null,
        dataQuality: 'VERIFIED',
        fetchedAt: NOW,
        validatedAt: NOW,
        corporateActionAdjusted: true,
        survivorshipSafe: true,
        pointInTimeSafe: true,
        requiredEvidence: [],
      },
      {
        stage: 'PAPER',
        status: 'PASS',
        startedAt: NOW,
        completedAt: NOW,
        observedAt: NOW,
        source: 'canonical-paper',
        provider: 'CANONICAL',
        sourceSha: SHA,
        datasetId: 'paper-v1',
        dataRange: null,
        sampleSize: 260,
        sampleCount: 260,
        tradeCount: 260,
        metrics: {
          hitRate: 0.58,
          averageWinR: 1.4,
          averageLossR: 0.9,
          estimatedCostsR: 0.08,
          profitFactor: 1.35,
          maxDrawdownPercent: 9,
          marketRegime: 'bull',
        },
        gate: 'PASS',
        gateResult: 'PASS',
        failureReason: null,
        failureReasons: [],
        provenance: ['canonical-natural-paper'],
        costAssumptions: null,
        costPolicy: { version: 'FULL_COST_V1' },
        dataQuality: 'VERIFIED',
        fetchedAt: NOW,
        validatedAt: NOW,
        corporateActionAdjusted: true,
        survivorshipSafe: true,
        pointInTimeSafe: true,
        requiredEvidence: [],
      },
      {
        stage: 'RECOMMENDATION_OUTCOMES',
        status: 'PASS',
        startedAt: NOW,
        completedAt: NOW,
        observedAt: NOW,
        source: 'forward-validation',
        provider: 'CANONICAL',
        sourceSha: SHA,
        datasetId: 'forward-v1',
        dataRange: null,
        sampleSize: 80,
        sampleCount: 80,
        tradeCount: 80,
        metrics: {
          hitRate: 0.58,
          averageWinR: 1.4,
          averageLossR: 0.9,
          estimatedCostsR: 0.08,
          profitFactor: 1.35,
          maxDrawdownPercent: 9,
          marketRegime: 'bull',
        },
        gate: 'PASS',
        gateResult: 'PASS',
        failureReason: null,
        failureReasons: [],
        provenance: ['sealed-oos-validation'],
        costAssumptions: null,
        costPolicy: { version: 'FULL_COST_V1' },
        dataQuality: 'VERIFIED',
        fetchedAt: NOW,
        validatedAt: NOW,
        corporateActionAdjusted: true,
        survivorshipSafe: true,
        pointInTimeSafe: true,
        requiredEvidence: [],
      },
    ],
    drift: {
      classification: 'HEALTHY',
      status: 'MEASURED',
      reason: 'fixture',
      baselineSampleSize: 80,
      observedSampleSize: 80,
      hitRateGap: 0,
      expectedValueGap: 0,
      autoPromotionAllowed: false,
    },
    killState: 'NONE',
    blockers: [],
    promotionEligible: true,
    executionAuthority: 'NONE',
    liveTradingAuthority: false,
    privateTradingApiCount: 0,
  } as StrategyPromotionRecord;
}

const policy = Object.freeze({
  status: 'empirically_calibrated',
  minTrials: 3,
  maxPbo: 0.25,
  minDsrProbability: 0.95,
  minOosTrades: 40,
  minWalkForwardWindows: 4,
  minShadowSettled: 300,
  minShadowElapsedMs: 28 * 24 * 60 * 60 * 1000,
  minPaperSettled: 200,
  minPaperProfitFactor: 1.2,
  minPaperExpectancyCiLower: 0,
  maxPaperMdd: 0.15,
});

function evidence() {
  return {
    backtest: {
      lineageValid: true,
      finalHoldoutRetuned: false,
      finalHoldoutStatus: 'PASS',
      oos: { tradeCount: 80, expectancy: 0.012 },
      walkForward: { windows: 8, stabilityPass: true },
      costStress: { passed: true },
      regime: { passed: true },
      crossSymbol: { passed: true },
    },
    selectionBias: {
      registryComplete: true,
      trialCount: 30,
      pbo: 0.12,
      dsrProbability: 0.985,
      forwardEvidenceUsedForSelection: false,
    },
    shadow: {
      lineageValid: true,
      frozenIdentity: true,
      naturalScheduleObserved: true,
      forwardRetuned: false,
      settled: 420,
      elapsedMs: 35 * 24 * 60 * 60 * 1000,
      neutralCollapse: false,
      directionalQualityPass: true,
    },
    paper: {
      lineageValid: true,
      scheduleActive: true,
      naturalCronObserved: true,
      settlementLinked: true,
      settledTrades: 260,
      profitFactor: 1.35,
      expectancyCiLower: 0.001,
      maximumDrawdown: 0.09,
      actualOrders: 0,
      privateAccountRequests: 0,
    },
  };
}

test('certificate is created only after unified promotion review passes and never grants order authority', () => {
  const input = evidence();
  const certificate = buildLiveProfitabilityPromotionCertificate({
    targetSha: SHA,
    record: record(),
    policy,
    ...input,
    createdAt: NOW,
  });
  const verified = verifyLiveProfitabilityPromotionCertificate(certificate, SHA);
  assert.equal(verified.status, 'PROMOTION_REVIEW_READY');
  assert.equal(verified.strategyId, STRATEGY);
  assert.equal(verified.gateVerdict.promotionEligible, true);
  assert.equal(verified.safety.orderAuthorityGranted, false);
  assert.equal(verified.safety.liveTradingActivated, false);
  assert.equal(verified.safety.realOrderSubmitted, false);
});

test('insufficient canonical paper evidence cannot produce a certificate', () => {
  const input = evidence();
  assert.throws(() => buildLiveProfitabilityPromotionCertificate({
    targetSha: SHA,
    record: record(),
    policy,
    ...input,
    paper: { ...input.paper, settledTrades: 0 },
    createdAt: NOW,
  }), /LIVE_PROFITABILITY_UNIFIED_GATE_BLOCKED/);
});

test('tampered certificate is rejected even when its promotion record still looks ready', () => {
  const certificate = buildLiveProfitabilityPromotionCertificate({
    targetSha: SHA,
    record: record(),
    policy,
    ...evidence(),
    createdAt: NOW,
  });
  const tampered = structuredClone(certificate) as any;
  tampered.record.identity.parameterHash = 'b'.repeat(64);
  assert.throws(
    () => verifyLiveProfitabilityPromotionCertificate(tampered, SHA),
    /LIVE_PROFITABILITY_CERTIFICATE_IDENTITY_INVALID|LIVE_PROFITABILITY_CERTIFICATE_DIGEST_MISMATCH/,
  );
});

test('runtime reader accepts only exact deployed SHA and exact strategy', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'live-profitability-cert-'));
  try {
    const certificate = buildLiveProfitabilityPromotionCertificate({
      targetSha: SHA,
      record: record(),
      policy,
      ...evidence(),
      createdAt: NOW,
    });
    const filePath = path.join(root, 'certificate.json');
    writeFileSync(filePath, JSON.stringify(certificate));
    const reader = createLiveProfitabilityPromotionReader({
      certificatePath: filePath,
      targetSha: SHA,
    });
    assert.equal(reader.get(STRATEGY)?.promotionState, 'PROMOTION_CANDIDATE');
    assert.equal(reader.get('other-strategy'), null);
    const stale = createLiveProfitabilityPromotionReader({
      certificatePath: filePath,
      targetSha: '2222222222222222222222222222222222222222',
    });
    assert.throws(() => stale.get(STRATEGY), /LIVE_PROFITABILITY_CERTIFICATE_IDENTITY_INVALID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
