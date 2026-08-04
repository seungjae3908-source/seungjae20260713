import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const spec = await readFile(
  path.join(root, 'stock-analyzer/e2e/phase10-staging-readiness.spec.ts'),
  'utf8',
);
const app = await readFile(
  path.join(root, 'stock-analyzer/src/App.tsx'),
  'utf8',
);
const auth = await readFile(
  path.join(root, 'stock-analyzer/src/lib/auth.tsx'),
  'utf8',
);
const routes = await readFile(
  path.join(root, 'api-server/src/routes/index.ts'),
  'utf8',
);
const assert = (condition, message) => {
  if (!condition) throw new Error(`[staging-login-selector-contract] ${message}`);
};

const scopedSelector = "page.locator('form').getByRole('button', { name: /^로그인$|sign in|log in/i })";
const ambiguousSelector = "page.getByRole('button', { name: /^로그인$|sign in|log in/i })";
const approvedLoginRoute = '<Route path="/login" component={AccountPage} />';

assert(spec.includes('function loginSubmitButton(page: Page)'), 'login submit helper is missing');
assert(spec.includes(scopedSelector), 'login submit button must be scoped to the login form');
assert(!spec.includes(ambiguousSelector), 'unscoped login button selector can match both the tab and submit button');
assert(
  (spec.match(/loginSubmitButton\(page\)/g) ?? []).length >= 4,
  'anonymous, login, logout, and post-refresh checks must share the scoped login submit selector',
);
assert(app.includes(approvedLoginRoute), 'approved sessions must render the account page at /login instead of the 404 route');
assert(
  app.indexOf(approvedLoginRoute) < app.indexOf('<Route component={AuthenticatedApp} />'),
  '/login must be resolved before the authenticated catch-all router',
);

assert(spec.includes('expected_logout_aborts: Diagnostic[]'), 'expected logout abort diagnostics bucket is missing');
assert(spec.includes('type LogoutObservation = { candidates: Diagnostic[] }'), 'logout aborts must remain pending until post-logout checks pass');
assert(spec.includes('const activeLogoutObservations = new WeakMap<Page, LogoutObservation>()'), 'logout observation must be scoped to the active page');
assert(spec.includes("request.method() === 'POST'"), 'only POST logout requests may be considered expected');
assert(spec.includes("parsed.pathname === '/auth/v1/logout'"), 'logout path must match exactly');
assert(spec.includes('query.length === 1'), 'logout request must contain no query parameter other than scope');
assert(spec.includes("query[0]?.[0] === 'scope'"), 'logout query key must be scope');
assert(spec.includes("query[0]?.[1] === 'global'"), 'logout scope must be global');
assert(spec.includes("request.failure()?.errorText === 'net::ERR_ABORTED'"), 'only the exact Chromium abort reason may be expected');

const visibleIndex = spec.indexOf('await expect(logoutButton).toBeVisible();');
const observationIndex = spec.indexOf('activeLogoutObservations.set(page, observation);');
const clickIndex = spec.indexOf('await logoutButton.click();');
assert(visibleIndex >= 0 && observationIndex > visibleIndex && clickIndex > observationIndex, 'expected window must open only around an explicit visible logout-button click');
assert(spec.includes('observation.candidates.push(diagnostic);'), 'matching aborts must be held as candidates first');
assert(
  spec.indexOf('diagnostics.expected_logout_aborts.push(...observation.candidates);')
    > spec.indexOf("expect(\n      [401, 403],"),
  'candidates may become expected only after protected API denial is confirmed',
);
assert(spec.includes('await page.reload();'), 'logout validation must refresh the page');
assert(spec.includes("await expect(page.getByRole('button', { name: /로그아웃|sign out/i })).toHaveCount(0);"), 'logout session must not return after refresh');
assert(spec.includes("page.request.get('/api/paper-journal/snapshot')"), 'logout validation must probe a protected API');
assert(spec.includes('[401, 403]'), 'protected API must be denied with 401 or 403 after logout');
assert(spec.includes('unconfirmed logout abort:'), 'unconfirmed candidates must return to unexpected HTTP errors');
assert(spec.includes('diagnostics.unexpected_http_errors.push(diagnostic);'), 'all non-matching failed requests must remain unexpected');
assert(spec.includes('if (response.status() < 400) return;'), 'all browser 4xx and 5xx responses must remain unexpected');
assert(!spec.includes("'/rest/v1/profiles'"), 'profile request aborts must be eliminated in the app, never allowlisted in staging diagnostics');

assert(spec.includes("return parsed.pathname || '/';"), 'diagnostic URLs must omit hosts and arbitrary query strings');
assert(spec.includes("'[redacted-url]'"), 'absolute URLs must be redacted from diagnostic details');
assert(spec.includes("'[redacted-token]'"), 'JWT-like tokens must be redacted from diagnostic details');
assert(spec.includes("'[redacted-key]'"), 'Supabase-style keys must be redacted from diagnostic details');
assert(spec.includes("'$1[redacted]'"), 'named password, token, secret, and key values must be redacted');

assert(spec.includes('for (let pass = 0; pass < 2; pass += 1)'), 'network settlement must require two quiet passes');
assert(spec.includes("await page.waitForLoadState('networkidle', { timeout: 30_000 });"), 'network settlement must fail instead of swallowing a timeout');
assert(!spec.includes("waitForLoadState('networkidle', { timeout: 20_000 }).catch"), 'network-idle timeouts must not be ignored');
assert(
  spec.indexOf('await settle(page);\n  const response = await page.goto(route') >= 0,
  'healthy route navigation must settle the previous page before leaving it',
);
assert(spec.includes('async function expectDeniedRoute(page: Page, route: string)'), 'denied route navigation must share a pre-navigation settlement helper');
assert(spec.includes('/stock-info?asset=stock&market=KR&ticker=005930'), 'stock staging routes must use the application ticker query parameter');

const capabilityIndex = routes.indexOf("router.use(requireCapability('canAccessBasicInfo'));");
const coinFeedIndex = routes.indexOf("router.get('/stocks/special-feed'");
const stocksRouterIndex = routes.indexOf("router.use('/stocks', stocksRouter);");
assert(capabilityIndex >= 0 && coinFeedIndex > capabilityIndex, 'optional coin feed must remain behind basic-info authorization');
assert(stocksRouterIndex > coinFeedIndex, 'optional coin feed fallback must run before the stock feed router');
assert(routes.includes("if (asset !== 'coin')"), 'stock feed requests must continue to the real stock router');
assert(routes.includes("res.status(200).json({"), 'unconnected coin feed must degrade through an HTTP 200 response');
assert(routes.includes("items: []"), 'unconnected coin feed must return an empty item list');
assert(routes.includes("ok: false"), 'unconnected coin feed must remain visibly marked as unavailable');

assert(auth.includes('useMemo, useRef, useState'), 'auth provider must import useRef for logout coordination');
assert(auth.includes('const signingOutRef = useRef(false);'), 'auth provider must track an active logout barrier');
assert(auth.includes('const profileLoadQueueRef = useRef<Promise<void>>(Promise.resolve());'), 'auth provider must track every profile load in a serial queue');
assert(auth.includes('if (signingOutRef.current) return Promise.resolve();'), 'new profile loads must stop after logout begins');
assert(auth.includes("profileLoadQueueRef.current\n      .catch(() => undefined)"), 'profile loads must remain serial even after an earlier load failure');
assert(auth.includes('profileLoadQueueRef.current = queued.catch(() => undefined);'), 'profile queue failures must not permanently block later logout');
assert(auth.includes('if (!signingOutRef.current) setProfile'), 'late profile responses must not restore profile state during logout');
assert(auth.includes('if (active && !signingOutRef.current) void loadProfile(session.user);'), 'timer, focus, and visibility refreshes must stop during logout');

const authSignOutIndex = auth.indexOf('async signOut() {');
const logoutBarrierIndex = auth.indexOf('signingOutRef.current = true;', authSignOutIndex);
const drainIndex = auth.indexOf('await profileLoadQueueRef.current;', authSignOutIndex);
const globalLogoutIndex = auth.indexOf('await getSupabase().auth.signOut();', authSignOutIndex);
const clearSessionIndex = auth.indexOf('setSession(null);', globalLogoutIndex);
const releaseBarrierIndex = auth.indexOf('signingOutRef.current = false;', globalLogoutIndex);
assert(authSignOutIndex >= 0, 'auth provider global signOut implementation is missing');
assert(
  logoutBarrierIndex > authSignOutIndex
    && drainIndex > logoutBarrierIndex
    && globalLogoutIndex > drainIndex,
  'logout must raise the barrier, drain profile requests, and only then call Supabase global signOut',
);
assert(clearSessionIndex > globalLogoutIndex, 'successful global logout must explicitly clear the local session');
assert(releaseBarrierIndex > clearSessionIndex, 'logout barrier must remain active until session and profile cleanup finish');

console.log('[staging-login-selector-contract] logout classification, profile-request drain, diagnostic redaction, optional coin-feed degradation, and navigation stability are locked down');
