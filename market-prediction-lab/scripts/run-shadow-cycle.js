import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyzeMarket } from "../src/engine.js";
import { BASELINE_MODEL } from "../src/tiny-model.js";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles, collectBitgetFuturesContext } from "../src/bitget-candle-collector.js";
import { collectFundingRateHistory, createTemporalDerivativesProvider } from "../src/derivatives-history.js";
import {
  createShadowPrediction,
  evaluateShadowPromotion,
  settleShadowPrediction,
  summarizeShadowState,
  upsertShadowPrediction,
} from "../src/shadow-ledger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUPS = Object.freeze([
  Object.freeze({ group: "crypto-futures-15m", timeframe: "15m", horizon: 8, lookback: 200, days: 7, symbols: Object.freeze(["BTCUSDT", "ETHUSDT"]) }),
  Object.freeze({ group: "crypto-futures-1h", timeframe: "1h", horizon: 12, lookback: 200, days: 15, symbols: Object.freeze(["BTCUSDT", "ETHUSDT"]) }),
]);

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

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1200),
    details: error?.details ?? null,
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 10) : [],
  };
}

async function loadModelSelection(group) {
  const v1Artifact = await readJsonOptional(resolve("docs/candidate-models", `${group}.json`), null);
  if (!v1Artifact?.model?.trained) throw new Error(`v1 candidate is missing for ${group}`);
  const v3Artifact = await readJsonOptional(resolve("docs/candidate-models-v3", `${group}-market-structure-v3.json`), null);
  if (v3Artifact?.status === "shadow_candidate_v3" && v3Artifact?.model?.trained) {
    return Object.freeze({ candidate: v3Artifact.model, reference: v1Artifact.model, source: "market-structure-v3-vs-v1" });
  }
  const v2Artifact = await readJsonOptional(resolve("docs/candidate-models-v2", `${group}-funding-v2.json`), null);
  if (v2Artifact?.status === "shadow_candidate_v2" && v2Artifact?.model?.trained) {
    return Object.freeze({ candidate: v2Artifact.model, reference: v1Artifact.model, source: "funding-v2-vs-v1" });
  }
  return Object.freeze({ candidate: v1Artifact.model, reference: BASELINE_MODEL, source: "v1-vs-rule-baseline" });
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

function settleAvailable(groupState, candlesBySymbol) {
  const records = (groupState.records ?? []).map((record) => {
    if (record.status !== "pending") return record;
    const candles = candlesBySymbol[record.symbol] ?? [];
    const future = candles.filter((candle) => candle.timestamp > record.anchorTimestamp).slice(0, record.horizon);
    if (future.length < record.horizon) return record;
    return settleShadowPrediction(record, future);
  });
  return { ...groupState, records };
}

async function processGroup({ client, config, previousGroupState, cycleTime }) {
  const selection = await loadModelSelection(config.group);
  let groupState = {
    schemaVersion: 2,
    createdAt: previousGroupState?.createdAt ?? cycleTime,
    updatedAt: cycleTime,
    openInterestSnapshots: [...(previousGroupState?.openInterestSnapshots ?? [])],
    records: [...(previousGroupState?.records ?? [])],
  };
  const candlesBySymbol = {};
  const fundingBySymbol = {};
  const contextBySymbol = {};

  for (const symbol of config.symbols) {
    const endTime = Date.now();
    const startTime = endTime - config.days * DAY_MS;
    const snapshot = await collectBitgetCandles({
      client,
      market: "CRYPTO_FUTURES",
      symbol,
      timeframe: config.timeframe,
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
    groupState.openInterestSnapshots = addOpenInterestSnapshot(groupState.openInterestSnapshots, symbol, context);
  }

  groupState = settleAvailable(groupState, candlesBySymbol);

  for (const symbol of config.symbols) {
    const candles = candlesBySymbol[symbol];
    if (candles.length < config.lookback) throw new Error(`not enough shadow candles for ${symbol} ${config.timeframe}`);
    const history = candles.slice(-config.lookback);
    const anchor = history.at(-1);
    const provider = createTemporalDerivativesProvider({
      fundingHistory: fundingBySymbol[symbol].records,
      openInterestSnapshots: groupState.openInterestSnapshots.filter((row) => row.symbol === symbol),
    });
    const temporal = provider({ anchorTimestamp: anchor.timestamp });
    const commonInput = {
      market: "CRYPTO_FUTURES",
      symbol,
      timeframe: config.timeframe,
      horizon: config.horizon,
      candles: history,
      derivativesFeatures: temporal.derivativesFeatures,
      marketFeatures: {},
      collectedAt: anchor.timestamp,
      source: "bitget-public-shadow-cycle",
    };
    const candidate = analyzeMarket(commonInput, { model: selection.candidate });
    const reference = analyzeMarket(commonInput, { model: selection.reference });
    const record = createShadowPrediction({
      modelGroup: config.group,
      modelId: selection.candidate.id,
      referenceModelId: selection.reference.id,
      symbol,
      timeframe: config.timeframe,
      anchorTimestamp: anchor.timestamp,
      horizon: config.horizon,
      lastClose: anchor.close,
      atrPct: candidate.indicators.atrPct,
      candidateProbabilities: candidate.probabilities,
      referenceProbabilities: reference.probabilities,
      features: candidate.features,
      featureAvailability: temporal.featureAvailability,
      generatedAt: cycleTime,
    });
    if (!groupState.records.some((existing) => existing.id === record.id)) {
      groupState = upsertShadowPrediction(groupState, record);
    }
  }

  const summary = summarizeShadowState(groupState, {
    modelId: selection.candidate.id,
    referenceModelId: selection.reference.id,
  });
  const promotion = evaluateShadowPromotion(summary);
  return {
    state: { ...groupState, updatedAt: cycleTime },
    summary: {
      ...summary,
      promotion,
      modelSelection: {
        source: selection.source,
        candidateModelId: selection.candidate.id,
        referenceModelId: selection.reference.id,
      },
      contexts: contextBySymbol,
    },
  };
}

const statePath = resolve(process.argv[2] ?? "docs/shadow-state.json");
const summaryPath = resolve(process.argv[3] ?? "docs/shadow-summary.json");
const cycleTime = Date.now();
const previous = await readJsonOptional(statePath, { schemaVersion: 2, createdAt: cycleTime, groups: {} });
const client = new BitgetPublicClient({ minIntervalMs: 180, maxRetries: 4, timeoutMs: 12_000 });
const nextState = { schemaVersion: 2, createdAt: previous.createdAt ?? cycleTime, updatedAt: cycleTime, groups: {} };
const nextSummary = { schemaVersion: 2, status: "pass", generatedAt: cycleTime, groups: {}, safety: {
  usesPublicMarketDataOnly: true,
  usesAccountOrOrderApi: false,
  modifiesExistingAppApi: false,
  backfillsHistoricalOpenInterest: false,
  mixesModelPairsInPromotionMetrics: false,
  deploysModel: false,
} };

for (const config of GROUPS) {
  try {
    const result = await processGroup({
      client,
      config,
      previousGroupState: previous.groups?.[config.group],
      cycleTime,
    });
    nextState.groups[config.group] = result.state;
    nextSummary.groups[config.group] = { status: "pass", ...result.summary };
  } catch (error) {
    nextState.groups[config.group] = previous.groups?.[config.group] ?? { records: [], openInterestSnapshots: [] };
    nextSummary.groups[config.group] = { status: "fail", error: serializeError(error) };
    nextSummary.status = "fail";
  }
}

await writeJsonAtomically(statePath, nextState);
await writeJsonAtomically(summaryPath, nextSummary);
console.log(JSON.stringify(nextSummary, null, 2));
if (nextSummary.status !== "pass") process.exitCode = 1;
