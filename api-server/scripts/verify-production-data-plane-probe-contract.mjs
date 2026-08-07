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

assert(deploy.includes('DATA_PROBE_PATH="${DATA_PROBE_PATH:-/api/healthz/data-plane}"'), 'production must use the dedicated data-plane path');
assert(!deploy.includes('/api/quotes?tickers=005930'), 'production must not anonymously probe the protected quote route');
for (const marker of [
  'value?.ok === true',
  'value?.dataPlane === "market-quotes"',
  'Number(value?.available) >= 1',
  'value?.priceValidated === true',
  'Date.parse(value?.providerUpdatedAt)',
]) {
  assert(deploy.includes(marker), `production probe semantic validation is missing ${marker}`);
}
assert(deploy.includes('probe_data "http://127.0.0.1:$CANARY_PORT"'), 'canary must execute the data-plane probe');
assert(deploy.includes('probe_data "http://127.0.0.1:$LIVE_PORT"'), 'live runtime must execute the same data-plane probe');
assert(deploy.includes('restore_backup'), 'automatic rollback must remain intact');

console.log('Production data-plane readiness contract verified.');
console.log('- Protected market routes remain authenticated');
console.log('- Direct loopback readiness exercises the real quote service without exposing price data');
console.log('- Canary and live deploy probes require valid data-plane semantics');
console.log('- Legacy anonymous /api/quotes probe is absent and rollback remains intact');
