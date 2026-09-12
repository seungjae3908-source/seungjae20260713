import assert from 'node:assert/strict';
import test from 'node:test';
import { requireRecommendationResponse } from './recommendation-response';

const NOW = Date.parse('2026-09-10T08:30:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    ticker: '005930',
    name: '삼성전자',
    market: 'KR',
    currency: 'KRW',
    category: 'undervalued',
    categoryLabel: '저평가 후보',
    price: 72_000,
    changePercent: 1.25,
    reasons: ['실데이터 조건 충족'],
    usedData: ['quote', 'candles'],
    missingData: [],
    risks: [],
    overheated: false,
    financialStability: '보통',
    newsRisk: '낮음',
    riskLevel: 'MEDIUM',
    shortTermOutlook: '규칙 기반 단기 관찰',
    midTermOutlook: '규칙 기반 중기 관찰',
    opinion: '관망',
    targetPrice: null,
    targetBasis: '근거 부족으로 산출하지 않음',
    stopLoss: null,
    stopBasis: '근거 부족으로 산출하지 않음',
    score: 61,
    generatedAt: '2026-09-10T08:29:30.000Z',
    dataUpdatedAt: '2026-09-10T08:29:00.000Z',
    providers: ['naver'],
    dataQuality: 'sufficient',
    ...overrides,
  };
}

function payload(rowOverrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    market: 'KR',
    provider: 'rule-based-engine',
    analysisMode: 'rule-based',
    aiConfigured: false,
    analysisDescription: '규칙 기반 추천',
    generatedAt: '2026-09-10T08:29:30.000Z',
    rows: [row(rowOverrides)],
    excludedCount: 0,
    excludedBreakdown: {},
    dataQualityNote: '실데이터 기준',
  };
}

test('recommendation accepts genuine data evidence inside the seven-day producer policy', () => {
  const parsed = requireRecommendationResponse<ReturnType<typeof payload>>(
    payload({ dataUpdatedAt: '2026-09-03T08:30:00.000Z' }),
    'KR',
    NOW,
  );
  assert.equal(parsed.rows[0].ticker, '005930');
});

test('recommendation rejects missing or malformed dataUpdatedAt evidence', () => {
  assert.throws(
    () => requireRecommendationResponse(payload({ dataUpdatedAt: undefined }), 'KR', NOW),
    /INVALID_RECOMMENDATION_RESPONSE/,
  );
  assert.throws(
    () => requireRecommendationResponse(payload({ dataUpdatedAt: 'not-a-timestamp' }), 'KR', NOW),
    /INVALID_RECOMMENDATION_RESPONSE/,
  );
});

test('recommendation rejects stale dataUpdatedAt even when the envelope is freshly generated', () => {
  assert.throws(
    () => requireRecommendationResponse(
      payload({ dataUpdatedAt: '2026-09-03T08:29:59.999Z' }),
      'KR',
      NOW,
    ),
    /INVALID_RECOMMENDATION_RESPONSE/,
  );
});

test('recommendation rejects materially future-dated dataUpdatedAt', () => {
  assert.throws(
    () => requireRecommendationResponse(
      payload({ dataUpdatedAt: '2026-09-10T08:31:00.001Z' }),
      'KR',
      NOW,
    ),
    /INVALID_RECOMMENDATION_RESPONSE/,
  );
});
