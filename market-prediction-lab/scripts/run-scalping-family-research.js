import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { BITGET_STANDARD_TAKER_RESEARCH_COSTS } from "../src/historical-backtest-data.js";
import { assertScalpingChunkIntegrity } from "../src/scalping-history-provider.js";
import { runScalpingFamilyResearch, SCALPING_ADAPTER_CONTRACTS } from "../src/scalping-family-research.js";

const historyRoot = resolve(process.argv[2] ?? "scalping-history-cache");
const binanceRoot = resolve(process.argv[3] ?? "binance-scalping-cache");
const rawOutput = resolve(process.argv[4] ?? "artifacts/automated-research/scalping-family-raw-results.json");
const rankingOutput = resolve(process.argv[5] ?? "artifacts/automated-research/scalping-family-ranking.json");
const researchCodeSha = process.env.RESEARCH_CODE_SHA ?? null;
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("RESEARCH_CODE_SHA must be immutable SHA");

const BINANCE_FUTURES_COSTS = Object.freeze({ entryFeeRate: 0.0006, exitFeeRate: 0.0006, taxRate: 0, slippageRate: 0.0002, spreadRate: 0.0002, latencyBars: 0, latencyDriftRate: 0 });
const COST_ASSUMPTION = "conservative_generic_perpetual_taker_assumption_not_historical_binance_fee_claim";
const INITIAL_CAPITAL = 1_000_000;
const FINAL_HOLDOUT_START = RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime;

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

async function loadSpot(symbol, researchSymbol) {
  const root = resolve(historyRoot, "crypto_spot", symbol, "15m");
  const manifest = await readJson(resolve(root, "manifest.json"));
  if (manifest.status !== "DATA_READY") throw new Error(`SPOT_DATA_NOT_READY:${symbol}:${manifest.status}`);
  if (manifest.collectionCodeSHA !== researchCodeSha) throw new Error(`SPOT_SHA_MISMATCH:${symbol}`);
  const filenames = (await readdir(root)).filter((name) => /^\d{4}-[0-9a-f]{64}\.json$/u.test(name)).sort();
  if (filenames.length !== manifest.readyChunkCount) throw new Error(`SPOT_CHUNK_COUNT_MISMATCH:${symbol}`);
  const map = new Map();
  for (const filename of filenames) {
    const chunk = await readJson(resolve(root, filename));
    assertScalpingChunkIntegrity(chunk);
    for (const row of chunk.normalizedCandles) if (row.timestamp < FINAL_HOLDOUT_START) map.set(row.timestamp, Object.freeze({ ...row, symbol: researchSymbol }));
  }
  const candles = Object.freeze([...map.values()].sort((a, b) => a.timestamp - b.timestamp));
  if (!candles.length || candles.some((row) => row.timestamp >= FINAL_HOLDOUT_START)) throw new Error(`SPOT_HOLDOUT_ISOLATION_FAILED:${symbol}`);
  return Object.freeze({
    market: "CRYPTO_SPOT",
    sourceSymbol: symbol,
    researchSymbol,
    side: "long",
    candles,
    fundingRates: Object.freeze([]),
    provider: manifest.provider,
    providerVersion: manifest.providerVersion,
    sourceDigest: manifest.normalizedDigest,
    selectionDataStatus: "DATA_READY",
    providerBoundary: "SAME_VENUE_BITGET_SPOT",
    priceVenue: "BITGET_SPOT",
    fundingVenue: null,
    crossVenueMix: false,
    costModel: BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_SPOT,
    costAssumption: "bitget_public_spot_research_cost_contract",
  });
}

async function loadBinance(symbol, side) {
  const bundle = await readJson(resolve(binanceRoot, `${symbol}.json`));
  if (bundle.collectionCodeSHA !== researchCodeSha) throw new Error(`BINANCE_SHA_MISMATCH:${symbol}`);
  if (bundle.audit?.selectionDataStatus !== "DATA_READY") throw new Error(`BINANCE_SELECTION_NOT_READY:${symbol}:${bundle.audit?.selectionDataStatus}`);
  if (bundle.audit?.providerBoundary !== "SAME_VENUE_BINANCE_USDM" || bundle.audit?.crossVenueMix !== false) throw new Error(`BINANCE_VENUE_BOUNDARY_FAILED:${symbol}`);
  if (bundle.audit?.finalHoldoutRead !== false) throw new Error(`BINANCE_HOLDOUT_ALREADY_READ:${symbol}`);
  const candles = Object.freeze((bundle.candles ?? []).filter((row) => row.timestamp < FINAL_HOLDOUT_START));
  const fundingRates = Object.freeze((bundle.fundingRates ?? []).filter((row) => row.timestamp < FINAL_HOLDOUT_START));
  if (!candles.length || !fundingRates.length || candles.some((row) => row.timestamp >= FINAL_HOLDOUT_START) || fundingRates.some((row) => row.timestamp >= FINAL_HOLDOUT_START)) throw new Error(`BINANCE_HOLDOUT_ISOLATION_FAILED:${symbol}`);
  return Object.freeze({
    market: "CRYPTO_FUTURES",
    sourceSymbol: symbol,
    researchSymbol: symbol,
    side,
    candles,
    fundingRates,
    provider: bundle.audit.provider,
    providerVersion: bundle.audit.providerVersion,
    sourceDigest: bundle.audit.normalizedCandleDigest,
    fundingDigest: bundle.audit.normalizedFundingDigest,
    selectionDataStatus: bundle.audit.selectionDataStatus,
    providerBoundary: bundle.audit.providerBoundary,
    priceVenue: bundle.audit.priceVenue,
    fundingVenue: bundle.audit.fundingVenue,
    crossVenueMix: bundle.audit.crossVenueMix,
    costModel: BINANCE_FUTURES_COSTS,
    costAssumption: COST_ASSUMPTION,
  });
}

function normalizeCandidate(group, familyRow, candidate) {
  const oos = candidate.oos ?? candidate.oosMetrics ?? null;
  const development = candidate.development ?? candidate.developmentMetrics ?? null;
  const walkForward = candidate.walkForward ?? null;
  const overfit = candidate.overfitDiagnostics ?? null;
  const statistical = candidate.statisticalQuality ?? null;
  const candidateId = candidate.candidateId ?? candidate.id ?? null;
  const status = candidate.researchStatus ?? "research_hold";
  return Object.freeze({
    group,
    family: familyRow.contract.family,
    structuralFamily: familyRow.contract.structuralFamily,
    version: familyRow.version,
    candidateId,
    market: candidate.market ?? null,
    symbol: candidate.symbol ?? null,
    direction: candidate.direction ?? null,
    parameters: candidate.parameters ?? null,
    filter: candidate.filter ?? null,
    developmentTradeCount: development?.tradeCount ?? null,
    oosTradeCount: oos?.tradeCount ?? null,
    wfTradeCount: (walkForward?.windows ?? []).reduce((sum, row) => sum + (row.tradeCount ?? 0), 0),
    expectancy: oos?.expectancy ?? null,
    profitFactor: oos?.profitFactor ?? null,
    totalReturn: oos?.totalReturn ?? null,
    MDD: oos?.maximumDrawdown ?? null,
    sharpe: oos?.sharpe ?? null,
    winRate: oos?.winRate ?? null,
    turnover: oos?.turnover ?? null,
    statisticalQuality: statistical,
    concentration: oos?.concentration ?? null,
    regimePerformance: oos?.regimePerformance ?? null,
    overfitDiagnostics: overfit,
    wfStability: walkForward?.stability ?? null,
    researchStatus: status,
    finalHoldoutUsed: false,
  });
}

function compareRank(left, right) {
  const status = (row) => row.researchStatus === "candidate" ? 1 : 0;
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  return status(right) - status(left)
    || finite(right.totalReturn, -Infinity) - finite(left.totalReturn, -Infinity)
    || finite(right.expectancy, -Infinity) - finite(left.expectancy, -Infinity)
    || finite(right.profitFactor, -Infinity) - finite(left.profitFactor, -Infinity)
    || String(left.candidateId).localeCompare(String(right.candidateId));
}

const requestedDatasetKey = process.env.SCALPING_DATASET_KEY ?? null;
const requestedFamilyVersion = process.env.SCALPING_FAMILY_VERSION ?? null;
if (requestedFamilyVersion != null && !Object.hasOwn(SCALPING_ADAPTER_CONTRACTS, requestedFamilyVersion)) throw new Error(`UNKNOWN_SCALPING_FAMILY_VERSION:${requestedFamilyVersion}`);
const datasetLoaders = Object.freeze([
  Object.freeze({ key: "spot-btc-long", load: () => loadSpot("BTCUSDT", "USDT-BTC") }),
  Object.freeze({ key: "spot-eth-long", load: () => loadSpot("ETHUSDT", "USDT-ETH") }),
  Object.freeze({ key: "futures-btc-long", load: () => loadBinance("BTCUSDT", "long") }),
  Object.freeze({ key: "futures-eth-long", load: () => loadBinance("ETHUSDT", "long") }),
  Object.freeze({ key: "futures-btc-short", load: () => loadBinance("BTCUSDT", "short") }),
  Object.freeze({ key: "futures-eth-short", load: () => loadBinance("ETHUSDT", "short") }),
]);
const selectedLoaders = requestedDatasetKey == null ? datasetLoaders : datasetLoaders.filter((row) => row.key === requestedDatasetKey);
if (selectedLoaders.length === 0) throw new Error(`UNKNOWN_SCALPING_DATASET_KEY:${requestedDatasetKey}`);
const datasets = [];
for (const descriptor of selectedLoaders) datasets.push(Object.freeze({ ...(await descriptor.load()), datasetKey: descriptor.key }));

const results = [];
for (const dataset of datasets) {
  const group = dataset.market === "CRYPTO_SPOT" ? "CRYPTO_SPOT_SCALPING" : `BINANCE_FUTURES_SCALPING_${dataset.side.toUpperCase()}`;
  const research = runScalpingFamilyResearch({
    backtestInput: Object.freeze({
      market: dataset.market,
      symbol: dataset.researchSymbol,
      side: dataset.side,
      timeframe: "15m",
      initialCapital: INITIAL_CAPITAL,
      candles: dataset.candles,
      fundingRates: dataset.fundingRates,
      costModel: dataset.costModel,
      riskModel: Object.freeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 }),
      dataCoverage: Object.freeze({ sufficient: true, ratio: 1 }),
    }),
    ...(requestedFamilyVersion == null ? {} : { versions: [requestedFamilyVersion] }),
  });
  results.push(Object.freeze({
    group,
    source: Object.freeze({ datasetKey: dataset.datasetKey, market: dataset.market, symbol: dataset.sourceSymbol, provider: dataset.provider, providerVersion: dataset.providerVersion, sourceDigest: dataset.sourceDigest, fundingDigest: dataset.fundingDigest ?? null, providerBoundary: dataset.providerBoundary, priceVenue: dataset.priceVenue, fundingVenue: dataset.fundingVenue, crossVenueMix: dataset.crossVenueMix, selectionDataStatus: dataset.selectionDataStatus, costAssumption: dataset.costAssumption }),
    research,
  }));
}

const rawCandidates = Object.freeze(results.flatMap((row) => row.research.families.flatMap((family) => family.candidates.map((candidate) => normalizeCandidate(row.group, family, candidate)))));
const familyTesting = Object.freeze(results.flatMap((row) => row.research.families.map((family) => Object.freeze({
  group: row.group,
  symbol: row.research.symbol,
  direction: row.research.direction,
  strategyFamily: family.contract.family,
  structuralFamily: family.contract.structuralFamily,
  candidateFamily: family.contract.family,
  parameterCount: family.parameterCount,
  developmentAttempts: family.developmentAttempts,
  oosAdmissions: family.oosAdmissions,
  wfAdmissions: family.wfAdmissions,
  totalCandidatesTested: family.totalCandidatesTested,
}))));
const globalTesting = Object.freeze({
  strategyFamilyCount: new Set(familyTesting.map((row) => row.strategyFamily)).size,
  structuralFamilyCount: new Set(familyTesting.map((row) => row.structuralFamily)).size,
  developmentAttempts: familyTesting.reduce((sum, row) => sum + row.developmentAttempts, 0),
  oosAdmissions: familyTesting.reduce((sum, row) => sum + row.oosAdmissions, 0),
  wfAdmissions: familyTesting.reduce((sum, row) => sum + row.wfAdmissions, 0),
  totalCandidatesTested: familyTesting.reduce((sum, row) => sum + row.totalCandidatesTested, 0),
  dataSnoopingRisk: "bounded_family_search_recorded; no search-until-positive loop; final holdout locked",
});

const crossSymbol = [];
for (const group of ["CRYPTO_SPOT_SCALPING", "BINANCE_FUTURES_SCALPING_LONG", "BINANCE_FUTURES_SCALPING_SHORT"]) {
  for (const version of ["V2", "V3", "V4", "V5", "V6"]) {
    const rows = rawCandidates.filter((row) => row.group === group && row.version === version);
    const symbols = [...new Set(rows.map((row) => row.symbol).filter(Boolean))].sort();
    const positive = rows.filter((row) => (row.totalReturn ?? 0) > 0 && (row.expectancy ?? 0) > 0).length;
    crossSymbol.push(Object.freeze({ group, version, validation: "preliminary", symbolCount: symbols.length, symbols: Object.freeze(symbols), candidateObservations: rows.length, positiveObservationRatio: rows.length ? positive / rows.length : null, fullMarketStabilityValidated: false, candidateFreezeAllowed: false, finalHoldoutQueueAllowed: false }));
  }
}

const rawArtifact = Object.freeze({
  schemaVersion: 1,
  mode: "scalping-v2-v6-bounded-family-raw-results",
  researchCodeSha,
  shard: Object.freeze({ datasetKey: requestedDatasetKey, familyVersion: requestedFamilyVersion, completeMatrix: requestedDatasetKey == null && requestedFamilyVersion == null }),
  selectionPeriod: Object.freeze({ start: RESEARCH_BACKTEST_PERIOD.startTime, end: RESEARCH_BACKTEST_PERIOD.validationEndTime }),
  finalHoldoutPeriod: Object.freeze({ start: FINAL_HOLDOUT_START, status: "LOCKED_NOT_EVALUATED" }),
  adapterContracts: SCALPING_ADAPTER_CONTRACTS,
  results: Object.freeze(results),
  candidates: rawCandidates,
  multipleTesting: Object.freeze({ byFamily: familyTesting, global: globalTesting }),
  crossSymbolValidation: Object.freeze(crossSymbol),
  finalHoldoutUsed: false,
  finalHoldoutRead: false,
  topStrategy: "NONE",
  syntheticDataUsedAsReal: false,
  privateApiUsed: false,
  orderSubmitted: false,
});

const rankedGroups = Object.freeze(["CRYPTO_SPOT_SCALPING", "BINANCE_FUTURES_SCALPING_LONG", "BINANCE_FUTURES_SCALPING_SHORT"].map((group) => Object.freeze({
  group,
  rankingBasis: "research-only lexicographic: existing researchStatus, OOS totalReturn, expectancy, PF; not a promotion gate",
  rows: Object.freeze(rawCandidates.filter((row) => row.group === group).sort(compareRank)),
  topStrategy: "NONE",
  candidateFreezeAllowed: false,
  finalHoldoutQueueAllowed: false,
})));
const rankingArtifact = Object.freeze({
  schemaVersion: 1,
  mode: "scalping-v2-v6-research-ranking",
  researchCodeSha,
  shard: Object.freeze({ datasetKey: requestedDatasetKey, familyVersion: requestedFamilyVersion, completeMatrix: requestedDatasetKey == null && requestedFamilyVersion == null }),
  rawResultsPath: rawOutput,
  groups: rankedGroups,
  gateCalibrationStatus: "RESEARCH_ONLY_NOT_FINAL_PROMOTION_GATE",
  topStrategy: "NONE",
  finalHoldoutUsed: false,
  finalHoldoutRead: false,
  candidateFreezeAllowed: false,
  finalHoldoutQueueAllowed: false,
  productionMutationAllowed: false,
  privateApiUsed: false,
  orderSubmitted: false,
});

await writeJson(rawOutput, rawArtifact);
await writeJson(rankingOutput, rankingArtifact);
console.log(JSON.stringify({ researchCodeSha, shard: { datasetKey: requestedDatasetKey, familyVersion: requestedFamilyVersion }, groups: rankedGroups.map((row) => ({ group: row.group, candidates: row.rows.length })), multipleTesting: globalTesting, topStrategy: "NONE", finalHoldoutUsed: false, privateApiUsed: false, orderSubmitted: false }));
