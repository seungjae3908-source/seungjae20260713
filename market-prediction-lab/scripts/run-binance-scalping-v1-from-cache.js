import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runScalpingV1Research, buildScalpingCrossSymbolDiagnostics } from "../src/scalping-v1-research.js";

const inputRoot = resolve(process.argv[2] ?? "binance-scalping-cache");
const outputPath = resolve(process.argv[3] ?? "artifacts/automated-research/binance-scalping-v1-research.json");
const calibrationPath = resolve(process.argv[4] ?? "artifacts/automated-research/binance-scalping-gate-calibration-candidates.json");
const researchCodeSha = process.env.RESEARCH_CODE_SHA ?? null;
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("RESEARCH_CODE_SHA must be immutable 40-character SHA");

const CONSERVATIVE_FUTURES_RESEARCH_COSTS = Object.freeze({
  entryFeeRate: 0.0006,
  exitFeeRate: 0.0006,
  taxRate: 0,
  slippageRate: 0.0002,
  spreadRate: 0.0002,
  latencyBars: 0,
  latencyDriftRate: 0,
});
const COST_ASSUMPTION = "conservative_generic_perpetual_taker_assumption_not_historical_binance_fee_claim";

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function calibrationRow(result, candidate) {
  return Object.freeze({
    market: result.market,
    researchVenue: "BINANCE_USDM",
    providerBoundary: "SAME_VENUE_BINANCE_USDM",
    strategy: "V1_EMA_ATR",
    version: "V1",
    candidateFamily: "EMA_ATR",
    symbol: result.symbol,
    direction: result.side.toUpperCase(),
    timeframe: result.timeframe,
    parameters: candidate.parameters,
    parameterCount: Object.keys(candidate.parameters ?? {}).length,
    developmentTradeCount: candidate.developmentTradeCount,
    oosTradeCount: candidate.oosTradeCount,
    wfTradeCount: candidate.wfTradeCount,
    totalIndependentTrades: candidate.totalIndependentTrades,
    sampleQuality: candidate.sampleQuality,
    lowSamplePenalty: candidate.lowSamplePenalty,
    expectancy: candidate.oosMetrics.expectancy,
    profitFactor: candidate.oosMetrics.profitFactor,
    totalReturn: candidate.oosMetrics.totalReturn,
    MDD: candidate.oosMetrics.maximumDrawdown,
    sharpe: candidate.oosMetrics.sharpe,
    winRate: candidate.oosMetrics.winRate,
    turnover: candidate.oosMetrics.turnover,
    stability: candidate.walkForward.stability,
    regimeDependency: candidate.overfitDiagnostics?.profitableRegimeRatio ?? null,
    topTradeDependency: candidate.overfitDiagnostics?.topTwoWinnerShare ?? null,
    concentrationPenalty: candidate.overfitPenaltyPoints,
    developmentToOosDegradation: candidate.overfitDiagnostics?.developmentToOosReturnRetention ?? null,
    wfWindowDispersion: candidate.walkForward.stability?.returnDispersion ?? null,
    qualityScore: candidate.qualityScore,
    researchStatus: candidate.researchStatus,
    finalHoldoutUsed: false,
  });
}

const results = [];
const blocked = [];
const dataAudit = [];
let developmentAttempts = 0;
let oosAdmissions = 0;
let wfAdmissions = 0;
for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
  const bundle = await readJson(resolve(inputRoot, `${symbol}.json`));
  if (bundle.collectionCodeSHA !== researchCodeSha) throw new Error(`BINANCE_SCALPING_SHA_MISMATCH:${symbol}`);
  if (bundle.audit?.providerBoundary !== "SAME_VENUE_BINANCE_USDM" || bundle.audit?.priceVenue !== "BINANCE_USDM" || bundle.audit?.fundingVenue !== "BINANCE_USDM" || bundle.audit?.crossVenueMix !== false) {
    throw new Error(`BINANCE_SCALPING_PROVIDER_BOUNDARY_MISMATCH:${symbol}`);
  }
  if (bundle.audit?.finalHoldoutDataStatus !== "LOCKED_NOT_EVALUATED" || bundle.audit?.finalHoldoutRead !== false) {
    throw new Error(`BINANCE_SCALPING_FINAL_HOLDOUT_CONTRACT_VIOLATION:${symbol}`);
  }
  dataAudit.push(bundle.audit);
  if (bundle.audit?.selectionDataStatus !== "DATA_READY") {
    blocked.push(Object.freeze({ market: "CRYPTO_FUTURES", researchVenue: "BINANCE_USDM", symbol, status: bundle.audit?.selectionDataStatus ?? "BLOCKED_PROVIDER_COVERAGE", reason: "SELECTION_DATA_NOT_READY" }));
    continue;
  }
  for (const side of ["long", "short"]) {
    const result = runScalpingV1Research({
      backtestInput: {
        market: "CRYPTO_FUTURES",
        symbol,
        side,
        timeframe: "15m",
        initialCapital: 1_000_000,
        candles: bundle.candles,
        fundingRates: bundle.fundingRates,
        costModel: CONSERVATIVE_FUTURES_RESEARCH_COSTS,
        riskModel: Object.freeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 }),
        dataCoverage: Object.freeze({ sufficient: true, ratio: bundle.audit.actualCandleCount / bundle.audit.expectedCandleCount }),
      },
    });
    developmentAttempts += result.candidateCounts?.development ?? 0;
    oosAdmissions += result.candidateCounts?.oos ?? result.candidates.length;
    wfAdmissions += result.candidates.filter((candidate) => (candidate.walkForward?.windows?.length ?? 0) > 0).length;
    results.push(Object.freeze({
      ...result,
      researchVenue: "BINANCE_USDM",
      priceVenue: "BINANCE_USDM",
      fundingVenue: "BINANCE_USDM",
      providerBoundary: "SAME_VENUE_BINANCE_USDM",
      compatibilityVerdict: "same_venue_price_and_funding_no_cross_venue_mix",
      executionCostAssumption: COST_ASSUMPTION,
      selectionDataStatus: bundle.audit.selectionDataStatus,
      finalHoldoutDataStatus: bundle.audit.finalHoldoutDataStatus,
      liveTailStatus: bundle.audit.liveTailStatus,
      sourceDataset: Object.freeze({
        provider: bundle.audit.provider,
        providerVersion: bundle.audit.providerVersion,
        rawCandleDigest: bundle.audit.rawCandleDigest,
        normalizedCandleDigest: bundle.audit.normalizedCandleDigest,
        rawFundingDigest: bundle.audit.rawFundingDigest,
        normalizedFundingDigest: bundle.audit.normalizedFundingDigest,
        collectionCodeSHA: bundle.audit.collectionCodeSHA,
      }),
    }));
  }
}

const crossSymbolDiagnostics = buildScalpingCrossSymbolDiagnostics(results);
const candidates = results.flatMap((result) => result.candidates.map((candidate) => calibrationRow(result, candidate)));
const multipleTesting = Object.freeze({
  candidateFamily: "EMA_ATR",
  strategyFamilyCount: 1,
  parameterCount: 6,
  developmentAttempts,
  oosAdmissions,
  wfAdmissions,
  dataSnoopingRisk: "tracked_single_family_no_final_holdout_used",
  finalHoldoutUsed: false,
});
const artifact = Object.freeze({
  schemaVersion: 2,
  mode: "binance-usdm-same-venue-scalping-v1-selection-research",
  researchCodeSha,
  timeframe: "15m",
  researchVenue: "BINANCE_USDM",
  providerBoundary: "SAME_VENUE_BINANCE_USDM",
  priceVenue: "BINANCE_USDM",
  fundingVenue: "BINANCE_USDM",
  executionCostAssumption: COST_ASSUMPTION,
  selectionDataStatus: dataAudit.length > 0 && dataAudit.every((row) => row.selectionDataStatus === "DATA_READY") ? "DATA_READY" : "BLOCKED_PROVIDER_COVERAGE",
  finalHoldoutDataStatus: "LOCKED_NOT_EVALUATED",
  liveTailStatus: dataAudit[0]?.liveTailStatus ?? "BLOCKED_EXTERNAL_BINANCE_REST_GITHUB_RUNNER_LOCATION",
  dataAudit: Object.freeze(dataAudit),
  blocked: Object.freeze(blocked),
  results: Object.freeze(results),
  crossSymbolValidation: "preliminary",
  crossSymbolDiagnostics,
  multipleTesting,
  candidateFreezeAllowed: false,
  finalHoldoutQueueAllowed: false,
  finalHoldoutStatus: "LOCKED",
  finalHoldoutExecuted: false,
  finalHoldoutRead: false,
  topStrategy: null,
  syntheticDataUsedAsReal: false,
  interpolationUsed: false,
  privateApiUsed: false,
  orderSubmitted: false,
});
const calibration = Object.freeze({
  schemaVersion: 2,
  mode: "binance-scalping-selection-gate-calibration-candidates",
  researchCodeSha,
  researchVenue: "BINANCE_USDM",
  providerBoundary: "SAME_VENUE_BINANCE_USDM",
  selectionDataStatus: artifact.selectionDataStatus,
  finalHoldoutDataStatus: "LOCKED_NOT_EVALUATED",
  liveTailStatus: artifact.liveTailStatus,
  thresholdCalibrationOnly: true,
  numericPfMddWfGatesConfigured: false,
  multipleTesting,
  candidates: Object.freeze(candidates),
  candidateCount: candidates.length,
  finalHoldoutUsed: false,
  finalHoldoutRead: false,
  syntheticDataUsedAsReal: false,
  privateApiUsed: false,
  orderSubmitted: false,
});
await writeJson(outputPath, artifact);
await writeJson(calibrationPath, calibration);
console.log(JSON.stringify({
  selectionData: dataAudit.map((row) => ({ symbol: row.symbol, selectionDataStatus: row.selectionDataStatus, liveTailStatus: row.liveTailStatus })),
  results: results.map((row) => ({ symbol: row.symbol, side: row.side, candidateCounts: row.candidateCounts, oosTrades: row.candidates.map((candidate) => candidate.oosTradeCount), statuses: [...new Set(row.candidates.map((candidate) => candidate.researchStatus))] })),
  blocked,
  candidateCount: candidates.length,
  multipleTesting,
  topStrategy: null,
  finalHoldoutExecuted: false,
  finalHoldoutRead: false,
  privateApiUsed: false,
  orderSubmitted: false,
}));

if (blocked.length > 0) process.exitCode = 1;
