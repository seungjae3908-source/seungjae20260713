import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const path = ".github/workflows/market-prediction-lab-main-required-ci-bridge.yml";
const workflow = await readFile(path, "utf8");

test("bridge is main-push-only and scoped to Prediction Lab plus itself", () => {
  assert.match(workflow, /^on:\s*\n  push:/mu);
  assert.match(workflow, /branches:\s*\n\s+- main/u);
  assert.match(workflow, /paths:\s*\n\s+- market-prediction-lab\/\*\*\s*\n\s+- \.github\/workflows\/market-prediction-lab-main-required-ci-bridge\.yml/u);
  assert.doesNotMatch(workflow, /^\s+pull_request:/mu);
  assert.doesNotMatch(workflow, /^\s+schedule:/mu);
  assert.doesNotMatch(workflow, /issue_comment|repository_dispatch|workflow_run/u);
});

test("bridge dispatches the canonical Application CI for the exact current main SHA", () => {
  assert.match(workflow, /actions:\s*write/u);
  assert.match(workflow, /contents:\s*read/u);
  assert.match(workflow, /context\.ref !== 'refs\/heads\/main'/u);
  assert.match(workflow, /repos\.getBranch/u);
  assert.match(workflow, /currentMainSha !== targetSha/u);
  assert.match(workflow, /MAIN_MOVED_BEFORE_DISPATCH/u);
  assert.match(workflow, /actions\.createWorkflowDispatch/u);
  assert.match(workflow, /workflow_id: 'futures-public-network-smoke\.yml'/u);
  assert.match(workflow, /ref: 'main'/u);
  assert.match(workflow, /inputs: \{ target_sha: targetSha \}/u);
});

test("bridge has no economic, deployment, secret, or trading authority", () => {
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.doesNotMatch(workflow, /^\s+environment:/mu);
  assert.doesNotMatch(workflow, /deploy|restart|workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /LIVE_TRADING\s*:\s*true|AUTO_TRADING\s*:\s*true|REAL_ORDER_ENABLED\s*:\s*true/u);
  assert.doesNotMatch(workflow, /privateTradingApiAllowed\s*:\s*true/u);
  assert.doesNotMatch(workflow, /order|cancel|transfer|withdraw/iu);
});
