import { expect, test } from '@playwright/test';
import { classifyStock, stockClassBadgeClass } from '../src/lib/stock-classifier';

test('stock classifier keeps missing score evidence explicit', () => {
  const result = classifyStock({
    ticker: 'AAPL',
    aiScore: null,
    score: null,
    rating: null,
    changePercent: null,
    debtRatio: null,
    risks: [],
    news: [],
    disclosures: [],
    riskFactors: [],
  });

  expect(result.evidenceState).toBe('MISSING_EVIDENCE');
  expect(result.label).toBe('분류 확인 필요');
  expect(result.score).toBeNull();
  expect(result.reason).toContain('분류 점수 근거가 없어');
  expect(stockClassBadgeClass(result.label)).toContain('text-muted-foreground');
});

test('blank numeric strings never become zero evidence', () => {
  const result = classifyStock({
    ticker: 'AAPL',
    aiScore: '' as unknown as number,
    score: '   ' as unknown as number,
    rating: { score: '%' as unknown as number },
  });

  expect(result.evidenceState).toBe('MISSING_EVIDENCE');
  expect(result.score).toBeNull();
});

test('genuine numeric zero remains real evidence', () => {
  const result = classifyStock({ ticker: 'TEST', aiScore: 0 });

  expect(result.evidenceState).toBe('EVALUABLE');
  expect(result.score).toBe(0);
});

test('large ticker alone cannot manufacture a bluechip classification', () => {
  const result = classifyStock({
    ticker: 'AAPL',
    aiScore: 80,
    debtRatio: null,
    risks: [],
    news: [],
    disclosures: [],
    riskFactors: [],
  });

  expect(result.evidenceState).toBe('EVALUABLE');
  expect(result.label).not.toBe('우량주');
  expect(result.reason).not.toContain('중대 위험 부재');
});

test('bluechip gate still works when its debt and risk evidence are present', () => {
  const result = classifyStock({
    ticker: 'AAPL',
    aiScore: 80,
    debtRatio: 80,
    risks: ['정기 리스크 점검 근거'],
  });

  expect(result.evidenceState).toBe('EVALUABLE');
  expect(result.label).toBe('우량주');
  expect(result.reason).not.toContain('중대 위험 부재');
  expect(result.riskCaption).toBe('리스크 별도 확인');
});

test('serious risk evidence remains visible even when score evidence is missing', () => {
  const result = classifyStock({
    ticker: 'TEST',
    risks: ['거래정지 공시 확인'],
  });

  expect(result.evidenceState).toBe('MISSING_EVIDENCE');
  expect(result.delistingWarning).toBe(true);
  expect(result.riskCaption).toBe('상장 리스크 주의');
});
