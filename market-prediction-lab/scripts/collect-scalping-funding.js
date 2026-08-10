import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import {
  SCALPING_FUNDING_PROVIDER,
  SCALPING_FUNDING_PROVIDER_API,
  SCALPING_FUNDING_PROVIDER_VERSION,
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
const category = "USDT-FUTURES";
const pageSize = 100;
const maxPages = 100;

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
    if (artifact.symbol !== symbol
      || artifact.requestedStart !== requestedStart
      || artifact.requestedEnd !== requestedEnd
      || artifact.collectionCodeSHA !== researchCodeSha
      || artifact.provider !== SCALPING_FUNDING_PROVIDER
      || artifact.providerVersion !== SCALPING_FUNDING_PROVIDER_VERSION
      || artifact.providerApi !== SCALPING_FUNDING_PROVIDER_API
      || artifact.category !== category
      || artifact.pageSize !== pageSize
      || artifact.maxPages !== maxPages) return null;
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
    category,
    pageSize,
    maxPages,
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
    missingIntervals: artifact.missingIntervals ?? null,
    duplicateCount: artifact.duplicateCount ?? 0,
    outOfOrderCount: artifact.outOfOrderCount ?? 0,
    sourceOrder: artifact.sourceOrder ?? null,
    normalizedOrder: artifact.normalizedOrder ?? null,
    pageCount: artifact.pageCount ?? 0,
    pagesRequested: artifact.pagesRequested ?? 0,
    cursorDirection: artifact.cursorDirection ?? null,
    provider: artifact.provider,
    providerVersion: artifact.providerVersion,
    providerApi: artifact.providerApi,
    rawDigest: artifact.rawDigest,
    normalizedDigest: artifact.normalizedDigest,
    provenanceDigest: artifact.provenanceDigest ?? null,
    collectionCodeSHA: artifact.collectionCodeSHA,
    diagnostics: artifact.diagnostics ?? null,
    cache: cached ? "reused" : "written",
  }));
}

const audit = Object.freeze({
  schemaVersion: 2,
  mode: "scalping-funding-provider-audit",
  researchCodeSha,
  requestedStart,
  requestedEnd,
  provider: SCALPING_FUNDING_PROVIDER,
  providerVersion: SCALPING_FUNDING_PROVIDER_VERSION,
  providerApi: SCALPING_FUNDING_PROVIDER_API,
  category,
  pageSize,
  maxPages,
  datasets: Object.freeze(reports),
  allFundingReady: reports.every((row) => row.status === "DATA_READY"),
  syntheticDataAllowed: false,
  interpolationAllowed: false,
  privateApiAllowed: false,
  orderSubmitted: false,
});
await writeJson(resolve(outputRoot, "scalping-funding-provider-audit.json"), audit);
console.log(JSON.stringify(audit));
