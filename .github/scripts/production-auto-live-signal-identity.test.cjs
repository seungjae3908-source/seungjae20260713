const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectSignalEntryIdentity, assertSignalEntryIdentityReceipt } = require('../../ops/production-auto-live-signal-identity.cjs');
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
