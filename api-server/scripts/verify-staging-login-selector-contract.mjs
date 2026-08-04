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
  (spec.match(/loginSubmitButton\(page\)/g) ?? []).length >= 5,
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

assert(spec.includes("return parsed.pathname || '/';"), 'diagnostic URLs must omit hosts and arbitrary query strings');
assert(spec.includes("'[redacted-url]'"), 'absolute URLs must be redacted from diagnostic details');
assert(spec.includes("'[redacted-token]'"), 'JWT-like tokens must be redacted from diagnostic details');
assert(spec.includes("'[redacted-key]'"), 'Supabase-style keys must be redacted from diagnostic details');
assert(spec.includes("'$1[redacted]'"), 'named password, token, secret, and key values must be redacted');

console.log('[staging-login-selector-contract] login selectors, approved /login routing, and eight-condition global logout abort classification are locked down');
