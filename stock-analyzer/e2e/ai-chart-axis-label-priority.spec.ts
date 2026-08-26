import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const source = readFileSync(
  new URL('../src/components/pattern-aware-unified-chart-canvas.tsx', import.meta.url),
  'utf8',
);

test('indicator overlays keep their chart series while suppressing redundant right-axis last-value labels', () => {
  const createLineBlock = source.match(/function createLine\([\s\S]*?\n}\n\nfunction setLineData/)?.[0] ?? '';

  expect(createLineBlock).toContain("return chart.addLineSeries({");
  expect(createLineBlock).toContain('lastValueVisible: false');
  expect(createLineBlock).toContain('priceLineVisible: false');

  const indicatorSeriesCreations = source.match(/createLine\(chart,/g) ?? [];
  expect(indicatorSeriesCreations).toHaveLength(10);
  expect(source).toContain("title: 'SMA5'");
  expect(source).toContain("title: 'SMA20'");
  expect(source).toContain("title: 'VWAP'");
  expect(source).toContain("title: 'BB 상단'");
});

test('canonical Scanner Price Plan labels take priority over generic reference and pattern axis labels', () => {
  expect(source).toContain('const higherPriorityPrices = planPriorityPrices(pricePlan);');
  expect(source).toContain('const showSecondaryAxisLabels = higherPriorityPrices.length === 0;');

  const secondaryLabelGuards = source.match(
    /axisLabelVisible: showSecondaryAxisLabels && !conflictsWithHigherPriority/g,
  ) ?? [];
  expect(secondaryLabelGuards).toHaveLength(3);

  for (const label of ['2차 저항', '1차 저항', '1차 지지', '2차 지지', '목표 참고', '무효 기준']) {
    expect(source).toContain(`title: '${label}'`);
  }
  expect(source).toContain("title: `패턴 확인선 · ${patternOverlay.status}`");
  expect(source).toContain("title: '패턴 무효화선'");

  const scannerPlanBlock = source.match(
    /removePriceLines\(instance\.candle, instance\.pricePlanLines\);[\s\S]*?removePriceLines\(instance\.candle, instance\.analysisPriceLines\);/,
  )?.[0] ?? '';
  expect(scannerPlanBlock).toContain("title: 'Scanner 손절'");
  expect(scannerPlanBlock).toContain("title: 'Scanner 무효화'");
  expect(scannerPlanBlock).toContain("title: 'Scanner 진입 하단'");
  expect(scannerPlanBlock).toContain("title: 'Scanner 진입 상단'");
  expect(scannerPlanBlock).toContain('title: `Scanner 목표 ${index + 1}`');
  expect(scannerPlanBlock).toContain('axisLabelVisible: true');
});

test('risk-critical liquidation label remains visible while position average still yields on an exact Scanner conflict', () => {
  const positionBlock = source.match(
    /removePriceLines\(instance\.candle, instance\.positionPriceLines\);[\s\S]*?\}, \[market, positionOverlay, pricePlan, resetKey\]\);/,
  )?.[0] ?? '';

  expect(positionBlock).toContain("title: positionOverlay.stale ? '내 평단 · 오래된 값' : '내 평단'");
  expect(positionBlock).toContain('axisLabelVisible: !conflictsWithHigherPriority(average, planPriorityPrices(pricePlan))');
  expect(positionBlock).toContain("title: positionOverlay.stale ? '청산가 · 오래된 값' : '청산가'");
  expect(positionBlock).toContain('axisLabelVisible: true');
});
