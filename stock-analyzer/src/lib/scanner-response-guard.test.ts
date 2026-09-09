import { describe, expect, it } from 'vitest';
import { validateScannerResponse } from './scanner-response-guard';

const validEmpty = {
  cards: [],
  selected: ['rsi'],
  supportedIndicators: ['rsi'],
  fetchedAt: '2026-09-09T12:00:00.000Z',
  searchRunId: 'run-1',
};

const validCard = {
  ticker: '005930',
  name: '삼성전자',
  market: 'KR',
  currency: 'KRW',
  price: 70000,
  changePct: 1.2,
  score: 80,
  confidence: 75,
  breakoutProbability: 61,
  matched: ['rsi'],
  missing: [],
  entry: [{ label: '진입', value: 69500 }],
  stop: [{ label: '손절', value: 68000 }],
  expectedPeriod: '1-3일',
  matchCount: 1,
  selectedCount: 1,
};

describe('validateScannerResponse', () => {
  it('rejects malformed HTTP 200 envelopes instead of treating them as no matches', () => {
    expect(() => validateScannerResponse({})).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse({ cards: [] })).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse({ cards: null, selected: ['rsi'] })).toThrow('INVALID_SCAN_RESPONSE');
  });

  it('preserves a canonical evidence-backed empty result', () => {
    expect(validateScannerResponse(validEmpty)).toEqual(validEmpty);
  });

  it('rejects malformed card evidence and accepts a canonical card', () => {
    expect(() => validateScannerResponse({ ...validEmpty, cards: [{ ...validCard, ticker: '' }] })).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse({ ...validEmpty, cards: [{ ...validCard, price: null }] })).toThrow('INVALID_SCAN_RESPONSE');
    expect(validateScannerResponse({ ...validEmpty, cards: [validCard] }).cards).toHaveLength(1);
  });

  it('rejects malformed optional lineage fields', () => {
    expect(() => validateScannerResponse({ ...validEmpty, fetchedAt: 'not-a-date' })).toThrow('INVALID_SCAN_RESPONSE');
    expect(() => validateScannerResponse({ ...validEmpty, searchRunId: '' })).toThrow('INVALID_SCAN_RESPONSE');
  });
});
