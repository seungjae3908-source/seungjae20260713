import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import { resolveCanonicalStrategyIdentity } from "../src/canonical-strategy-identity-v1.js";
import { buildStrategyEvidenceEnvelope } from "../src/strategy-evidence-envelope-v1.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function identity(overrides = {}) {
  return {
    strategyId: "candidate-a", strategyFamily: "regime", strategyVersion: "v1", market: "US_STOCK",
    direction: "BUY", timeframe: "1D", formulaIdentity: "formula-v1", parameterHash: HASH_A,
    researchCodeSha: "1".repeat(40), datasetId: "dataset-v1", datasetDigest: HASH_B,
    datasetStart: "2020-01-01T00:00:00.000Z", datasetEnd: "2025-01-01T00:00:00.000Z",
    costPolicyVersion: "cost-v1", riskPolicyVersion: "risk-v1",
    evidenceSchemaVersion: "strategy-evidence-envelope-v1", ...overrides,
  };
}

function envelope(overrides = {}) {
  const strategyIdentity = overrides.strategyIdentity ?? identity();
  const resolved = resolveCanonicalStrategyIdentity(strategyIdentity);
  const artifactPayload = overrides.artifactPayload ?? { rows: [1, 2, 3] };
  return buildStrategyEvidenceEnvelope({
    strategyIdentity,
    strategyIdentityDigest: overrides.strategyIdentityDigest ?? resolved.strategyIdentityDigest,
    evidenceType: "CANONICAL_ENGINE_RESULT",
    evidenceStage: "SHADOW",
    source: "canonical-owner",
    sourceSha: "2".repeat(40),
    artifactId: "artifact-1",
    artifactDigest: overrides.artifactDigest ?? sha256Canonical(artifactPayload),
    artifactPayload,
    measuredAt: "2026-08-25T00:00:00.000Z",
    datasetIdentity: { datasetId: strategyIdentity.datasetId, datasetDigest: strategyIdentity.datasetDigest, datasetStart: strategyIdentity.datasetStart, datasetEnd: strategyIdentity.datasetEnd },
    sample: { sampleN: 0, tradeN: 0, settledN: 0 },
    metrics: { netReturn: 0, profitFactor: 0, expectancy: 0, mdd: 0 },
    validation: { datasetIntegrity: true, noFutureLeakage: true, noSameBarLeakage: true },
    ...overrides,
  });
}

test("missing metrics remain null and zero outcome samples never become zero profitability", () => {
  const result = envelope();
  assert.equal(result.status, "LINKED");
  assert.equal(result.envelope.metrics.expectancy, null);
  assert.equal(result.envelope.metrics.profitFactor, null);
  assert.equal(result.envelope.metrics.mdd, null);
  assert.equal(result.envelope.metrics.sharpe, null);
  assert.ok(result.missingEvidence.includes("ZERO_OUTCOME_SAMPLE_PROFITABILITY_METRICS_NA"));
});

test("mismatched identity, dataset, evidence schema and artifact remain unlinked", () => {
  const digestMismatch = envelope({ strategyIdentityDigest: HASH_A });
  assert.equal(digestMismatch.status, "IDENTITY_MISMATCH");
  const datasetMismatch = envelope({ datasetIdentity: { datasetId: "other", datasetDigest: HASH_B, datasetStart: identity().datasetStart, datasetEnd: identity().datasetEnd } });
  assert.equal(datasetMismatch.status, "IDENTITY_MISMATCH");
  const schemaMismatch = envelope({ strategyIdentity: identity({ evidenceSchemaVersion: "other-envelope-v9" }) });
  assert.equal(schemaMismatch.status, "IDENTITY_MISMATCH");
  assert.ok(schemaMismatch.blockers.includes("EVIDENCE_SCHEMA_IDENTITY_MISMATCH"));
  const artifactMismatch = envelope({ artifactDigest: HASH_A });
  assert.equal(artifactMismatch.status, "UNLINKED_EVIDENCE");
  assert.ok(artifactMismatch.blockers.includes("ARTIFACT_DIGEST_MISMATCH"));
});

test("fake self-attestation cannot raise evidence authority at top level, verdict or validation", () => {
  const result = envelope({
    validated: true,
    profitabilityProven: true,
    verdict: { champion: true, executionAuthority: "LIVE" },
    validation: { datasetIntegrity: true, validatedChampion: true, executionAuthority: "LIVE" },
  });
  assert.equal(result.status, "UNLINKED_EVIDENCE");
  assert.equal(result.executionAuthority, "NONE");
  assert.ok(result.blockers.includes("SELF_ATTESTATION_FORBIDDEN:validated"));
  assert.ok(result.blockers.includes("SELF_ATTESTATION_FORBIDDEN:verdict.champion"));
  assert.ok(result.blockers.includes("EXECUTION_AUTHORITY_FORBIDDEN:verdict.executionAuthority"));
  assert.ok(result.blockers.includes("SELF_ATTESTATION_FORBIDDEN:validation.validatedChampion"));
  assert.ok(result.blockers.includes("EXECUTION_AUTHORITY_FORBIDDEN:validation.executionAuthority"));
});
