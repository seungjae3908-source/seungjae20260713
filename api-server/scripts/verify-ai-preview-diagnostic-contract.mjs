import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[ai-preview-diagnostic-contract] ${message}`);
};

const [spec, helper, helperTest, sanitizer, playwright] = await Promise.all([
  read('stock-analyzer/e2e/phase10-staging-readiness.spec.ts'),
  read('stock-analyzer/e2e/support/safe-api-diagnostic.ts'),
  read('stock-analyzer/e2e/support/safe-api-diagnostic.test.ts'),
  read('api-server/scripts/sanitize-staging-playwright-artifacts.mjs'),
  read('stock-analyzer/playwright.config.ts'),
]);

const requestIndex = spec.indexOf("page.request.post('/api/paper-journal/ai-review/preview'");
const diagnosticIndex = spec.indexOf('collectSafeApiDiagnostic(preview', requestIndex);
const artifactIndex = spec.indexOf('diagnostics.api_diagnostics.push(previewDiagnostic)', diagnosticIndex);
const assertionIndex = spec.indexOf('preview.ok()', diagnosticIndex);
assert(
  requestIndex >= 0 && diagnosticIndex > requestIndex && artifactIndex > diagnosticIndex && assertionIndex > artifactIndex,
  'status and safe body fields must be captured before preview.ok() assertion',
);
assert(spec.includes('api_diagnostics: SafeApiDiagnostic[]'), 'staging artifact has no typed API diagnostic collection');
assert(!spec.includes('const previewBody = await preview.json()'), 'staging spec must not record or assert from an unfiltered preview body');
assert(!spec.includes('preview.text()'), 'staging spec must not read raw preview text');

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
assert(helper.includes("errorCode: 'NON_JSON_RESPONSE'"), 'non-JSON responses must fail closed without raw text');
assert(helper.includes("errorCode: 'UNRECOGNIZED_ERROR_CODE'"), 'unknown error codes must not be copied');
assert(helper.includes('SAFE_ERROR_MESSAGES'), 'safe messages must use an exact allowlist');
assert(helperTest.includes('records only allowlisted preview failure fields'), 'safe failure diagnostic test is missing');
assert(helperTest.includes('unknown error code and message fail closed'), 'unknown error diagnostic test is missing');
assert(helperTest.includes('non-JSON response records status without raw response text'), 'non-JSON diagnostic test is missing');
assert(helperTest.includes('successful preview retains only safety booleans'), 'success diagnostic test is missing');
assert(sanitizer.includes('Unsafe staging artifact content'), 'artifact sanitizer must remain fail closed');
assert(sanitizer.includes('Raw Playwright trace is forbidden'), 'raw trace rejection must remain enabled');
assert(playwright.includes("trace: stagingMode ? 'off'"), 'raw staging Playwright trace must remain disabled');

console.log('[ai-preview-diagnostic-contract] status-before-assertion, allowlisted code/message, safe booleans, non-JSON fail-closed, sanitizer and raw-trace prohibition verified');
