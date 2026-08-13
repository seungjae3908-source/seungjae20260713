import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..');
const repositoryRoot = path.resolve(apiRoot, '..');

async function source(relative) {
  return readFile(path.join(repositoryRoot, relative), 'utf8');
}

const [service, route, routerIndex, panel] = await Promise.all([
  source('api-server/src/services/auto-trading-v2.service.ts'),
  source('api-server/src/routes/auto-trading-v2.ts'),
  source('api-server/src/routes/index.ts'),
  source('stock-analyzer/src/components/auto-trading-v2-panel.tsx'),
]);

assert.match(service, /liveTrading:\s*false/);
assert.match(service, /privateTradingApiAllowed:\s*false/);
assert.match(service, /realOrderCount:\s*0/);
assert.match(service, /realCancelCount:\s*0/);
assert.match(service, /privateTradingApiCount:\s*0/);
assert.match(service, /AUTO_TRADING_V2_LIVE_LOCKED/);
assert.match(service, /https:\/\/fapi\.binance\.com/);
assert.match(service, /\/fapi\/v1\/klines/);
assert.match(service, /\/fapi\/v1\/ticker\/bookTicker/);
assert.match(service, /\/fapi\/v1\/premiumIndex/);

const forbiddenPrivateTradingTokens = [
  '/fapi/v1/order',
  '/fapi/v1/allOpenOrders',
  '/fapi/v1/countdownCancelAll',
  '/fapi/v2/account',
  '/fapi/v2/positionRisk',
  'X-MBX-APIKEY',
  'signature=',
  'secretKey',
];
for (const token of forbiddenPrivateTradingTokens) {
  assert.equal(service.includes(token), false, `V2 service must not contain private Binance trading token: ${token}`);
  assert.equal(route.includes(token), false, `V2 route must not contain private Binance trading token: ${token}`);
}

assert.match(route, /safeMode\(req\.body\?\.mode\)/);
assert.match(route, /if \(mode === 'LIVE'\) throw new Error\('AUTO_TRADING_V2_LIVE_LOCKED'\)/);
assert.match(route, /process\.env\.AUTO_TRADING_V2_FAULT_INJECTION === 'true' && process\.env\.NODE_ENV !== 'production'/);
assert.match(route, /privateTradingApiCount:\s*0/);
assert.match(routerIndex, /router\.use\('\/trade-automation\/v2', autoTradingV2Router\)/);
assert.match(routerIndex, /PRIVATE_EXCHANGE_API_DISABLED/);

assert.match(panel, /mode === 'LIVE'/);
assert.match(panel, /disabled=\{actionBusy \|\| mode === 'LIVE'/);
assert.match(panel, /실거래는 현재 비활성화되어 있습니다\./);
assert.match(panel, /Real Order 0 · Real Cancel 0 · Private Trading API 0/);

console.log('AUTO_TRADING_V2_SAFETY_CONTRACT=PASS');
console.log('LIVE_TRADING=false');
console.log('REAL_ORDER_COUNT=0');
console.log('REAL_CANCEL_COUNT=0');
console.log('PRIVATE_TRADING_API_COUNT=0');
