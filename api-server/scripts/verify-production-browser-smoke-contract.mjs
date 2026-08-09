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
const deployScript = await read('ops/deploy-production.sh');
const server = await read('api-server/src/index.ts');

assert(/workflow_dispatch:/.test(workflow), 'workflow must be explicit-dispatch capable');
assert(/pull_request:/.test(workflow), 'workflow must statically validate the PR without Production browsing');
assert(workflow.includes("if: github.event_name == 'workflow_dispatch'"), 'live browser job must be dispatch-only');
assert(workflow.includes("if: github.event_name == 'pull_request'"), 'PR job must be static-only');
assert(workflow.includes('BLOCKED_BY_PRODUCTION_QA_CREDENTIAL'), 'missing QA credentials must fail explicitly');
assert(workflow.includes('PRODUCTION_READONLY_E2E: "true"'), 'live browser must require read-only mode');
assert(workflow.includes('playwright.production.config.ts'), 'workflow must use isolated Production config');
assert(!workflow.includes('ssh '), 'Production browser workflow must not use SSH');
assert(!workflow.includes('pm2 '), 'Production browser workflow must not mutate PM2');
assert(!workflow.includes('supabase db'), 'Production browser workflow must not mutate Supabase');
assert(!workflow.includes('deploy-production.sh'), 'Production browser workflow must not deploy');

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
assert(spec.includes('installProductionReadOnlyPolicy'), 'browser smoke must install fail-closed request policy');

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
