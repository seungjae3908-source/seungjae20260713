import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { extractSingleCsvFromZip, parseVisionFunding } from "../src/binance-vision-futures-archive.js";

const MONTHLY_BASE = "https://data.binance.vision/data/futures/um/monthly/fundingRate";
const researchCodeSha = process.env.RESEARCH_CODE_SHA ?? null;
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("RESEARCH_CODE_SHA must be immutable SHA");
const outputPath = resolve(process.argv[2] ?? "artifacts/automated-research/binance-funding-timestamp-audit.json");
const selectionEnd = Date.UTC(2025, 11, 31, 23, 59, 59, 999);

function csvRows(text) {
  return String(text).replace(/^\uFEFF/u, "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => line.split(",").map((cell) => cell.trim()));
}
function headerLike(row) { return row?.some((cell) => /[A-Za-z_]/u.test(cell)); }
function normalizeRawTimestamp(raw) {
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new Error(`invalid raw timestamp: ${raw}`);
  const sourceUnit = number >= 100_000_000_000_000 ? "microseconds" : "milliseconds";
  const normalizedMs = sourceUnit === "microseconds" ? Math.trunc(number / 1000) : Math.trunc(number);
  return Object.freeze({ rawTimestamp: String(raw), sourceUnit, normalizedMs, conversionRule: sourceUnit === "microseconds" ? "trunc(raw/1000)" : "trunc(raw)" });
}
async function fetchOk(url) {
  const response = await fetch(url, { headers: { "user-agent": "market-prediction-lab/0.9" } });
  if (!response.ok) throw new Error(`Binance Vision HTTP ${response.status}: ${url}`);
  return response;
}
async function auditSymbol(symbol) {
  const file = `${symbol}-fundingRate-2025-12.zip`;
  const url = `${MONTHLY_BASE}/${symbol}/${file}`;
  const checksumUrl = `${url}.CHECKSUM`;
  const checksumText = (await (await fetchOk(checksumUrl)).text()).trim();
  const expectedSha256 = checksumText.split(/\s+/u)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")) throw new Error(`invalid checksum document: ${symbol}`);
  const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error(`checksum mismatch: ${symbol}`);
  const extracted = extractSingleCsvFromZip(bytes);
  const rows = csvRows(extracted.text);
  const hasHeader = headerLike(rows[0]);
  const header = hasHeader ? rows[0].map((cell) => cell.toLowerCase()) : [];
  const timestampIndex = hasHeader ? Math.max(0, ["calc_time", "funding_time", "fundingtime", "timestamp", "time"].map((name) => header.indexOf(name)).find((index) => index >= 0) ?? 0) : 0;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const parsed = parseVisionFunding(extracted.text);
  if (dataRows.length !== parsed.length) throw new Error(`raw/parsed row count mismatch: ${symbol}`);
  const joined = dataRows.map((row, index) => Object.freeze({ raw: normalizeRawTimestamp(row[timestampIndex]), parsed: parsed[index] })).filter((row) => row.parsed.timestamp <= selectionEnd);
  if (!joined.length) throw new Error(`no selection funding rows: ${symbol}`);
  for (const row of joined) if (row.raw.normalizedMs !== row.parsed.timestamp) throw new Error(`parser timestamp mutation detected: ${symbol}:${row.raw.rawTimestamp}`);
  const last = joined.at(-1);
  return Object.freeze({
    symbol,
    archiveUrl: url,
    checksumUrl,
    archiveSha256: actualSha256,
    rawRowCount: dataRows.length,
    parserRowCount: parsed.length,
    lastSelectionSourceTimestampRaw: last.raw.rawTimestamp,
    lastSelectionSourceTimestampUnit: last.raw.sourceUnit,
    lastSelectionNormalizedTimestampMs: last.raw.normalizedMs,
    parserTimestampMs: last.parsed.timestamp,
    sourceAndParserSameInstant: last.raw.normalizedMs === last.parsed.timestamp,
    paginationCursorAppliedToArchiveData: false,
    normalizationRule: last.raw.conversionRule,
    finalHoldoutRead: false,
  });
}

const datasets = [];
for (const symbol of ["BTCUSDT", "ETHUSDT"]) datasets.push(await auditSymbol(symbol));
const artifact = Object.freeze({
  schemaVersion: 1,
  mode: "binance-vision-funding-timestamp-provenance-audit",
  researchCodeSha,
  source: "official_binance_vision_monthly_archive",
  selectionEnd,
  datasets: Object.freeze(datasets),
  verdict: datasets.every((row) => row.sourceAndParserSameInstant && row.paginationCursorAppliedToArchiveData === false) ? "SOURCE_TIMESTAMP_PRESERVED" : "TIMESTAMP_MUTATION_DETECTED",
  syntheticDataUsed: false,
  privateApiUsed: false,
  orderSubmitted: false,
  finalHoldoutRead: false,
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(artifact));
if (artifact.verdict !== "SOURCE_TIMESTAMP_PRESERVED") process.exitCode = 1;
