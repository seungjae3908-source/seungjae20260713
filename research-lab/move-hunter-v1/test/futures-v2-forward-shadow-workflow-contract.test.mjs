import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../../../.github/workflows/move-hunter-futures-v2-forward-shadow.yml', import.meta.url);

test('Futures V2 shadow workflow remains manual read-only post-freeze and canonical-source-only', async () => {
  const text = await readFile(workflowPath, 'utf8');
  assert.match(text, /workflow_dispatch:/u);
  assert.doesNotMatch(text, /\bschedule:/u);
  assert.doesNotMatch(text, /\bpush:/u);
  assert.doesNotMatch(text, /\bpull_request:/u);

  assert.match(text, /permissions:\s*\n\s+actions:\s+read\s*\n\s+contents:\s+read/u);
  assert.doesNotMatch(text, /permissions:[\s\S]*\bwrite\b/u);
  assert.doesNotMatch(text, /secrets\./u);

  assert.match(text, /forward-recommendation-observer-cycle\.yml/u);
  assert.match(text, /run\.event !== 'workflow_dispatch'/u);
  assert.match(text, /run\.head_branch !== 'main'/u);
  assert.match(text, /run\.conclusion !== 'success'/u);
  assert.match(text, /2026-09-28T07:37:20Z/u);
  assert.match(text, /forward-recommendation-observer-state-/u);

  assert.match(text, /cost_model_id:/u);
  assert.match(text, /fee_bps:/u);
  assert.match(text, /slippage_bps:/u);
  assert.match(text, /spread_bps:/u);
  assert.match(text, /run-futures-v2-forward-shadow\.mjs/u);

  assert.match(text, /git diff --exit-code/u);
  assert.match(text, /git status --porcelain=v1/u);
  assert.match(text, /performance winner: NONE/u);
  assert.match(text, /canonical state mutation: false/u);
  assert.match(text, /economic\/OOS credit: 0/u);
  assert.match(text, /execution authority: NONE/u);

  assert.doesNotMatch(text, /\bLIVE_TRADING\s*=\s*true\b/iu);
  assert.doesNotMatch(text, /\bAUTO_TRADING\s*=\s*true\b/iu);
  assert.doesNotMatch(text, /\bREAL_ORDER\w*\s*=\s*true\b/iu);
  assert.doesNotMatch(text, /\bPRIVATE_TRADING_API\w*\s*=\s*true\b/iu);
});
