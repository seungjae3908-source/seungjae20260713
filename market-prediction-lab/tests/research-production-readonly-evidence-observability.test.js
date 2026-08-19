import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SCRIPT = resolve(process.cwd(), "../ops/research-production-readonly-evidence.sh");

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
