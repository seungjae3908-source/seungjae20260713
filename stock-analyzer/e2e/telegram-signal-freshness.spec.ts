import { expect, test } from '@playwright/test';
import {
  evaluateTelegramSignalFreshness,
  formatTelegramAge,
} from '../../api-server/src/services/telegram-signal-freshness.service';

const NOW = Date.parse('2026-08-27T00:00:00.000Z');

function readyChart(dataAsOf = '2026-08-26T23:59:00.000Z') {
  return {
    status: 'READY' as const,
    png: new Uint8Array([1]),
    candleCount: 60,
    dataAsOf,
    priceMin: 100,
    priceMax: 110,
  };
}

test('fresh signal uses only canonical generatedAt, expiresAt and chart dataAsOf evidence', () => {
  const result = evaluateTelegramSignalFreshness({
    generatedAt: '2026-08-26T23:58:00.000Z',
    expiresAt: '2026-08-27T00:10:00.000Z',
    chart: readyChart(),
    nowMs: NOW,
  });

  expect(result.status).toBe('FRESH');
  expect(result.validity).toBe('VALID');
  expect(result.signalAgeMs).toBe(2 * 60_000);
  expect(result.dataAgeMs).toBe(60_000);
  expect(result.remainingMs).toBe(10 * 60_000);
  expect(result.reasonCodes).toEqual([]);
});

test('expired or already-stale chart evidence can never be labeled fresh', () => {
  const expired = evaluateTelegramSignalFreshness({
    generatedAt: '2026-08-26T23:40:00.000Z',
    expiresAt: '2026-08-26T23:59:59.000Z',
    chart: readyChart(),
    nowMs: NOW,
  });
  expect(expired.status).toBe('STALE');
  expect(expired.validity).toBe('EXPIRED');
  expect(expired.remainingMs).toBe(0);

  const staleChart = evaluateTelegramSignalFreshness({
    generatedAt: '2026-08-26T23:58:00.000Z',
    expiresAt: '2026-08-27T00:10:00.000Z',
    chart: { status: 'UNAVAILABLE', reason: 'STALE_CHART_EVIDENCE' },
    nowMs: NOW,
  });
  expect(staleChart.status).toBe('STALE');
  expect(staleChart.reasonCodes).toContain('STALE_CHART_EVIDENCE');
});

test('missing, invalid and future timestamps fail closed without guessing freshness', () => {
  expect(evaluateTelegramSignalFreshness({ chart: readyChart(), nowMs: NOW }).status).toBe('MISSING');

  const invalid = evaluateTelegramSignalFreshness({
    generatedAt: 'not-a-date',
    expiresAt: '2026-08-27T00:10:00.000Z',
    chart: readyChart(),
    nowMs: NOW,
  });
  expect(invalid.status).toBe('UNAVAILABLE');
  expect(invalid.validity).toBe('INVALID');

  const future = evaluateTelegramSignalFreshness({
    generatedAt: '2026-08-27T00:01:00.000Z',
    expiresAt: '2026-08-27T00:10:00.000Z',
    chart: readyChart(),
    nowMs: NOW,
  });
  expect(future.status).toBe('UNAVAILABLE');
  expect(future.validity).toBe('FUTURE');
});

test('missing optional evidence is partial while explicitly unavailable evidence stays unavailable', () => {
  const partial = evaluateTelegramSignalFreshness({
    generatedAt: '2026-08-26T23:58:00.000Z',
    expiresAt: '2026-08-27T00:10:00.000Z',
    chart: null,
    nowMs: NOW,
  });
  expect(partial.status).toBe('PARTIAL');
  expect(partial.reasonCodes).toContain('CHART_EVIDENCE_MISSING');

  const unavailable = evaluateTelegramSignalFreshness({
    generatedAt: '2026-08-26T23:58:00.000Z',
    expiresAt: '2026-08-27T00:10:00.000Z',
    chart: { status: 'UNAVAILABLE', reason: 'INVALID_CHART_EVIDENCE' },
    nowMs: NOW,
  });
  expect(unavailable.status).toBe('UNAVAILABLE');
  expect(unavailable.reasonCodes).toContain('INVALID_CHART_EVIDENCE');
});

test('age formatter stays bounded and never invents values', () => {
  expect(formatTelegramAge(null)).toBe('N/A');
  expect(formatTelegramAge(-1)).toBe('N/A');
  expect(formatTelegramAge(45_000)).toBe('45초');
  expect(formatTelegramAge(5 * 60_000)).toBe('5분');
  expect(formatTelegramAge(2 * 60 * 60_000 + 5 * 60_000)).toBe('2시간 5분');
});
