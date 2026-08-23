import fs from "node:fs";
import path from "node:path";

import { BASELINE_MODEL } from "../src/tiny-model.js";
import { buildShadowFeatureDriftDiagnostic } from "../src/shadow-feature-drift-diagnostics.js";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requireSha(name) {
  const value = process.env[name];
  if (!value || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be an immutable 40-character SHA`);
  return value;
}

function format(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  return Number(value).toFixed(digits);
}

function classCounts(value = {}) {
  return `B ${value.bullish ?? 0} / N ${value.neutral ?? 0} / S ${value.bearish ?? 0}`;
}

function topShiftedFeatures(diagnostic, limit = 10) {
  return Object.values(diagnostic.diagnostics.features)
    .sort((left, right) => Math.abs(right.standardizedMeanShift ?? 0) - Math.abs(left.standardizedMeanShift ?? 0)
      || left.feature.localeCompare(right.feature))
    .slice(0, limit);
}

function markdown(output) {
  const lines = [
    "# Shadow Feature Drift Diagnostic",
    "",
    `- Diagnostic code SHA: \`${output.researchCodeSha}\``,
    `- Active Shadow source SHA: \`${output.shadowResearchCodeSha}\``,
    `- Generated: ${new Date(output.generatedAt).toISOString()}`,
    `- Root verdict: **${output.rootCauseVerdict}**`,
    "- Model/threshold/label changes: **none**",
    "",
    "> Raw TRAIN/VALIDATION feature samples are not persisted in the current candidate artifacts. Therefore true TRAIN↔SHADOW PSI/KS values are not invented. Model normalization mean/scale are used only as training-baseline proxies for standardized shifts.",
    "",
  ];

  for (const [groupName, group] of Object.entries(output.groups)) {
    const probabilities = group.diagnostics.probabilities;
    lines.push(`## ${groupName}`, "");
    lines.push(`- Model: \`${group.modelId}\``);
    lines.push(`- Samples: ${group.diagnostics.count}`);
    lines.push(`- Range: ${new Date(group.diagnostics.firstAnchorTimestamp).toISOString()} → ${new Date(group.diagnostics.lastAnchorTimestamp).toISOString()}`);
    lines.push(`- Predicted: ${classCounts(probabilities.predictedClassDistribution)}`);
    lines.push(`- Actual settled: ${classCounts(probabilities.actualLabelDistribution)}`);
    lines.push(`- Mean confidence margin: ${format(probabilities.confidenceMargin.mean)}`);
    lines.push(`- Mean entropy: ${format(probabilities.entropy.mean)}`);
    lines.push("");
    lines.push("### Largest standardized feature shifts", "");
    lines.push("| Feature | Shadow mean | Train norm mean | Shift (σ) | Shadow std / train scale | Missing | Zero | Clip | PSI | KS |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const feature of topShiftedFeatures(group)) {
      lines.push(`| ${feature.feature} | ${format(feature.raw.mean, 6)} | ${format(feature.modelNormalization.mean, 6)} | ${format(feature.standardizedMeanShift)} | ${format(feature.stdRatioToTrainingScale)} | ${format(feature.raw.missingRatio)} | ${format(feature.raw.zeroRatio)} | ${format(feature.clippingRatio)} | ${format(feature.psi)} | ${format(feature.ksDistance)} |`);
    }
    lines.push("");
    lines.push("### Symbol split", "");
    lines.push("| Symbol | Samples | Predicted | Actual | Margin mean | Entropy mean |");
    lines.push("|---|---:|---|---|---:|---:|");
    for (const [symbol, item] of Object.entries(group.diagnostics.bySymbol)) {
      lines.push(`| ${symbol} | ${item.count} | ${classCounts(item.probabilities.predictedClassDistribution)} | ${classCounts(item.probabilities.actualLabelDistribution)} | ${format(item.probabilities.confidenceMargin.mean)} | ${format(item.probabilities.entropy.mean)} |`);
    }
    lines.push("");
    lines.push("### Time split", "");
    lines.push("| Window | Samples | Predicted | Actual | Margin mean | Entropy mean |");
    lines.push("|---|---:|---|---|---:|---:|");
    for (const [window, item] of Object.entries(group.diagnostics.temporal)) {
      lines.push(`| ${window} | ${item.count} | ${classCounts(item.probabilities.predictedClassDistribution)} | ${classCounts(item.probabilities.actualLabelDistribution)} | ${format(item.probabilities.confidenceMargin.mean)} | ${format(item.probabilities.entropy.mean)} |`);
    }
    lines.push("");
  }

  lines.push("## Verdict", "", `**${output.rootCauseVerdict}**`, "");
  lines.push("This artifact is diagnostic-only. It does not change model weights, thresholds, labels, live authority, or Paper/Shadow promotion state.");
  return `${lines.join("\n")}\n`;
}

const [statePath, modelDirectory, outputJson, outputMd] = process.argv.slice(2);
if (!statePath || !modelDirectory || !outputJson || !outputMd) {
  throw new Error("usage: node run-shadow-feature-drift-diagnostics.js <shadow-state.json> <candidate-model-dir> <output.json> <output.md>");
}

const researchCodeSha = requireSha("RESEARCH_CODE_SHA");
const shadowResearchCodeSha = requireSha("SHADOW_RESEARCH_CODE_SHA");
const state = readJson(statePath);
const groups = {};
for (const groupName of ["crypto-futures-15m", "crypto-futures-1h"]) {
  const groupState = state.groups?.[groupName];
  if (!groupState || !Array.isArray(groupState.records) || groupState.records.length === 0) {
    throw new Error(`missing non-empty Shadow records for ${groupName}`);
  }
  const modelArtifact = readJson(path.join(modelDirectory, `${groupName}.json`));
  groups[groupName] = buildShadowFeatureDriftDiagnostic({
    records: groupState.records,
    modelArtifact,
    canonicalFeatureOrder: BASELINE_MODEL.featureOrder,
    researchCodeSha,
    shadowResearchCodeSha,
    modelGroup: groupName,
  });
}

const output = Object.freeze({
  schemaVersion: 1,
  kind: "shadow-feature-drift-summary",
  generatedAt: Date.now(),
  researchCodeSha,
  shadowResearchCodeSha,
  rootCauseVerdict: "INSUFFICIENT_EVIDENCE",
  groups: Object.freeze(groups),
  safety: Object.freeze({
    syntheticDataAllowed: false,
    modelModified: false,
    thresholdModified: false,
    labelModified: false,
    branchWrite: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
  }),
});

fs.mkdirSync(path.dirname(outputJson), { recursive: true });
fs.mkdirSync(path.dirname(outputMd), { recursive: true });
fs.writeFileSync(outputJson, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(outputMd, markdown(output));
console.log(JSON.stringify({
  status: "ok",
  rootCauseVerdict: output.rootCauseVerdict,
  researchCodeSha,
  shadowResearchCodeSha,
  groups: Object.fromEntries(Object.entries(groups).map(([name, value]) => [name, {
    modelId: value.modelId,
    count: value.diagnostics.count,
    predicted: value.diagnostics.probabilities.predictedClassDistribution,
    actual: value.diagnostics.probabilities.actualLabelDistribution,
  }])),
  modelModified: false,
  thresholdModified: false,
  labelModified: false,
}));
