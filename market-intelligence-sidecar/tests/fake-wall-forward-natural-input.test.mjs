import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFakeWallNaturalCadenceEvent,
  buildFakeWallNaturalLedgerBatch,
  buildFakeWallNaturalLedgerInput,
  FAKE_WALL_NATURAL_EVENT_CONTRACT,
  FAKE_WALL_NATURAL_INPUT_CONTRACT,
} from '../src/fake-wall-forward-natural-input.mjs';

const researchSha = 'a'.repeat(40);
const detectedAt = 1_800_000_000_000;

function candidate(state = 'CANDIDATE') {
  return {
    contract: 'market-intelligence-spoof-candidate/v1',
    mode: 'OBSERVE_ONLY',
    state,
    direction: 'BULLISH_SUPPORT',
    evidenceScore: state === 'CANDIDATE' ? 88 : 42,
    evidence: { wallSide: 'bid', wallPrice: 100, cancellationRatio: 0.91 },
    confounders: state === 'CANDIDATE' ? [] : ['THIN_BOOK'],
    missingEvidence: state === 'CANDIDATE' ? [] : ['TRADE_EXECUTION_EVIDENCE'],
    scannerHardBlockAllowed: false,
    parentGateImpact: 'NONE',
    orderAllowed: false,
    executionAuthority: 'NONE',
  };
}

function event(overrides = {}) {
  return {
    serviceSha: researchSha,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    venue: 'BITGET',
    detectedAt,
    referencePrice: 100,
    candidate: candidate(),
    provenance: { provider: 'Bitget', privateApiUsed: false },
    freshness: { state: 'fresh', ageMs: 1200 },
    qualityFlags: [],
    ...overrides,
  };
}

function publicInput(overrides = {}) {
  return {
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    asOf: detectedAt,
    orderBook: {
      ts: detectedAt,
      bids: [[99, 2]],
      asks: [[101, 3]],
    },
    provenance: {
      provider: 'BITGET_PUBLIC_UTA_V3',
      privateApiUsed: false,
      endpoints: ['/api/v3/market/orderbook'],
    },
    ...overrides,
  };
}

function evaluatedResult(overrides = {}) {
  return {
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    asOf: detectedAt,
    ageMs: 500,
    policy: { maxDataAgeMs: 15_000 },
    microstructure: { spoofCandidate: candidate() },
    warnings: [],
    ...overrides,
  };
}

test('public GET cadence emits deterministic sanitized natural event that feeds ledger input', () => {
  const naturalEvent = buildFakeWallNaturalCadenceEvent(publicInput(), evaluatedResult(), { serviceSha: researchSha });
  assert.equal(naturalEvent.contract, FAKE_WALL_NATURAL_EVENT_CONTRACT);
  assert.equal(naturalEvent.natural, true);
  assert.equal(naturalEvent.source, 'MARKET_INTELLIGENCE_PUBLIC_GET');
  assert.equal(naturalEvent.serviceSha, researchSha);
  assert.equal(naturalEvent.venue, 'BITGET_PUBLIC_UTA_V3');
  assert.equal(naturalEvent.referencePrice, 100);
  assert.match(naturalEvent.eventId, /^fwn-[0-9a-f]{64}$/u);
  assert.equal(naturalEvent.provenance.privateApiUsed, false);
  assert.deepEqual(naturalEvent.provenance.endpoints, ['/api/v3/market/orderbook']);
  assert.equal(naturalEvent.freshness.state, 'fresh');

  const built = buildFakeWallNaturalLedgerInput(naturalEvent, { researchCodeSha: researchSha });
  assert.match(built.candidateEventId, /^fw-[0-9a-f]{64}$/u);
  assert.equal(built.observation.status, 'PENDING');
  assert.equal(built.mark.observedAt, detectedAt);
  assert.equal(built.mark.referencePrice, 100);
});

test('natural cadence event rejects provenance that is not explicitly public-only', () => {
  assert.throws(
    () => buildFakeWallNaturalCadenceEvent(publicInput({
      provenance: { provider: 'BITGET', privateApiUsed: true },
    }), evaluatedResult(), { serviceSha: researchSha }),
    /FAKE_WALL_NATURAL_PRIVATE_PROVENANCE_REJECTED/u,
  );
});

test('natural candidate becomes deterministic append-only observation plus public mark', () => {
  const built = buildFakeWallNaturalLedgerInput(event(), { researchCodeSha: researchSha });
  assert.equal(built.contract, FAKE_WALL_NATURAL_INPUT_CONTRACT);
  assert.match(built.candidateEventId, /^fw-[0-9a-f]{64}$/u);
  assert.equal(built.candidateEventId, built.observation.candidateId);
  assert.equal(built.observation.candidateEventId, built.candidateEventId);
  assert.equal(built.observation.serviceSha, researchSha);
  assert.equal(built.observation.producerSha, researchSha);
  assert.match(built.evidenceSnapshotDigest, /^[0-9a-f]{64}$/u);
  assert.equal(built.observation.evidenceSnapshotDigest, built.evidenceSnapshotDigest);
  assert.equal(built.observation.provenance.evidenceSnapshotDigest, built.evidenceSnapshotDigest);
  assert.equal(built.observation.status, 'PENDING');
  assert.deepEqual(built.observation.horizons.map((item) => item.status), ['PENDING', 'PENDING', 'PENDING']);
  assert.deepEqual(built.mark, {
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    venue: 'BITGET',
    observedAt: detectedAt,
    referencePrice: 100,
  });
});

test('no-candidate cadence event still contributes a future public settlement mark without fabricating an observation', () => {
  const built = buildFakeWallNaturalLedgerInput(event({ candidate: candidate('NO_CANDIDATE'), referencePrice: 101 }), {
    researchCodeSha: researchSha,
  });
  assert.equal(built.observation, null);
  assert.equal(built.candidateEventId, null);
  assert.equal(built.mark.referencePrice, 101);
});

test('service SHA mismatch fails closed instead of mixing evidence identity', () => {
  assert.throws(
    () => buildFakeWallNaturalLedgerInput(event({ serviceSha: 'b'.repeat(40) }), { researchCodeSha: researchSha }),
    /FAKE_WALL_NATURAL_IDENTITY_MISMATCH/u,
  );
});

test('natural cadence batch rejects time reversal for the same market symbol venue', () => {
  assert.throws(
    () => buildFakeWallNaturalLedgerBatch([
      event({ detectedAt: detectedAt + 1_000 }),
      event({ detectedAt }),
    ], { researchCodeSha: researchSha }),
    /FAKE_WALL_NATURAL_TIME_REVERSAL/u,
  );
});
