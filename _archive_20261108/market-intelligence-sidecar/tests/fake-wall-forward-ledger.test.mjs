import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceLedger,
  buildArtifactBundle,
  buildCandidateObservation,
  createEmptyLedger,
  verifyPredecessorBundle,
} from '../src/fake-wall-forward-ledger.mjs';

const sha = '1'.repeat(40);
const baseContext = {
  market: 'CRYPTO_FUTURES',
  symbol: 'BTCUSDT',
  venue: 'BITGET',
  producerSha: sha,
  detectedAt: 1_800_000_000_000,
  referencePrice: 100,
  provenance: { provider: 'Bitget', privateApiUsed: false },
  freshness: { state: 'fresh' },
};
const candidate = {
  contract: 'market-intelligence-spoof-candidate/v1',
  mode: 'OBSERVE_ONLY',
  state: 'CANDIDATE',
  direction: 'BULLISH_SUPPORT',
  evidenceScore: 88,
  evidence: { wallSide: 'ask', wallPrice: 101, cancellationRatio: 0.95 },
  confounders: [],
  missingEvidence: [],
  scannerHardBlockAllowed: false,
  parentGateImpact: 'NONE',
  orderAllowed: false,
  executionAuthority: 'NONE',
};

test('candidate identity is deterministic and fixed horizons start PENDING', () => {
  const a = buildCandidateObservation(baseContext, candidate);
  const b = buildCandidateObservation({ ...baseContext }, { ...candidate, evidence: { cancellationRatio: 0.95, wallPrice: 101, wallSide: 'ask' } });
  assert.equal(a.candidateId, b.candidateId);
  assert.equal(a.status, 'PENDING');
  assert.deepEqual(a.horizons.map((item) => [item.key, item.status]), [['5m', 'PENDING'], ['15m', 'PENDING'], ['60m', 'PENDING']]);
  assert.equal(a.evidence.orderAllowed, false);
  assert.equal(a.evidence.executionAuthority, 'NONE');
});

test('result not yet due stays PENDING and duplicate observation is idempotent', () => {
  const observation = buildCandidateObservation(baseContext, candidate);
  const first = advanceLedger({ researchCodeSha: sha, observations: [observation], now: baseContext.detectedAt + 60_000 });
  assert.equal(first.state.observations.length, 1);
  assert.equal(first.state.observations[0].status, 'PENDING');
  const second = advanceLedger({ previousState: first.state, researchCodeSha: sha, observations: [observation], now: baseContext.detectedAt + 120_000 });
  assert.equal(second.state.observations.length, 1);
  assert.equal(second.stats.deduped, 1);
});

test('serialized predecessor state restores pending candidates after restart', () => {
  const observation = buildCandidateObservation(baseContext, candidate);
  const first = advanceLedger({ researchCodeSha: sha, observations: [observation], now: baseContext.detectedAt + 60_000 });
  const restored = JSON.parse(JSON.stringify(first.state));
  const next = advanceLedger({ previousState: restored, researchCodeSha: sha, now: baseContext.detectedAt + 120_000 });
  assert.equal(next.state.observations[0].candidateId, observation.candidateId);
  assert.equal(next.state.observations[0].status, 'PENDING');
});

test('fixed horizon settles only from an observed mark inside its immutable settlement window', () => {
  const observation = buildCandidateObservation(baseContext, candidate);
  const fiveMinutes = baseContext.detectedAt + 5 * 60_000;
  const result = advanceLedger({
    researchCodeSha: sha,
    observations: [observation],
    now: fiveMinutes + 30_000,
    marks: [
      { market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', venue: 'BITGET', observedAt: baseContext.detectedAt + 2 * 60_000, referencePrice: 102 },
      { market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', venue: 'BITGET', observedAt: fiveMinutes + 10_000, referencePrice: 103 },
    ],
  });
  const [h5, h15] = result.state.observations[0].horizons;
  assert.equal(h5.status, 'SETTLED');
  assert.equal(Math.round(h5.returnBps), 300);
  assert.equal(h5.direction, 'UP');
  assert.equal(h15.status, 'PENDING');
  assert.equal(result.state.observations[0].status, 'PARTIALLY_SETTLED');
});

test('missing mature mark invalidates only that horizon instead of fabricating zero or profit', () => {
  const observation = buildCandidateObservation(baseContext, candidate);
  const result = advanceLedger({
    researchCodeSha: sha,
    observations: [observation],
    now: baseContext.detectedAt + 8 * 60_000,
    marks: [],
  });
  const h5 = result.state.observations[0].horizons[0];
  assert.equal(h5.status, 'INVALIDATED');
  assert.equal(h5.reason, 'HORIZON_MARK_MISSING');
  assert.equal(h5.returnBps, null);
  assert.equal(h5.observedReferencePrice, null);
});

test('artifact bundle is immutable and predecessor digest mismatch fails closed', () => {
  const state = createEmptyLedger({ researchCodeSha: sha });
  const bundle = buildArtifactBundle(state, { predecessorArtifactId: 123, predecessorArtifactDigest: 'abc', harnessSha: '2'.repeat(40) });
  assert.equal(verifyPredecessorBundle({ ...bundle, researchCodeSha: sha }), true);
  const tampered = JSON.parse(JSON.stringify(bundle.state));
  tampered.observations.push({ candidateId: 'tampered', producerSha: sha, horizons: [] });
  assert.throws(
    () => verifyPredecessorBundle({ manifest: bundle.manifest, state: tampered, summary: bundle.summary, researchCodeSha: sha }),
    (error) => error.message === 'ARTIFACT_CHAIN_BROKEN',
  );
});

test('same candidateId with different immutable content is rejected', () => {
  const observation = buildCandidateObservation(baseContext, candidate);
  const first = advanceLedger({ researchCodeSha: sha, observations: [observation], now: baseContext.detectedAt });
  const changed = JSON.parse(JSON.stringify(observation));
  changed.referencePrice = 999;
  assert.throws(
    () => advanceLedger({ previousState: first.state, researchCodeSha: sha, observations: [changed], now: baseContext.detectedAt + 1 }),
    /FAKE_WALL_CANDIDATE_ID_COLLISION/,
  );
});
