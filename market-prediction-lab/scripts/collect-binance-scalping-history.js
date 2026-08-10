import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { BINANCE_LIVE_TAIL_BLOCKER, collectBinanceSelectionDataset } from "../src/binance-scalping-selection-provider.js";

const outputRoot = resolve(process.argv[2] ?? "binance-scalping-cache");
const researchCodeSha = process.env.RESEARCH_CODE_SHA ?? null;
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("RESEARCH_CODE_SHA must be immutable 40-character SHA");

const requestedSelectionStart = RESEARCH_BACKTEST_PERIOD.startTime;
const requestedSelectionEnd = RESEARCH_BACKTEST_PERIOD.validationEndTime;
const symbols = Object.freeze(["BTCUSDT", "ETHUSDT"]);
await mkdir(outputRoot, { recursive: true });

const audits = [];
for (const symbol of symbols) {
  const result = await collectBinanceSelectionDataset({
    symbol,
    requestedSelectionStart,
    requestedSelectionEnd,
    collectionCodeSHA: researchCodeSha,
  });
  const bundle = Object.freeze({
    schemaVersion: 2,
    market: "CRYPTO_FUTURES",
    venue: "BINANCE_USDM",
    symbol,
    timeframe: "15m",
    collectionCodeSHA: researchCodeSha,
    selectionDataStatus: result.audit.selectionDataStatus,
    finalHoldoutDataStatus: result.audit.finalHoldoutDataStatus,
    liveTailStatus: result.audit.liveTailStatus,
    audit: result.audit,
    candles: result.candles,
    fundingRates: result.fundingRates,
    syntheticDataUsed: false,
    interpolationUsed: false,
    privateApiUsed: false,
    orderSubmitted: false,
    finalHoldoutRead: false,
  });
  await writeFile(resolve(outputRoot, `${symbol}.json`), `${JSON.stringify(bundle)}\n`, "utf8");
  audits.push(result.audit);
  console.log(JSON.stringify({
    symbol,
    selectionDataStatus: result.audit.selectionDataStatus,
    finalHoldoutDataStatus: result.audit.finalHoldoutDataStatus,
    liveTailStatus: result.audit.liveTailStatus,
    requestedSelectionStart: result.audit.requestedSelectionStart,
    requestedSelectionEnd: result.audit.requestedSelectionEnd,
    actualFirstCandle: result.audit.actualFirstCandle,
    actualLastCandle: result.audit.actualLastCandle,
    expectedCandleCount: result.audit.expectedCandleCount,
    actualCandleCount: result.audit.actualCandleCount,
    missingCandleCount: result.audit.missingCandleCount,
    gapCount: result.audit.gapCount,
    duplicateCount: result.audit.duplicateCount,
    outOfOrderCount: result.audit.outOfOrderCount,
    actualFirstFunding: result.audit.actualFirstFunding,
    actualLastFunding: result.audit.actualLastFunding,
    fundingRecordCount: result.audit.fundingRecordCount,
    fundingMissingIntervals: result.audit.fundingMissingIntervals,
    fundingDuplicateCount: result.audit.fundingDuplicateCount,
    fundingOutOfOrderCount: result.audit.fundingOutOfOrderCount,
    monthlyArchiveCount: result.audit.monthlyArchiveCount,
    checksumVerifiedCount: result.audit.checksumVerifiedCount,
    checksumFailureCount: result.audit.checksumFailureCount,
    rawCandleDigest: result.audit.rawCandleDigest,
    normalizedCandleDigest: result.audit.normalizedCandleDigest,
    rawFundingDigest: result.audit.rawFundingDigest,
    normalizedFundingDigest: result.audit.normalizedFundingDigest,
  }));
}

const auditArtifact = Object.freeze({
  schemaVersion: 2,
  mode: "binance-usdm-same-venue-scalping-selection-data-audit",
  researchCodeSha,
  selectionPeriod: Object.freeze({ start: requestedSelectionStart, end: requestedSelectionEnd }),
  finalHoldoutPeriod: Object.freeze({ start: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime, status: "LOCKED_NOT_EVALUATED" }),
  liveTailStatus: BINANCE_LIVE_TAIL_BLOCKER,
  binanceRest451Status: BINANCE_LIVE_TAIL_BLOCKER,
  providerBoundary: "SAME_VENUE_BINANCE_USDM",
  priceVenue: "BINANCE_USDM",
  fundingVenue: "BINANCE_USDM",
  crossVenueMix: false,
  compatibilityVerdict: "same_venue_price_and_funding_no_cross_venue_mix",
  datasets: Object.freeze(audits),
  selectionDataStatus: audits.every((row) => row.selectionDataStatus === "DATA_READY") ? "DATA_READY" : "BLOCKED_PROVIDER_COVERAGE",
  finalHoldoutDataStatus: "LOCKED_NOT_EVALUATED",
  bitgetLongFundingStatus: "BLOCKED_PROVIDER_COVERAGE",
  syntheticDataUsedAsReal: false,
  interpolationUsed: false,
  privateApiUsed: false,
  orderSubmitted: false,
  finalHoldoutRead: false,
});
await writeFile(resolve(outputRoot, "binance-scalping-provider-audit.json"), `${JSON.stringify(auditArtifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ selectionDataStatus: auditArtifact.selectionDataStatus, liveTailStatus: auditArtifact.liveTailStatus, datasets: audits.map((row) => ({ symbol: row.symbol, selectionDataStatus: row.selectionDataStatus })), privateApiUsed: false, orderSubmitted: false, finalHoldoutRead: false }));

if (auditArtifact.selectionDataStatus !== "DATA_READY") process.exitCode = 1;
