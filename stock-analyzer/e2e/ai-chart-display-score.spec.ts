import { expect, test } from '@playwright/test';
import { formatAiChartScore } from '../src/lib/ai-chart-display';

test('AI Chart score display bounds precision without changing the underlying value', () => {
  const value = 93.545331681183588;
  expect(formatAiChartScore(value)).toBe('93.55');
  expect(value).toBe(93.545331681183588);
});

test('AI Chart score display preserves explicit zero and fails closed on missing/non-finite values', () => {
  expect(formatAiChartScore(0)).toBe('0');
  expect(formatAiChartScore(null)).toBe('-');
  expect(formatAiChartScore(undefined)).toBe('-');
  expect(formatAiChartScore(Number.NaN)).toBe('-');
  expect(formatAiChartScore(Number.POSITIVE_INFINITY)).toBe('-');
});
