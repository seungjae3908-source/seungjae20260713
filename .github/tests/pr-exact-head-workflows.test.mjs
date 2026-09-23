import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const WORKFLOWS = {
  application: ".github/workflows/futures-public-network-smoke.yml",
  applicationFast: ".github/workflows/application-fast-ci.yml",
  applicationReadyDispatch: ".github/workflows/application-full-ci-ready-dispatch.yml",
  applicationMainFallback: ".github/workflows/application-ci-main-fallback.yml",
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

const rule0Sidecar = await readFile(".github/workflows/prediction-lab-rule0-1h-shadow-sidecar.yml", "utf8");
const derivativesHistory = await readFile("market-prediction-lab/src/derivatives-history.js");

test("workflow syntax and PR event contracts are explicit", () => {
  for (const document of Object.values(documents)) {
    assertBasicWorkflowSyntax(document);
    assert.doesNotMatch(document, /pull_request_target/u);
  }

  const fastPullRequest = indentedBlock(indentedBlock(documents.applicationFast, "on", 0), "pull_request", 2);
  for (const activity of ["opened", "synchronize", "reopened", "converted_to_draft"]) {
    assert.match(fastPullRequest, new RegExp(`- ${activity}`, "u"));
  }
  assert.doesNotMatch(fastPullRequest, /- ready_for_review/u);
  assert.doesNotMatch(fastPullRequest, /^\s+branches:/mu, "stacked PR bases must not be excluded");
  assert.doesNotMatch(documents.applicationFast, /if: github\.event\.pull_request\.draft == true/u);

  const applicationOn = indentedBlock(documents.application, "on", 0);
  const applicationPullRequest = indentedBlock(applicationOn, "pull_request", 2);
  assert.match(applicationPullRequest, /- ready_for_review/u);
  assert.doesNotMatch(applicationPullRequest, /^\s+branches:/mu, "stacked PR bases must not be excluded");
  assert.match(applicationOn, /^\s+workflow_dispatch:/mu);

  const dispatcherOn = indentedBlock(documents.applicationReadyDispatch, "on", 0);
  const workflowRun = indentedBlock(dispatcherOn, "workflow_run", 2);
  assert.match(workflowRun, /- Application Fast CI/u);
  assert.match(workflowRun, /- completed/u);
  assert.doesNotMatch(dispatcherOn, /^\s+pull_request:/mu);
  assert.match(documents.applicationReadyDispatch, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(documents.applicationReadyDispatch, /if \(pr\.draft\)/u);

  for (const name of ["research", "multiMarket", "longHistory"]) {
    const pullRequest = indentedBlock(indentedBlock(documents[name], "on", 0), "pull_request", 2);
    assert.doesNotMatch(pullRequest, /^\s+branches:/mu, "stacked PR bases must not be excluded");
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
    assert.doesNotMatch(documents.applicationFast, new RegExp(context.replaceAll("/", "\\/"), "u"));
    assert.doesNotMatch(documents.applicationReadyDispatch, new RegExp(context.replaceAll("/", "\\/"), "u"));
  }
  for (const name of ["application", "multiMarket", "longHistory"]) {
    assert.match(indentedBlock(documents[name], "on", 0), /^\s+workflow_dispatch:/mu);
  }
  assert.doesNotMatch(indentedBlock(documents.applicationFast, "on", 0), /^\s+workflow_dispatch:/mu);
  assert.doesNotMatch(indentedBlock(documents.applicationReadyDispatch, "on", 0), /^\s+workflow_dispatch:/mu);
});

test("exact-current-main CI recovery command dispatches only canonical full CI", () => {
  const document = documents.applicationMainFallback;
  const on = indentedBlock(document, "on", 0);
  assert.match(on, /^\s+push:/mu);
  assert.match(on, /^\s+issue_comment:/mu);
  assert.match(document, /github\.event\.issue\.number == 23/u);
  assert.match(document, /github\.event\.comment\.user\.login == github\.repository_owner/u);
  assert.match(document, /github\.event\.comment\.author_association == 'OWNER'/u);
  assert.match(document, /startsWith\(github\.event\.comment\.body, '\/run-application-ci-main '\)/u);
  assert.match(document, /\^\\\/run-application-ci-main \(\[0-9a-f\]\{40\}\)\$/u);
  assert.match(document, /officialWorkflowId = 'futures-public-network-smoke\.yml'/u);
  assert.match(document, /createWorkflowDispatch/u);
  assert.match(document, /inputs: \{ target_sha: sha, checkout_ref: sha \}/u);
  assert.match(document, /Fallback CI requires the exact current main SHA/u);
  assert.doesNotMatch(document, /merge_pull_request|REAL_ORDER_ENABLED\s*:\s*true|LIVE_TRADING\s*:\s*true/u);
});

test("fast CI remains development-only while canonical full CI remains the release authority", () => {
  assert.match(documents.applicationFast, /Application Fast CI is a development accelerator only/u);
  assert.match(documents.applicationFast, /MUST NOT publish or replace any of the six Required CI contexts/u);
  assert.match(documents.applicationFast, /Final Ready\/Merge\/Staging gates still require canonical Application CI 6\/6/u);
  assert.match(documents.application, /Publish verified Application CI result/u);
  assert.match(documents.application, /Playwright desktop and mobile application UI/u);
  assert.match(documents.application, /Disposable PostgreSQL migration and RLS integration/u);
  assert.match(documents.application, /Security input, bundle, and outbound safety verification/u);
  assert.match(documents.application, /AI privacy, prompt, output, and outbound verification/u);
  assert.match(documents.application, /Bitget public API smoke/u);
});

test("successful exact-head Fast CI is required for both commit-change and Ready-transition full CI", () => {
  const document = documents.applicationReadyDispatch;
  assert.match(document, /actions: write/u);
  assert.match(document, /workflowId = 'futures-public-network-smoke\.yml'/u);
  assert.match(document, /createWorkflowDispatch/u);
  assert.match(document, /target_sha: targetSha/u);
  assert.match(document, /checkout_ref: targetSha/u);
  assert.match(document, /run\.head_sha/u);
  assert.match(document, /String\(pr\.head\.sha\)\.toLowerCase\(\) !== targetSha/u);
  assert.match(document, /if \(pr\.draft\)/u);
  assert.match(document, /Failed, skipped, cancelled, missing, stale, or Draft Fast CI cannot dispatch/u);
  assert.match(document, /grants no merge, staging, production, database, secret, environment, live-trading, or real-order authority/u);

  const fastPullRequest = indentedBlock(indentedBlock(documents.applicationFast, "on", 0), "pull_request", 2);
  assert.doesNotMatch(fastPullRequest, /- ready_for_review/u);
  const applicationPullRequest = indentedBlock(indentedBlock(documents.application, "on", 0), "pull_request", 2);
  assert.match(applicationPullRequest, /- ready_for_review/u);
  assert.match(documents.application, /READY_FAST_CI_NOT_GREEN/u);
  assert.match(documents.application, /latestFast\.conclusion !== 'success'/u);
});

test("each lane exposes a clear exact-head or fast check name", () => {
  assert.match(documents.application, /PR Exact Application CI/u);
  assert.match(documents.applicationFast, /Changed-scope typecheck, tests, and build/u);
  assert.match(documents.applicationReadyDispatch, /Dispatch canonical full CI after exact-head Fast CI success/u);
  assert.match(documents.multiMarket, /PR Exact Multi-Market/u);
  assert.match(documents.longHistory, /PR Exact Long-History/u);
  assert.match(documents.research, /PR Exact Research Tests/u);
});

test("checkout-based lanes verify expected SHA, actual HEAD, and detached mode", () => {
  for (const name of ["application", "applicationFast", "research", "multiMarket", "longHistory"]) {
    const document = documents[name];
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

test("multi-market PR data blocks stay truthful without weakening full dispatch validation", () => {
  assert.match(documents.multiMarket, /research_ready:\s*\$\{\{ steps\.market_suite\.outputs\.research_ready \}\}/u);
  assert.match(documents.multiMarket, /steps\.market_suite\.outputs\.research_ready == 'true'/u);
  assert.match(documents.multiMarket, /github\.event_name != 'pull_request' && steps\.market_suite\.outputs\.research_ready != 'true'/u);
  assert.match(documents.multiMarket, /github\.event_name == 'workflow_dispatch'[\s\S]*needs\.validate-and-train\.outputs\.research_ready == 'true'/u);
});

test("Rule0 OI parity lock tracks the exact derivatives-history Git blob before merge", () => {
  const match = rule0Sidecar.match(/^\s*CANONICAL_OI_PARITY_BLOB:\s*([0-9a-f]{40})\s*$/mu);
  assert.ok(match, "Rule0 sidecar must pin a canonical OI parity blob");

  const gitHeader = Buffer.from(`blob ${derivativesHistory.length}\0`);
  const actualBlob = createHash("sha1").update(gitHeader).update(derivativesHistory).digest("hex");
  assert.equal(match[1], actualBlob, "Rule0 sidecar OI parity blob drifted from derivatives-history.js");

  const fastPullRequest = indentedBlock(indentedBlock(documents.applicationFast, "on", 0), "pull_request", 2);
  assert.match(fastPullRequest, /- market-prediction-lab\/src\/derivatives-history\.js/u);
});

test("PR lanes have no secret, deployment, timer, or trading authority", () => {
  for (const document of Object.values(documents)) {
    assert.doesNotMatch(document, /secrets\./u);
    assert.doesNotMatch(document, /^\s+(deploy|environment):/mu);
    assert.doesNotMatch(document, /^\s+schedule:/mu);
    assert.doesNotMatch(document, /REAL_ORDER_ENABLED\s*:\s*true/u);
  }
});
