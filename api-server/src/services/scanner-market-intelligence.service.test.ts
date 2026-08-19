import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichScannerCardsWithMarketIntelligence } from './scanner-market-intelligence.service';
import { marketIntelligenceNotAvailable, type MarketIntelligenceSummary } from './market-intelligence-client.service';
import type { ScannerSignalCard } from './scanner-signal.types';

function card(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return {
    signalId: 'sig-1', assetClass: 'coin_futures', market: 'futures', exchange: 'bitget', symbol: 'BTCUSDT',
    name: 'BTC', currency: 'USDT', assetType: 'crypto', listingStatus: 'LISTED', price: 100,
    changePercent: 0, direction: 'LONG', signalState: 'CONFIRMED', score: 80, confidence: 80,
    dataCompleteness: 100, riskScore: 20, riskLevel: 'LOW', liquidity: 100, volume: 100,
    tradingValue: 100, spreadPercent: 0.01, volatilityPercent: 1, matched: [], notMatched: [], unverified: [],
    evidence: [], pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
    dataState: 'complete', dataSources: ['test'], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    strongSignalEligible: true, warnings: [], signalGrade: 'A',
    ...overrides,
  };
}

function ready(input: { adjustment: number; mode: 'PAPER_ONLY' | 'BLOCKED_RISK' | 'ELIGIBLE_FOR_PARENT_GATE'; hardBlockReason?: string }): MarketIntelligenceSummary {
  return {
    status: 'READY', market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', serviceSha: 'sha', reason: null,
    scanner: {
      mode: 'SOFT_INTELLIGENCE_LAYER', adjustment: input.adjustment, intelligenceScore: 70,
      bullishScore: 70, bearishScore: 30, hardBlockReason: input.hardBlockReason ?? null,
      candidateDeletionAllowed: false,
    },
    autoTrading: {
      mode: input.mode, orderAllowed: false, evidenceReady: false, parentEligibilityReady: false,
      hardBlockReason: input.hardBlockReason ?? null,
    },
    warnings: [],
  };
}

test('matching microstructure adjusts scanner score without deleting the candidate', async () => {
  const [result] = await enrichScannerCardsWithMarketIntelligence([card()], async () => ready({ adjustment: 10, mode: 'PAPER_ONLY' }));
  assert.equal(result.score, 90);
  assert.equal(result.marketIntelligence.baseScore, 80);
  assert.equal(result.marketIntelligence.directionalAdjustment, 10);
  assert.equal(result.strongSignalEligible, true);
  assert.equal(result.marketIntelligence.autoTrading.orderAllowed, false);
});

test('short direction reverses bullish adjustment', async () => {
  const [result] = await enrichScannerCardsWithMarketIntelligence([card({ direction: 'SHORT' })], async () => ready({ adjustment: 10, mode: 'PAPER_ONLY' }));
  assert.equal(result.score, 70);
  assert.equal(result.marketIntelligence.directionalAdjustment, -10);
});

test('BLOCKED_RISK demotes strong eligibility but preserves scanner candidate', async () => {
  const [result] = await enrichScannerCardsWithMarketIntelligence([card()], async () => ready({
    adjustment: -5, mode: 'BLOCKED_RISK', hardBlockReason: 'STALE_INTELLIGENCE_DATA',
  }));
  assert.equal(result.strongSignalEligible, false);
  assert.equal(result.signalState, 'WEAKENED');
  assert.equal(result.symbol, 'BTCUSDT');
  assert.ok(result.warnings.includes('MI_BLOCK:STALE_INTELLIGENCE_DATA'));
});

test('unavailable Market Intelligence is fail-soft and keeps original score', async () => {
  const [result] = await enrichScannerCardsWithMarketIntelligence([card()], async () =>
    marketIntelligenceNotAvailable('CRYPTO_FUTURES', 'BTCUSDT', 'SIDECAR_DOWN'));
  assert.equal(result.score, 80);
  assert.equal(result.strongSignalEligible, true);
  assert.equal(result.marketIntelligence.status, 'NOT_AVAILABLE');
  assert.ok(result.warnings.includes('MI:SIDECAR_DOWN'));
});
