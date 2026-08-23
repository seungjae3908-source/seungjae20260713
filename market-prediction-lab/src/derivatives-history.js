const FUNDING_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function positiveTimestamp(value, label) {
  const timestamp = finiteNumber(value, label);
  if (!Number.isInteger(timestamp) || timestamp <= 0) throw new TypeError(`${label} must be a positive millisecond timestamp`);
  return timestamp;
}

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/.test(symbol)) throw new TypeError("invalid symbol");
  return symbol;
}

function uniqueSorted(records, valueKey) {
  const byTimestamp = new Map();
  for (const record of records) {
    const existing = byTimestamp.get(record.timestamp);
    if (existing && existing[valueKey] !== record[valueKey]) {
      throw new Error(`conflicting derivatives records at ${record.timestamp}`);
    }
    byTimestamp.set(record.timestamp, record);
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export function normalizeFundingRateRecord(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`funding[${index}] is invalid`);
  const rateSource = raw.rateRaw ?? raw.fundingRate ?? raw.rate;
  const rateRaw = String(rateSource ?? "").trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rateRaw)) {
    throw new TypeError(`funding[${index}].fundingRate is invalid`);
  }
  const rate = finiteNumber(rateRaw, `funding[${index}].fundingRate`);
  const timestamp = positiveTimestamp(raw.timestamp ?? raw.fundingTime, `funding[${index}].fundingTime`);
  return Object.freeze({ timestamp, rate, rateRaw });
}

export function normalizeOpenInterestSnapshot(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("open-interest snapshot is invalid");
  const timestamp = positiveTimestamp(raw.timestamp ?? raw.openInterestTimestamp ?? raw.collectedAt, "openInterest.timestamp");
  const valueRaw = String(raw.valueRaw ?? raw.openInterestRaw ?? raw.value ?? raw.openInterest ?? "").trim();
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(valueRaw)) {
    throw new TypeError("openInterest.value is invalid");
  }
  const value = finiteNumber(valueRaw, "openInterest.value");
  if (value < 0) throw new TypeError("openInterest.value cannot be negative");
  return Object.freeze({ timestamp, value, valueRaw });
}

export async function collectFundingRateHistory({
  client,
  symbol,
  startTime,
  endTime = Date.now(),
  productType = "usdt-futures",
  pageSize = FUNDING_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  endpoint = "/api/v2/mix/market/history-fund-rate",
  onPage,
}) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  assertSymbol(symbol);
  positiveTimestamp(startTime, "startTime");
  positiveTimestamp(endTime, "endTime");
  if (endTime <= startTime) throw new RangeError("endTime must be greater than startTime");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError("pageSize must be between 1 and 100");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new RangeError("maxPages must be between 1 and 200");

  const collected = [];
  let previousOldest = Number.POSITIVE_INFINITY;
  let exhausted = false;

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const payload = await client.get(endpoint, { symbol, productType, pageSize, pageNo });
    if (!Array.isArray(payload.data)) throw new TypeError("Bitget funding history data must be an array");
    if (payload.data.length === 0) {
      exhausted = true;
      break;
    }

    const page = uniqueSorted(payload.data.map(normalizeFundingRateRecord), "rateRaw");
    const oldest = page[0]?.timestamp;
    const newest = page.at(-1)?.timestamp;
    if (!Number.isFinite(oldest) || !Number.isFinite(newest)) throw new TypeError("funding page has no valid timestamp");
    if (oldest >= previousOldest) throw new Error("funding pagination did not move backward");
    previousOldest = oldest;

    collected.push(...page.filter((record) => record.timestamp >= startTime && record.timestamp <= endTime));
    await onPage?.(Object.freeze({ pageNo, received: page.length, oldest, newest }));

    if (oldest <= startTime || payload.data.length < pageSize) {
      exhausted = true;
      break;
    }
  }

  const records = uniqueSorted(collected, "rateRaw");
  return Object.freeze({
    schemaVersion: 1,
    provider: "bitget-public-v2",
    symbol,
    productType,
    startTime,
    endTime,
    exhausted,
    records: Object.freeze(records),
  });
}

function lastIndexAtOrBefore(records, timestamp) {
  let low = 0;
  let high = records.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (records[middle].timestamp <= timestamp) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

export function createTemporalDerivativesProvider({
  fundingHistory = [],
  openInterestSnapshots = [],
  openInterestTrainingParityConfirmed = false,
  fundingMaxAgeMs = 12 * 60 * 60 * 1000,
  openInterestMaxAgeMs = 2 * 60 * 60 * 1000,
} = {}) {
  if (typeof openInterestTrainingParityConfirmed !== "boolean") {
    throw new TypeError("openInterestTrainingParityConfirmed must be boolean");
  }
  if (!Number.isInteger(fundingMaxAgeMs) || fundingMaxAgeMs <= 0) throw new TypeError("fundingMaxAgeMs must be positive");
  if (!Number.isInteger(openInterestMaxAgeMs) || openInterestMaxAgeMs <= 0) throw new TypeError("openInterestMaxAgeMs must be positive");
  const funding = uniqueSorted(fundingHistory.map(normalizeFundingRateRecord), "rateRaw");
  const oi = openInterestTrainingParityConfirmed
    ? uniqueSorted(openInterestSnapshots.map(normalizeOpenInterestSnapshot), "valueRaw")
    : [];

  return ({ anchorTimestamp }) => {
    const anchor = positiveTimestamp(anchorTimestamp, "anchorTimestamp");
    const features = {};
    const availability = {
      fundingKnown: false,
      fundingTimestamp: null,
      fundingAgeMs: null,
      openInterestKnown: false,
      openInterestTimestamp: null,
      openInterestAgeMs: null,
    };

    const fundingIndex = lastIndexAtOrBefore(funding, anchor);
    if (fundingIndex >= 0) {
      const record = funding[fundingIndex];
      const age = anchor - record.timestamp;
      if (age <= fundingMaxAgeMs) {
        features.fundingRate = record.rate;
        availability.fundingKnown = true;
        availability.fundingTimestamp = record.timestamp;
        availability.fundingAgeMs = age;
      }
    }

    const oiIndex = lastIndexAtOrBefore(oi, anchor);
    if (oiIndex >= 1) {
      const current = oi[oiIndex];
      const previous = oi[oiIndex - 1];
      const age = anchor - current.timestamp;
      if (age <= openInterestMaxAgeMs && previous.value > 0) {
        features.openInterestChange = (current.value - previous.value) / previous.value;
        availability.openInterestKnown = true;
        availability.openInterestTimestamp = current.timestamp;
        availability.openInterestAgeMs = age;
      }
    }

    return Object.freeze({
      derivativesFeatures: Object.freeze(features),
      featureAvailability: Object.freeze(availability),
    });
  };
}

export function summarizeTemporalCoverage(records) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const total = records.length;
  const fundingKnown = records.filter((record) => record.featureAvailability?.fundingKnown).length;
  const openInterestKnown = records.filter((record) => record.featureAvailability?.openInterestKnown).length;
  return Object.freeze({
    total,
    fundingKnown,
    openInterestKnown,
    fundingCoverage: total === 0 ? 0 : fundingKnown / total,
    openInterestCoverage: total === 0 ? 0 : openInterestKnown / total,
  });
}
