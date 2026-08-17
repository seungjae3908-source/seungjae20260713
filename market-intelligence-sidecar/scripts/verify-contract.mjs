import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname, '..');
const required = [
  'src/engine.mjs',
  'src/public-data.mjs',
  'src/server.mjs',
  'tests/engine.test.mjs',
  'tests/server.test.mjs',
  'SAFETY.md',
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`MISSING_REQUIRED_FILE:${relative}`);
}
const server = fs.readFileSync(path.join(root, 'src/server.mjs'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'src/engine.mjs'), 'utf8');
const publicData = fs.readFileSync(path.join(root, 'src/public-data.mjs'), 'utf8');
for (const text of [server, engine]) {
  if (!text.includes("executionAuthority: 'NONE'")) throw new Error('EXECUTION_AUTHORITY_NOT_PINNED');
  if (!text.includes('realOrderAllowed: false')) throw new Error('REAL_ORDER_NOT_PINNED_FALSE');
}
if (!server.includes("'127.0.0.1'")) throw new Error('LOOPBACK_BIND_NOT_PRESENT');
if (/api\/v3\/(trade\/place|trade\/cancel|account\/|withdraw|transfer)/u.test(publicData)) {
  throw new Error('PRIVATE_OR_MUTATING_BITGET_PATH_DETECTED');
}
if (/\/v1\/orders|\/v1\/withdraws|Authorization|ACCESS-KEY/u.test(publicData)) {
  throw new Error('PRIVATE_OR_MUTATING_PROVIDER_CONTRACT_DETECTED');
}
console.log(JSON.stringify({
  ok: true,
  contract: 'market-intelligence-sidecar/v1',
  executionAuthority: 'NONE',
  privateTradingApiAllowed: false,
  realOrderAllowed: false,
  loopbackOnly: true,
}));
