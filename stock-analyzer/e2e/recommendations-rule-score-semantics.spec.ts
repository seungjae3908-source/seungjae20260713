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

  // Presentation-only remediation: preserve the existing score threshold semantics.
  expect(page).toContain('row.score >= 70 ? "positive" : "muted"');
});
