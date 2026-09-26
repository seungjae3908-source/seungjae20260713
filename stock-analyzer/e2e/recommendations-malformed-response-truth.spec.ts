import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { requireRecommendationResponse } from '../src/lib/recommendation-response';

const validEnvelope = {
  ok: true,
  provider: 'rule-based-engine',
  analysisMode: 'rule-based',
  aiConfigured: false,
  analysisDescription: '검증 가능한 규칙 기반 추천',
  market: 'KR' as const,
  generatedAt: new Date().toISOString(),
  rows: [],
  excludedCount: 0,
  excludedBreakdown: {},
  dataQualityNote: '조건 충족 후보만 표시',
};

function validRecommendationRow(generatedAt: string) {
  return {
    ticker: '005930',
    name: '삼성전자',
    market: 'KR',
    currency: 'KRW',
    category: 'undervalued',
    categoryLabel: '저평가 후보',
    price: 70_000,
    changePercent: 0,
    reasons: ['근거'],
    usedData: ['현재가'],
    missingData: [],
    risks: [],
    overheated: false,
    financialStability: '보통',
    newsRisk: '보통',
    riskLevel: 'MEDIUM',
    shortTermOutlook: '관망',
    midTermOutlook: '관망',
    opinion: '관망',
    targetPrice: null,
    targetBasis: '산출 불가',
    stopLoss: null,
    stopBasis: '산출 불가',
    score: 50,
    generatedAt,
    dataUpdatedAt: new Date().toISOString(),
    providers: ['provider'],
    dataQuality: 'sufficient',
  };
}

test('genuine zero-candidate recommendation response remains a valid success state', () => {
  expect(requireRecommendationResponse<typeof validEnvelope>(validEnvelope, 'KR')).toEqual(validEnvelope);
});

test('stale or materially future-dated HTTP 200 recommendation envelopes fail closed', () => {
  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        generatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');

  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        generatedAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');
});

test('stale or materially future-dated recommendation rows fail closed even under a fresh envelope', () => {
  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        generatedAt: new Date().toISOString(),
        rows: [validRecommendationRow(new Date(Date.now() - 11 * 60_000).toISOString())],
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');

  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        generatedAt: new Date().toISOString(),
        rows: [validRecommendationRow(new Date(Date.now() + 2 * 60_000).toISOString())],
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');
});

test('malformed HTTP 200 recommendation envelope fails closed instead of becoming empty success', () => {
  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        rows: undefined,
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');

  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        ok: false,
        rows: [],
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');

  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        analysisMode: 'ai',
        aiConfigured: true,
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');
});

test('malformed recommendation rows fail closed before investment facts are rendered', () => {
  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        rows: [
          {
            ...validRecommendationRow(new Date().toISOString()),
            price: 'not-a-price',
          },
        ],
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');

  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        excludedCount: 1,
        excludedBreakdown: {},
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');
});

test('every recommendation consumer validates unknown transport payload before empty-state rendering', () => {
  const recommendationsPage = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/recommendations.tsx'), 'utf8');
  const stocksPage = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/stocks.tsx'), 'utf8');

  expect(recommendationsPage).toContain('await apiGet<unknown>(`/market/recommendations?market=${market}`)');
  expect(recommendationsPage).toContain('requireRecommendationResponse<RecoResponse>');
  expect(recommendationsPage).toContain('query.isError');
  expect(recommendationsPage).toContain('!query.isLoading && !query.isError && rows.length === 0');
  expect(recommendationsPage).toContain('조건 미달 종목으로 채우지 않습니다.');

  expect(stocksPage).toContain('await apiGet<unknown>(`/market/recommendations?market=${mode.stockMarket}`)');
  expect(stocksPage).toContain('requireRecommendationResponse<RecoResponse>');
  expect(stocksPage).toContain('if (recommendations.isError)');
  expect(stocksPage).toContain('const rows = recommendations.data?.rows ?? []');
});
