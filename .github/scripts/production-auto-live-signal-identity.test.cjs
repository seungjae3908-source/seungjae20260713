const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectSignalEntryIdentity, assertSignalEntryIdentityReceipt,
  verifyProductionAutoLivePrearmHandoff } = require('../../ops/production-auto-live-signal-identity.cjs');
const SHA = 'a'.repeat(40);
const entry = (market, researchCodeSha = SHA) => ({ identity: { market, researchCodeSha } });
test('an empty handoff is transport-only and does not prove scanner/AI invocation or candidate SHA', () => {
  const proof = inspectSignalEntryIdentity([], SHA);
  assert.equal(proof.entryShaMatch, null);
  assert.equal(proof.producerInvocationVerified, false);
  assert.deepEqual(proof.observedMarkets, []);
  assert.doesNotThrow(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 0 }, SHA));
  assert.throws(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 0, entryShaMatch: true }, SHA), /IDENTITY_INVALID/);
  assert.throws(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 0,
    observedMarkets: ['KR_STOCK'] }, SHA), /IDENTITY_INVALID/);
});
test('mixed or old candidate SHA is rejected before a receipt is emitted', () => {
  for (const rows of [[entry('KR_STOCK', 'b'.repeat(40))], [entry('KR_STOCK'), entry('US_STOCK', 'b'.repeat(40))],
    [{}], [{ identity: { market: 'US_STOCK' } }]]) {
    assert.throws(() => inspectSignalEntryIdentity(rows, SHA), /HANDOFF_SHA_MISMATCH/);
  }
});
test('current candidate identities are bound exactly, never promoted into all-market AI execution proof', () => {
  const proof = inspectSignalEntryIdentity([entry('KR_STOCK'), entry('CRYPTO_FUTURES')], SHA);
  assert.equal(proof.entryShaMatch, true);
  assert.deepEqual(proof.entryResearchCodeShas, [SHA]);
  assert.deepEqual(proof.observedMarkets, ['CRYPTO_FUTURES', 'KR_STOCK']);
  assert.doesNotThrow(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 2 }, SHA));
  for (const patch of [{ producerInvocationVerified: true }, { sourceTransportOnly: false },
    { entryResearchCodeShas: ['b'.repeat(40)] }, { observedMarkets: ['KR_STOCK', 'KR_STOCK'] },
    { entryCount: 1 }, { entryCount: Number.NaN }]) {
    assert.throws(() => assertSignalEntryIdentityReceipt({ ...proof, entryCount: 2, ...patch }, SHA), /IDENTITY_INVALID/);
  }
});

test('prearm validates published schema and SHA256 without fabricating scanner/AI capability', async () => {
  const { buildMemberAutoTradingPaperHandoff } =
    await import('../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js');
  const nowMs = Date.parse('2026-10-12T23:00:00.000Z');
  const makeEmpty = (evaluatedAtMs = nowMs) => buildMemberAutoTradingPaperHandoff({
    cycleId: 'prearm-transport-only', evaluatedAtMs, lanes: [],
  });
  const published = makeEmpty();
  const safe = await verifyProductionAutoLivePrearmHandoff(published, SHA, nowMs);
  assert.equal(safe.entryCount, 0);
  assert.equal(safe.producerInvocationVerified, false);
  assert.equal(safe.sourceTransportOnly, true);
  assert.equal(safe.entryShaMatch, null);
  assert.deepEqual(safe.observedMarkets, []);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    { ...published, handoffDigest: 'b'.repeat(64) }, SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_CONTRACT_INVALID/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    { ...published, safety: { ...published.safety, liveTrading: true } }, SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_CONTRACT_INVALID/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    { ...published, status: 'BLOCKED_DATA', blockers: ['PUBLIC_DATA_MISSING'] }, SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_BLOCKED_OR_STALE/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    makeEmpty(nowMs - 30 * 60_000 - 1), SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_BLOCKED_OR_STALE/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    makeEmpty(nowMs + 1), SHA, nowMs),
  /AUTOMATIC_TRADING_PREARM_HANDOFF_CONTRACT_INVALID/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    published, 'not-a-valid-sha', nowMs),
  /AUTOMATIC_TRADING_PREARM_ARGUMENT_INVALID/u);
  await assert.rejects(() => verifyProductionAutoLivePrearmHandoff(
    published, SHA, Number.NaN),
  /AUTOMATIC_TRADING_PREARM_ARGUMENT_INVALID/u);
});
