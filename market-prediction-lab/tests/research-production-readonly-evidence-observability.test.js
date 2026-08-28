import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO_ROOT, "ops/research-production-readonly-evidence.sh");
const WORKFLOW = join(REPO_ROOT, ".github/workflows/research-production-natural-cycle-evidence.yml");

function inlineNodeScript(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `inline script marker missing: ${marker}`);
  const prefix = "node -e '";
  const start = source.indexOf(prefix, markerIndex);
  assert.notEqual(start, -1, `inline node start missing after: ${marker}`);
  const bodyStart = start + prefix.length;
  const bodyEnd = source.indexOf("\n  '", bodyStart);
  assert.notEqual(bodyEnd, -1, `inline node end missing after: ${marker}`);
  return source.slice(bodyStart, bodyEnd);
}

function runInline(script, { input, args = [] } = {}) {
  const result = spawnSync(process.execPath, ["-e", script, ...args], {
    encoding: "utf8",
    input: input ?? "",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function workflowClassifier(source) {
  const marker = "node --input-type=module <<'NODE'";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "Natural evidence workflow classifier start missing");
  const bodyStart = start + marker.length;
  const bodyEnd = source.indexOf("\n          NODE", bodyStart);
  assert.notEqual(bodyEnd, -1, "Natural evidence workflow classifier end missing");
  return source.slice(bodyStart, bodyEnd);
}

function outputFields(text) {
  return Object.fromEntries(text.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

test("Research Production read-only evidence exposes actionable Paper blocker and freshness counters", async () => {
  const source = await readFile(SCRIPT, "utf8");
  for (const token of [
    "lane_blockers=",
    "lane_data_as_of=",
    "lane_last_success=",
    "lane_last_failure=",
    "duplicate_replay_count=",
    "runtime_settlement_count=",
    "runtime_outcome_count=",
    "sample_count=",
    "oldest_pending_age_ms=",
  ]) {
    assert.ok(source.includes(token), `missing read-only evidence field: ${token}`);
  }

  assert.ok(source.includes("x.blocker"), "Paper lane blocker must come from persisted runtime evidence");
  assert.ok(source.includes("x.dataAsOfMs"), "Paper lane freshness must expose persisted dataAsOfMs");
  assert.ok(source.includes("x.lastSuccessAtMs"), "Paper lane freshness must expose lastSuccessAtMs");
  assert.ok(source.includes("x.lastFailureAtMs"), "Paper lane freshness must expose lastFailureAtMs");
  assert.ok(source.includes("row?.entryTimestampMs"), "oldest pending age must derive from immutable position entry time");

  for (const safety of [
    "server_files_written=0",
    "server_files_deleted=0",
    "server_processes_restarted=0",
    "deployment_executed=0",
    "database_changes=0",
    "live_trading=false",
    "private_api=false",
    "order_authority=false",
    "real_order_count=0",
  ]) {
    assert.ok(source.includes(safety), `read-only safety contract regressed: ${safety}`);
  }
});

test("Research Production read-only evidence follows canonical nested Shadow candidate metrics", async () => {
  const source = await readFile(SCRIPT, "utf8");
  for (const token of [
    "value.candidate",
    "candidate.predictionHealth",
    "candidate.macroF1",
    "candidate.balancedAccuracy",
    "candidate.perClass",
    "candidate.confusion",
    "candidate.confusionMatrix",
    "per_class=",
    "confusion=",
    "prediction_health=",
  ]) {
    assert.ok(source.includes(token), `missing nested Shadow candidate evidence field: ${token}`);
  }

  assert.ok(
    source.indexOf("candidate.macroF1") < source.indexOf("value.macroF1"),
    "canonical nested candidate metric must take precedence over legacy top-level fallback",
  );
  assert.ok(
    source.indexOf("candidate.predictionHealth") < source.indexOf("value.predictionHealth"),
    "canonical nested candidate health must take precedence over legacy top-level fallback",
  );
});

test("Research Production read-only evidence exports the latest identity-bound Natural Paper funnel", async () => {
  const source = await readFile(SCRIPT, "utf8");
  for (const token of [
    "PAPER_NATURAL present=false blocker=PAPER_FORWARD_STDOUT_PATH_UNAVAILABLE",
    "PAPER_FORWARD_STDOUT_MISSING",
    "PAPER_FORWARD_CLI_V5_RESULT_UNAVAILABLE",
    "PAPER_FORWARD_CLI_V5_PAYLOAD_TOO_LARGE",
    "paper-forward-schedule-cli-v5",
    "naturalScheduleInvocation",
    "naturalStrategySha",
    "naturalRuntimeSha",
    "naturalDatasetIdentity",
    "naturalFunnelMeasurements",
    "authoritativeFirstZeroReasonEvidenceByStage",
    "PAPER_NATURAL_STAGE",
    "PAPER_NATURAL_REASON",
    "payload_base64=",
  ]) {
    assert.ok(source.includes(token), `missing Natural Paper read-only evidence field: ${token}`);
  }

  assert.ok(source.includes('join(stateRoot, "runs")'), "Paper stdout must remain confined to the Research state runs root");
  assert.ok(source.includes('paper-forward${sep}stdout.log'), "only the canonical paper-forward task stdout may be read");
  assert.ok(source.includes('externalFinancialMutationAllowed: value.externalFinancialMutationAllowed'), "runtime mutation authority must be copied without a missing-is-safe default");
  assert.ok(source.includes('liveTrading: value.liveTrading'), "live-trading authority must be copied without a missing-is-safe default");
  assert.ok(source.includes('orderAuthority: value.orderAuthority'), "order authority must be copied without a missing-is-safe default");
});

test("Paper stdout resolver accepts only the canonical task path inside the state runs root", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const resolver = inlineNodeScript(source, 'paper_stdout_path="$(read_file');
  const stateRoot = resolve("fixture-research-state");
  const canonical = join(stateRoot, "runs", "cycle-1", "paper-forward", "stdout.log");
  const cycle = (stdoutPath) => JSON.stringify({ results: [{ id: "paper-forward", stdoutPath }] });

  assert.equal(runInline(resolver, { input: cycle(canonical), args: [stateRoot] }), canonical);
  assert.equal(runInline(resolver, { input: cycle(resolve("outside", "paper-forward", "stdout.log")), args: [stateRoot] }), "");
  assert.equal(runInline(resolver, { input: cycle(join(stateRoot, "runs", "cycle-1", "shadow-forward", "stdout.log")), args: [stateRoot] }), "");
});

test("Paper CLI v5 extractor emits a bounded payload and all twelve stage observations", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const extractor = inlineNodeScript(source, 'read_file "$paper_stdout_path" | node -e');
  const sha = "8b337eb22cf943a71e56158de4ae5fa5893aaa09";
  const stages = [
    "UNIVERSE", "SCANNER_EVALUATED", "CANDIDATE", "EVIDENCE_COMPLETE",
    "ADMISSION_PASS", "RISK_PASS", "COST_PASS", "ACCOUNT_READY",
    "PAPER_ENTRY", "POSITION", "SETTLEMENT", "OUTCOME",
  ].map((stage, index) => ({ stage, status: "MEASURED", count: index < 8 ? 12 - index : 0 }));
  const runtime = {
    schemaVersion: "paper-forward-schedule-cli-v5",
    status: "BLOCKED_DATA",
    cycleId: "paper-cycle-1",
    naturalScheduleInvocation: true,
    naturalStrategySha: sha,
    naturalRuntimeSha: sha,
    naturalDatasetIdentity: "dataset-v1",
    naturalFunnelMeasurements: stages,
    authoritativeFirstZeroReasonEvidenceByStage: {
      PAPER_ENTRY: { reasonCode: "NO_ENTRY", authoritative: true, freshness: "FRESH" },
    },
    externalFinancialMutationAllowed: false,
    privateRequestCount: 0,
    financialMutationCount: 0,
    orderCount: 0,
    liveTrading: false,
    orderAuthority: false,
    suppliedSecret: "must-not-leak",
  };
  const output = runInline(extractor, { input: `noise\n${JSON.stringify(runtime)}\n` }).split(/\r?\n/);
  const natural = output.find((line) => line.startsWith("PAPER_NATURAL "));
  const payloadField = natural.split(/\s+/).find((field) => field.startsWith("payload_base64="));
  const payload = JSON.parse(Buffer.from(payloadField.slice("payload_base64=".length), "base64url").toString("utf8"));

  assert.equal(output.filter((line) => line.startsWith("PAPER_NATURAL_STAGE ")).length, 12);
  assert.equal(output.filter((line) => line.startsWith("PAPER_NATURAL_REASON ")).length, 1);
  assert.deepEqual(payload.naturalFunnelMeasurements.map(({ stage, status, count }) => ({ stage, status, count })), stages);
  assert.equal(payload.naturalDatasetIdentity, "dataset-v1");
  assert.equal(payload.externalFinancialMutationAllowed, false);
  assert.equal(payload.liveTrading, false);
  assert.equal(payload.orderAuthority, false);
  assert.equal(Object.hasOwn(payload, "suppliedSecret"), false);

  const unavailable = runInline(extractor, { input: '{"schemaVersion":"legacy"}\n' });
  assert.equal(unavailable, "PAPER_NATURAL present=false blocker=PAPER_FORWARD_CLI_V5_RESULT_UNAVAILABLE");

  const manyIds = Array.from({ length: 10 }, (_, index) => `${index}-${"x".repeat(126)}`);
  const oversized = {
    ...runtime,
    naturalFunnelMeasurements: stages.map((stage) => ({ ...stage, observationIds: manyIds })),
    authoritativeFirstZeroReasonEvidenceByStage: Object.fromEntries(stages.map(({ stage }) => [stage, {
      reasonCode: "NOT_APPLICABLE",
      authoritative: true,
      freshness: "FRESH",
      observationIds: manyIds,
    }])),
  };
  assert.equal(
    runInline(extractor, { input: `${JSON.stringify(oversized)}\n` }),
    "PAPER_NATURAL present=false blocker=PAPER_FORWARD_CLI_V5_PAYLOAD_TOO_LARGE",
  );
});

test("workflow recomputes FIRST_ZERO from the extracted v5 counts and exact release identity", async () => {
  const source = await readFile(WORKFLOW, "utf8");
  const classifier = workflowClassifier(source);
  const sha = "8b337eb22cf943a71e56158de4ae5fa5893aaa09";
  const stages = [
    "UNIVERSE", "SCANNER_EVALUATED", "CANDIDATE", "EVIDENCE_COMPLETE",
    "ADMISSION_PASS", "RISK_PASS", "COST_PASS", "ACCOUNT_READY",
    "PAPER_ENTRY", "POSITION", "SETTLEMENT", "OUTCOME",
  ].map((stage, index) => ({ stage, status: "MEASURED", count: index < 8 ? 12 - index : 0 }));
  const payload = Buffer.from(JSON.stringify({
    schemaVersion: "paper-forward-schedule-cli-v5",
    status: "BLOCKED_DATA",
    cycleId: "paper-cycle-1",
    naturalScheduleInvocation: true,
    naturalStrategySha: sha,
    naturalRuntimeSha: sha,
    naturalDatasetIdentity: "dataset-v1",
    naturalFunnelMeasurements: stages,
    authoritativeFirstZeroReasonEvidenceByStage: {
      PAPER_ENTRY: { reasonCode: "NO_ENTRY", authoritative: true, freshness: "FRESH" },
    },
    externalFinancialMutationAllowed: false,
    privateRequestCount: 0,
    financialMutationCount: 0,
    orderCount: 0,
    liveTrading: false,
    orderAuthority: false,
  }), "utf8").toString("base64url");
  const evidence = [
    "TIMER profile=forward enabled=enabled active=active last_trigger=2026-08-27T00:00:00Z",
    "TIMER profile=fast-historical enabled=enabled active=active last_trigger=2026-08-27T00:00:00Z",
    "TIMER profile=long-history enabled=enabled active=active last_trigger=2026-08-27T00:00:00Z",
    `CYCLE profile=forward present=true research_sha=${sha} failed_count=0`,
    `CYCLE profile=fast-historical present=true research_sha=${sha} failed_count=0`,
    `CYCLE profile=long-history present=true research_sha=${sha} failed_count=0`,
    "TASK profile=forward id=shadow-forward status=success",
    "TASK profile=forward id=paper-forward status=blocked_data",
    "PAPER_RUNTIME present=true live_trading=false order_authority=false private_request_count=0 financial_mutation_count=0 order_count=0",
    "PAPER_LEDGER present=true position_count=0 settlement_count=0",
    `PAPER_NATURAL present=true dataset_identity_sha256=${"a".repeat(64)} payload_base64=${payload}`,
  ].join("\n");
  const directory = await mkdtemp(join(tmpdir(), "natural-evidence-workflow-"));
  const evidencePath = join(directory, "evidence.txt");
  const outputPath = join(directory, "github-output.txt");
  try {
    await writeFile(evidencePath, `${evidence}\n`);
    await writeFile(outputPath, "");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", classifier], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, EVIDENCE_FILE: evidencePath, GITHUB_OUTPUT: outputPath, RESEARCH_SHA: sha },
    });
    assert.equal(result.status, 0, result.stderr);
    const fields = outputFields(await readFile(outputPath, "utf8"));
    assert.equal(fields.status, "passed");
    assert.equal(fields.natural_trace_status, "BLOCKED");
    assert.equal(fields.natural_trace_error, "none");
    assert.equal(fields.natural_identity_complete, "true");
    assert.equal(fields.natural_measurement_source, "NATURAL_FUNNEL");
    assert.equal(fields.natural_first_zero_stage, "PAPER_ENTRY");
    assert.equal(fields.natural_first_zero_reason, "NO_ENTRY");
    assert.equal(fields.natural_first_zero_reason_evidence_status, "ACCEPTED");
    const stageTrace = JSON.parse(Buffer.from(fields.natural_stage_trace_base64, "base64url").toString("utf8"));
    assert.equal(stageTrace.length, 12);
    assert.deepEqual(stageTrace.find((row) => row.stage === "PAPER_ENTRY"), {
      stage: "PAPER_ENTRY", count: 0, status: "ZERO",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
