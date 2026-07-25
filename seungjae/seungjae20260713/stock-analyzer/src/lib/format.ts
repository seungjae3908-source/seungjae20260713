import type { Currency } from '@/lib/api';

export function formatPrice(value: number, currency: Currency): string {
  if (currency === 'KRW') return `${Math.round(value).toLocaleString('ko-KR')}원`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Compact magnitude for market cap / financial statement values.
export function formatCompact(value: number, currency: Currency): string {
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

export function formatPercent(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function formatChange(amount: number, currency: Currency): string {
  return `${amount >= 0 ? '+' : '-'}${formatPrice(Math.abs(amount), currency)}`;
}

export function formatVolume(n: number): string {
  return `${n.toLocaleString('en-US')}주`;
}

export function formatSignedNumber(n: number, suffix = ''): string {
  return `${n >= 0 ? '+' : ''}${n.toLocaleString('en-US')}${suffix}`;
}
