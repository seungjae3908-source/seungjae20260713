import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const scannerSource = readFileSync(
  new URL('../src/pages/signal-scanner.tsx', import.meta.url),
  'utf8',
);
const intelligenceSource = readFileSync(
  new URL('../src/components/ai-chart-v2-intelligence-panel.tsx', import.meta.url),
  'utf8',
);
const aiChartPageSource = readFileSync(
  new URL('../src/pages/ai-chart.tsx', import.meta.url),
  'utf8',
);

test('Scanner passes signal score and confidence as separate fields', () => {
  const selectionBlock = scannerSource.match(
    /const selectionFor = \(card: ScannerSignalCard\): AnalysisSelection => \(\{[\s\S]*?selectedAt:/,
  )?.[0] ?? '';

  expect(selectionBlock).toContain('signalScore: card.score');
  expect(selectionBlock).toContain('confidence: card.confidence');
});

test('AI Chart prefers canonical Scanner signalScore and uses confidence only as fallback', () => {
  expect(intelligenceSource).toContain(
    'const scannerScore = finiteScore(selection.signalScore ?? selection.confidence);',
  );
  expect(intelligenceSource).not.toContain(
    'const scannerScore = finiteScore(selection.confidence ?? selection.signalScore);',
  );
});

test('AI Chart keeps signal score and confidence visibly distinct', () => {
  expect(aiChartPageSource).toContain('>신호점수</p>');
  expect(aiChartPageSource).toContain('{selection.signalScore ?? \'-\'}');
  expect(aiChartPageSource).toContain('>신뢰도</p>');
  expect(aiChartPageSource).toContain('{confidence ?? \'-\'}');
});
