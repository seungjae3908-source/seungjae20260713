import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  FIXED_V1_PATH_EVIDENCE_CASE_V1,
  produceBacktesterPathEvidenceV1,
  verifyBacktesterPathEvidenceV1,
} from "../src/backtester-path-evidence-producer-v1.js";
import { runV1Backtest } from "../src/multi-market-backtest-engine.js";

const SHA_40 = /^[0-9a-f]{40}$/u;
const ALLOWED_ARGUMENTS = new Set([
  "source-sha",
  "candle-archive",
  "candle-csv",
  "funding-archive",
  "funding-csv",
  "output",
  "produced-at",
]);

function argumentsFrom(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new TypeError("arguments must be --name value pairs");
    const name = flag.slice(2);
    if (!ALLOWED_ARGUMENTS.has(name)) throw new TypeError(`unsupported argument: ${flag}`);
    if (Object.hasOwn(parsed, name)) throw new TypeError(`duplicate argument: ${flag}`);
    parsed[name] = value;
  }
  return parsed;
}

function required(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`--${name} is required`);
  return value;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function lines(text, label) {
  const rows = text.trim().split(/\r?\n/u);
  if (rows.length < 2) throw new TypeError(`${label} must include a header and rows`);
  return rows;
}

function fixedCandles(text) {
  const rows = lines(text, "candle CSV");
  const header = rows[0].split(",");
  const expected = ["open_time", "open", "high", "low", "close", "volume"];
  if (!expected.every((name, index) => header[index] === name)) throw new TypeError("candle CSV schema mismatch");
  const count = FIXED_V1_PATH_EVIDENCE_CASE_V1.dataset.rowCount;
  if (rows.length - 1 < count) throw new RangeError("candle CSV does not contain the fixed public window");
  return rows.slice(1, count + 1).map((line, index) => {
    const columns = line.split(",");
    const [timestamp, open, high, low, close, volume] = columns;
    const candle = {
      timestamp: Number(timestamp),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      isClosed: true,
    };
    if (!Number.isSafeInteger(candle.timestamp) || ![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) {
      throw new TypeError(`candle CSV row ${index + 1} is invalid`);
    }
    return candle;
  });
}

function fixedFunding(text, candles) {
  const rows = lines(text, "funding CSV");
  const header = rows[0].split(",");
  if (header[0] !== "calc_time" || header[1] !== "funding_interval_hours" || header[2] !== "last_funding_rate") {
    throw new TypeError("funding CSV schema mismatch");
  }
  const start = candles[0].timestamp;
  const end = candles.at(-1).timestamp;
  return rows.slice(1).map((line, index) => {
    const [timestamp, , rate] = line.split(",");
    const funding = { timestamp: Number(timestamp), rate: Number(rate) };
    if (!Number.isSafeInteger(funding.timestamp) || !Number.isFinite(funding.rate)) {
      throw new TypeError(`funding CSV row ${index + 1} is invalid`);
    }
    return funding;
  }).filter((row) => row.timestamp >= start && row.timestamp <= end);
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const sourceSha = required(args, "source-sha").toLowerCase();
  if (!SHA_40.test(sourceSha)) throw new TypeError("--source-sha must be an exact lowercase 40-character SHA");
  const candleArchive = resolve(required(args, "candle-archive"));
  const candleCsv = resolve(required(args, "candle-csv"));
  const fundingArchive = resolve(required(args, "funding-archive"));
  const fundingCsv = resolve(required(args, "funding-csv"));
  const outputPath = resolve(required(args, "output"));
  const producedAt = args["produced-at"] ?? new Date().toISOString();

  const fixed = FIXED_V1_PATH_EVIDENCE_CASE_V1;
  const candleArchiveDigest = await sha256File(candleArchive);
  const fundingArchiveDigest = await sha256File(fundingArchive);
  if (candleArchiveDigest !== fixed.source.candleArchiveDigest) throw new Error("CANDLE_ARCHIVE_DIGEST_MISMATCH");
  if (fundingArchiveDigest !== fixed.source.fundingArchiveDigest) throw new Error("FUNDING_ARCHIVE_DIGEST_MISMATCH");

  const candles = fixedCandles(await readFile(candleCsv, "utf8"));
  const fundingRates = fixedFunding(await readFile(fundingCsv, "utf8"), candles);
  const result = runV1Backtest({ ...fixed.backtestInput, candles, fundingRates });
  const evidence = produceBacktesterPathEvidenceV1({
    caseId: fixed.caseId,
    caseContractDigest: fixed.caseContractDigest,
    source: fixed.source,
    sourceSha,
    expectedSourceSha: sourceSha,
    candles,
    fundingRates,
    result,
    producedAt,
    testOnly: false,
    replay: false,
    synthetic: false,
    finalHoldoutUsed: false,
  });
  if (evidence.status !== "PRODUCED") throw new Error(`PATH_EVIDENCE_REJECTED:${evidence.blockers.join(",")}`);
  const verification = verifyBacktesterPathEvidenceV1(evidence, { expectedSourceSha: sourceSha });
  if (verification.verified !== true) throw new Error(`PATH_EVIDENCE_VERIFICATION_FAILED:${verification.blockers.join(",")}`);

  const artifact = Object.freeze({
    schemaVersion: "backtester-path-evidence-artifact-v1",
    exactSourceSha: sourceSha,
    fixedCaseId: fixed.caseId,
    caseContractDigest: fixed.caseContractDigest,
    candleArchiveDigest,
    fundingArchiveDigest,
    evidence,
    verification,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: evidence.status,
    exactSourceSha: sourceSha,
    fixedCaseId: fixed.caseId,
    settledTradeCount: evidence.evidenceSet.settledTradeCount,
    datasetDigest: evidence.evidenceSet.datasetDigest,
    fundingDigest: evidence.evidenceSet.fundingDigest,
    resultDigest: evidence.evidenceSet.resultDigest,
    tradeSetDigest: evidence.evidenceSet.tradeSetDigest,
    evidenceSetDigest: evidence.evidenceSet.evidenceSetDigest,
    receiptDigest: evidence.receipt.receiptDigest,
    scalarMae: evidence.scalarMetrics.mae,
    scalarMaeStatus: evidence.scalarMetrics.maeStatus,
    scalarMfe: evidence.scalarMetrics.mfe,
    scalarMfeStatus: evidence.scalarMetrics.mfeStatus,
    truthFlags: evidence.truthFlags,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "REJECTED",
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    LIVE_TRADING: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    executionAuthority: "NONE",
    REAL_ORDER_COUNT: 0,
    PROFITABILITY_PROVEN: false,
    CURRENT_VALIDATED_CHAMPION: "NONE",
  }, null, 2));
  process.exitCode = 1;
});
