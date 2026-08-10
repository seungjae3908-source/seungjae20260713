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
assert(spec.includes('logoutObservation.candidates.push(diagnostic);'), 'matching logout aborts must be held as candidates first');
assert(spec.includes('routeObservation.candidates.push(diagnostic);'), 'matching route-transition aborts must be held as candidates first');
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
const profileMatcherStart = spec.indexOf('function isProfileRequest(request: Request)');
const profileMatcherEnd = spec.indexOf(
  '\nfunction isExpectedAuthFault(',
  profileMatcherStart,
);
assert(
  profileMatcherStart >= 0 && profileMatcherEnd > profileMatcherStart,
  'profile request matcher boundaries are missing',
);
const profileMatcherBlock = spec.slice(profileMatcherStart, profileMatcherEnd);
const hasExactProfileRequestIdentification = (source) =>
  source.includes("request.method() === 'GET'")
  && source.includes("parsed.pathname === '/rest/v1/profiles'")
  && !source.includes('request.failure()');
assert(
  hasExactProfileRequestIdentification(profileMatcherBlock),
  'profile fault injection must identify only exact GET /rest/v1/profiles requests without classifying a failure reason',
);
assert(
  hasExactProfileRequestIdentification(
    "return request.method() === 'GET' && parsed.pathname === '/rest/v1/profiles';",
  ),
  'exact profile request identification fixture must be accepted',
);
assert(
  !hasExactProfileRequestIdentification("if (url.includes('/rest/v1/profiles')) return true;"),
  'broad profile-path fixture must not satisfy exact request identification',
);

const authFaultMatcherStart = spec.indexOf(
  'function isExpectedAuthFault(request: Request, observation: AuthFaultObservation)',
);
const authFaultMatcherEnd = spec.indexOf(
  '\nfunction isExpectedRouteTransitionAbort(',
  authFaultMatcherStart,
);
assert(
  authFaultMatcherStart >= 0 && authFaultMatcherEnd > authFaultMatcherStart,
  'auth fault matcher boundaries are missing',
);
const authFaultMatcherBlock = spec.slice(authFaultMatcherStart, authFaultMatcherEnd);
assert(
  authFaultMatcherBlock.includes(
    'return observation.requests.has(request) && isProfileRequest(request);',
  ),
  'expected auth faults must require both the observed request identity and the exact profile matcher',
);
assert(
  (spec.match(/observation\.requests\.add\(request\);/g) ?? []).length >= 3,
  'bootstrap reject, timeout, and retry fault injection must register the exact intercepted profile request',
);

const requestFailedStart = spec.indexOf("page.on('requestfailed', (request) => {");
const requestFailedEnd = spec.indexOf(
  '\nasync function waitForPresentationFrame(page: Page)',
  requestFailedStart,
);
assert(
  requestFailedStart >= 0 && requestFailedEnd > requestFailedStart,
  'requestfailed diagnostic handler boundaries are missing',
);
const requestFailedBlock = spec.slice(requestFailedStart, requestFailedEnd);
const authFaultCandidateIndex = requestFailedBlock.indexOf('authFault.candidates.push(diagnostic);');
const routeCandidateIndex = requestFailedBlock.indexOf('routeObservation.candidates.push(diagnostic);');
const unmatchedFailureIndex = requestFailedBlock.lastIndexOf(
  'diagnostics.unexpected_http_errors.push(diagnostic);',
);
assert(
  authFaultCandidateIndex >= 0
    && routeCandidateIndex > authFaultCandidateIndex
    && unmatchedFailureIndex > routeCandidateIndex,
  'unmatched request failures must remain unexpected after all narrowly scoped candidate checks',
);

const finishAuthFaultStart = spec.indexOf('async function finishAuthFault(');
const finishAuthFaultEnd = spec.indexOf(
  '\nasync function expectBootstrapTerminalError(',
  finishAuthFaultStart,
);
assert(
  finishAuthFaultStart >= 0 && finishAuthFaultEnd > finishAuthFaultStart,
  'auth fault finalization helper boundaries are missing',
);
const finishAuthFaultBlock = spec.slice(finishAuthFaultStart, finishAuthFaultEnd);
const confirmedAuthFaultIndex = finishAuthFaultBlock.indexOf(
  'diagnostics.expected_auth_faults.push(...observation.candidates);',
);
const unconfirmedAuthFaultIndex = finishAuthFaultBlock.indexOf(
  'diagnostics.unexpected_http_errors.push(...observation.candidates.map((item) => ({',
);
assert(
  confirmedAuthFaultIndex >= 0 && unconfirmedAuthFaultIndex > confirmedAuthFaultIndex,
  'unconfirmed auth fault candidates must return to unexpected HTTP errors',
);
assert(
  finishAuthFaultBlock.includes('unconfirmed auth fault:'),
  'unconfirmed auth fault evidence must remain explicitly labeled',
);

assert(!spec.includes('function isExpectedProfileAbort('), 'blanket profile abort exemption is forbidden');
assert(!spec.includes('expected_profile_aborts'), 'profile aborts must not have a blanket expected diagnostics bucket');
assert(!spec.includes('function isExpectedScannerAbort('), 'blanket scanner abort exemption is forbidden');
assert(
  !spec.includes('diagnostics.expected_scanner_aborts.push('),
  'scanner request failures must never be promoted into the expected scanner abort bucket',
);
assert(
  spec.includes("expect(diagnostics.expected_scanner_aborts, 'scanner net::ERR_ABORTED must remain zero').toEqual([]);"),
  'scanner net::ERR_ABORTED must remain a zero-tolerance staging contract',
);

assert(spec.includes("return parsed.pathname || '/';"), 'diagnostic URLs must omit hosts and arbitrary query strings');
assert(spec.includes("'[redacted-url]'"), 'absolute URLs must be redacted from diagnostic details');
assert(spec.includes("'[redacted-token]'"), 'JWT-like tokens must be redacted from diagnostic details');
assert(spec.includes("'[redacted-key]'"), 'Supabase-style keys must be redacted from diagnostic details');
assert(spec.includes("'$1[redacted]'"), 'named password, token, secret, and key values must be redacted');

assert(spec.includes('async function waitForPresentationFrame(page: Page)'), 'presentation-frame readiness helper is missing');
assert(spec.includes("await page.waitForLoadState('load');"), 'route settlement must require the browser load event');
assert(spec.includes('requestAnimationFrame(() => requestAnimationFrame(() => resolve()));'), 'route settlement must wait for two browser presentation frames');
assert(spec.includes('for (let pass = 0; pass < 2; pass += 1)'), 'presentation settlement must require two stable passes');
assert(spec.includes("expect(page.url(), 'route changed while presentation was settling').toBe(urlBeforeFrame);"), 'each presentation pass must prove the route stayed stable');
assert(spec.includes("await expect(page.locator('body')).toBeVisible();"), 'each presentation pass must prove the rendered body is visible');
assert(!spec.includes("waitForLoadState('networkidle'"), 'polling and bounded provider requests must not be treated as a route-readiness failure');
assert(!spec.includes('.catch(() => undefined)'), 'route settlement failures must not be swallowed');

const settleHelperStart = spec.indexOf('async function settle(page: Page)');
const settleHelperEnd = spec.indexOf(
  '\nfunction loginSubmitButton(',
  settleHelperStart,
);
assert(
  settleHelperStart >= 0 && settleHelperEnd > settleHelperStart,
  'route settlement helper boundaries are missing',
);
const settleHelperBlock = spec.slice(settleHelperStart, settleHelperEnd);
const settleLoadIndex = settleHelperBlock.indexOf("await page.waitForLoadState('load');");
const settleBodyVisibleIndex = settleHelperBlock.indexOf(
  "await expect(page.locator('body')).toBeVisible();",
  settleLoadIndex,
);
const settleMutationDrainIndex = settleHelperBlock.indexOf(
  'await waitForPendingMutations(page);',
  settleBodyVisibleIndex,
);
assert(
  settleLoadIndex >= 0
    && settleBodyVisibleIndex > settleLoadIndex
    && settleMutationDrainIndex > settleBodyVisibleIndex,
  'route settlement must render the page and drain mutating browser requests before navigation can continue',
);

const healthyRouteStart = spec.indexOf(
  'async function expectHealthyRoute(page: Page, route: string)',
);
const healthyRouteEnd = spec.indexOf(
  '\nasync function expectDeniedRoute(',
  healthyRouteStart,
);
assert(
  healthyRouteStart >= 0 && healthyRouteEnd > healthyRouteStart,
  'healthy route helper boundaries are missing',
);
const healthyRouteBlock = spec.slice(healthyRouteStart, healthyRouteEnd);
const routeSettleIndex = healthyRouteBlock.indexOf('await settle(page);');
const routeObservationIndex = healthyRouteBlock.indexOf(
  'const observation: RouteTransitionObservation = {',
  routeSettleIndex,
);
const activateObservationIndex = healthyRouteBlock.indexOf(
  'activeRouteTransitionObservations.set(page, observation);',
  routeObservationIndex,
);
const routeGotoIndex = healthyRouteBlock.indexOf(
  'const response = await page.goto(',
  activateObservationIndex,
);
const routeStatusIndex = healthyRouteBlock.indexOf(
  'expect(response.status()',
  routeGotoIndex,
);
const destinationSettleIndex = healthyRouteBlock.indexOf(
  'await settle(page);',
  routeStatusIndex,
);
const destinationRouteIndex = healthyRouteBlock.indexOf(
  'expect(routeIdentity(page.url())).toBe(observation.toRoute);',
  destinationSettleIndex,
);
const notFoundIndex = healthyRouteBlock.indexOf(
  'not.toContainText(/페이지를 찾을 수 없습니다|page not found/i)',
  destinationRouteIndex,
);
const notEmptyIndex = healthyRouteBlock.indexOf(
  'not.toBeEmpty();',
  notFoundIndex,
);
const confirmedIndex = healthyRouteBlock.indexOf(
  'confirmed = true;',
  notEmptyIndex,
);
const finishTransitionIndex = healthyRouteBlock.indexOf(
  'await finishRouteTransition(page, observation, confirmed);',
  confirmedIndex,
);
assert(
  routeSettleIndex >= 0
    && routeObservationIndex > routeSettleIndex
    && activateObservationIndex > routeObservationIndex
    && routeGotoIndex > activateObservationIndex,
  'healthy route navigation must settle the previous page and begin scoped transition observation before leaving it',
);
assert(
  routeStatusIndex > routeGotoIndex
    && destinationSettleIndex > routeStatusIndex
    && destinationRouteIndex > destinationSettleIndex
    && notFoundIndex > destinationRouteIndex
    && notEmptyIndex > notFoundIndex
    && confirmedIndex > notEmptyIndex
    && finishTransitionIndex > confirmedIndex,
  'healthy route navigation must validate and settle the destination before confirming route-transition abort candidates',
);
assert(spec.includes('async function expectDeniedRoute(page: Page, route: string)'), 'denied route navigation must share a pre-navigation settlement helper');
assert(spec.includes('/stock-info?asset=stock&market=KR&ticker=005930'), 'stock staging routes must use the application ticker query parameter');

const capabilityIndex = routes.indexOf("router.use(requireCapability('canAccessBasicInfo'));");
const coinFeedIndex = routes.indexOf("router.get('/stocks/special-feed'");
const financialDelayIndex = routes.indexOf("router.use('/stocks/:ticker/financials'");
const stocksRouterIndex = routes.indexOf("router.use('/stocks', stocksRouter);");
assert(capabilityIndex >= 0 && coinFeedIndex > capabilityIndex, 'optional coin feed must remain behind basic-info authorization');
assert(stocksRouterIndex > coinFeedIndex, 'optional coin feed fallback must run before the stock feed router');
assert(routes.includes("if (asset !== 'coin')"), 'stock feed requests must continue to the real stock router');
assert(routes.includes("res.status(200).json({"), 'unconnected coin feed must degrade through an HTTP 200 response');
assert(routes.includes("items: []"), 'unconnected coin feed must return an empty item list');
assert(routes.includes("ok: false"), 'unconnected coin feed must remain visibly marked as unavailable');

assert(
  financialDelayIndex > capabilityIndex && financialDelayIndex < stocksRouterIndex,
  'financial provider degradation must remain authorized and scoped before the stock router',
);
assert(
  routes.includes("res.statusCode !== 503 || payload?.code !== 'FINANCIAL_PROVIDER_DELAY'"),
  'only the exact 503 FINANCIAL_PROVIDER_DELAY response may be degraded',
);
assert(routes.includes('const originalJson = res.json.bind(res);'), 'successful financial responses must pass through the original serializer');
assert(routes.includes('res.statusCode = 200;'), 'the exact provider delay must become a non-error HTTP response');
assert(routes.includes('available: false'), 'provider delay must remain explicitly unavailable');
assert(routes.includes('financials: unavailableFinancials'), 'provider delay must preserve the frontend financials response shape');
assert(routes.includes('annual: []') && routes.includes('quarterly: []'), 'unavailable financial data must use empty statement arrays');
assert(routes.includes('source: null'), 'unavailable financial data must not claim a provider source');
assert(
  (routes.match(/FINANCIAL_PROVIDER_DELAY/g) ?? []).length === 1,
  'financial delay conversion must not broaden to additional endpoints or error codes',
);
assert(!routes.includes('res.statusCode >= 500'), 'generic server errors must never be converted into successful responses');

assert(auth.includes('useMemo, useRef, useState'), 'auth provider must import useRef for logout coordination');
assert(auth.includes('const signingOutRef = useRef(false);'), 'auth provider must track an active logout barrier');
assert(auth.includes('const sessionRef = useRef<Session | null>(null);'), 'auth provider must track the synchronously current session identity');
assert(auth.includes('const profileLoadQueueRef = useRef<Promise<void>>(Promise.resolve());'), 'auth provider must track every profile load in a serial queue');
assert(auth.includes('function applySession(next: Session | null)'), 'auth provider must update session identity and React state through one helper');
assert(
  auth.includes('sessionRef.current = next;\n    setSession(next);'),
  'session identity must change synchronously before React session state is scheduled',
);
assert(
  (auth.match(/setSession\(/g) ?? []).length === 1,
  'all session mutations must pass through the synchronous session identity helper',
);
assert(
  auth.includes('if (signingOutRef.current || sessionRef.current?.user.id !== user.id) return Promise.resolve();'),
  'new or stale-user profile loads must stop after logout begins or session identity changes',
);
assert(
  auth.includes('if (signingOutRef.current || sessionRef.current?.user.id !== user.id) return;'),
  'queued profile work must recheck logout and session identity before starting a provider request',
);
assert(auth.includes("profileLoadQueueRef.current\n      .catch(() => undefined)"), 'profile loads must remain serial even after an earlier load failure');
assert(auth.includes('profileLoadQueueRef.current = queued.catch(() => undefined);'), 'profile queue failures must not permanently block later logout');
assert(
  auth.includes('if (!signingOutRef.current && sessionRef.current?.user.id === user.id)'),
  'late profile responses must not restore profile state after logout or a user change',
);
assert(auth.includes('if (active && !signingOutRef.current) void loadProfile(session.user).catch(() => undefined);'), 'timer, focus, and visibility refreshes must stop during logout');

const authSignOutIndex = auth.indexOf('async signOut() {');
const logoutBarrierIndex = auth.indexOf('signingOutRef.current = true;', authSignOutIndex);
const drainIndex = auth.indexOf('await profileLoadQueueRef.current;', authSignOutIndex);
const globalLogoutIndex = auth.indexOf('await getSupabase().auth.signOut();', authSignOutIndex);
const clearSessionIndex = auth.indexOf('applySession(null);', globalLogoutIndex);
const releaseBarrierIndex = auth.indexOf('signingOutRef.current = false;', globalLogoutIndex);
assert(authSignOutIndex >= 0, 'auth provider global signOut implementation is missing');
assert(
  logoutBarrierIndex > authSignOutIndex
    && drainIndex > logoutBarrierIndex
    && globalLogoutIndex > drainIndex,
  'logout must raise the barrier, drain profile requests, and only then call Supabase global signOut',
);
assert(clearSessionIndex > globalLogoutIndex, 'successful global logout must synchronously invalidate session identity');
assert(releaseBarrierIndex > clearSessionIndex, 'logout barrier must remain active until session identity and profile cleanup finish');

console.log('[staging-login-selector-contract] logout and route-transition candidate classification, current-session profile guard, diagnostic redaction, optional provider degradation, and polling-safe presentation stability are locked down');
