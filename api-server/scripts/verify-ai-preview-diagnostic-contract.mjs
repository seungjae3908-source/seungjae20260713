import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[ai-preview-diagnostic-contract] ${message}`);
};

const [spec, sessionHelper, helper, helperTest, sanitizer, playwright, phase8Db, bootstrap] = await Promise.all([
  read('stock-analyzer/e2e/phase10-staging-readiness.spec.ts'),
  read('stock-analyzer/e2e/support/browser-session-api.ts'),
  read('stock-analyzer/e2e/support/safe-api-diagnostic.ts'),
  read('stock-analyzer/e2e/support/safe-api-diagnostic.test.ts'),
  read('api-server/scripts/sanitize-staging-playwright-artifacts.mjs'),
  read('stock-analyzer/playwright.config.ts'),
  read('api-server/scripts/verify-phase8-db.sh'),
  read('api-server/scripts/apply-staging-supabase-bootstrap.mjs'),
]);

const regularIndex = spec.indexOf("test('regular: futures, scanner, paper trading, and safe AI preview");
const requestIndex = spec.indexOf('requestWithBrowserSession(', regularIndex);
const requestPathIndex = spec.indexOf("'/api/paper-journal/ai-review/preview'", requestIndex);
const diagnosticIndex = spec.indexOf('collectSafeApiDiagnostic(preview', requestPathIndex);
const artifactIndex = spec.indexOf('diagnostics.api_diagnostics.push(previewDiagnostic)', diagnosticIndex);
const assertionIndex = spec.indexOf('preview.ok()', diagnosticIndex);
assert(
  regularIndex >= 0
    && requestIndex > regularIndex
    && requestPathIndex > requestIndex
    && diagnosticIndex > requestPathIndex
    && artifactIndex > diagnosticIndex
    && assertionIndex > artifactIndex,
  'authenticated status and safe body fields must be captured before preview.ok() assertion',
);
assert(spec.includes('api_diagnostics: SafeApiDiagnostic[]'), 'staging artifact has no typed API diagnostic collection');
assert(!spec.includes('const previewBody = await preview.json()'), 'staging spec must not record or assert from an unfiltered preview body');
assert(!spec.includes('preview.text()'), 'staging spec must not read raw preview text');

const routeIdentityIndex = spec.indexOf('function routeIdentity(');
const routeIdentityEndIndex = spec.indexOf('\n}\n\nfunction diagnosticText', routeIdentityIndex);
const routeIdentitySource = spec.slice(routeIdentityIndex, routeIdentityEndIndex);
assert(
  routeIdentityIndex >= 0
    && routeIdentityEndIndex > routeIdentityIndex
    && routeIdentitySource.includes('`${parsed.pathname}${parsed.search}`'),
  'route identity must include both pathname and search parameters',
);

const routeAbortIndex = spec.indexOf('function isExpectedRouteTransitionAbort(');
const routeAbortEndIndex = spec.indexOf('\n}\n\nfunction isSameOriginApiGet', routeAbortIndex);
const routeAbortSource = spec.slice(routeAbortIndex, routeAbortEndIndex);
for (const marker of [
  'observation.fromRoute !== observation.toRoute',
  'observation.pendingGetRequests.has(request)',
  "request.method() === 'GET'",
  "parsed.pathname.startsWith('/api/')",
  "request.failure()?.errorText === 'net::ERR_ABORTED'",
]) {
  assert(routeAbortSource.includes(marker), `scoped route-transition abort classifier is missing ${marker}`);
}
assert(
  !routeAbortSource.includes("includes('net::ERR_ABORTED')")
    && !routeAbortSource.includes('includes("net::ERR_ABORTED")'),
  'route-transition abort classifier must require the exact Playwright abort error',
);

for (const marker of [
  'expected_route_transition_aborts',
  'activeRouteTransitionObservations',
  'pendingApiGetRequests',
  'pendingGetRequests: new Set(pendingApiGetRequests.get(page) ?? [])',
  'await finishRouteTransition(page, observation, confirmed)',
  'expectScannerAfterFutures(page)',
]) {
  assert(spec.includes(marker), `scoped route-transition abort contract is missing ${marker}`);
}
assert(
  !spec.includes("parsed.pathname.includes('/chart')"),
  'route-transition abort handling must not use a broad chart allowlist',
);

const healthyRouteIndex = spec.indexOf('async function expectHealthyRoute(');
const pendingSnapshotIndex = spec.indexOf(
  'pendingGetRequests: new Set(pendingApiGetRequests.get(page) ?? [])',
  healthyRouteIndex,
);
const routeNavigationIndex = spec.indexOf("await page.goto(route, { waitUntil: 'domcontentloaded' })", healthyRouteIndex);
assert(
  healthyRouteIndex >= 0
    && pendingSnapshotIndex > healthyRouteIndex
    && routeNavigationIndex > pendingSnapshotIndex,
  'positive abort contract must snapshot pending GET requests before route navigation starts',
);

const responseListenerIndex = spec.indexOf("page.on('response', (response) => {");
const responseFailureIndex = spec.indexOf('diagnostics.unexpected_http_errors.push({', responseListenerIndex);
const requestFailedListenerIndex = spec.indexOf("page.on('requestfailed', (request) => {", responseListenerIndex);
assert(
  responseListenerIndex >= 0
    && responseFailureIndex > responseListenerIndex
    && requestFailedListenerIndex > responseFailureIndex,
  'HTTP 4xx/5xx responses must continue to be recorded as unexpected failures',
);

const expectedRouteAbortIndex = spec.indexOf(
  'isExpectedRouteTransitionAbort(request, routeObservation)',
  requestFailedListenerIndex,
);
const unexpectedRequestFailureIndex = spec.indexOf(
  'diagnostics.unexpected_http_errors.push(diagnostic)',
  expectedRouteAbortIndex,
);
assert(
  requestFailedListenerIndex >= 0
    && expectedRouteAbortIndex > requestFailedListenerIndex
    && unexpectedRequestFailureIndex > expectedRouteAbortIndex,
  'non-matching request failures must continue to fall through to unexpected HTTP errors',
);
assert(
  spec.includes('if (isMutatingBrowserRequest(request)) mutations.add(request);')
    && spec.includes('await waitForPendingMutations(page);'),
  'mutating requests must remain tracked and settled before route navigation',
);

const liveIndex = phase8Db.indexOf('if [[ -n "${DATABASE_URL:-}" ]]');
const liveArtifactIndex = phase8Db.indexOf('staging-bootstrap-verification.json', liveIndex);
const liveStaticVerifierIndex = phase8Db.indexOf('verify-paper-journal-privilege-contract.mjs', liveIndex);
const liveExitIndex = phase8Db.indexOf('exit 0', liveIndex);
const passwordIndex = phase8Db.indexOf('PGPASSWORD is required for disposable Phase 8 verification');
const firstDownMigrationIndex = phase8Db.indexOf('.down.sql');
assert(
  liveIndex >= 0
    && liveArtifactIndex > liveIndex
    && liveStaticVerifierIndex > liveArtifactIndex
    && liveExitIndex > liveStaticVerifierIndex
    && passwordIndex > liveExitIndex
    && firstDownMigrationIndex > liveExitIndex,
  'live staging evidence verification must exit before disposable credentials and rollback fixtures',
);

const schemaVersionMatch = bootstrap.match(/\bconst\s+SCHEMA_VERSION\s*=\s*(['"])([^'"]+)\1\s*;/);
assert(schemaVersionMatch, 'staging bootstrap schema version constant is missing');
const expectedSchemaVersion = schemaVersionMatch[2];
const liveEvidenceSection = phase8Db.slice(liveIndex, liveExitIndex);
assert(
  liveEvidenceSection.includes(`value.schema_version !== '${expectedSchemaVersion}'`)
    || liveEvidenceSection.includes(`value.schema_version !== "${expectedSchemaVersion}"`),
  'live staging bootstrap evidence schema version must match the bootstrap producer',
);

for (const marker of [
  'atomic_transaction !== true',
  'idempotency_passes !== 2',
  'production_export_used !== false',
  'auth_users_copied !== 0',
  'profile_rows_copied !== 0',
  'storage_objects_copied !== 0',
  'credentials_recorded !== false',
  'rollback remains disposable-CI only',
]) {
  assert(phase8Db.includes(marker), `live staging bootstrap evidence contract is missing ${marker}`);
}

for (const field of [
  'testStep',
  'requestPath',
  'status',
  'errorCode',
  'safeMessage',
  'externalAiCalled',
  'orderSubmitted',
  'exchangeRequestSent',
]) {
  assert(helper.includes(`${field}:`), `safe diagnostic is missing ${field}`);
}
for (const forbidden of [
  '.text()',
  '.headers()',
  'authorization',
  'cookie',
  'accessToken',
  'refreshToken',
  'userId',
  'email',
  'stack',
  'sql',
]) {
  assert(!helper.includes(forbidden), `safe diagnostic helper references forbidden content: ${forbidden}`);
}
assert(
  /errorCode:\s*status\s*>=\s*400\s*\?\s*'NON_JSON_RESPONSE'\s*:\s*null/.test(helper),
  'non-JSON error responses must fail closed without raw text',
);
assert(helper.includes("errorCode: 'UNRECOGNIZED_ERROR_CODE'"), 'unknown error codes must not be copied');
assert(helper.includes('SAFE_ERROR_MESSAGES'), 'safe messages must use an exact allowlist');
assert(helperTest.includes('records only allowlisted preview failure fields'), 'safe failure diagnostic test is missing');
assert(helperTest.includes('unknown error code and message fail closed'), 'unknown error diagnostic test is missing');
assert(helperTest.includes('non-JSON response records status without raw response text'), 'non-JSON diagnostic test is missing');
assert(helperTest.includes('successful preview retains only safety booleans'), 'success diagnostic test is missing');
assert(sanitizer.includes('Unsafe staging artifact content'), 'artifact sanitizer must remain fail closed');
assert(sanitizer.includes('Raw Playwright trace is forbidden'), 'raw trace rejection must remain enabled');
assert(playwright.includes("trace: stagingMode ? 'off'"), 'raw staging Playwright trace must remain disabled');

console.log('[ai-preview-diagnostic-contract] authenticated browser request, query-aware route identity, positive pre-navigation GET abort classification, negative real-failure fallthrough, live evidence-only DB verification, safe diagnostics, sanitizer and raw-trace prohibition verified');
