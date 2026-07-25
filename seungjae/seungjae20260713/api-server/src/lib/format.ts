import type { Currency } from '../data/catalog';

// Format a monetary magnitude with Korean number words, currency-aware.
export function formatMagnitude(value: number, currency: Currency): string {
  if (!Number.isFinite(value)) return '-';
  const unit = currency === 'KRW' ? '원' : '달러';
  const abs = Math.abs(value);
  if (currency === 'KRW') {
    if (abs >= 1e12) return `${(value / 1e12).toFixed(1)}조 ${unit}`;
    if (abs >= 1e8) return `${Math.round(value / 1e8).toLocaleString('ko-KR')}억 ${unit}`;
    return `${Math.round(value / 1e4).toLocaleString('ko-KR')}만 ${unit}`;
  }
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}조 ${unit}`;
  if (abs >= 1e8) return `${(value / 1e8).toFixed(1)}억 ${unit}`;
  if (abs >= 1e6) return `${Math.round(value / 1e6).toLocaleString('ko-KR')}백만 ${unit}`;
  return `${Math.round(value).toLocaleString('ko-KR')} ${unit}`;
}
