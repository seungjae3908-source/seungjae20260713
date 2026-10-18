import { createHash } from 'node:crypto';

import { deriveArchivedResearchTimeframesV1 } from '../../market-prediction-lab/src/research-minute-archive-v1.js';

/**
 * Mechanical TRAIN-source check for Upbit KRW spot candles.
 *
 * It proves only that the candles inside a queue dataset are exactly the
 * candles that can be derived from the immutable private 1-minute archive, that
 * no minute bucket in the period is missing, that the period stays clear of the
 * sealed holdout, and that an owner-signed rights attestation with a pinned hash
 * and an owner-approved reviewed association exist. It is read-only: no network,
 * no provider call, no database, no archive write.
 *
 * It does NOT prove independent source authenticity, exchange completeness,
 * out-of-sample behaviour, full costs or profitability, and it never grants
 * execution authority. Any failure returns HOLD; it never throws.
 */
export const UPBIT_SPOT_SOURCE_VERIFIER_CONTRACT_V1 = 'research-upbit-spot-source-verifier/v1';
export const UPBIT_RIGHTS_ATTESTATION_SCHEMA_V1 = 'upbit-spot-research-rights-attestation-v1';

const DAY_MS = 86_400_000;
const MAX_SESSION_DAYS = 400;
const MAX_CANDLES = 200_000;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;
const SYMBOL = /^KRW-[A-Z0-9]{2,15}$/u;
const TIMEFRAMES = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '4h']);
const ATTESTATION_KEYS = ['schemaVersion', 'source', 'market', 'permittedUse', 'termsUrl', 'confirmedBy', 'confirmedAt'];
const DEFAULT_HOLDOUT_START_MS = Date.UTC(2026, 0, 1);
const OHLCV = ['open', 'high', 'low', 'close', 'volume'];

function hold(code) {
  return Object.freeze({ status: 'HOLD', code, executionAuthority: 'NONE' });
}

class HoldSignal extends Error {
  constructor(code) {
    super(code);
    this.holdCode = code;
  }
}

function stop(code) {
  throw new HoldSignal(code);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function nonEmptyString(value, max = 300) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Canonical digest of the owner rights attestation (key order fixed). */
export function digestUpbitRightsAttestationV1(attestation) {
  if (!sameKeys(attestation, ATTESTATION_KEYS)) stop('RIGHTS_ATTESTATION_SHAPE_INVALID');
  return sha256(JSON.stringify(ATTESTATION_KEYS.map((key) => [key, attestation[key]])));
}

function validateRights(attestation, expectedSha256, nowMs) {
  if (attestation == null) stop('RIGHTS_ATTESTATION_MISSING');
  if (!SHA64.test(String(expectedSha256 ?? ''))) stop('RIGHTS_ATTESTATION_PIN_MISSING');
  if (!sameKeys(attestation, ATTESTATION_KEYS)
    || attestation.schemaVersion !== UPBIT_RIGHTS_ATTESTATION_SCHEMA_V1
    || attestation.source !== 'UPBIT_PUBLIC_QUOTATION'
    || attestation.market !== 'CRYPTO_SPOT'
    || attestation.permittedUse !== 'INTERNAL_RESEARCH_BACKTEST'
    || !nonEmptyString(attestation.termsUrl)
    || !attestation.termsUrl.startsWith('https://')
    || !nonEmptyString(attestation.confirmedBy, 120)) {
    stop('RIGHTS_ATTESTATION_SHAPE_INVALID');
  }
  const confirmedAtMs = Date.parse(attestation.confirmedAt);
  if (!Number.isFinite(confirmedAtMs) || confirmedAtMs > nowMs) stop('RIGHTS_ATTESTATION_TIME_INVALID');
  const digest = digestUpbitRightsAttestationV1(attestation);
  if (digest !== expectedSha256) stop('RIGHTS_ATTESTATION_HASH_MISMATCH');
  return digest;
}

function readRequest(request) {
  if (!isPlainObject(request)) stop('REQUEST_INVALID');
  const { researchSha, aiEvidenceDigest, hypothesisId, formulaCandidate, dataset } = request;
  if (!SHA40.test(String(researchSha ?? ''))) stop('REQUEST_RESEARCH_SHA_INVALID');
  if (!nonEmptyString(aiEvidenceDigest) || !nonEmptyString(hypothesisId)) stop('REQUEST_AI_BINDING_INVALID');
  for (const key of ['datasetDigest', 'reviewIdentityDigest', 'reviewedAssociationDigest']) {
    if (!SHA64.test(String(request[key] ?? ''))) stop('REQUEST_DIGEST_INVALID');
  }
  if (!isPlainObject(formulaCandidate) || !nonEmptyString(formulaCandidate.candidateId)
    || !nonEmptyString(formulaCandidate.formulaHash) || formulaCandidate.market !== 'CRYPTO_SPOT') {
    stop('REQUEST_FORMULA_INVALID');
  }
  if (!isPlainObject(dataset) || dataset.datasetRole !== 'TRAIN' || dataset.market !== 'CRYPTO_SPOT'
    || !nonEmptyString(dataset.datasetIdentity)) {
    stop('REQUEST_DATASET_NOT_SPOT_TRAIN');
  }
  return request;
}

function readDataset(dataset, holdoutStartMs) {
  const symbol = dataset.symbol;
  if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) stop('DATASET_SYMBOL_MISSING_OR_INVALID');
  const timeframe = String(dataset.timeframe ?? '').toLowerCase();
  if (!TIMEFRAMES.has(timeframe)) stop('DATASET_TIMEFRAME_UNSUPPORTED');
  const period = dataset.period;
  if (!isPlainObject(period) || !Number.isSafeInteger(period.startTime) || !Number.isSafeInteger(period.endTime)
    || period.startTime <= 0 || period.startTime >= period.endTime || period.includeFinalHoldout !== false) {
    stop('DATASET_PERIOD_INVALID');
  }
  if (period.endTime > holdoutStartMs) stop('DATASET_PERIOD_TOUCHES_SEALED_HOLDOUT');
  const candles = dataset.backtestInput?.candles;
  if (!Array.isArray(candles) || candles.length === 0 || candles.length > MAX_CANDLES
    || dataset.candleCount !== candles.length) {
    stop('DATASET_CANDLES_INVALID');
  }
  return { symbol, timeframe, period, candles };
}

function sessionStarts(period) {
  const first = Math.floor(period.startTime / DAY_MS) * DAY_MS;
  const starts = [];
  for (let start = first; start < period.endTime; start += DAY_MS) {
    starts.push(start);
    if (starts.length > MAX_SESSION_DAYS) stop('DATASET_PERIOD_TOO_LONG');
  }
  return starts;
}

/**
 * Verify one request from ai-formula-train-producer-v1. `options.deriveSession`
 * must read only the immutable archive (see createArchiveDeriveSessionV1).
 */
export async function verifyUpbitSpotTrainSourceV1(request, options = {}) {
  try {
    return await verify(request, options);
  } catch (error) {
    return hold(error instanceof HoldSignal ? error.holdCode : 'VERIFIER_INTERNAL_ERROR');
  }
}

async function verify(request, options) {
  const {
    deriveSession,
    rightsAttestation = null,
    expectedRightsSha256 = null,
    reviewedAssociationDigests = [],
    holdoutStartMs = DEFAULT_HOLDOUT_START_MS,
  } = options;
  const nowMs = Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  if (typeof deriveSession !== 'function') stop('ARCHIVE_READER_MISSING');
  if (!Number.isSafeInteger(holdoutStartMs) || holdoutStartMs <= 0) stop('HOLDOUT_BOUNDARY_INVALID');

  readRequest(request);
  const rightsSha256 = validateRights(rightsAttestation, expectedRightsSha256, nowMs);
  const approved = new Set(Array.isArray(reviewedAssociationDigests) ? reviewedAssociationDigests : []);
  if (!approved.has(request.reviewedAssociationDigest)) stop('FORMULA_REVIEW_NOT_APPROVED_BY_OWNER');

  const { symbol, timeframe, period, candles } = readDataset(request.dataset, holdoutStartMs);

  const derivedByStart = new Map();
  let widthMs = null;
  let sessionCount = 0;
  for (const sessionStartMs of sessionStarts(period)) {
    const derived = await deriveSession({ symbol, sessionStartMs, asOfMs: nowMs, timeframe });
    if (!isPlainObject(derived) || derived.status === 'BLOCKED_DATA' || !isPlainObject(derived.intervalData)) {
      stop('ARCHIVED_SESSION_MISSING_OR_AMBIGUOUS');
    }
    const frame = Object.values(derived.intervalData)[0];
    if (!isPlainObject(frame) || !Array.isArray(frame.bars) || !Number.isSafeInteger(frame.intervalMinutes)) {
      stop('ARCHIVED_SESSION_FRAME_INVALID');
    }
    const frameWidth = frame.intervalMinutes * 60_000;
    if (widthMs !== null && frameWidth !== widthMs) stop('ARCHIVED_SESSION_FRAME_INCONSISTENT');
    widthMs = frameWidth;
    sessionCount += 1;
    for (const bar of frame.bars) derivedByStart.set(bar.startMs, bar);
  }
  if (widthMs === null) stop('ARCHIVED_SESSION_MISSING_OR_AMBIGUOUS');

  const expectedStarts = [];
  for (let start = Math.ceil(period.startTime / widthMs) * widthMs; start + widthMs <= period.endTime; start += widthMs) {
    expectedStarts.push(start);
  }
  if (expectedStarts.length === 0) stop('DATASET_PERIOD_HAS_NO_COMPLETE_BAR');
  if (candles.length !== expectedStarts.length) stop('DATASET_CANDLES_DO_NOT_MATCH_ARCHIVE');

  let observedAtMs = 0;
  for (let index = 0; index < expectedStarts.length; index += 1) {
    const bar = derivedByStart.get(expectedStarts[index]);
    if (!bar) stop('PERIOD_BAR_MISSING_IN_ARCHIVE');
    const candle = candles[index];
    if (!isPlainObject(candle) || candle.timestamp !== bar.startMs) stop('DATASET_CANDLES_DO_NOT_MATCH_ARCHIVE');
    for (const key of OHLCV) {
      if (candle[key] !== bar[key]) stop('DATASET_CANDLES_DO_NOT_MATCH_ARCHIVE');
    }
    if (!Number.isSafeInteger(bar.availableAtMs) || bar.availableAtMs > nowMs) stop('ARCHIVE_BAR_AVAILABILITY_INVALID');
    observedAtMs = Math.max(observedAtMs, bar.availableAtMs);
  }
  if (observedAtMs < period.endTime) stop('ARCHIVE_DATA_NOT_AVAILABLE_BY_PERIOD_END');

  return Object.freeze({
    status: 'VERIFIED_TRAIN_SOURCE',
    researchSha: request.researchSha,
    aiEvidenceDigest: request.aiEvidenceDigest,
    hypothesisId: request.hypothesisId,
    datasetIdentity: request.dataset.datasetIdentity,
    datasetDigest: request.datasetDigest,
    datasetRole: 'TRAIN',
    reviewIdentityDigest: request.reviewIdentityDigest,
    reviewedAssociationDigest: request.reviewedAssociationDigest,
    formulaCandidateId: request.formulaCandidate.candidateId,
    formulaHash: request.formulaCandidate.formulaHash,
    formulaReviewedForAiHypothesis: true,
    sourceRightsVerified: true,
    sourceProvenanceVerified: true,
    observedAtMs,
    verifierContract: UPBIT_SPOT_SOURCE_VERIFIER_CONTRACT_V1,
    rightsAttestationSha256: rightsSha256,
    verifiedSessionCount: sessionCount,
    verifiedBarCount: expectedStarts.length,
    independentSourceAuthenticityVerified: false,
    executionAuthority: 'NONE',
  });
}

/**
 * Upbit candle datasets name the pair `KRW-BTC`, while the 1-minute collector
 * (`four-market-minute-intake`) stores the bare ticker `BTC`. Pass this as
 * `archiveSymbol` when the archive was filled by that collector.
 */
export const upbitBareTickerArchiveSymbolV1 = (symbol) => String(symbol).replace(/^KRW-/u, '');

/**
 * Read-only adapter over the private immutable minute archive. `archiveSymbol`
 * maps the dataset symbol to the symbol the archive actually stores (default:
 * unchanged).
 */
export function createArchiveDeriveSessionV1({ root, archiveSymbol = (symbol) => symbol }) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('ARCHIVE_ROOT_REQUIRED');
  if (typeof archiveSymbol !== 'function') throw new TypeError('ARCHIVE_SYMBOL_MAPPER_INVALID');
  return ({ symbol, sessionStartMs, asOfMs, timeframe }) => deriveArchivedResearchTimeframesV1({
    root,
    market: 'CRYPTO_SPOT',
    symbol: archiveSymbol(symbol),
    sessionStartMs,
    asOfMs,
    timeframes: [timeframe],
  });
}
