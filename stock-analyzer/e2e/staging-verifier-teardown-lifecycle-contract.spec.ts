import fs from 'node:fs';
import { expect, test } from '@playwright/test';

test('keeps verifier teardown proof alive for requestfailed events delivered after context close', () => {
  const source = fs.readFileSync(
    new URL('./phase10-staging-readiness.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = source.indexOf('async function runAuthenticatedAiChartCertification');
  const helperEnd = source.indexOf('async function auditAuthenticatedViewport', helperStart);
  const helper = source.slice(helperStart, helperEnd);
  const mark = helper.indexOf('verifierOwnedContextTeardowns.set(page, new URL(page.url()).origin);');
  const close = helper.indexOf('await context.close();');

  expect(helperStart).toBeGreaterThanOrEqual(0);
  expect(helperEnd).toBeGreaterThan(helperStart);
  expect(mark).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(mark);
  expect(helper).not.toContain('verifierOwnedContextTeardowns.delete(page)');
  expect(source).toContain('const verifierOwnedContextTeardowns = new WeakMap<Page, string>();');
});
