type RecommendationMarket = 'KR' | 'US';

const CATEGORY_VALUES = new Set(['undervalued', 'breakout']);
const CATEGORY_LABELS = {
  undervalued: '저평가 후보',
  breakout: '초기 추세돌파 후보',
} as const;
const RISK_VALUES = new Set(['LOW', 'MEDIUM', 'HIGH']);
const DATA_QUALITY_VALUES = new Set(['sufficient', 'partial', 'insufficient', 'stale']);
const FINANCIAL_STABILITY_VALUES = new Set(['안정', '보통', '불안정', '판단 불가']);
const NEWS_RISK_VALUES = new Set(['낮음', '보통', '높음', '판단 불가']);
const OPINION_VALUES = new Set(['매수', '관망', '매도']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNullablePositiveNumber(value: unknown): value is number | null {
  return value === null || isPositiveNumber(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isExcludedBreakdown(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (count) => Number.isInteger(count) && (count as number) >= 0,
  );
}

function isRecommendationRow(value: unknown, expectedMarket: RecommendationMarket): boolean {
  if (!isRecord(value)) return false;

  if (!isNonEmptyString(value.ticker) || !isNonEmptyString(value.name)) return false;
  if (value.market !== expectedMarket) return false;
  if (value.currency !== (expectedMarket === 'KR' ? 'KRW' : 'USD')) return false;
  if (!CATEGORY_VALUES.has(String(value.category))) return false;
  if (
    value.categoryLabel
      !== CATEGORY_LABELS[value.category as keyof typeof CATEGORY_LABELS]
  ) return false;
  if (!isPositiveNumber(value.price) || !isNullableFiniteNumber(value.changePercent)) return false;
  if (!isStringArray(value.reasons) || value.reasons.length === 0) return false;
  if (!isStringArray(value.usedData) || !isStringArray(value.missingData) || !isStringArray(value.risks)) return false;
  if (typeof value.overheated !== 'boolean') return false;
  if (!FINANCIAL_STABILITY_VALUES.has(String(value.financialStability))) return false;
  if (!NEWS_RISK_VALUES.has(String(value.newsRisk))) return false;
  if (!RISK_VALUES.has(String(value.riskLevel))) return false;
  if (!isNonEmptyString(value.shortTermOutlook) || !isNonEmptyString(value.midTermOutlook)) return false;
  if (!OPINION_VALUES.has(String(value.opinion))) return false;
  if (!isNullablePositiveNumber(value.targetPrice) || !isNonEmptyString(value.targetBasis)) return false;
  if (!isNullablePositiveNumber(value.stopLoss) || !isNonEmptyString(value.stopBasis)) return false;
  if (!isFiniteNumber(value.score) || value.score < 0 || value.score > 100) return false;
  if (!isTimestamp(value.generatedAt) || !isTimestamp(value.dataUpdatedAt)) return false;
  if (!isStringArray(value.providers) || value.providers.length === 0) return false;
  if (!DATA_QUALITY_VALUES.has(String(value.dataQuality))) return false;

  if (value.previousGeneratedAt !== undefined && !isTimestamp(value.previousGeneratedAt)) return false;
  if (value.changeSincePrevious !== undefined && !isFiniteNumber(value.changeSincePrevious)) return false;

  return true;
}

/**
 * HTTP 200 is transport success only. Recommendation data is investment-facing,
 * so a malformed or explicitly non-success envelope must fail closed instead of
 * becoming a legitimate-looking empty candidate list in the UI.
 */
export function requireRecommendationResponse<T>(
  payload: unknown,
  expectedMarket: RecommendationMarket,
): T {
  if (!isRecord(payload)) throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (payload.ok !== true) throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (payload.market !== expectedMarket) throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (payload.provider !== 'rule-based-engine') throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (payload.analysisMode !== 'rule-based') throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (payload.aiConfigured !== false) throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (!isNonEmptyString(payload.analysisDescription)) throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (!isTimestamp(payload.generatedAt)) throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (!Array.isArray(payload.rows)) throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (!Number.isInteger(payload.excludedCount) || (payload.excludedCount as number) < 0) {
    throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  }
  if (!isExcludedBreakdown(payload.excludedBreakdown)) throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (
    Object.values(payload.excludedBreakdown).reduce((sum, count) => sum + count, 0)
      !== payload.excludedCount
  ) {
    throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  }
  if (!isNonEmptyString(payload.dataQualityNote)) throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  if (!payload.rows.every((row) => isRecommendationRow(row, expectedMarket))) {
    throw new Error('INVALID_RECOMMENDATION_RESPONSE');
  }

  return payload as T;
}
