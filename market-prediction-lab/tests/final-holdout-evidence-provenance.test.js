import test from "node:test";
import assert from "node:assert/strict";
import {
  assessFinalHoldoutEvidenceProvenance,
  buildFinalHoldoutEvidenceProvenance,
} from "../src/final-holdout-evidence-provenance.js";

const RESEARCH_SHA = "a".repeat(40);
const NEXT_RESEARCH_SHA = "b".repeat(40);
const MANIFEST_SHA = "c".repeat(64);

function result(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: 123456789,
    mode: "backtest-only",
    evaluation: "one-shot-final-holdout",
    candidateManifestSha256: MANIFEST_SHA,
    finalHoldoutRetuningAllowed: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    results: [],
    ...overrides,
  }, null, 2) + "\n";
}

const markdown = "# immutable final holdout\n";

test("builds immutable provenance and validates only the exact research SHA", () => {
  const resultJson = result();
  const provenance = buildFinalHoldoutEvidenceProvenance({
    researchCodeSha: RESEARCH_SHA,
    resultJson,
    resultMarkdown: markdown,
  });

  assert.equal(provenance.researchCodeSha, RESEARCH_SHA);
  assert.equal(provenance.candidateManifestSha256, MANIFEST_SHA);
  assert.equal(provenance.selectionAllowed, false);
  assert.equal(provenance.liveOrderAllowed, false);

  assert.deepEqual(
    assessFinalHoldoutEvidenceProvenance({
      expectedResearchCodeSha: RESEARCH_SHA,
      resultJson,
      resultMarkdown: markdown,
      provenanceJson: JSON.stringify(provenance),
    }),
    {
      status: "CURRENT_IDENTITY_VALID",
      currentIdentity: true,
      researchCodeSha: RESEARCH_SHA,
      candidateManifestSha256: MANIFEST_SHA,
    },
  );
});

test("fails closed when an immutable result has no provenance", () => {
  const assessment = assessFinalHoldoutEvidenceProvenance({
    expectedResearchCodeSha: RESEARCH_SHA,
    resultJson: result(),
    resultMarkdown: markdown,
    provenanceJson: null,
  });
  assert.deepEqual(assessment, { status: "MISSING_PROVENANCE", currentIdentity: false });
});

test("marks prior-SHA evidence stale instead of relabeling it as current", () => {
  const resultJson = result();
  const provenance = buildFinalHoldoutEvidenceProvenance({
    researchCodeSha: RESEARCH_SHA,
    resultJson,
    resultMarkdown: markdown,
  });
  const assessment = assessFinalHoldoutEvidenceProvenance({
    expectedResearchCodeSha: NEXT_RESEARCH_SHA,
    resultJson,
    resultMarkdown: markdown,
    provenanceJson: JSON.stringify(provenance),
  });
  assert.deepEqual(assessment, {
    status: "STALE_RESEARCH_SHA",
    currentIdentity: false,
    evidenceResearchCodeSha: RESEARCH_SHA,
  });
});

test("detects any result or markdown mutation after provenance is built", () => {
  const resultJson = result();
  const provenanceJson = JSON.stringify(buildFinalHoldoutEvidenceProvenance({
    researchCodeSha: RESEARCH_SHA,
    resultJson,
    resultMarkdown: markdown,
  }));

  assert.equal(assessFinalHoldoutEvidenceProvenance({
    expectedResearchCodeSha: RESEARCH_SHA,
    resultJson: result({ generatedAt: 123456790 }),
    resultMarkdown: markdown,
    provenanceJson,
  }).status, "DIGEST_MISMATCH");

  assert.equal(assessFinalHoldoutEvidenceProvenance({
    expectedResearchCodeSha: RESEARCH_SHA,
    resultJson,
    resultMarkdown: `${markdown}changed\n`,
    provenanceJson,
  }).status, "DIGEST_MISMATCH");
});

test("rejects candidate-manifest identity or safety-contract mismatches", () => {
  const resultJson = result();
  const provenance = buildFinalHoldoutEvidenceProvenance({
    researchCodeSha: RESEARCH_SHA,
    resultJson,
    resultMarkdown: markdown,
  });

  assert.equal(assessFinalHoldoutEvidenceProvenance({
    expectedResearchCodeSha: RESEARCH_SHA,
    resultJson,
    resultMarkdown: markdown,
    provenanceJson: JSON.stringify({ ...provenance, candidateManifestSha256: "d".repeat(64) }),
  }).status, "IDENTITY_MISMATCH");

  const unsafeJson = result({ liveOrderAllowed: true });
  const unsafeProvenance = {
    ...buildFinalHoldoutEvidenceProvenance({
      researchCodeSha: RESEARCH_SHA,
      resultJson,
      resultMarkdown: markdown,
    }),
    resultJsonSha256: provenance.resultJsonSha256,
  };
  assert.equal(assessFinalHoldoutEvidenceProvenance({
    expectedResearchCodeSha: RESEARCH_SHA,
    resultJson: unsafeJson,
    resultMarkdown: markdown,
    provenanceJson: JSON.stringify(unsafeProvenance),
  }).status, "DIGEST_MISMATCH");
});
