export function normalizeMissingEvidence(value) {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map((entry) => normalizeMissingEvidence(entry));
  if (!value || typeof value !== 'object') return value;

  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = normalizeMissingEvidence(entry);
    if (next !== undefined) normalized[key] = next;
  }
  return normalized;
}
