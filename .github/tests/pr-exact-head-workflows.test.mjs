import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const WORKFLOWS = {
  application: ".github/workflows/futures-public-network-smoke.yml",
  applicationFast: ".github/workflows/application-fast-ci.yml",
  applicationMainFallback: ".github/workflows/application-ci-main-fallback.yml",
  postMergeProvenance: ".github/workflows/post-merge-release-provenance.yml",
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
const dashboardReadback = await readFile(".github/workflows/research-dashboard-overview-readback.yml", "utf8");

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
  assert.match(applicationOn, /^\s+workflow_dispatch:/mu);
  assert.doesNotMatch(applicationOn, /^\s+pull_request:/mu, "canonical full CI is dispatched after Fast CI, not by Ready transition");
  assert.doesNotMatch(applicationOn, /^\s+push:/mu, "main push must not repeat canonical full CI");

  assert.match(documents.applicationFast, /^  dispatch-full-ci:/mu);
  assert.match(documents.applicationFast, /needs: \[fast, browser-critical\]/u);
  assert.match(documents.applicationFast, /actions: write/u);
  assert.match(documents.applicationFast, /createWorkflowDispatch/u);
  assert.match(documents.applicationFast, /Dispatched canonical pre-merge Application CI/u);

  const postMergeOn = indentedBlock(documents.postMergeProvenance, "on", 0);
  const postMergePush = indentedBlock(postMergeOn, "push", 2);
  assert.match(postMergePush, /^\s+branches:\s*\n\s+- main$/mu);

  for (const name of ["research", "multiMarket", "longHistory"]) {
    const pullRequest = indentedBlock(indentedBlock(documents[name], "on", 0), "pull_request", 2);
    assert.doesNotMatch(pullRequest, /^\s+branches:/mu, "stacked PR bases must not be excluded");
    for (const activity of ["opened", "synchronize", "reopened"]) {
      assert.match(pullRequest, new RegExp(`- ${activity}`, "u"));
    }
  }
});

test("pre-merge full CI owns Required contexts and main push uses provenance only", () => {
  const applicationOn = indentedBlock(documents.application, "on", 0);
  assert.match(applicationOn, /^\s+workflow_dispatch:/mu);
  assert.doesNotMatch(applicationOn, /^\s+push:/mu);
  assert.doesNotMatch(applicationOn, /^\s+pull_request:/mu);

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
  }

  assert.match(documents.postMergeProvenance, /post-merge-provenance\/verified/u);
  assert.match(documents.postMergeProvenance, /evaluateReleaseCandidateProvenance/u);
  assert.match(documents.postMergeProvenance, /targetTreeSha/u);
  assert.match(documents.postMergeProvenance, /headTreeSha/u);
  assert.match(documents.postMergeProvenance, /Pre-merge 6\/6 \+ merged tree identity verified/u);

  for (const name of ["application", "multiMarket", "longHistory"]) {
    assert.match(indentedBlock(documents[name], "on", 0), /^\s+workflow_dispatch:/mu);
  }
  assert.doesNotMatch(indentedBlock(documents.applicationFast, "on", 0), /^\s+workflow_dispatch:/mu);
});

test("exact-current-main CI recovery is manual-only", () => {
  const document = documents.applicationMainFallback;
  const on = indentedBlock(document, "on", 0);
  assert.doesNotMatch(on, /^\s+push:/mu, "main push must not auto-repeat full CI");
  assert.match(on, /^\s+issue_comment:/mu);
  assert.match(document, /contains\(github\.event\.issue\.labels\.\*\.name, 'release-control'\)/u);
  assert.match(document, /github\.event\.issue\.pull_request == null/u);
  assert.match(document, /github\.event\.issue\.state == 'open'/u);
  assert.match(document, /startsWith\(github\.event\.issue\.title, 'Staging Readiness Control'\)/u);
  assert.match(document, /current-release-control\.cjs/u);
  assert.doesNotMatch(document, /github\.event\.issue\.number == \d+\b/u);
  assert.match(document, /github\.event\.comment\.user\.login == github\.repository_owner/u);
  assert.match(document, /github\.event\.comment\.author_association == 'OWNER'/u);
  assert.match(document, /startsWith\(github\.event\.comment\.body, '\/run-application-ci-main '\)/u);
  assert.match(document, /officialWorkflowId = 'futures-public-network-smoke\.yml'/u);
  assert.match(document, /createWorkflowDispatch/u);
  assert.match(document, /inputs: \{ target_sha: sha, checkout_ref: sha \}/u);
  assert.match(document, /Fallback CI requires the exact current main SHA/u);
  assert.doesNotMatch(document, /merge_pull_request|REAL_ORDER_ENABLED\s*:\s*true|LIVE_TRADING\s*:\s*true/u);
});

test("fast CI remains development-only while pre-merge full CI remains the validation authority", () => {
  assert.match(documents.applicationFast, /Application Fast CI is a development accelerator only/u);
  assert.match(documents.applicationFast, /MUST NOT publish or replace any of the six Required CI contexts/u);
  assert.match(documents.applicationFast, /Final Ready\/Merge still require canonical pre-merge Application CI 6\/6/u);
  assert.match(documents.applicationFast, /Staging\/Production require verified post-merge tree provenance/u);
  assert.match(documents.application, /Publish verified Application CI result/u);
  assert.match(documents.application, /Playwright desktop and mobile application UI/u);
  assert.match(documents.application, /Disposable PostgreSQL migration and RLS integration/u);
  assert.match(documents.application, /Security input, bundle, and outbound safety verification/u);
  assert.match(documents.application, /AI privacy, prompt, output, and outbound verification/u);
  assert.match(documents.application, /Bitget public API smoke/u);
});

test("successful exact-head Fast CI dispatches full CI for Draft or Ready PRs", () => {
  const document = documents.applicationFast;
  assert.match(document, /^  dispatch-full-ci:/mu);
  assert.match(document, /needs: \[fast, browser-critical\]/u);
  assert.match(document, /needs\.fast\.result == 'success'/u);
  assert.match(document, /needs\.browser-critical\.result == 'success'/u);
  assert.match(document, /actions: write/u);
  assert.match(document, /workflowId = 'futures-public-network-smoke\.yml'/u);
  assert.match(document, /createWorkflowDispatch/u);
  assert.match(document, /target_sha: targetSha/u);
  assert.match(document, /checkout_ref: targetSha/u);
  assert.match(document, /String\(pr\.head\.sha \|\| ''\)\.toLowerCase\(\) !== targetSha/u);
  assert.match(document, /pr\.draft \? 'Draft' : 'Ready'/u);
  assert.match(document, /Full CI dispatch occurs only after both Fast CI jobs succeed/u);
  assert.doesNotMatch(document, /REAL_ORDER_ENABLED\s*:\s*true|LIVE_TRADING\s*:\s*true/u);

  const fastPullRequest = indentedBlock(indentedBlock(document, "on", 0), "pull_request", 2);
  assert.doesNotMatch(fastPullRequest, /- ready_for_review/u);
  assert.doesNotMatch(indentedBlock(documents.application, "on", 0), /^\s+pull_request:/mu);
  assert.match(documents.application, /READY_FAST_CI_NOT_GREEN/u);
  assert.match(documents.application, /latestFast\.conclusion !== 'success'/u);
});

test("each lane exposes a clear exact-head or fast check name", () => {
  assert.match(documents.application, /PR Exact Application CI/u);
  assert.match(documents.applicationFast, /Changed-scope typecheck, tests, and build/u);
  assert.match(documents.applicationFast, /Dispatch canonical pre-merge Full CI/u);
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
  assert.match(documents.multiMarket, /Record explicit research hold when required temporal evidence is incomplete/u);
  assert.match(documents.multiMarket, /RESEARCH_HOLD_TEMPORAL_EVIDENCE/u);
  assert.match(documents.multiMarket, /MISSING_TEMPORAL_REQUIRED_FEATURE_EVIDENCE:/u);

  const failStart = documents.multiMarket.lastIndexOf("- name: Fail workflow when technical validation failed");
  const nextJob = documents.multiMarket.indexOf("\n  durable-policy-preflight:", failStart);
  assert.ok(failStart >= 0 && nextJob > failStart, "multi-market technical failure block must remain present");
  const technicalFailureBlock = documents.multiMarket.slice(failStart, nextJob);
  assert.match(technicalFailureBlock, /steps\.research_hold\.outcome == 'failure'/u);
  assert.doesNotMatch(technicalFailureBlock, /steps\.market_suite\.outputs\.research_ready != 'true'/u);

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


test("Research Dashboard readback receipt parser uses real regex escapes", () => {
  assert.ok(
    dashboardReadback.includes("matchAll(/<!--\\s*agent-hub-predecessor:(\\d+)\\s*-->/g)"),
    "predecessor marker parser must use regex whitespace/digit tokens",
  );
  assert.ok(
    dashboardReadback.includes("matchAll(/<!--\\s*agent-hub-successor:(\\d+)\\s*-->/g)"),
    "successor marker parser must use regex whitespace/digit tokens",
  );
  assert.ok(
    dashboardReadback.includes("receipt.match(/(?:^|\\n)target_sha:\\s*([0-9a-f]{40})(?:\\n|$)/i)"),
    "activation target parser must use newline/whitespace regex tokens",
  );
  assert.ok(
    dashboardReadback.includes("receipt.match(/(?:^|\\n)canonical_hub:\\s*#(\\d+)(?:\\n|$)/i)"),
    "activation hub parser must use newline/whitespace/digit regex tokens",
  );
  assert.equal(dashboardReadback.includes("matchAll(/<!--\\\\s*agent-hub-predecessor:"), false);
  assert.equal(dashboardReadback.includes("matchAll(/<!--\\\\s*agent-hub-successor:"), false);
  assert.equal(dashboardReadback.includes("receipt.match(/(?:^|\\\\n)target_sha:\\\\s*"), false);
  assert.equal(dashboardReadback.includes("receipt.match(/(?:^|\\\\n)canonical_hub:\\\\s*"), false);
});


test("Research Dashboard readback validates frozen multi-lane live count relationships instead of stale snapshot literals", () => {
  assert.ok(dashboardReadback.includes("const measuredCounts = {"));
  assert.ok(dashboardReadback.includes("targetSlotIndex: li.targetSlotIndex"));
  assert.ok(dashboardReadback.includes("Number.isSafeInteger(value)"));
  assert.equal(dashboardReadback.includes("li.genuineScheduledSlotN < li.effectiveIndependentN"), false);
  assert.ok(dashboardReadback.includes("li.genuineScheduledSlotN > li.targetSlotIndex + 1"));
  assert.ok(dashboardReadback.includes("li.effectiveIndependentN > li.genuineScheduledSlotN * 2"));
  assert.ok(dashboardReadback.includes("li.rawAcceptedN < li.effectiveIndependentN"));
  assert.ok(dashboardReadback.includes("li.effectiveIndependentN !== li.independentBuyN + li.independentSellN"));
  assert.ok(dashboardReadback.includes("li.effectiveIndependentN !== counts.TRAIN + counts.VALIDATION + counts.OOS"));
  assert.ok(dashboardReadback.includes("counts.TRAIN > 512 || counts.VALIDATION > 256 || counts.OOS > 256"));
  assert.ok(dashboardReadback.includes("li.targetSlotIndex < 512"));
  assert.ok(dashboardReadback.includes("li.targetSlotIndex < 768"));
  assert.ok(dashboardReadback.includes("counts.VALIDATION !== 0"));
  assert.ok(dashboardReadback.includes("counts.OOS !== 0"));
  assert.equal(dashboardReadback.includes("li.genuineScheduledSlotN !== 15"), false);
  assert.equal(dashboardReadback.includes("li.effectiveIndependentN !== 15"), false);
  assert.equal(dashboardReadback.includes("li.independentBuyN !== 10"), false);
  assert.equal(dashboardReadback.includes("li.independentSellN !== 5"), false);
});
