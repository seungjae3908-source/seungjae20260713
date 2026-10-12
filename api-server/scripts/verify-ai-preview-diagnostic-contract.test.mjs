import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeContractSource } from './contract-source-text.mjs';
import { verifyAiPreviewDiagnosticContract } from './ai-preview-diagnostic-contract.mjs';
import { verifyStagingDetailCanonicalRouteContract } from './staging-detail-canonical-route-contract.mjs';

const paths = [
  'stock-analyzer/e2e/phase10-staging-readiness.spec.ts',
  'stock-analyzer/e2e/support/browser-session-api.ts',
  'stock-analyzer/e2e/support/safe-api-diagnostic.ts',
  'stock-analyzer/e2e/support/safe-api-diagnostic.test.ts',
  'api-server/scripts/sanitize-staging-playwright-artifacts.mjs',
  'stock-analyzer/playwright.config.ts',
  'api-server/scripts/verify-phase8-db.sh',
  'api-server/scripts/apply-staging-supabase-bootstrap.mjs',
  'stock-analyzer/src/lib/asset-navigation.ts',
  'stock-analyzer/src/App.tsx',
];
const originals = Object.fromEntries(await Promise.all(paths.map(async relative => [
  relative, normalizeContractSource(await readFile(new URL('../../' + relative, import.meta.url), 'utf8')),
])));
const spec = paths[0], diagnostic = paths[2], sanitizer = paths[4], database = paths[6];
const endings = {
  LF: source => source,
  CRLF: source => source.replaceAll('\n', '\r\n'),
  MIXED: source => {
    let index = 0;
    return source.replace(/\n/gu, () => index++ % 2 ? '\n' : '\r\n');
  },
};
const sources = convert => Object.fromEntries(Object.entries(originals).map(([key, value]) => [key, convert(value)]));
const check = values => verifyAiPreviewDiagnosticContract(async relative => {
  if (!Object.hasOwn(values, relative)) throw new Error('CONTRACT_SOURCE_MISSING');
  return values[relative];
});

test('every pre-fix safety assertion remains byte-identical, in the same order', async () => {
  const text = normalizeContractSource(await readFile(new URL('./ai-preview-diagnostic-contract.mjs', import.meta.url), 'utf8'));
  const start = text.indexOf('const regularIndex =');
  const end = text.lastIndexOf('\n}');
  assert.ok(start >= 0 && end > start);
  const body = text.slice(start, end).replace(/^  /gmu, '').trim();
  // Assertion body from the previously verified Draft HEAD 548ca9a3.
  assert.equal(createHash('sha256').update(body).digest('hex'),
    '178009020827570993d1005c514225e51cd80cfb0826361e3fd6f38cbc2a8745');
});

const forbiddenChanges = [
  { name: 'query identity omitted', path: spec, from: '$' + '{parsed.search}', to: '',
    error: /route identity must include both pathname and search/ },
  { name: 'pending-request binding removed', path: spec,
    from: 'observation.pendingGetRequests.has(request)', to: 'true',
    error: /scoped route-transition abort classifier is missing/ },
  { name: 'read-only GET binding removed', path: spec,
    from: "request.method() === 'GET'", to: 'true',
    error: /scoped route-transition abort classifier is missing/ },
  { name: 'exact abort error broadened', path: spec,
    from: "request.failure()?.errorText === 'net::ERR_ABORTED'",
    to: "request.failure()?.errorText.includes('net::ERR_ABORTED')",
    error: /scoped route-transition abort classifier is missing|exact Playwright abort/ },
  { name: 'real HTTP failures hidden', path: spec,
    from: 'diagnostics.unexpected_http_errors.push({', to: 'diagnostics.expected_http_errors.push({',
    error: /HTTP 4xx\/5xx responses/ },
  { name: 'pending mutations not settled', path: spec,
    from: 'await waitForPendingMutations(page);', to: 'await skipPendingMutations(page);',
    error: /mutating requests must remain tracked and settled/ },
  { name: 'raw response allowed', path: diagnostic, append: '\n// .text()\n',
    error: /safe diagnostic helper references forbidden content/ },
  { name: 'raw trace guard removed', path: sanitizer,
    from: 'Raw Playwright trace is forbidden', to: 'Raw trace allowed',
    error: /raw trace rejection must remain enabled/ },
  { name: 'account-copy denial removed', path: database,
    from: 'auth_users_copied !== 0', to: 'auth_users_copied < 0',
    error: /live staging bootstrap evidence contract is missing/ },
  { name: 'disposable-only rollback guard removed', path: database,
    from: 'rollback remains disposable-CI only', to: 'rollback allowed',
    error: /live staging bootstrap evidence contract is missing/ },
];

for (const [name, convert] of Object.entries(endings)) {
  test(name + ': intact safety contract passes', async () => check(sources(convert)));
  for (const mutation of forbiddenChanges) {
    test(name + ': ' + mutation.name + ' stays blocked', async () => {
      const values = sources(convert);
      const original = originals[mutation.path];
      if (mutation.from) assert.ok(original.includes(mutation.from), mutation.name);
      const modified = mutation.append ? original + mutation.append
        : original.replaceAll(mutation.from, mutation.to);
      assert.notEqual(modified, original);
      values[mutation.path] = convert(modified);
      await assert.rejects(check(values), mutation.error);
    });
  }
}

test('missing source evidence remains fail-closed', async () => {
  const values = sources(endings.CRLF);
  delete values[diagnostic];
  await assert.rejects(check(values), /CONTRACT_SOURCE_MISSING/);
});

test('non-text source evidence remains fail-closed', async () => {
  const values = sources(endings.CRLF);
  values[diagnostic] = null;
  await assert.rejects(check(values), /CONTRACT_SOURCE_TEXT_REQUIRED/);
});

test('every pre-fix canonical-route safety assertion remains unchanged', async () => {
  const text = normalizeContractSource(await readFile(new URL('./staging-detail-canonical-route-contract.mjs', import.meta.url), 'utf8'));
  const start = text.indexOf('assert(\n    navigation.includes');
  const end = text.lastIndexOf('\n}');
  assert.ok(start >= 0 && end > start);
  const body = text.slice(start, end).replace(/^  /gmu, '').trim();
  assert.equal(createHash('sha256').update(body).digest('hex'),
    '2b8226a2aa29ee16f378101da258e93a46c20920a14f4882e6d3a34be19f8d9a');
});

const routeChanges = [
  { name: 'fixture exception widened', path: spec,
    from: "requestedRoute === '/stock/005930'", to: "requestedRoute.startsWith('/stock/')",
    error: /only the exact 005930 legacy fixture/ },
  { name: 'canonical market identity changed', path: spec,
    from: '/stock-info?back=%2Fstocks&asset=stock&market=KR&ticker=005930',
    to: '/stock-info?back=%2Fstocks&asset=stock&market=US&ticker=005930',
    error: /only the exact 005930 legacy fixture/ },
  { name: 'canonical destination not confirmed', path: spec,
    from: ').toBe(expectedRoute);', to: ').toBe(requestedRoute);',
    error: /canonical destination must be confirmed/ },
  { name: 'settled URL stability removed', path: spec,
    from: "expect(page.url(), 'route changed while presentation was settling').toBe(urlBeforeFrame);",
    to: "expect(page.url()).toContain('/stock');",
    error: /strict post-canonical URL stability/ },
  { name: 'final route binding removed', path: spec,
    from: 'expect(routeIdentity(page.url())).toBe(observation.toRoute);',
    to: "expect(routeIdentity(page.url())).toContain('/stock');",
    error: /exact expected destination/ },
  { name: 'duplicate fixture exception', path: spec,
    append: "\n// requestedRoute === '/stock/005930'\n",
    error: /canonical exception must remain singular/ },
  { name: 'generic legacy-route acceptance', path: spec,
    append: "\n// startsWith('/stock/')\n",
    error: /legacy detail must not be accepted as canonical/ },
];
const checkRoute = values => verifyStagingDetailCanonicalRouteContract(async relative => {
  if (!Object.hasOwn(values, relative)) throw new Error('CONTRACT_SOURCE_MISSING');
  return values[relative];
});
for (const [name, convert] of Object.entries(endings)) {
  test(name + ': intact canonical route contract passes', async () => checkRoute(sources(convert)));
  for (const mutation of routeChanges) {
    test(name + ': ' + mutation.name + ' stays blocked', async () => {
      const values = sources(convert);
      const original = originals[mutation.path];
      if (mutation.from) assert.ok(original.includes(mutation.from), mutation.name);
      const modified = mutation.append ? original + mutation.append
        : original.replaceAll(mutation.from, mutation.to);
      assert.notEqual(modified, original);
      values[mutation.path] = convert(modified);
      await assert.rejects(checkRoute(values), mutation.error);
    });
  }
}
