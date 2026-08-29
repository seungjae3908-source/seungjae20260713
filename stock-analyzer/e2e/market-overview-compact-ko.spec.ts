import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('market overview separates mobile tabs and desktop three-column dashboard', () => {
  const overview = source('src/pages/market-overview.tsx');

  expect(overview).toContain("type OverviewTab = 'indices' | 'sectors' | 'briefing';");
  expect(overview).toContain('data-testid="market-overview-mobile-tabs"');
  expect(overview).toContain('data-testid="market-overview-indices"');
  expect(overview).toContain('data-testid="market-overview-sectors"');
  expect(overview).toContain('data-testid="market-overview-briefing"');
  expect(overview).toContain('lg:grid-cols-3');
  expect(overview).toContain("mobileTab !== 'indices' && 'hidden lg:block'");
  expect(overview).toContain("mobileTab !== 'sectors' && 'hidden lg:block'");
  expect(overview).toContain("mobileTab !== 'briefing' && 'hidden lg:block'");
  expect(overview).toContain('지수 확인 중');
  expect(overview).toContain('섹터 확인 중');
  expect(overview).toContain('브리핑 확인 중');
  expect(overview).not.toContain('주요 지수와 섹터 흐름을 한눈에 확인합니다.');
});
