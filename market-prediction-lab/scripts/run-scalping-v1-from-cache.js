import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertScalpingChunkIntegrity, scalpingDigest } from "../src/scalping-history-provider.js";
import { assertScalpingFundingIntegrity } from "../src/scalping-funding-provider.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "../src/historical-backtest-data.js";
import {
  buildScalpingCrossSymbolDiagnostics,
  runScalpingV1Research,
} from "../src/scalping-v1-research.js";

const historyRoot = resolve(process.argv[2] ?? "scalping-history-cache");
const fundingRoot = resolve(process.argv[3] ?? "scalping-funding-cache");
const outputPath = resolve(process.argv[4] ?? "artifacts/automated-research/scalping-v1-research.json");
const calibrationPath = resolve(process.argv[5] ?? "artifacts/automated-research/scalping-gate-calibration-candidates.json");
const researchCodeSha = process.env.RESEARCH_CODE_SHA ?? null;
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("RESEARCH_CODE_SHA must be an immutable 40-character SHA");

const DATASETS = Object.freeze([
  Object.freeze({ market: "CRYPTO_SPOT", symbol: "BTCUSDT", researchSymbol: "USDT-BTC", sides: Object.freeze(["long"]) }),
  Object.freeze({ market: "CRYPTO_SPOT", symbol: "ETHUSDT", researchSymbol: "USDT-ETH", sides: Object.freeze(["long"]) }),
  Object.freeze({ market: "CRYPTO_FUTURES", symbol: "BTCUSDT", researchSymbol: "BTCUSDT", sides: Object.freeze(["long", "short"]) }),
  Object.freeze({ market: "CRYPTO_FUTURES", symbol: "ETHUSDT", researchSymbol: "ETHUSDT", sides: Object.freeze(["long", "short"]) }),
]);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function datasetDir(dataset) {
  return resolve(historyRoot, dataset.market.toLowerCase(), dataset.symbol, "15m");
}

async function loadDataReadyCandles(dataset) {
  const root = datasetDir(dataset);
  const manifest = await readJson(resolve(root, "manifest.json"));
  if (manifest.status !== "DATA_READY") return Object.freeze({ status: manifest.status, manifest, candles: Object.freeze([]) });
  if (manifest.collectionCodeSHA !== researchCodeSha) throw new Error(`SCALPING_HISTORY_SHA_MISMATCH:${dataset.market}:${dataset.symbol}`);
  const filenames = (await readdir(root)).filter((name) => /^\d{4}-[0-9a-f]{64}\.json$/u.test(name)).sort();
  if (filenames.length !== manifest.readyChunkCount) throw new Error(`SCALPING_CHUNK_COUNT_MISMATCH:${dataset.market}:${dataset.symbol}`);
  const rows = [];
  for (const filename of filenames) {
    const chunk = await readJson(resolve(root, filename));
    assertScalpingChunkIntegrity(chunk);
    rows.push(...chunk.normalizedCandles);
  }
  const unique = new Map();
  for (const candle of rows) unique.set(candle.timestamp, Object.freeze({ ...candle, symbol: dataset.researchSymbol }));
  const candles = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length !== manifest.actualCandleCount) throw new Error(`SCALPING_AGGREGATE_COUNT_MISMATCH:${dataset.market}:${dataset.symbol}`);
  const aggregateDigest = scalpingDigest({ market: dataset.market, symbol: dataset.symbol, timeframe: "15m", candles: rows.map((row) => ({ ...row })) });
  return Object.freeze({ status: "DATA_READY", manifest, candles: Object.freeze(candles), aggregateDigest });
}

async function loadFunding(dataset) {
  if (dataset.market !== "CRYPTO_FUTURES") return Object.freeze({ status: "NOT_APPLICABLE", records: Object.freeze([]), artifact: null });
  const artifact = await readJson(resolve(fundingRoot, `${dataset.symbol}.funding.json`));
  if (artifact.status !== "DATA_READY") return Object.freeze({ status: artifact.status, records: Object.freeze([]), artifact });
  if (artifact.collectionCodeSHA !== researchCodeSha) throw new Error(`SCALPING_FUNDING_SHA_MISMATCH:${dataset.symbol}`);
  assertScalpingFundingIntegrity(artifact);
  return Object.freeze({ status: "DATA_READY", records: artifact.records, artifact });
}

function rawCandidateRow(result, candidate) {
  const lastWf = candidate.walkForward.windows.at(-1) ?? null;
  return Object.freeze({
    market: result.market,
    strategy: "V1_EMA_ATR",
    version: "V1",
    symbol: result.symbol,
    direction: result.side === "short" ? "SHORT" : "LONG",
    timeframe: result.timeframe,
    parameterSet: candidate.parameters,
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
    Sharpe: candidate.oosMetrics.sharpe,
    winRate: candidate.oosMetrics.winRate,
    payoffRatio: candidate.oosMetrics.averageLoss ? Math.abs((candidate.oosMetrics.averageWin ?? 0) / candidate.oosMetrics.averageLoss) : null,
    exposure: null,
    turnover: candidate.oosMetrics.turnover,
    feesSpreadSlippageCostImpact: candidate.oosMetrics.costImpact,
    stability: candidate.walkForward.stability,
    regimeDependency: candidate.overfitDiagnostics?.profitableRegimeRatio,
    symbolDependency: null,
    topTradeDependency: candidate.overfitDiagnostics?.topTwoWinnerShare,
    concentrationPenalty: candidate.overfitPenaltyPoints,
    developmentToOosDegradation: candidate.overfitDiagnostics?.developmentToOosReturnRetention,
    wfWindowDispersion: candidate.walkForward.stability?.returnDispersion ?? null,
    recentWalkForwardReturn: lastWf?.totalReturn ?? null,
    qualityScore: candidate.qualityScore,
    researchStatus: candidate.researchStatus,
    finalHoldoutUsed: false,
  });
}

const results = [];
const blocked = [];
const dataAudit = [];
for (const dataset of DATASETS) {
  const history = await loadDataReadyCandles(dataset);
  const funding = await loadFunding(dataset);
  dataAudit.push(Object.freeze({
    market: dataset.market,
    symbol: dataset.symbol,
    candleStatus: history.status,
    fundingStatus: funding.status,
    candleManifestDigest: history.manifest?.manifestDigest ?? null,
    fundingDigest: funding.artifact?.normalizedDigest ?? null,
  }));
  if (history.status !== "DATA_READY") {
    blocked.push(Object.freeze({ market: dataset.market, symbol: dataset.symbol, reason: "CANDLE_DATA_NOT_READY", status: history.status }));
    continue;
  }
  if (dataset.market === "CRYPTO_FUTURES" && funding.status !== "DATA_READY") {
    blocked.push(Object.freeze({ market: dataset.market, symbol: dataset.symbol, reason: "FUNDING_DATA_NOT_READY", status: funding.status }));
    continue;
  }
  for (const side of dataset.sides) {
    const dataCoverage = Object.freeze({
      sufficient: history.manifest.status === "DATA_READY",
      ratio: history.manifest.expectedCandleCount > 0 ? history.manifest.actualCandleCount / history.manifest.expectedCandleCount : null,
    });
    const result = runScalpingV1Research({
      backtestInput: {
        market: dataset.market,
        symbol: dataset.researchSymbol,
        side,
        timeframe: "15m",
        initialCapital: 1_000_000,
        candles: history.candles,
        fundingRates: funding.records,
        costModel: BITGET_STANDARD_TAKER_RESEARCH_COSTS[dataset.market],
        riskModel: Object.freeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 }),
        dataCoverage,
      },
    });
    results.push(Object.freeze({
      ...result,
      sourceDataset: Object.freeze({
        provider: history.manifest.provider,
        providerVersion: history.manifest.providerVersion,
        manifestDigest: history.manifest.manifestDigest,
        rawDigest: history.manifest.rawDigest,
        normalizedDigest: history.manifest.normalizedDigest,
        fundingProvider: funding.artifact?.provider ?? null,
        fundingProviderVersion: funding.artifact?.providerVersion ?? null,
        fundingDigest: funding.artifact?.normalizedDigest ?? null,
      }),
    }));
  }
}

const crossSymbolDiagnostics = buildScalpingCrossSymbolDiagnostics(results);
const rawCandidates = results.flatMap((result) => result.candidates.map((candidate) => rawCandidateRow(result, candidate)));
const artifact = Object.freeze({
  schemaVersion: 1,
  mode: "real-public-scalping-v1-research",
  researchCodeSha,
  timeframe: "15m",
  strategyVersion: "V1",
  dataAudit: Object.freeze(dataAudit),
  blocked: Object.freeze(blocked),
  results: Object.freeze(results),
  crossSymbolDiagnostics,
  finalHoldoutStatus: "LOCKED",
  finalHoldoutExecuted: false,
  topStrategy: null,
  syntheticDataUsedAsReal: false,
  interpolationUsed: false,
  branchWrite: false,
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
  privateApiUsed: false,
  orderSubmitted: false,
});
const calibration = Object.freeze({
  schemaVersion: 1,
  mode: "scalping-gate-calibration-candidates",
  researchCodeSha,
  thresholdCalibrationOnly: true,
  numericPfMddWfGatesConfigured: false,
  candidates: Object.freeze(rawCandidates),
  candidateCount: rawCandidates.length,
  finalHoldoutUsed: false,
  syntheticDataUsedAsReal: false,
  privateApiUsed: false,
  orderSubmitted: false,
});
await writeJson(outputPath, artifact);
await writeJson(calibrationPath, calibration);
console.log(JSON.stringify({
  results: results.map((row) => ({ market: row.market, symbol: row.symbol, side: row.side, candidateCounts: row.candidateCounts, oosTrades: row.candidates.map((candidate) => candidate.oosTradeCount), statuses: [...new Set(row.candidates.map((candidate) => candidate.researchStatus))] })),
  blocked,
  rawCandidateCount: rawCandidates.length,
  finalHoldoutExecuted: false,
  topStrategy: null,
  privateApiUsed: false,
  orderSubmitted: false,
}));
