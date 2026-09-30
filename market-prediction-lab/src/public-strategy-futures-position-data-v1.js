import {
  collectVisionFuturesDailyArchiveKlines,
  collectVisionFuturesDailyKlines,
  collectVisionFuturesFunding,
} from "./binance-vision-futures-archive.js";
import {
  BinanceFuturesPublicClient,
  collectBinanceFuturesFundingRates,
} from "./binance-futures-history.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function uniqueSorted(rows, fields) {
  const byTimestamp = new Map();
  for (const row of rows) {
    const previous = byTimestamp.get(row.timestamp);
    if (previous && fields.some((field) => previous[field] !== row[field])) {
      throw new Error(`CONFLICTING_FUTURES_POSITION_ROW:${row.timestamp}`);
    }
    byTimestamp.set(row.timestamp, row);
  }
  return Object.freeze([...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp));
}

export function assertDailyPriceCoverageV1(candles, startTime, endTimeExclusive, label = "futures-position") {
  if (!Array.isArray(candles) || candles.length === 0) throw new Error(`${label}:EMPTY_DAILY_PRICE`);
  const rows = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  if (rows[0].timestamp > startTime + DAY_MS) throw new Error(`${label}:DAILY_PRICE_START_TOO_LATE`);
  if (rows.at(-1).timestamp < endTimeExclusive - 2 * DAY_MS) throw new Error(`${label}:DAILY_PRICE_END_TOO_EARLY`);
  for (let index = 1; index < rows.length; index += 1) {
    const delta = rows[index].timestamp - rows[index - 1].timestamp;
    if (delta !== DAY_MS) throw new Error(`${label}:DAILY_PRICE_GAP:${rows[index - 1].timestamp}:${delta}`);
  }
  return Object.freeze({
    firstTimestamp: rows[0].timestamp,
    lastTimestamp: rows.at(-1).timestamp,
    candleCount: rows.length,
  });
}

export function assertFundingCoverageV1(records, startTime, endTimeExclusive, label = "futures-position") {
  if (!Array.isArray(records) || records.length === 0) throw new Error(`${label}:EMPTY_FUNDING`);
  const rows = [...records].sort((a, b) => a.timestamp - b.timestamp);
  if (rows[0].timestamp > startTime + DAY_MS) throw new Error(`${label}:FUNDING_START_TOO_LATE`);
  if (rows.at(-1).timestamp < endTimeExclusive - DAY_MS) throw new Error(`${label}:FUNDING_END_TOO_EARLY`);
  for (let index = 1; index < rows.length; index += 1) {
    const delta = rows[index].timestamp - rows[index - 1].timestamp;
    if (delta > DAY_MS) throw new Error(`${label}:FUNDING_GAP_GT_24H:${rows[index - 1].timestamp}:${delta}`);
  }
  return Object.freeze({
    firstTimestamp: rows[0].timestamp,
    lastTimestamp: rows.at(-1).timestamp,
    fundingCount: rows.length,
  });
}

export async function collectExactThreeYearFuturesPositionDataV1({
  symbol,
  startTime,
  endTimeExclusive,
  fetchImpl = globalThis.fetch,
  monthlyCutoverTime = Date.UTC(2026, 8, 1),
} = {}) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/u.test(symbol)) throw new TypeError("invalid symbol");
  if (!Number.isInteger(startTime) || !Number.isInteger(endTimeExclusive) || endTimeExclusive <= startTime) {
    throw new TypeError("invalid benchmark period");
  }
  if (!Number.isInteger(monthlyCutoverTime) || monthlyCutoverTime <= startTime || monthlyCutoverTime >= endTimeExclusive) {
    throw new TypeError("invalid monthlyCutoverTime");
  }

  const monthlyEnd = monthlyCutoverTime - 1;
  const dailyEnd = endTimeExclusive - DAY_MS;
  const [monthlyPrice, recentDailyPrice, monthlyFunding] = await Promise.all([
    collectVisionFuturesDailyKlines({
      symbol,
      startTime,
      endTime: monthlyEnd,
      fetchImpl,
      concurrency: 6,
    }),
    collectVisionFuturesDailyArchiveKlines({
      symbol,
      startTime: monthlyCutoverTime,
      endTime: dailyEnd,
      fetchImpl,
      concurrency: 6,
    }),
    collectVisionFuturesFunding({
      symbol,
      startTime,
      endTime: monthlyEnd,
      fetchImpl,
      concurrency: 6,
    }),
  ]);

  const restClient = new BinanceFuturesPublicClient({ fetchImpl, maxRetries: 4, timeoutMs: 12_000 });
  const recentFunding = await collectBinanceFuturesFundingRates({
    client: restClient,
    symbol,
    startTime: monthlyCutoverTime,
    endTime: endTimeExclusive - 1,
  });

  const candles = uniqueSorted(
    [...monthlyPrice.candles, ...recentDailyPrice.candles]
      .filter((row) => row.timestamp >= startTime && row.timestamp < endTimeExclusive),
    ["open", "high", "low", "close", "volume"],
  );
  const fundingRates = uniqueSorted(
    [...monthlyFunding.records, ...recentFunding.records]
      .filter((row) => row.timestamp >= startTime && row.timestamp < endTimeExclusive),
    ["rate"],
  );

  const priceCoverage = assertDailyPriceCoverageV1(candles, startTime, endTimeExclusive, symbol);
  const fundingCoverage = assertFundingCoverageV1(fundingRates, startTime, endTimeExclusive, symbol);

  return Object.freeze({
    schemaVersion: 1,
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: "1d",
    provider: "binance-vision-monthly-plus-daily-and-binance-rest-funding",
    targetExecutionCostVenue: "BITGET_RESEARCH_ASSUMPTION",
    crossVenueProxy: true,
    checksumVerifiedArchive: true,
    startTime,
    endTimeExclusive,
    monthlyCutoverTime,
    candles,
    fundingRates,
    priceCoverage,
    fundingCoverage,
    manifests: Object.freeze({
      monthlyPrice: monthlyPrice.manifests,
      recentDailyPrice: recentDailyPrice.manifests,
      monthlyFunding: monthlyFunding.manifests,
      recentFundingProvider: recentFunding.provider,
    }),
  });
}
