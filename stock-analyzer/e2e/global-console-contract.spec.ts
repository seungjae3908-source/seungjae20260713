import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const mainSourceUrl = new URL('../src/main.tsx', import.meta.url);

test('application bootstrap does not suppress global console errors', async () => {
  const source = await readFile(mainSourceUrl, 'utf8');

  expect(source).not.toContain('console.error =');
  expect(source).not.toContain('configureRecoverableSearchDiagnostics');
  expect(source).not.toContain('공통 시세 보강 건너뜀');
  expect(source).toContain('configureUnifiedChartFetch(authorizedFetch);');
  expect(source).toContain("createRoot(document.getElementById('root')!).render(<App />);");
});
