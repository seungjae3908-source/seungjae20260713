import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

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