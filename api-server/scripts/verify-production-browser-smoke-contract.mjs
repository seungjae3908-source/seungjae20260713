import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd(), path.basename(process.cwd()) === 'api-server' ? '..' : '.');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[production-browser-contract] ${message}`);
};

const workflow = await read('.github/workflows/production-browser-smoke.yml');
const spec = await read('stock-analyzer/e2e/production-readonly-smoke.spec.ts');
const policy = await read('stock-analyzer/e2e/support/production-readonly-policy.ts');
const policyTest = await read('stock-analyzer/e2e/support/production-readonly-policy.test.ts');
const config = await read('stock-analyzer/playwright.production.config.ts');
const app = await read('stock-analyzer/src/App.tsx');
const entrypoint = await read('stock-analyzer/src/main.tsx');
const stylesheet = await read('stock-analyzer/src/index.css');
const indexHtml = await read('stock-analyzer/index.html');
const deployScript = await read('ops/deploy-production.sh');
const server = await read('api-server/src/index.ts');

assert(/workflow_dispatch:/.test(workflow), 'workflow must be explicit-dispatch capable');
assert(/pull_request:/.test(workflow), 'workflow must statically validate the PR without Production browsing');
assert(workflow.includes("if: github.event_name == 'workflow_dispatch'"), 'live browser job must be dispatch-only');
assert(workflow.includes("if: github.event_name == 'pull_request'"), 'PR job must be static-only');
assert(workflow.includes('BLOCKED_BY_PRODUCTION_QA_CREDENTIAL'), 'missing QA credentials must fail explicitly');
assert(workflow.includes('PRODUCTION_READONLY_E2E: "true"'), 'live browser must require read-only mode');
assert(workflow.includes('playwright.production.config.ts'), 'workflow must use isolated Production config');
assert(workflow.includes('ref: ${{ inputs.sha }}'), 'live smoke must start from the exact deployed source SHA');
assert(workflow.includes('git fetch --no-tags --depth=1 origin main'), 'smoke harness must resolve current main fail-closed');
for (const harnessFile of [
  'stock-analyzer/e2e/production-readonly-smoke.spec.ts',
  'stock-analyzer/e2e/support/production-readonly-policy.ts',
]) {
  assert(workflow.includes(`'${harnessFile}'`), `current-main smoke harness whitelist missing ${harnessFile}`);
}
assert(workflow.includes('git show "$HARNESS_SHA:$file" > "$file"'), 'only whitelisted harness files may overlay deployed source');
assert(workflow.includes('"$HARNESS_SHA" == "${GITHUB_SHA,,}"'), 'stale harness dispatch must fail closed');
assert(!workflow.includes('ssh '), 'Production browser workflow must not use SSH');
assert(!workflow.includes('pm2 '), 'Production browser workflow must not mutate PM2');
assert(!workflow.includes('supabase db'), 'Production browser workflow must not mutate Supabase');
assert(
  !workflow.replace(/^\s*-\s+ops\/deploy-production\.sh\s*$/m, '').includes('deploy-production.sh'),
  'Production browser workflow must not deploy',
);

for (const route of ['/', '/stocks', '/stock-info', '/stock/005930', '/ai-chart', '/scanner', '/recommendations', '/paper-trading', '/account']) {
  assert(spec.includes(route), `major Production route missing: ${route}`);
}
for (const marker of [
  'consoleErrors', 'pageErrors', 'unhandledRejections', 'unexpectedHttpErrors', 'failedRequests',
  'loadingDurationsMs', "privateAccountLiveQa: 'NOT_RUN'", 'actualOrders: 0', 'actualCancels: 0',
  'privateAccountRequests: 0', 'privateTradingRequests: 0', 'transfers: 0', 'withdrawals: 0',
]) {
  assert(spec.includes(marker), `browser evidence marker missing: ${marker}`);
}
assert(spec.includes("getByTestId('page-fallback')"), 'browser smoke must prove global loading terminates');
assert(spec.includes("getByTestId('open-journal-sync')"), 'browser smoke must prove the real paper workspace becomes ready');
assert(spec.includes("getByTestId('paper-trading-route-skeleton')"), 'browser smoke must prove the paper skeleton terminates');
assert(spec.includes('installProductionReadOnlyPolicy'), 'browser smoke must install fail-closed request policy');
assert(spec.includes('isIgnorableProductionRequestFailure'), 'browser smoke must use the narrowly tested request-failure classifier');
assert(policy.includes('isIgnorableProductionRequestFailure'), 'read-only policy must classify benign same-origin read aborts');
assert(policy.includes("errorText.trim() === 'net::ERR_ABORTED'"), 'only exact net::ERR_ABORTED failures may be ignored');
assert(policyTest.includes('same-origin read requests cancelled by navigation are the only ignored browser failures'), 'abort classifier must have explicit boundary tests');
assert(app.includes('loadPaperTradingPage'), 'approved sessions must preload the paper trading route');
assert(app.includes('PaperTradingRouteFallback'), 'paper trading must use a route-specific progressive fallback');
assert(app.includes('paper-trading-route-skeleton'), 'paper trading fallback must have a deterministic readiness marker');
assert(entrypoint.includes('if (!import.meta.env.PROD) return;'), 'service worker registration must stay production-only');
for (const source of [stylesheet, indexHtml]) {
  assert(!/fonts\.(?:googleapis|gstatic)\.com/i.test(source), 'Production source must not depend on remote Google fonts');
}

for (const marker of [
  'FINANCIAL_MUTATION_REQUEST_BLOCKED',
  'PRODUCTION_APP_MUTATION_BLOCKED',
  'PRODUCTION_DATABASE_MUTATION_BLOCKED',
  'PRODUCTION_STORAGE_MUTATION_BLOCKED',
  'PRIVATE_PROVIDER_NETWORK_BLOCKED',
  'PRIVATE_ACCOUNT_LIVE_QA_NOT_RUN',
  '/api/account-connections/snapshot',
]) {
  assert(policy.includes(marker), `read-only policy missing ${marker}`);
  assert(policyTest.includes(marker) || marker === '/api/account-connections/snapshot', `policy test missing ${marker}`);
}
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  assert(policyTest.includes(`'${method}'`), `policy test must cover ${method}`);
}
assert(config.includes("serviceWorkers: 'block'"), 'Production browser config must neutralize stale service worker state');
assert(config.includes("trace: 'off'"), 'Production browser must not create raw Playwright traces');
assert(config.includes("video: 'off'"), 'Production browser must not record credential-bearing video');
assert(config.includes("retries: 0"), 'Production browser must not hide failures behind retries');

assert(deployScript.includes('DEPLOY_SHA="$TARGET_SHA" pm2 restart "$PM2_NAME" --update-env'), 'Production deploy must inject immutable process SHA with --update-env');
assert(deployScript.includes('DEPLOY_SHA="$TARGET_SHA"'), 'canary/live process must receive immutable target SHA');
for (const marker of ['processDeploySha', 'deployMarkerSha', 'identityMatch', 'identityStatus']) {
  assert(server.includes(marker), `health identity contract missing ${marker}`);
}

console.log('[production-browser-contract] static contract passed');
