import type { TelegramEvidenceChartResult } from './telegram-evidence-chart.service';

export type TelegramSignalFreshnessStatus = 'FRESH' | 'STALE' | 'PARTIAL' | 'MISSING' | 'UNAVAILABLE';
export type TelegramSignalValidity = 'VALID' | 'EXPIRED' | 'FUTURE' | 'MISSING' | 'INVALID';

export type TelegramSignalFreshness = {
  status: TelegramSignalFreshnessStatus;
  validity: TelegramSignalValidity;
  signalGeneratedAt: string | null;
  signalAgeMs: number | null;
  expiresAt: string | null;
  remainingMs: number | null;
  dataAsOf: string | null;
  dataAgeMs: number | null;
  reasonCodes: string[];
};

export type TelegramSignalFreshnessInput = {
  generatedAt?: string | null;
  expiresAt?: string | null;
  chart: TelegramEvidenceChartResult | null;
  warnings?: readonly string[];
  nowMs?: number;
};

function parsedIso(value: string | null | undefined): { iso: string; ms: number } | null {
  if (!value || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : null;
}

function nonNegativeAge(nowMs: number, observedMs: number): number | null {
  if (observedMs > nowMs) return null;
  return Math.max(0, nowMs - observedMs);
}

export function evaluateTelegramSignalFreshness(
  input: TelegramSignalFreshnessInput,
): TelegramSignalFreshness {
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
    ? input.nowMs
    : Date.now();
  const generated = parsedIso(input.generatedAt);
  const expires = parsedIso(input.expiresAt);
  const reasons: string[] = [];

  let validity: TelegramSignalValidity = 'VALID';
  if (!input.generatedAt || !input.expiresAt) {
    validity = 'MISSING';
    if (!input.generatedAt) reasons.push('SIGNAL_GENERATED_AT_MISSING');
    if (!input.expiresAt) reasons.push('SIGNAL_EXPIRES_AT_MISSING');
  } else if (!generated || !expires) {
    validity = 'INVALID';
    if (!generated) reasons.push('SIGNAL_GENERATED_AT_INVALID');
    if (!expires) reasons.push('SIGNAL_EXPIRES_AT_INVALID');
  } else if (expires.ms <= generated.ms) {
    validity = 'INVALID';
    reasons.push('SIGNAL_EXPIRY_ORDER_INVALID');
  } else if (generated.ms > nowMs) {
    validity = 'FUTURE';
    reasons.push('SIGNAL_GENERATED_AT_FUTURE');
  } else if (expires.ms <= nowMs) {
    validity = 'EXPIRED';
    reasons.push('SIGNAL_EXPIRED');
  }

  let dataAsOf: string | null = null;
  let dataAgeMs: number | null = null;
  if (input.chart?.status === 'READY') {
    const parsed = parsedIso(input.chart.dataAsOf);
    if (parsed && parsed.ms <= nowMs) {
      dataAsOf = parsed.iso;
      dataAgeMs = nonNegativeAge(nowMs, parsed.ms);
    } else {
      reasons.push(parsed ? 'CHART_DATA_FUTURE' : 'CHART_DATA_AS_OF_INVALID');
    }
  } else if (input.chart?.status === 'UNAVAILABLE') {
    reasons.push(input.chart.reason);
  } else {
    reasons.push('CHART_EVIDENCE_MISSING');
  }

  for (const warning of input.warnings ?? []) {
    const normalized = String(warning).trim();
    if (normalized && !reasons.includes(normalized)) reasons.push(normalized);
  }

  let status: TelegramSignalFreshnessStatus;
  if (validity === 'MISSING') {
    status = 'MISSING';
  } else if (validity === 'INVALID' || validity === 'FUTURE') {
    status = 'UNAVAILABLE';
  } else if (
    validity === 'EXPIRED'
    || (input.chart?.status === 'UNAVAILABLE' && input.chart.reason === 'STALE_CHART_EVIDENCE')
  ) {
    status = 'STALE';
  } else if (
    input.chart?.status === 'UNAVAILABLE'
    || reasons.includes('CHART_DATA_FUTURE')
    || reasons.includes('CHART_DATA_AS_OF_INVALID')
  ) {
    status = 'UNAVAILABLE';
  } else if (!input.chart || (input.warnings?.length ?? 0) > 0) {
    status = 'PARTIAL';
  } else {
    status = 'FRESH';
  }

  return {
    status,
    validity,
    signalGeneratedAt: generated?.iso ?? null,
    signalAgeMs: generated ? nonNegativeAge(nowMs, generated.ms) : null,
    expiresAt: expires?.iso ?? null,
    remainingMs: expires && expires.ms > nowMs ? expires.ms - nowMs : expires ? 0 : null,
    dataAsOf,
    dataAgeMs,
    reasonCodes: reasons,
  };
}

export function formatTelegramAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'N/A';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}시간 ${minutes % 60}분`;
  const days = Math.floor(hours / 24);
  return `${days}일 ${hours % 24}시간`;
}
