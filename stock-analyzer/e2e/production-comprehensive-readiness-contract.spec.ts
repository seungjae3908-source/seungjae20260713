import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('Production route audit waits for the mounted app shell before accepting zero busy elements', () => {
  const app = source('src/App.tsx');
  const qa = source('e2e/production-comprehensive-readonly-qa.spec.ts');
  const auditStart = qa.indexOf('async function auditRoute');
  const auditEnd = qa.indexOf('async function ensureSearchPage', auditStart);
  const auditRoute = qa.slice(auditStart, auditEnd);
  const shellCheck = auditRoute.indexOf("page.getByTestId('app-shell').isVisible");
  const busyCheck = auditRoute.indexOf("page.locator('[aria-busy=\"true\"]:visible').count", shellCheck);

  expect(app).toContain('data-testid="app-shell"');
  expect(auditStart).toBeGreaterThanOrEqual(0);
  expect(auditEnd).toBeGreaterThan(auditStart);
  expect(shellCheck).toBeGreaterThan(0);
  expect(busyCheck).toBeGreaterThan(shellCheck);
  expect(auditRoute).toContain("{ timeout: 5_000, intervals: [100, 200, 400, 800] }).toBe('READY')");
  expect(auditRoute).toContain("page.goto(route, { waitUntil: 'commit', timeout: 15_000 })");
  expect(auditRoute).not.toContain("expect(page.getByTestId('page-fallback')).toHaveCount(0");
  expect(qa).toContain("expect(audits.filter((item) => item.busyAfter5s > 0)");
});
