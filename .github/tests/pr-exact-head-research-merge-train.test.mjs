import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  attachTargetParents,
  classifyChangedPaths,
  classifyPreReady,
  finalizePreReady,
  selectTargetPullRequests,
} from "../scripts/research-merge-train-pre-ready.mjs";

test("target selection is bounded to open PRs #1146 through #1170", () => {
  const pulls = [
    { number: 1145, state: "open", head: { ref: "a", sha: "a".repeat(40) }, base: { ref: "main", sha: "b".repeat(40) } },
    { number: 1146, state: "open", head: { ref: "root", sha: "c".repeat(40) }, base: { ref: "main", sha: "d".repeat(40) } },
    { number: 1153, state: "open", head: { ref: "dataset", sha: "e".repeat(40) }, base: { ref: "root", sha: "f".repeat(40) } },
    { number: 1170, state: "open", head: { ref: "component", sha: "1".repeat(40) }, base: { ref: "dataset", sha: "2".repeat(40) } },
    { number: 1171, state: "open", head: { ref: "outside", sha: "3".repeat(40) }, base: { ref: "main", sha: "4".repeat(40) } },
    { number: 1160, state: "closed", head: { ref: "closed", sha: "5".repeat(40) }, base: { ref: "main", sha: "6".repeat(40) } },
  ];
  assert.deepEqual(selectTargetPullRequests(pulls).map((pr) => pr.number), [1146, 1153, 1170]);
});

test("stacked PR dependencies are inferred from exact target head/base refs", () => {
  const pulls = [
    { number: 1146, state: "open", head: { ref: "factory", sha: "a".repeat(40) }, base: { ref: "main", sha: "b".repeat(40) } },
    { number: 1153, state: "open", head: { ref: "dataset", sha: "c".repeat(40) }, base: { ref: "factory", sha: "d".repeat(40) } },
    { number: 1154, state: "open", head: { ref: "catalog", sha: "e".repeat(40) }, base: { ref: "dataset", sha: "f".repeat(40) } },
  ];
  const attached = attachTargetParents(selectTargetPullRequests(pulls));
  assert.equal(attached.find((pr) => pr.number === 1146).parentPr, null);
  assert.equal(attached.find((pr) => pr.number === 1153).parentPr, 1146);
  assert.equal(attached.find((pr) => pr.number === 1154).parentPr, 1153);
});

test("Pre-Ready classification prioritizes stale, parent, drift, review and merge blockers", () => {
  assert.equal(classifyPreReady({ staleMatrix: true }), "STALE_MATRIX");
  assert.equal(classifyPreReady({ parentPr: 1153 }), "BLOCKED_BY_PARENT");
  assert.equal(classifyPreReady({ behindMain: 3 }), "NEEDS_REALIGN");
  assert.equal(classifyPreReady({ unresolved: 2 }), "BLOCKED_REVIEW");
  assert.equal(classifyPreReady({ mergeable: false }), "CONFLICT_OR_UNMERGEABLE");
  assert.equal(classifyPreReady({}), "READY_CANDIDATE_PRECHECK");
});

test("changed path classifier selects only applicable local validation lanes", () => {
  const impact = classifyChangedPaths([
    "research-production/src/research-factory-controller.mjs",
    "research-dashboard/server.py",
    "market-prediction-lab/tests/foo.test.js",
    ".github/workflows/example.yml",
  ]);
  assert.equal(impact.researchProduction, true);
  assert.equal(impact.researchDashboard, true);
  assert.equal(impact.predictionLab, true);
  assert.equal(impact.ciContracts, true);
});

test("local validation failure blocks a candidate without granting any authority", () => {
  const report = {
    preReadyState: "READY_CANDIDATE_PRECHECK",
    validationPlan: {
      staticAuditors: true,
      researchProduction: true,
      researchDashboard: false,
      predictionLab: false,
      ciContracts: false,
    },
  };
  const failed = finalizePreReady(report, {
    staticAuditors: "success",
    researchProduction: "failure",
  });
  assert.equal(failed.finalState, "PRE_READY_FAILED");
  assert.equal(failed.localValidation.status, "FAIL");

  const passed = finalizePreReady(report, {
    staticAuditors: "success",
    researchProduction: "success",
  });
  assert.equal(passed.finalState, "READY_CANDIDATE");
  assert.equal(passed.localValidation.status, "PASS");
});

test("workflow is manual, read-only, bounded-parallel and cannot Ready/Merge/Deploy/Activate", async () => {
  const workflow = await readFile(".github/workflows/research-merge-train-pre-ready.yml", "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.match(workflow, /default: "1146"/u);
  assert.match(workflow, /default: "1170"/u);
  assert.match(workflow, /max-parallel: 6/u);
  assert.match(workflow, /fail-fast: false/u);
  assert.match(workflow, /fromJson\(needs\.discover\.outputs\.matrix\)/u);
  assert.match(workflow, /^  contents: read$/mu);
  assert.match(workflow, /^  pull-requests: read$/mu);
  assert.match(workflow, /^  actions: read$/mu);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|actions: write/u);
  assert.doesNotMatch(workflow, /^  schedule:/mu);
  assert.doesNotMatch(workflow, /pull_request_target/u);
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.doesNotMatch(workflow, /gh pr (ready|merge)|createWorkflowDispatch|git push/u);
  assert.doesNotMatch(workflow, /^\s+environment:/mu);
  assert.match(workflow, /REQUIRED_CI_REPLACEMENT=false/u);
  assert.match(workflow, /READY_AUTHORITY=false/u);
  assert.match(workflow, /MERGE_AUTHORITY=false/u);
  assert.match(workflow, /DEPLOY_AUTHORITY=false/u);
  assert.match(workflow, /ACTIVATION_AUTHORITY=false/u);
});
