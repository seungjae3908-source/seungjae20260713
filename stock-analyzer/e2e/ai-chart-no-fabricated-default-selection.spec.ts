import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const source = readFileSync(new URL('../src/pages/ai-chart.tsx', import.meta.url), 'utf8');

test('AI Chart does not fabricate a Samsung selection when no asset is selected', () => {
  expect(source).toContain('function emptySelection(): AnalysisSelection');
  expect(source).toContain("symbol: ''");
  expect(source).toContain("ticker: ''");
  expect(source).toContain("displayName: '종목 미선택'");
  expect(source).toContain('data-testid="ai-chart-empty-selection"');
  expect(source).toContain('if (invalidRoute || !hasSelection) return;');
  expect(source).not.toContain('function fallbackSelection()');
  expect(source).not.toContain("displayName: '삼성전자'");
  expect(source).not.toContain("symbol: '005930'");
});
