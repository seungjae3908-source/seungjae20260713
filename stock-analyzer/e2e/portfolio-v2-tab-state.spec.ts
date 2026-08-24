import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('portfolio V2 keeps all primary tabs visible, marks journal selected, and hides the nested legacy tab strip', async () => {
  const source = await readFile(new URL('../src/pages/portfolio-v2.tsx', import.meta.url), 'utf8');

  expect(source).toContain('className="grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1"');
  expect(source).toContain("aria-pressed={tab === 'journal'}");
  expect(source).toContain("tab === 'journal' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'");
  expect(source).not.toContain("{tab !== 'journal' ? <button");
  expect(source).toContain("[&_[aria-label='포트폴리오_보기']]:hidden");
  expect(source.match(/min-h-11 rounded-xl/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
});
