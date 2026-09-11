import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const path = ".github/workflows/market-prediction-lab-main-required-ci-bridge.yml";
const workflow = await readFile(path, "utf8");
const phase3Source = await readFile("market-prediction-lab/src/phase3-strategy-tournament-core-v1.js", "utf8");
const phase3Test = await readFile("market-prediction-lab/tests/phase3-strategy-tournament-core-v1.test.js", "utf8");

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

test("Phase 3 tournament source and regression owner cannot silently disappear", () => {
  assert.match(phase3Source, /export async function runPhase3StrategyTournamentCoreV1/u);
  assert.match(phase3Source, /phase4Handoff/u);
  assert.match(phase3Source, /PROFITABILITY_PROVEN:\s*false/u);
  assert.match(phase3Test, /finalists are Phase-4 inputs, never profitability proofs or champions/u);
  assert.match(phase3Test, /TRAIN is the only permitted data role/u);
});

test("bridge has no economic, deployment, secret, or trading authority", () => {
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.doesNotMatch(workflow, /^\s+environment:/mu);
  assert.doesNotMatch(workflow, /Production Deploy|Staging activation|Production activation|restart/iu);
  assert.doesNotMatch(workflow, /LIVE_TRADING\s*:\s*true|AUTO_TRADING\s*:\s*true|REAL_ORDER_ENABLED\s*:\s*true/u);
  assert.doesNotMatch(workflow, /PRIVATE_TRADING_API_ALLOWED\s*:\s*true|privateTradingApiAllowed\s*:\s*true/u);
  assert.doesNotMatch(workflow, /\b(order|transfer|withdrawal)\b/iu);
  assert.match(workflow, /cancel-in-progress: false/u);
});
