import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const supabasePath = fileURLToPath(new URL('../src/lib/supabase.ts', import.meta.url));
const deviceTrustPath = fileURLToPath(new URL('../src/lib/device-trust.ts', import.meta.url));
const appPath = fileURLToPath(new URL('../../api-server/src/app.ts', import.meta.url));
const runtimeEntryPath = fileURLToPath(new URL('../../api-server/src/index.ts', import.meta.url));
const runtimeRouterPath = fileURLToPath(new URL('../../api-server/src/routes/index.ts', import.meta.url));
const authMiddlewarePath = fileURLToPath(new URL('../../api-server/src/middleware/auth.ts', import.meta.url));
const phase10StagingPath = fileURLToPath(new URL('./phase10-staging-readiness.spec.ts', import.meta.url));

test('auth bootstrap self-profile read is same-origin, exact-identity, and device-trust aware', async () => {
  const [
    supabaseSource,
    deviceTrustSource,
    appSource,
    runtimeEntrySource,
    runtimeRouterSource,
    authSource,
    phase10StagingSource,
  ] = await Promise.all([
    readFile(supabasePath, 'utf8'),
    readFile(deviceTrustPath, 'utf8'),
    readFile(appPath, 'utf8'),
    readFile(runtimeEntryPath, 'utf8'),
    readFile(runtimeRouterPath, 'utf8'),
    readFile(authMiddlewarePath, 'utf8'),
    readFile(phase10StagingPath, 'utf8'),
  ]);

  expect(supabaseSource).toContain("parsed.pathname.replace(/\\/+$/u, '') !== '/rest/v1/profiles'");
  expect(supabaseSource).toContain("parsed.searchParams.get('select') !== '*'");
  expect(supabaseSource).toContain("parsed.searchParams.get('id') !== `eq.${subject}`");
  expect(supabaseSource).toContain("await fetch('/api/auth/profile'");
  expect(supabaseSource).toContain("method: 'GET'");
  expect(supabaseSource).toContain("proxyHeaders.set('Authorization', authorization!)");
  expect(supabaseSource).toContain("import { deviceTrustRequestHeaders } from '@/lib/device-trust';");
  expect(supabaseSource).toContain('Object.entries(deviceTrustRequestHeaders())');
  expect(deviceTrustSource).toContain("const DEVICE_SESSION_STORAGE_KEY = 'device-trust-session-v1';");
  expect(deviceTrustSource).toContain('export function deviceTrustRequestHeaders()');
  expect(deviceTrustSource).toContain("return session ? { 'X-Device-Session': session } : {};");

  const deviceTrustGate = appSource.indexOf("app.use('/api', deviceTrustAppGate);");
  const profileRoute = appSource.indexOf("app.get('/api/auth/profile', requireAuthenticated");
  const privateRouter = appSource.indexOf('app.use("/api", router);');
  expect(deviceTrustGate).toBeGreaterThanOrEqual(0);
  expect(profileRoute).toBeGreaterThan(deviceTrustGate);
  expect(privateRouter).toBeGreaterThan(profileRoute);

  const routeBody = appSource.slice(profileRoute, privateRouter);
  expect(routeBody).toContain('const profile = req.member;');
  expect(routeBody).not.toContain('req.query');
  expect(routeBody).not.toContain('req.params');
  expect(routeBody).toContain("'Cache-Control', 'no-store, max-age=0'");

  // Production and staging are built from src/index.ts, not src/app.ts. Lock
  // the same endpoint into the router that the deployed entry actually mounts.
  expect(runtimeEntrySource).toContain("import apiRouter from './routes';");
  expect(runtimeEntrySource).toContain("app.use('/api', apiRouter);");
  const runtimeProfileRoute = runtimeRouterSource.indexOf(
    "router.get('/auth/profile', requireAuthenticated",
  );
  const runtimePrivateGate = runtimeRouterSource.indexOf('router.use(requireAuthenticated);');
  expect(runtimeProfileRoute).toBeGreaterThanOrEqual(0);
  expect(runtimePrivateGate).toBeGreaterThan(runtimeProfileRoute);
  const runtimeRouteBody = runtimeRouterSource.slice(runtimeProfileRoute, runtimePrivateGate);
  expect(runtimeRouteBody).toContain('const profile = req.member;');
  expect(runtimeRouteBody).not.toContain('req.query');
  expect(runtimeRouteBody).not.toContain('req.params');
  expect(runtimeRouteBody).toContain("'Cache-Control', 'no-store, max-age=0'");

  expect(authSource).toContain(".eq('id', auth.user.id)");
  expect(authSource).toContain("res.status(401).json({ error: 'INVALID_SESSION' })");
  expect(authSource).toContain("res.status(403).json({ error: 'PROFILE_NOT_FOUND' })");

  // Lock the exact Full Staging failure shape: a previously authenticated
  // storage state is restored into fresh browser contexts, then the direct
  // /ai-chart cold route must leave the global bootstrap fallback inside the
  // existing frozen 5 second product gate. The repair above must apply to this
  // path without weakening that gate or replacing it with a retry.
  expect(phase10StagingSource).toContain(
    'const storageState = await authenticatedPage.context().storageState();',
  );
  expect(phase10StagingSource).toContain('const context = await browser.newContext({');
  expect(phase10StagingSource).toContain('storageState,');
  expect(phase10StagingSource).toContain(
    "const response = await page.goto('/ai-chart', { waitUntil: 'domcontentloaded' });",
  );
  expect(phase10StagingSource).toContain('const cold = await waitForUsableAiChart(page, coldStarted);');
  expect(phase10StagingSource).toContain(
    "page.getByRole('heading', { name: /AI 차트 생중계/, level: 1 })).toBeVisible({ timeout: 5_000 })",
  );
});
