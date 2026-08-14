import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WORKFLOW_URL = new URL("../../.github/workflows/prediction-lab-shadow-hourly.yml", import.meta.url);
const workflow = readFileSync(WORKFLOW_URL, "utf8");

const LEGACY_SHA = "be77e3d2f5e63609806697836a8c1b6cd893a547";
const PARITY_SHA = "87cfafc3d502901d8f678e0153e2e974a4b69004";

test("hourly shadow clean cutover is pinned to the exact OI parity transition", () => {
  assert.match(workflow, new RegExp(`SHADOW_CUTOVER_FROM_SHA: ${LEGACY_SHA}`));
  assert.match(workflow, new RegExp(`SHADOW_CUTOVER_TO_SHA: ${PARITY_SHA}`));
  assert.match(workflow, /SHADOW_CUTOVER_REASON: oi-training-parity/);
  assert.match(workflow, /manifest\.researchCodeSha === cutoverFromSha && currentResearchCodeSha === cutoverToSha/);
});

test("unexpected research SHA changes fail closed instead of mixing shadow chains", () => {
  assert.match(workflow, /Shadow research code changed outside approved OI parity cutover; chain mixing forbidden\./);
  assert.match(workflow, /No predecessor artifact exists for an unapproved Hourly Shadow research SHA\./);
  assert.match(workflow, /if \(manifest\.researchCodeSha !== currentResearchCodeSha\)/);
});

test("OI parity cutover resets legacy prediction groups but preserves independent forward strategies", () => {
  assert.match(workflow, /groups: \{\},\n\s+forwardStrategies: previousValue\.forwardStrategies \?\? \{\}/);
  assert.match(workflow, /groups: \{\},\n\s+forwardStrategies: previousSummaryValue\.forwardStrategies \?\? \{\}/);
  assert.match(workflow, /seedMode: 'oi-parity-clean-cutover'/);
  assert.match(workflow, /seedMode: 'oi-parity-clean-cutover-no-predecessor'/);
});

test("cutover provenance is emitted from the restore decision and remains fail closed", () => {
  assert.ok(workflow.includes("SEED_MODE: ${{ steps.restore.outputs.seed_mode }}"));
  assert.match(workflow, /cutoverReason: cutoverSeed \? process\.env\.SHADOW_CUTOVER_REASON : null/);
  assert.match(workflow, /cutoverFromResearchCodeSha: cutoverSeed \? process\.env\.SHADOW_CUTOVER_FROM_SHA : null/);
  assert.match(workflow, /cutoverToResearchCodeSha: cutoverSeed \? process\.env\.SHADOW_CUTOVER_TO_SHA : null/);
  assert.match(workflow, /branchWrite: false/);
  assert.match(workflow, /liveOrderAllowed: false/);
  assert.match(workflow, /privateAccountRequestAllowed: false/);
  assert.match(workflow, /permissions:\n  actions: read\n  contents: read/);
});
