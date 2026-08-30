import { ProviderError } from '../lib/errors';

// A missing statement value is not a measured zero. Strict consumers require
// complete evidence until their public contracts can represent partial rows.
export function requireFinancialNumber(value: unknown, provider: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProviderError('UNAVAILABLE', provider, `INCOMPLETE_FINANCIAL_EVIDENCE:${field}`);
  }
  return value;
}

export function parseFinancialAmount(value: unknown, provider: string, field: string): number {
  if (typeof value !== 'string') return requireFinancialNumber(undefined, provider, field);
  const text = value.trim();
  // DART amounts use comma grouping, an optional sign/triangle, or parentheses.
  if (!/^(?:[-+△]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?\))$/.test(text)) {
    return requireFinancialNumber(undefined, provider, field);
  }
  const negative = /^[-△(]/.test(text);
  const amount = Number(text.replace(/[,()+△-]/g, ''));
  return requireFinancialNumber(negative ? -amount : amount, provider, field);
}
