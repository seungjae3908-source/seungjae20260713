import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { persistScannerSpot4hDatasetMaterializationV1 } from "../src/scanner-spot-4h-dataset-materializer-v1.js";

const DAY = 24 * 60 * 60 * 1000;

function arg(name, fallback = "") {
  const direct = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3).trim();
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : fallback;
}

const researchSha = String(process.env.RESEARCH_CODE_SHA ?? "").trim().toLowerCase();
if (!/^[0-9a-f]{40}$/u.test(researchSha)) {
  throw new Error("SCANNER_SPOT_4H_EXACT_RESEARCH_SHA_REQUIRED");
}
const symbol = arg("symbol", "BTC").toUpperCase();
const days = Number(arg("days", "730"));
if (!Number.isInteger(days) || days < 180 || days > 730) {
  throw new Error("SCANNER_SPOT_4H_DAYS_INVALID");
}
const outputRaw = arg("output-dir");
if (!outputRaw) throw new Error("SCANNER_SPOT_4H_OUTPUT_DIR_REQUIRED");
const outputDir = path.resolve(outputRaw);
const observedAtMs = Date.now();
const startTime = observedAtMs - days * DAY;

await mkdir(outputDir, { recursive: true, mode: 0o700 });
const [primaryHistory, contextHistory] = await Promise.all([
  collectUpbitSpotHistory({
    symbol,
    timeframe: "4h",
    startTime,
    endTime: observedAtMs,
    maxPages: 100,
    minIntervalMs: 120,
  }),
  collectUpbitSpotHistory({
    symbol,
    timeframe: "60m",
    startTime,
    endTime: observedAtMs,
    maxPages: 100,
    minIntervalMs: 120,
  }),
]);

const result = await persistScannerSpot4hDatasetMaterializationV1({
  stateRoot: outputDir,
  researchSha,
  symbol,
  observedAtMs,
  nowMs: Date.now(),
  primaryHistory,
  contextHistory,
});

const summaryPath = path.join(outputDir, "scanner-spot-4h-materialization.json");
await writeFile(
  summaryPath,
  `${JSON.stringify(result, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600, flag: "wx" },
);

process.stdout.write(`${JSON.stringify({
  status: result.status,
  researchCodeSha: result.researchCodeSha,
  symbol: result.symbol,
  datasetSnapshotHash: result.dataset.datasetSnapshotHash,
  datasetDigest: result.dataset.datasetDigest,
  primaryRows: result.dataset.rowCount,
  contextRows: result.contextEvidence.rowCount,
  firstZero: result.historicalReplay.firstZero,
  qualityArtifactWritten: result.qualityArtifactWritten,
  executionAuthority: result.safety.executionAuthority,
  summaryPath,
}, null, 2)}\n`);
