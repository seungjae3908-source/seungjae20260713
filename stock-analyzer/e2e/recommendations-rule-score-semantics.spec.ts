import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('rule-based recommendation score is not presented as calibrated probability', () => {
  const page = source('src/pages/recommendations.tsx');

  expect(page).toContain('규칙 기반 후보 · LLM 미연결');
  expect(page).toContain('규칙 점수 {row.score}점');
  expect(page).not.toContain('상승 가능성 {row.score}점');
  expect(page).not.toContain('상승 확률 {row.score}');
  expect(page).not.toContain('승률 {row.score}');

  // Presentation-only score remediation: preserve the existing score threshold semantics.
  expect(page).toMatch(/row\.score >= 70 \? ['"]positive['"] : ['"]muted['"]/);
});

test('recommendation change percent keeps missing distinct from genuine zero in the UI', () => {
  const page = source('src/pages/recommendations.tsx');

  expect(page).toContain('changePercent: number | null;');
  expect(page).toContain('row.changePercent == null');
  expect(page).toContain("? 'text-muted-foreground'");
  expect(page).toContain("row.changePercent == null ? '—' : formatAppPercent(row.changePercent)");
});

test('recommendations uses progressive disclosure and readable card hierarchy', () => {
  const page = source('src/pages/recommendations.tsx');

  expect(page).toContain('data-testid="recommendation-methodology"');
  expect(page).toContain('data-testid="recommendation-card-grid"');
  expect(page).toContain('min-[900px]:grid-cols-2');
  expect(page).toContain('데이터 근거 보기');
  expect(page).not.toContain('text-[9px]');
  expect(page).not.toContain('text-[10px]');
  expect(page).not.toContain('text-[11px]');
  expect(page).not.toContain('font-black');
});
