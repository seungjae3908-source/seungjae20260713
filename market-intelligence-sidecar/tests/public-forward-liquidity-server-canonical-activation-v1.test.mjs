import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../../.github/workflows/public-forward-liquidity-server-canonical-activation-v1.yml', import.meta.url), 'utf8');
const service = await readFile(new URL('../deploy/public-forward-liquidity-server-canonical-runtime-v1.service', import.meta.url), 'utf8');
const timer = await readFile(new URL('../deploy/public-forward-liquidity-server-canonical-runtime-v1.timer', import.meta.url), 'utf8');
const runner = await readFile(new URL('../scripts/run-public-forward-liquidity-server-canonical-runtime-v1.mjs', import.meta.url), 'utf8');

test('canonical activation is owner/protected and future-only', () => {
  assert.match(workflow, /\/authorize-public-forward-liquidity-server-canonical-cutover-v1 /u);
  assert.match(workflow, /\/activate-public-forward-liquidity-server-canonical-v1 /u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /SERVER_CANONICAL_AUTHORITY_OWNER_REQUIRED/u);
  assert.match(workflow, /SERVER_CANONICAL_AUTHORITY_COMMENT_STALE/u);
  assert.match(workflow, /SERVER_CANONICAL_REQUIRED_CI_REJECTED/u);
  assert.doesNotMatch(workflow, /LIVE_TRADING=true|AUTO_TRADING=true|REAL_ORDER_ENABLED=true|PRIVATE_TRADING_API_ALLOWED=true/u);
});

test('canonical timer is natural-only and non-persistent', () => {
  assert.match(timer, /OnCalendar=\*-\*-\* \*:17:00 UTC/u);
  assert.match(timer, /OnCalendar=\*-\*-\* \*:27:00 UTC/u);
  assert.match(timer, /OnCalendar=\*-\*-\* \*:37:00 UTC/u);
  assert.match(timer, /Persistent=false/u);
  assert.match(timer, /RandomizedDelaySec=0/u);
  assert.match(timer, /AccuracySec=1s/u);
});

test('runtime stays isolated and zero execution authority', () => {
  assert.match(service, /SERVER_EVIDENCE_SERVER_CANONICAL=true/u);
  assert.match(service, /\/opt\/stock-app-server-evidence-shadow-v1/u);
  assert.doesNotMatch(service, /\/opt\/stock-app(?:\/|$)/u);
  assert.match(runner, /canonicalTrainReceiptN: 4/u);
  assert.match(runner, /independentN: 4/u);
  assert.match(runner, /validationN: 0/u);
  assert.match(runner, /oosN: 0/u);
  assert.match(runner, /executionAuthority: 'NONE'/u);
  assert.match(runner, /SERVER_CANONICAL_READINESS_BLOCKED/u);
});
