import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const path = ".github/workflows/main-post-merge-required-ci-bridge.yml";
const workflow = await readFile(path, "utf8");

test("bridge is main-push-only with no schedule or comment control surface", () => {
  assert.match(workflow, /^on:\s*\n  push:/mu);
  assert.match(workflow, /branches:\s*\n\s+- main/u);
  assert.doesNotMatch(workflow, /^\s+pull_request:/mu);
  assert.doesNotMatch(workflow, /^\s+schedule:/mu);
  assert.doesNotMatch(workflow, /issue_comment|repository_dispatch|workflow_run/u);
});

test("bridge verifies exact current main before any dispatch", () => {
  assert.match(workflow, /context\.ref !== 'refs\/heads\/main'/u);
  assert.match(workflow, /repos\.getBranch/u);
  assert.match(workflow, /currentMainSha !== targetSha/u);
  assert.match(workflow, /MAIN_MOVED_BEFORE_DISPATCH/u);
});

test("bridge skips duplicate dispatch when native Application CI push coverage applies", () => {
  for (const expected of [
    ".github/workflows/futures-public-network-smoke.yml",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "api-server/",
    "stock-analyzer/",
    "packages/",
  ]) {
    assert.ok(workflow.includes(expected), `missing direct Application CI path classification: ${expected}`);
  }
  assert.match(workflow, /compareCommitsWithBasehead/u);
  assert.match(workflow, /changedFiles\.some\(directApplicationCiPath\)/u);
  assert.match(workflow, /bridge dispatch not needed/u);
});

test("bridge reuses canonical Application CI and preserves no-duplicate fail-safe", () => {
  assert.match(workflow, /actions:\s*write/u);
  assert.match(workflow, /contents:\s*read/u);
  assert.match(workflow, /listWorkflowRunsForRepo/u);
  assert.match(workflow, /run\.name === 'Application CI'/u);
  assert.match(workflow, /actions\.createWorkflowDispatch/u);
  assert.match(workflow, /workflow_id: 'futures-public-network-smoke\.yml'/u);
  assert.match(workflow, /inputs: \{ target_sha: targetSha \}/u);
  assert.match(workflow, /dispatching an extra canonical CI run is allowed while skipping one is not/u);
});

test("bridge grants no deploy, schedule activation, secret, economic, or trading authority", () => {
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.doesNotMatch(workflow, /^\s+environment:/mu);
  assert.doesNotMatch(workflow, /Production Deploy|Staging activation|Production activation|restart/iu);
  assert.doesNotMatch(workflow, /LIVE_TRADING\s*:\s*true|AUTO_TRADING\s*:\s*true|REAL_ORDER_ENABLED\s*:\s*true/u);
  assert.doesNotMatch(workflow, /PRIVATE_TRADING_API_ALLOWED\s*:\s*true|privateTradingApiAllowed\s*:\s*true/u);
  assert.doesNotMatch(workflow, /\b(order|transfer|withdrawal)\b/iu);
  assert.match(workflow, /cancel-in-progress: false/u);
});
