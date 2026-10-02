type UpbitCandleTimeRow = {
  candle_date_time_utc?: unknown;
  candle_date_time_kst?: unknown;
};

function withExplicitOffset(value: unknown, offset: 'Z' | '+09:00'): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text)) return text;
  return `${text}${offset}`;
}

/**
 * Upbit's candle_date_time_* values omit an offset. Keep the provider instant
 * unambiguous across UTC CI browsers and Asia/Seoul user browsers.
 */
export function absoluteUpbitCandleTime(row: UpbitCandleTimeRow): string | null {
  return withExplicitOffset(row.candle_date_time_utc, 'Z')
    ?? withExplicitOffset(row.candle_date_time_kst, '+09:00');
}
