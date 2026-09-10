export type NewsEvidenceProvenance = 'PROVIDER_SUPPLIED' | 'NOT_PROVIDED';
export type NewsRelevanceProvenance = 'TICKER_SCOPED_PROVIDER' | 'COMPANY_NAME_QUERY';

export type NewsEvidenceFields = {
  reliability?: unknown;
  summary?: unknown;
  impact?: unknown;
  provider?: unknown;
  publishedAt?: unknown;
  collectedAt?: unknown;
  relevanceProvenance?: unknown;
  confidenceProvenance?: unknown;
  summaryProvenance?: unknown;
  impactProvenance?: unknown;
};

export type NewsEvidenceDisplay = {
  reliabilityScore: number | null;
  reliabilityLabel: string | null;
  summary: string | null;
  impact: string | null;
  provider: string | null;
  publishedAt: string | null;
  collectedAt: string | null;
  relevanceLabel: string;
  confidenceProvenance: NewsEvidenceProvenance;
  summaryProvenance: NewsEvidenceProvenance;
  impactProvenance: NewsEvidenceProvenance;
};

function evidenceText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function evidenceTimestamp(value: unknown): string | null {
  const normalized = evidenceText(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function evidenceProvenance(value: unknown): NewsEvidenceProvenance {
  return value === 'PROVIDER_SUPPLIED' ? 'PROVIDER_SUPPLIED' : 'NOT_PROVIDED';
}

function relevanceLabel(value: unknown): string {
  if (value === 'TICKER_SCOPED_PROVIDER') return '관련성 근거: 종목 지정 공급자';
  if (value === 'COMPANY_NAME_QUERY') return '관련성 근거: 회사명 검색 결과 · 미검증';
  return '관련성 근거 미제공';
}

export function reliabilityLabel(score: number): string {
  if (score >= 90) return '매우 높음';
  if (score >= 80) return '높음';
  if (score >= 70) return '보통';
  return '낮음';
}

export function newsEvidenceDisplay(item: NewsEvidenceFields): NewsEvidenceDisplay {
  const confidenceProvenance = evidenceProvenance(item.confidenceProvenance);
  const summaryProvenance = evidenceProvenance(item.summaryProvenance);
  const impactProvenance = evidenceProvenance(item.impactProvenance);
  const reliabilityScore = confidenceProvenance === 'PROVIDER_SUPPLIED'
    && typeof item.reliability === 'number'
    && Number.isFinite(item.reliability)
    && item.reliability >= 0
    && item.reliability <= 100
    ? item.reliability
    : null;

  return {
    reliabilityScore,
    reliabilityLabel: reliabilityScore == null ? null : reliabilityLabel(reliabilityScore),
    summary: summaryProvenance === 'PROVIDER_SUPPLIED' ? evidenceText(item.summary) : null,
    impact: impactProvenance === 'PROVIDER_SUPPLIED' ? evidenceText(item.impact) : null,
    provider: evidenceText(item.provider),
    publishedAt: evidenceTimestamp(item.publishedAt),
    collectedAt: evidenceTimestamp(item.collectedAt),
    relevanceLabel: relevanceLabel(item.relevanceProvenance),
    confidenceProvenance,
    summaryProvenance,
    impactProvenance,
  };
}
