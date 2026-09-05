import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_URL = new URL("../../.github/workflows/prediction-lab-shadow-hourly.yml", import.meta.url);
const workflow = readFileSync(WORKFLOW_URL, "utf8");

const COLLAPSE_GUARD_SHA = "84bb50cf6d0b90c29f47f043de36b9a239547c9b";
const DEPLOYED_INFERENCE_PARITY_SHA = "ea1d873c93d603e61960c5bfbff1f6d6d9933fec";

test("hourly shadow clean cutover is pinned to the exact deployed-inference parity research transition", () => {
  assert.match(workflow, new RegExp(`SHADOW_CUTOVER_FROM_SHA: ${COLLAPSE_GUARD_SHA}`));
  assert.match(workflow, new RegExp(`SHADOW_CUTOVER_TO_SHA: ${DEPLOYED_INFERENCE_PARITY_SHA}`));
  assert.match(workflow, /SHADOW_CUTOVER_REASON: deployed-inference-parity/);
  assert.match(workflow, /manifest\.researchCodeSha === cutoverFromSha && currentResearchCodeSha === cutoverToSha/);
});

test("unexpected research SHA changes fail closed instead of mixing shadow chains", () => {
  assert.match(workflow, /Shadow research code changed outside approved research cutover; chain mixing forbidden\./);
  assert.match(workflow, /No predecessor artifact exists for an unapproved Hourly Shadow research SHA\./);
  assert.match(workflow, /if \(manifest\.researchCodeSha !== currentResearchCodeSha\)/);
});

test("approved research cutover resets prediction groups but preserves independent forward strategies", () => {
  assert.match(workflow, /groups: \{\},\n\s+forwardStrategies: previousValue\.forwardStrategies \?\? \{\}/);
  assert.match(workflow, /groups: \{\},\n\s+forwardStrategies: previousSummaryValue\.forwardStrategies \?\? \{\}/);
  assert.match(workflow, /seedMode: 'research-code-clean-cutover'/);
  assert.match(workflow, /seedMode: 'research-code-clean-cutover-no-predecessor'/);
});

test("cutover provenance is emitted from the restore decision and remains fail closed", () => {
  assert.ok(workflow.includes("SEED_MODE: ${{ steps.restore.outputs.seed_mode }}"));
  assert.match(workflow, /startsWith\('research-code-clean-cutover'\)/);
  assert.match(workflow, /cutoverReason: cutoverSeed \? process\.env\.SHADOW_CUTOVER_REASON : null/);
  assert.match(workflow, /cutoverFromResearchCodeSha: cutoverSeed \? process\.env\.SHADOW_CUTOVER_FROM_SHA : null/);
  assert.match(workflow, /cutoverToResearchCodeSha: cutoverSeed \? process\.env\.SHADOW_CUTOVER_TO_SHA : null/);
  assert.match(workflow, /branchWrite: false/);
  assert.match(workflow, /liveOrderAllowed: false/);
  assert.match(workflow, /privateAccountRequestAllowed: false/);
  assert.match(workflow, /permissions:\n  actions: read\n  contents: read/);
});
