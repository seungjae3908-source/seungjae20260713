import fs from "node:fs";
import path from "node:path";

import { sha256Canonical } from "../src/research-cache-provenance.js";
import { buildShadowFeatureDriftDiagnostic } from "../src/shadow-feature-drift-diagnostics.js";
import { BASELINE_MODEL } from "../src/tiny-model.js";

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function requireSha(name) {
  const value = process.env[name];
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) throw new Error(`${name} must be an immutable 40-character SHA`);
  return value;
}
function requireNumericId(name) {
  const value = process.env[name];
  if (!/^\d+$/.test(value ?? "")) throw new Error(`${name} must be a numeric immutable identifier`);
  return value;
}
function requireArtifactDigest(name) {
  const value = process.env[name];
  if (!/^sha256:[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${name} must be a GitHub artifact SHA-256 digest`);
  return value;
}
function format(value, digits = 4) { return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "N/A"; }
function metric(feature, name) { return feature[name] == null ? `N/A — ${feature.driftEvidenceStatus}` : format(feature[name]); }
function classCounts(value = {}) { return `LONG ${value.bullish ?? 0} / NEUTRAL ${value.neutral ?? 0} / SHORT ${value.bearish ?? 0}`; }
function directionalCounts(value = {}) { return `LONG ${value.LONG ?? 0} / NEUTRAL ${value.NEUTRAL ?? 0} / SHORT ${value.SHORT ?? 0}`; }

function summaryStatus(groups) {
  const values = Object.values(groups);
  if (values.every((group) => group.DRIFT_EVIDENCE_VALID)) return "DRIFT_MEASURED_CAUSALITY_UNPROVEN";
  const statuses = values.map((group) => group.driftEvidenceStatus);
  for (const priority of ["IDENTITY_MISMATCH", "REFERENCE_EXPIRED", "MISSING_EVIDENCE", "INSUFFICIENT_EVIDENCE"]) {
    if (statuses.includes(priority)) return priority;
  }
  return "INSUFFICIENT_EVIDENCE";
}

function markdown(output) {
  const lines = [
    "# Shadow Feature Drift Diagnostic",
    "",
    `- Exact diagnostic HEAD SHA: \`${output.source.diagnosticHeadSha}\``,
    `- Canonical model source SHA: \`${output.source.canonicalModelSourceSha}\``,
    `- Shadow source SHA: \`${output.source.shadowResearchCodeSha}\``,
    `- Source Shadow run id: \`${output.source.shadowRunId}\``,
    `- Source artifact id: \`${output.source.shadowArtifactId}\``,
    `- Source artifact digest: \`${output.source.shadowArtifactDigest}\``,
    `- Generated evidence digest: \`${output.evidenceDigest}\``,
    `- Root verdict: **${output.rootCauseVerdict}**`,
    `- DRIFT_EVIDENCE_VALID: **${output.DRIFT_EVIDENCE_VALID}**`,
    `- DRIFT_PROXY_ONLY: **${output.DRIFT_PROXY_ONLY}**`,
    "- Model/threshold/label/frozen blend changes: **none**",
    "",
  ];

  for (const [name, group] of Object.entries(output.groups)) {
    const probabilities = group.diagnostics.probabilities;
    const quality = group.diagnostics.directionalQuality;
    const reference = group.referenceEvidence;
    const identity = reference.identity ?? {};
    lines.push(`## ${name}`, "");
    lines.push(`- Model: \`${group.modelId}\``);
    lines.push(`- Model SHA: \`${group.modelSha}\``);
    lines.push(`- Samples: ${group.diagnostics.count}`);
    lines.push(`- Range: ${new Date(group.diagnostics.firstAnchorTimestamp).toISOString()} → ${new Date(group.diagnostics.lastAnchorTimestamp).toISOString()}`);
    lines.push(`- Provenance status: **${reference.status}** (${reference.reason ?? "exact"})`);
    lines.push(`- strategyIdentityDigest status: **${identity.strategyIdentityDigest ? reference.comparisonStatus : "MISSING_EVIDENCE"}**`);
    lines.push(`- strategyIdentityDigest: ${identity.strategyIdentityDigest ? `\`${identity.strategyIdentityDigest}\`` : "N/A — MISSING_EVIDENCE"}`);
    lines.push(`- Reference receipt status / expiry: **${reference.receiptStatus}** / ${identity.artifactReceipt?.expiresAt ?? "N/A — MISSING_EVIDENCE"}`);
    lines.push(`- Raw TRAIN / VALIDATION samples: ${reference.rawTrainSampleN} / ${reference.rawValidationSampleN}`);
    lines.push(`- DRIFT_EVIDENCE_VALID / DRIFT_PROXY_ONLY: **${group.DRIFT_EVIDENCE_VALID} / ${group.DRIFT_PROXY_ONLY}**`, "");

    lines.push("### Directional quality and confidence", "");
    lines.push(`- Predicted: ${directionalCounts(probabilities.predictedDirectionalDistribution)}`);
    lines.push(`- Actual: ${directionalCounts(probabilities.actualDirectionalDistribution)}`);
    lines.push(`- Macro-F1: ${format(quality.macroF1)}`);
    lines.push(`- Balanced Accuracy: ${format(quality.balancedAccuracy)}`);
    lines.push(`- LONG / NEUTRAL / SHORT recall: ${format(quality.longRecall)} / ${format(quality.neutralRecall)} / ${format(quality.shortRecall)}`);
    lines.push(`- Bear recall: ${format(quality.bearRecall)}`);
    lines.push(`- Top1 / Top2 / margin / entropy mean: ${format(probabilities.top1.mean)} / ${format(probabilities.top2.mean)} / ${format(probabilities.confidenceMargin.mean)} / ${format(probabilities.entropy.mean)}`, "");

    lines.push("### Actual-class conditional", "");
    lines.push("| Actual | N | Predicted | P(LONG) | P(NEUTRAL) | P(SHORT) | Top1 | Top2 | Margin | Entropy |");
    lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const [actual, item] of Object.entries(probabilities.classConditional)) {
      lines.push(`| ${actual.toUpperCase()} | ${item.count} | ${classCounts(item.predictedClassDistribution)} | ${format(item.bullish.mean)} | ${format(item.neutral.mean)} | ${format(item.bearish.mean)} | ${format(item.top1.mean)} | ${format(item.top2.mean)} | ${format(item.confidenceMargin.mean)} | ${format(item.entropy.mean)} |`);
    }
    lines.push("");

    lines.push("### Bull / Bear / Sideways regime", "");
    lines.push("| Regime | N | Predicted | Actual support | LONG recall | NEUTRAL recall | SHORT/Bear recall | Margin | Entropy |");
    lines.push("|---|---:|---|---|---:|---:|---:|---:|---:|");
    for (const [regime, item] of Object.entries(group.diagnostics.byRegime)) {
      lines.push(`| ${regime} | ${item.count} | ${directionalCounts(item.probabilities.predictedDirectionalDistribution)} | ${directionalCounts(item.probabilities.actualDirectionalDistribution)} | ${format(item.directionalQuality.longRecall)} | ${format(item.directionalQuality.neutralRecall)} | ${format(item.directionalQuality.bearRecall)} | ${format(item.probabilities.confidenceMargin.mean)} | ${format(item.probabilities.entropy.mean)} |`);
    }
    lines.push("");

    lines.push("### Symbol split", "");
    lines.push("| Symbol | N | Predicted | Actual | Macro-F1 | Balanced Accuracy | Margin | Entropy |");
    lines.push("|---|---:|---|---|---:|---:|---:|---:|");
    for (const [symbol, item] of Object.entries(group.diagnostics.bySymbol)) {
      lines.push(`| ${symbol} | ${item.count} | ${directionalCounts(item.probabilities.predictedDirectionalDistribution)} | ${directionalCounts(item.probabilities.actualDirectionalDistribution)} | ${format(item.directionalQuality.macroF1)} | ${format(item.directionalQuality.balancedAccuracy)} | ${format(item.probabilities.confidenceMargin.mean)} | ${format(item.probabilities.entropy.mean)} |`);
    }
    lines.push("");

    lines.push("### Oldest / middle / newest", "");
    lines.push("| Window | N | Predicted | Actual | Macro-F1 | Balanced Accuracy | Margin | Entropy |");
    lines.push("|---|---:|---|---|---:|---:|---:|---:|");
    for (const [window, item] of Object.entries(group.diagnostics.temporal)) {
      lines.push(`| ${window} | ${item.count} | ${directionalCounts(item.probabilities.predictedDirectionalDistribution)} | ${directionalCounts(item.probabilities.actualDirectionalDistribution)} | ${format(item.directionalQuality.macroF1)} | ${format(item.directionalQuality.balancedAccuracy)} | ${format(item.probabilities.confidenceMargin.mean)} | ${format(item.probabilities.entropy.mean)} |`);
    }
    lines.push("");

    lines.push("### Feature evidence and proxy separation", "");
    lines.push("| Feature | Ref N | Shadow N | PSI | KS | JSD | Shift σ (proxy) | Std ratio (proxy) | Clip | Missing | Zero | p01 | p25 | p50 | p75 | p99 | Norm mean | Norm std |");
    lines.push("|---|---:|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    const features = Object.values(group.diagnostics.features).sort((left, right) => Math.abs(right.standardizedMeanShift ?? 0) - Math.abs(left.standardizedMeanShift ?? 0) || left.feature.localeCompare(right.feature));
    for (const feature of features) {
      lines.push(`| ${feature.feature} | ${feature.referenceSampleN} | ${feature.shadowSampleN} | ${metric(feature, "psi")} | ${metric(feature, "ksDistance")} | ${metric(feature, "jsd")} | ${format(feature.standardizedMeanShift)} | ${format(feature.stdRatioToTrainingScale)} | ${format(feature.clippingRatio)} | ${format(feature.raw.missingRatio)} | ${format(feature.raw.zeroRatio)} | ${format(feature.raw.p01)} | ${format(feature.raw.p25)} | ${format(feature.raw.p50)} | ${format(feature.raw.p75)} | ${format(feature.raw.p99)} | ${format(feature.normalized.mean)} | ${format(feature.normalized.std)} |`);
    }
    lines.push("");
    lines.push("### Missing Evidence", "");
    if (group.limitations.length) group.limitations.forEach((limitation) => lines.push(`- ${limitation}`));
    else lines.push("- None for metric availability; causality and profitability remain unproven.");
    lines.push("");
  }

  lines.push("## Safety", "");
  lines.push("LIVE_TRADING=false; AUTO_TRADING=false; REAL_ORDER_ENABLED=false; PRIVATE_TRADING_API_ALLOWED=false; executionAuthority=NONE; orderSubmitted=false.");
  lines.push("This immutable artifact is diagnostic-only. It does not change the model, thresholds, labels, frozen blend, strategy, promotion rule, schedule, private API, or order state.");
  return `${lines.join("\n")}\n`;
}

const [statePath, modelDirectory, outputJson, outputMd, referenceEvidencePath] = process.argv.slice(2);
if (!statePath || !modelDirectory || !outputJson || !outputMd) throw new Error("usage: node run-shadow-feature-drift-diagnostics.js <shadow-state.json> <canonical-model-dir> <output.json> <output.md> [reference-evidence.json]");
const diagnosticHeadSha = requireSha("DIAGNOSTIC_HEAD_SHA");
const researchCodeSha = requireSha("RESEARCH_CODE_SHA");
if (diagnosticHeadSha !== researchCodeSha) throw new Error("RESEARCH_CODE_SHA must equal DIAGNOSTIC_HEAD_SHA");
const shadowResearchCodeSha = requireSha("SHADOW_RESEARCH_CODE_SHA");
const canonicalModelSourceSha = requireSha("CANONICAL_MODEL_SOURCE_SHA");
const shadowRunId = requireNumericId("SOURCE_SHADOW_RUN_ID");
const shadowArtifactId = requireNumericId("SOURCE_SHADOW_ARTIFACT_ID");
const shadowArtifactDigest = requireArtifactDigest("SOURCE_SHADOW_ARTIFACT_DIGEST");
const state = readJson(statePath);
const suppliedReference = referenceEvidencePath ? readJson(referenceEvidencePath) : null;
const generatedAt = Date.now();
const groups = {};
for (const groupName of ["crypto-futures-15m", "crypto-futures-1h"]) {
  const records = state.groups?.[groupName]?.records;
  if (!Array.isArray(records) || !records.length) throw new Error(`missing non-empty Shadow records for ${groupName}`);
  const modelArtifact = readJson(path.join(modelDirectory, `${groupName}.json`));
  const referenceGroup = suppliedReference?.groups?.[groupName] ?? {};
  groups[groupName] = buildShadowFeatureDriftDiagnostic({
    records,
    modelArtifact,
    canonicalFeatureOrder: BASELINE_MODEL.featureOrder,
    referenceEvidence: referenceGroup.referenceEvidence ?? null,
    expectedReferenceProvenance: referenceGroup.expectedReferenceProvenance ?? null,
    referenceNow: referenceGroup.referenceNow ?? new Date(generatedAt).toISOString(),
    researchCodeSha,
    shadowResearchCodeSha,
    modelGroup: groupName,
    generatedAt,
  });
}
const rootCauseVerdict = summaryStatus(groups);
const outputCore = Object.freeze({
  schemaVersion: 2,
  kind: "shadow-feature-drift-summary",
  generatedAt,
  source: Object.freeze({ diagnosticHeadSha, canonicalModelSourceSha, shadowResearchCodeSha, shadowRunId, shadowArtifactId, shadowArtifactDigest }),
  researchCodeSha,
  shadowResearchCodeSha,
  rootCauseVerdict,
  DRIFT_EVIDENCE_VALID: Object.values(groups).every((group) => group.DRIFT_EVIDENCE_VALID),
  DRIFT_PROXY_ONLY: Object.values(groups).some((group) => group.DRIFT_PROXY_ONLY),
  groups: Object.freeze(groups),
  profitability: Object.freeze({ PROFITABILITY_PROVEN: false, SHADOW_PROMOTION: "INELIGIBLE" }),
  safety: Object.freeze({
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
  }),
});
const output = Object.freeze({ ...outputCore, evidenceDigest: sha256Canonical(outputCore) });
fs.mkdirSync(path.dirname(outputJson), { recursive: true });
fs.mkdirSync(path.dirname(outputMd), { recursive: true });
fs.writeFileSync(outputJson, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(outputMd, markdown(output));
console.log(JSON.stringify({
  status: "ok",
  rootCauseVerdict,
  DRIFT_EVIDENCE_VALID: output.DRIFT_EVIDENCE_VALID,
  DRIFT_PROXY_ONLY: output.DRIFT_PROXY_ONLY,
  evidenceDigest: output.evidenceDigest,
  source: output.source,
  groups: Object.fromEntries(Object.entries(groups).map(([name, value]) => [name, {
    modelId: value.modelId,
    modelSha: value.modelSha,
    count: value.diagnostics.count,
    referenceStatus: value.referenceEvidence.status,
    predicted: value.diagnostics.probabilities.predictedDirectionalDistribution,
    actual: value.diagnostics.probabilities.actualDirectionalDistribution,
    macroF1: value.diagnostics.directionalQuality.macroF1,
    balancedAccuracy: value.diagnostics.directionalQuality.balancedAccuracy,
    bearRecall: value.diagnostics.directionalQuality.bearRecall,
  }])),
  PROFITABILITY_PROVEN: false,
  SHADOW_PROMOTION: "INELIGIBLE",
  safety: output.safety,
}));
