import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../sample/types';
import { applyScannerMarketProfile } from './scanner-market-profile-overlay.service';
import type { ScannerSignalCard } from './scanner-signal.types';

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