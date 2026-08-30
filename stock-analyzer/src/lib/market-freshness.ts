const MAX_AGE_MS = 5 * 60_000;

export function quoteFreshness(input: unknown, now = Date.now()): { label: string; timestamp: string | null } {
  const row = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const freshness = row.freshness && typeof row.freshness === 'object' ? row.freshness as Record<string, unknown> : {};
  if (freshness.status === 'PROVIDER_UNAVAILABLE') return { label: '시세 공급자 응답 없음', timestamp: null };
  if (freshness.status === 'INVALID') return { label: '시세 시각 오류', timestamp: null };
  const value = row.updatedAt;
  if (value == null || value === '') return { label: '시세 시각 확인 불가', timestamp: null };
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  if (!match) return { label: '시세 시각 오류', timestamp: null };
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = match[7] === 'Z' ? 0 : Number(match[7].slice(1, 3));
  const offsetMinute = match[7] === 'Z' ? 0 : Number(match[7].slice(4, 6));
  const ms = Date.parse(value as string);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
    || !Number.isFinite(ms) || ms <= 0 || !Number.isFinite(now) || ms > now) return { label: '시세 시각 오류', timestamp: null };
  return {
    label: freshness.status === 'ARCHIVED' ? '보관된 시세' : now - ms > MAX_AGE_MS ? '5분 이상 지난 시세' : '5분 이내 시세 · 실시간 여부 미확인',
    timestamp: new Date(ms).toISOString(),
  };
}
