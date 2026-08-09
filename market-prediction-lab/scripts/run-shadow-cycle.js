import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyzeMarket } from "../src/engine.js";
import { BASELINE_MODEL } from "../src/tiny-model.js";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles, collectBitgetFuturesContext } from "../src/bitget-candle-collector.js";
import { collectBitgetUtcDailyForwardCandles } from "../src/bitget-forward-daily-candles.js";
import { collectFundingRateHistory, createTemporalDerivativesProvider } from "../src/derivatives-history.js";
import { collectBitgetDerivedCandles, createTemporalMarketStructureProvider } from "../src/market-structure-history.js";
import {
  createShadowPrediction,
  evaluateShadowPromotion,
  settleShadowPrediction,
  summarizeShadowState,
  upsertShadowPrediction,
} from "../src/shadow-ledger.js";
import {
  ETH_V6_FORWARD_CANDIDATE,
  ETH_V6_FORWARD_START,
  advanceEthV6ForwardState,
  createEthV6ForwardState,
  summarizeEthV6ForwardState,
} from "../src/eth-v6-forward-validation.js";
import { FROZEN_CANDIDATE_MANIFEST_SHA256 } from "../src/final-holdout-evaluator.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ETH_V6_LOOKBACK_DAYS = 120;
const ETH_V6_FORWARD_KEY = "eth-futures-long-v6";
const UTC_FORWARD_DATA_CONTRACT = Object.freeze({
  version: 1,
  timeframe: "1d",
  timezone: "UTC",
  granularity: "1Dutc",
  closedHistorySource: "bitget-public-history-candles",
  currentOpenSource: "bitget-public-candles",
});
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

function hasUtcDataContract(state) {
  return state?.dataContract?.version === UTC_FORWARD_DATA_CONTRACT.version
    && state?.dataContract?.timeframe === UTC_FORWARD_DATA_CONTRACT.timeframe
    && state?.dataContract?.timezone === UTC_FORWARD_DATA_CONTRACT.timezone
    && state?.dataContract?.granularity === UTC_FORWARD_DATA_CONTRACT.granularity;
}

function prepareUtcForwardState(previous, candlesResult, cycleTime) {
  if (hasUtcDataContract(previous)) return previous;
  const existingRecords = previous?.ledger?.records?.length ?? 0;
  const existingMissedSignals = previous?.missedSignals?.length ?? 0;
  if (previous && (existingRecords > 0 || existingMissedSignals > 0)) {
    throw new Error(`refusing UTC forward cutover with existing legacy evidence: records=${existingRecords}, missed=${existingMissedSignals}`);
  }
  const base = createEthV6ForwardState(cycleTime);
  const priorUtcSignalBoundary = Math.max(ETH_V6_FORWARD_START - 1, candlesResult.currentOpenTimestamp - 2 * DAY_MS);
  return Object.freeze({
    ...base,
    lastSignalEvaluated: priorUtcSignalBoundary,
    dataContract: UTC_FORWARD_DATA_CONTRACT,
    cutover: Object.freeze({
      resetAt: cycleTime,
      previousLegacyStateDiscarded: Boolean(previous),
      previousLegacyRecordCount: existingRecords,
      previousLegacyMissedSignalCount: existingMissedSignals,
      reason: "align_forward_validation_with_frozen_utc_daily_contract",
      historicalMetricsReused: false,
      parametersChanged: false,
      holdoutReusedForSelection: false,
    }),
  });
}

async function loadModelSelection(group) {
  const v1Artifact = await readJsonOptional(resolve("docs/candidate-models", `${group}.json`), null);
  if (!v1Artifact?.model?.trained) throw new Error(`v1 candidate is missing for ${group}`);
  const v4Artifact = await readJsonOptional(resolve("docs/candidate-models-v4", `${group}-ensemble-v4.json`), null);
  if (v4Artifact?.status === "shadow_candidate_v4" && v4Artifact?.model?.trained) {
    return Object.freeze({ candidate: v4Artifact.model, reference: v1Artifact.model, source: "ensemble-v4-vs-v1", requiresMarketStructure: true });
  }
  const v3Artifact = await readJsonOptional(resolve("docs/candidate-models-v3", `${group}-market-structure-v3.json`), null);
  if (v3Artifact?.status === "shadow_candidate_v3" && v3Artifact?.model?.trained) {
    return Object.freeze({ candidate: v3Artifact.model, reference: v1Artifact.model, source: "market-structure-v3-vs-v1", requiresMarketStructure: true });
  }
  const v2Artifact = await readJsonOptional(resolve("docs/candidate-models-v2", `${group}-funding-v2.json`), null);
  if (v2Artifact?.status === "shadow_candidate_v2" && v2Artifact?.model?.trained) {
    return Object.freeze({ candidate: v2Artifact.model, reference: v1Artifact.model, source: "funding-v2-vs-v1", requiresMarketStructure: false });
  }
  return Object.freeze({ candidate: v1Artifact.model, reference: BASELINE_MODEL, source: "v1-vs-rule-baseline", requiresMarketStructure: false });
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

function mergeTemporalFeatures(base, structure) {
  if (!structure) return base;
  return Object.freeze({
    derivativesFeatures: Object.freeze({ ...base.derivativesFeatures, ...structure.derivativesFeatures }),
    featureAvailability: Object.freeze({ ...base.featureAvailability, ...structure.featureAvailability }),
  });
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
  const markBySymbol = {};
  const indexBySymbol = {};
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
    if (selection.requiresMarketStructure) {
      [markBySymbol[symbol], indexBySymbol[symbol]] = await Promise.all([
        collectBitgetDerivedCandles({ client, kind: "mark", symbol, timeframe: config.timeframe, startTime, endTime }),
        collectBitgetDerivedCandles({ client, kind: "index", symbol, timeframe: config.timeframe, startTime, endTime }),
      ]);
    }
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
    const baseProvider = createTemporalDerivativesProvider({
      fundingHistory: fundingBySymbol[symbol].records,
      openInterestSnapshots: groupState.openInterestSnapshots.filter((row) => row.symbol === symbol),
    });
    const baseTemporal = baseProvider({ anchorTimestamp: anchor.timestamp });
    const structureTemporal = selection.requiresMarketStructure
      ? createTemporalMarketStructureProvider({
          fundingHistory: fundingBySymbol[symbol].records,
          markCandles: markBySymbol[symbol].candles,
          indexCandles: indexBySymbol[symbol].candles,
        })({ anchorTimestamp: anchor.timestamp, history })
      : null;
    const temporal = mergeTemporalFeatures(baseTemporal, structureTemporal);
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
        requiresMarketStructure: selection.requiresMarketStructure,
      },
      contexts: contextBySymbol,
    },
  };
}

async function assertEthV6ReplayProof() {
  const proof = await readJsonOptional(resolve("docs/eth-v6-replay-proof.json"), null);
  if (!proof || proof.status !== "passed") throw new Error("ETH V6 deterministic replay proof is missing or failed");
  if (proof.strategyId !== ETH_V6_FORWARD_CANDIDATE.id) throw new Error("ETH V6 replay proof strategy does not match frozen candidate");
  if (proof.candidateManifestSha256 !== FROZEN_CANDIDATE_MANIFEST_SHA256) throw new Error("ETH V6 replay proof manifest mismatch");
  if (proof.safeguards?.usedForSelection !== false || proof.safeguards?.parametersChanged !== false) {
    throw new Error("ETH V6 replay proof safety flags are invalid");
  }
  return proof;
}

async function processEthV6Forward({ client, previousForwardState, cycleTime }) {
  const replay = await assertEthV6ReplayProof();
  const candlesResult = await collectBitgetUtcDailyForwardCandles({
    client,
    symbol: "ETHUSDT",
    productType: "usdt-futures",
    asOf: cycleTime,
    lookbackDays: ETH_V6_LOOKBACK_DAYS,
    minimumClosedCandles: 60,
  });
  if (!Array.isArray(candlesResult.candles) || candlesResult.closedCandleCount < 60) {
    throw new Error("ETH V6 forward cycle has insufficient UTC daily candle history");
  }
  const funding = await collectFundingRateHistory({
    client,
    symbol: "ETHUSDT",
    productType: "usdt-futures",
    startTime: Math.max(ETH_V6_FORWARD_START - 7 * DAY_MS, cycleTime - ETH_V6_LOOKBACK_DAYS * DAY_MS),
    endTime: cycleTime,
    pageSize: 100,
    maxPages: 20,
  });
  const state = advanceEthV6ForwardState({
    state: prepareUtcForwardState(previousForwardState, candlesResult, cycleTime),
    candles: candlesResult.candles,
    fundingRates: funding.records,
    cycleTime,
  });
  const summary = summarizeEthV6ForwardState(state);
  return Object.freeze({
    state,
    summary: Object.freeze({
      status: "pass",
      ...summary,
      dataContract: state.dataContract,
      cutover: state.cutover ?? null,
      replay: Object.freeze({ status: replay.status, usedForSelection: false, generatedAt: replay.generatedAt }),
      data: Object.freeze({
        provider: candlesResult.provider,
        timezone: candlesResult.timezone,
        granularity: candlesResult.granularity,
        candleCount: candlesResult.candles.length,
        closedCandleCount: candlesResult.closedCandleCount,
        currentOpenTimestamp: candlesResult.currentOpenTimestamp,
        firstCandle: candlesResult.candles[0]?.timestamp ?? null,
        lastCandle: candlesResult.candles.at(-1)?.timestamp ?? null,
        fundingRecords: funding.records.length,
        fundingFirst: funding.records[0]?.timestamp ?? null,
        fundingLast: funding.records.at(-1)?.timestamp ?? null,
        collectedAt: cycleTime,
      }),
      safety: Object.freeze({
        frozenCandidateOnly: true,
        parametersRetunedAfterHoldout: false,
        forwardSignalsOnly: true,
        publicMarketDataOnly: true,
        actualOrders: 0,
        privateAccountRequests: 0,
        livePromotion: false,
      }),
    }),
  });
}

const statePath = resolve(process.argv[2] ?? "docs/shadow-state.json");
const summaryPath = resolve(process.argv[3] ?? "docs/shadow-summary.json");
const cycleTime = Date.now();
const previous = await readJsonOptional(statePath, { schemaVersion: 3, createdAt: cycleTime, groups: {}, forwardStrategies: {} });
const client = new BitgetPublicClient({ minIntervalMs: 180, maxRetries: 4, timeoutMs: 12_000 });
const nextState = {
  schemaVersion: 3,
  createdAt: previous.createdAt ?? cycleTime,
  updatedAt: cycleTime,
  groups: {},
  forwardStrategies: {},
};
const nextSummary = {
  schemaVersion: 3,
  status: "pass",
  generatedAt: cycleTime,
  groups: {},
  forwardStrategies: {},
  safety: {
    usesPublicMarketDataOnly: true,
    usesAccountOrOrderApi: false,
    modifiesExistingAppApi: false,
    backfillsHistoricalOpenInterest: false,
    mixesModelPairsInPromotionMetrics: false,
    deploysModel: false,
    frozenEthV6LiveOrderAllowed: false,
  },
};

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

try {
  const forward = await processEthV6Forward({
    client,
    previousForwardState: previous.forwardStrategies?.[ETH_V6_FORWARD_KEY] ?? null,
    cycleTime,
  });
  nextState.forwardStrategies[ETH_V6_FORWARD_KEY] = forward.state;
  nextSummary.forwardStrategies[ETH_V6_FORWARD_KEY] = forward.summary;
} catch (error) {
  nextState.forwardStrategies[ETH_V6_FORWARD_KEY] = previous.forwardStrategies?.[ETH_V6_FORWARD_KEY] ?? null;
  nextSummary.forwardStrategies[ETH_V6_FORWARD_KEY] = {
    status: "technical_failure",
    candidateId: ETH_V6_FORWARD_CANDIDATE.id,
    candidateManifestSha256: FROZEN_CANDIDATE_MANIFEST_SHA256,
    error: serializeError(error),
    safety: {
      stateCarriedForwardWithoutMutation: true,
      actualOrders: 0,
      privateAccountRequests: 0,
      livePromotion: false,
    },
  };
  nextSummary.status = "fail";
}

await writeJsonAtomically(statePath, nextState);
await writeJsonAtomically(summaryPath, nextSummary);
console.log(JSON.stringify(nextSummary, null, 2));
if (nextSummary.status !== "pass") process.exitCode = 1;
