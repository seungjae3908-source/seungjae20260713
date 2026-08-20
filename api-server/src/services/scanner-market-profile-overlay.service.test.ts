import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../sample/types';
import { applyScannerMarketProfile } from './scanner-market-profile-overlay.service';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import { StrategyPromotionService } from './strategy-promotion.service';
import {
  attachScannerCanonicalPaperIdentity,
  resolveScannerCanonicalPaperIdentity,
} from './scanner-canonical-paper-identity.service';

function candlesEndingAt(end: number, gapPercent = 0): Candle[] {
  const rows: Candle[] = Array.from({ length: 40 }, (_, index) => {
    const close = 100 + index * 0.2;
    return {
      time: end - (39 - index) * 60_000,
      open: close - 0.05,
      high: close + 0.3,
      low: close - 0.3,
      close,
      volume: index === 39 ? 220 : 100,
    };
  });
  if (gapPercent !== 0) {
    const previous = rows[38].close;
    rows[39] = {
      ...rows[39],
      open: previous * (1 + gapPercent / 100),
      high: previous * (1 + gapPercent / 100) + 0.5,
      low: Math.min(rows[39].low, previous * (1 + gapPercent / 100) - 0.2),
      close: previous * (1 + gapPercent / 100) + 0.2,
    };
  }
  return rows;
}

function card(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return {
    signalId: 'signal:test',
    assetClass: 'stock',
    market: 'KR',
    exchange: null,
    symbol: 'TEST',
    name: 'TEST',
    currency: 'KRW',
    assetType: 'STOCK',
    listingStatus: 'LISTED',
    price: 108,
    changePercent: 3,
    direction: 'LONG',
    signalState: 'WATCHING',
    score: 88,
    confidence: 85,
    dataCompleteness: 95,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 10_000_000_000,
    volume: 1_000_000,
    tradingValue: 10_000_000_000,
    spreadPercent: 0.08,
    volatilityPercent: 1.4,
    matched: [],
    notMatched: [],
    unverified: [],
    evidence: [],
    pricePlan: {
      entryZone: { from: 107, to: 108 },
      invalidation: 104,
      stopLoss: 104,
      targets: [114, 118],
      riskReward: 1.8,
    },
    dataState: 'complete',
    dataSources: ['test'],
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    strongSignalEligible: true,
    warnings: [],
    strategyMode: 'scalping',
    signalGrade: 'A',
    quantScore: {
      technical: 80,
      trend: 78,
      momentum: 76,
      volume: 82,
      liquidity: 85,
      volatility: 75,
      marketRegime: 80,
      risk: 82,
    },
    ...overrides,
  };
}

function marketEvidence(result: ScannerSignalCard) {
  return result.evidence.find((item) => item.key.startsWith('market-profile-v1:'));
}

test('KR regular-session profile preserves an already-strong liquid signal without raising its score', () => {
  const original = card();
  const result = applyScannerMarketProfile({
    card: original,
    profile: 'KR_STOCK',
    candles: candlesEndingAt(Date.UTC(2026, 7, 12, 1, 0)), // 10:00 KST
    strategyMode: 'scalping',
  });
  assert.equal(result.score, original.score);
  assert.equal(result.signalGrade, 'A');
  assert.equal(result.strongSignalEligible, true);
  assert.equal(marketEvidence(result)?.status, 'matched');
});

test('KR abnormal opening discontinuity fail-closes a strong candidate', () => {
  const result = applyScannerMarketProfile({
    card: card(),
    profile: 'KR_STOCK',
    candles: candlesEndingAt(Date.UTC(2026, 7, 12, 1, 0), 15),
    strategyMode: 'scalping',
  });
  assert.equal(result.strongSignalEligible, false);
  assert.equal(result.signalGrade, 'B');
  assert.ok(result.score <= 64);
  assert.equal(marketEvidence(result)?.status, 'not_matched');
});

test('US premarket remains research-visible but cannot preserve S/A intraday strength', () => {
  const result = applyScannerMarketProfile({
    card: card({ market: 'US', currency: 'USD' }),
    profile: 'US_STOCK',
    candles: candlesEndingAt(Date.UTC(2026, 7, 12, 12, 0)), // 08:00 EDT
    strategyMode: 'scalping',
  });
  assert.equal(result.strongSignalEligible, false);
  assert.equal(result.signalGrade, 'B');
  assert.ok(result.score <= 74);
  assert.ok(result.warnings.some((item) => item.includes('프리/애프터마켓')));
});

test('US regular-session profile may preserve an independently strong signal', () => {
  const result = applyScannerMarketProfile({
    card: card({ market: 'US', currency: 'USD' }),
    profile: 'US_STOCK',
    candles: candlesEndingAt(Date.UTC(2026, 7, 12, 14, 0)), // 10:00 EDT
    strategyMode: 'scalping',
  });
  assert.equal(result.strongSignalEligible, true);
  assert.equal(result.signalGrade, 'A');
  assert.equal(marketEvidence(result)?.status, 'matched');
});

test('crypto spot profile blocks SHORT even when the incoming card is strong', () => {
  const result = applyScannerMarketProfile({
    card: card({
      assetClass: 'coin_spot', market: 'UPBIT_KRW', exchange: 'UPBIT', assetType: 'CRYPTO_SPOT', direction: 'SHORT',
      currency: 'KRW', spreadPercent: 0.1,
    }),
    profile: 'CRYPTO_SPOT',
    candles: candlesEndingAt(Date.UTC(2026, 7, 12, 9, 0)),
    strategyMode: 'scalping',
  });
  assert.equal(result.strongSignalEligible, false);
  assert.equal(result.signalGrade, 'B');
  assert.ok(result.score <= 64);
});

test('crypto futures requires public funding and open-interest context before preserving strength', () => {
  const base = card({
    assetClass: 'coin_futures', market: 'BITGET_USDT_FUTURES', exchange: 'BITGET', assetType: 'CRYPTO_FUTURES',
    currency: 'USDT', direction: 'LONG', spreadPercent: 0.08,
  });
  const missing = applyScannerMarketProfile({
    card: base,
    profile: 'CRYPTO_FUTURES',
    candles: candlesEndingAt(Date.UTC(2026, 7, 12, 9, 0)),
    strategyMode: 'scalping',
  });
  assert.equal(missing.strongSignalEligible, false);
  assert.equal(missing.signalGrade, 'B');
  assert.equal(marketEvidence(missing)?.status, 'unverified');

  const complete = applyScannerMarketProfile({
    card: base,
    profile: 'CRYPTO_FUTURES',
    candles: candlesEndingAt(Date.UTC(2026, 7, 12, 9, 0)),
    strategyMode: 'scalping',
    fundingRate: 0.0001,
    openInterest: 5_000_000,
  });
  assert.equal(complete.strongSignalEligible, true);
  assert.equal(complete.signalGrade, 'A');
  assert.equal(marketEvidence(complete)?.status, 'matched');
});

test('crowded futures funding fail-closes same-direction chasing', () => {
  const result = applyScannerMarketProfile({
    card: card({
      assetClass: 'coin_futures', market: 'BITGET_USDT_FUTURES', exchange: 'BITGET', assetType: 'CRYPTO_FUTURES',
      currency: 'USDT', direction: 'LONG', spreadPercent: 0.08,
    }),
    profile: 'CRYPTO_FUTURES',
    candles: candlesEndingAt(Date.UTC(2026, 7, 12, 9, 0)),
    strategyMode: 'scalping',
    fundingRate: 0.001,
    openInterest: 5_000_000,
  });
  assert.equal(result.strongSignalEligible, false);
  assert.equal(result.signalGrade, 'B');
  assert.ok(result.score <= 64);
  assert.ok(result.warnings.some((item) => item.includes('펀딩 쏠림')));
});

test('market profile is confirmation-only and never raises a weak incoming score', () => {
  const result = applyScannerMarketProfile({
    card: card({ score: 60, signalGrade: 'C', strongSignalEligible: false }),
    profile: 'KR_STOCK',
    candles: candlesEndingAt(Date.UTC(2026, 7, 12, 1, 0)),
    strategyMode: 'scalping',
  });
  assert.equal(result.score, 60);
  assert.equal(result.signalGrade, 'C');
  assert.equal(result.strongSignalEligible, false);
});

const CANONICAL_SHA = 'c'.repeat(40);
const CANONICAL_OBSERVED_AT = '2026-08-20T00:00:00.000Z';

function canonicalCard(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  return card({
    signalId: 'canonical-paper-1',
    action: 'BUY',
    observedAt: CANONICAL_OBSERVED_AT,
    expiresAt: '2026-08-20T04:00:00.000Z',
    strategyMode: 'swing',
    ...overrides,
  });
}

test('canonical Paper identity forwards exact KR SWING Promotion identity and cost policy', () => {
  const source = new StrategyPromotionService({ sourceSha: CANONICAL_SHA })
    .list({ market: 'KR_STOCK', strategyHorizon: 'SWING', direction: 'BUY' }).items[0];
  assert.ok(source);
  const result = resolveScannerCanonicalPaperIdentity({
    card: canonicalCard(),
    market: 'KR_STOCK',
    researchCodeSha: CANONICAL_SHA,
  });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.paperCandidate);
  assert.equal(result.paperCandidate.signal.style, 'SWING');
  assert.equal(result.paperCandidate.signal.timeframe, '60m');
  assert.equal(result.paperCandidate.signal.horizon, 4);
  assert.equal(result.paperCandidate.signal.direction, 'BUY');
  assert.deepEqual(result.paperCandidate.signal.strategyIdentity, {
    strategyId: source.identity.strategyId,
    strategyVersion: source.identity.strategyVersion,
    parameterHash: source.identity.parameterHash,
    researchCodeSha: source.identity.researchCodeSha,
    costPolicyVersion: source.identity.costPolicyVersion,
  });
  assert.equal(result.paperCandidate.executionAuthority, 'NONE');
  assert.equal(result.paperCandidate.liveOrderAllowed, false);
  assert.equal(result.paperCandidate.privateTradingApiAllowed, false);
  assert.equal(result.paperCandidate.orderSubmitted, false);
  assert.equal(result.paperCandidate.exchangeRequestSent, false);
});

test('canonical Paper identity accepts the actual CRYPTO_SPOT card market and preserves SWING 4H', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: canonicalCard({
      assetClass: 'coin_spot', market: 'UPBIT_KRW', exchange: 'UPBIT', symbol: 'BTC', currency: 'KRW', assetType: 'CRYPTO_SPOT',
    }),
    market: 'CRYPTO_SPOT',
    researchCodeSha: CANONICAL_SHA,
  });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.paperCandidate);
  assert.equal(result.paperCandidate.signal.timeframe, '4H');
  assert.equal(result.paperCandidate.signal.horizon, 1);
  assert.equal(result.paperCandidate.signal.style, 'SWING');
});

test('canonical Paper identity accepts the actual CRYPTO_FUTURES card market and supports SCALP 5m', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: canonicalCard({
      assetClass: 'coin_futures', market: 'BITGET_USDT_FUTURES', exchange: 'BITGET', symbol: 'BTCUSDT', currency: 'USDT', assetType: 'CRYPTO_FUTURES',
      action: 'LONG', strategyMode: 'scalping', expiresAt: '2026-08-20T00:15:00.000Z',
    }),
    market: 'CRYPTO_FUTURES',
    researchCodeSha: CANONICAL_SHA,
  });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.paperCandidate);
  assert.equal(result.paperCandidate.signal.timeframe, '5m');
  assert.equal(result.paperCandidate.signal.horizon, 3);
  assert.equal(result.paperCandidate.signal.style, 'SCALPING');
  assert.equal(result.paperCandidate.signal.direction, 'LONG');
});

test('canonical Paper identity maps POSITION to MID_LONG with canonical 1D stock timeframe', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: canonicalCard({ strategyMode: 'position', expiresAt: '2026-08-22T00:00:00.000Z' }),
    market: 'KR_STOCK',
    researchCodeSha: CANONICAL_SHA,
  });
  assert.deepEqual(result.blockers, []);
  assert.ok(result.paperCandidate);
  assert.equal(result.paperCandidate.signal.style, 'MID_LONG');
  assert.equal(result.paperCandidate.signal.timeframe, '1D');
  assert.equal(result.paperCandidate.signal.horizon, 2);
});

test('canonical Paper identity fails closed for non-divisible profile horizon', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: canonicalCard({
      assetClass: 'coin_spot', market: 'UPBIT_KRW', exchange: 'UPBIT', symbol: 'BTC', currency: 'KRW', assetType: 'CRYPTO_SPOT',
      expiresAt: '2026-08-20T05:00:00.000Z',
    }),
    market: 'CRYPTO_SPOT',
    researchCodeSha: CANONICAL_SHA,
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('SCANNER_CANONICAL_HORIZON_REQUIRED'));
});

test('canonical Paper identity fails closed for missing strategy mode and explicit action', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: canonicalCard({ strategyMode: undefined, action: 'NONE' }),
    market: 'KR_STOCK',
    researchCodeSha: CANONICAL_SHA,
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('SCANNER_STRATEGY_MODE_REQUIRED'));
  assert.ok(result.blockers.includes('SCANNER_EXPLICIT_ACTION_REQUIRED'));
});

test('canonical Paper identity fails closed for market mismatch', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: canonicalCard({ market: 'US' }),
    market: 'KR_STOCK',
    researchCodeSha: CANONICAL_SHA,
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('SCANNER_MARKET_MISMATCH'));
});

test('canonical Paper identity fails closed for ambiguous Promotion identity', () => {
  const source = new StrategyPromotionService({ sourceSha: CANONICAL_SHA })
    .list({ market: 'KR_STOCK', strategyHorizon: 'SWING', direction: 'BUY' }).items[0];
  assert.ok(source);
  const result = resolveScannerCanonicalPaperIdentity({
    card: canonicalCard(),
    market: 'KR_STOCK',
    researchCodeSha: CANONICAL_SHA,
    promotionRecords: [source, source],
  });
  assert.equal(result.paperCandidate, null);
  assert.ok(result.blockers.includes('CANONICAL_PROMOTION_IDENTITY_AMBIGUOUS'));
});

test('canonical Paper identity requires immutable research SHA', () => {
  const result = resolveScannerCanonicalPaperIdentity({
    card: canonicalCard(),
    market: 'KR_STOCK',
    researchCodeSha: 'not-a-sha',
  });
  assert.equal(result.paperCandidate, null);
  assert.deepEqual(result.blockers, ['IMMUTABLE_RESEARCH_SHA_REQUIRED']);
});

test('canonical Paper identity response attachment preserves existing scanner fields', () => {
  const response = { cards: [canonicalCard()] } as ScannerResponse;
  const enriched = attachScannerCanonicalPaperIdentity({
    response,
    market: 'KR_STOCK',
    researchCodeSha: CANONICAL_SHA,
  });
  const output = enriched.cards[0] as ScannerSignalCard & { paperCandidate?: unknown };
  assert.ok(output.paperCandidate);
  assert.equal(output.signalId, response.cards[0]!.signalId);
  assert.equal(output.score, response.cards[0]!.score);
});
