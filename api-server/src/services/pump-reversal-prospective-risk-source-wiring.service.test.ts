import assert from 'node:assert/strict';
import test from 'node:test';

import type { BitgetFuturesPublicEvidence } from './bitget-futures-public-evidence.service';
import { createPaperTradingState } from './paper-trading-core.service';
import { createImmutablePaperTradingStateSnapshot } from './paper-trading-state-snapshot.service';
import {
  createPumpReversalPublicRiskSourceWiring,
  PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_SAFETY,
} from './pump-reversal-prospective-risk-source-wiring.service';

const NOW = 1_800_000_000_000;
const SHA = 'a'.repeat(40);
const PUBLISHER = 'b'.repeat(64);

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

function paperSnapshot() {
  const state = createPaperTradingState(10_000, new Date(NOW - 1_000));
  state.updatedAt = new Date(NOW - 1_000).toISOString();
  state.account.updatedAt = state.updatedAt;
  return createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: 'pump-test-owner',
    sourceSha: SHA,
    market: 'CRYPTO_FUTURES',
    currency: 'USDT',
    provenance: ['test-paper-state'],
    publisherAccountIdSha256: PUBLISHER,
    observedAtMs: NOW,
    maximumAgeMs: 30_000,
  });
}

function publicEvidence(): BitgetFuturesPublicEvidence {
  return {
    provider: 'bitget',
    productType: 'USDT-FUTURES',
    symbol: 'ALTUSDT',
    lastPrice: 100,
    bidPrice: 99.9,
    askPrice: 100.1,
    markPrice: 100,
    indexPrice: 100,
    tickerTimestampMs: NOW,
    fundingRate: 0.0001,
    fundingIntervalHours: 8,
    nextFundingUpdateMs: NOW + 8 * 60 * 60 * 1000,
    openInterest: 1000,
    openInterestTimestampMs: NOW,
    minTradeNum: 0.001,
    sizeMultiplier: 0.001,
    minTradeUsdt: 5,
    priceStep: 0.01,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0006,
    minLeverage: 1,
    maxLeverage: 20,
    candles5m: [],
    candles1h: [],
    benchmarkBtc1h: [],
    benchmarkBtc1d: [],
    observedAtMs: NOW,
    dataQuality: 'ready',
  };
}

function supplemental() {
  const component = (valuePercent: number, name: string) => ({
    valuePercent,
    quality: 'ESTIMATED' as const,
    source: name,
    observedAtMs: NOW,
  });
  return {
    costPolicyId: 'pump-cost-v1',
    observedAtMs: NOW,
    latency: component(0.01, 'latency'),
    liquidityImpact: component(0.02, 'liquidity'),
    partialFillImpact: component(0.01, 'partial-fill'),
    funding: component(0.03, 'funding'),
  };
}

test('wiring derives maintenance margin from the public tier at the 1% maximum probe notional', async () => {
  const urls: string[] = [];
  const wiring = createPumpReversalPublicRiskSourceWiring({
    researchCodeSha: SHA,
    paperStateSnapshotForRecord: async () => paperSnapshot(),
    supplementalCostEvidenceForRecord: async () => supplemental(),
    publicEvidenceForRecord: async () => publicEvidence(),
    now: () => NOW,
    fetchPublicJson: async (url) => {
      urls.push(String(url));
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/query-position-lever')) {
        return {
          code: '00000',
          data: [
            { startUnit: '0', keepMarginRate: '0.005' },
            { startUnit: '1000', keepMarginRate: '0.01' },
          ],
        };
      }
      if (parsed.pathname.endsWith('/orderbook')) {
        return {
          code: '00000',
          data: {
            ts: String(NOW),
            b: [['99.9', '10']],
            a: [['100.1', '10']],
          },
        };
      }
      throw new Error('UNEXPECTED_URL:' + parsed.pathname);
    },
  });

  const owner = wiring.createOwner();
  const result = await owner({ record: record(), observedAtMs: NOW });
  assert.equal(result.status, 'READY');
  if (result.status !== 'READY') throw new Error(result.blockers.join(','));
  assert.equal(result.riskInput?.maintenanceMarginRate, 0.005);
  assert.equal(result.maximumProbeNotional, 100);
  assert.equal(result.riskPercent, 0.25);
  assert.equal(result.leverage, 2);
  assert.equal(result.marginMode, 'isolated');
  assert.ok(urls.some((url) => url.includes('/query-position-lever')));
  assert.ok(urls.some((url) => url.includes('/orderbook')));
  assert.equal(wiring.executionAuthority, 'NONE');
});

test('wiring fails closed when the public position-tier schedule is missing', async () => {
  const wiring = createPumpReversalPublicRiskSourceWiring({
    researchCodeSha: SHA,
    paperStateSnapshotForRecord: async () => paperSnapshot(),
    supplementalCostEvidenceForRecord: async () => supplemental(),
    publicEvidenceForRecord: async () => publicEvidence(),
    now: () => NOW,
    fetchPublicJson: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/query-position-lever')) {
        return { code: '00000', data: [] };
      }
      if (parsed.pathname.endsWith('/orderbook')) {
        return { code: '00000', data: { ts: String(NOW), b: [['99.9', '10']], a: [['100.1', '10']] } };
      }
      throw new Error('UNEXPECTED_URL');
    },
  });
  const result = await wiring.createOwner()({ record: record(), observedAtMs: NOW });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('PUMP_RISK_OWNER_AUTHORITATIVE_SOURCE_FAILED'));
  assert.equal(result.executionAuthority, 'NONE');
});

test('safety contract keeps every trading authority disabled', () => {
  assert.equal(PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_SAFETY.riskPercent, 0.25);
  assert.equal(PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_SAFETY.leverage, 2);
  assert.equal(PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_SAFETY.marginMode, 'isolated');
  assert.equal(PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_SAFETY.liveTrading, false);
  assert.equal(PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_SAFETY.privateTradingApiAllowed, false);
  assert.equal(PUMP_REVERSAL_PUBLIC_RISK_SOURCE_WIRING_SAFETY.financialMutationAllowed, false);
});
