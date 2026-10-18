import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { persistResearchMinuteSessionV1 } from '../../market-prediction-lab/src/research-minute-archive-v1.js';
import {
  MARKET_VERIFIER_CONFIG_V1,
  createMarketArchiveDeriveSessionV1,
  digestRightsAttestationV1,
  verifyMarketTrainSourceV1,
} from '../src/market-source-verifier-v1.mjs';

const DAY = 86_400_000;
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 5, 1);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const ASSOCIATION = sha('association');

const SPECS = {
  CRYPTO_FUTURES: {
    venue: 'BITGET_USDT_FUTURES', symbol: 'BTCUSDT', timeZone: 'UTC', kind: 'UTC_24H', minutes: 1440, timeframe: '4h',
    starts: [Date.UTC(2025, 5, 1), Date.UTC(2025, 5, 2)], source: 'BITGET_PUBLIC_MARKET_DATA',
  },
  KR_STOCK: {
    venue: 'KRX', symbol: '005930', timeZone: 'Asia/Seoul', kind: 'REGULAR', minutes: 390, timeframe: '30m',
    starts: [Date.UTC(2025, 5, 2, 0, 0), Date.UTC(2025, 5, 3, 0, 0)], source: 'KRX_MINUTE_DATA_LICENSED',
  },
  US_STOCK: {
    venue: 'US_SIP', symbol: 'AAPL', timeZone: 'America/New_York', kind: 'REGULAR', minutes: 390, timeframe: '30m',
    starts: [Date.UTC(2025, 5, 2, 13, 30), Date.UTC(2025, 5, 3, 13, 30)], source: 'US_SIP_MINUTE_DATA_LICENSED',
  },
};

function minuteBars(market, spec, sessionStartMs, skipMinute = null) {
  const bars = [];
  for (let index = 0; index < spec.minutes; index += 1) {
    if (index === skipMinute) continue;
    const timestampMs = sessionStartMs + index * MINUTE;
    const base = 1000 + (sessionStartMs / DAY) + index;
    bars.push({
      market, venue: spec.venue, symbol: spec.symbol, sourceId: 'test-minute-source', timestampMs,
      availableAtMs: timestampMs + MINUTE + 500, open: base, high: base + 5, low: base - 5, close: base + 1, volume: 1 + (index % 7),
    });
  }
  return bars;
}

async function storeSession(root, market, spec, sessionStartMs, skipMinute) {
  const bars = minuteBars(market, spec, sessionStartMs, skipMinute);
  return persistResearchMinuteSessionV1({
    root,
    source: {
      market, venue: spec.venue, symbol: spec.symbol, sourceId: 'test-minute-source',
      session: { startMs: sessionStartMs, endMs: sessionStartMs + spec.minutes * MINUTE, kind: spec.kind, timeZone: spec.timeZone, calendarSourceId: 'test-calendar' },
      minuteBars: bars, sourceMinuteRowsSha256: sha(JSON.stringify(bars)), asOfMs: sessionStartMs + spec.minutes * MINUTE + 1000,
    },
  });
}

async function fixture(market, { skipMinute = null } = {}) {
  const spec = SPECS[market];
  const root = await mkdtemp(join(tmpdir(), 'market-verifier-'));
  await storeSession(root, market, spec, spec.starts[0], skipMinute);
  await storeSession(root, market, spec, spec.starts[1]);
  const deriveSession = createMarketArchiveDeriveSessionV1({ root });
  const bars = [];
  for (const sessionStartMs of spec.starts) {
    const result = await deriveSession({ market, symbol: spec.symbol, sessionStartMs, asOfMs: NOW, timeframe: spec.timeframe });
    bars.push(...(Object.values(result.intervalData)[0]?.bars ?? []));
  }
  const candles = bars.map((bar) => ({ timestamp: bar.startMs, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }));
  const endTime = spec.starts[1] + spec.minutes * MINUTE;
  const dataset = {
    datasetRole: 'TRAIN', datasetIdentity: `${market}-train`, market, symbol: spec.symbol, timeframe: spec.timeframe.toUpperCase(),
    candleCount: candles.length, period: { startTime: spec.starts[0], endTime, includeFinalHoldout: false },
    backtestInput: { market, candles },
  };
  const request = {
    researchSha: 'a'.repeat(40), aiEvidenceDigest: sha('evidence'), hypothesisId: 'H1',
    formulaCandidate: { candidateId: 'cand-1', formulaHash: sha('formula'), market },
    dataset, datasetDigest: sha('dataset'), reviewIdentityDigest: sha('review'), reviewedAssociationDigest: ASSOCIATION,
  };
  const attestation = {
    schemaVersion: MARKET_VERIFIER_CONFIG_V1[market].attestationSchema, source: spec.source, market,
    permittedUse: 'INTERNAL_RESEARCH_BACKTEST', termsUrl: 'https://example.com/terms', confirmedBy: 'owner', confirmedAt: '2026-01-02T00:00:00.000Z',
  };
  const base = {
    deriveSession, nowMs: NOW, rightsAttestation: attestation, expectedRightsSha256: digestRightsAttestationV1(attestation),
    reviewedAssociationDigests: [ASSOCIATION], allowedSources: [spec.source],
    sessionCalendar: async () => spec.starts,
  };
  return { root, request, base, candles, spec, attestation };
}

async function withFixture(market, run, options) {
  const fx = await fixture(market, options);
  try { await run(fx); } finally { await rm(fx.root, { recursive: true, force: true }); }
}

for (const market of Object.keys(SPECS)) {
  test(`${market}: dataset that exactly matches the archive is verified without execution authority`, async () => {
    await withFixture(market, async ({ request, base, candles }) => {
      assert.ok(candles.length > 0);
      const proof = await verifyMarketTrainSourceV1(market, request, base);
      assert.equal(proof.status, 'VERIFIED_TRAIN_SOURCE', JSON.stringify(proof));
      assert.equal(proof.market, market);
      assert.equal(proof.verifiedSessionCount, 2);
      assert.equal(proof.verifiedBarCount, candles.length);
      assert.equal(proof.sourceRightsVerified, true);
      assert.equal(proof.independentSourceAuthenticityVerified, false);
      assert.equal(proof.executionAuthority, 'NONE');
    });
  });

  test(`${market}: a changed candle value is held`, async () => {
    await withFixture(market, async ({ request, base }) => {
      request.dataset.backtestInput.candles[1] = { ...request.dataset.backtestInput.candles[1], close: 9 };
      assert.equal((await verifyMarketTrainSourceV1(market, request, base)).code, 'DATASET_CANDLES_DO_NOT_MATCH_ARCHIVE');
    });
  });

  test(`${market}: a dropped candle is held`, async () => {
    await withFixture(market, async ({ request, base }) => {
      request.dataset.backtestInput.candles.pop();
      request.dataset.candleCount -= 1;
      assert.equal((await verifyMarketTrainSourceV1(market, request, base)).code, 'DATASET_CANDLES_DO_NOT_MATCH_ARCHIVE');
    });
  });

  test(`${market}: rights attestation hash mismatch, wrong market and future time are held`, async () => {
    await withFixture(market, async ({ request, base, attestation }) => {
      assert.equal((await verifyMarketTrainSourceV1(market, request, { ...base, expectedRightsSha256: sha('x') })).code, 'RIGHTS_ATTESTATION_HASH_MISMATCH');
      const other = Object.keys(SPECS).find((m) => m !== market);
      assert.equal((await verifyMarketTrainSourceV1(market, request, { ...base, rightsAttestation: { ...attestation, market: other } })).code, 'RIGHTS_ATTESTATION_SHAPE_INVALID');
      const future = { ...attestation, confirmedAt: '2027-01-01T00:00:00.000Z' };
      assert.equal((await verifyMarketTrainSourceV1(market, request, { ...base, rightsAttestation: future, expectedRightsSha256: digestRightsAttestationV1(future) })).code, 'RIGHTS_ATTESTATION_TIME_INVALID');
      assert.equal((await verifyMarketTrainSourceV1(market, request, { ...base, rightsAttestation: null })).code, 'RIGHTS_ATTESTATION_MISSING');
    });
  });

  test(`${market}: unreviewed association, holdout touch and a missing archive reader are held`, async () => {
    await withFixture(market, async ({ request, base }) => {
      assert.equal((await verifyMarketTrainSourceV1(market, request, { ...base, reviewedAssociationDigests: [] })).code, 'FORMULA_REVIEW_NOT_APPROVED_BY_OWNER');
      assert.equal((await verifyMarketTrainSourceV1(market, request, { ...base, holdoutStartMs: request.dataset.period.endTime - 1 })).code, 'DATASET_PERIOD_TOUCHES_SEALED_HOLDOUT');
      assert.equal((await verifyMarketTrainSourceV1(market, request, { ...base, deriveSession: undefined })).code, 'ARCHIVE_READER_MISSING');
    });
  });

  test(`${market}: a minute missing from the archive is held`, async () => {
    await withFixture(market, async ({ request, base }) => {
      const result = await verifyMarketTrainSourceV1(market, request, base);
      assert.equal(result.status, 'HOLD');
    }, { skipMinute: 5 });
  });
}

test('stock markets hold without a session calendar or a source allowlist', async () => {
  await withFixture('KR_STOCK', async ({ request, base }) => {
    assert.equal((await verifyMarketTrainSourceV1('KR_STOCK', request, { ...base, sessionCalendar: undefined })).code, 'SESSION_CALENDAR_MISSING');
    assert.equal((await verifyMarketTrainSourceV1('KR_STOCK', request, { ...base, allowedSources: null })).code, 'RIGHTS_SOURCE_ALLOWLIST_MISSING');
    assert.equal((await verifyMarketTrainSourceV1('KR_STOCK', request, { ...base, sessionCalendar: async () => [] })).code, 'SESSION_CALENDAR_INVALID');
  });
});

test('a session the calendar lists but the archive lacks is held', async () => {
  await withFixture('US_STOCK', async ({ request, base, spec }) => {
    const extra = [...spec.starts, spec.starts[1] + DAY];
    const result = await verifyMarketTrainSourceV1('US_STOCK', request, { ...base, sessionCalendar: async () => extra });
    assert.equal(result.code, 'ARCHIVED_SESSION_MISSING_OR_AMBIGUOUS');
  });
});

test('unsupported market, symbol mismatch and malformed request never throw', async () => {
  assert.equal((await verifyMarketTrainSourceV1('FOREX', {}, {})).code, 'MARKET_UNSUPPORTED');
  assert.equal((await verifyMarketTrainSourceV1('US_STOCK', null, {})).code, 'ARCHIVE_READER_MISSING');
  await withFixture('KR_STOCK', async ({ request, base }) => {
    request.dataset.symbol = 'AAPL';
    assert.equal((await verifyMarketTrainSourceV1('KR_STOCK', request, base)).code, 'DATASET_SYMBOL_MISSING_OR_INVALID');
    assert.equal((await verifyMarketTrainSourceV1('US_STOCK', request, base)).code, 'REQUEST_FORMULA_INVALID');
  });
});
