import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const WORKFLOW_URL = new URL("../../.github/workflows/prediction-lab-model-reference-drift-diagnostics-v1.yml", import.meta.url);

test("durable drift workflow auto-follows only successful manual main publication", async () => {
  const workflow = await readFile(WORKFLOW_URL, "utf8");
  assert.match(workflow, /workflow_run:/u);
  assert.match(workflow, /Prediction Lab Multi-Market Suite/u);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/u);
  assert.match(workflow, /workflow_run\.event == 'workflow_dispatch'/u);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/u);
  assert.match(workflow, /source\?\.event !== 'workflow_dispatch'/u);
  assert.match(workflow, /source\?\.head_branch !== 'main'/u);
  assert.match(workflow, /prediction-lab-model-reference-v1-\$\{sourceRunId\}/u);
  assert.match(workflow, /durable publication is not bound to exact latest main/u);
  assert.match(workflow, /expected immutable publication is missing/u);
  assert.match(workflow, /release\.immutable !== true/u);
  assert.match(workflow, /gh release verify "\$RELEASE_TAG"/u);
  assert.match(workflow, /gh release verify-asset/u);
});

test("durable drift workflow keeps readback diagnostic-only and fail-closed", async () => {
  const workflow = await readFile(WORKFLOW_URL, "utf8");
  assert.match(workflow, /DURABLE_REFERENCE_PROVEN=false/u);
  assert.match(workflow, /Authenticate immutable reference and calculate PSI KS JSD/u);
  assert.match(workflow, /model-reference-drift-diagnostics-v1\.js/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
  assert.doesNotMatch(workflow, /createRelease|uploadReleaseAsset|updateRelease/u);
  assert.doesNotMatch(workflow, /LIVE_TRADING:\s*true/u);
  assert.doesNotMatch(workflow, /executionAuthority:\s*["']?(?:LIVE|PRIVATE)/u);
});
