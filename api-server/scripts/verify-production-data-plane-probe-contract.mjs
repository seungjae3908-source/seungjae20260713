import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[production-data-plane-probe] ${message}`);
};

const health = await read('api-server/src/routes/health.ts');
const routes = await read('api-server/src/routes/index.ts');
const deploy = await read('ops/deploy-production.sh');
const productionWorkflow = await read('.github/workflows/production-deploy.yml');
const approvalWorkflow = await read('.github/workflows/production-one-time-approval.yml');

const healthMount = routes.indexOf("router.use('/', healthRouter);");
const authBoundary = routes.indexOf('router.use(requireAuthenticated);');
const marketMount = routes.indexOf("router.use('/', marketRouter);");

assert(healthMount >= 0, 'health router must be mounted');
assert(authBoundary > healthMount, 'health router must remain before authentication');
assert(marketMount > authBoundary, 'market routes must remain behind authentication');

assert(health.includes('router.get("/healthz/data-plane"'), 'dedicated data-plane readiness route is missing');
assert(health.includes('isDirectLoopbackProbe(req)'), 'data-plane readiness must require a direct loopback request');
assert(health.includes('req.socket.remoteAddress'), 'loopback validation must use the direct socket address');
assert(health.includes('req.headers.host'), 'loopback validation must also bind the Host header');
assert(health.includes('MarketDataService.getQuotes(["005930"])'), 'readiness must exercise the real quote service');
assert(health.includes('Number.isFinite(row.price)') && health.includes('row.price > 0'), 'readiness must validate a real positive price');
assert(health.includes('Number.isFinite(Date.parse(row.updatedAt))'), 'readiness must validate provider freshness metadata');
assert(health.includes('dataPlane: "market-quotes"'), 'readiness response must identify the checked data plane');
assert(health.includes('priceValidated: true'), 'readiness response must expose price validation without returning the price');
assert(!health.includes('price: quote.price'), 'readiness response must not expose the quote price');
assert(health.includes('res.status(404).json({ ok: false, error: "NOT_FOUND" })'), 'non-loopback requests must not trigger the provider probe');

assert(deploy.includes('DATA_PROBE_PATH="${DATA_PROBE_PATH:-/api/healthz/data-plane}"'), 'production script must use the dedicated data-plane path');
assert(!deploy.includes('/api/quotes?tickers=005930'), 'production script must not anonymously probe the protected quote route');
assert(productionWorkflow.includes('default: /api/healthz/data-plane'), 'Production Deploy workflow must default to the dedicated data-plane path');
assert(!productionWorkflow.includes('/api/quotes?tickers=005930'), 'Production Deploy workflow must not default to the protected quote API');
assert(approvalWorkflow.includes("data_probe_path: '/api/healthz/data-plane'"), 'one-time approval must explicitly dispatch the dedicated data-plane probe');
assert(!approvalWorkflow.includes('/api/quotes?tickers=005930'), 'one-time approval must never dispatch the protected quote API as a health probe');

for (const marker of [
  'value?.ok === true',
  'value?.dataPlane === "market-quotes"',
  'Number(value?.available) >= 1',
  'value?.priceValidated === true',
  'Date.parse(value?.providerUpdatedAt)',
]) {
  assert(deploy.includes(marker), `production probe semantic validation is missing ${marker}`);
}
assert(deploy.includes('curl --fail --silent --show-error --max-time 25'), 'non-2xx responses and timeouts must fail the transport probe');
assert(deploy.includes('probe_data "http://127.0.0.1:$CANARY_PORT"'), 'canary must execute the data-plane probe');
assert(deploy.includes('probe_data "http://127.0.0.1:$LIVE_PORT"'), 'live runtime must execute the same data-plane probe');
assert(deploy.includes('restore_backup'), 'automatic rollback must remain intact');

function acceptsFixture({ status = 200, body = '', timedOut = false }) {
  if (timedOut || status < 200 || status >= 300) return false;
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }
  return value?.ok === true
    && value?.dataPlane === 'market-quotes'
    && Number(value?.available) >= 1
    && value?.priceValidated === true
    && Number.isFinite(Date.parse(value?.providerUpdatedAt));
}

const validBody = JSON.stringify({
  ok: true,
  dataPlane: 'market-quotes',
  available: 1,
  priceValidated: true,
  providerUpdatedAt: '2026-08-08T00:00:00Z',
});
assert(acceptsFixture({ status: 200, body: validBody }), 'valid HTTP 200 data-plane fixture must pass');
for (const status of [401, 403, 404, 500]) {
  assert(!acceptsFixture({ status, body: validBody }), `HTTP ${status} fixture must fail`);
}
assert(!acceptsFixture({ status: 200, body: '{malformed' }), 'malformed JSON must fail');
assert(!acceptsFixture({ status: 200, body: JSON.stringify({ ...JSON.parse(validBody), ok: false }) }), 'ok=false must fail');
assert(!acceptsFixture({ status: 200, body: JSON.stringify({ ...JSON.parse(validBody), dataPlane: 'wrong-plane' }) }), 'wrong dataPlane must fail');
assert(!acceptsFixture({ status: 200, body: validBody, timedOut: true }), 'timeout must fail');

console.log('Production data-plane readiness contract verified.');
console.log('- Protected market routes remain authenticated');
console.log('- Direct loopback readiness exercises the real quote service without exposing price data');
console.log('- Workflow, canary, and live deploy use /api/healthz/data-plane only');
console.log('- 401/403/404/500, malformed JSON, semantic mismatch, and timeout are rejected');
console.log('- Legacy anonymous /api/quotes probe is absent and rollback remains intact');
