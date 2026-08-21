import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function analyzerDirectory() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

test('disclosure UI never presents deterministic classification guidance as AI analysis', () => {
  const source = fs.readFileSync(
    path.join(analyzerDirectory(), 'src/components/tabs/disclosure-tab.tsx'),
    'utf8',
  );

  expect(source).not.toContain('AI 해석:');
  expect(source).toContain('분류 안내:');
  expect(source).toContain('실제 주가 영향은 원문과 재무 내용을 함께 확인하세요.');
});
