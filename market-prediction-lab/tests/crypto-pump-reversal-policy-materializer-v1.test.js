import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  materializePumpProspectivePolicyV1,
} from "../scripts/materialize-pump-prospective-policy-v1.mjs";
import {
  verifyPumpProspectivePolicyV1,
} from "../src/crypto-pump-reversal-prospective-policy-v1.js";

const DAY = 24 * 60 * 60 * 1000;
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const FROZEN = Date.parse("2026-10-02T00:00:00.000Z");

test("new materialized Pump policy has exact SHA and >=24h prospective boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pump-policy-"));
  try {
    const output = join(root, "policy.json");
    const result = await materializePumpProspectivePolicyV1({
      researchCodeSha: SHA,
      policyFrozenAtMs: FROZEN,
      outputPath: output,
    });
    assert.equal(result.status, "CREATED");
    assert.equal(result.researchCodeSha, SHA);
    assert.equal(result.policyFrozenAtMs, FROZEN);
    assert.equal(result.eligibleAfterMs, FROZEN + DAY);
    const policy = JSON.parse(await readFile(output, "utf8"));
    assert.equal(verifyPumpProspectivePolicyV1(policy).valid, true);
    assert.equal(policy.candidate.researchCodeSha, SHA);
    assert.equal(policy.bootstrap.rawProspectiveSampleEconomicCredit, 0);
    assert.equal(policy.safety.executionAuthority, "NONE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("re-activation preserves the existing future boundary instead of resetting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pump-policy-"));
  try {
    const output = join(root, "policy.json");
    const first = await materializePumpProspectivePolicyV1({
      researchCodeSha: SHA,
      policyFrozenAtMs: FROZEN,
      outputPath: output,
    });
    const second = await materializePumpProspectivePolicyV1({
      researchCodeSha: SHA,
      policyFrozenAtMs: FROZEN + 6 * 60 * 60 * 1000,
      outputPath: output,
    });
    assert.equal(second.status, "PRESERVED_EXISTING");
    assert.equal(second.policyFrozenAtMs, first.policyFrozenAtMs);
    assert.equal(second.eligibleAfterMs, first.eligibleAfterMs);
    assert.equal(second.policyDigest, first.policyDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing policy from a different research SHA fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pump-policy-"));
  try {
    const output = join(root, "policy.json");
    await materializePumpProspectivePolicyV1({
      researchCodeSha: SHA,
      policyFrozenAtMs: FROZEN,
      outputPath: output,
    });
    await assert.rejects(
      () => materializePumpProspectivePolicyV1({
        researchCodeSha: OTHER,
        policyFrozenAtMs: FROZEN + DAY,
        outputPath: output,
      }),
      /PUMP_POLICY_EXISTING_RESEARCH_SHA_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
