import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildRuleModelBlendChallenger } from "../src/rule-model-blend-challenger.js";

const GROUPS = Object.freeze({
  "crypto-futures-15m": Object.freeze([
    "btcusdt-futures-15m-52d",
    "ethusdt-futures-15m-52d",
  ]),
  "crypto-futures-1h": Object.freeze([
    "btcusdt-futures-1h-83d",
    "ethusdt-futures-1h-83d",
  ]),
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function readGroupRecords(suiteRoot, datasetIds, splitName) {
  const rows = [];
  for (const datasetId of datasetIds) {
    const path = resolve(suiteRoot, "datasets", datasetId, "records", `${splitName}.jsonl`);
    rows.push(...await readJsonl(path));
  }
  return rows;
}

const suiteRoot = resolve(process.argv[2] ?? "live-market-suite");
const outputPath = resolve(process.argv[3] ?? "docs/rule-model-blend-challenger-result.json");
const sourceArtifactId = process.argv[4] ?? null;
const sourceArtifactSha256 = process.argv[5] ?? null;
const sourceHeadSha = process.argv[6] ?? null;

const groups = {};
for (const [group, datasetIds] of Object.entries(GROUPS)) {
  const artifact = await readJson(resolve(suiteRoot, "models", `${group}.json`));
  if (!artifact?.model?.trained) {
    groups[group] = Object.freeze({
      status: "research_hold",
      reason: "trained_model_missing",
      sourceDatasets: datasetIds,
    });
    continue;
  }
  const validationRecords = await readGroupRecords(suiteRoot, datasetIds, "validation");
  const testRecords = await readGroupRecords(suiteRoot, datasetIds, "test");
  groups[group] = buildRuleModelBlendChallenger({
    validationRecords,
    testRecords,
    model: artifact.model,
  });
}

const result = Object.freeze({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "immutable-multi-market-suite-replay",
  provenance: Object.freeze({
    sourceArtifactId,
    sourceArtifactSha256,
    sourceHeadSha,
    suiteRoot: "live-market-suite",
  }),
  groups: Object.freeze(groups),
  safety: Object.freeze({
    validationOnlySelection: true,
    untouchedTestGate: true,
    finalHoldoutUsed: false,
    paperUsed: false,
    shadowUsedForSelection: false,
    runtimeChanged: false,
    thresholdChanged: false,
    classWeightChanged: false,
    labelChanged: false,
    liveAuthority: false,
    promotionAuthority: false,
  }),
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  outputPath,
  statuses: Object.fromEntries(Object.entries(groups).map(([group, value]) => [group, value.status])),
}));
