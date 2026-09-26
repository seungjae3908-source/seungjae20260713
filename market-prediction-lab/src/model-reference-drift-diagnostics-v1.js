import { sha256 } from "./data-quality.js";
import { sha256Canonical } from "./research-cache-provenance.js";

export const MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SCHEMA_VERSION = "PredictionLabModelReferenceDriftDiagnosticV1";
export const MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY = Object.freeze({
  diagnosticsOnly: true,
  tuningAuthority: false,
  thresholdModified: false,
  modelModified: false,
  labelModified: false,
  classWeightModified: false,
  blendWeightModified: false,
  finalHoldoutOptimizationAllowed: false,
  profitabilityCredit: 0,
  promotionCredit: 0,
  LIVE_TRADING: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  executionAuthority: "NONE",
  orderSubmitted: false,
});

const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const DEFAULT_BINS = 10;
const SMOOTHING_EPSILON = 1e-6;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactBytes(value, label) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) throw new TypeError(`${label} exact bytes are required`);
  return Buffer.from(value);
}

function exactDigest(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase().replace(/^sha256:/u, "") : "";
  if (!HASH_64.test(normalized)) throw new TypeError(`${label} must be an exact SHA256 digest`);
  return normalized;
}

function exactSha(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!SHA_40.test(normalized)) throw new TypeError(`${label} must be an immutable 40-character SHA`);
  return normalized;
}

function parseJsonl(bytes, label) {
  const text = exactBytes(bytes, label).toString("utf8");
  if (!text.endsWith("\n")) throw new Error(`${label} JSONL must end with one newline`);
  const lines = text.slice(0, -1).split("\n");
  if (!lines.length || lines.some((line) => line.length === 0)) throw new Error(`${label} JSONL is empty or malformed`);
  const records = lines.map((line) => JSON.parse(line));
  if (records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
    throw new Error(`${label} JSONL records must be objects`);
  }
  return records;
}

function recordIdentityDigest(records, label) {
  const ids = records.map((record) => typeof record?.id === "string" ? record.id : "");
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error(`${label} record identities must be present and unique`);
  }
  return sha256(Buffer.from(`${[...ids].sort().join("\n")}\n`, "utf8"));
}

function requireGenuineManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError("reference manifest is required");
  if (manifest.status !== "VALID" || manifest.referenceProvenanceStatus !== "VALID") {
    throw new Error("durable reference manifest must be canonically VALID before drift diagnostics");
  }
  const source = manifest.sourceAttestation;
  if (source?.sourceKind !== "GENUINE_MARKET_DATA"
      || source.futureOnly !== true
      || source.reconstructed !== false
      || source.historicalReconstruction !== false
      || source.synthetic !== false
      || source.replayDerived !== false
      || source.shadowDerived !== false
      || source.testFixture !== false
      || source.oosIncluded !== false
      || source.finalHoldoutIncluded !== false
      || source.finalHoldoutAccessed !== false) {
    throw new Error("only genuine future TRAIN/VALIDATION reference evidence may be diagnosed");
  }
  if (!Array.isArray(manifest.featureOrder) || manifest.featureOrder.length === 0
      || manifest.featureOrder.some((feature) => typeof feature !== "string" || feature.length === 0)) {
    throw new Error("reference featureOrder is required");
  }
  if (sha256Canonical(manifest.featureOrder) !== exactDigest(manifest.featureOrderDigest, "featureOrderDigest")) {
    throw new Error("reference featureOrder digest mismatch");
  }
  if (manifest.preprocessingVersion !== "prediction-lab-training-preprocessing-v1") {
    throw new Error("unsupported reference preprocessing identity");
  }
}

function requireDurableReceiptBinding(durableReceiptValidation, manifest) {
  if (!durableReceiptValidation || durableReceiptValidation.valid !== true
      || durableReceiptValidation.status !== "VALID"
      || durableReceiptValidation.longTermReferenceProven !== true
      || durableReceiptValidation.publicationReceiptProven !== true
      || durableReceiptValidation.durableReferenceStore !== "GITHUB_IMMUTABLE_RELEASE") {
    throw new Error("DURABLE_REFERENCE_PROVEN=false: immutable publication readback is required");
  }
  const receipt = durableReceiptValidation.receipt;
  if (!receipt || receipt.provider !== "GITHUB_IMMUTABLE_RELEASE") throw new Error("durable receipt provider mismatch");
  const targetCommitSha = exactSha(receipt.targetCommitSha, "durable targetCommitSha");
  if (targetCommitSha !== exactSha(manifest.producerSha, "manifest producerSha")
      || targetCommitSha !== exactSha(manifest.researchCodeSha, "manifest researchCodeSha")
      || targetCommitSha !== exactSha(manifest.trainingCodeSha, "manifest trainingCodeSha")) {
    throw new Error("durable receipt target SHA does not bind the reference producer");
  }
  const reference = Array.isArray(receipt.references)
    ? receipt.references.find((item) => item?.group === manifest.group)
    : null;
  if (!reference) throw new Error(`durable receipt has no reference binding for ${manifest.group ?? "MISSING"}`);
  const bindings = [
    ["datasetDigest", manifest.datasetDigest],
    ["strategyIdentityDigest", manifest.strategyIdentityDigest],
    ["modelSha", manifest.modelSha],
    ["featureOrderDigest", manifest.featureOrderDigest],
    ["trainDatasetDigest", manifest.trainDatasetDigest],
    ["validationDatasetDigest", manifest.validationDatasetDigest],
    ["trainSplitDigest", manifest.trainSplitDigest],
    ["validationSplitDigest", manifest.validationSplitDigest],
    ["rawArtifactDigest", manifest.rawArtifactDigest],
    ["artifactDigest", manifest.artifactDigest],
  ];
  for (const [field, expected] of bindings) {
    if (reference[field] !== expected) throw new Error(`durable receipt ${field} mismatch`);
  }
  return { receipt, reference, targetCommitSha };
}

function canonicalFeatureValues(records, feature) {
  let missingOrNonFiniteN = 0;
  const values = records.map((record) => {
    const value = record?.features?.[feature];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    missingOrNonFiniteN += 1;
    return 0;
  });
  return { values, missingOrNonFiniteN };
}

function sorted(values) {
  return [...values].sort((left, right) => left - right);
}

function quantileFromSorted(values, probability) {
  if (!values.length) throw new Error("quantile requires values");
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  const weight = position - lower;
  return values[lower] * (1 - weight) + values[upper] * weight;
}

function trainQuantileEdges(trainValues, requestedBins) {
  const values = sorted(trainValues);
  const edges = [];
  for (let index = 1; index < requestedBins; index += 1) {
    const edge = quantileFromSorted(values, index / requestedBins);
    if (!edges.length || edge > edges.at(-1)) edges.push(edge);
  }
  return edges;
}

function bucketCounts(values, edges) {
  const counts = Array.from({ length: edges.length + 1 }, () => 0);
  for (const value of values) {
    let bucket = 0;
    while (bucket < edges.length && value > edges[bucket]) bucket += 1;
    counts[bucket] += 1;
  }
  return counts;
}

function smoothedProportions(counts) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const denominator = total + SMOOTHING_EPSILON * counts.length;
  return counts.map((count) => (count + SMOOTHING_EPSILON) / denominator);
}

function populationStabilityIndex(trainValues, validationValues, edges) {
  const train = smoothedProportions(bucketCounts(trainValues, edges));
  const validation = smoothedProportions(bucketCounts(validationValues, edges));
  return train.reduce((sum, expected, index) => {
    const actual = validation[index];
    return sum + (actual - expected) * Math.log(actual / expected);
  }, 0);
}

function jensenShannonDivergence(trainValues, validationValues, edges) {
  const train = smoothedProportions(bucketCounts(trainValues, edges));
  const validation = smoothedProportions(bucketCounts(validationValues, edges));
  const midpoint = train.map((value, index) => (value + validation[index]) / 2);
  const kl = (distribution, target) => distribution.reduce((sum, value, index) => sum + value * Math.log2(value / target[index]), 0);
  return (kl(train, midpoint) + kl(validation, midpoint)) / 2;
}

function kolmogorovSmirnovStatistic(trainValues, validationValues) {
  const train = sorted(trainValues);
  const validation = sorted(validationValues);
  let trainIndex = 0;
  let validationIndex = 0;
  let statistic = 0;
  while (trainIndex < train.length || validationIndex < validation.length) {
    const trainValue = trainIndex < train.length ? train[trainIndex] : Number.POSITIVE_INFINITY;
    const validationValue = validationIndex < validation.length ? validation[validationIndex] : Number.POSITIVE_INFINITY;
    const point = Math.min(trainValue, validationValue);
    while (trainIndex < train.length && train[trainIndex] <= point) trainIndex += 1;
    while (validationIndex < validation.length && validation[validationIndex] <= point) validationIndex += 1;
    statistic = Math.max(statistic, Math.abs(trainIndex / train.length - validationIndex / validation.length));
  }
  return statistic;
}

function summarize(values) {
  const count = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  const ordered = sorted(values);
  return Object.freeze({
    n: count,
    min: ordered[0],
    p25: quantileFromSorted(ordered, 0.25),
    p50: quantileFromSorted(ordered, 0.5),
    p75: quantileFromSorted(ordered, 0.75),
    max: ordered.at(-1),
    mean,
    std: Math.sqrt(variance),
  });
}

function maxMetric(perFeature, field) {
  let best = null;
  for (const [feature, value] of Object.entries(perFeature)) {
    if (best === null || value[field] > best.value) best = { feature, value: value[field] };
  }
  return Object.freeze(best);
}

export function buildModelReferenceDriftDiagnosticV1({
  manifest,
  trainBytes,
  validationBytes,
  durableReceiptValidation,
  requestedBins = DEFAULT_BINS,
  generatedAt = Date.now(),
} = {}) {
  requireGenuineManifest(manifest);
  if (!Number.isInteger(requestedBins) || requestedBins < 4 || requestedBins > 20) {
    throw new TypeError("requestedBins must be an integer between 4 and 20");
  }
  const exactTrainBytes = exactBytes(trainBytes, "TRAIN");
  const exactValidationBytes = exactBytes(validationBytes, "VALIDATION");
  if (sha256(exactTrainBytes) !== exactDigest(manifest.trainSplitDigest, "trainSplitDigest")
      || sha256(exactValidationBytes) !== exactDigest(manifest.validationSplitDigest, "validationSplitDigest")) {
    throw new Error("durable TRAIN/VALIDATION exact-byte digest mismatch");
  }
  const trainRecords = parseJsonl(exactTrainBytes, "TRAIN");
  const validationRecords = parseJsonl(exactValidationBytes, "VALIDATION");
  if (trainRecords.length !== manifest.trainSampleN || validationRecords.length !== manifest.validationSampleN) {
    throw new Error("durable TRAIN/VALIDATION sample count mismatch");
  }
  if (recordIdentityDigest(trainRecords, "TRAIN") !== manifest.trainRecordIdentityDigest
      || recordIdentityDigest(validationRecords, "VALIDATION") !== manifest.validationRecordIdentityDigest) {
    throw new Error("durable TRAIN/VALIDATION record identity mismatch");
  }
  const trainIds = new Set(trainRecords.map((record) => record.id));
  if (validationRecords.some((record) => trainIds.has(record.id))) throw new Error("TRAIN/VALIDATION record identity overlap detected");

  const durable = requireDurableReceiptBinding(durableReceiptValidation, manifest);
  const perFeature = {};
  for (const feature of manifest.featureOrder) {
    const train = canonicalFeatureValues(trainRecords, feature);
    const validation = canonicalFeatureValues(validationRecords, feature);
    const edges = trainQuantileEdges(train.values, requestedBins);
    perFeature[feature] = Object.freeze({
      metricInputSpace: "pre-normalization feature values after canonical non-finite-to-zero preprocessing",
      requestedBins,
      effectiveBins: edges.length + 1,
      trainQuantileEdges: Object.freeze(edges),
      train: summarize(train.values),
      validation: summarize(validation.values),
      trainMissingOrNonFiniteN: train.missingOrNonFiniteN,
      validationMissingOrNonFiniteN: validation.missingOrNonFiniteN,
      psi: populationStabilityIndex(train.values, validation.values, edges),
      ks: kolmogorovSmirnovStatistic(train.values, validation.values),
      jsd: jensenShannonDivergence(train.values, validation.values, edges),
    });
  }

  return deepFreeze({
    schemaVersion: MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SCHEMA_VERSION,
    status: "VALID",
    decisionStatus: "DIAGNOSTIC_ONLY",
    generatedAt: new Date(generatedAt).toISOString(),
    durableReferenceProven: true,
    durableReferenceStore: durableReceiptValidation.durableReferenceStore,
    durableBinding: {
      releaseId: durable.receipt.releaseId,
      releaseTag: durable.receipt.releaseTag,
      targetCommitSha: durable.targetCommitSha,
      receiptDigest: durable.receipt.receiptDigest,
      group: manifest.group,
      rawArtifactDigest: manifest.rawArtifactDigest,
      trainSplitDigest: manifest.trainSplitDigest,
      validationSplitDigest: manifest.validationSplitDigest,
    },
    reference: {
      group: manifest.group,
      datasetId: manifest.datasetId,
      datasetDigest: manifest.datasetDigest,
      strategyIdentityDigest: manifest.strategyIdentityDigest,
      modelSha: manifest.modelSha,
      producerSha: manifest.producerSha,
      featureOrder: Object.freeze([...manifest.featureOrder]),
      featureOrderDigest: manifest.featureOrderDigest,
      trainDatasetIdentity: manifest.trainDatasetIdentity,
      validationDatasetIdentity: manifest.validationDatasetIdentity,
      trainSampleN: manifest.trainSampleN,
      validationSampleN: manifest.validationSampleN,
      preprocessingVersion: manifest.preprocessingVersion,
    },
    metrics: {
      definitions: {
        psi: "train-quantile-binned population stability index; natural log; diagnostic only",
        ks: "two-sample empirical Kolmogorov-Smirnov D statistic; diagnostic only",
        jsd: "train-quantile-binned Jensen-Shannon divergence in bits; diagnostic only",
        smoothingEpsilon: SMOOTHING_EPSILON,
      },
      perFeature: deepFreeze(perFeature),
      maxima: {
        psi: maxMetric(perFeature, "psi"),
        ks: maxMetric(perFeature, "ks"),
        jsd: maxMetric(perFeature, "jsd"),
      },
    },
    authority: {
      tuningAllowed: false,
      thresholdSelectionAllowed: false,
      modelSelectionAllowed: false,
      classWeightSelectionAllowed: false,
      blendWeightSelectionAllowed: false,
      promotionDecisionAllowed: false,
      profitabilityClaimAllowed: false,
      statement: "PSI/KS/JSD are authenticated drift diagnostics only and are not tuning or promotion authority.",
    },
    safety: MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY,
  });
}
