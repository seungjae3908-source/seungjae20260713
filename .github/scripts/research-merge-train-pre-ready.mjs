import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TARGET_MIN = 1146;
export const DEFAULT_TARGET_MAX = 1170;
const SHA_RE = /^[0-9a-f]{40}$/iu;
const TRACKED_WORKFLOWS = Object.freeze([
  "Application Fast CI",
  "Research Production Branch Validation",
  "Research Dashboard Validation",
  "Prediction Lab PR Head Unit",
  "Prediction Lab Multi-Market Suite",
  "Prediction Lab Long History V1",
]);

function asInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) throw new Error("[" + label + "] integer required");
  return parsed;
}

function normalizePr(pr) {
  return {
    number: Number(pr.number),
    title: String(pr.title || ""),
    draft: Boolean(pr.draft),
    state: String(pr.state || ""),
    headRef: String(pr.head?.ref || pr.head_ref || ""),
    headSha: String(pr.head?.sha || pr.head_sha || "").toLowerCase(),
    baseRef: String(pr.base?.ref || pr.base_ref || ""),
    baseSha: String(pr.base?.sha || pr.base_sha || "").toLowerCase(),
    mergeable: pr.mergeable ?? null,
    mergeableState: String(pr.mergeable_state || ""),
  };
}

export function selectTargetPullRequests(pulls, { min = DEFAULT_TARGET_MIN, max = DEFAULT_TARGET_MAX } = {}) {
  return pulls
    .map(normalizePr)
    .filter((pr) => pr.state === "open" && pr.number >= min && pr.number <= max)
    .sort((a, b) => a.number - b.number);
}

export function attachTargetParents(pulls) {
  const byHead = new Map(pulls.map((pr) => [pr.headRef, pr.number]));
  return pulls.map((pr) => ({
    ...pr,
    parentPr: byHead.get(pr.baseRef) ?? null,
  }));
}

export function classifyChangedPaths(files) {
  const normalized = [...new Set((files || []).map((file) => String(file).replaceAll("\\", "/")).filter(Boolean))].sort();
  return Object.freeze({
    files: normalized,
    researchProduction: normalized.some((file) => file.startsWith("research-production/")),
    researchDashboard: normalized.some((file) => file.startsWith("research-dashboard/")),
    predictionLab: normalized.some((file) => file.startsWith("market-prediction-lab/")),
    ciContracts: normalized.some((file) => file.startsWith(".github/")),
  });
}

export function classifyPreReady({
  staleMatrix = false,
  draft = true,
  parentPr = null,
  behindMain = 0,
  unresolved = 0,
  mergeable = true,
}) {
  if (staleMatrix) return "STALE_MATRIX";
  if (!draft) return "READY_ALREADY";
  if (parentPr) return "BLOCKED_BY_PARENT";
  if (behindMain > 0) return "NEEDS_REALIGN";
  if (unresolved > 0) return "BLOCKED_REVIEW";
  if (mergeable === false) return "CONFLICT_OR_UNMERGEABLE";
  return "READY_CANDIDATE_PRECHECK";
}

export function finalizePreReady(report, outcomes = {}) {
  const plan = report.validationPlan || {};
  const pairs = [
    ["staticAuditors", outcomes.staticAuditors],
    ["researchProduction", outcomes.researchProduction],
    ["researchDashboard", outcomes.researchDashboard],
    ["predictionLab", outcomes.predictionLab],
    ["ciContracts", outcomes.ciContracts],
  ];
  const executed = pairs
    .filter(([name]) => plan[name])
    .map(([name, outcome]) => ({ name, outcome: String(outcome || "missing") }));
  const failed = executed.filter((item) => item.outcome !== "success");
  let finalState = report.preReadyState;
  if (failed.length > 0) finalState = "PRE_READY_FAILED";
  else if (finalState === "READY_CANDIDATE_PRECHECK") finalState = "READY_CANDIDATE";

  return {
    ...report,
    schemaVersion: "research-merge-train-pr-v1",
    finalState,
    localValidation: {
      status: failed.length === 0 ? "PASS" : "FAIL",
      executed,
      failed: failed.map((item) => item.name),
    },
  };
}

function parseRepository(repository) {
  const [owner, name, ...rest] = String(repository || "").split("/");
  if (!owner || !name || rest.length) throw new Error("[INVALID_REPOSITORY] expected owner/name");
  return { owner, name };
}

function requireToken() {
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("[MISSING_GITHUB_TOKEN]");
  return token;
}

async function githubJson(urlPath, token, init = {}) {
  const response = await fetch("https://api.github.com" + urlPath, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error("[GITHUB_READ_FAILED] " + response.status + " " + urlPath + " " + body.slice(0, 400));
  }
  return response.json();
}

async function listOpenPulls(repository, token) {
  const { owner, name } = parseRepository(repository);
  const items = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubJson(
      "/repos/" + owner + "/" + name + "/pulls?state=open&per_page=100&page=" + page,
      token,
    );
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function listPullFiles(repository, prNumber, token) {
  const { owner, name } = parseRepository(repository);
  const files = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubJson(
      "/repos/" + owner + "/" + name + "/pulls/" + prNumber + "/files?per_page=100&page=" + page,
      token,
    );
    files.push(...batch.map((item) => item.filename));
    if (batch.length < 100) break;
  }
  return files;
}

async function unresolvedReviewThreads(repository, prNumber, token) {
  const { owner, name } = parseRepository(repository);
  let cursor = null;
  let unresolved = 0;
  do {
    const query = [
      "query($owner:String!,$name:String!,$number:Int!,$after:String){",
      "repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){",
      "nodes{isResolved} pageInfo{hasNextPage endCursor}",
      "}}}}",
    ].join("");
    const payload = await githubJson("/graphql", token, {
      method: "POST",
      body: JSON.stringify({ query, variables: { owner, name, number: prNumber, after: cursor } }),
      headers: { "Content-Type": "application/json" },
    });
    if (payload.errors?.length) throw new Error("[GRAPHQL_READ_FAILED] " + JSON.stringify(payload.errors).slice(0, 500));
    const threads = payload.data?.repository?.pullRequest?.reviewThreads;
    for (const node of threads?.nodes || []) if (!node.isResolved) unresolved += 1;
    cursor = threads?.pageInfo?.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (cursor);
  return unresolved;
}

function latestWorkflowRuns(runs) {
  const out = {};
  for (const name of TRACKED_WORKFLOWS) {
    const hit = (runs || []).find((run) => run.name === name);
    out[name] = hit ? {
      id: hit.id,
      status: hit.status,
      conclusion: hit.conclusion,
      event: hit.event,
      headSha: hit.head_sha,
    } : null;
  }
  return out;
}

function markdownEscape(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderPrMarkdown(report) {
  const ci = report.existingCi || {};
  const fast = ci["Application Fast CI"];
  const parent = report.parentPr ? "#" + report.parentPr : "-";
  return [
    "## Research Merge Train Pre-Ready Audit",
    "",
    "| Field | Value |",
    "|---|---|",
    "| PR | #" + report.number + " |",
    "| HEAD | \`" + report.headSha + "\` |",
    "| Current main | \`" + report.currentMainSha + "\` |",
    "| Parent | " + parent + " |",
    "| Behind main | " + report.behindMain + " |",
    "| Ahead of main | " + report.aheadMain + " |",
    "| Unresolved | " + report.unresolved + " |",
    "| Mergeable | " + String(report.mergeable) + " |",
    "| Pre-Ready state | **" + report.preReadyState + "** |",
    "| Existing Fast CI | " + (fast ? String(fast.conclusion || fast.status) : "MISSING") + " |",
    "",
    "This lane is diagnostic only. It grants no Ready, Merge, deploy, activation, schedule, database, secret, live-trading, private-API, or real-order authority.",
    "",
  ].join("\n");
}

async function writeJsonAndMarkdown(report, jsonOutput, markdownOutput) {
  if (jsonOutput) {
    await mkdir(path.dirname(jsonOutput), { recursive: true });
    await writeFile(jsonOutput, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  if (markdownOutput) {
    await mkdir(path.dirname(markdownOutput), { recursive: true });
    await writeFile(markdownOutput, renderPrMarkdown(report), "utf8");
  }
}

async function discover(options) {
  const token = requireToken();
  const pulls = attachTargetParents(selectTargetPullRequests(
    await listOpenPulls(options.repository, token),
    { min: options.min, max: options.max },
  ));
  const include = pulls.map((pr) => ({
    pr: pr.number,
    head_sha: pr.headSha,
    head_ref: pr.headRef,
    base_ref: pr.baseRef,
    parent_pr: pr.parentPr,
  }));
  const report = {
    schemaVersion: "research-merge-train-discovery-v1",
    repository: options.repository,
    targetMin: options.min,
    targetMax: options.max,
    count: include.length,
    matrix: { include },
  };
  if (options.jsonOutput) await writeFile(options.jsonOutput, JSON.stringify(report, null, 2) + "\n", "utf8");
  if (options.githubOutput) {
    await appendFile(options.githubOutput, "count=" + include.length + "\n", "utf8");
    await appendFile(options.githubOutput, "matrix=" + JSON.stringify({ include }) + "\n", "utf8");
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

async function audit(options) {
  const token = requireToken();
  const { owner, name } = parseRepository(options.repository);
  const [rawPr, mainBranch, files, unresolved, runs] = await Promise.all([
    githubJson("/repos/" + owner + "/" + name + "/pulls/" + options.pr, token),
    githubJson("/repos/" + owner + "/" + name + "/branches/main", token),
    listPullFiles(options.repository, options.pr, token),
    unresolvedReviewThreads(options.repository, options.pr, token),
    githubJson("/repos/" + owner + "/" + name + "/actions/runs?head_sha=" + options.headSha + "&per_page=100", token),
  ]);
  const pr = normalizePr(rawPr);
  const currentMainSha = String(mainBranch.commit?.sha || "").toLowerCase();
  if (!SHA_RE.test(currentMainSha)) throw new Error("[INVALID_MAIN_SHA]");
  const staleMatrix = pr.headSha !== options.headSha;
  const compare = await githubJson(
    "/repos/" + owner + "/" + name + "/compare/" + currentMainSha + "..." + options.headSha,
    token,
  );
  const impact = classifyChangedPaths(files);
  const preReadyState = classifyPreReady({
    staleMatrix,
    draft: pr.draft,
    parentPr: options.parentPr,
    behindMain: Number(compare.behind_by || 0),
    unresolved,
    mergeable: pr.mergeable,
  });
  const report = {
    schemaVersion: "research-merge-train-pr-audit-v1",
    repository: options.repository,
    number: options.pr,
    title: pr.title,
    draft: pr.draft,
    headRef: pr.headRef,
    headSha: options.headSha,
    observedHeadSha: pr.headSha,
    baseRef: pr.baseRef,
    parentPr: options.parentPr,
    currentMainSha,
    staleMatrix,
    aheadMain: Number(compare.ahead_by || 0),
    behindMain: Number(compare.behind_by || 0),
    compareStatus: String(compare.status || ""),
    unresolved,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeableState,
    changedFiles: impact.files,
    existingCi: latestWorkflowRuns(runs.workflow_runs || []),
    validationPlan: {
      staticAuditors: true,
      researchProduction: impact.researchProduction,
      researchDashboard: impact.researchDashboard,
      predictionLab: impact.predictionLab,
      ciContracts: impact.ciContracts,
    },
    preReadyState,
    safety: {
      readyAuthority: false,
      mergeAuthority: false,
      deployAuthority: false,
      activationAuthority: false,
      scheduleMutationAuthority: false,
      databaseMutationAuthority: false,
      secretMutationAuthority: false,
      liveTrading: false,
      privateApi: false,
      realOrderAuthority: false,
    },
  };
  await writeJsonAndMarkdown(report, options.jsonOutput, options.markdownOutput);
  if (options.githubOutput) {
    for (const [name, enabled] of Object.entries(report.validationPlan)) {
      await appendFile(options.githubOutput, name + "=" + (enabled ? "true" : "false") + "\n", "utf8");
    }
    await appendFile(options.githubOutput, "pre_ready_state=" + preReadyState + "\n", "utf8");
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

async function finalize(options) {
  const report = JSON.parse(await readFile(options.input, "utf8"));
  const result = finalizePreReady(report, {
    staticAuditors: process.env.STATIC_AUDIT_OUTCOME,
    researchProduction: process.env.RESEARCH_PRODUCTION_OUTCOME,
    researchDashboard: process.env.RESEARCH_DASHBOARD_OUTCOME,
    predictionLab: process.env.PREDICTION_LAB_OUTCOME,
    ciContracts: process.env.CI_CONTRACTS_OUTCOME,
  });
  await writeJsonAndMarkdown(result, options.jsonOutput, options.markdownOutput);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function walkJson(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walkJson(full));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(full);
  }
  return result;
}

function topologicalOrder(reports) {
  const byNumber = new Map(reports.map((report) => [report.number, report]));
  const indegree = new Map(reports.map((report) => [report.number, 0]));
  const children = new Map(reports.map((report) => [report.number, []]));
  for (const report of reports) {
    if (report.parentPr && byNumber.has(report.parentPr)) {
      indegree.set(report.number, (indegree.get(report.number) || 0) + 1);
      children.get(report.parentPr).push(report.number);
    }
  }
  const queue = [...reports.filter((report) => indegree.get(report.number) === 0).map((report) => report.number)].sort((a, b) => a - b);
  const order = [];
  while (queue.length) {
    const current = queue.shift();
    order.push(current);
    for (const child of (children.get(current) || []).sort((a, b) => a - b)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
    queue.sort((a, b) => a - b);
  }
  return order;
}

async function aggregate(options) {
  const files = await walkJson(options.inputDir);
  const reports = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed.schemaVersion === "research-merge-train-pr-v1") reports.push(parsed);
  }
  reports.sort((a, b) => a.number - b.number);
  const counts = {};
  for (const report of reports) counts[report.finalState] = (counts[report.finalState] || 0) + 1;
  const order = topologicalOrder(reports);
  const matrix = {
    schemaVersion: "research-merge-train-matrix-v1",
    generatedAt: new Date().toISOString(),
    count: reports.length,
    counts,
    dependencyOrder: order,
    reports,
    safety: {
      diagnosticOnly: true,
      requiredCiReplacement: false,
      readyAuthority: false,
      mergeAuthority: false,
      deployAuthority: false,
      activationAuthority: false,
    },
  };
  const lines = [
    "# Research Merge Train / Pre-Ready Drift Matrix",
    "",
    "| PR | Parent | Behind | Unresolved | Mergeable | Local | State |",
    "|---:|---:|---:|---:|---|---|---|",
  ];
  for (const report of reports) {
    lines.push(
      "| #" + report.number +
      " | " + (report.parentPr ? "#" + report.parentPr : "-") +
      " | " + report.behindMain +
      " | " + report.unresolved +
      " | " + markdownEscape(report.mergeable) +
      " | " + markdownEscape(report.localValidation?.status || "UNKNOWN") +
      " | **" + markdownEscape(report.finalState) + "** |",
    );
  }
  lines.push("", "Dependency order: " + order.map((number) => "#" + number).join(" -> "));
  lines.push("", "Diagnostic only: final Required CI 6/6 must still run on the exact latest-main-integrated HEAD immediately before each Merge.");
  lines.push("No Ready/Merge/Deploy/Activation/schedule/DB/Secret/trading authority is granted by this matrix.", "");
  await writeFile(options.jsonOutput, JSON.stringify(matrix, null, 2) + "\n", "utf8");
  await writeFile(options.markdownOutput, lines.join("\n"), "utf8");
  process.stdout.write(JSON.stringify({ count: reports.length, counts, dependencyOrder: order }, null, 2) + "\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error("[INVALID_ARGUMENT] " + arg);
    const key = arg.slice(2).replaceAll("-", "_");
    const value = rest[++i];
    if (value === undefined) throw new Error("[MISSING_ARGUMENT_VALUE] " + arg);
    options[key] = value;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "discover") {
    return discover({
      repository: options.repository,
      min: asInt(options.min || DEFAULT_TARGET_MIN, "INVALID_MIN"),
      max: asInt(options.max || DEFAULT_TARGET_MAX, "INVALID_MAX"),
      githubOutput: options.github_output,
      jsonOutput: options.json_output,
    });
  }
  if (options.command === "audit") {
    const headSha = String(options.head_sha || "").toLowerCase();
    if (!SHA_RE.test(headSha)) throw new Error("[INVALID_HEAD_SHA]");
    return audit({
      repository: options.repository,
      pr: asInt(options.pr, "INVALID_PR"),
      headSha,
      parentPr: options.parent_pr && options.parent_pr !== "null" ? asInt(options.parent_pr, "INVALID_PARENT_PR") : null,
      githubOutput: options.github_output,
      jsonOutput: options.json_output,
      markdownOutput: options.markdown_output,
    });
  }
  if (options.command === "finalize") {
    return finalize({
      input: options.input,
      jsonOutput: options.json_output,
      markdownOutput: options.markdown_output,
    });
  }
  if (options.command === "aggregate") {
    return aggregate({
      inputDir: options.input_dir,
      jsonOutput: options.json_output,
      markdownOutput: options.markdown_output,
    });
  }
  throw new Error("[UNKNOWN_COMMAND] " + String(options.command || ""));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error("[RESEARCH_MERGE_TRAIN_FAILED] " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
