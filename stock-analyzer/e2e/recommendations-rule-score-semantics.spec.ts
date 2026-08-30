import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('rule-based recommendation score is not presented as calibrated probability', () => {
  const page = source('src/pages/recommendations.tsx');

  expect(page).toContain('규칙 기반 분석 · AI(LLM) 미연결');
  expect(page).toContain('규칙 점수 {row.score}점');
  expect(page).not.toContain('상승 가능성 {row.score}점');
  expect(page).not.toContain('상승 확률 {row.score}');
  expect(page).not.toContain('승률 {row.score}');

  // Presentation-only score remediation: preserve the existing score threshold semantics.
  expect(page).toContain('row.score >= 70 ? "positive" : "muted"');
});

test('recommendation change percent keeps missing distinct from genuine zero in the UI', () => {
  const page = source('src/pages/recommendations.tsx');

  expect(page).toContain('changePercent: number | null;');
  expect(page).toContain('row.changePercent == null');
  expect(page).toContain('? "text-muted-foreground"');
  expect(page).toContain('row.changePercent == null ? "—" : formatAppPercent(row.changePercent)');
});
