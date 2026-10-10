import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowPath = ".github/workflows/paper-canonical-seven-blocker-repair.yml";
const workflow = await readFile(workflowPath, "utf8");
const validation = await readFile(".github/workflows/paper-forward-schedule-validation.yml", "utf8");

test("Paper repair checks out the exact command SHA before loading local provenance code", () => {
  const checkoutName = "Checkout exact repair target for provenance helper";
  const provenanceName = "Require exact current main, coherent Required CI, official Production deploy, and Research source ancestry";
  const checkoutIndex = workflow.indexOf(checkoutName);
  const provenanceIndex = workflow.indexOf(provenanceName);

  assert.notEqual(checkoutIndex, -1, "missing exact-target checkout");
  assert.notEqual(provenanceIndex, -1, "missing provenance gate");
  assert.ok(checkoutIndex < provenanceIndex, "checkout must precede the local helper import");

  const checkoutBlock = workflow.slice(checkoutIndex, provenanceIndex);
  assert.match(checkoutBlock, /uses: actions\/checkout@v4/u);
  assert.match(checkoutBlock, /ref: \$\{\{ steps\.command\.outputs\.target_sha \}\}/u);
  assert.match(checkoutBlock, /fetch-depth: 1/u);
  assert.match(checkoutBlock, /persist-credentials: false/u);
  assert.match(workflow.slice(provenanceIndex), /\.github\/scripts\/current-main-ci-provenance\.cjs/u);
});

test("Paper validation owns the checkout regression test path", () => {
  const testPath = ".github/tests/pr-exact-head-paper-repair-checkout.test.mjs";
  assert.equal(validation.split(testPath).length - 1, 2);
});
