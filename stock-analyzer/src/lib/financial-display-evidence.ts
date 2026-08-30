function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function financialDisplayEvidence(input: unknown) {
  const data = record(input);
  const cash = record(data.cashBurn);
  const health = record(data.health);
  const cashBalance = typeof cash.cashBalance === 'number' && Number.isFinite(cash.cashBalance) && cash.cashBalance >= 0 ? cash.cashBalance : null;
  const score = health.method === 'FINANCIAL_RULES_V1' && typeof health.score === 'number' && Number.isFinite(health.score) && health.score >= 0 && health.score <= 100 ? health.score : null;
  const level: 'STRONG' | 'AVERAGE' | 'WEAK' | null = score !== null && (health.level === 'STRONG' || health.level === 'AVERAGE' || health.level === 'WEAK') ? health.level : null;
  // Legacy quarterlyBurn was net income, and legacy confidence was a heuristic.
  // Neither field is evidence of cash flow, runway, or probability.
  return { cashBalance, healthScore: level ? score : null, healthLevel: level, sample: data.source === 'sample' };
}
