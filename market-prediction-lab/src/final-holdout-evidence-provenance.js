import { createHash } from "node:crypto";

export const FINAL_HOLDOUT_PROVENANCE_SCHEMA_VERSION = 2;

const RESEARCH_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value, label) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return JSON.parse(value);
}

function validResearchCodeSha(value) {
  return typeof value === "string" && RESEARCH_SHA_PATTERN.test(value);
}

function validDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function safetyContractMatches(report, provenance) {
  return report?.finalHoldoutRetuningAllowed === false
    && report?.liveOrderAllowed === false
    && report?.privateAccountRequestAllowed === false
    && provenance?.finalHoldoutRetuningAllowed === false
    && provenance?.selectionAllowed === false
    && provenance?.liveOrderAllowed === false
    && provenance?.privateAccountRequestAllowed === false;
}

export function buildFinalHoldoutEvidenceProvenance({
  researchCodeSha,
  resultJson,
  resultMarkdown,
} = {}) {
  if (!validResearchCodeSha(researchCodeSha)) throw new Error("researchCodeSha must be an exact 40-character lowercase commit SHA");
  if (typeof resultJson !== "string" || resultJson.length === 0) throw new Error("resultJson is required");
  if (typeof resultMarkdown !== "string" || resultMarkdown.length === 0) throw new Error("resultMarkdown is required");

  const report = parseJson(resultJson, "resultJson");
  if (!validDigest(report.candidateManifestSha256)) throw new Error("result candidateManifestSha256 is required");
  if (report.finalHoldoutRetuningAllowed !== false || report.liveOrderAllowed !== false || report.privateAccountRequestAllowed !== false) {
    throw new Error("final holdout result safety contract is invalid");
  }

  return Object.freeze({
    schemaVersion: FINAL_HOLDOUT_PROVENANCE_SCHEMA_VERSION,
    researchCodeSha,
    candidateManifestSha256: report.candidateManifestSha256,
    generatedResultAt: report.generatedAt ?? null,
    resultJsonSha256: sha256(resultJson),
    resultMarkdownSha256: sha256(resultMarkdown),
    finalHoldoutRetuningAllowed: false,
    selectionAllowed: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  });
}

export function assessFinalHoldoutEvidenceProvenance({
  expectedResearchCodeSha,
  resultJson,
  resultMarkdown,
  provenanceJson,
} = {}) {
  if (!validResearchCodeSha(expectedResearchCodeSha)) throw new Error("expectedResearchCodeSha must be an exact 40-character lowercase commit SHA");
  if (typeof resultJson !== "string" || resultJson.length === 0 || typeof resultMarkdown !== "string" || resultMarkdown.length === 0) {
    return Object.freeze({ status: "MISSING_RESULT", currentIdentity: false });
  }
  if (typeof provenanceJson !== "string" || provenanceJson.length === 0) {
    return Object.freeze({ status: "MISSING_PROVENANCE", currentIdentity: false });
  }

  let report;
  let provenance;
  try {
    report = parseJson(resultJson, "resultJson");
    provenance = parseJson(provenanceJson, "provenanceJson");
  } catch {
    return Object.freeze({ status: "MALFORMED_EVIDENCE", currentIdentity: false });
  }

  if (provenance.schemaVersion !== FINAL_HOLDOUT_PROVENANCE_SCHEMA_VERSION) {
    return Object.freeze({ status: "UNSUPPORTED_PROVENANCE_SCHEMA", currentIdentity: false });
  }
  if (!validResearchCodeSha(provenance.researchCodeSha) || provenance.researchCodeSha !== expectedResearchCodeSha) {
    return Object.freeze({
      status: "STALE_RESEARCH_SHA",
      currentIdentity: false,
      evidenceResearchCodeSha: validResearchCodeSha(provenance.researchCodeSha) ? provenance.researchCodeSha : null,
    });
  }
  if (!validDigest(report.candidateManifestSha256)
      || !validDigest(provenance.candidateManifestSha256)
      || provenance.candidateManifestSha256 !== report.candidateManifestSha256) {
    return Object.freeze({ status: "IDENTITY_MISMATCH", currentIdentity: false });
  }
  if (!validDigest(provenance.resultJsonSha256)
      || !validDigest(provenance.resultMarkdownSha256)
      || provenance.resultJsonSha256 !== sha256(resultJson)
      || provenance.resultMarkdownSha256 !== sha256(resultMarkdown)) {
    return Object.freeze({ status: "DIGEST_MISMATCH", currentIdentity: false });
  }
  if (provenance.generatedResultAt !== (report.generatedAt ?? null)) {
    return Object.freeze({ status: "GENERATED_AT_MISMATCH", currentIdentity: false });
  }
  if (!safetyContractMatches(report, provenance)) {
    return Object.freeze({ status: "SAFETY_CONTRACT_MISMATCH", currentIdentity: false });
  }

  return Object.freeze({
    status: "CURRENT_IDENTITY_VALID",
    currentIdentity: true,
    researchCodeSha: provenance.researchCodeSha,
    candidateManifestSha256: provenance.candidateManifestSha256,
  });
}
