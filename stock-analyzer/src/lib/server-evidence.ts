/** Validate an explicit ISO instant without Date.parse calendar rollover or coercion. */
export function evidenceInstant(value: unknown, latest = Infinity): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = match[7] === 'Z' ? 0 : Number(match[7].slice(1, 3));
  const offsetMinute = match[7] === 'Z' ? 0 : Number(match[7].slice(4, 6));
  const time = Date.parse(value);
  return year >= 1970 && month >= 1 && month <= 12
    && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 14 && offsetMinute <= 59 && (offsetHour !== 14 || offsetMinute === 0)
    && Number.isFinite(time) && time > 0 && time <= latest;
}

export function evidenceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function evidenceNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
