import fs from 'node:fs';
import { expect, test } from '@playwright/test';

test('staging arms scanner response evidence only after the previous route settles', () => {
  const source = fs.readFileSync(
    new URL('./phase10-staging-readiness.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = source.indexOf('async function expectHealthyRoute(page: Page, route: string): Promise<void>;');
  const helperEnd = source.indexOf('async function expectDeniedRoute', helperStart);
  const helper = source.slice(helperStart, helperEnd);
  const settle = helper.indexOf('await settle(page);');
  const arm = helper.indexOf('const observedResponsePromise = observeAfterSettle?.();');
  const navigation = helper.indexOf("page.goto(route, { waitUntil: 'domcontentloaded' })");
  const observation = helper.indexOf('observedValue = await observedResponsePromise;');

  expect(helperStart).toBeGreaterThanOrEqual(0);
  expect(helperEnd).toBeGreaterThan(helperStart);
  expect(settle).toBeGreaterThan(0);
  expect(arm).toBeGreaterThan(settle);
  expect(navigation).toBeGreaterThan(arm);
  expect(observation).toBeGreaterThan(navigation);
  expect(helper).toContain('observeAfterSettle: () => Promise<T>');
  expect(helper).toContain('Promise<T | void>');

  const auditStart = source.indexOf('async function auditAuthenticatedViewport');
  const auditEnd = source.indexOf('function errorsFor', auditStart);
  const audit = source.slice(auditStart, auditEnd);

  expect(auditStart).toBeGreaterThanOrEqual(0);
  expect(auditEnd).toBeGreaterThan(auditStart);
  expect(audit).not.toContain("const scannerResponsePromise = route === '/scanner'");
  expect(audit).toContain('let scannerResponse: Response | null = null;');
  expect(audit).toContain("if (route === '/scanner') {");
  expect(audit).toContain('scannerResponse = await expectHealthyRoute(');
  expect(audit).toContain('() => page.waitForResponse((response) => {');
  expect(audit).toContain("url.pathname === '/api/market/scan'");
  expect(audit).toContain('{ timeout: 15_000 }');
  expect(audit).toContain("scanner viewport API returned HTTP ${scannerResponse.status()}");
});
