import test from "node:test";
import assert from "node:assert/strict";

import {
  assertExactCheckout,
  formatFailure,
  resolveTestedSha,
  selectValidationLanes,
} from "../scripts/pr-exact-head-contract.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("pull_request events select the immutable PR head SHA", () => {
  assert.equal(resolveTestedSha({
    eventName: "pull_request",
    pullRequestHeadSha: SHA_A.toUpperCase(),
    eventSha: SHA_B,
  }), SHA_A);
});

test("workflow_dispatch requires an exact SHA and falls back to the event SHA", () => {
  assert.equal(resolveTestedSha({ eventName: "workflow_dispatch", eventSha: SHA_A }), SHA_A);
  assert.throws(
    () => resolveTestedSha({ eventName: "workflow_dispatch", dispatchSha: "main", eventSha: SHA_A }),
    /INVALID_SHA/,
  );
});

test("unsupported PR activity sources fail closed", () => {
  assert.throws(() => resolveTestedSha({ eventName: "pull_request_target", eventSha: SHA_A }), /UNSUPPORTED_EVENT/);
});

test("exact detached checkout is accepted", () => {
  assert.deepEqual(assertExactCheckout({ testedSha: SHA_A, headSha: SHA_A }), {
    testedSha: SHA_A,
    headSha: SHA_A,
    checkoutMode: "DETACHED",
  });
});

test("wrong SHA and unexpected branch checkout are rejected", () => {
  assert.throws(() => assertExactCheckout({ testedSha: SHA_A, headSha: SHA_B }), /HEAD_SHA_MISMATCH/);
  assert.throws(
    () => assertExactCheckout({ testedSha: SHA_A, headSha: SHA_A, branchName: "feature/stale" }),
    /UNEXPECTED_BRANCH/,
  );
});

test("path filtering keeps unrelated changes out of expensive research lanes", () => {
  assert.deepEqual(selectValidationLanes(["docs/readme.md"]), {
    application: true,
    researchTests: false,
    multiMarket: false,
    longHistory: false,
  });

  assert.deepEqual(selectValidationLanes(["market-prediction-lab/src/autonomous-factory.js"]), {
    application: true,
    researchTests: true,
    multiMarket: true,
    longHistory: false,
  });

  assert.deepEqual(selectValidationLanes(["market-prediction-lab/tests/autonomous-factory.test.js"]), {
    application: true,
    researchTests: true,
    multiMarket: true,
    longHistory: true,
  });

  assert.deepEqual(selectValidationLanes([".github/workflows/prediction-lab-long-history-v1.yml"]), {
    application: true,
    researchTests: true,
    multiMarket: false,
    longHistory: true,
  });
});

test("failure reporting is explicit and stable", () => {
  assert.equal(formatFailure("HEAD_SHA_MISMATCH", "tested A, checked out B"), "[HEAD_SHA_MISMATCH] tested A, checked out B");
});
