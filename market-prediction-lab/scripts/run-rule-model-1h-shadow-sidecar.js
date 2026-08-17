import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyzeMarket } from "../src/engine.js";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles, collectBitgetFuturesContext } from "../src/bitget-candle-collector.js";
import { collectFundingRateHistory, createTemporalDerivativesProvider } from "../src/derivatives-history.js";
import {
  createShadowPrediction,
  settleShadowPrediction,
  summarizeShadowState,
  upsertShadowPrediction,
} from "../src/shadow-ledger.js";
import {
  assertForwardOnlyChallengerState,
  buildRuleModelShadowPair,
  evaluateRuleModelShadowChallenger,
  RULE_MODEL_1H_CHALLENGER_GROUP,
  verifyFrozenShadowChallengerModel,
} from "../src/rule-model-shadow-challenger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIG = Object.freeze({
  timeframe: "1h",
  horizon: 12,
  lookback: 200,
  days: 15,
  symbols: Object.freeze(["BTCUSDT", "ETHUSDT"]),
});

async function readJsonOptional(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function addOpenInterestSnapshot(snapshots, symbol, context) {
  if (!context.openInterestRaw) return snapshots;
  const timestamp = Number(context.openInterestTimestamp ?? context.collectedAt);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return snapshots;
  const next = [...snapshots];
  const candidate = { symbol, timestamp, valueRaw: context.openInterestRaw };
  const existing = next.find((row) => row.symbol === symbol && row.timestamp === timestamp);
  if (existing && existing.valueRaw !== candidate.valueRaw) throw new Error(`open-interest conflict at ${symbol}:${timestamp}`);
  if (!existing) next.push(candidate);
  next.sort((left, right) => left.timestamp - right.timestamp || left.symbol.localeCompare(right.symbol));
  return next.slice(-5000);
}

function settleAvailable(state, candlesBySymbol) {
  const records = (state.records ?? []).map((record) => {
    if (record.status !== "pending") return record;
    const future = (candlesBySymbol[record.symbol] ?? [])
      .filter((candle) => candle.timestamp > record.anchorTimestamp)
      .slice(0, record.horizon);
    if (future.length < record.horizon) return record;
    return settleShadowPrediction(record, future);
  });
  return { ...state, records };
}

function probabilitiesClose(left, right, tolerance = 2e-6) {
  return ["bullish", "neutral", "bearish"].every((name) => Math.abs(left[name] - right[name]) <= tolerance);
}

const statePath = resolve(process.argv[2] ?? "docs/rule-model-1h-shadow-state.json");
const summaryPath = resolve(process.argv[3] ?? "docs/rule-model-1h-shadow-summary.json");
const frozenPath = resolve(process.argv[4] ?? "docs/rule-model-1h-shadow-model.json");
const cycleTime = Date.now();
const frozenArtifact = await readJsonOptional(frozenPath, null);
const verified = verifyFrozenShadowChallengerModel(frozenArtifact);
const model = verified.model;
const previous = await readJsonOptional(statePath, null);
if (previous) assertForwardOnlyChallengerState(previous);

const client = new BitgetPublicClient({ minIntervalMs: 180, maxRetries: 4, timeoutMs: 12_000 });
const candlesBySymbol = {};
const fundingBySymbol = {};
const contextBySymbol = {};
let openInterestSnapshots = [...(previous?.openInterestSnapshots ?? [])];

for (const symbol of CONFIG.symbols) {
  const endTime = Date.now();
  const startTime = endTime - CONFIG.days * DAY_MS;
  const snapshot = await collectBitgetCandles({
    client,
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: CONFIG.timeframe,
    startTime,
    endTime,
  });
  candlesBySymbol[symbol] = snapshot.candles;
  fundingBySymbol[symbol] = await collectFundingRateHistory({
    client,
    symbol,
    startTime: startTime - 12 * 60 * 60 * 1000,
    endTime,
  });
  const context = await collectBitgetFuturesContext({ client, symbol });
  contextBySymbol[symbol] = {
    openInterestRaw: context.openInterestRaw,
    openInterestTimestamp: context.openInterestTimestamp,
    fundingRateRaw: context.fundingRateRaw,
    markPriceRaw: context.markPriceRaw,
  };
  openInterestSnapshots = addOpenInterestSnapshot(openInterestSnapshots, symbol, context);
}

const anchors = CONFIG.symbols.map((symbol) => candlesBySymbol[symbol]?.at(-1)?.timestamp)
  .filter((value) => Number.isInteger(value) && value > 0);
if (anchors.length !== CONFIG.symbols.length) throw new Error("missing current challenger anchors");
const challengerStartedAt = previous?.challengerStartedAt ?? Math.min(...anchors);
let state = settleAvailable({
  schemaVersion: 1,
  challengerStartedAt,
  createdAt: previous?.createdAt ?? cycleTime,
  updatedAt: cycleTime,
  openInterestSnapshots,
  records: [...(previous?.records ?? [])],
}, candlesBySymbol);

for (const symbol of CONFIG.symbols) {
  const candles = candlesBySymbol[symbol];
  if (!Array.isArray(candles) || candles.length < CONFIG.lookback) {
    throw new Error(`not enough challenger candles for ${symbol}`);
  }
  const history = candles.slice(-CONFIG.lookback);
  const anchor = history.at(-1);
  if (anchor.timestamp < challengerStartedAt) throw new Error("historical challenger backfill is forbidden");
  const temporal = createTemporalDerivativesProvider({
    fundingHistory: fundingBySymbol[symbol].records,
    openInterestSnapshots: openInterestSnapshots.filter((row) => row.symbol === symbol),
    openInterestTrainingParityConfirmed: false,
  })({ anchorTimestamp: anchor.timestamp });
  if (temporal.featureAvailability.openInterestKnown !== false
      || temporal.derivativesFeatures.openInterestChange !== undefined) {
    throw new Error("open interest must remain inference-disabled until historical training parity is confirmed");
  }
  const input = {
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: CONFIG.timeframe,
    horizon: CONFIG.horizon,
    candles: history,
    derivativesFeatures: temporal.derivativesFeatures,
    marketFeatures: {},
    collectedAt: anchor.timestamp,
    source: "bitget-public-rule-model-1h-shadow-sidecar",
  };
  const deployedAnalysis = analyzeMarket(input, { model });
  const pair = buildRuleModelShadowPair({
    features: deployedAnalysis.features,
    ruleScore: deployedAnalysis.ruleScore,
    model,
  });
  if (!probabilitiesClose(deployedAnalysis.probabilities, pair.referenceProbabilities)) {
    throw new Error("65% reference inference no longer matches deployed analyzeMarket path");
  }
  const record = createShadowPrediction({
    modelGroup: RULE_MODEL_1H_CHALLENGER_GROUP,
    modelId: pair.challengerModelId,
    referenceModelId: pair.referenceModelId,
    symbol,
    timeframe: CONFIG.timeframe,
    anchorTimestamp: anchor.timestamp,
    horizon: CONFIG.horizon,
    lastClose: anchor.close,
    atrPct: deployedAnalysis.indicators.atrPct,
    candidateProbabilities: pair.challengerProbabilities,
    referenceProbabilities: pair.referenceProbabilities,
    features: deployedAnalysis.features,
    featureAvailability: temporal.featureAvailability,
    generatedAt: cycleTime,
  });
  if (!state.records.some((existing) => existing.id === record.id)) {
    const ledgerState = upsertShadowPrediction(state, record);
    state = {
      ...state,
      ...ledgerState,
      challengerStartedAt,
      openInterestSnapshots,
    };
  }
}

state = assertForwardOnlyChallengerState({ ...state, updatedAt: cycleTime, openInterestSnapshots });
const modelId = `${model.id}:rule-0.00`;
const referenceModelId = `${model.id}:rule-0.65`;
const metrics = summarizeShadowState(state, { modelId, referenceModelId });
const gate = evaluateRuleModelShadowChallenger(metrics);
const summary = Object.freeze({
  schemaVersion: 1,
  status: "pass",
  generatedAt: cycleTime,
  modelGroup: RULE_MODEL_1H_CHALLENGER_GROUP,
  modelId,
  referenceModelId,
  frozenModel: Object.freeze({
    sourceRunId: frozenArtifact.provenance.sourceRunId,
    sourceArtifactId: frozenArtifact.provenance.sourceArtifactId,
    sourceArtifactSha256: frozenArtifact.provenance.sourceArtifactSha256,
    sourceHeadSha: frozenArtifact.provenance.sourceHeadSha,
    modelObjectSha256: verified.modelObjectSha256,
  }),
  metrics,
  gate,
  contexts: contextBySymbol,
  safety: Object.freeze({
    forwardOnly: true,
    historicalBackfill: false,
    currentGeneralShadowReplaced: false,
    publicMarketDataOnly: true,
    actualOrders: 0,
    privateAccountRequests: 0,
    liveAuthority: false,
    promotionAuthority: false,
  }),
});

await writeJsonAtomically(statePath, state);
await writeJsonAtomically(summaryPath, summary);
console.log(JSON.stringify({
  statePath,
  summaryPath,
  total: metrics.total,
  settled: metrics.settled,
  pending: metrics.pending,
  gate: gate.status,
}));
