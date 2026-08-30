import { expect, test } from '@playwright/test';
import type { Candle } from '../../api-server/src/sample/types';
import type { ScanCard } from '../../api-server/src/services/signal.service';
import {
  applyStockSignalPolicy,
  selectedConditionTruth,
} from '../../api-server/src/services/scanner-signal-policy.service';
import type { ScannerUniverseEntry } from '../../api-server/src/services/scanner-universe.service';

function candle(index: number, close: number, volume = 100, high = close + 1): Candle {
  return {
    time: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    open: close,
    high,
    low: Math.max(0.01, close - 1),
    close,
    volume,
  };
}

function risingValueCandles(): Candle[] {
  return Array.from({ length: 40 }, (_, index) => candle(index, index < 20 ? 100 : 150, 100));
}

function maCrossCandles(period: number, crossed: boolean): Candle[] {
  const closes = Array.from({ length: period + 1 }, () => 100);
  if (crossed) {
    closes[period] = 120;
  } else {
    closes[period - 1] = 120;
    closes[period] = 130;
  }
  return closes.map((close, index) => candle(index, close));
}

const universeEntry: ScannerUniverseEntry = {
  ticker: 'TEST',
  name: 'Test Corp',
  market: 'US',
  currency: 'USD',
  assetType: 'STOCK',
  exchange: 'NASDAQ',
  listingStatus: 'LISTED',
  source: 'finnhub-symbol-master',
};

function card(overrides: Partial<ScanCard> = {}): ScanCard {
  const analyzedAt = '2026-02-10T00:00:00.000Z';
  const ok = (score: number, reason: string) => ({ score, status: 'ok' as const, reasons: [reason] });
  return {
    ticker: 'TEST',
    name: 'Test Corp',
    market: 'US',
    currency: 'USD',
    assetType: 'STOCK',
    price: 100,
    changePercent: 1,
    score: 90,
    confidence: 90,
    matched: [],
    missing: [],
    breakoutProbability: null,
    expectedPeriod: 'test',
    entry: ['test'],
    stop: ['test'],
    matchCount: 0,
    selectedCount: 0,
    riskLevel: 'LOW',
    riskScore: 10,
    liquidity: 1_000_000,
    marketCap: 1_000_000_000,
    dataState: 'ok',
    analyzedAt,
    quoteObservedAt: analyzedAt,
    quoteSource: 'condition-test-fixture',
    scoreBreakdown: {
      trend: ok(90, 'trend'),
      volume: ok(90, 'volume'),
      liquidity: ok(90, 'liquidity'),
      technical: ok(90, 'technical'),
      news: ok(90, 'news'),
      financial: ok(90, 'financial'),
      market: ok(90, 'market'),
      risk: ok(100, 'risk'),
    },
    ...overrides,
  };
}

test('sample or unavailable financial evidence cannot stay matched just because legacy ScanCard says it matched', () => {
  const input = card({
    matched: ['PER 낮음'],
    scoreBreakdown: {
      ...card().scoreBreakdown,
      financial: { score: null, status: 'unavailable', reasons: ['sample financial fallback is not measured live evidence'] },
    },
  });
  const result = applyStockSignalPolicy({
    memberId: 'member-test',
    card: input,
    universeEntry,
    candles: risingValueCandles(),
    selected: ['PER 낮음'],
    timeframe: '1D',
    now: Date.parse('2026-02-10T00:00:00.000Z'),
  });

  expect(result.matched).not.toContain('PER 낮음');
  expect(result.unverified).toContain('PER 낮음');
  expect(result.evidence.find((item) => item.label === 'PER 낮음')?.status).toBe('unverified');
  expect(result.strongSignalEligible).toBe(false);
});

test('trading-value increase uses price times volume instead of volume alone', () => {
  expect(selectedConditionTruth('거래대금 증가', risingValueCandles())).toBe(true);
  const flat = Array.from({ length: 40 }, (_, index) => candle(index, 100, 100));
  expect(selectedConditionTruth('거래대금 증가', flat)).toBe(false);
  expect(selectedConditionTruth('거래대금 증가', flat.slice(-39))).toBeNull();

  const result = applyStockSignalPolicy({
    memberId: 'member-test',
    card: card({ matched: ['거래대금 증가'] }),
    universeEntry,
    candles: risingValueCandles(),
    selected: ['거래대금 증가'],
    timeframe: '1D',
    now: Date.parse('2026-02-10T00:00:00.000Z'),
  });
  expect(result.evidence.find((item) => item.label === '거래대금 증가')).toMatchObject({
    status: 'matched',
    source: 'market-candles-volume',
  });
});

test('unavailable factor cannot describe unverified candle truth as confirmed', () => {
  const input = card({
    matched: ['거래대금 증가'],
    scoreBreakdown: {
      ...card().scoreBreakdown,
      liquidity: { score: null, status: 'unavailable', reasons: ['liquidity factor unavailable'] },
    },
  });
  const result = applyStockSignalPolicy({
    memberId: 'member-test',
    card: input,
    universeEntry,
    candles: risingValueCandles(),
    selected: ['거래대금 증가'],
    timeframe: '1D',
    now: Date.parse('2026-02-10T00:00:00.000Z'),
  });
  const evidence = result.evidence.find((item) => item.label === '거래대금 증가');
  expect(evidence).toMatchObject({
    status: 'unverified',
    source: 'market-candles-volume',
    reasons: ['liquidity factor unavailable'],
  });
  expect(evidence?.reasons.join(' ')).not.toContain('조건을 확인했습니다');
  expect(result.strongSignalEligible).toBe(false);
});

test('an analysis timestamp alone cannot confirm candle conditions without the source quote time', () => {
  const result = applyStockSignalPolicy({
    memberId: 'member-test', card: card({ quoteObservedAt: null, matched: ['거래대금 증가'] }),
    universeEntry, candles: risingValueCandles(), selected: ['거래대금 증가'], timeframe: '1D',
    now: Date.parse('2026-02-10T00:00:00.000Z'),
  });
  expect(result.evidence.find((item) => item.label === '거래대금 증가')).toMatchObject({ status: 'unverified', observedAt: null });
  expect(result.strongSignalEligible).toBe(false);
  expect(result.pricePlan.entryZone).toBeNull();
});

test('MA20 MA60 and MA120 labels require a fresh prior-to-current upward cross', () => {
  const cases: Array<[string, number]> = [
    ['이평선 돌파', 20],
    ['20일선 회복', 20],
    ['60일선 돌파', 60],
    ['120일선 돌파', 120],
  ];
  for (const [label, period] of cases) {
    expect(selectedConditionTruth(label, maCrossCandles(period, true))).toBe(true);
    expect(selectedConditionTruth(label, maCrossCandles(period, false))).toBe(false);
    expect(selectedConditionTruth(label, maCrossCandles(period, true).slice(1))).toBeNull();
  }
});

test('RSI overheat is driven by actual RSI(14), not aggregate score or one-day move', () => {
  const rising = Array.from({ length: 20 }, (_, index) => candle(index, 100 + index));
  const falling = Array.from({ length: 20 }, (_, index) => candle(index, 120 - index));
  expect(selectedConditionTruth('RSI 과열', rising)).toBe(true);
  expect(selectedConditionTruth('RSI 과열', falling)).toBe(false);
  expect(selectedConditionTruth('RSI 과열', rising.slice(0, 14))).toBeNull();
});

test('box and resistance breakout compare close against prior 60-bar resistance excluding current candle', () => {
  const rows = Array.from({ length: 60 }, (_, index) => candle(index, 95, 100, 100));
  rows.push(candle(60, 105, 100, 120));

  expect(selectedConditionTruth('박스권 상단 돌파', rows)).toBe(true);
  expect(selectedConditionTruth('저항선 돌파', rows)).toBe(true);
  expect(selectedConditionTruth('박스권 상단 돌파', rows.slice(1))).toBeNull();
});

test('ROE improvement fails closed until historical ROE trend evidence is explicitly available', () => {
  expect(selectedConditionTruth('ROE 개선', risingValueCandles())).toBeNull();
});
