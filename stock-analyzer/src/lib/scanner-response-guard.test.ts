import { describe, expect, it } from 'vitest';
import { validateScannerResponse } from './scanner-response-guard';

const NOW = Date.parse('2026-09-09T14:20:00.000Z');

const canonicalCard = {
  signalId: 'signal:005930',
  assetClass: 'stock',
  market: 'KR',
  exchange: 'KRX',
  symbol: '005930',
  name: '삼성전자',
  currency: 'KRW',
  assetType: 'STOCK',
  listingStatus: 'LISTED',
  price: 70000,
  changePercent: null,
  direction: 'LONG',
  action: 'BUY',
  signalState: 'DETECTED',
  score: 80,
  confidence: 75,
  dataCompleteness: 92,
  riskScore: 22,
  riskLevel: 'LOW',
  liquidity: 1_000_000_000,
  volume: 1_000_000,
  tradingValue: 70_000_000_000,
  spreadPercent: null,
  volatilityPercent: 1.2,
  matched: ['거래량 증가'],
  notMatched: [],
  unverified: ['AI 점수 상위'],
  evidence: [{
    key: '거래량 증가',
    label: '거래량 증가',
    status: 'matched',
    source: 'market-candles-volume',
    observedAt: '2026-09-09T14:00:00.000Z',
    reasons: ['실제 거래량 증가를 확인했습니다.'],
  }],
  pricePlan: {
    entryZone: { from: 69000, to: 70000 },
    invalidation: 67000,
    stopLoss: 67000,
    targets: [74500, 77000],
    riskReward: 1.5,
  },
  dataState: 'complete',
  dataSources: ['market-quote', 'market-candles'],
  observedAt: '2026-09-09T14:00:00.000Z',
  expiresAt: '2026-09-12T14:00:00.000Z',
  strongSignalEligible: false,
  warnings: [],
};

function response(cards: unknown[] = [], outcome = cards.length ? 'CANDIDATES_AVAILABLE' : 'VALID_ZERO_SIGNAL') {
  return {
    ok: true,
    requestId: 'scan-request-1',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards,
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 10,
      startedCount: 10,
      completedCount: 10,
      excludedCount: cards.length ? 9 : 10,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 100,
      deadlineMs: 8500,
      itemTimeoutMs: 4000,
      maxConcurrency: 6,
    },
    universe: {
      totalCount: 10,
      cursor: 0,
      nextCursor: null,
      source: 'krx-symbol-master',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    outcome,
    message: cards.length ? '후보 1개' : '조건을 통과한 후보가 없습니다.',
    generatedAt: '2026-09-09T14:19:30.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

const expectation = {
  selected: ['거래량 증가', 'AI 점수 상위'],
  market: 'KR',
  timeframe: '1D',
  now: NOW,
};

describe('validateScannerResponse', () => {
  it('rejects malformed HTTP 200 envelopes instead of treating them as no matches', () => {
    expect(() => validateScannerResponse({}, expectation)).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse({ cards: [] }, expectation)).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse({ ...response(), outcome: undefined }, expectation)).toThrow('INVALID_SCAN_RESPONSE');
  });

  it('preserves a canonical evidence-backed empty result', () => {
    const result = validateScannerResponse(response(), expectation);
    expect(result.cards).toEqual([]);
    expect(result.selected).toEqual(expectation.selected);
    expect(result.fetchedAt).toBe('2026-09-09T14:19:30.000Z');
  });

  it('accepts canonical cards, preserves explicit missing change evidence, and maps symbol identity for the legacy UI', () => {
    const result = validateScannerResponse(response([canonicalCard]), expectation);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].ticker).toBe('005930');
    expect(result.cards[0].changePercent).toBeNull();
    expect(result.cards[0].missing).toEqual(['AI 점수 상위']);
    expect(result.cards[0].entry).toEqual(['69000', '70000']);
    expect(result.cards[0].stop).toEqual(['67000']);
  });

  it('rejects malformed card evidence and cross-market identity drift', () => {
    expect(() => validateScannerResponse(response([{ ...canonicalCard, symbol: '' }]), expectation)).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse(response([{ ...canonicalCard, price: null }]), expectation)).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse(response([{ ...canonicalCard, currency: 'USD' }]), expectation)).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse({ ...response(), market: 'US' }, expectation)).toThrow('INVALID_SCAN_RESPONSE');
  });

  it('rejects stale/future response timestamps instead of presenting them as current scanner evidence', () => {
    expect(() => validateScannerResponse({ ...response(), generatedAt: '2026-09-09T14:17:59.999Z' }, expectation)).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse({ ...response(), generatedAt: '2026-09-09T14:20:05.001Z' }, expectation)).toThrow('INVALID_SCAN_RESPONSE');
  });

  it('routes explicit provider/timeout success envelopes away from the normal-empty UI', () => {
    expect(() => validateScannerResponse(response([], 'PROVIDER_FAILURE'), expectation)).toThrow('UNHEALTHY_SCAN_RESPONSE');
    expect(() => validateScannerResponse(response([], 'REQUEST_TIMEOUT'), expectation)).toThrow('UNHEALTHY_SCAN_RESPONSE');
  });

  it('requires candidate outcome/card cardinality to remain coherent', () => {
    expect(() => validateScannerResponse(response([], 'CANDIDATES_AVAILABLE'), expectation)).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse(response([canonicalCard], 'VALID_ZERO_SIGNAL'), expectation)).toThrow('INVALID_SCAN_RESPONSE');
  });
});
