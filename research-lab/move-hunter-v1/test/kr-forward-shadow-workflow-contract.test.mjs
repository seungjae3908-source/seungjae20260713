import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../../../.github/workflows/move-hunter-kr-forward-shadow.yml', import.meta.url);

test('KR frozen Forward shadow workflow remains manual, read-only, and canonical-source-only', async () => {
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
  assert.match(text, /forward-recommendation-observer-state-/u);

  assert.match(text, /git diff --exit-code/u);
  assert.match(text, /git status --porcelain=v1/u);
  assert.match(text, /canonical state mutation: false/u);
  assert.match(text, /economic\/OOS credit: 0/u);
  assert.match(text, /execution authority: NONE/u);

  assert.doesNotMatch(text, /\bLIVE_TRADING\s*=\s*true\b/iu);
  assert.doesNotMatch(text, /\bAUTO_TRADING\s*=\s*true\b/iu);
  assert.doesNotMatch(text, /\bREAL_ORDER\w*\s*=\s*true\b/iu);
  assert.doesNotMatch(text, /\bPRIVATE_TRADING_API\w*\s*=\s*true\b/iu);
});

test('frozen hypothesis module no longer depends on mutable one-year decision function', async () => {
  const source = await readFile(
    new URL('../src/market-hypothesis-forward.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"]\.\/one-year-benchmark\.mjs['"]/u);
  assert.match(source, /KR_NO_STRUCTURE_60M_DECISION_V1/u);
  assert.match(source, /requiredPassCount:\s*6/u);
  assert.match(source, /hardRequirements:\s*Object\.freeze\(\['ema', 'roc'\]\)/u);
  assert.match(source, /evaluateFrozenKrNoStructureDecisionV1/u);
});
