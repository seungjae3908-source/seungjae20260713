import { createHash } from 'node:crypto';

import { deriveArchivedResearchTimeframesV1 } from '../../market-prediction-lab/src/research-minute-archive-v1.js';

/**
 * Mechanical TRAIN-source check for the three markets that follow the Upbit
 * spot verifier: CRYPTO_FUTURES (Bitget USDT), KR_STOCK (KRX) and US_STOCK
 * (US SIP). Read-only: no network, provider call, database or archive write.
 *
 * It proves only that the candles inside a queue dataset are exactly the
 * candles derived from the immutable private 1-minute archive, that the period
 * stays clear of the sealed holdout, and that an owner-signed rights
 * attestation with a pinned hash and an owner-approved reviewed association
 * exist.
 *
 * Crypto futures use UTC 24h sessions, so every missing bar is detectable on a
 * fixed grid. Stock sessions follow exchange calendars; the archive cannot say
 * which sessions SHOULD exist, so the owner must pass `sessionCalendar` and a
 * `allowedSources` list. Without them the stock verifiers HOLD.
 *
 * It does NOT prove independent source authenticity, exchange completeness,
 * funding/borrow/corporate-action correctness, out-of-sample behaviour, costs
 * or profitability, and it never grants execution authority. Any failure
 * returns HOLD; it never throws.
 */
export const MARKET_SOURCE_VERIFIER_CONTRACT_V1 = 'research-market-source-verifier/v1';

const DAY_MS = 86_400_000;
const MAX_SESSIONS = 400;
const MAX_CANDLES = 200_000;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;
const INTRADAY = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '4h']);
const ATTESTATION_KEYS = ['schemaVersion', 'source', 'market', 'permittedUse', 'termsUrl', 'confirmedBy', 'confirmedAt'];
const DEFAULT_HOLDOUT_START_MS = Date.UTC(2026, 0, 1);
const OHLCV = ['open', 'high', 'low', 'close', 'volume'];

export const MARKET_VERIFIER_CONFIG_V1 = Object.freeze({
  CRYPTO_FUTURES: Object.freeze({
    attestationSchema: 'bitget-futures-research-rights-attestation-v1',
    defaultSources: Object.freeze(['BITGET_PUBLIC_MARKET_DATA']),
    symbol: /^[A-Z0-9]{2,20}USDT$/u,
    calendar: 'UTC_24H',
  }),
  KR_STOCK: Object.freeze({
    attestationSchema: 'kr-stock-research-rights-attestation-v1',
    defaultSources: Object.freeze([]),
    symbol: /^[0-9]{6}$/u,
    calendar: 'EXCHANGE',
  }),
  US_STOCK: Object.freeze({
    attestationSchema: 'us-stock-research-rights-attestation-v1',
    defaultSources: Object.freeze([]),
    symbol: /^[A-Z]{1,5}([.-][A-Z])?$/u,
    calendar: 'EXCHANGE',
  }),
});

class HoldSignal extends Error {
  constructor(code) {
    super(code);
    this.holdCode = code;
  }
}

const stop = (code) => { throw new HoldSignal(code); };
const hold = (code) => Object.freeze({ status: 'HOLD', code, executionAuthority: 'NONE' });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v, max = 300) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function sameKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function configFor(market) {
  if (!Object.prototype.hasOwnProperty.call(MARKET_VERIFIER_CONFIG_V1, market)) stop('MARKET_UNSUPPORTED');
  return MARKET_VERIFIER_CONFIG_V1[market];
}

/** Canonical digest of an owner rights attestation (key order fixed, same scheme as the Upbit one). */
export function digestRightsAttestationV1(attestation) {
  if (!sameKeys(attestation, ATTESTATION_KEYS)) stop('RIGHTS_ATTESTATION_SHAPE_INVALID');
  return sha256(JSON.stringify(ATTESTATION_KEYS.map((key) => [key, attestation[key]])));
}

function validateRights(market, config, attestation, expectedSha256, allowedSources, nowMs) {
  if (attestation == null) stop('RIGHTS_ATTESTATION_MISSING');
  if (!SHA64.test(String(expectedSha256 ?? ''))) stop('RIGHTS_ATTESTATION_PIN_MISSING');
  const sources = Array.isArray(allowedSources) && allowedSources.length > 0 ? allowedSources : config.defaultSources;
  if (sources.length === 0) stop('RIGHTS_SOURCE_ALLOWLIST_MISSING');
  if (!sameKeys(attestation, ATTESTATION_KEYS)
    || attestation.schemaVersion !== config.attestationSchema
    || !nonEmptyString(attestation.source, 120)
    || !sources.includes(attestation.source)
    || attestation.market !== market
    || attestation.permittedUse !== 'INTERNAL_RESEARCH_BACKTEST'
    || !nonEmptyString(attestation.termsUrl)
    || !attestation.termsUrl.startsWith('https://')
    || !nonEmptyString(attestation.confirmedBy, 120)) {
    stop('RIGHTS_ATTESTATION_SHAPE_INVALID');
  }
  const confirmedAtMs = Date.parse(attestation.confirmedAt);
  if (!Number.isFinite(confirmedAtMs) || confirmedAtMs > nowMs) stop('RIGHTS_ATTESTATION_TIME_INVALID');
  const digest = digestRightsAttestationV1(attestation);
  if (digest !== expectedSha256) stop('RIGHTS_ATTESTATION_HASH_MISMATCH');
  return digest;
}

function readRequest(market, request) {
  if (!isPlainObject(request)) stop('REQUEST_INVALID');
  const { researchSha, aiEvidenceDigest, hypothesisId, formulaCandidate, dataset } = request;
  if (!SHA40.test(String(researchSha ?? ''))) stop('REQUEST_RESEARCH_SHA_INVALID');
  if (!nonEmptyString(aiEvidenceDigest) || !nonEmptyString(hypothesisId)) stop('REQUEST_AI_BINDING_INVALID');
  for (const key of ['datasetDigest', 'reviewIdentityDigest', 'reviewedAssociationDigest']) {
    if (!SHA64.test(String(request[key] ?? ''))) stop('REQUEST_DIGEST_INVALID');
  }
  if (!isPlainObject(formulaCandidate) || !nonEmptyString(formulaCandidate.candidateId)
    || !nonEmptyString(formulaCandidate.formulaHash) || formulaCandidate.market !== market) {
    stop('REQUEST_FORMULA_INVALID');
  }
  if (!isPlainObject(dataset) || dataset.datasetRole !== 'TRAIN' || dataset.market !== market
    || !nonEmptyString(dataset.datasetIdentity)) {
    stop('REQUEST_DATASET_NOT_MARKET_TRAIN');
  }
}

function readDataset(config, dataset, holdoutStartMs) {
  const { symbol } = dataset;
  if (typeof symbol !== 'string' || !config.symbol.test(symbol)) stop('DATASET_SYMBOL_MISSING_OR_INVALID');
  const timeframe = String(dataset.timeframe ?? '').toLowerCase();
  if (!INTRADAY.has(timeframe)) stop('DATASET_TIMEFRAME_UNSUPPORTED');
  const { period } = dataset;
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

async function sessionStartsFor(market, config, symbol, period, options) {
  if (config.calendar === 'UTC_24H') {
    const starts = [];
    for (let start = Math.floor(period.startTime / DAY_MS) * DAY_MS; start < period.endTime; start += DAY_MS) {
      starts.push(start);
      if (starts.length > MAX_SESSIONS) stop('DATASET_PERIOD_TOO_LONG');
    }
    return starts;
  }
  if (typeof options.sessionCalendar !== 'function') stop('SESSION_CALENDAR_MISSING');
  const listed = await options.sessionCalendar({
    market, symbol, periodStartMs: period.startTime, periodEndMs: period.endTime,
  });
  if (!Array.isArray(listed) || listed.length === 0 || listed.length > MAX_SESSIONS
    || !listed.every((v, i) => Number.isSafeInteger(v) && v > 0 && v % 60_000 === 0 && (i === 0 || v > listed[i - 1]))) {
    stop('SESSION_CALENDAR_INVALID');
  }
  return listed;
}

/**
 * Verify one request from ai-formula-train-producer-v1 for `market`.
 * `options.deriveSession` must read only the immutable archive.
 */
export async function verifyMarketTrainSourceV1(market, request, options = {}) {
  try {
    return await verify(market, request, options ?? {});
  } catch (error) {
    return hold(error instanceof HoldSignal ? error.holdCode : 'VERIFIER_INTERNAL_ERROR');
  }
}

async function verify(market, request, options) {
  const config = configFor(market);
  const {
    deriveSession,
    rightsAttestation = null,
    expectedRightsSha256 = null,
    allowedSources = null,
    reviewedAssociationDigests = [],
    holdoutStartMs = DEFAULT_HOLDOUT_START_MS,
  } = options;
  const nowMs = Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  if (typeof deriveSession !== 'function') stop('ARCHIVE_READER_MISSING');
  if (!Number.isSafeInteger(holdoutStartMs) || holdoutStartMs <= 0) stop('HOLDOUT_BOUNDARY_INVALID');

  readRequest(market, request);
  const rightsSha256 = validateRights(market, config, rightsAttestation, expectedRightsSha256, allowedSources, nowMs);
  const approved = new Set(Array.isArray(reviewedAssociationDigests) ? reviewedAssociationDigests : []);
  if (!approved.has(request.reviewedAssociationDigest)) stop('FORMULA_REVIEW_NOT_APPROVED_BY_OWNER');

  const { symbol, timeframe, period, candles } = readDataset(config, request.dataset, holdoutStartMs);
  const starts = await sessionStartsFor(market, config, symbol, period, options);

  const derivedByStart = new Map();
  let widthMs = null;
  for (const sessionStartMs of starts) {
    const derived = await deriveSession({ market, symbol, sessionStartMs, asOfMs: nowMs, timeframe });
    if (!isPlainObject(derived) || derived.status === 'BLOCKED_DATA' || !isPlainObject(derived.intervalData)) {
      stop('ARCHIVED_SESSION_MISSING_OR_AMBIGUOUS');
    }
    const frame = Object.values(derived.intervalData)[0];
    if (!isPlainObject(frame) || !Array.isArray(frame.bars) || !Number.isSafeInteger(frame.intervalMinutes)) {
      stop('ARCHIVED_SESSION_FRAME_INVALID');
    }
    if (config.calendar === 'EXCHANGE' && frame.sourceSessionCoverageComplete !== true) {
      stop('ARCHIVED_SESSION_COVERAGE_INCOMPLETE');
    }
    const frameWidth = frame.intervalMinutes * 60_000;
    if (widthMs !== null && frameWidth !== widthMs) stop('ARCHIVED_SESSION_FRAME_INCONSISTENT');
    widthMs = frameWidth;
    for (const bar of frame.bars) derivedByStart.set(bar.startMs, bar);
  }
  if (widthMs === null) stop('ARCHIVED_SESSION_MISSING_OR_AMBIGUOUS');

  let expectedStarts;
  if (config.calendar === 'UTC_24H') {
    expectedStarts = [];
    for (let start = Math.ceil(period.startTime / widthMs) * widthMs; start + widthMs <= period.endTime; start += widthMs) {
      expectedStarts.push(start);
    }
  } else {
    expectedStarts = [...derivedByStart.keys()]
      .filter((start) => start >= period.startTime && start + widthMs <= period.endTime)
      .sort((a, b) => a - b);
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
  if (observedAtMs < period.endTime && config.calendar === 'UTC_24H') stop('ARCHIVE_DATA_NOT_AVAILABLE_BY_PERIOD_END');
  if (observedAtMs < expectedStarts.at(-1) + widthMs) stop('ARCHIVE_DATA_NOT_AVAILABLE_BY_PERIOD_END');

  return Object.freeze({
    status: 'VERIFIED_TRAIN_SOURCE',
    market,
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
    verifierContract: MARKET_SOURCE_VERIFIER_CONTRACT_V1,
    rightsAttestationSha256: rightsSha256,
    verifiedSessionCount: starts.length,
    verifiedBarCount: expectedStarts.length,
    independentSourceAuthenticityVerified: false,
    executionAuthority: 'NONE',
  });
}

export const verifyCryptoFuturesTrainSourceV1 = (request, options) => verifyMarketTrainSourceV1('CRYPTO_FUTURES', request, options);
export const verifyKrStockTrainSourceV1 = (request, options) => verifyMarketTrainSourceV1('KR_STOCK', request, options);
export const verifyUsStockTrainSourceV1 = (request, options) => verifyMarketTrainSourceV1('US_STOCK', request, options);

/** Read-only adapter over the private immutable minute archive (market comes from each call). */
export function createMarketArchiveDeriveSessionV1({ root }) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('ARCHIVE_ROOT_REQUIRED');
  return ({ market, symbol, sessionStartMs, asOfMs, timeframe }) => deriveArchivedResearchTimeframesV1({
    root, market, symbol, sessionStartMs, asOfMs, timeframes: [timeframe],
  });
}
