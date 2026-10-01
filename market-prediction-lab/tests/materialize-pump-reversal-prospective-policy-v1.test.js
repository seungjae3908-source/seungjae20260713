import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  materializePumpProspectivePolicyV1,
  PUMP_PROSPECTIVE_MINIMUM_FUTURE_BUFFER_MS,
} from "../scripts/materialize-pump-reversal-prospective-policy-v1.mjs";

const SHA = "a".repeat(40);
const FROZEN = 1_800_000_000_000;

test("materializer freezes exact SHA and a 24h future boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pump-policy-"));
  try {
    const path = join(root, "policy.json");
    const result = await materializePumpProspectivePolicyV1({
      researchCodeSha: SHA,
      policyFrozenAtMs: FROZEN,
      outputPath: path,
    });
    assert.equal(result.status, "CREATED");
    assert.equal(result.policy.candidate.researchCodeSha, SHA);
    assert.equal(result.policy.eligibleAfterMs, FROZEN + PUMP_PROSPECTIVE_MINIMUM_FUTURE_BUFFER_MS);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.policyDigest, result.policy.policyDigest);
    const reused = await materializePumpProspectivePolicyV1({
      researchCodeSha: SHA,
      policyFrozenAtMs: FROZEN,
      outputPath: path,
    });
    assert.equal(reused.status, "REUSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing policy cannot be silently refrozen", async () => {
  const root = await mkdtemp(join(tmpdir(), "pump-policy-"));
  try {
    const path = join(root, "policy.json");
    await materializePumpProspectivePolicyV1({
      researchCodeSha: SHA,
      policyFrozenAtMs: FROZEN,
      outputPath: path,
    });
    await assert.rejects(
      () => materializePumpProspectivePolicyV1({
        researchCodeSha: SHA,
        policyFrozenAtMs: FROZEN + 1,
        outputPath: path,
      }),
      /PUMP_POLICY_EXISTING_IDENTITY_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
