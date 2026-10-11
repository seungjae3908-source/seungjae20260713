import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const activation = new URL('../../.github/workflows/signal-intelligence-v3-activation.yml', import.meta.url);
const representative = new URL('../../.github/workflows/signal-intelligence-v3-representative-validation.yml', import.meta.url);

test('activation looks up each exact validation workflow without repository-wide run noise', async () => {
  const source = await readFile(activation, 'utf8');
  assert.match(source, /workflow_id: 'signal-intelligence-v3-validation\.yml'/u);
  assert.match(source, /workflow_id: 'signal-intelligence-v3-representative-validation\.yml'/u);
  assert.match(source, /run\.head_sha\.toLowerCase\(\) === targetSha/u);
  assert.doesNotMatch(source, /listWorkflowRunsForRepo/u);
});

test('representative validation remains dispatchable and preserves public-only zero-authority gates', async () => {
  const source = await readFile(representative, 'utf8');
  for (const expected of [
    'workflow_dispatch:',
    'Run 23 assets x 3 strategy profiles',
    "LIVE_TRADING: 'false'",
    "PRIVATE_API_ENABLED: 'false'",
    "ORDER_AUTHORITY: 'false'",
    'SIGNAL_INTELLIGENCE_EXECUTION_AUTHORITY: NONE',
    "p.executionAuthority !== 'NONE'",
    'p.publicDataOnly !== true',
    'p.representativeCount !== 23',
    'p.rowCount !== 69',
    'actualOrders !== 0',
  ]) assert.ok(source.includes(expected), expected);
});
