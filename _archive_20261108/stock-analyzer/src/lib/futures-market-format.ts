export function formatFundingRatePercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '확인 불가';
  const percent = value * 100;
  if (!Number.isFinite(percent)) return '확인 불가';
  return `${percent.toFixed(4)}%`;
}
