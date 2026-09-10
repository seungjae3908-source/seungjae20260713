import fs from "node:fs";
import path from "node:path";

import { buildShadowBacktestGapDiagnostic } from "../src/shadow-backtest-gap-diagnostics.js";

function requireSha(name) {
  const value = process.env[name];
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) throw new Error(`${name} must be an immutable 40-character SHA`);
  return value;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function format(value) { return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "N/A"; }
function markdown(report) {
  const shadow = report.shadow;
  const comparison = report.directionalComparison;
  return [
    "# Backtest ↔ Shadow Evidence Gap",
    "",
    `- Timeframe: ${report.timeframe}`,
    `- Shadow samples: ${shadow.sampleCount}`,
    `- Predicted LONG/NEUTRAL/SHORT: ${shadow.predictedCounts.bullish}/${shadow.predictedCounts.neutral}/${shadow.predictedCounts.bearish}`,
    `- Actual bearish support: ${shadow.evidence.actualBearishSupport}`,
    `- Bear recall: ${shadow.bearRecallEvaluable ? format(shadow.bearRecall) : "N/A (actual bearish sample=0)"}`,
    `- Neutral dominance observed: ${shadow.evidence.neutralDominanceObserved}`,
    `- Same-semantic Backtest directional comparison: ${comparison.available ? comparison.descriptiveVerdict : comparison.reason}`,
    `- Causal root cause: **${report.rootCauseVerdict}**`,
    "",
    `Missing evidence: ${report.missingEvidence.length ? report.missingEvidence.join(", ") : "none"}`,
    "",
    "Backtest economic metrics are displayed as a separate semantic domain and are never subtracted from Shadow classification metrics.",
    "Diagnostic-only: no model/threshold/label/strategy/promotion/schedule/order mutation.",
    "",
  ].join("\n");
}

const [inputPath, outputJson, outputMd] = process.argv.slice(2);
if (!inputPath || !outputJson || !outputMd) throw new Error("usage: node run-shadow-backtest-gap-diagnostics.js <input.json> <output.json> <output.md>");
const input = readJson(inputPath);
const report = buildShadowBacktestGapDiagnostic({ ...input, researchCodeSha: requireSha("RESEARCH_CODE_SHA"), shadowResearchCodeSha: requireSha("SHADOW_RESEARCH_CODE_SHA") });
fs.mkdirSync(path.dirname(outputJson), { recursive: true });
fs.mkdirSync(path.dirname(outputMd), { recursive: true });
fs.writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(outputMd, markdown(report));
console.log(JSON.stringify({ status: "ok", timeframe: report.timeframe, neutralDominanceObserved: report.collapseObservation.neutralDominanceObserved, bearRecall: report.collapseObservation.bearRecall, bearRecallEvaluable: report.collapseObservation.bearRecallEvaluable, rootCauseVerdict: report.rootCauseVerdict }));
