import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import {
  assertScalpingFundingIntegrity,
  collectScalpingFundingHistory,
} from "../src/scalping-funding-provider.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";

const outputRoot = resolve(process.argv[2] ?? "scalping-funding-cache");
const requestedStart = RESEARCH_BACKTEST_PERIOD.startTime;
const requestedEnd = Math.min(RESEARCH_BACKTEST_PERIOD.defaultEndTime, Date.now());
const researchCodeSha = process.env.RESEARCH_CODE_SHA ?? null;
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("RESEARCH_CODE_SHA must be an immutable 40-character SHA");
const client = new BitgetPublicClient({ minIntervalMs: 100, maxRetries: 4, timeoutMs: 15_000 });
const symbols = Object.freeze(["BTCUSDT", "ETHUSDT"]);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function reusable(path, symbol) {
  try {
    const artifact = await readJson(path);
    if (artifact.symbol !== symbol || artifact.requestedStart !== requestedStart || artifact.requestedEnd !== requestedEnd || artifact.collectionCodeSHA !== researchCodeSha) return null;
    assertScalpingFundingIntegrity(artifact);
    return artifact;
  } catch {
    return null;
  }
}

const reports = [];
for (const symbol of symbols) {
  const path = resolve(outputRoot, `${symbol}.funding.json`);
  const cached = await reusable(path, symbol);
  const artifact = cached ?? await collectScalpingFundingHistory({
    client,
    symbol,
    requestedStart,
    requestedEnd,
    productType: "usdt-futures",
    pageSize: 100,
    maxPages: 200,
    collectionCodeSHA: researchCodeSha,
  });
  if (!cached) await writeJson(path, artifact);
  reports.push(Object.freeze({
    symbol,
    status: artifact.status,
    requestedStart: artifact.requestedStart,
    requestedEnd: artifact.requestedEnd,
    actualFirstFunding: artifact.actualFirstFunding ?? null,
    actualLastFunding: artifact.actualLastFunding ?? null,
    recordCount: artifact.recordCount ?? 0,
    duplicateCount: artifact.duplicateCount ?? 0,
    outOfOrderCount: artifact.outOfOrderCount ?? 0,
    provider: artifact.provider,
    providerVersion: artifact.providerVersion,
    providerApi: artifact.providerApi,
    rawDigest: artifact.rawDigest,
    normalizedDigest: artifact.normalizedDigest,
    collectionCodeSHA: artifact.collectionCodeSHA,
    cache: cached ? "reused" : "written",
  }));
}

const audit = Object.freeze({
  schemaVersion: 1,
  mode: "scalping-funding-provider-audit",
  researchCodeSha,
  requestedStart,
  requestedEnd,
  provider: "bitget-public-v2",
  datasets: Object.freeze(reports),
  allFundingReady: reports.every((row) => row.status === "DATA_READY"),
  syntheticDataAllowed: false,
  privateApiAllowed: false,
  orderSubmitted: false,
});
await writeJson(resolve(outputRoot, "scalping-funding-provider-audit.json"), audit);
console.log(JSON.stringify(audit));
