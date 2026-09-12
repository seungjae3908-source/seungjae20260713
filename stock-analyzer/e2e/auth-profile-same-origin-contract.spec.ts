import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const supabasePath = fileURLToPath(new URL('../src/lib/supabase.ts', import.meta.url));
const appPath = fileURLToPath(new URL('../../api-server/src/app.ts', import.meta.url));
const authMiddlewarePath = fileURLToPath(new URL('../../api-server/src/middleware/auth.ts', import.meta.url));

test('auth bootstrap self-profile read is same-origin and exact-identity only', async () => {
  const [supabaseSource, appSource, authSource] = await Promise.all([
    readFile(supabasePath, 'utf8'),
    readFile(appPath, 'utf8'),
    readFile(authMiddlewarePath, 'utf8'),
  ]);

  expect(supabaseSource).toContain("parsed.pathname.replace(/\\/+$/u, '') !== '/rest/v1/profiles'");
  expect(supabaseSource).toContain("parsed.searchParams.get('select') !== '*'");
  expect(supabaseSource).toContain("parsed.searchParams.get('id') !== `eq.${subject}`");
  expect(supabaseSource).toContain("await fetch('/api/auth/profile'");
  expect(supabaseSource).toContain("method: 'GET'");
  expect(supabaseSource).toContain("proxyHeaders.set('Authorization', authorization!)");

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

  expect(authSource).toContain(".eq('id', auth.user.id)");
  expect(authSource).toContain("res.status(401).json({ error: 'INVALID_SESSION' })");
  expect(authSource).toContain("res.status(403).json({ error: 'PROFILE_NOT_FOUND' })");
});
