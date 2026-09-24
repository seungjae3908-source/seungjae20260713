const SCORE_FORMATTER = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 2,
});

export function formatAiChartScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  const normalized = Object.is(value, -0) ? 0 : value;
  if (normalized < 0 || normalized > 100) return '-';
  return SCORE_FORMATTER.format(normalized);
}
