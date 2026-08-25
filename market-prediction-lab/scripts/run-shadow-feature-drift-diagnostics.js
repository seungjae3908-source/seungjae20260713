import fs from "node:fs";
import path from "node:path";

import { BASELINE_MODEL } from "../src/tiny-model.js";
import { buildShadowFeatureDriftDiagnostic } from "../src/shadow-feature-drift-diagnostics.js";

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function requireSha(name) {
  const value = process.env[name];
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) throw new Error(`${name} must be an immutable 40-character SHA`);
  return value;
}
function format(value, digits = 4) { return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "N/A"; }

function markdown(output) {
  const lines = ["# Shadow Feature Drift Diagnostic", "", `- Diagnostic SHA: \`${output.researchCodeSha}\``, `- Shadow source SHA: \`${output.shadowResearchCodeSha}\``, `- Verdict: **${output.rootCauseVerdict}**`, "- Model/threshold/label changes: **none**", ""];
  for (const [name, group] of Object.entries(output.groups)) {
    lines.push(`## ${name}`, "", `- Model: \`${group.modelId}\``, `- Samples: ${group.diagnostics.count}`, `- PSI/KS empirical reference available: ${group.trueDistributionDriftAvailable}`, `- Predicted B/N/S: ${group.diagnostics.probabilities.predictedClassDistribution.bullish}/${group.diagnostics.probabilities.predictedClassDistribution.neutral}/${group.diagnostics.probabilities.predictedClassDistribution.bearish}`, `- Actual B/N/S: ${group.diagnostics.probabilities.actualLabelDistribution.bullish}/${group.diagnostics.probabilities.actualLabelDistribution.neutral}/${group.diagnostics.probabilities.actualLabelDistribution.bearish}`, "", "| Feature | Shift σ | Std/train scale | Missing | Zero | PSI | KS |", "|---|---:|---:|---:|---:|---:|---:|");
    const features = Object.values(group.diagnostics.features).sort((a, b) => Math.abs(b.standardizedMeanShift ?? 0) - Math.abs(a.standardizedMeanShift ?? 0));
    features.slice(0, 12).forEach((feature) => lines.push(`| ${feature.feature} | ${format(feature.standardizedMeanShift)} | ${format(feature.stdRatioToTrainingScale)} | ${format(feature.raw.missingRatio)} | ${format(feature.raw.zeroRatio)} | ${format(feature.psi)} | ${format(feature.ksDistance)} |`));
    if (group.limitations.length) lines.push("", `Missing evidence: ${group.limitations.join(", ")}`);
    lines.push("");
  }
  lines.push("Diagnostic-only: no model, threshold, label, strategy, promotion, schedule, private API, or order mutation.");
  return `${lines.join("\n")}\n`;
}

const [statePath, modelDirectory, outputJson, outputMd] = process.argv.slice(2);
if (!statePath || !modelDirectory || !outputJson || !outputMd) throw new Error("usage: node run-shadow-feature-drift-diagnostics.js <shadow-state.json> <candidate-model-dir> <output.json> <output.md>");
const researchCodeSha = requireSha("RESEARCH_CODE_SHA");
const shadowResearchCodeSha = requireSha("SHADOW_RESEARCH_CODE_SHA");
const state = readJson(statePath);
const groups = {};
for (const groupName of ["crypto-futures-15m", "crypto-futures-1h"]) {
  const records = state.groups?.[groupName]?.records;
  if (!Array.isArray(records) || !records.length) throw new Error(`missing non-empty Shadow records for ${groupName}`);
  const modelArtifact = readJson(path.join(modelDirectory, `${groupName}.json`));
  groups[groupName] = buildShadowFeatureDriftDiagnostic({ records, modelArtifact, canonicalFeatureOrder: BASELINE_MODEL.featureOrder, researchCodeSha, shadowResearchCodeSha, modelGroup: groupName });
}
const output = Object.freeze({ schemaVersion: 1, kind: "shadow-feature-drift-summary", generatedAt: Date.now(), researchCodeSha, shadowResearchCodeSha, rootCauseVerdict: Object.values(groups).some((group) => group.trueDistributionDriftAvailable) ? "DRIFT_MEASURED_CAUSALITY_UNPROVEN" : "INSUFFICIENT_EVIDENCE", groups: Object.freeze(groups), safety: Object.freeze({ diagnosticsOnly: true, modelModified: false, thresholdModified: false, labelModified: false, orderSubmitted: false }) });
fs.mkdirSync(path.dirname(outputJson), { recursive: true });
fs.mkdirSync(path.dirname(outputMd), { recursive: true });
fs.writeFileSync(outputJson, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(outputMd, markdown(output));
console.log(JSON.stringify({ status: "ok", rootCauseVerdict: output.rootCauseVerdict, researchCodeSha, shadowResearchCodeSha, modelModified: false, thresholdModified: false, labelModified: false }));
