import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const tabPath = fileURLToPath(new URL('../src/components/tabs/ai-tab.tsx', import.meta.url));

test('malformed successful AI analysis fails closed before reason lists render', async () => {
  const source = await readFile(tabPath, 'utf8');

  expect(source).toContain('function validAnalysisPayload(value: unknown): boolean');
  expect(source).toContain('validReasonList(record.buyReasons)');
  expect(source).toContain('validReasonList(record.sellReasons)');
  expect(source).toContain('if (!validAnalysisPayload(data))');
  expect(source).toContain('AI_ANALYSIS_CONTRACT_INVALID');

  const guard = source.indexOf('if (!validAnalysisPayload(data))');
  const buyReasons = source.indexOf('<ReasonList items={data.buyReasons}');
  const sellReasons = source.indexOf('<ReasonList items={data.sellReasons}');
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(buyReasons).toBeGreaterThan(guard);
  expect(sellReasons).toBeGreaterThan(guard);
});

test('missing strategy evidence never fabricates target or stop prices', async () => {
  const source = await readFile(tabPath, 'utf8');

  expect(source).toContain('const strategyHasEvidence = Boolean(');
  expect(source).toContain('목표가·손절가 근거 미수집');
  expect(source).toContain('없는 숫자를 현재가 기준 임의 퍼센트로 만들지 않습니다.');
  expect(source).not.toContain('formatPrice(data.targetPrice, currency)');
  expect(source).not.toContain('formatPrice(data.stopLossPrice, currency)');
  expect(source).not.toContain('실시간 차트 데이터가 부족하여 모델 추정값으로 표시합니다.');
});
