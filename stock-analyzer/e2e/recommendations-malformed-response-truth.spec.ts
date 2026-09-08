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
  generatedAt: '2026-09-08T12:00:00.000Z',
  rows: [],
  excludedCount: 0,
  excludedBreakdown: {},
  dataQualityNote: '조건 충족 후보만 표시',
};

test('genuine zero-candidate recommendation response remains a valid success state', () => {
  expect(requireRecommendationResponse<typeof validEnvelope>(validEnvelope, 'KR')).toEqual(validEnvelope);
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
});

test('malformed recommendation rows fail closed before investment facts are rendered', () => {
  expect(() =>
    requireRecommendationResponse(
      {
        ...validEnvelope,
        rows: [
          {
            ticker: '005930',
            name: '삼성전자',
            market: 'KR',
            currency: 'KRW',
            category: 'undervalued',
            categoryLabel: '저평가',
            price: 'not-a-price',
            changePercent: null,
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
            generatedAt: '2026-09-08T12:00:00.000Z',
            dataUpdatedAt: '2026-09-08T11:59:00.000Z',
            providers: ['provider'],
            dataQuality: 'partial',
          },
        ],
      },
      'KR',
    ),
  ).toThrow('INVALID_RECOMMENDATION_RESPONSE');
});

test('recommendation page validates unknown transport payload before empty-state rendering', () => {
  const page = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/recommendations.tsx'), 'utf8');

  expect(page).toContain('await apiGet<unknown>(`/market/recommendations?market=${market}`)');
  expect(page).toContain('requireRecommendationResponse<RecoResponse>');
  expect(page).toContain('query.isError');
  expect(page).toContain('!query.isLoading && !query.isError && rows.length === 0');
  expect(page).toContain('조건 미달 종목으로 채우지 않습니다.');
});
