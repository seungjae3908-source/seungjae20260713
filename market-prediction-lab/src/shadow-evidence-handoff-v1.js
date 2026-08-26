import { createHash } from "node:crypto";

import { resolveCanonicalStrategyIdentity } from "./canonical-strategy-identity-v1.js";
import { sha256Canonical } from "./research-cache-provenance.js";
import {
  jensenShannonDivergence,
  kolmogorovSmirnovDistance,
  populationStabilityIndex,
} from "./shadow-feature-drift-diagnostics.js";

export const SHADOW_EVIDENCE_HANDOFF_SCHEMA_VERSION = "prediction-lab-shadow-evidence-handoff-v1";
export const MODEL_IDENTITY_MAPPING_SCHEMA_VERSION = "prediction-lab-model-identity-mapping-v1";
export const SHADOW_OBSERVATION_SCHEMA_VERSION = "prediction-lab-shadow-observation-components-v1";
export const SHADOW_SETTLEMENT_SCHEMA_VERSION = "prediction-lab-shadow-settlement-evidence-v1";
export const STRATEGY_HEALTH_HANDOFF_SCHEMA_VERSION = "prediction-lab-strategy-health-shadow-handoff-v1";
export const FROZEN_BLEND_WEIGHTS = Object.freeze({ rule: 0.65, model: 0.35 });

const CLASSES = Object.freeze(["bullish", "neutral", "bearish"]);
const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const EPSILON = 1e-12;

const SAFETY = Object.freeze({
  LIVE_TRADING: false,
  AUTO_TRADING: false,
  REAL_ORDER_ENABLED: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  executionAuthority: "NONE",
  orderSubmitted: false,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function digest(value) {
  return typeof value === "string" && HASH_64.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function sha(value) {
  return typeof value === "string" && SHA_40.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}

function sha256Bytes(value) {
  const source = bytes(value);
  return source ? createHash("sha256").update(source).digest("hex") : null;
}

function iso(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function failure(status, reason, extra = {}) {
  return deepFreeze({ valid: false, status, reason, ...extra, safety: SAFETY });
}

function topClass(probabilities) {
  return CLASSES.reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, CLASSES[0]);
}

function normalizeDirection(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["bullish", "bull", "long"].includes(normalized)) return "bullish";
  if (["bearish", "bear", "short"].includes(normalized)) return "bearish";
  if (["neutral", "flat", "no_trade", "no-trade"].includes(normalized)) return "neutral";
  return null;
}

function assertProbabilities(probabilities, label) {
  if (!object(probabilities)) throw new TypeError(`${label} probabilities are required`);
  if (CLASSES.some((name) => !finite(probabilities[name]) || probabilities[name] < 0 || probabilities[name] > 1)) {
    throw new TypeError(`${label} probabilities are invalid`);
  }
  const total = CLASSES.reduce((sum, name) => sum + probabilities[name], 0);
  if (Math.abs(total - 1) > 1e-6) throw new TypeError(`${label} probabilities must sum to one`);
  return Object.freeze(Object.fromEntries(CLASSES.map((name) => [name, probabilities[name]])));
}

function observationIdentityPayload(observation) {
  const copy = structuredClone(observation);
  delete copy.artifactDigest;
  return copy;
}

export function computeShadowObservationArtifactDigestV1(observation) {
  return sha256Canonical(observationIdentityPayload(observation));
}

export function resolveProducerStrategyIdentityV1(producerManifest, expectedStrategyInput = null) {
  if (!object(producerManifest)) return failure("MISSING_EVIDENCE", "PRODUCER_MANIFEST_MISSING");
  const resolved = resolveCanonicalStrategyIdentity(producerManifest.strategyIdentity ?? {});
  if (resolved.status !== "IDENTITY_COMPLETE") {
    return failure("MISSING_EVIDENCE", "CANONICAL_STRATEGY_IDENTITY_MISSING", {
      missingFields: resolved.missingFields,
      blockers: resolved.blockers,
    });
  }
  if (!digest(producerManifest.strategyIdentityDigest)) return failure("MISSING_EVIDENCE", "STRATEGY_IDENTITY_DIGEST_MISSING");
  if (producerManifest.strategyIdentityDigest.toLowerCase() !== resolved.strategyIdentityDigest) {
    return failure("IDENTITY_MISMATCH", "STRATEGY_IDENTITY_DIGEST_MISMATCH");
  }
  const identity = resolved.identity;
  const directMismatches = [];
  if (producerManifest.datasetId !== identity.datasetId) directMismatches.push("datasetId");
  if (producerManifest.datasetDigest !== identity.datasetDigest) directMismatches.push("datasetDigest");
  if (producerManifest.researchCodeSha !== identity.researchCodeSha) directMismatches.push("researchCodeSha");
  if (directMismatches.length) {
    return failure("IDENTITY_MISMATCH", "PRODUCER_STRATEGY_PROVENANCE_MISMATCH", { mismatchedFields: directMismatches });
  }
  if (expectedStrategyInput) {
    const expected = resolveCanonicalStrategyIdentity(expectedStrategyInput);
    if (expected.status !== "IDENTITY_COMPLETE") return failure("MISSING_EVIDENCE", "EXPECTED_STRATEGY_IDENTITY_MISSING");
    if (expected.strategyIdentityDigest !== resolved.strategyIdentityDigest) {
      return failure("IDENTITY_MISMATCH", "EXPECTED_STRATEGY_IDENTITY_MISMATCH");
    }
  }
  return deepFreeze({
    valid: true,
    status: "IDENTITY_COMPLETE",
    reason: null,
    strategyIdentity: identity,
    strategyIdentityDigest: resolved.strategyIdentityDigest,
    safety: SAFETY,
  });
}

function trainingRunIdentityFromManifest(producerManifest) {
  const receipt = object(producerManifest.artifactReceipt);
  const required = {
    artifactId: receipt?.artifactId ?? null,
    artifactReference: receipt?.artifactReference ?? null,
    outerArtifactDigest: digest(receipt?.outerArtifactDigest),
    rawArtifactDigest: digest(producerManifest.rawArtifactDigest),
    trainingCodeSha: sha(producerManifest.trainingCodeSha),
    measuredAt: iso(producerManifest.measuredAt),
  };
  if (!required.artifactId || !required.artifactReference || !required.outerArtifactDigest
      || !required.rawArtifactDigest || !required.trainingCodeSha || !required.measuredAt) return null;
  return deepFreeze(required);
}

export function resolveModelIdentityMappingV1({
  producerManifest,
  exactModelBytes,
  modelArtifact = null,
  strategyResolution,
  expectedModelIdentity = null,
} = {}) {
  if (!strategyResolution?.valid) return failure(strategyResolution?.status ?? "MISSING_EVIDENCE", "STRATEGY_IDENTITY_REQUIRED_FOR_MODEL_IDENTITY");
  if (!object(producerManifest)) return failure("MISSING_EVIDENCE", "PRODUCER_MANIFEST_MISSING");
  const exactBytes = bytes(exactModelBytes);
  if (!exactBytes) return failure("MISSING_EVIDENCE", "EXACT_MODEL_BYTES_MISSING");
  const exactModelBytesSha = sha256Bytes(exactBytes);
  const producerExactSha = digest(producerManifest.modelSha);
  if (!producerExactSha) return failure("MISSING_EVIDENCE", "PRODUCER_EXACT_MODEL_BYTES_SHA_MISSING");
  if (exactModelBytesSha !== producerExactSha) return failure("IDENTITY_MISMATCH", "EXACT_MODEL_BYTES_SHA_MISMATCH");

  let exactModel;
  try { exactModel = JSON.parse(exactBytes.toString("utf8")); }
  catch { return failure("IDENTITY_MISMATCH", "EXACT_MODEL_JSON_MALFORMED"); }
  const canonicalModelArtifactDigest = sha256Canonical(exactModel);
  const producerCanonicalDigest = digest(producerManifest.modelArtifactCanonicalDigest);
  if (!producerCanonicalDigest) return failure("MISSING_EVIDENCE", "CANONICAL_MODEL_ARTIFACT_DIGEST_MISSING");
  if (canonicalModelArtifactDigest !== producerCanonicalDigest) {
    return failure("IDENTITY_MISMATCH", "CANONICAL_MODEL_ARTIFACT_DIGEST_MISMATCH");
  }
  if (modelArtifact && sha256Canonical(modelArtifact?.model ?? modelArtifact) !== canonicalModelArtifactDigest) {
    return failure("IDENTITY_MISMATCH", "CONSUMER_MODEL_ARTIFACT_DIGEST_MISMATCH");
  }

  const featureOrder = exactModel.featureOrder;
  if (!Array.isArray(featureOrder) || !featureOrder.length) return failure("MISSING_EVIDENCE", "MODEL_FEATURE_ORDER_MISSING");
  const featureOrderDigest = sha256Canonical(featureOrder);
  if (!digest(producerManifest.featureOrderDigest)) return failure("MISSING_EVIDENCE", "FEATURE_ORDER_DIGEST_MISSING");
  if (featureOrderDigest !== producerManifest.featureOrderDigest.toLowerCase()) return failure("IDENTITY_MISMATCH", "FEATURE_ORDER_DIGEST_MISMATCH");
  if (!producerManifest.preprocessingVersion) return failure("MISSING_EVIDENCE", "PREPROCESSING_VERSION_MISSING");

  const trainingRunIdentity = trainingRunIdentityFromManifest(producerManifest);
  if (!trainingRunIdentity) return failure("MISSING_EVIDENCE", "TRAINING_RUN_IDENTITY_MISSING");
  const modelSchemaVersion = exactModel.modelSchemaVersion ?? exactModel.schemaVersion ?? exactModel.modelType ?? null;
  if (typeof modelSchemaVersion !== "string" || !modelSchemaVersion) return failure("MISSING_EVIDENCE", "MODEL_SCHEMA_IDENTITY_MISSING");
  if (!digest(producerManifest.datasetDigest)) return failure("MISSING_EVIDENCE", "DATASET_IDENTITY_DIGEST_MISSING");

  const mapping = deepFreeze({
    schemaVersion: MODEL_IDENTITY_MAPPING_SCHEMA_VERSION,
    exactModelBytesSha,
    exactModelBytesShaSemantics: "sha256(exact serialized model bytes)",
    canonicalModelArtifactDigest,
    canonicalModelArtifactDigestSemantics: "sha256(canonical parsed model artifact)",
    trainingRunIdentity,
    trainingRunIdentityDigest: sha256Canonical(trainingRunIdentity),
    strategyIdentityDigest: strategyResolution.strategyIdentityDigest,
    datasetIdentity: Object.freeze({
      datasetId: producerManifest.datasetId,
      datasetDigest: producerManifest.datasetDigest.toLowerCase(),
    }),
    datasetIdentityDigest: producerManifest.datasetDigest.toLowerCase(),
    featureOrderDigest,
    preprocessingVersion: producerManifest.preprocessingVersion,
    modelSchemaVersion,
  });
  const modelIdentityDigest = sha256Canonical(mapping);

  if (expectedModelIdentity) {
    const expected = object(expectedModelIdentity);
    if (!expected) return failure("MISSING_EVIDENCE", "EXPECTED_MODEL_IDENTITY_MISSING");
    const fields = [
      "exactModelBytesSha",
      "canonicalModelArtifactDigest",
      "strategyIdentityDigest",
      "datasetIdentityDigest",
      "featureOrderDigest",
      "preprocessingVersion",
      "modelSchemaVersion",
    ];
    const mismatchedFields = fields.filter((field) => expected[field] != null && expected[field] !== mapping[field]);
    if (expected.trainingRunIdentityDigest != null && expected.trainingRunIdentityDigest !== mapping.trainingRunIdentityDigest) mismatchedFields.push("trainingRunIdentityDigest");
    if (mismatchedFields.length) return failure("IDENTITY_MISMATCH", "EXPECTED_MODEL_IDENTITY_MISMATCH", { mismatchedFields });
  }

  return deepFreeze({
    valid: true,
    status: "IDENTITY_COMPLETE",
    reason: null,
    modelIdentity: mapping,
    modelIdentityDigest,
    exactModel,
    safety: SAFETY,
  });
}

function parseJsonlReference(rawBytes, label) {
  const source = bytes(rawBytes);
  if (!source) return failure("MISSING_EVIDENCE", `${label}_REFERENCE_BYTES_MISSING`);
  const text = source.toString("utf8");
  if (!text.endsWith("\n")) return failure("IDENTITY_MISMATCH", `${label}_REFERENCE_JSONL_TERMINATOR_MISMATCH`);
  const lines = text.slice(0, -1).split("\n");
  if (!lines.length || lines.some((line) => !line)) return failure("MISSING_EVIDENCE", `${label}_REFERENCE_RECORDS_MISSING`);
  try {
    return deepFreeze({ valid: true, bytes: source, records: lines.map((line) => JSON.parse(line)) });
  } catch {
    return failure("IDENTITY_MISMATCH", `${label}_REFERENCE_JSONL_MALFORMED`);
  }
}

export function resolveTrainValidationReferenceV1({ producerManifest, trainReferenceBytes, validationReferenceBytes, asOf = new Date().toISOString() } = {}) {
  if (!object(producerManifest)) return failure("MISSING_EVIDENCE", "PRODUCER_MANIFEST_MISSING");
  const expiresAt = iso(producerManifest.artifactReceipt?.expiresAt);
  const now = iso(asOf);
  if (!now) return failure("MISSING_EVIDENCE", "REFERENCE_AS_OF_INVALID");
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(now)) return failure("REFERENCE_EXPIRED", "TRAIN_VALIDATION_REFERENCE_EXPIRED");
  if (producerManifest.status !== "VALID" || producerManifest.referenceProvenanceStatus !== "VALID") {
    return failure(producerManifest.status === "IDENTITY_MISMATCH" ? "IDENTITY_MISMATCH" : "MISSING_EVIDENCE", "PRODUCER_REFERENCE_NOT_CANONICALLY_VALID");
  }
  const source = producerManifest.sourceAttestation;
  if (source?.sourceKind !== "GENUINE_MARKET_DATA" || source.reconstructed !== false || source.synthetic !== false
      || source.shadowDerived !== false || source.finalHoldoutIncluded !== false) {
    return failure("IDENTITY_MISMATCH", "REFERENCE_SOURCE_SUBSTITUTION_REJECTED");
  }
  const train = parseJsonlReference(trainReferenceBytes, "TRAIN");
  if (!train.valid) return train;
  const validation = parseJsonlReference(validationReferenceBytes, "VALIDATION");
  if (!validation.valid) return validation;
  if (!digest(producerManifest.trainSplitDigest) || sha256Bytes(train.bytes) !== producerManifest.trainSplitDigest.toLowerCase()) {
    return failure("IDENTITY_MISMATCH", "TRAIN_REFERENCE_DIGEST_MISMATCH");
  }
  if (!digest(producerManifest.validationSplitDigest) || sha256Bytes(validation.bytes) !== producerManifest.validationSplitDigest.toLowerCase()) {
    return failure("IDENTITY_MISMATCH", "VALIDATION_REFERENCE_DIGEST_MISMATCH");
  }
  if (producerManifest.trainSampleN !== train.records.length) return failure("IDENTITY_MISMATCH", "TRAIN_REFERENCE_SAMPLE_N_MISMATCH");
  if (producerManifest.validationSampleN !== validation.records.length) return failure("IDENTITY_MISMATCH", "VALIDATION_REFERENCE_SAMPLE_N_MISMATCH");
  const malformed = [...train.records, ...validation.records].some((record) => !object(record?.features));
  if (malformed) return failure("MISSING_EVIDENCE", "REFERENCE_FEATURE_SNAPSHOT_MISSING");
  return deepFreeze({
    valid: true,
    status: "VALID",
    reason: null,
    trainRecords: train.records,
    validationRecords: validation.records,
    referenceRecords: [...train.records, ...validation.records],
    referenceIdentity: Object.freeze({
      datasetId: producerManifest.datasetId,
      datasetDigest: producerManifest.datasetDigest,
      trainSplitDigest: producerManifest.trainSplitDigest,
      validationSplitDigest: producerManifest.validationSplitDigest,
      rawArtifactDigest: producerManifest.rawArtifactDigest,
      preprocessingVersion: producerManifest.preprocessingVersion,
      featureOrderDigest: producerManifest.featureOrderDigest,
    }),
    freshness: Object.freeze({ checkedAt: now, expiresAt, status: "FRESH" }),
    safety: SAFETY,
  });
}

function genuineSource(sourceProvenance) {
  return sourceProvenance?.sourceKind === "GENUINE_SHADOW_OBSERVATION"
    && sourceProvenance.capturedAtObservationTime === true
    && sourceProvenance.reconstructed === false
    && sourceProvenance.synthetic === false
    && sourceProvenance.replayed === false
    && sourceProvenance.historicalBackfill === false;
}

function component(probabilities, label) {
  const validated = assertProbabilities(probabilities, label);
  return deepFreeze({ probabilities: validated, finalDirection: topClass(validated) });
}

function genuineSettlementSource(sourceProvenance) {
  return sourceProvenance?.sourceKind === "GENUINE_FUTURE_SHADOW_OUTCOME"
    && sourceProvenance.capturedAfterObservation === true
    && sourceProvenance.reconstructed === false
    && sourceProvenance.synthetic === false
    && sourceProvenance.replayed === false
    && sourceProvenance.historicalBackfill === false;
}

function settlementIdentityPayload(settlement) {
  const copy = structuredClone(settlement);
  delete copy.evidenceDigest;
  return copy;
}

function computeSettlementEvidenceDigestV1(settlement) {
  return sha256Canonical(settlementIdentityPayload(settlement));
}

export function buildNormalizedFeatureSnapshotV1({ rawFeatureSnapshot, exactModel } = {}) {
  if (!object(rawFeatureSnapshot) || !object(exactModel) || !Array.isArray(exactModel.featureOrder) || !exactModel.featureOrder.length) {
    throw new TypeError("raw feature snapshot and exact model feature order are required");
  }
  const normalization = exactModel.normalization;
  if (normalization && (!Array.isArray(normalization.mean) || !Array.isArray(normalization.scale)
      || normalization.mean.length !== exactModel.featureOrder.length || normalization.scale.length !== exactModel.featureOrder.length)) {
    throw new Error("exact model normalization identity is invalid");
  }
  return deepFreeze(Object.fromEntries(exactModel.featureOrder.map((name, index) => {
    const raw = finite(rawFeatureSnapshot[name]) ? rawFeatureSnapshot[name] : 0;
    if (!normalization) return [name, raw];
    const mean = finite(normalization.mean[index]) ? normalization.mean[index] : 0;
    const scale = Math.max(Math.abs(finite(normalization.scale[index]) ? normalization.scale[index] : 1), 1e-9);
    return [name, Math.min(12, Math.max(-12, (raw - mean) / scale))];
  })));
}

export function buildFutureShadowObservationV1({
  observationId,
  observedAt,
  signalAt,
  symbol,
  market,
  timeframe,
  direction,
  strategyIdentity,
  strategyIdentityDigest,
  modelIdentity,
  modelIdentityDigest,
  referenceIdentity,
  regime,
  rawFeatureSnapshot,
  normalizedFeatureSnapshot,
  inference,
  confidence = null,
  referencePrice,
  priceProvenance,
  dataFreshness,
  sourceProvenance,
} = {}) {
  const canonicalObservedAt = iso(observedAt);
  const canonicalSignalAt = iso(signalAt);
  if (!observationId || !canonicalObservedAt || !canonicalSignalAt || !symbol || !market || !timeframe || !direction) throw new TypeError("canonical observation identity fields are required");
  if (Date.parse(canonicalSignalAt) > Date.parse(canonicalObservedAt)) throw new Error("future Shadow signal must exist before observation capture");
  if (!object(strategyIdentity) || !object(modelIdentity) || !digest(strategyIdentityDigest) || !digest(modelIdentityDigest)) throw new TypeError("strategy/model identities and digests are required");
  if (sha256Canonical(strategyIdentity) !== strategyIdentityDigest.toLowerCase()
      || sha256Canonical(modelIdentity) !== modelIdentityDigest.toLowerCase()) throw new Error("strategy/model identity digest mismatch");
  if (!object(referenceIdentity) || !object(rawFeatureSnapshot) || !object(normalizedFeatureSnapshot)) throw new TypeError("reference/raw/normalized feature evidence is required");
  if (!finite(referencePrice) || referencePrice <= 0 || !object(priceProvenance)
      || priceProvenance.provider !== sourceProvenance?.provider
      || iso(priceProvenance.signalAt) !== canonicalSignalAt
      || !Number.isInteger(priceProvenance.candleTimestamp)) {
    throw new TypeError("canonical signal reference price provenance is required");
  }
  if (!genuineSource(sourceProvenance)) throw new Error("historical/replayed/synthetic Shadow component evidence is forbidden");
  if (!object(dataFreshness) || dataFreshness.status !== "FRESH" || !finite(dataFreshness.ageMs) || !finite(dataFreshness.maxAgeMs) || dataFreshness.ageMs < 0 || dataFreshness.ageMs > dataFreshness.maxAgeMs) {
    throw new Error("fresh genuine Shadow feature evidence is required");
  }
  const ruleOnly = component(inference?.ruleProbabilities, "RULE_ONLY");
  const modelOnly = component(inference?.modelProbabilities, "MODEL_ONLY");
  const blend = component(inference?.probabilities, "DEPLOYED_FROZEN_BLEND");
  const body = {
    schemaVersion: SHADOW_OBSERVATION_SCHEMA_VERSION,
    observationId: String(observationId),
    observedAt: canonicalObservedAt,
    signalAt: canonicalSignalAt,
    symbol: String(symbol),
    market: String(market),
    timeframe: String(timeframe),
    direction: String(direction),
    strategyIdentity: structuredClone(strategyIdentity),
    strategyIdentityDigest: strategyIdentityDigest.toLowerCase(),
    modelIdentity: structuredClone(modelIdentity),
    modelIdentityDigest: modelIdentityDigest.toLowerCase(),
    referenceIdentity: structuredClone(referenceIdentity),
    regime: structuredClone(regime ?? null),
    rawFeatureSnapshot: structuredClone(rawFeatureSnapshot),
    normalizedFeatureSnapshot: structuredClone(normalizedFeatureSnapshot),
    components: {
      RULE_ONLY: ruleOnly,
      MODEL_ONLY: modelOnly,
      DEPLOYED_FROZEN_BLEND: {
        ...blend,
        weights: FROZEN_BLEND_WEIGHTS,
      },
    },
    confidence: finite(confidence) ? confidence : Math.max(...Object.values(blend.probabilities)),
    referencePrice,
    priceProvenance: structuredClone(priceProvenance),
    dataFreshness: structuredClone(dataFreshness),
    sourceProvenance: structuredClone(sourceProvenance),
    creditEligibility: {
      genuineFuture: true,
      duplicate: false,
      replay: false,
      synthetic: false,
      historicalBackfill: false,
      hindsightReconstruction: false,
    },
    positionEvidence: {
      status: "POSITION",
      nature: "NON_EXECUTING_SHADOW_POSITION",
      openedAt: canonicalObservedAt,
      actualOrder: false,
      executionAuthority: "NONE",
    },
    settlementStatus: "PENDING_SETTLEMENT",
    settlement: null,
    actualDirection: null,
  };
  body.artifactDigest = computeShadowObservationArtifactDigestV1(body);
  return deepFreeze(body);
}

export function buildFutureShadowSettlementEvidenceV1({
  observation,
  actualDirection,
  settlementPrice,
  futureCandles,
  horizonBars,
  outcomeAt,
  settledAt,
  costEvidence,
  sourceProvenance,
} = {}) {
  if (!object(observation) || observation.schemaVersion !== SHADOW_OBSERVATION_SCHEMA_VERSION) {
    throw new TypeError("canonical future Shadow observation is required");
  }
  const normalizedActual = normalizeDirection(actualDirection);
  if (!normalizedActual) throw new TypeError("settled actual direction is required");
  if (!finite(settlementPrice) || settlementPrice <= 0 || !Number.isInteger(horizonBars) || horizonBars <= 0) {
    throw new TypeError("canonical settlement price and horizon are required");
  }
  if (!Array.isArray(futureCandles) || futureCandles.length !== horizonBars) throw new TypeError("exact future settlement candle window is required");
  if (!genuineSettlementSource(sourceProvenance)) throw new Error("historical/replayed/synthetic Shadow settlement evidence is forbidden");
  const canonicalOutcomeAt = iso(outcomeAt);
  const canonicalSettledAt = iso(settledAt);
  if (!canonicalOutcomeAt || !canonicalSettledAt
      || Date.parse(canonicalOutcomeAt) <= Date.parse(observation.observedAt)
      || Date.parse(canonicalSettledAt) < Date.parse(canonicalOutcomeAt)) {
    throw new Error("future Shadow outcome must occur after observation and before settlement capture");
  }
  let previousTimestamp = null;
  for (const candle of futureCandles) {
    if (!Number.isInteger(candle?.timestamp) || !finite(candle?.high) || !finite(candle?.low) || !finite(candle?.close)
        || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.high < candle.low
        || (previousTimestamp != null && candle.timestamp <= previousTimestamp)) {
      throw new TypeError("future settlement candles are invalid");
    }
    previousTimestamp = candle.timestamp;
  }
  if (Math.abs(futureCandles.at(-1).close - settlementPrice) > EPSILON) throw new Error("settlement price does not match the exact future candle window");
  if (!object(costEvidence) || costEvidence.applicable !== false || costEvidence.reason !== "SHADOW_NO_EXECUTION") {
    throw new TypeError("explicit non-executing Shadow cost evidence is required");
  }
  const signalPrice = observation.referencePrice;
  const realizedMove = (settlementPrice / signalPrice) - 1;
  const maxUpMove = Math.max(...futureCandles.map((candle) => (candle.high / signalPrice) - 1));
  const maxDownMove = Math.min(...futureCandles.map((candle) => (candle.low / signalPrice) - 1));
  const predictedDirection = normalizeDirection(observation.components?.DEPLOYED_FROZEN_BLEND?.finalDirection);
  const directionalRealizedMove = predictedDirection === "bullish"
    ? realizedMove
    : (predictedDirection === "bearish" ? -realizedMove : null);
  const mfe = predictedDirection === "bullish"
    ? Math.max(0, maxUpMove)
    : (predictedDirection === "bearish" ? Math.max(0, -maxDownMove) : null);
  const mae = predictedDirection === "bullish"
    ? Math.min(0, maxDownMove)
    : (predictedDirection === "bearish" ? Math.min(0, -maxUpMove) : null);
  const body = {
    schemaVersion: SHADOW_SETTLEMENT_SCHEMA_VERSION,
    observationId: observation.observationId,
    observationArtifactDigest: observation.artifactDigest,
    strategyIdentity: structuredClone(observation.strategyIdentity),
    strategyIdentityDigest: observation.strategyIdentityDigest,
    modelIdentity: structuredClone(observation.modelIdentity),
    modelIdentityDigest: observation.modelIdentityDigest,
    symbol: observation.symbol,
    market: observation.market,
    timeframe: observation.timeframe,
    direction: observation.direction,
    signalAt: observation.signalAt,
    signalPrice,
    settlementPrice,
    horizon: {
      bars: horizonBars,
      timeframe: observation.timeframe,
      firstCandleTimestamp: futureCandles[0].timestamp,
      lastCandleTimestamp: futureCandles.at(-1).timestamp,
      outcomeAt: canonicalOutcomeAt,
    },
    realizedMove,
    directionalRealizedMove,
    directionalOutcome: normalizedActual,
    excursions: {
      maximumFavorableExcursion: mfe,
      maximumAdverseExcursion: mae,
      maxUpMove,
      maxDownMove,
      basisDirection: predictedDirection,
      neutralPositionReason: predictedDirection === "neutral" ? "NO_DIRECTIONAL_SHADOW_POSITION" : null,
    },
    costEvidence: structuredClone(costEvidence),
    settledAt: canonicalSettledAt,
    sourceProvenance: {
      ...structuredClone(sourceProvenance),
      firstCandleTimestamp: futureCandles[0].timestamp,
      lastCandleTimestamp: futureCandles.at(-1).timestamp,
    },
  };
  body.evidenceDigest = computeSettlementEvidenceDigestV1(body);
  return deepFreeze(body);
}

function validSettlementEvidence(observation, settlement) {
  const pendingObservation = structuredClone(observation);
  delete pendingObservation.artifactDigest;
  pendingObservation.actualDirection = null;
  pendingObservation.settlementStatus = "PENDING_SETTLEMENT";
  pendingObservation.settlement = null;
  pendingObservation.positionEvidence = {
    ...pendingObservation.positionEvidence,
    status: "POSITION",
  };
  delete pendingObservation.positionEvidence.closedAt;
  const pendingArtifactDigest = computeShadowObservationArtifactDigestV1(pendingObservation);
  if (!object(settlement) || settlement.schemaVersion !== SHADOW_SETTLEMENT_SCHEMA_VERSION
      || !digest(settlement.evidenceDigest) || settlement.evidenceDigest !== computeSettlementEvidenceDigestV1(settlement)
      || settlement.observationId !== observation.observationId
      || settlement.strategyIdentityDigest !== observation.strategyIdentityDigest
      || settlement.modelIdentityDigest !== observation.modelIdentityDigest
      || sha256Canonical(settlement.strategyIdentity) !== observation.strategyIdentityDigest
      || sha256Canonical(settlement.modelIdentity) !== observation.modelIdentityDigest
      || settlement.observationArtifactDigest !== pendingArtifactDigest
      || settlement.symbol !== observation.symbol || settlement.market !== observation.market
      || settlement.timeframe !== observation.timeframe || settlement.direction !== observation.direction
      || settlement.signalAt !== observation.signalAt || settlement.signalPrice !== observation.referencePrice
      || !finite(settlement.settlementPrice) || settlement.settlementPrice <= 0
      || !finite(settlement.realizedMove)
      || Math.abs(settlement.realizedMove - ((settlement.settlementPrice / observation.referencePrice) - 1)) > EPSILON
      || !Number.isInteger(settlement.horizon?.bars) || settlement.horizon.bars <= 0
      || !Number.isInteger(settlement.horizon?.firstCandleTimestamp)
      || !Number.isInteger(settlement.horizon?.lastCandleTimestamp)
      || settlement.horizon.firstCandleTimestamp > settlement.horizon.lastCandleTimestamp
      || normalizeDirection(settlement.directionalOutcome) == null
      || settlement.costEvidence?.applicable !== false || settlement.costEvidence?.reason !== "SHADOW_NO_EXECUTION"
      || !genuineSettlementSource(settlement.sourceProvenance)
      || settlement.sourceProvenance.provider !== observation.sourceProvenance.provider
      || settlement.sourceProvenance.firstCandleTimestamp !== settlement.horizon.firstCandleTimestamp
      || settlement.sourceProvenance.lastCandleTimestamp !== settlement.horizon.lastCandleTimestamp
      || Date.parse(settlement.horizon?.outcomeAt) <= Date.parse(observation.observedAt)
      || Date.parse(settlement.settledAt) < Date.parse(settlement.horizon?.outcomeAt)) return false;
  const predictedDirection = normalizeDirection(observation.components?.DEPLOYED_FROZEN_BLEND?.finalDirection);
  if (predictedDirection === "neutral") {
    if (settlement.directionalRealizedMove !== null
        || settlement.excursions?.maximumFavorableExcursion !== null
        || settlement.excursions?.maximumAdverseExcursion !== null) return false;
  } else if (!finite(settlement.directionalRealizedMove)
      || !finite(settlement.excursions?.maximumFavorableExcursion)
      || !finite(settlement.excursions?.maximumAdverseExcursion)) return false;
  return true;
}

export function settleFutureShadowObservationV1(observation, settlement) {
  if (!object(observation) || observation.schemaVersion !== SHADOW_OBSERVATION_SCHEMA_VERSION) {
    throw new TypeError("canonical future Shadow observation is required");
  }
  if (!validSettlementEvidence(observation, settlement)) {
    throw new TypeError("canonical future Shadow settlement evidence is required");
  }
  if (observation.settlement) {
    if (observation.settlement.evidenceDigest !== settlement.evidenceDigest) throw new Error("future Shadow observation settlement conflict");
    return observation;
  }
  const body = structuredClone(observation);
  delete body.artifactDigest;
  body.actualDirection = settlement.directionalOutcome;
  body.settlementStatus = "SETTLED";
  body.settlement = structuredClone(settlement);
  body.positionEvidence = {
    ...body.positionEvidence,
    status: "CLOSED",
    closedAt: settlement.horizon.outcomeAt,
  };
  body.artifactDigest = computeShadowObservationArtifactDigestV1(body);
  return deepFreeze(body);
}

export function validateFutureShadowObservationV1({ observation, strategyResolution, modelResolution, referenceResolution, featureOrder } = {}) {
  if (!object(observation)) return failure("MISSING_EVIDENCE", "SHADOW_OBSERVATION_MISSING");
  if (observation.schemaVersion !== SHADOW_OBSERVATION_SCHEMA_VERSION) return failure("MISSING_EVIDENCE", "SHADOW_COMPONENT_SCHEMA_MISSING");
  if (!genuineSource(observation.sourceProvenance)) return failure("MISSING_EVIDENCE", "HISTORICAL_OR_REPLAYED_COMPONENTS_NOT_CREDITABLE");
  const signalAt = iso(observation.signalAt);
  const observedAt = iso(observation.observedAt);
  if (!signalAt || !observedAt || Date.parse(signalAt) > Date.parse(observedAt)) return failure("MISSING_EVIDENCE", "FUTURE_TIMESTAMP_INTEGRITY_FAILED");
  if (!finite(observation.referencePrice) || observation.referencePrice <= 0 || !object(observation.priceProvenance)
      || observation.priceProvenance.provider !== observation.sourceProvenance.provider
      || iso(observation.priceProvenance.signalAt) !== signalAt) return failure("MISSING_EVIDENCE", "SIGNAL_REFERENCE_PRICE_PROVENANCE_MISSING");
  if (observation.creditEligibility?.genuineFuture !== true || observation.creditEligibility?.duplicate !== false
      || observation.creditEligibility?.replay !== false || observation.creditEligibility?.synthetic !== false
      || observation.creditEligibility?.historicalBackfill !== false || observation.creditEligibility?.hindsightReconstruction !== false) {
    return failure("MISSING_EVIDENCE", "OBSERVATION_CREDIT_FLAGS_INVALID");
  }
  if (!strategyResolution?.valid || !modelResolution?.valid || !referenceResolution?.valid) return failure("MISSING_EVIDENCE", "CANONICAL_IDENTITY_CHAIN_INCOMPLETE");
  const strategy = strategyResolution.strategyIdentity;
  if (observation.strategyIdentityDigest !== strategyResolution.strategyIdentityDigest) return failure("IDENTITY_MISMATCH", "OBSERVATION_STRATEGY_IDENTITY_MISMATCH");
  if (observation.modelIdentityDigest !== modelResolution.modelIdentityDigest) return failure("IDENTITY_MISMATCH", "OBSERVATION_MODEL_IDENTITY_MISMATCH");
  if (sha256Canonical(observation.strategyIdentity) !== strategyResolution.strategyIdentityDigest
      || sha256Canonical(observation.modelIdentity) !== modelResolution.modelIdentityDigest) return failure("IDENTITY_MISMATCH", "OBSERVATION_FULL_IDENTITY_MISMATCH");
  if (observation.market !== strategy.market || observation.timeframe !== strategy.timeframe || observation.direction !== strategy.direction) {
    return failure("IDENTITY_MISMATCH", "OBSERVATION_MARKET_TIMEFRAME_DIRECTION_MISMATCH");
  }
  const reference = observation.referenceIdentity;
  for (const field of ["datasetId", "datasetDigest", "trainSplitDigest", "validationSplitDigest", "preprocessingVersion", "featureOrderDigest"]) {
    if (reference?.[field] !== referenceResolution.referenceIdentity[field]) return failure("IDENTITY_MISMATCH", `OBSERVATION_REFERENCE_${field.toUpperCase()}_MISMATCH`);
  }
  const freshness = observation.dataFreshness;
  if (!object(freshness) || freshness.status !== "FRESH" || !finite(freshness.ageMs) || !finite(freshness.maxAgeMs) || freshness.ageMs < 0 || freshness.ageMs > freshness.maxAgeMs) {
    return failure("MISSING_EVIDENCE", "STALE_FEATURE_SNAPSHOT");
  }
  const order = featureOrder ?? modelResolution.exactModel.featureOrder;
  if (!object(observation.rawFeatureSnapshot) || !object(observation.normalizedFeatureSnapshot)
      || order.some((name) => !Object.hasOwn(observation.rawFeatureSnapshot, name) || !Object.hasOwn(observation.normalizedFeatureSnapshot, name))) {
    return failure("MISSING_EVIDENCE", "RAW_OR_NORMALIZED_FEATURE_SNAPSHOT_INCOMPLETE");
  }
  let expectedNormalized;
  try {
    expectedNormalized = buildNormalizedFeatureSnapshotV1({ rawFeatureSnapshot: observation.rawFeatureSnapshot, exactModel: modelResolution.exactModel });
  } catch {
    return failure("MISSING_EVIDENCE", "MODEL_PREPROCESSING_IDENTITY_INCOMPLETE");
  }
  if (order.some((name) => !finite(observation.normalizedFeatureSnapshot[name])
      || Math.abs(observation.normalizedFeatureSnapshot[name] - expectedNormalized[name]) > 1e-12)) {
    return failure("IDENTITY_MISMATCH", "NORMALIZED_FEATURE_SNAPSHOT_MISMATCH");
  }
  let rule;
  let model;
  let blend;
  try {
    rule = assertProbabilities(observation.components?.RULE_ONLY?.probabilities, "RULE_ONLY");
    model = assertProbabilities(observation.components?.MODEL_ONLY?.probabilities, "MODEL_ONLY");
    blend = assertProbabilities(observation.components?.DEPLOYED_FROZEN_BLEND?.probabilities, "DEPLOYED_FROZEN_BLEND");
  } catch {
    return failure("MISSING_EVIDENCE", "RULE_MODEL_BLEND_COMPONENT_MISSING");
  }
  const weights = observation.components?.DEPLOYED_FROZEN_BLEND?.weights;
  if (weights?.rule !== FROZEN_BLEND_WEIGHTS.rule || weights?.model !== FROZEN_BLEND_WEIGHTS.model) return failure("IDENTITY_MISMATCH", "FROZEN_65_35_BLEND_WEIGHT_MISMATCH");
  for (const [name, probabilities] of [["RULE_ONLY", rule], ["MODEL_ONLY", model], ["DEPLOYED_FROZEN_BLEND", blend]]) {
    if (normalizeDirection(observation.components?.[name]?.finalDirection) !== topClass(probabilities)) return failure("IDENTITY_MISMATCH", `${name}_FINAL_DIRECTION_MISMATCH`);
  }
  if (observation.actualDirection || observation.settlementStatus === "SETTLED" || observation.settlement) {
    const settlement = observation.settlement;
    if (!validSettlementEvidence(observation, settlement)
        || normalizeDirection(settlement.directionalOutcome) !== normalizeDirection(observation.actualDirection)) {
      return failure("MISSING_EVIDENCE", "CANONICAL_SETTLEMENT_EVIDENCE_INVALID");
    }
  } else if (observation.settlementStatus !== "PENDING_SETTLEMENT") {
    return failure("MISSING_EVIDENCE", "SETTLEMENT_STATUS_INVALID");
  }
  if (!digest(observation.artifactDigest) || observation.artifactDigest !== computeShadowObservationArtifactDigestV1(observation)) return failure("IDENTITY_MISMATCH", "SHADOW_OBSERVATION_ARTIFACT_DIGEST_MISMATCH");
  return deepFreeze({ valid: true, status: "VALID", reason: null, observation, safety: SAFETY });
}

export function validateFutureShadowObservationBatchV1({ observations, ...context } = {}) {
  if (!Array.isArray(observations) || !observations.length) return failure("MISSING_EVIDENCE", "GENUINE_FUTURE_SHADOW_SAMPLE_MISSING");
  const seenIds = new Set();
  const seenDigests = new Set();
  const validated = [];
  for (const observation of observations) {
    if (seenIds.has(observation?.observationId) || seenDigests.has(observation?.artifactDigest)) return failure("IDENTITY_MISMATCH", "DUPLICATE_SHADOW_OBSERVATION");
    const result = validateFutureShadowObservationV1({ observation, ...context });
    if (!result.valid) return result;
    seenIds.add(observation.observationId);
    seenDigests.add(observation.artifactDigest);
    validated.push(observation);
  }
  return deepFreeze({ valid: true, status: "VALID", reason: null, observations: validated, sampleN: validated.length, safety: SAFETY });
}

function numericSummary(values, totalCount) {
  const numeric = values.filter(finite);
  const average = numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
  const variance = average == null ? null : numeric.reduce((sum, value) => sum + ((value - average) ** 2), 0) / numeric.length;
  const sorted = [...numeric].sort((a, b) => a - b);
  const q = (p) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return lower === upper ? sorted[lower] : sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
  };
  return Object.freeze({
    count: numeric.length,
    missingRatio: totalCount ? (totalCount - numeric.length) / totalCount : null,
    zeroRatio: numeric.length ? numeric.filter((value) => value === 0).length / numeric.length : null,
    mean: average,
    std: variance == null ? null : Math.sqrt(variance),
    q05: q(0.05),
    q25: q(0.25),
    q50: q(0.5),
    q75: q(0.75),
    q95: q(0.95),
  });
}

function featureDriftMetrics({ featureName, referenceRecords, observations, model, strategyIdentityDigest, modelIdentityDigest, referenceIdentity }) {
  const referenceValuesAll = referenceRecords.map((record) => record.features?.[featureName]);
  const shadowValuesAll = observations.map((record) => record.rawFeatureSnapshot?.[featureName]);
  const referenceValues = referenceValuesAll.filter(finite);
  const shadowValues = shadowValuesAll.filter(finite);
  const reference = numericSummary(referenceValuesAll, referenceRecords.length);
  const shadow = numericSummary(shadowValuesAll, observations.length);
  if (referenceValues.length < 2 || shadowValues.length < 2) {
    return deepFreeze({ feature: featureName, status: "MISSING_EVIDENCE", reason: "INSUFFICIENT_EMPIRICAL_SAMPLE", psi: null, ksStatistic: null, ksPValue: null, jsd: null });
  }
  const scale = Math.max(Math.abs(reference.std ?? 0), EPSILON);
  const featureIndex = model.featureOrder.indexOf(featureName);
  const normalizationMean = model.normalization?.mean?.[featureIndex];
  const normalizationScale = Math.abs(model.normalization?.scale?.[featureIndex] ?? 0);
  const clipping = (values) => {
    if (!finite(normalizationMean) || !(normalizationScale > 0)) return null;
    return values.length ? values.filter((value) => Math.abs((value - normalizationMean) / normalizationScale) >= 12).length / values.length : null;
  };
  const quantileShift = Object.freeze({
    q05: (shadow.q05 - reference.q05) / scale,
    q25: (shadow.q25 - reference.q25) / scale,
    q50: (shadow.q50 - reference.q50) / scale,
    q75: (shadow.q75 - reference.q75) / scale,
    q95: (shadow.q95 - reference.q95) / scale,
  });
  return deepFreeze({
    feature: featureName,
    status: "MEASURED",
    reason: null,
    strategyIdentityDigest,
    modelIdentityDigest,
    referenceIdentity,
    referenceN: referenceValues.length,
    shadowN: shadowValues.length,
    reference,
    shadow,
    psi: populationStabilityIndex(referenceValues, shadowValues),
    ksStatistic: kolmogorovSmirnovDistance(referenceValues, shadowValues),
    ksPValue: null,
    ksPValueStatus: "NOT_COMPUTED_NO_CANONICAL_PVALUE_CONTRACT",
    jsd: jensenShannonDivergence(referenceValues, shadowValues),
    standardizedMeanShift: (shadow.mean - reference.mean) / scale,
    stdRatio: reference.std > EPSILON ? shadow.std / reference.std : null,
    missingRatio: Object.freeze({ reference: reference.missingRatio, shadow: shadow.missingRatio, delta: shadow.missingRatio - reference.missingRatio }),
    zeroRatio: Object.freeze({ reference: reference.zeroRatio, shadow: shadow.zeroRatio, delta: (shadow.zeroRatio ?? 0) - (reference.zeroRatio ?? 0) }),
    clippingRatio: Object.freeze({ reference: clipping(referenceValues), shadow: clipping(shadowValues) }),
    quantileShift,
  });
}

function canonicalPolicy(policy) {
  if (!object(policy) || policy.source !== "CANONICAL_EXISTING_POLICY" || policy.hindsightTuned !== false) return null;
  const watch = object(policy.watch);
  const brake = object(policy.brake);
  const metrics = ["psi", "ksStatistic", "jsd"];
  if (!watch || !brake || metrics.some((name) => !finite(watch[name]) || !finite(brake[name]) || watch[name] < 0 || brake[name] < watch[name])) return null;
  if (!Number.isInteger(brake.minimumTriggeredMetrics) || brake.minimumTriggeredMetrics < 2) return null;
  const body = {
    schemaVersion: policy.schemaVersion,
    source: policy.source,
    hindsightTuned: false,
    watch: { psi: watch.psi, ksStatistic: watch.ksStatistic, jsd: watch.jsd },
    brake: { psi: brake.psi, ksStatistic: brake.ksStatistic, jsd: brake.jsd, minimumTriggeredMetrics: brake.minimumTriggeredMetrics },
  };
  if (!digest(policy.policyDigest) || policy.policyDigest !== sha256Canonical(body)) return null;
  return deepFreeze({ ...body, policyDigest: policy.policyDigest });
}

export function buildDriftVerdictV1({ featureMetrics, canonicalDriftPolicy, strategyIdentityDigest, modelIdentityDigest, referenceIdentity, sampleN, futureSampleN = sampleN, settledN = sampleN, referenceN, freshness, asOf } = {}) {
  const metrics = Array.isArray(featureMetrics) ? featureMetrics : [];
  if (!metrics.length || metrics.some((item) => item.status !== "MEASURED" || !finite(item.psi) || !finite(item.ksStatistic) || !finite(item.jsd))) {
    return deepFreeze({
      status: "NOT_EVALUABLE",
      reason: settledN ? "INSUFFICIENT_SAMPLE" : "SETTLEMENT_NOT_DUE",
      strategyIdentityDigest,
      modelIdentityDigest,
      referenceIdentity,
      futureSampleN,
      settledN,
      referenceN,
      psi: null,
      ksStatistic: null,
      jsd: null,
      strongestDriftingFeatures: [],
      evidenceDigest: null,
      asOf,
      freshness,
    });
  }
  const policy = canonicalPolicy(canonicalDriftPolicy);
  if (!policy) return deepFreeze({
    status: "NOT_EVALUABLE",
    reason: "CANONICAL_DRIFT_POLICY_MISSING",
    strategyIdentityDigest,
    modelIdentityDigest,
    referenceIdentity,
    futureSampleN,
    settledN,
    referenceN,
    psi: null,
    ksStatistic: null,
    jsd: null,
    strongestDriftingFeatures: [],
    evidenceDigest: null,
    asOf,
    freshness,
  });
  const watchSignals = [];
  const brakeSignals = [];
  for (const item of metrics) {
    for (const metricName of ["psi", "ksStatistic", "jsd"]) {
      if (item[metricName] >= policy.watch[metricName]) watchSignals.push(`${item.feature}:${metricName}`);
      if (item[metricName] >= policy.brake[metricName]) brakeSignals.push(`${item.feature}:${metricName}`);
    }
  }
  const status = brakeSignals.length >= policy.brake.minimumTriggeredMetrics ? "BRAKE" : (watchSignals.length ? "WATCH" : "STABLE");
  const strongestDriftingFeatures = [...metrics]
    .sort((a, b) => Math.max(b.psi, b.ksStatistic, b.jsd) - Math.max(a.psi, a.ksStatistic, a.jsd) || a.feature.localeCompare(b.feature))
    .slice(0, 5)
    .map((item) => Object.freeze({ feature: item.feature, psi: item.psi, ks: item.ksStatistic, jsd: item.jsd }));
  const body = {
    status,
    reason: status === "STABLE" ? "CANONICAL_POLICY_WITHIN_LIMITS" : (status === "WATCH" ? "CANONICAL_POLICY_WATCH_SIGNAL" : "CANONICAL_POLICY_MULTI_SIGNAL_BRAKE"),
    strategyIdentityDigest,
    modelIdentityDigest,
    referenceIdentity,
    shadowSampleN: sampleN,
    futureSampleN,
    settledN,
    referenceN,
    strongestDriftingFeatures,
    watchSignals,
    brakeSignals,
    policyDigest: policy.policyDigest,
    asOf,
    freshness,
  };
  return deepFreeze({ ...body, evidenceDigest: sha256Canonical(body) });
}

function componentQuality(observations, componentName) {
  const predictedCounts = { bullish: 0, neutral: 0, bearish: 0 };
  const confusion = Object.fromEntries(CLASSES.map((actual) => [actual, Object.fromEntries(CLASSES.map((predicted) => [predicted, 0]))]));
  const settledObservations = observations.filter((observation) => normalizeDirection(observation.actualDirection));
  const settled = [];
  let brier = 0;
  let logLoss = 0;
  let catastrophic = 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
  for (const observation of settledObservations) {
    const item = observation.components[componentName];
    const probabilities = item.probabilities;
    const predicted = normalizeDirection(item.finalDirection);
    predictedCounts[predicted] += 1;
    const actual = normalizeDirection(observation.actualDirection);
    settled.push({ actual, predicted, probabilities });
    confusion[actual][predicted] += 1;
    if ((actual === "bullish" && predicted === "bearish") || (actual === "bearish" && predicted === "bullish")) catastrophic += 1;
    logLoss -= Math.log(Math.max(probabilities[actual], EPSILON));
    for (const name of CLASSES) brier += (probabilities[name] - (actual === name ? 1 : 0)) ** 2;
    const confidence = Math.max(...Object.values(probabilities));
    const bucket = Math.min(9, Math.floor(confidence * 10));
    bins[bucket].count += 1;
    bins[bucket].confidence += confidence;
    bins[bucket].correct += predicted === actual ? 1 : 0;
  }
  const perClass = {};
  for (const name of CLASSES) {
    const tp = confusion[name][name];
    const support = CLASSES.reduce((sum, predicted) => sum + confusion[name][predicted], 0);
    const predictedSupport = CLASSES.reduce((sum, actual) => sum + confusion[actual][name], 0);
    const precision = predictedSupport ? tp / predictedSupport : null;
    const recall = support ? tp / support : null;
    const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
    perClass[name] = Object.freeze({ support, predictedSupport, precision, recall, f1 });
  }
  const supported = CLASSES.filter((name) => perClass[name].support > 0);
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const ece = settled.length ? bins.reduce((sum, bin) => {
    if (!bin.count) return sum;
    const confidence = bin.confidence / bin.count;
    const accuracy = bin.correct / bin.count;
    return sum + (bin.count / settled.length) * Math.abs(confidence - accuracy);
  }, 0) : null;
  const total = settledObservations.length;
  return deepFreeze({
    sampleN: total,
    settledN: settled.length,
    totalObservationN: observations.length,
    directionRatio: Object.freeze({
      LONG: total ? predictedCounts.bullish / total : null,
      SHORT: total ? predictedCounts.bearish / total : null,
      NEUTRAL: total ? predictedCounts.neutral / total : null,
    }),
    predictedCounts: Object.freeze(predictedCounts),
    confusionMatrix: deepFreeze(confusion),
    perClass: deepFreeze(perClass),
    bullRecall: perClass.bullish.recall,
    bearRecall: perClass.bearish.recall,
    precision: mean(supported.map((name) => perClass[name].precision).filter(finite)),
    recall: mean(supported.map((name) => perClass[name].recall).filter(finite)),
    macroF1: mean(supported.map((name) => perClass[name].f1).filter(finite)),
    balancedAccuracy: mean(supported.map((name) => perClass[name].recall).filter(finite)),
    brier: settled.length ? brier / (settled.length * CLASSES.length) : null,
    logLoss: settled.length ? logLoss / settled.length : null,
    calibration: Object.freeze({ expectedCalibrationError: ece, bins: deepFreeze(bins) }),
    catastrophicOppositeDirectionErrors: Object.freeze({ count: catastrophic, ratio: settled.length ? catastrophic / settled.length : null }),
  });
}

function groupedQuality(observations, keyFn) {
  const groups = new Map();
  for (const observation of observations) {
    const key = String(keyFn(observation) ?? "UNKNOWN");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  return deepFreeze(Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, {
    RULE_ONLY: componentQuality(rows, "RULE_ONLY"),
    MODEL_ONLY: componentQuality(rows, "MODEL_ONLY"),
    DEPLOYED_FROZEN_BLEND: componentQuality(rows, "DEPLOYED_FROZEN_BLEND"),
  }])));
}

function failClosedHandoff(reason, status = "MISSING_EVIDENCE", extra = {}) {
  const body = {
    schemaVersion: SHADOW_EVIDENCE_HANDOFF_SCHEMA_VERSION,
    status,
    reason,
    driftVerdict: Object.freeze({ status: "NOT_EVALUABLE", reason, evidenceDigest: null }),
    strategyHealthHandoff: null,
    PROFITABILITY_PROVEN: false,
    FORWARD_EVIDENCE_SUFFICIENT: false,
    safety: SAFETY,
    ...extra,
  };
  return deepFreeze(body);
}

export function buildCanonicalShadowDriftHandoffV1({
  producerManifest,
  exactModelBytes,
  modelArtifact = null,
  trainReferenceBytes,
  validationReferenceBytes,
  observations,
  expectedStrategyInput = null,
  expectedModelIdentity = null,
  canonicalDriftPolicy = null,
  asOf = new Date().toISOString(),
} = {}) {
  const strategyResolution = resolveProducerStrategyIdentityV1(producerManifest, expectedStrategyInput);
  if (!strategyResolution.valid) return failClosedHandoff(strategyResolution.reason, strategyResolution.status, { strategyResolution });
  const modelResolution = resolveModelIdentityMappingV1({ producerManifest, exactModelBytes, modelArtifact, strategyResolution, expectedModelIdentity });
  if (!modelResolution.valid) return failClosedHandoff(modelResolution.reason, modelResolution.status, { strategyResolution, modelResolution });
  const referenceResolution = resolveTrainValidationReferenceV1({ producerManifest, trainReferenceBytes, validationReferenceBytes, asOf });
  if (!referenceResolution.valid) return failClosedHandoff(referenceResolution.reason, referenceResolution.status, { strategyResolution, modelResolution, referenceResolution });
  const featureOrder = modelResolution.exactModel.featureOrder;
  const observationResolution = validateFutureShadowObservationBatchV1({ observations, strategyResolution, modelResolution, referenceResolution, featureOrder });
  if (!observationResolution.valid) return failClosedHandoff(observationResolution.reason, observationResolution.status, { strategyResolution, modelResolution, referenceResolution, observationResolution });

  const settledObservations = observationResolution.observations.filter((observation) => normalizeDirection(observation.actualDirection));
  const featureMetrics = featureOrder.map((featureName) => featureDriftMetrics({
    featureName,
    referenceRecords: referenceResolution.referenceRecords,
    observations: settledObservations,
    model: modelResolution.exactModel,
    strategyIdentityDigest: strategyResolution.strategyIdentityDigest,
    modelIdentityDigest: modelResolution.modelIdentityDigest,
    referenceIdentity: referenceResolution.referenceIdentity,
  }));
  const metricsComplete = featureMetrics.every((metric) => metric.status === "MEASURED");
  const driftVerdict = buildDriftVerdictV1({
    featureMetrics,
    canonicalDriftPolicy,
    strategyIdentityDigest: strategyResolution.strategyIdentityDigest,
    modelIdentityDigest: modelResolution.modelIdentityDigest,
    referenceIdentity: referenceResolution.referenceIdentity,
    sampleN: settledObservations.length,
    futureSampleN: observationResolution.sampleN,
    settledN: settledObservations.length,
    referenceN: referenceResolution.referenceRecords.length,
    freshness: referenceResolution.freshness,
    asOf: iso(asOf),
  });
  const ruleOnlyQuality = componentQuality(observationResolution.observations, "RULE_ONLY");
  const modelOnlyQuality = componentQuality(observationResolution.observations, "MODEL_ONLY");
  const blendQuality = componentQuality(observationResolution.observations, "DEPLOYED_FROZEN_BLEND");
  const slices = Object.freeze({
    byRegime: groupedQuality(observationResolution.observations, (row) => row.regime?.key ?? row.regime?.trend ?? "UNKNOWN"),
    bySymbol: groupedQuality(observationResolution.observations, (row) => row.symbol),
    byTimeframe: groupedQuality(observationResolution.observations, (row) => row.timeframe),
  });
  const strongest = driftVerdict.strongestDriftingFeatures ?? [];
  const causeSeparation = deepFreeze({
    featureDrift: { status: driftVerdict.status, strongestFeatures: strongest },
    normalizationDrift: { status: metricsComplete ? "MEASURED" : "NOT_EVALUABLE", featureMetrics: featureMetrics.map((item) => ({ feature: item.feature, standardizedMeanShift: item.standardizedMeanShift ?? null, stdRatio: item.stdRatio ?? null, clippingRatio: item.clippingRatio ?? null })) },
    ruleCollapse: { status: ruleOnlyQuality.settledN ? "MEASURED" : "NOT_EVALUABLE", quality: ruleOnlyQuality },
    modelCollapse: { status: modelOnlyQuality.settledN ? "MEASURED" : "NOT_EVALUABLE", quality: modelOnlyQuality },
    blendCollapse: { status: blendQuality.settledN ? "MEASURED" : "NOT_EVALUABLE", quality: blendQuality },
    regimeSpecific: slices.byRegime,
    symbolSpecific: slices.bySymbol,
    timeframeSpecific: slices.byTimeframe,
    missingOrStaleData: { status: "CLEAR", rejectedObservationCount: 0 },
  });
  const strategyHealthBody = {
    schemaVersion: STRATEGY_HEALTH_HANDOFF_SCHEMA_VERSION,
    strategyIdentity: strategyResolution.strategyIdentity,
    strategyIdentityDigest: strategyResolution.strategyIdentityDigest,
    modelIdentity: modelResolution.modelIdentity,
    modelIdentityDigest: modelResolution.modelIdentityDigest,
    datasetReferenceIdentity: referenceResolution.referenceIdentity,
    directionalQuality: blendQuality,
    ruleOnlyQuality,
    modelOnlyQuality,
    blendQuality,
    driftVerdict,
    driftMetrics: featureMetrics,
    sampleN: observationResolution.sampleN,
    settledN: settledObservations.length,
    referenceN: referenceResolution.referenceRecords.length,
    freshness: referenceResolution.freshness,
    missingEvidence: driftVerdict.status === "NOT_EVALUABLE" ? [driftVerdict.reason] : [],
    executionAuthority: "NONE",
  };
  const strategyHealthHandoff = deepFreeze({ ...strategyHealthBody, evidenceDigest: sha256Canonical(strategyHealthBody) });
  const handoffComplete = metricsComplete && driftVerdict.status !== "NOT_EVALUABLE";
  const body = {
    schemaVersion: SHADOW_EVIDENCE_HANDOFF_SCHEMA_VERSION,
    status: handoffComplete ? "COMPLETE" : "MISSING_EVIDENCE",
    reason: handoffComplete ? null : driftVerdict.reason,
    strategyResolution,
    modelResolution: Object.freeze({
      status: modelResolution.status,
      modelIdentity: modelResolution.modelIdentity,
      modelIdentityDigest: modelResolution.modelIdentityDigest,
    }),
    referenceResolution: Object.freeze({
      status: referenceResolution.status,
      referenceIdentity: referenceResolution.referenceIdentity,
      freshness: referenceResolution.freshness,
      trainSampleN: referenceResolution.trainRecords.length,
      validationSampleN: referenceResolution.validationRecords.length,
    }),
    observationEvidence: Object.freeze({
      status: observationResolution.status,
      sampleN: observationResolution.sampleN,
      settledN: settledObservations.length,
      driftInputN: settledObservations.length,
      futureOnly: true,
      duplicateCredited: false,
      replayCredited: false,
      historicalBackfillCredited: false,
      frozenBlendWeights: FROZEN_BLEND_WEIGHTS,
    }),
    featureMetrics: deepFreeze(featureMetrics),
    driftVerdict,
    directionalQuality: Object.freeze({ RULE_ONLY: ruleOnlyQuality, MODEL_ONLY: modelOnlyQuality, DEPLOYED_FROZEN_BLEND: blendQuality }),
    causeSeparation,
    strategyHealthHandoff,
    PROFITABILITY_PROVEN: false,
    FORWARD_EVIDENCE_SUFFICIENT: false,
    safety: SAFETY,
  };
  return deepFreeze({ ...body, evidenceDigest: sha256Canonical(body) });
}

export function shadowEvidenceSafetyV1() {
  return SAFETY;
}
