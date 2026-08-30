import { resolveModelIdentityMappingV1, resolveProducerStrategyIdentityV1 } from '../../../market-prediction-lab/src/shadow-evidence-handoff-v1.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;

/** Consume the existing Shadow owner identity mapping. This does not run/train a
 * model or make the formula-only #690 execution equivalent to model inference. */
export function researchBundleModelIdentity(source: Row, now: number, allowTestEvidence: boolean) {
  const reference = row(source.modelReference), manifest = row(reference.producerManifest);
  const modelBlockers: string[] = [], featureBlockers: string[] = [];
  let modelIdentityDigest: string | null = null, featureOrderDigest: string | null = null, preprocessingVersion: string | null = null;
  if (!source.modelReference) return { modelIdentityDigest, featureOrderDigest, preprocessingVersion,
    modelBlockers: ['MODEL_REFERENCE_MISSING'], featureBlockers: ['FEATURE_IDENTITY_MISSING'] };
  try {
    if (!text(reference.exactModelJson) || Buffer.byteLength(reference.exactModelJson, 'utf8') > 2_000_000)
      throw new Error('MODEL_EXACT_BYTES_MISSING_OR_OVERSIZED');
    const strategy = resolveProducerStrategyIdentityV1(manifest, source.strategy);
    if (strategy.valid !== true) modelBlockers.push(String(strategy.reason ?? 'MODEL_STRATEGY_IDENTITY_MISMATCH'));
    const mapping = resolveModelIdentityMappingV1({ producerManifest: manifest, exactModelBytes: reference.exactModelJson, strategyResolution: strategy });
    if (mapping.valid !== true) modelBlockers.push(String(mapping.reason ?? 'MODEL_IDENTITY_INVALID'));
    const model = row(mapping.exactModel), identity = row(mapping.modelIdentity), order = model.featureOrder;
    if (!Array.isArray(order) || !order.length || !order.every(text) || new Set(order).size !== order.length)
      featureBlockers.push('MODEL_FEATURE_ORDER_INVALID');
    if (!text(manifest.preprocessingVersion)) featureBlockers.push('PREPROCESSING_VERSION_MISSING');
    if (model.normalization != null) {
      const normalization = row(model.normalization);
      for (const key of ['mean', 'scale']) {
        const values = normalization[key];
        if (!Array.isArray(values) || !Array.isArray(order) || values.length !== order.length ||
          values.some(value => typeof value !== 'number' || !Number.isFinite(value) || key === 'scale' && value <= 0))
          featureBlockers.push('MODEL_NORMALIZATION_INVALID');
      }
    }
    const receipt = row(manifest.artifactReceipt), measuredAt = time(manifest.measuredAt), expiresAt = time(receipt.expiresAt);
    if (!Number.isFinite(measuredAt) || measuredAt > now || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt <= measuredAt)
      modelBlockers.push('MODEL_REFERENCE_STALE_OR_TIME_INVALID');
    const attestation = row(manifest.sourceAttestation);
    const testOnly = allowTestEvidence && source.evidenceClass === 'TEST_ONLY' && attestation.sourceKind === 'TEST_ONLY';
    if (manifest.status !== 'VALID' || manifest.referenceProvenanceStatus !== 'VALID' ||
      (!testOnly && attestation.sourceKind !== 'GENUINE_MARKET_DATA') || attestation.reconstructed !== false ||
      attestation.synthetic !== testOnly || attestation.shadowDerived !== false || attestation.finalHoldoutIncluded !== false)
      modelBlockers.push('MODEL_REFERENCE_PROVENANCE_INVALID');
    if (mapping.valid === true && !modelBlockers.length && !featureBlockers.length &&
      typeof mapping.modelIdentityDigest === 'string' && typeof identity.featureOrderDigest === 'string' && text(identity.preprocessingVersion)) {
      modelIdentityDigest = mapping.modelIdentityDigest;
      featureOrderDigest = identity.featureOrderDigest;
      preprocessingVersion = identity.preprocessingVersion;
    }
  } catch {
    modelBlockers.push('MODEL_REFERENCE_INVALID');
  }
  if (!featureOrderDigest && !featureBlockers.length) featureBlockers.push('FEATURE_IDENTITY_UNVERIFIED');
  return { modelIdentityDigest, featureOrderDigest, preprocessingVersion, modelBlockers, featureBlockers };
}
