const SCORE_FORMATTER = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 2,
});

export function formatAiChartScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return SCORE_FORMATTER.format(value);
}
