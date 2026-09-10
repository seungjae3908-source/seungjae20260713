import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('standalone backtest page uses the centered compact application shell', () => {
  const backtests = source('src/pages/backtests.tsx');
  expect(backtests).toContain("import { CenteredPageHeader } from '@/components/centered-page-header'");
  expect(backtests).toContain('title="백테스트"');
  expect(backtests).toContain('eyebrow="코인 선물 연구"');
  expect(backtests).toContain('<BacktestResearchPanel compact />');
});

test('settings page uses the shared centered page header without the removed long info popup', () => {
  const more = source('src/pages/more.tsx');
  expect(more).toContain("import { CenteredPageHeader } from '@/components/centered-page-header'");
  expect(more).toContain('title="설정"');
  expect(more).not.toContain('infoTitle=');
  expect(more).not.toContain('설정 안내');
  expect(more).not.toContain('SlidersHorizontal');
});

test('scanner readiness stays in document flow instead of covering results', () => {
  const readiness = source('src/components/scanner-readiness-status.tsx');
  expect(readiness).toContain('className="shrink-0 border-b border-card-border bg-background px-3 py-2 sm:px-4"');
  expect(readiness).not.toContain('pointer-events-none absolute');
  expect(readiness).toContain('data-testid="scanner-partial"');
  expect(readiness).toContain('다시 시도');
});
