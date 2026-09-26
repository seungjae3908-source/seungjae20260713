import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('portfolio V2 keeps all primary tabs visible through the shared tab system and hides the nested legacy strip', async () => {
  const source = await readFile(new URL('../src/pages/portfolio-v2.tsx', import.meta.url), 'utf8');

  expect(source).toContain("import { ResponsiveTabs } from '@/components/responsive-tabs';");
  expect(source).toContain("{ value: 'intelligence', label: '자산 현황' }");
  expect(source).toContain("{ value: 'holdings', label: '보유자산' }");
  expect(source).toContain("{ value: 'journal', label: '매매일지' }");
  expect(source).toContain('testId="portfolio-v2-tabs"');
  expect(source).toContain('ariaLabel="포트폴리오 보기"');
  expect(source).toContain('onChange={selectTab}');
  expect(source).not.toContain("{tab !== 'journal' ? <button");
  expect(source).toContain("[&_[aria-label='포트폴리오_보기']]:hidden");
});
