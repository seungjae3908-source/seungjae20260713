import type { Currency } from '@/lib/api';

type FinancialValue = number | null | undefined;
const hasNumber = (value: FinancialValue): value is number => typeof value === 'number' && Number.isFinite(value);
const hasCurrency = (currency: string): boolean => /^[A-Z]{3,10}$/.test(currency);

export function formatPrice(value: FinancialValue, currency: Currency | string): string {
  if (!hasNumber(value) || !hasCurrency(currency)) return '—';
  if (currency === 'KRW') return `${Math.round(value).toLocaleString('ko-KR')}원`;
  if (currency !== 'USD') return `${value.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${currency}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Compact magnitude for market cap / financial statement values.
export function formatCompact(value: FinancialValue, currency: Currency | string): string {
  if (!hasNumber(value) || !hasCurrency(currency)) return '—';
  if (currency !== 'KRW' && currency !== 'USD') return formatPrice(value, currency);
  const neg = value < 0;
  const v = Math.abs(value);
  let out: string;
  if (currency === 'KRW') {
    if (v >= 1e12) out = `${(v / 1e12).toFixed(1)}조원`;
    else if (v >= 1e8) out = `${Math.round(v / 1e8).toLocaleString('ko-KR')}억원`;
    else out = `${Math.round(v).toLocaleString('ko-KR')}원`;
  } else {
    if (v >= 1e12) out = `$${(v / 1e12).toFixed(2)}T`;
    else if (v >= 1e9) out = `$${(v / 1e9).toFixed(2)}B`;
    else if (v >= 1e6) out = `$${(v / 1e6).toFixed(2)}M`;
    else out = `$${Math.round(v).toLocaleString('en-US')}`;
  }
  return neg ? `-${out}` : out;
}

export function formatPercent(n: FinancialValue): string {
  if (!hasNumber(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function formatChange(amount: FinancialValue, currency: Currency | string): string {
  if (!hasNumber(amount) || !hasCurrency(currency)) return '—';
  return `${amount >= 0 ? '+' : '-'}${formatPrice(Math.abs(amount), currency)}`;
}

export function formatVolume(n: FinancialValue): string {
  if (!hasNumber(n) || n < 0) return '—';
  return `${n.toLocaleString('en-US')}주`;
}

export function formatSignedNumber(n: FinancialValue, suffix = ''): string {
  if (!hasNumber(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toLocaleString('en-US')}${suffix}`;
}
