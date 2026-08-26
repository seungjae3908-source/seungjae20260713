import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyzeMarket } from "../src/engine.js";
import { BASELINE_MODEL } from "../src/tiny-model.js";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { BITGET_TIMEFRAME_MS, collectBitgetCandles, collectBitgetFuturesContext } from "../src/bitget-candle-collector.js";
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
import { predictDeployedTinyModel } from "../src/deployment-inference.js";
import {
  buildCanonicalShadowDriftHandoffV1,
  buildFutureShadowObservationV1,
  buildFutureShadowSettlementEvidenceV1,
  buildNormalizedFeatureSnapshotV1,
  resolveModelIdentityMappingV1,
  resolveProducerStrategyIdentityV1,
  resolveTrainValidationReferenceV1,
  settleFutureShadowObservationV1,
} from "../src/shadow-evidence-handoff-v1.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ETH_V6_LOOKBACK_DAYS = 120;
const ETH_V6_FORWARD_KEY = "eth-futures-long-v6";
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

async function readBytesOptional(filePath) {
  try { return await readFile(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
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

async function loadCanonicalEvidenceContext(referenceEvidenceRoot, group, cycleTime) {
  if (!referenceEvidenceRoot) return Object.freeze({ valid: false, status: "MISSING_EVIDENCE", reason: "PRODUCER_REFERENCE_ROOT_NOT_PROVIDED" });
  const packageRoot = resolve(referenceEvidenceRoot, group);
  const [manifestBytes, exactModelBytes, trainReferenceBytes, validationReferenceBytes] = await Promise.all([
    readBytesOptional(resolve(packageRoot, "reference-manifest.json")),
    readBytesOptional(resolve(packageRoot, "model/exact-model.json")),
    readBytesOptional(resolve(packageRoot, "records/train.jsonl")),
    readBytesOptional(resolve(packageRoot, "records/validation.jsonl")),
  ]);
  if (!manifestBytes || !exactModelBytes || !trainReferenceBytes || !validationReferenceBytes) {
    return Object.freeze({ valid: false, status: "MISSING_EVIDENCE", reason: "PRODUCER_REFERENCE_PACKAGE_INCOMPLETE" });
  }
  let producerManifest;
  try { producerManifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch { return Object.freeze({ valid: false, status: "IDENTITY_MISMATCH", reason: "PRODUCER_MANIFEST_MALFORMED" }); }
  const strategyResolution = resolveProducerStrategyIdentityV1(producerManifest);
  if (!strategyResolution.valid) return Object.freeze({ valid: false, status: strategyResolution.status, reason: strategyResolution.reason });
  const modelResolution = resolveModelIdentityMappingV1({ producerManifest, exactModelBytes, strategyResolution });
  if (!modelResolution.valid) return Object.freeze({ valid: false, status: modelResolution.status, reason: modelResolution.reason });
  const asOf = new Date(cycleTime).toISOString();
  const referenceResolution = resolveTrainValidationReferenceV1({ producerManifest, trainReferenceBytes, validationReferenceBytes, asOf });
  if (!referenceResolution.valid) return Object.freeze({ valid: false, status: referenceResolution.status, reason: referenceResolution.reason });
  return Object.freeze({
    valid: true,
    producerManifest,
    exactModelBytes,
    trainReferenceBytes,
    validationReferenceBytes,
    strategyResolution,
    modelResolution,
    referenceResolution,
    asOf,
  });
}

function canonicalObservationId(context, config, symbol, anchorTimestamp) {
  return createHash("sha256").update([
    context.strategyResolution.strategyIdentityDigest,
    context.modelResolution.modelIdentityDigest,
    config.group,
    symbol,
    config.timeframe,
    anchorTimestamp,
    config.horizon,
  ].join("|")).digest("hex");
}

function settleCanonicalObservations(observations, records, candlesBySymbol) {
  const settledByAnchor = new Map(records.filter((record) => record.status === "settled")
    .map((record) => [`${record.symbol}|${record.timeframe}|${record.anchorTimestamp}|${record.horizon}`, record]));
  return observations.map((observation) => {
    const source = observation.sourceProvenance;
    const record = settledByAnchor.get(`${observation.symbol}|${observation.timeframe}|${source.anchorTimestamp}|${source.horizon}`);
    if (!record || observation.settlementStatus === "SETTLED") return observation;
    const futureCandles = (candlesBySymbol[record.symbol] ?? [])
      .filter((candle) => candle.timestamp > record.anchorTimestamp)
      .slice(0, record.horizon);
    if (futureCandles.length !== record.horizon) return observation;
    const intervalMs = BITGET_TIMEFRAME_MS[record.timeframe];
    const settlement = buildFutureShadowSettlementEvidenceV1({
      observation,
      actualDirection: record.actualDirection,
      settlementPrice: futureCandles.at(-1).close,
      futureCandles,
      horizonBars: record.horizon,
      outcomeAt: new Date(record.futureEndTimestamp + intervalMs).toISOString(),
      settledAt: new Date(record.evaluatedAt).toISOString(),
      costEvidence: {
        applicable: false,
        reason: "SHADOW_NO_EXECUTION",
        commission: null,
        slippage: null,
        funding: null,
        netReturn: null,
      },
      sourceProvenance: {
        sourceKind: "GENUINE_FUTURE_SHADOW_OUTCOME",
        provider: "bitget-public-v2",
        firstCandleTimestamp: futureCandles[0].timestamp,
        lastCandleTimestamp: futureCandles.at(-1).timestamp,
        capturedAfterObservation: true,
        reconstructed: false,
        synthetic: false,
        replayed: false,
        historicalBackfill: false,
      },
    });
    return settleFutureShadowObservationV1(observation, settlement);
  });
}

function runtimeCounters(previousCanonical, {
  rawRecordCount,
  observations,
  duplicateEvents,
  replayEvents,
} = {}) {
  const previous = previousCanonical?.runtimeCounters ?? {};
  return Object.freeze({
    RAW_RECORD_COUNT: (Number(previous.RAW_RECORD_COUNT) || previousCanonical?.observations?.length || 0) + rawRecordCount,
    UNIQUE_GENUINE_OBSERVATION_COUNT: observations.length,
    UNIQUE_SETTLEMENT_COUNT: observations.filter((observation) => observation.settlementStatus === "SETTLED").length,
    DUPLICATE_COUNT: (Number(previous.DUPLICATE_COUNT) || 0) + duplicateEvents.length,
    REPLAY_COUNT: (Number(previous.REPLAY_COUNT) || 0) + replayEvents.length,
  });
}

function firstZeroEvidence({ canonicalContext, canonicalRunError, identityChanged, currentRunAttemptCount, currentRunObservationCount, observations, handoff }) {
  const settledN = observations.filter((observation) => observation.settlementStatus === "SETTLED").length;
  const pendingN = observations.filter((observation) => observation.settlementStatus === "PENDING_SETTLEMENT").length;
  const driftInputN = handoff?.observationEvidence?.driftInputN ?? 0;
  const funnel = Object.freeze({
    SIGNAL: currentRunAttemptCount,
    OBSERVATION: currentRunObservationCount,
    POSITION: pendingN,
    SETTLEMENT: settledN,
    DRIFT: driftInputN,
    STRATEGY_HEALTH: handoff?.strategyHealthHandoff ? 1 : 0,
  });
  let stage = null;
  let reason = null;
  if (!currentRunAttemptCount) {
    stage = "SIGNAL";
    reason = "NO_ELIGIBLE_SIGNAL";
  } else if (!currentRunObservationCount) {
    stage = "OBSERVATION";
    const failureReason = canonicalRunError?.reason ?? canonicalContext?.reason ?? "";
    reason = failureReason.includes("REFERENCE_EXPIRED") ? "REFERENCE_EXPIRED"
      : (identityChanged || failureReason.includes("MODEL") || failureReason.includes("IDENTITY_MISMATCH") ? "MODEL_IDENTITY_MISMATCH"
        : (failureReason.includes("STRATEGY") || canonicalContext?.valid === false ? "STRATEGY_IDENTITY_MISSING"
          : (canonicalRunError ? "OBSERVATION_WRITE_FAILED" : "DUPLICATE_ONLY")));
  } else if (!pendingN && !settledN) {
    stage = "POSITION";
    reason = "OBSERVATION_WRITE_FAILED";
  } else if (!settledN) {
    stage = "SETTLEMENT";
    reason = "SETTLEMENT_NOT_DUE";
  } else if (handoff?.driftVerdict?.status === "NOT_EVALUABLE") {
    stage = "DRIFT";
    reason = handoff.driftVerdict.reason === "CANONICAL_DRIFT_POLICY_MISSING" ? "DRIFT_POLICY_MISSING" : "INSUFFICIENT_SAMPLE";
  } else if (!handoff?.strategyHealthHandoff) {
    stage = "STRATEGY_HEALTH";
    reason = "STRATEGY_HEALTH_MISSING_EVIDENCE";
  }
  return Object.freeze({
    ...funnel,
    FIRST_ZERO_STAGE: stage,
    FIRST_ZERO_REASON: reason,
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

async function processGroup({ client, config, previousGroupState, cycleTime, referenceEvidenceRoot }) {
  const selection = await loadModelSelection(config.group);
  const canonicalContext = await loadCanonicalEvidenceContext(referenceEvidenceRoot, config.group, cycleTime);
  const previousCanonical = previousGroupState?.canonicalEvidence ?? null;
  const identityChanged = canonicalContext.valid && previousCanonical?.strategyIdentityDigest
    && (previousCanonical.strategyIdentityDigest !== canonicalContext.strategyResolution.strategyIdentityDigest
      || previousCanonical.modelIdentityDigest !== canonicalContext.modelResolution.modelIdentityDigest);
  let canonicalObservations = identityChanged
    ? []
    : [...(previousCanonical?.observations ?? [])];
  let canonicalRunError = null;
  let canonicalAttemptCount = 0;
  let canonicalNewObservationCount = 0;
  const duplicateEvents = [];
  const replayEvents = [];
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
    canonicalAttemptCount += 1;
    if (canonicalContext.valid && !identityChanged) {
      const observationId = canonicalObservationId(canonicalContext, config, symbol, anchor.timestamp);
      if (canonicalObservations.some((observation) => observation.observationId === observationId)) {
        duplicateEvents.push({
          observationId,
          strategyIdentityDigest: canonicalContext.strategyResolution.strategyIdentityDigest,
          symbol,
          timeframe: config.timeframe,
          signalAt: new Date(anchor.timestamp + BITGET_TIMEFRAME_MS[config.timeframe]).toISOString(),
          detectedAt: new Date(cycleTime).toISOString(),
          reason: "DETERMINISTIC_OBSERVATION_ID_DUPLICATE",
          credit: 0,
        });
      } else {
        try {
          const exactInference = predictDeployedTinyModel({
            features: candidate.features,
            ruleScore: candidate.ruleScore,
          }, canonicalContext.modelResolution.exactModel);
          const rawFeatureSnapshot = Object.fromEntries(canonicalContext.modelResolution.exactModel.featureOrder
            .map((name) => [name, candidate.features[name]]));
          const normalizedFeatureSnapshot = buildNormalizedFeatureSnapshotV1({
            rawFeatureSnapshot,
            exactModel: canonicalContext.modelResolution.exactModel,
          });
          canonicalObservations.push(buildFutureShadowObservationV1({
            observationId,
            observedAt: new Date(cycleTime).toISOString(),
            signalAt: new Date(anchor.timestamp + BITGET_TIMEFRAME_MS[config.timeframe]).toISOString(),
            symbol,
            market: canonicalContext.strategyResolution.strategyIdentity.market,
            timeframe: canonicalContext.strategyResolution.strategyIdentity.timeframe,
            direction: canonicalContext.strategyResolution.strategyIdentity.direction,
            strategyIdentity: canonicalContext.strategyResolution.strategyIdentity,
            strategyIdentityDigest: canonicalContext.strategyResolution.strategyIdentityDigest,
            modelIdentity: canonicalContext.modelResolution.modelIdentity,
            modelIdentityDigest: canonicalContext.modelResolution.modelIdentityDigest,
            referenceIdentity: canonicalContext.referenceResolution.referenceIdentity,
            regime: record.regime,
            rawFeatureSnapshot,
            normalizedFeatureSnapshot,
            inference: exactInference,
            referencePrice: anchor.close,
            priceProvenance: {
              provider: "bitget-public-v2",
              source: commonInput.source,
              priceField: "close",
              candleTimestamp: anchor.timestamp,
              signalAt: new Date(anchor.timestamp + BITGET_TIMEFRAME_MS[config.timeframe]).toISOString(),
            },
            dataFreshness: {
              status: "FRESH",
              ageMs: cycleTime - (anchor.timestamp + BITGET_TIMEFRAME_MS[config.timeframe]),
              maxAgeMs: BITGET_TIMEFRAME_MS[config.timeframe] * 3,
            },
            sourceProvenance: {
              sourceKind: "GENUINE_SHADOW_OBSERVATION",
              provider: "bitget-public-v2",
              source: commonInput.source,
              anchorTimestamp: anchor.timestamp,
              signalTimestamp: anchor.timestamp + BITGET_TIMEFRAME_MS[config.timeframe],
              horizon: config.horizon,
              capturedAtObservationTime: true,
              reconstructed: false,
              synthetic: false,
              replayed: false,
              historicalBackfill: false,
            },
          }));
          canonicalNewObservationCount += 1;
        } catch (error) {
          canonicalRunError = { status: "MISSING_EVIDENCE", reason: `GENUINE_SHADOW_OBSERVATION_REJECTED:${error.message}` };
        }
      }
    }
  }

  canonicalObservations = settleCanonicalObservations(canonicalObservations, groupState.records, candlesBySymbol).slice(-10000);
  let canonicalEvidence;
  if (!canonicalContext.valid || canonicalRunError) {
    const failure = canonicalRunError ?? canonicalContext;
    canonicalEvidence = {
      ...(previousCanonical ?? {}),
      schemaVersion: "prediction-lab-shadow-runtime-evidence-v1",
      runtimeStatus: failure.status,
      runtimeReason: failure.reason,
      currentRunCredited: false,
      currentRunAttemptCount: canonicalAttemptCount,
      currentRunObservationCount: canonicalNewObservationCount,
      lastAttemptAt: new Date(cycleTime).toISOString(),
      observations: canonicalObservations,
      rejectedCredits: [
        ...(previousCanonical?.rejectedCredits ?? []),
        ...duplicateEvents,
        ...replayEvents,
      ].slice(-1000),
      runtimeCounters: runtimeCounters(previousCanonical, {
        rawRecordCount: canonicalAttemptCount,
        observations: canonicalObservations,
        duplicateEvents,
        replayEvents,
      }),
      PROFITABILITY_PROVEN: false,
      FORWARD_EVIDENCE_SUFFICIENT: false,
    };
  } else if (identityChanged) {
    canonicalEvidence = {
      ...(previousCanonical ?? {}),
      schemaVersion: "prediction-lab-shadow-runtime-evidence-v1",
      runtimeStatus: "IDENTITY_MISMATCH",
      runtimeReason: "PREDECESSOR_CANONICAL_IDENTITY_MISMATCH",
      currentRunCredited: false,
      currentRunAttemptCount: canonicalAttemptCount,
      currentRunObservationCount: 0,
      lastAttemptAt: new Date(cycleTime).toISOString(),
      observations: previousCanonical?.observations ?? [],
      runtimeCounters: previousCanonical?.runtimeCounters ?? null,
      PROFITABILITY_PROVEN: false,
      FORWARD_EVIDENCE_SUFFICIENT: false,
    };
  } else {
    const handoff = buildCanonicalShadowDriftHandoffV1({
      producerManifest: canonicalContext.producerManifest,
      exactModelBytes: canonicalContext.exactModelBytes,
      trainReferenceBytes: canonicalContext.trainReferenceBytes,
      validationReferenceBytes: canonicalContext.validationReferenceBytes,
      observations: canonicalObservations,
      expectedStrategyInput: canonicalContext.strategyResolution.strategyIdentity,
      expectedModelIdentity: canonicalContext.modelResolution.modelIdentity,
      canonicalDriftPolicy: null,
      asOf: canonicalContext.asOf,
    });
    canonicalEvidence = {
      schemaVersion: "prediction-lab-shadow-runtime-evidence-v1",
      runtimeStatus: handoff.status,
      runtimeReason: handoff.reason,
      currentRunCredited: canonicalNewObservationCount > 0 && handoff.observationEvidence?.futureOnly === true,
      currentRunAttemptCount: canonicalAttemptCount,
      currentRunObservationCount: canonicalNewObservationCount,
      lastAttemptAt: new Date(cycleTime).toISOString(),
      strategyIdentityDigest: canonicalContext.strategyResolution.strategyIdentityDigest,
      modelIdentityDigest: canonicalContext.modelResolution.modelIdentityDigest,
      observations: canonicalObservations,
      rejectedCredits: [
        ...(previousCanonical?.rejectedCredits ?? []),
        ...duplicateEvents,
        ...replayEvents,
      ].slice(-1000),
      runtimeCounters: runtimeCounters(previousCanonical, {
        rawRecordCount: canonicalAttemptCount,
        observations: canonicalObservations,
        duplicateEvents,
        replayEvents,
      }),
      handoff,
      PROFITABILITY_PROVEN: false,
      FORWARD_EVIDENCE_SUFFICIENT: false,
    };
  }
  canonicalEvidence.firstZero = firstZeroEvidence({
    canonicalContext,
    canonicalRunError,
    identityChanged,
    currentRunAttemptCount: canonicalAttemptCount,
    currentRunObservationCount: canonicalNewObservationCount,
    observations: canonicalEvidence.observations ?? canonicalObservations,
    handoff: canonicalEvidence.handoff ?? null,
  });
  groupState = { ...groupState, canonicalEvidence };

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
      canonicalEvidence: {
        runtimeStatus: canonicalEvidence.runtimeStatus,
        runtimeReason: canonicalEvidence.runtimeReason,
        currentRunCredited: canonicalEvidence.currentRunCredited,
        currentRunAttemptCount: canonicalEvidence.currentRunAttemptCount ?? 0,
        currentRunObservationCount: canonicalEvidence.currentRunObservationCount ?? 0,
        observationCount: canonicalEvidence.observations?.length ?? 0,
        settledObservationCount: canonicalEvidence.observations?.filter((observation) => observation.actualDirection).length ?? 0,
        runtimeCounters: canonicalEvidence.runtimeCounters ?? null,
        firstZero: canonicalEvidence.firstZero ?? null,
        strategyHealthHandoff: canonicalEvidence.handoff?.strategyHealthHandoff ?? null,
        PROFITABILITY_PROVEN: false,
        FORWARD_EVIDENCE_SUFFICIENT: false,
      },
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
  const startTime = Math.max(ETH_V6_FORWARD_START - ETH_V6_LOOKBACK_DAYS * DAY_MS, cycleTime - ETH_V6_LOOKBACK_DAYS * DAY_MS);
  const candlesResult = await collectBitgetCandles({
    client,
    market: "CRYPTO_FUTURES",
    symbol: "ETHUSDT",
    timeframe: "1d",
    startTime,
    endTime: cycleTime,
    maxCandles: 500,
  });
  if (!Array.isArray(candlesResult.candles) || candlesResult.candles.length < 40) {
    throw new Error("ETH V6 forward cycle has insufficient daily candle history");
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
    state: previousForwardState ?? createEthV6ForwardState(cycleTime),
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
      replay: Object.freeze({ status: replay.status, usedForSelection: false, generatedAt: replay.generatedAt }),
      data: Object.freeze({
        provider: "bitget-public-v2",
        candleCount: candlesResult.candles.length,
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
const referenceEvidenceRoot = process.argv[4] ? resolve(process.argv[4]) : null;
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
      referenceEvidenceRoot,
    });
    nextState.groups[config.group] = result.state;
    nextSummary.groups[config.group] = { status: "pass", ...result.summary };
  } catch (error) {
    nextState.groups[config.group] = previous.groups?.[config.group] ?? { records: [], openInterestSnapshots: [] };
    nextSummary.groups[config.group] = { status: "fail", error: serializeError(error) };
    nextSummary.status = "fail";
  }
}

const canonicalGroupSummaries = Object.values(nextSummary.groups)
  .map((group) => group?.canonicalEvidence)
  .filter(Boolean);
const counterNames = ["RAW_RECORD_COUNT", "UNIQUE_GENUINE_OBSERVATION_COUNT", "UNIQUE_SETTLEMENT_COUNT", "DUPLICATE_COUNT", "REPLAY_COUNT"];
const aggregateCounters = Object.fromEntries(counterNames.map((name) => [name, canonicalGroupSummaries
  .reduce((sum, group) => sum + (Number(group.runtimeCounters?.[name]) || 0), 0)]));
const aggregateFunnel = Object.fromEntries(["SIGNAL", "OBSERVATION", "POSITION", "SETTLEMENT", "DRIFT", "STRATEGY_HEALTH"]
  .map((name) => [name, canonicalGroupSummaries.reduce((sum, group) => sum + (Number(group.firstZero?.[name]) || 0), 0)]));
const firstZeroOrder = ["SIGNAL", "OBSERVATION", "POSITION", "SETTLEMENT", "DRIFT", "STRATEGY_HEALTH"];
const firstZeroStage = firstZeroOrder.find((name) => aggregateFunnel[name] === 0) ?? null;
const firstZeroReason = firstZeroStage
  ? (canonicalGroupSummaries.find((group) => group.firstZero?.FIRST_ZERO_STAGE === firstZeroStage)?.firstZero?.FIRST_ZERO_REASON
    ?? (firstZeroStage === "SETTLEMENT" ? "SETTLEMENT_NOT_DUE" : "INSUFFICIENT_SAMPLE"))
  : null;
nextSummary.canonicalEvidence = {
  ...aggregateCounters,
  ...aggregateFunnel,
  FIRST_ZERO_STAGE: firstZeroStage,
  FIRST_ZERO_REASON: firstZeroReason,
  duplicateCredit: 0,
  replayCredit: 0,
  syntheticCredit: 0,
  historicalBackfillCredit: 0,
  PROFITABILITY_PROVEN: false,
  FORWARD_EVIDENCE_SUFFICIENT: false,
};

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
}

await writeJsonAtomically(statePath, nextState);
await writeJsonAtomically(summaryPath, nextSummary);
console.log(JSON.stringify(nextSummary, null, 2));
if (nextSummary.status !== "pass") process.exitCode = 1;
