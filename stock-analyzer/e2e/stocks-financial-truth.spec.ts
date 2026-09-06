import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('stocks rows preserve missing change percent instead of coercing it to zero', () => {
  const page = source('src/pages/stocks.tsx');

  expect(page).toContain('function finitePercent(value: unknown): number | null');
  expect(page).toContain('const change = finitePercent(stock.changePercent);');
  expect(page).toContain("change === null ? '데이터 없음' : formatAppPercent(change)");
  expect(page).not.toContain('const change = Number(stock.changePercent);');
});

test('stocks recommendation cards label deterministic scores as rule scores', () => {
  const page = source('src/pages/stocks.tsx');

  expect(page).toContain('규칙 기반 분석 · AI(LLM) 미연결');
  expect(page).toContain('규칙 점수 {row.score}점');
  expect(page).not.toContain('상승 가능성 {row.score}점');
  expect(page).not.toContain('상승 확률 {row.score}');
  expect(page).not.toContain('승률 {row.score}');
});

test('stocks recommendation change percent remains nullable at the consumer boundary', () => {
  const page = source('src/pages/stocks.tsx');

  expect(page).toContain('changePercent: number | null;');
  expect(page).toContain('const change = finitePercent(row.changePercent);');
  expect(page).toContain("change === null ? '데이터 없음' : formatAppPercent(change)");
});
