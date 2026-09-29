import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const policyWorkflowUrl = new URL("../../.github/workflows/prediction-lab-model-reference-durable-policy.yml", import.meta.url);
const parentWorkflowUrl = new URL("../../.github/workflows/prediction-lab-52d-validation.yml", import.meta.url);

test("durable policy reusable workflow declares and consumes the environment-bound credential", async () => {
  const [workflow, parentWorkflow] = await Promise.all([
    readFile(policyWorkflowUrl, "utf8"),
    readFile(parentWorkflowUrl, "utf8"),
  ]);
  assert.match(workflow, /workflow_call:[\s\S]*secrets:[\s\S]*PREDICTION_LAB_IMMUTABLE_RELEASE_POLICY_TOKEN:/u);
  assert.match(workflow, /environment:\s*prediction-lab-durable-reference/u);
  assert.match(parentWorkflow, /durable-policy-preflight:[\s\S]*secrets:\s*inherit/u);
  assert.match(workflow, /IMMUTABLE_RELEASE_POLICY_TOKEN:\s*\$\{\{ secrets\.PREDICTION_LAB_IMMUTABLE_RELEASE_POLICY_TOKEN \}\}/u);
  assert.match(workflow, /Administration:read/u);
  assert.match(workflow, /\/immutable-releases/u);
  assert.doesNotMatch(workflow, /Administration:\s*write/u);
});
