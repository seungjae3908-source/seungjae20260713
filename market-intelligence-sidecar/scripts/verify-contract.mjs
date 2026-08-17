import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const required = [
  'src/engine.mjs',
  'src/advanced-gates.mjs',
  'src/public-data.mjs',
  'src/server.mjs',
  'tests/engine.test.mjs',
  'tests/advanced-gates.test.mjs',
  'tests/server.test.mjs',
  'SAFETY.md',
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`MISSING_REQUIRED_FILE:${relative}`);
}
const server = fs.readFileSync(path.join(root, 'src/server.mjs'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'src/engine.mjs'), 'utf8');
const advancedGates = fs.readFileSync(path.join(root, 'src/advanced-gates.mjs'), 'utf8');
const publicData = fs.readFileSync(path.join(root, 'src/public-data.mjs'), 'utf8');
for (const text of [server, engine, advancedGates]) {
  if (!text.includes("executionAuthority: 'NONE'")) throw new Error('EXECUTION_AUTHORITY_NOT_PINNED');
  if (!text.includes('realOrderAllowed: false')) throw new Error('REAL_ORDER_NOT_PINNED_FALSE');
}
if (!advancedGates.includes('candidateDeletionAllowed: false')) throw new Error('ADVANCED_GATE_SCANNER_PRESERVATION_NOT_PINNED');
if (!advancedGates.includes('orderAllowed: false')) throw new Error('ADVANCED_GATE_ORDER_AUTHORITY_NOT_PINNED_FALSE');
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
  advancedGateContract: 'market-intelligence-advanced-gates/v1',
  executionAuthority: 'NONE',
  privateTradingApiAllowed: false,
  realOrderAllowed: false,
  scannerCandidateDeletionAllowed: false,
  loopbackOnly: true,
}));
