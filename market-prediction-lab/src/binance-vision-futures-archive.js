import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const MONTHLY_BASE = "https://data.binance.vision/data/futures/um/monthly";
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function normalizeTimestamp(value, label) {
  const raw = finite(value, label);
  const milliseconds = raw >= 100_000_000_000_000 ? Math.trunc(raw / 1000) : Math.trunc(raw);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new TypeError(`${label} must be a positive timestamp`);
  return milliseconds;
}

function rows(text) {
  return String(text)
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

function headerLike(row) {
  return row?.some((cell) => /[A-Za-z_]/u.test(cell));
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

export function extractSingleCsvFromZip(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const eocd = findEndOfCentralDirectory(buffer);
  const entries = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < entries; entry += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error("invalid ZIP central-directory signature");
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const fileName = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    cursor += 46 + fileNameLength + extraLength + commentLength;
    if (!fileName.toLowerCase().endsWith(".csv")) continue;
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error("invalid ZIP local-file signature");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const uncompressed = compressionMethod === 0
      ? compressed
      : compressionMethod === 8
        ? inflateRawSync(compressed)
        : null;
    if (!uncompressed) throw new Error(`unsupported ZIP compression method: ${compressionMethod}`);
    if (uncompressed.length !== uncompressedSize) throw new Error(`ZIP size mismatch for ${fileName}`);
    return Object.freeze({ fileName, text: uncompressed.toString("utf8") });
  }
  throw new Error("ZIP archive does not contain a CSV file");
}

export function parseVisionKlines(text, symbol) {
  const parsed = rows(text);
  const data = headerLike(parsed[0]) ? parsed.slice(1) : parsed;
  return Object.freeze(data.map((row, index) => {
    if (row.length < 6) throw new Error(`kline row ${index} has too few columns`);
    const candle = {
      symbol,
      timestamp: normalizeTimestamp(row[0], `kline[${index}].open_time`),
      open: finite(row[1], `kline[${index}].open`),
      high: finite(row[2], `kline[${index}].high`),
      low: finite(row[3], `kline[${index}].low`),
      close: finite(row[4], `kline[${index}].close`),
      volume: finite(row[5], `kline[${index}].volume`),
    };
    if ([candle.open, candle.high, candle.low, candle.close].some((value) => value <= 0)
      || candle.volume < 0
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < candle.low) throw new Error(`kline row ${index} has invalid OHLCV`);
    return Object.freeze({ ...candle, observedAt: candle.timestamp, isClosed: true });
  }));
}

export function parseVisionFunding(text) {
  const parsed = rows(text);
  if (parsed.length === 0) return Object.freeze([]);
  const hasHeader = headerLike(parsed[0]);
  const header = hasHeader ? parsed[0].map((cell) => cell.toLowerCase()) : [];
  const findColumn = (names, fallback) => {
    for (const name of names) {
      const index = header.indexOf(name);
      if (index >= 0) return index;
    }
    return fallback;
  };
  const timestampIndex = hasHeader ? findColumn(["calc_time", "funding_time", "fundingtime", "timestamp", "time"], 0) : 0;
  const rateIndex = hasHeader ? findColumn(["last_funding_rate", "funding_rate", "fundingrate", "rate"], parsed[0].length - 1) : 2;
  const data = hasHeader ? parsed.slice(1) : parsed;
  return Object.freeze(data.map((row, index) => Object.freeze({
    timestamp: normalizeTimestamp(row[timestampIndex], `funding[${index}].timestamp`),
    rate: finite(row[rateIndex], `funding[${index}].rate`),
  })));
}

export function buildMonthRange(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) throw new TypeError("invalid month range");
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth() + 1;
  const output = [];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    output.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return Object.freeze(output);
}

async function responseOrThrow(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { "user-agent": "market-prediction-lab/0.9" } });
  if (!response.ok) {
    const error = new Error(`Binance Vision HTTP ${response.status}: ${url}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function fetchVerifiedCsv(fetchImpl, url) {
  const checksumResponse = await responseOrThrow(fetchImpl, `${url}.CHECKSUM`);
  const checksumText = (await checksumResponse.text()).trim();
  const expected = checksumText.split(/\s+/u)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected ?? "")) throw new Error(`invalid checksum document: ${url}`);
  const zipResponse = await responseOrThrow(fetchImpl, url);
  const bytes = Buffer.from(await zipResponse.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch: ${url}`);
  const extracted = extractSingleCsvFromZip(bytes);
  return Object.freeze({ ...extracted, sha256: actual });
}

function uniqueRows(items, fields) {
  const map = new Map();
  for (const row of items) {
    const previous = map.get(row.timestamp);
    if (previous && fields.some((field) => previous[field] !== row[field])) throw new Error(`conflicting archive rows at ${row.timestamp}`);
    map.set(row.timestamp, row);
  }
  return [...map.values()].sort((left, right) => left.timestamp - right.timestamp);
}

async function collectMonths({ symbol, startTime, endTime, kind, fetchImpl, concurrency, onMonth }) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/u.test(symbol)) throw new TypeError("invalid symbol");
  const months = [...buildMonthRange(startTime, endTime)];
  const output = new Array(months.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= months.length) return;
      const month = months[index];
      const file = kind === "klines" ? `${symbol}-1d-${month}.zip` : `${symbol}-fundingRate-${month}.zip`;
      const url = kind === "klines"
        ? `${MONTHLY_BASE}/klines/${symbol}/1d/${file}`
        : `${MONTHLY_BASE}/fundingRate/${symbol}/${file}`;
      const csv = await fetchVerifiedCsv(fetchImpl, url);
      const parsed = kind === "klines" ? parseVisionKlines(csv.text, symbol) : parseVisionFunding(csv.text);
      output[index] = Object.freeze({ month, url, sha256: csv.sha256, rows: parsed });
      await onMonth?.(Object.freeze({ month, rowCount: parsed.length, sha256: csv.sha256 }));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, months.length)) }, () => worker()));
  const flat = output.flatMap((entry) => entry.rows).filter((row) => row.timestamp >= startTime && row.timestamp <= endTime);
  return Object.freeze({
    provider: "binance-vision-usdm-monthly",
    symbol,
    startTime,
    endTime,
    checksumVerified: true,
    rows: Object.freeze(uniqueRows(flat, kind === "klines" ? ["open", "high", "low", "close", "volume"] : ["rate"])),
    manifests: Object.freeze(output.map(({ rows: ignored, ...manifest }) => Object.freeze(manifest))),
  });
}

export async function collectVisionFuturesDailyKlines({ fetchImpl = globalThis.fetch, concurrency = 6, ...input }) {
  const result = await collectMonths({ ...input, kind: "klines", fetchImpl, concurrency });
  return Object.freeze({ ...result, timeframe: "1d", candles: result.rows });
}

export async function collectVisionFuturesFunding({ fetchImpl = globalThis.fetch, concurrency = 6, ...input }) {
  const result = await collectMonths({ ...input, kind: "fundingRate", fetchImpl, concurrency });
  return Object.freeze({ ...result, records: result.rows });
}
