import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { buildTechnicalTimeframeEvidence } from '../src/lib/ai-chart-v2-intelligence';

const intelligenceSource = readFileSync(
  new URL('../src/lib/ai-chart-v2-intelligence.ts', import.meta.url),
  'utf8',
);
const panelSource = readFileSync(
  new URL('../src/components/ai-chart-v2-intelligence-panel.tsx', import.meta.url),
  'utf8',
);

test('freshness quality is separate from live transport semantics', () => {
  expect(intelligenceSource).toContain(
    "export type AiChartDataQuality = 'FRESH' | 'DELAYED' | 'STALE' | 'PARTIAL' | 'UNAVAILABLE';",
  );
  expect(intelligenceSource).toContain(
    "export type AiChartTransportMode = 'LIVE_STREAM' | 'FALLBACK_POLLING' | 'POLLING_PAUSED' | 'DISCONNECTED' | 'RECOVERING';",
  );
  expect(intelligenceSource).toContain("if (status === 'ok') return 'FRESH';");
  expect(intelligenceSource).not.toContain("if (status === 'ok') return 'LIVE';");
  expect(panelSource).toContain("if (quality === 'FRESH')");
  expect(panelSource).not.toContain("quality === 'LIVE'");
});

test('partial candle data cannot activate a Scanner direction before minimum evidence checks', () => {
  const result = buildTechnicalTimeframeEvidence({
    market: 'BITGET',
    mode: 'SCALPING',
    timeframe: '5m',
    dataStatus: 'insufficient',
    candleCount: 1,
    trend: 'bullish',
    close: 100,
    ema12: 101,
    ema26: 99,
    vwap: 99,
    rsi14: 55,
    macdHistogram: 1,
    volumeRatio20: 2,
    atr14: 1,
    scannerAction: 'LONG',
    scannerConfidence: 95,
    scannerReasons: ['scanner context must not bypass partial data'],
  });

  expect(result.quality).toBe('PARTIAL');
  expect(result.state).toBe('INSUFFICIENT_DATA');
  expect(result.side).toBe('WAIT');
  expect(result.score).toBeNull();
  expect(result.reasonCodes).toContain('INSUFFICIENT_DATA');
});
