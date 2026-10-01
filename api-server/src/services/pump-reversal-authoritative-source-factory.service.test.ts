import assert from 'node:assert/strict';
import test from 'node:test';

import { createPaperTradingState } from './paper-trading-core.service';
import { createImmutablePaperTradingStateSnapshot } from './paper-trading-state-snapshot.service';
import { createPumpReversalProspectiveRiskOwnerFromAuthoritativeSources } from './pump-reversal-authoritative-source-factory.service';

const NOW = 1_800_000_000_000;
const SHA = 'a'.repeat(40);
const PUBLISHER = 'b'.repeat(64);

function paperSnapshot() {
  const state = createPaperTradingState(1_000_000, new Date(NOW - 1_000));
  state.updatedAt = new Date(NOW - 1_000).toISOString();
  state.account.updatedAt = state.updatedAt;
  return createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: 'pump-test-paper-owner',
    sourceSha: SHA,
    market: 'CRYPTO_FUTURES',
    currency: 'USDT',
    provenance: ['test-paper-state'],
    publisherAccountIdSha256: PUBLISHER,
    observedAtMs: NOW,
    maximumAgeMs: 30_000,
  });
}

function record() {
  return {
    status: 'OPEN' as const,
    observation: {
      candidateId: 'paper-candidate-v1:' + 'c'.repeat(64),
      candidateDigest: 'd'.repeat(64),
      policyDigest: 'e'.repeat(64),
      symbol: 'ALTUSDT',
    },
    signal: {
      strategyId: 'CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1',
      market: 'CRYPTO_FUTURES' as const,
      direction: 'SHORT' as const,
      symbol: 'ALTUSDT',
      signalId: 'f'.repeat(64),
      parameterHash: '1'.repeat(64),
    },
    position: {
      positionId: '2'.repeat(64),
      entryTimestampMs: NOW - 5_000,
      entryPrice: 100,
      stopPrice: 125,
      timeExitAtMs: NOW + 72 * 60 * 60 * 1000,
      actualExchangeFillClaim: false as const,
    },
  };
}

function publicEvidence(input: any) {
  return {
    provider: 'bitget',
    productType: 'USDT-FUTURES',
    symbol: 'ALTUSDT',
    lastPrice: 100,
    bidPrice: 99.9,
    askPrice: 100.1,
    markPrice: 100,
    indexPrice: 100,
    tickerTimestampMs: input.nowMs,
    fundingRate: 0.0001,
    fundingIntervalHours: 8,
    nextFundingUpdateMs: input.nowMs + 8 * 60 * 60 * 1000,
    openInterest: 1_000,
    openInterestTimestampMs: input.nowMs,
    minTradeNum: 0.001,
    sizeMultiplier: 0.001,
    minTradeUsdt: 5,
    priceStep: 0.1,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0006,
    minLeverage: 1,
    maxLeverage: 20,
    candles5m: [],
    candles1h: [],
    benchmarkBtc1h: [],
    benchmarkBtc1d: [],
    observedAtMs: input.nowMs,
    dataQuality: 'ready',
  };
}

function readySizing() {
  return Object.freeze({
    status: 'READY' as const,
    version: 'pump-reversal-paper-risk-sizing-v1' as const,
    blockers: Object.freeze([]),
    riskInput: null,
    riskResult: Object.freeze({
      allowed: true,
      blockCodes: Object.freeze([]),
      recommendedQuantity: 1,
      actualRiskPercent: 0.2,
      calculatedAt: new Date(NOW + 100).toISOString(),
    }) as any,
    maximumProbeNotional: 10_000,
    maximumProbeQuantity: 100,
    observedSlippagePercent: 0.1,
    observedSpreadPercent: 0.2,
    conservativeFundingRiskRate: 0.0009,
    finalQuantity: 1,
    finalNotional: 100,
    riskPercent: 0.25 as const,
    leverage: 2 as const,
    marginMode: 'isolated' as const,
    fundingDirectionalFilterUsed: false as const,
    fundingCountsAsProfitabilityEvidence: false as const,
    simulatedOnly: true as const,
    canonicalProfitAdmissionEligible: false as const,
    profitabilityClaimAllowed: false as const,
    executionAuthority: 'NONE' as const,
    liveOrderAllowed: false as const,
    privateTradingApiAllowed: false as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
  });
}

function supplemental() {
  return {
    costPolicyId: 'pump-cost-v1',
    observedAtMs: NOW,
    latency: { valuePercent: 0.01, quality: 'ESTIMATED', source: 'latency', observedAtMs: NOW },
    liquidityImpact: { valuePercent: 0.02, quality: 'ESTIMATED', source: 'liquidity', observedAtMs: NOW },
    partialFillImpact: { valuePercent: 0.01, quality: 'ESTIMATED', source: 'partial', observedAtMs: NOW },
    funding: { valuePercent: 0, quality: 'OBSERVED', source: 'funding', observedAtMs: NOW },
  } as any;
}

test('authoritative factory shares one market bundle and sizes the tier at the 1% nominal cap', async () => {
  let publicCalls = 0;
  let executionCalls = 0;
  let sizeCalls = 0;
  let seenSizingInput: any = null;

  const owner = createPumpReversalProspectiveRiskOwnerFromAuthoritativeSources({
    researchCodeSha: SHA,
    sources: {
      paperStateSnapshotForRecord: async () => paperSnapshot(),
      supplementalCostEvidenceForRecord: async () => supplemental(),
    },
    dependencies: {
      now: () => NOW + 100,
      fetchPublicJson: async (url) => {
        publicCalls += 1;
        if (url.pathname.endsWith('/query-position-lever')) {
          return {
            code: '00000',
            data: [
              { startUnit: '0', keepMarginRate: '0.005' },
              { startUnit: '5000', keepMarginRate: '0.010' },
            ],
          };
        }
        return { code: '00000', data: [] };
      },
      buildPublicEvidence: ((input: any) => publicEvidence(input)) as any,
      collectExecutionInput: (async ({ sizingEvidence }: any) => {
        executionCalls += 1;
        assert.equal(sizingEvidence.targetQuantity, 100);
        return {
          executionEvidenceInput: {
            source: 'BITGET_PUBLIC_UTA_V3_ORDERBOOK',
            market: 'CRYPTO_FUTURES',
            symbol: 'ALTUSDT',
            direction: 'SHORT',
            targetQuantity: 100,
            bids: [[99.9, 200]],
            asks: [[100.1, 200]],
            observedAtMs: NOW,
            requestStartedAtMs: NOW,
            requestCompletedAtMs: NOW + 50,
            maximumAgeMs: 30_000,
            provenance: ['SIMULATED', 'public-L2', 'bitget-public-uta-v3-orderbook'],
            calibratedFillModel: null,
          },
          riskPolicy: sizingEvidence.riskPolicy,
          nowMs: NOW + 50,
        };
      }) as any,
      sizeRisk: ((input: any) => {
        sizeCalls += 1;
        seenSizingInput = input;
        return readySizing();
      }) as any,
    },
  });

  const result = await owner({ record: record(), observedAtMs: NOW });
  assert.equal(result.status, 'READY');
  assert.equal(sizeCalls, 1);
  assert.equal(executionCalls, 1);
  // 8 public evidence requests + 1 tier request. The three owner callbacks share this same bundle.
  assert.equal(publicCalls, 9);
  assert.equal(seenSizingInput.contractRules.maintenanceMarginRate, 0.01);
  assert.equal(seenSizingInput.contractRules.quantityPrecision, 3);
  assert.equal(seenSizingInput.depth.provenance.includes('public-L2'), true);
  assert.equal(seenSizingInput.nowMs, NOW + 100);
});

test('decreasing maintenance-margin tiers fail closed before the Risk Engine', async () => {
  let sizeCalls = 0;
  const owner = createPumpReversalProspectiveRiskOwnerFromAuthoritativeSources({
    researchCodeSha: SHA,
    sources: {
      paperStateSnapshotForRecord: async () => paperSnapshot(),
      supplementalCostEvidenceForRecord: async () => supplemental(),
    },
    dependencies: {
      now: () => NOW + 100,
      fetchPublicJson: async (url) => {
        if (url.pathname.endsWith('/query-position-lever')) {
          return {
            code: '00000',
            data: [
              { startUnit: '0', keepMarginRate: '0.010' },
              { startUnit: '5000', keepMarginRate: '0.005' },
            ],
          };
        }
        return { code: '00000', data: [] };
      },
      buildPublicEvidence: ((input: any) => publicEvidence(input)) as any,
      collectExecutionInput: (async ({ sizingEvidence }: any) => ({
        executionEvidenceInput: {
          source: 'BITGET_PUBLIC_UTA_V3_ORDERBOOK',
          market: 'CRYPTO_FUTURES',
          symbol: 'ALTUSDT',
          direction: 'SHORT',
          targetQuantity: sizingEvidence.targetQuantity,
          bids: [[99.9, 200]],
          asks: [[100.1, 200]],
          observedAtMs: NOW,
          requestStartedAtMs: NOW,
          requestCompletedAtMs: NOW + 50,
          maximumAgeMs: 30_000,
          provenance: ['SIMULATED', 'public-L2'],
          calibratedFillModel: null,
        },
        riskPolicy: sizingEvidence.riskPolicy,
        nowMs: NOW + 50,
      })) as any,
      sizeRisk: ((input: any) => {
        sizeCalls += 1;
        return input;
      }) as any,
    },
  });

  const result = await owner({ record: record(), observedAtMs: NOW });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, ['PUMP_RISK_OWNER_AUTHORITATIVE_SOURCE_FAILED']);
  assert.equal(sizeCalls, 0);
  assert.equal(result.executionAuthority, 'NONE');
});
