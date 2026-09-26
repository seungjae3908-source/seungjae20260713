import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function withReadiness(readiness, callback) {
  const root = await mkdtemp(join(tmpdir(), "paper-seven-blocker-"));
  const path = join(root, "readiness.json");
  try {
    await writeFile(path, JSON.stringify(readiness), "utf8");
    return callback(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("CLI requires explicit freshness value when the freshness blocker is present", async () => {
  await withReadiness({
    blockers: ["PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED"],
    readyForActivationReview: false,
  }, (path) => {
    const result = spawnSync(process.execPath, [
      "ops/plan-paper-canonical-seven-blocker-repair.mjs",
      `--readiness=${path}`,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PAPER_CANONICAL_REPAIR_EXPLICIT_MAXIMUM_AGE_REQUIRED/);
  });
});

test("CLI emits a zero-authority plan when an explicit freshness value is supplied", async () => {
  await withReadiness({
    blockers: [
      "PAPER_CANONICAL_PAPER_STATE_BINDING_NOT_READY",
      "PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED",
    ],
    readyForActivationReview: false,
    evidenceCounts: {
      naturalPositions: 0,
      naturalSettlements: 0,
      fullCostReadyPositions: 0,
      durableSettlementPackets: 0,
      canonicalRebinds: 0,
    },
  }, (path) => {
    const result = spawnSync(process.execPath, [
      "ops/plan-paper-canonical-seven-blocker-repair.mjs",
      `--readiness=${path}`,
      "--maximum-age-ms=3600000",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.status, "REPAIR_REQUIRED");
    assert.equal(value.maximumAgeMs, 3600000);
    assert.equal(value.operationalMutationApplied, false);
    assert.equal(value.safety.executionAuthority, "NONE");
    assert.equal(value.safety.profitabilityCredit, 0);
  });
});
