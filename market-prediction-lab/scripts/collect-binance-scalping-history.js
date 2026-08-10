import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { collectBinanceSameVenueScalpingDataset } from "../src/binance-scalping-archive-provider.js";

const outputRoot = resolve(process.argv[2] ?? "binance-scalping-cache");
const researchCodeSha = process.env.RESEARCH_CODE_SHA ?? null;
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("RESEARCH_CODE_SHA must be immutable 40-character SHA");

const requestedStart = RESEARCH_BACKTEST_PERIOD.startTime;
const requestedEnd = RESEARCH_BACKTEST_PERIOD.defaultEndTime;
const symbols = Object.freeze(["BTCUSDT", "ETHUSDT"]);
await mkdir(outputRoot, { recursive: true });

const audits = [];
for (const symbol of symbols) {
  const result = await collectBinanceSameVenueScalpingDataset({
    symbol,
    requestedStart,
    requestedEnd,
    collectionCodeSHA: researchCodeSha,
  });
  const bundle = Object.freeze({
    schemaVersion: 1,
    market: "CRYPTO_FUTURES",
    venue: "BINANCE_USDM",
    symbol,
    timeframe: "15m",
    collectionCodeSHA: researchCodeSha,
    audit: result.audit,
    candles: result.candles,
    fundingRates: result.fundingRates,
    syntheticDataUsed: false,
    interpolationUsed: false,
    privateApiUsed: false,
    orderSubmitted: false,
  });
  await writeFile(resolve(outputRoot, `${symbol}.json`), `${JSON.stringify(bundle)}\n`, "utf8");
  audits.push(result.audit);
  console.log(JSON.stringify({
    symbol,
    status: result.audit.status,
    actualFirstCandle: result.audit.actualFirstCandle,
    actualLastCandle: result.audit.actualLastCandle,
    expectedCandleCount: result.audit.expectedCandleCount,
    actualCandleCount: result.audit.actualCandleCount,
    actualFirstFunding: result.audit.actualFirstFunding,
    actualLastFunding: result.audit.actualLastFunding,
    fundingRecordCount: result.audit.fundingRecordCount,
    priceArchiveCount: result.audit.priceArchiveCount,
    fundingArchiveCount: result.audit.fundingArchiveCount,
    rawDigest: result.audit.rawDigest,
    normalizedDigest: result.audit.normalizedDigest,
  }));
}

const auditArtifact = Object.freeze({
  schemaVersion: 1,
  mode: "binance-usdm-same-venue-scalping-data-audit",
  researchCodeSha,
  requestedStart,
  requestedEnd,
  providerBoundary: "SAME_VENUE_BINANCE_USDM",
  priceVenue: "BINANCE_USDM",
  fundingVenue: "BINANCE_USDM",
  compatibilityVerdict: "same_venue_price_and_funding_no_cross_venue_mix",
  datasets: Object.freeze(audits),
  status: audits.every((row) => row.status === "DATA_READY") ? "DATA_READY" : "BLOCKED_DATA",
  bitgetLongFundingStatus: "BLOCKED_PROVIDER_COVERAGE",
  syntheticDataUsedAsReal: false,
  interpolationUsed: false,
  privateApiUsed: false,
  orderSubmitted: false,
});
await writeFile(resolve(outputRoot, "binance-scalping-provider-audit.json"), `${JSON.stringify(auditArtifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: auditArtifact.status, datasets: audits.map((row) => ({ symbol: row.symbol, status: row.status })), privateApiUsed: false, orderSubmitted: false }));
