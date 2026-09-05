import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const WORKFLOWS = {
  application: ".github/workflows/futures-public-network-smoke.yml",
  research: ".github/workflows/prediction-lab-pr-head-unit.yml",
  multiMarket: ".github/workflows/prediction-lab-52d-validation.yml",
  longHistory: ".github/workflows/prediction-lab-long-history-v1.yml",
};

function indentedBlock(document, key, indent) {
  const lines = document.split(/\r?\n/u);
  const prefix = `${" ".repeat(indent)}${key}:`;
  const start = lines.findIndex((line) => line === prefix);
  assert.notEqual(start, -1, `missing ${prefix}`);

  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      body.push(line);
      continue;
    }
    const currentIndent = line.match(/^ */u)[0].length;
    if (currentIndent <= indent) break;
    body.push(line);
  }
  return body.join("\n");
}

function assertBasicWorkflowSyntax(document) {
  assert.doesNotMatch(document, /\t/u, "workflow YAML must not contain tabs");
  assert.match(document, /^name: .+/mu);
  assert.match(document, /^on:\s*$/mu);
  assert.match(document, /^permissions:\s*$/mu);
  assert.match(document, /^jobs:\s*$/mu);
  for (const line of document.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.match(/^ */u)[0].length;
    assert.equal(indent % 2, 0, `invalid indentation: ${line}`);
  }
}

const documents = Object.fromEntries(await Promise.all(Object.entries(WORKFLOWS).map(async ([name, path]) => [
  name,
  await readFile(path, "utf8"),
])));

test("workflow syntax and PR event contract are explicit", () => {
  for (const document of Object.values(documents)) {
    assertBasicWorkflowSyntax(document);
    const pullRequest = indentedBlock(indentedBlock(document, "on", 0), "pull_request", 2);
    assert.doesNotMatch(pullRequest, /^\s+branches:/mu, "stacked PR bases must not be excluded");
    assert.doesNotMatch(document, /pull_request_target/u);
    for (const activity of ["opened", "synchronize", "reopened"]) {
      assert.match(pullRequest, new RegExp(`- ${activity}`, "u"));
    }
  }
});

test("authoritative main push CI and required status publishers remain intact", () => {
  const push = indentedBlock(indentedBlock(documents.application, "on", 0), "push", 2);
  assert.match(push, /^\s+branches:\s*\n\s+- main$/mu);
  for (const context of [
    "application-ci/verified",
    "browser-ui/verified",
    "database-rls/verified",
    "security-integration/verified",
    "ai-privacy/verified",
    "futures-public-network-smoke/verified",
  ]) {
    assert.match(documents.application, new RegExp(context.replaceAll("/", "\\/"), "u"));
  }
  for (const name of ["application", "multiMarket", "longHistory"]) {
    assert.match(indentedBlock(documents[name], "on", 0), /^\s+workflow_dispatch:/mu);
  }
});

test("each lane exposes a clear PR exact check name", () => {
  assert.match(documents.application, /PR Exact Application CI/u);
  assert.match(documents.multiMarket, /PR Exact Multi-Market/u);
  assert.match(documents.longHistory, /PR Exact Long-History/u);
  assert.match(documents.research, /PR Exact Research Tests/u);
});

test("each checkout verifies expected SHA, actual HEAD, and detached mode", () => {
  for (const [name, document] of Object.entries(documents)) {
    assert.match(document, /git rev-parse HEAD/u, `${name} does not read actual HEAD`);
    assert.match(document, /git symbolic-ref --quiet --short HEAD/u, `${name} does not reject branch checkout`);
    assert.match(document, /HEAD_SHA_MISMATCH/u, `${name} does not report SHA mismatch`);
    assert.match(document, /UNEXPECTED_BRANCH/u, `${name} does not report unexpected branch`);
    assert.match(document, /persist-credentials: false/u, `${name} persists checkout credentials`);
  }
});

test("expensive research lanes retain path filters and report failures", () => {
  for (const name of ["research", "multiMarket", "longHistory"]) {
    const pullRequest = indentedBlock(indentedBlock(documents[name], "on", 0), "pull_request", 2);
    assert.match(pullRequest, /^\s+paths:/mu, `${name} lost its path filter`);
  }
  assert.match(documents.multiMarket, /Fail workflow when technical validation failed/u);
  assert.match(documents.longHistory, /PR Exact Long-History/u);
  assert.match(documents.application, /Publish verified Application CI result/u);
});

test("PR lane has no secret, deployment, timer, or trading authority", () => {
  for (const document of Object.values(documents)) {
    assert.doesNotMatch(document, /secrets\./u);
    assert.doesNotMatch(document, /^\s+(deploy|environment):/mu);
    assert.doesNotMatch(document, /^\s+schedule:/mu);
    assert.doesNotMatch(document, /REAL_ORDER_ENABLED\s*:\s*true/u);
  }
});
