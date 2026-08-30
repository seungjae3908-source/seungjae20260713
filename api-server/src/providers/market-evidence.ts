// Quote age is a display/data-quality policy, never an order eligibility rule.
// REST polling cannot establish LIVE status. A market closure does not reset age.
export const QUOTE_MAX_AGE_MS = 5 * 60_000;
export type FreshnessStatus = 'LIVE' | 'FRESH' | 'STALE' | 'ARCHIVED' | 'UNKNOWN' | 'INVALID' | 'PROVIDER_UNAVAILABLE';

export interface QuoteTimeEvidence {
  updatedAt: string | null;
  freshness: {
    status: FreshnessStatus;
    checkedAt: string;
    ageMs: number | null;
    maxAgeMs: number;
    reason: 'SOURCE_TIME_MISSING' | 'SOURCE_TIME_INVALID' | 'SOURCE_TIME_FUTURE' | 'WITHIN_AGE_LIMIT' | 'AGE_LIMIT_EXCEEDED' | 'PROVIDER_ERROR';
  };
}

export function marketNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function requireMarketNumber(value: unknown, field: string, minimum = -Infinity): number {
  const number = marketNumber(value);
  if (number === null || number < minimum) throw new Error(`MARKET_EVIDENCE_INVALID:${field}`);
  return number;
}

function isoMilliseconds(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return NaN;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return NaN;
  if (m[7] !== 'Z') {
    const offsetHour = Number(m[7].slice(1, 3));
    const offsetMinute = Number(m[7].slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return NaN;
  }
  return Date.parse(value);
}

export function quoteTimeEvidence(value: unknown, encoding: 'iso' | 'unix-seconds' = 'iso', now = Date.now()): QuoteTimeEvidence {
  if (!Number.isFinite(now) || now <= 0) throw new Error('MARKET_CLOCK_INVALID');
  const base = { checkedAt: new Date(now).toISOString(), ageMs: null, maxAgeMs: QUOTE_MAX_AGE_MS };
  if (value == null || value === '') return { updatedAt: null, freshness: { ...base, status: 'UNKNOWN', reason: 'SOURCE_TIME_MISSING' } };
  const ms = encoding === 'unix-seconds'
    ? typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value * 1000 : NaN
    : typeof value === 'string' ? isoMilliseconds(value) : NaN;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return { updatedAt: null, freshness: { ...base, status: 'INVALID', reason: 'SOURCE_TIME_INVALID' } };
  if (ms > now) return { updatedAt: null, freshness: { ...base, status: 'INVALID', reason: 'SOURCE_TIME_FUTURE' } };
  const ageMs = now - ms;
  return { updatedAt: new Date(ms).toISOString(), freshness: { ...base, ageMs, status: ageMs <= QUOTE_MAX_AGE_MS ? 'FRESH' : 'STALE', reason: ageMs <= QUOTE_MAX_AGE_MS ? 'WITHIN_AGE_LIMIT' : 'AGE_LIMIT_EXCEEDED' } };
}

export function requireSourceTime(value: unknown, encoding: 'iso' | 'unix-seconds' = 'iso'): QuoteTimeEvidence {
  const evidence = quoteTimeEvidence(value, encoding);
  if (evidence.freshness.status === 'INVALID') throw new Error(`MARKET_EVIDENCE_INVALID:${evidence.freshness.reason}`);
  return evidence;
}
