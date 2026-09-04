import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../../.github/workflows/public-forward-liquidity-v3-independence.yml', import.meta.url),
  'utf8',
);

const required = [
  'name: Public Forward Liquidity V3 Independence Consume',
  "workflows: ['Public Forward Liquidity V3 Canonical Ingest']",
  "startsWith(github.event.comment.body, '/run-v3-liquidity-independence ')",
  'github.event.issue.number == 838',
  'github.event.comment.user.login == github.repository_owner',
  "github.event.comment.author_association == 'OWNER'",
  "run.name === 'Public Forward Liquidity V3 Canonical Ingest'",
  "['workflow_run', 'issue_comment'].includes(run.event)",
  'Number(run.run_attempt) === 1',
  'public-forward-liquidity-v3-authoritative-ingest-slot-',
  'portable-source-inventory.json',
  'ingest-evidence-report.json',
  'V3_SCHEDULED_CUMULATIVE_REBUILD',
  'ingestReceiptRelativePaths',
  'run-public-forward-liquidity-independence-audit.mjs',
  'buildPublicForwardLiquidityV3IndependentSplitIndex',
  'v3-independent-split-index.json',
  'retrospectiveSplitSelection !== false',
  'syntheticSplitAssignment !== false',
  'additionalIndependentSampleCredit !== 0',
  'oosOutcomeCredit !== 0',
  "liquidityImpactStatus !== 'BLOCKED_DATA'",
  'fullCostReady !== false',
  "executionAuthority !== 'NONE'",
  'frozenV3SplitIndexPresent: true',
  'v2SplitReceiptPresent: false',
  'Upload immutable V3 independence evidence',
  'STATE_ROOT: /tmp/v3-authoritative-liquidity-ingest-${{ github.run_id }}-${{ github.run_attempt }}',
];
for (const token of required) {
  assert.ok(workflow.includes(token), `V3 independence workflow missing contract token: ${token}`);
}

for (const forbidden of [
  '33251065520',
  '9714378567',
  'dcbcf8ad6f0ca88f6d7314a92ceb7bb8c3159b0f7d7ed130b765237990d0b279',
  'inventory.acceptedN !== 116',
  'INDEPENDENT_N !== 3',
  'persistLiquidityCalibrationBatch',
  'contents: write',
  'actions: write',
  'secrets.',
  'PRIVATE_API',
  'LIVE_TRADING=true',
  'AUTO_TRADING=true',
  'ORDER_SUBMIT',
  'workflow_dispatch:',
  'STATE_ROOT: ${{ runner.temp }}',
]) {
  assert.ok(!workflow.includes(forbidden), `V3 independence workflow contains forbidden legacy/authority token: ${forbidden}`);
}

assert.ok(!/^\s*schedule\s*:/m.test(workflow), 'V3 independence consumer must not create its own schedule');
assert.ok(workflow.includes("github.event.workflow_run.run_attempt == 1"), 'automatic consume must reject upstream reruns');
assert.ok(workflow.includes("artifact.expired !== true"), 'upstream ingest artifact must be non-expired');
assert.ok(workflow.includes("/^sha256:[a-f0-9]{64}$/u"), 'upstream artifact digest must be exact sha256');
assert.ok(workflow.includes("inventory.inventoryDigest !== digest(inventoryBody)"), 'inventory digest must be independently recomputed');
assert.ok(workflow.includes("result.audit.counts.RAW_ACCEPTED_N !== inventory.acceptedN"), 'independence raw count must bind to V3 inventory');
assert.ok(workflow.includes("result.audit.counts.INDEPENDENT_N !== index.effectiveIndependentN"), 'independent count must bind to V3 split index');

test('V3 independence workflow contract is hardcode-free, frozen-split-bound and fail-closed', () => {
  assert.equal(true, true);
});
