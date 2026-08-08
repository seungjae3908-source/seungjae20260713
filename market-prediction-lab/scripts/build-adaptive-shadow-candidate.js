import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildAdaptiveShadowCandidate } from "../src/adaptive-shadow-candidate.js";

const GROUPS = Object.freeze(["crypto-futures-15m", "crypto-futures-1h"]);

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
    const result = buildAdaptiveShadowCandidate({
      group,
      state: state.groups?.[group] ?? { records: [] },
      referenceArtifact,
    });
    await writeJsonAtomically(resolve(diagnosticsRoot, `${group}-adaptive-v2.json`), result);
    if (result.status === "shadow_candidate_v2") {
      await writeJsonAtomically(resolve(promotionRoot, `${group}-funding-v2.json`), result);
    }
    results[group] = {
      status: result.status,
      reason: result.reason ?? null,
      reasons: result.reasons ?? [],
      settled: result.settled ?? result.diagnostics?.split?.total ?? 0,
      modelId: result.model?.id ?? null,
      promotedToShadowSlot: result.status === "shadow_candidate_v2",
    };
  } catch (error) {
    technicalFailure = true;
    results[group] = { status: "fail", stage: "adaptive_candidate_build", error: serializeError(error) };
  }
}

const report = {
  schemaVersion: 1,
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
  },
};
await writeJsonAtomically(reportPath, report);
console.log(JSON.stringify(report, null, 2));
if (technicalFailure) process.exitCode = 1;
