import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildAdaptiveShadowCandidate } from "../src/adaptive-shadow-candidate.js";
import { summarizeShadowSourceHealth } from "../src/shadow-source-health.js";

const GROUPS = Object.freeze(["crypto-futures-15m", "crypto-futures-1h"]);
const MIN_ADAPTIVE_SETTLED = 120;

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1200),
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 10) : [],
  };
}

function collapseResearchHold({ group, referenceModel, sourceHealth }) {
  return Object.freeze({
    schemaVersion: 1,
    status: "research_hold",
    reason: "source_shadow_prediction_collapse",
    reasons: sourceHealth.reasons,
    group,
    generatedAt: Date.now(),
    settled: sourceHealth.sampleCount,
    required: MIN_ADAPTIVE_SETTLED,
    referenceModelId: referenceModel.id,
    diagnostics: Object.freeze({ sourceShadowHealth: sourceHealth }),
    safety: Object.freeze({
      usesPublicMarketDataOnly: true,
      usesAccountOrOrderApi: false,
      modifiesExistingAppApi: false,
      deploysModel: false,
      mutatesSourceModel: false,
      forcesDirectionalPredictions: false,
    }),
  });
}

function attachSourceHealth(result, sourceHealth) {
  return Object.freeze({
    ...result,
    diagnostics: Object.freeze({
      ...(result.diagnostics ?? {}),
      sourceShadowHealth: sourceHealth,
    }),
  });
}

const statePath = resolve(process.argv[2] ?? "docs/shadow-state.json");
const referenceRoot = resolve(process.argv[3] ?? "docs/candidate-models");
const diagnosticsRoot = resolve(process.argv[4] ?? "docs/adaptive-candidates");
const promotionRoot = resolve(process.argv[5] ?? "docs/candidate-models-v2");
const reportPath = resolve(process.argv[6] ?? "docs/adaptive-shadow-candidate-summary.json");
const state = await readJson(statePath);
const results = {};
let technicalFailure = false;

for (const group of GROUPS) {
  try {
    const referenceArtifact = await readJson(resolve(referenceRoot, `${group}.json`));
    const referenceModel = referenceArtifact?.model;
    if (!referenceModel?.trained || typeof referenceModel.id !== "string") {
      throw new TypeError(`trained reference model is required for ${group}`);
    }
    const groupState = state.groups?.[group] ?? { records: [] };
    const sourceHealth = summarizeShadowSourceHealth({ state: groupState, model: referenceModel });
    const result = sourceHealth.collapsed
      ? collapseResearchHold({ group, referenceModel, sourceHealth })
      : attachSourceHealth(buildAdaptiveShadowCandidate({
          group,
          state: groupState,
          referenceArtifact,
          minSettled: MIN_ADAPTIVE_SETTLED,
        }), sourceHealth);

    await writeJsonAtomically(resolve(diagnosticsRoot, `${group}-adaptive-v2.json`), result);
    if (result.status === "shadow_candidate_v2") {
      await writeJsonAtomically(resolve(promotionRoot, `${group}-funding-v2.json`), result);
    }
    results[group] = {
      status: result.status,
      reason: result.reason ?? null,
      reasons: result.reasons ?? [],
      settled: result.settled ?? result.diagnostics?.split?.total ?? sourceHealth.sampleCount,
      modelId: result.model?.id ?? null,
      promotedToShadowSlot: result.status === "shadow_candidate_v2",
      sourceShadowHealth: {
        status: sourceHealth.status,
        sampleCount: sourceHealth.sampleCount,
        dominantClass: sourceHealth.dominantClass,
        dominantShare: sourceHealth.dominantShare,
        collapsed: sourceHealth.collapsed,
        reasons: sourceHealth.reasons,
        actualCounts: sourceHealth.actualCounts,
        predictedCounts: sourceHealth.predictedCounts,
        topFeatureMeanShifts: sourceHealth.featureMeanShift.topMeanShifts,
      },
    };
  } catch (error) {
    technicalFailure = true;
    results[group] = { status: "fail", stage: "adaptive_candidate_build", error: serializeError(error) };
  }
}

const report = {
  schemaVersion: 2,
  status: technicalFailure ? "fail" : "pass",
  generatedAt: Date.now(),
  source: "isolated-live-shadow-adaptive-candidate-builder",
  results,
  safety: {
    usesPublicMarketDataOnly: true,
    usesAccountOrOrderApi: false,
    modifiesExistingAppApi: false,
    overwritesShadowHistory: false,
    deploysModel: false,
    mutatesSourceModel: false,
    forcesDirectionalPredictions: false,
  },
};
await writeJsonAtomically(reportPath, report);
console.log(JSON.stringify(report, null, 2));
if (technicalFailure) process.exitCode = 1;
