import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { persistResearchMinuteSessionV1 } from '../../market-prediction-lab/src/research-minute-archive-v1.js';
import {
  UPBIT_RIGHTS_ATTESTATION_SCHEMA_V1,
  createArchiveDeriveSessionV1,
  digestUpbitRightsAttestationV1,
  verifyUpbitSpotTrainSourceV1,
} from '../src/upbit-spot-source-verifier-v1.mjs';

const DAY = 86_400_000;
const MINUTE = 60_000;
const START = Date.UTC(2025, 5, 1);
const SYMBOL = 'KRW-BTC';
const NOW = Date.UTC(2026, 5, 1);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const SHA40 = 'a'.repeat(40);
const ASSOCIATION = sha('association');

function minuteBars(sessionStartMs, { skipMinute = null } = {}) {
  const bars = [];
  for (let index = 0; index < 1440; index += 1) {
    if (index === skipMinute) continue;
    const timestampMs = sessionStartMs + index * MINUTE;
    const base = 100_000_000 + (sessionStartMs / DAY) * 1000 + index;
    bars.push({
      market: 'CRYPTO_SPOT', venue: 'UPBIT_KRW', symbol: SYMBOL, sourceId: 'test-upbit-minute-source',
      timestampMs, availableAtMs: timestampMs + MINUTE + 500,
      open: base, high: base + 50, low: base - 50, close: base + 10, volume: 1 + (index % 7),
    });
  }
  return bars;
}

async function storeSession(root, sessionStartMs, options) {
  const bars = minuteBars(sessionStartMs, options);
  return persistResearchMinuteSessionV1({
    root,
    source: {
      market: 'CRYPTO_SPOT', venue: 'UPBIT_KRW', symbol: SYMBOL, sourceId: 'test-upbit-minute-source',
      session: { startMs: sessionStartMs, endMs: sessionStartMs + DAY, kind: 'UTC_24H', timeZone: 'UTC', calendarSourceId: 'utc-24h-test' },
      minuteBars: bars,
      sourceMinuteRowsSha256: sha(JSON.stringify(bars)),
      asOfMs: sessionStartMs + DAY + 1000,
    },
  });
}

const attestation = Object.freeze({
  schemaVersion: UPBIT_RIGHTS_ATTESTATION_SCHEMA_V1,
  source: 'UPBIT_PUBLIC_QUOTATION',
  market: 'CRYPTO_SPOT',
  permittedUse: 'INTERNAL_RESEARCH_BACKTEST',
  termsUrl: 'https://upbit.com/open_api_agreement',
  confirmedBy: 'owner',
  confirmedAt: '2026-01-02T00:00:00.000Z',
});

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'upbit-verifier-'));
  await storeSession(root, START, options);
  await storeSession(root, START + DAY);
  const deriveSession = createArchiveDeriveSessionV1({ root });
  const derived = [];
  for (const sessionStartMs of [START, START + DAY]) {
    const result = await deriveSession({ symbol: SYMBOL, sessionStartMs, asOfMs: NOW, timeframe: '4h' });
    derived.push(...Object.values(result.intervalData)[0].bars);
  }
  const candles = derived.map((bar) => ({
    timestamp: bar.startMs, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
  }));
  const dataset = {
    datasetRole: 'TRAIN', datasetIdentity: 'upbit-btc-4h-train', market: 'CRYPTO_SPOT', symbol: SYMBOL,
    timeframe: '4H', direction: 'LONG', candleCount: candles.length,
    period: { startTime: START, endTime: START + 2 * DAY, includeFinalHoldout: false },
    backtestInput: { market: 'CRYPTO_SPOT', timeframe: '4H', side: 'long', candles },
  };
  const request = {
    researchSha: SHA40, aiEvidenceDigest: sha('evidence'), sourceCycleId: 'cycle-1', hypothesisId: 'H1',
    formulaCandidate: { candidateId: 'cand-1', formulaHash: sha('formula'), market: 'CRYPTO_SPOT' },
    dataset, datasetDigest: sha('dataset'), reviewIdentityDigest: sha('review'), reviewedAssociationDigest: ASSOCIATION,
  };
  const base = {
    deriveSession, nowMs: NOW, rightsAttestation: attestation,
    expectedRightsSha256: digestUpbitRightsAttestationV1(attestation),
    reviewedAssociationDigests: [ASSOCIATION],
  };
  return { root, request, base, candles };
}

async function withFixture(run, options) {
  const fx = await fixture(options);
  try { await run(fx); } finally { await rm(fx.root, { recursive: true, force: true }); }
}

test('a dataset that exactly matches the archive is verified with no execution authority', async () => {
  await withFixture(async ({ request, base }) => {
    const proof = await verifyUpbitSpotTrainSourceV1(request, base);
    assert.equal(proof.status, 'VERIFIED_TRAIN_SOURCE');
    assert.equal(proof.verifiedSessionCount, 2);
    assert.equal(proof.verifiedBarCount, 12);
    assert.equal(proof.datasetRole, 'TRAIN');
    assert.equal(proof.sourceRightsVerified, true);
    assert.equal(proof.formulaReviewedForAiHypothesis, true);
    assert.equal(proof.independentSourceAuthenticityVerified, false);
    assert.equal(proof.executionAuthority, 'NONE');
    assert.ok(proof.observedAtMs >= START + 2 * DAY - 4 * 3_600_000);
  });
});

test('every request binding is echoed exactly so the producer can compare them', async () => {
  await withFixture(async ({ request, base }) => {
    const proof = await verifyUpbitSpotTrainSourceV1(request, base);
    assert.equal(proof.researchSha, request.researchSha);
    assert.equal(proof.aiEvidenceDigest, request.aiEvidenceDigest);
    assert.equal(proof.datasetDigest, request.datasetDigest);
    assert.equal(proof.reviewIdentityDigest, request.reviewIdentityDigest);
    assert.equal(proof.reviewedAssociationDigest, request.reviewedAssociationDigest);
    assert.equal(proof.formulaCandidateId, 'cand-1');
    assert.equal(proof.formulaHash, request.formulaCandidate.formulaHash);
  });
});

test('a changed candle value is held', async () => {
  await withFixture(async ({ request, base, candles }) => {
    const tampered = structuredClone(request);
    tampered.dataset.backtestInput.candles[3] = { ...candles[3], close: candles[3].close + 1 };
    assert.deepEqual(await verifyUpbitSpotTrainSourceV1(tampered, base), { status: 'HOLD', code: 'DATASET_CANDLES_DO_NOT_MATCH_ARCHIVE', executionAuthority: 'NONE' });
  });
});

test('a dropped, extra or shifted candle is held', async () => {
  await withFixture(async ({ request, base, candles }) => {
    const dropped = structuredClone(request);
    dropped.dataset.backtestInput.candles = candles.slice(1);
    dropped.dataset.candleCount = candles.length - 1;
    assert.equal((await verifyUpbitSpotTrainSourceV1(dropped, base)).code, 'DATASET_CANDLES_DO_NOT_MATCH_ARCHIVE');
    const shifted = structuredClone(request);
    shifted.dataset.backtestInput.candles[0] = { ...candles[0], timestamp: candles[0].timestamp + MINUTE };
    assert.equal((await verifyUpbitSpotTrainSourceV1(shifted, base)).code, 'DATASET_CANDLES_DO_NOT_MATCH_ARCHIVE');
  });
});

test('a missing minute inside the period is held, never filled', async () => {
  await withFixture(async ({ request, base }) => {
    const result = await verifyUpbitSpotTrainSourceV1(request, base);
    assert.equal(result.status, 'HOLD');
    assert.ok(['PERIOD_BAR_MISSING_IN_ARCHIVE', 'DATASET_CANDLES_DO_NOT_MATCH_ARCHIVE'].includes(result.code));
  }, { skipMinute: 5 });
});

test('a session that was never archived is held', async () => {
  await withFixture(async ({ request, base }) => {
    const longer = structuredClone(request);
    longer.dataset.period.endTime = START + 3 * DAY;
    assert.equal((await verifyUpbitSpotTrainSourceV1(longer, base)).code, 'ARCHIVED_SESSION_MISSING_OR_AMBIGUOUS');
  });
});

test('the sealed holdout, an open holdout flag and bad symbols are held', async () => {
  await withFixture(async ({ request, base }) => {
    const holdout = structuredClone(request);
    assert.equal((await verifyUpbitSpotTrainSourceV1(holdout, { ...base, holdoutStartMs: START + DAY })).code, 'DATASET_PERIOD_TOUCHES_SEALED_HOLDOUT');
    const flagged = structuredClone(request);
    flagged.dataset.period.includeFinalHoldout = true;
    assert.equal((await verifyUpbitSpotTrainSourceV1(flagged, base)).code, 'DATASET_PERIOD_INVALID');
    const futures = structuredClone(request);
    futures.dataset.symbol = 'BTCUSDT';
    assert.equal((await verifyUpbitSpotTrainSourceV1(futures, base)).code, 'DATASET_SYMBOL_MISSING_OR_INVALID');
    const futuresMarket = structuredClone(request);
    futuresMarket.dataset.market = 'CRYPTO_FUTURES';
    assert.equal((await verifyUpbitSpotTrainSourceV1(futuresMarket, base)).code, 'REQUEST_DATASET_NOT_SPOT_TRAIN');
  });
});

test('rights attestation must exist, be pinned, unaltered and not from the future', async () => {
  await withFixture(async ({ request, base }) => {
    assert.equal((await verifyUpbitSpotTrainSourceV1(request, { ...base, rightsAttestation: null })).code, 'RIGHTS_ATTESTATION_MISSING');
    assert.equal((await verifyUpbitSpotTrainSourceV1(request, { ...base, expectedRightsSha256: null })).code, 'RIGHTS_ATTESTATION_PIN_MISSING');
    assert.equal((await verifyUpbitSpotTrainSourceV1(request, { ...base, rightsAttestation: { ...attestation, confirmedBy: 'someone else' } })).code, 'RIGHTS_ATTESTATION_HASH_MISMATCH');
    assert.equal((await verifyUpbitSpotTrainSourceV1(request, { ...base, rightsAttestation: { ...attestation, permittedUse: 'COMMERCIAL' } })).code, 'RIGHTS_ATTESTATION_SHAPE_INVALID');
    const future = { ...attestation, confirmedAt: '2027-01-01T00:00:00.000Z' };
    assert.equal((await verifyUpbitSpotTrainSourceV1(request, { ...base, rightsAttestation: future, expectedRightsSha256: digestUpbitRightsAttestationV1(future) })).code, 'RIGHTS_ATTESTATION_TIME_INVALID');
  });
});

test('the owner must approve the exact reviewed association', async () => {
  await withFixture(async ({ request, base }) => {
    assert.equal((await verifyUpbitSpotTrainSourceV1(request, { ...base, reviewedAssociationDigests: [] })).code, 'FORMULA_REVIEW_NOT_APPROVED_BY_OWNER');
    assert.equal((await verifyUpbitSpotTrainSourceV1(request, { ...base, reviewedAssociationDigests: [sha('other')] })).code, 'FORMULA_REVIEW_NOT_APPROVED_BY_OWNER');
  });
});

test('malformed requests and reader failures hold instead of throwing', async () => {
  await withFixture(async ({ request, base }) => {
    assert.equal((await verifyUpbitSpotTrainSourceV1(null, base)).code, 'REQUEST_INVALID');
    assert.equal((await verifyUpbitSpotTrainSourceV1({ ...request, researchSha: 'xyz' }, base)).code, 'REQUEST_RESEARCH_SHA_INVALID');
    assert.equal((await verifyUpbitSpotTrainSourceV1(request, {})).code, 'ARCHIVE_READER_MISSING');
    const boom = { ...base, deriveSession: async () => { throw new Error('disk exploded'); } };
    const result = await verifyUpbitSpotTrainSourceV1(request, boom);
    assert.deepEqual(result, { status: 'HOLD', code: 'VERIFIER_INTERNAL_ERROR', executionAuthority: 'NONE' });
  });
});
