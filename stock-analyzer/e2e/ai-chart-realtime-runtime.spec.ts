import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { normalizeChartCandles } from '../src/lib/chart-candle-normalizer';
import {
  aiChartStreamIdentityKey,
  createAiChartStreamReduction,
  reconcileAiChartPublicTrades,
  type AiChartPublicTradeEvent,
} from '../src/lib/ai-chart-public-stream';

const bootstrap = {
  time: 1_787_788_800,
  sourceTime: '2026-08-27T00:00:00.000Z',
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 5,
  isClosed: false,
  closeStateSource: 'unknown' as const,
};

function trade(overrides: Partial<AiChartPublicTradeEvent> = {}): AiChartPublicTradeEvent {
  return {
    provider: 'UPBIT_PUBLIC',
    market: 'UPBIT',
    symbol: 'BTC',
    eventId: 'UPBIT:KRW-BTC:1',
    sequence: null,
    eventTimeMs: 1_787_788_830_000,
    receivedAtMs: 1_787_788_830_100,
    price: 102,
    volume: 0.25,
    aggressor: 'BUY',
    ...overrides,
  };
}

test('REST bootstrap rejects future candles with an explicit diagnostic', () => {
  const nowSeconds = 1_787_788_800;
  const result = normalizeChartCandles([{
    time: nowSeconds + 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }], '1m', nowSeconds);

  expect(result.candles).toEqual([]);
  expect(result.futureRows).toBe(1);
  expect(result.warnings.some((warning) => warning.includes('미래'))).toBe(true);
});

test('same-bar stream events reconcile once against the frozen REST bootstrap', () => {
  const result = reconcileAiChartPublicTrades({
    previous: createAiChartStreamReduction([bootstrap]),
    events: [trade()],
    market: 'UPBIT',
    symbol: 'BTC',
    timeframe: '1m',
    bootstrapCutoffMs: 1_787_788_820_000,
  });

  expect(result.acceptedEvents).toBe(1);
  expect(result.needsSnapshot).toBe(false);
  expect(result.integrityIssues).toEqual([]);
  expect(result.latestCandle).toMatchObject({ time: bootstrap.time, close: 102, high: 102, volume: 5.25 });
});

test('REST overlap, duplicates, wrong identity and coverage gaps never mutate the displayed bar', () => {
  const previous = createAiChartStreamReduction([bootstrap]);
  const overlap = reconcileAiChartPublicTrades({
    previous,
    events: [trade({ eventTimeMs: 1_787_788_810_000 })],
    market: 'UPBIT',
    symbol: 'BTC',
    timeframe: '1m',
    bootstrapCutoffMs: 1_787_788_820_000,
  });
  expect(overlap.acceptedEvents).toBe(0);
  expect(overlap.latestCandle).toBeNull();
  expect(overlap.integrityIssues).toContain('REST_STREAM_OVERLAP_REJECTED');

  const wrong = reconcileAiChartPublicTrades({
    previous,
    events: [trade({ symbol: 'ETH' })],
    market: 'UPBIT',
    symbol: 'BTC',
    timeframe: '1m',
    bootstrapCutoffMs: 1_787_788_820_000,
  });
  expect(wrong.acceptedEvents).toBe(0);
  expect(wrong.integrityIssues).toContain('WRONG_SYMBOL_EVENT');

  const accepted = reconcileAiChartPublicTrades({
    previous,
    events: [trade()],
    market: 'UPBIT',
    symbol: 'BTC',
    timeframe: '1m',
    bootstrapCutoffMs: 1_787_788_820_000,
  });
  const duplicate = reconcileAiChartPublicTrades({
    previous: accepted.reduction,
    events: [trade()],
    market: 'UPBIT',
    symbol: 'BTC',
    timeframe: '1m',
    bootstrapCutoffMs: 1_787_788_820_000,
  });
  expect(duplicate.acceptedEvents).toBe(0);
  expect(duplicate.latestCandle).toBeNull();

  const gap = reconcileAiChartPublicTrades({
    previous,
    events: [trade({ eventId: 'gap', eventTimeMs: 1_787_789_040_000 })],
    market: 'UPBIT',
    symbol: 'BTC',
    timeframe: '1m',
    bootstrapCutoffMs: 1_787_788_820_000,
  });
  expect(gap.acceptedEvents).toBe(0);
  expect(gap.needsSnapshot).toBe(true);
  expect(gap.integrityIssues).toContain('BAR_COVERAGE_GAP');
  expect(gap.reduction).toEqual(previous);
});

test('stream identity includes timeframe and generation', () => {
  const base = { market: 'UPBIT' as const, symbol: 'BTC', timeframe: '15m' as const, generation: 1 };
  expect(aiChartStreamIdentityKey(base)).not.toBe(aiChartStreamIdentityKey({ ...base, timeframe: '1H' }));
  expect(aiChartStreamIdentityKey(base)).not.toBe(aiChartStreamIdentityKey({ ...base, generation: 2 }));
});

test('runtime wiring uses bounded client reconciliation and imperative incremental chart updates', () => {
  const unified = readFileSync(new URL('../src/components/unified-analysis-chart.tsx', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../src/components/pattern-aware-unified-chart-canvas.tsx', import.meta.url), 'utf8');

  expect(unified).toContain('createAiChartPublicStreamClient');
  expect(unified).toContain('reconcileAiChartPublicTrades');
  expect(unified).toContain('streamGenerationRef.current !== generation');
  expect(unified).toContain('applyRealtimeCandle');
  expect(canvas).toContain('useImperativeHandle');
  expect(canvas).toContain('instance.candle.update');
  expect(canvas).toContain('instance.volume.update');
});
