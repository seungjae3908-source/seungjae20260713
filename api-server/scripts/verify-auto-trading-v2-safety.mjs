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

const [service, simulation, worker, route, routerIndex, serverIndex, panel, liveSafety] = await Promise.all([
  source('api-server/src/services/auto-trading-v2.service.ts'),
  source('api-server/src/services/auto-trading-v2-simulation.service.ts'),
  source('api-server/src/services/auto-trading-v2-worker.service.ts'),
  source('api-server/src/routes/auto-trading-v2.ts'),
  source('api-server/src/routes/index.ts'),
  source('api-server/src/index.ts'),
  source('stock-analyzer/src/components/auto-trading-v2-panel.tsx'),
  source('api-server/src/services/auto-trading-live-safety.service.ts'),
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
  for (const [name, text] of [
    ['service', service],
    ['simulation', simulation],
    ['worker', worker],
    ['route', route],
    ['liveSafety', liveSafety],
  ]) {
    assert.equal(text.includes(token), false, `V2 ${name} must not contain private Binance trading token: ${token}`);
  }
}

assert.match(simulation, /SIMULATION_ONLY_NOT_EXCHANGE_EXACT/);
assert.match(simulation, /closedCandleOnly:\s*true/);
assert.match(worker, /AUTO_TRADING_V2_WORKER_ENABLED/);
assert.match(worker, /hasSupabaseServerKey\(\)/);
assert.match(worker, /fetchAutoTradingV2PublicSnapshot/);
assert.match(worker, /acquireAutoTradingV2WorkerLease/);
assert.match(worker, /WORKER_LEASE_MS/);
assert.match(worker, /__autoTradingV2WorkerRuntime/);
assert.match(worker, /normalizeAutoTradingV2PositionPayload/);
assert.match(worker, /liquidationSimulation/);
assert.match(worker, /SIMULATION_ONLY_NOT_EXCHANGE_EXACT/);
assert.match(worker, /initialConfig\.safeHalt \|\| risk\.safeHalt/);
assert.match(worker, /realOrderCount:\s*0/);
assert.match(worker, /realCancelCount:\s*0/);
assert.match(worker, /privateTradingApiCount:\s*0/);
assert.match(worker, /wouldLiquidate/);
assert.match(worker, /wouldPnL/);
assert.match(serverIndex, /startAutoTradingV2Worker\(\)/);
assert.match(serverIndex, /AUTO_TRADING_V2_CANARY_PORTS = new Set\(\[18081, 18082, 18084\]\)/);
assert.match(serverIndex, /AUTO_TRADING_V2_CANARY_PORTS\.has\(port\)/);
assert.match(serverIndex, /canary-disabled port=\$\{port\} LIVE_TRADING=false/);

assert.match(route, /safeMode\(req\.body\?\.mode\)/);
assert.match(route, /if \(mode === 'LIVE'\) throw new Error\('AUTO_TRADING_V2_LIVE_LOCKED'\)/);
assert.match(route, /process\.env\.AUTO_TRADING_V2_FAULT_INJECTION === 'true' && process\.env\.NODE_ENV !== 'production'/);
assert.match(route, /privateTradingApiCount:\s*0/);
assert.match(routerIndex, /router\.use\('\/trade-automation\/v2\/tick'/);
assert.match(routerIndex, /AUTO_TRADING_V2_WORKER_OWNS_EXECUTION/);
assert.match(routerIndex, /router\.use\('\/trade-automation\/v2\/status'/);
assert.match(routerIndex, /autoTradingV2WorkerHealth\(\)/);
assert.match(routerIndex, /router\.use\('\/trade-automation\/v2', autoTradingV2Router\)/);
assert.match(routerIndex, /PRIVATE_EXCHANGE_API_DISABLED/);

assert.match(panel, /mode === 'LIVE'/);
assert.match(panel, /disabled=\{actionBusy \|\| mode === 'LIVE'/);
assert.match(panel, /실거래는 현재 비활성화되어 있습니다\./);
assert.match(panel, /Real Order 0 · Real Cancel 0 · Private Trading API 0/);
assert.match(panel, /SIMULATION_ONLY_NOT_EXCHANGE_EXACT/);
assert.equal(panel.includes("authorizedFetch('/api/trade-automation/v2/tick'"), false, 'browser must not mutate execution via /tick');
assert.equal(panel.includes('setInterval(() => void tick()'), false, 'browser must not own execution timer');
assert.match(panel, /setInterval\(\(\) => void load\(\), READ_ONLY_REFRESH_MS\)/);

assert.match(liveSafety, /releaseMode:\s*'PREPARATION_ONLY'/);
assert.match(liveSafety, /liveActivationIncluded:\s*false/);
assert.match(liveSafety, /liveTrading:\s*false/);
assert.match(liveSafety, /realOrderCount:\s*0/);
assert.match(liveSafety, /realCancelCount:\s*0/);
assert.match(liveSafety, /privateTradingApiCount:\s*0/);
assert.match(liveSafety, /credentialsAcceptedByRuntime:\s*false/);
assert.match(liveSafety, /signedPrivateRequestsAllowed:\s*false/);
assert.match(liveSafety, /liveActivationAllowed:\s*false/);
assert.match(liveSafety, /AUTO_TRADING_LIVE_ACTIVATION_NOT_INCLUDED/);
assert.equal(liveSafety.includes('fetch('), false, 'live-safety preparation layer must not perform network requests');
assert.equal(liveSafety.includes('process.env'), false, 'live-safety preparation layer must not accept runtime credentials or activation flags');

console.log('AUTO_TRADING_V2_SAFETY_CONTRACT=PASS');
console.log('AUTO_TRADING_V2_EXECUTION_OWNER=SERVER_WORKER_ONLY');
console.log('AUTO_TRADING_V2_WORKER_SINGLE_OWNER=LEASE_GUARDED');
console.log('AUTO_TRADING_V2_BACKGROUND_WORKER=PUBLIC_DATA_DB_ONLY');
console.log('AUTO_TRADING_V2_DEPLOYMENT_CANARIES=WORKER_DISABLED');
console.log('HISTORICAL_REPLAY=CLOSED_CANDLE_ONLY');
console.log('LIQUIDATION_MODEL=SIMULATION_ONLY_NOT_EXCHANGE_EXACT');
console.log('LIVE_SAFETY_RELEASE=PREPARATION_ONLY');
console.log('LIVE_ACTIVATION_INCLUDED=false');
console.log('LIVE_TRADING=false');
console.log('REAL_ORDER_COUNT=0');
console.log('REAL_CANCEL_COUNT=0');
console.log('PRIVATE_TRADING_API_COUNT=0');
