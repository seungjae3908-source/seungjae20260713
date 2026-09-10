import { expect, test } from '@playwright/test';
import { classifyStock, stockClassBadgeClass } from '../src/lib/stock-classifier';

test('stock classifier keeps every missing evidence category explicit', () => {
  const result = classifyStock({
    ticker: 'AAPL',
    aiScore: null,
    score: null,
    rating: null,
    changePercent: null,
    debtRatio: null,
    risks: [],
    riskFactors: [],
  });

  expect(result.evidenceState).toBe('MISSING_EVIDENCE');
  expect(result.missingEvidence).toEqual(['score', 'debt', 'financial', 'risk']);
  expect(result.label).toBe('분류 확인 필요');
  expect(result.score).toBeNull();
  expect(result.reason).toContain('근거가 부족');
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
  expect(result.missingEvidence).toContain('score');
  expect(result.score).toBeNull();
});

test('genuine numeric zero remains evidence when the other required categories exist', () => {
  const result = classifyStock({
    ticker: 'TEST',
    aiScore: 0,
    debtRatio: 0,
    operatingIncome: 0,
    risks: ['정기 리스크 점검 근거'],
  });

  expect(result.evidenceState).toBe('EVALUABLE');
  expect(result.missingEvidence).toEqual([]);
  expect(result.score).not.toBeNull();
});

test('score alone cannot manufacture an evaluable classification', () => {
  const result = classifyStock({
    ticker: 'AAPL',
    aiScore: 80,
    debtRatio: null,
    risks: [],
    riskFactors: [],
  });

  expect(result.evidenceState).toBe('MISSING_EVIDENCE');
  expect(result.missingEvidence).toEqual(['debt', 'financial', 'risk']);
  expect(result.label).toBe('분류 확인 필요');
  expect(result.score).toBeNull();
});

test('large ticker identity cannot manufacture market-cap or bluechip evidence', () => {
  const result = classifyStock({
    ticker: 'AAPL',
    aiScore: 80,
    debtRatio: 80,
    operatingIncome: 1,
    risks: ['정기 리스크 점검 근거'],
  });

  expect(result.marketCapGrade).toBe('시총확인필요');
  expect(result.evidenceState).toBe('EVALUABLE');
  expect(result.label).not.toBe('우량주');
  expect(result.reason).not.toContain('중대 위험 부재');
});

test('bluechip gate still works only with explicit market-cap debt financial and risk evidence', () => {
  const result = classifyStock({
    ticker: 'AAPL',
    aiScore: 80,
    marketCap: 3_000_000_000_000,
    currency: 'USD',
    debtRatio: 80,
    operatingIncome: 1,
    risks: ['정기 리스크 점검 근거'],
  });

  expect(result.evidenceState).toBe('EVALUABLE');
  expect(result.missingEvidence).toEqual([]);
  expect(result.label).toBe('우량주');
  expect(result.reason).not.toContain('중대 위험 부재');
  expect(result.riskCaption).toBe('리스크 별도 확인');
});

test('explicit completed risk review can make an empty risk result evaluable', () => {
  const result = classifyStock({
    ticker: 'TEST',
    aiScore: 60,
    debtRatio: 50,
    roe: 5,
    risks: [],
    riskFactors: [],
    riskEvidenceComplete: true,
  });

  expect(result.evidenceState).toBe('EVALUABLE');
  expect(result.missingEvidence).toEqual([]);
});

test('serious risk evidence remains visible even when classification evidence is incomplete', () => {
  const result = classifyStock({
    ticker: 'TEST',
    risks: ['거래정지 공시 확인'],
  });

  expect(result.evidenceState).toBe('MISSING_EVIDENCE');
  expect(result.delistingWarning).toBe(true);
  expect(result.riskCaption).toBe('상장 리스크 주의');
  expect(result.label).toBe('분류 확인 필요');
});
