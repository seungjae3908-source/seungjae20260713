import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  canClassifyResearchReloadAbort,
  getResearchReloadAppNavigation,
  isCompleteResearchReloadProof,
  isResearchReloadAbortCandidate,
  isResearchOverviewRequestIdentity,
  responseBelongsToActiveDocument,
  type ResearchReloadAbortCandidate,
  type ResearchReloadAcceptanceProof,
} from './support/research-reload-abort-contract';

test('selects one app-shell navigation when the Research tablist coexists', async ({ page }) => {
  await page.setContent(`
    <nav role="tablist" aria-label="연구센터 핵심 화면">
      <button role="tab">개요</button>
    </nav>
    <nav aria-label="주요 메뉴">
      <button>정보</button>
    </nav>
  `);

  const appNavigation = getResearchReloadAppNavigation(page);
  await expect(appNavigation).toHaveCount(1);
  await expect(appNavigation).toBeVisible();
});

test('does not accept a Research tablist or an absent app-shell navigation', async ({ page }) => {
  await page.setContent(`
    <nav role="tablist" aria-label="연구센터 핵심 화면">
      <button role="tab">개요</button>
    </nav>
  `);
  await expect(getResearchReloadAppNavigation(page)).toHaveCount(0);

  await page.setContent('<main>연구센터</main>');
  await expect(getResearchReloadAppNavigation(page)).toHaveCount(0);
});

test('keeps the admin journey semantic and preserves session and logout proof ordering', () => {
  const source = fs.readFileSync(
    new URL('./phase10-staging-readiness.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = source.indexOf('async function reloadResearchCenterWithAdminSessionProof');
  const helperEnd = source.indexOf('async function finishRouteTransition', helperStart);
  const helper = source.slice(helperStart, helperEnd);
  const journeyStart = source.indexOf("test('admin: full product staging journey");
  const journeyEnd = source.indexOf('const certificationRoutes', journeyStart);
  const journey = source.slice(journeyStart, journeyEnd);

  expect(helperStart).toBeGreaterThanOrEqual(0);
  expect(helperEnd).toBeGreaterThan(helperStart);
  expect(journeyStart).toBeGreaterThanOrEqual(0);
  expect(journeyEnd).toBeGreaterThan(journeyStart);
  expect(journey).toContain('const nav = getResearchReloadAppNavigation(page);');
  expect(journey).not.toContain("const nav = page.locator('nav');");

  const navigationProof = helper.indexOf('authenticated app-shell navigation must remain visible');
  const protectedSessionProof = helper.indexOf('protected read must remain authenticated');
  const adminCapabilityProof = helper.indexOf('admin Research read must retain canManageMembers');
  expect(protectedSessionProof).toBeGreaterThan(navigationProof);
  expect(adminCapabilityProof).toBeGreaterThan(protectedSessionProof);

  const reloadProof = journey.indexOf('await reloadResearchCenterWithAdminSessionProof(page, nav);');
  const logoutProof = journey.indexOf('await logout(page);');
  const researchBeforeLogout = journey.lastIndexOf(
    "await openMenuRoute('information', '연구센터', '/research-center');",
    logoutProof,
  );
  const accountBeforeLogout = journey.lastIndexOf(
    "await openMenuRoute('settings', '계정', '/account');",
    logoutProof,
  );
  const pendingReadDrainBeforeLogout = journey.indexOf(
    'await waitForPendingPersonalIntegrationReads(page);',
    accountBeforeLogout,
  );
  const postLogoutProof = journey.indexOf('protected API must remain denied after strict full-product session loss');

  expect(logoutProof).toBeGreaterThan(reloadProof);
  expect(researchBeforeLogout).toBeGreaterThan(reloadProof);
  expect(accountBeforeLogout).toBeGreaterThan(researchBeforeLogout);
  expect(pendingReadDrainBeforeLogout).toBeGreaterThan(accountBeforeLogout);
  expect(pendingReadDrainBeforeLogout).toBeLessThan(logoutProof);
  expect(postLogoutProof).toBeGreaterThan(logoutProof);
});

const origin = 'https://staging.example.test';
const candidate: ResearchReloadAbortCandidate = {
  method: 'GET',
  rawUrl: `${origin}/api/admin/research/overview`,
  errorText: 'net::ERR_ABORTED',
  origin,
  startedBeforeReload: true,
};
const completeProof: ResearchReloadAcceptanceProof = {
  fromRoute: '/research-center',
  toRoute: '/research-center',
  intentionalReload: true,
  obsoleteByReload: true,
  browserLifecycleCancelled: true,
  currentPageDataPresent: true,
  sessionRetained: true,
  capabilityRetained: true,
  noUserVisibleError: true,
  freshRequestIssued: true,
  freshResponseStatus: 200,
  staleResponseBlocked: true,
};

test('accepts only the exact pre-reload Research overview request identity', () => {
  expect(isResearchOverviewRequestIdentity(candidate)).toBe(true);
  expect(isResearchReloadAbortCandidate(candidate)).toBe(true);
  expect(isResearchReloadAbortCandidate({ ...candidate, startedBeforeReload: false })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, errorText: 'net::ERR_FAILED' })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, method: 'POST' })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, rawUrl: `${candidate.rawUrl}?refresh=1` })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, rawUrl: `${origin}/api/admin/members` })).toBe(false);
  expect(isResearchReloadAbortCandidate({ ...candidate, rawUrl: 'https://other.example.test/api/admin/research/overview' })).toBe(false);
});

test('classifies the obsolete request only after the complete reload proof', () => {
  expect(isCompleteResearchReloadProof(completeProof)).toBe(true);
  expect(canClassifyResearchReloadAbort(candidate, completeProof)).toBe(true);
});

test('keeps authentication or capability loss as an unexpected failure', () => {
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, sessionRetained: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, capabilityRetained: false })).toBe(false);
});

test('requires current Research data, no visible error, and a successful replacement read', () => {
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, currentPageDataPresent: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, noUserVisibleError: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, freshRequestIssued: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, freshResponseStatus: 503 })).toBe(false);
});

test('does not turn an unrelated route change into a reload exemption', () => {
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, toRoute: '/account' })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, intentionalReload: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, obsoleteByReload: false })).toBe(false);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, browserLifecycleCancelled: false })).toBe(false);
});

test('prevents an old-document response from being accepted by the reloaded lifecycle', () => {
  expect(responseBelongsToActiveDocument('document-before-reload', 'document-after-reload')).toBe(false);
  expect(responseBelongsToActiveDocument('document-after-reload', 'document-after-reload')).toBe(true);
  expect(canClassifyResearchReloadAbort(candidate, { ...completeProof, staleResponseBlocked: false })).toBe(false);
});
