export type NewsEvidenceFields = {
  reliability?: unknown;
  summary?: unknown;
  impact?: unknown;
};

export type NewsEvidenceDisplay = {
  reliabilityScore: number | null;
  reliabilityLabel: string | null;
  summary: string | null;
  impact: string | null;
};

function evidenceText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function reliabilityLabel(score: number): string {
  if (score >= 90) return '매우 높음';
  if (score >= 80) return '높음';
  if (score >= 70) return '보통';
  return '낮음';
}

export function newsEvidenceDisplay(item: NewsEvidenceFields): NewsEvidenceDisplay {
  const reliabilityScore = typeof item.reliability === 'number'
    && Number.isFinite(item.reliability)
    && item.reliability >= 0
    && item.reliability <= 100
    ? item.reliability
    : null;

  return {
    reliabilityScore,
    reliabilityLabel: reliabilityScore == null ? null : reliabilityLabel(reliabilityScore),
    summary: evidenceText(item.summary),
    impact: evidenceText(item.impact),
  };
}
