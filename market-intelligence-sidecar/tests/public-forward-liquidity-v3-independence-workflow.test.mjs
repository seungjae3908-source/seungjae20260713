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
  'PHASE2_INDEPENDENCE_EVIDENCE_INVALID',
  'PHASE2_POLICY_OR_CUTOVER_BINDING_INVALID',
  'crossLanePairAssessments: result.audit.crossLanePairAssessments',
  'dependencyComponents: result.audit.dependencyComponents',
  'preCutoverIndexFreeze: index.preCutoverIndexFreeze',
  'genuineScheduledLaneReceiptN: inventory.genuineScheduledLaneReceiptN',
  'laneSplitSideCounts: index.laneSplitSideCounts',
  'scopeCells: index.scopeCells',
  'maxCreditPerLanePerSlot: index.maxCreditPerLanePerSlot',
  'maxTotalCreditPerSlot: index.maxTotalCreditPerSlot',
  'maxCreditPerDependencyComponent: index.maxCreditPerDependencyComponent',
  'utc27AdditionalIndependentCredit: index.utc27AdditionalIndependentCredit',
  'retroactiveMultiLaneCreditAllowed: false',
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
assert.ok(workflow.includes("result.audit.counts.INDEPENDENT_N !== index.preCapIndependentN"), 'pre-cap independence count must bind to the canonical audit');
assert.ok(workflow.includes('effectiveIndependentN: index.effectiveIndependentN'), 'effective count must reflect hard lane and global caps');

const upstreamBindingStart = workflow.indexOf("await writeFile(join(root, 'v3-upstream-binding.json')");
const upstreamBindingEnd = workflow.indexOf('      - name: Execute receipt-bound effective-independence audit');
assert.ok(upstreamBindingStart >= 0 && upstreamBindingEnd > upstreamBindingStart, 'upstream binding section must be present');
const upstreamBindingSection = workflow.slice(upstreamBindingStart, upstreamBindingEnd);
assert.ok(
  upstreamBindingSection.includes('genuineScheduledLaneReceiptN: inventory.genuineScheduledLaneReceiptN'),
  'upstream binding must source genuine scheduled lane receipt count from validated inventory',
);
assert.ok(
  !upstreamBindingSection.includes('genuineScheduledLaneReceiptN: index.genuineScheduledLaneReceiptN'),
  'upstream binding must not reference the downstream split index before it exists',
);

const truthBoundaryStart = workflow.indexOf('      - name: Assert V3 independence truth boundary and write immutable summary');
const truthBoundaryEnd = workflow.indexOf('      - name: Upload immutable V3 independence evidence');
assert.ok(truthBoundaryStart >= 0 && truthBoundaryEnd > truthBoundaryStart, 'truth-boundary section must be present');
const truthBoundarySection = workflow.slice(truthBoundaryStart, truthBoundaryEnd);
assert.ok(
  truthBoundarySection.includes("import { PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1 as phase2Policy } from './market-intelligence-sidecar/src/public-forward-liquidity-multi-lane-policy-v1.mjs';"),
  'truth-boundary step must import Phase 2 policy before validating its digests',
);

test('V3 independence workflow contract is hardcode-free, frozen-split-bound and fail-closed', () => {
  assert.equal(true, true);
});
