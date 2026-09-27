import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  persistScannerSpotSpreadObservationV1,
  summarizeScannerSpotSpreadArchiveV1,
} from "../src/scanner-spot-spread-archive-v1.js";

const BASE_URL = "https://api.upbit.com";
const DAY = 24 * 60 * 60 * 1000;

function arg(name, fallback = "") {
  const direct = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3).trim();
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] ?? "").trim() : fallback;
}
async function collectStoredObservations(root, symbol) {
  const directory = path.join(root, "spread-observations", symbol);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const observations = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    observations.push(JSON.parse(await readFile(path.join(directory, name), "utf8")));
  }
  return observations;
}

const researchCodeSha = String(process.env.RESEARCH_CODE_SHA ?? "").trim().toLowerCase();
if (!/^[0-9a-f]{40}$/u.test(researchCodeSha)) {
  throw new Error("SCANNER_SPOT_SPREAD_EXACT_RESEARCH_SHA_REQUIRED");
}
const symbol = arg("symbol", "BTC").toUpperCase();
const outputRaw = arg("output-dir");
if (!outputRaw) throw new Error("SCANNER_SPOT_SPREAD_OUTPUT_DIR_REQUIRED");
const outputDir = path.resolve(outputRaw);
const requiredDays = Number(arg("required-days", "730"));
if (!Number.isInteger(requiredDays) || requiredDays < 1 || requiredDays > 730) {
  throw new Error("SCANNER_SPOT_SPREAD_REQUIRED_DAYS_INVALID");
}

const requestStartedAtMs = Date.now();
const market = `KRW-${symbol}`;
const response = await fetch(
  `${BASE_URL}/v1/orderbook?markets=${encodeURIComponent(market)}&level=0`,
  {
    headers: {
      accept: "application/json",
      "user-agent": "seungjae-prediction-lab/1.0",
    },
  },
);
if (!response.ok) {
  throw Object.assign(new Error(`UPBIT_ORDERBOOK_HTTP_${response.status}`), { status: response.status });
}
const orderbook = await response.json();
const capturedAtMs = Date.now();
if (capturedAtMs < requestStartedAtMs) throw new Error("SCANNER_SPOT_SPREAD_CAPTURE_CLOCK_INVALID");
const persisted = await persistScannerSpotSpreadObservationV1({
  stateRoot: outputDir,
  researchCodeSha,
  symbol,
  capturedAtMs,
  orderbook,
});
if (persisted.status !== "READY") {
  process.stdout.write(`${JSON.stringify(persisted, null, 2)}\n`);
  process.exitCode = 2;
} else {
  const observations = await collectStoredObservations(outputDir, symbol);
  const summary = summarizeScannerSpotSpreadArchiveV1({
    observations,
    researchCodeSha,
    symbol,
    requiredStartTime: capturedAtMs - requiredDays * DAY,
    requiredEndTime: capturedAtMs,
  });
  const summaryPath = path.join(outputDir, "scanner-spot-spread-archive-readiness.json");
  await writeFile(
    summaryPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify({
    status: summary.status,
    researchCodeSha,
    symbol,
    observationCount: summary.observationCount,
    spreadBps: persisted.observation.spreadBps,
    ownerReady: summary.ownerReady,
    historicalReplayReady: summary.historicalReplayReady,
    resolvesFirstZero: summary.resolvesFirstZero,
    nextFirstZero: summary.nextFirstZero,
    expected4hBucketCount: summary.expected4hBucketCount,
    covered4hBucketCount: summary.covered4hBucketCount,
    missing4hBucketCount: summary.missing4hBucketCount,
    economicSampleCredit: summary.economicSampleCredit,
    scheduleActivated: summary.safety.scheduleActivated,
    summaryPath,
  }, null, 2)}\n`);
}
