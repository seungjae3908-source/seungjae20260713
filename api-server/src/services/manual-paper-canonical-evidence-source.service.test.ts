import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperTradingState } from './paper-trading-engine.service';
import { PaperTradingError } from './paper-trading-core.service';
import { manualCanonicalFixture } from './manual-paper-canonical-contract.fixture';
import { manualPaperEvidenceSha256 } from './manual-paper-canonical-contract.service';
import {
  createManualPaperCanonicalEvidenceSource,
  unavailableManualPaperCanonicalEvidenceSource,
  type ManualPaperCanonicalOwnerEvidencePacket,
} from './manual-paper-canonical-evidence-source.service';

const NOW = new Date('2026-08-02T02:30:00.000Z');
const ACCOUNT = 'authenticated-paper-owner';

function input(state = createPaperTradingState(10_000, NOW), candidateId: string | null = 'candidate-v1') {
  return {
    authenticatedAccountId: ACCOUNT,
    candidateId,
    action: { type: 'mark_price', eventId: 'resolver-test', symbol: 'BTCUSDT', price: 100, at: NOW.toISOString() } as const,
    state,
    nowMs: NOW.getTime(),
  };
}

async function ownerPacket(state: ReturnType<typeof createPaperTradingState>) {
  const fixture = await manualCanonicalFixture(state, { entryOnly: true });
  const {
    authenticatedAccountId: _authenticatedAccountId,
    paperAccountId: _paperAccountId,
    paperStateSha256: _paperStateSha256,
    ...packet
  } = fixture.evidence;
  return { fixture, packet: packet as ManualPaperCanonicalOwnerEvidencePacket };
}

function paperError(code: string, statusCode: number) {
  return (error: unknown) => {
    assert.ok(error instanceof PaperTradingError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  };
}

test('canonical evidence resolver leaves non-canonical Paper untouched without reading owner sources', async () => {
  let reads = 0;
  const source = createManualPaperCanonicalEvidenceSource({
    async readPaperState() { reads += 1; throw new Error('must not read'); },
    async readOwnerEvidence() { reads += 1; throw new Error('must not read'); },
  });
  assert.equal(await source(input(undefined, null)), undefined);
  assert.equal(reads, 0);
});

test('canonical evidence resolver requires exact immutable owner-state readback before owner packet lookup', async () => {
  const state = createPaperTradingState(10_000, NOW);
  const different = structuredClone(state);
  different.account.cashBalance -= 1;
  let evidenceReads = 0;
  const source = createManualPaperCanonicalEvidenceSource({
    async readPaperState() { return different; },
    async readOwnerEvidence() { evidenceReads += 1; return undefined; },
  });
  await assert.rejects(() => source(input(state)), paperError('CANONICAL_PAPER_OWNER_STATE_READBACK_REQUIRED', 409));
  assert.equal(evidenceReads, 0);
});

test('canonical evidence resolver preserves MISSING when genuine owner evidence issuer is absent', async () => {
  const state = createPaperTradingState(10_000, NOW);
  const source = createManualPaperCanonicalEvidenceSource({
    async readPaperState() { return structuredClone(state); },
    async readOwnerEvidence() { return undefined; },
  });
  await assert.rejects(() => source(input(state)), paperError('CANONICAL_PAPER_OWNER_EVIDENCE_SOURCE_UNAVAILABLE', 503));
});

test('canonical evidence resolver reconstructs server binding fields instead of trusting owner packet claims', async () => {
  const state = createPaperTradingState(10_000, NOW);
  const { fixture, packet } = await ownerPacket(state);
  let readbackCandidate = '';
  const source = createManualPaperCanonicalEvidenceSource({
    async readPaperState(readInput) {
      assert.equal(readInput.authenticatedAccountId, ACCOUNT);
      assert.equal(readInput.candidateId, fixture.canonicalIdentity.candidateId);
      return structuredClone(state);
    },
    async readOwnerEvidence(readInput) {
      readbackCandidate = readInput.candidateId;
      assert.deepEqual(readInput.ownerState, state);
      return packet;
    },
  });
  const resolved = await source(input(state, fixture.canonicalIdentity.candidateId));
  assert.ok(resolved);
  assert.equal(readbackCandidate, fixture.canonicalIdentity.candidateId);
  assert.equal(resolved.authenticatedAccountId, ACCOUNT);
  assert.equal(resolved.paperAccountId, state.account.id);
  assert.equal(resolved.paperStateSha256, manualPaperEvidenceSha256(state));
  assert.deepEqual(resolved.validationReceipt, fixture.evidence.validationReceipt);
  assert.deepEqual(resolved.receiptVerification, fixture.evidence.receiptVerification);
});

test('canonical evidence resolver rejects owner packets that try to set server binding fields', async () => {
  const state = createPaperTradingState(10_000, NOW);
  const { fixture, packet } = await ownerPacket(state);
  const malicious = { ...packet, paperStateSha256: 'client-claim' } as ManualPaperCanonicalOwnerEvidencePacket;
  const source = createManualPaperCanonicalEvidenceSource({
    async readPaperState() { return structuredClone(state); },
    async readOwnerEvidence() { return malicious; },
  });
  await assert.rejects(
    () => source(input(state, fixture.canonicalIdentity.candidateId)),
    paperError('CANONICAL_PAPER_OWNER_PACKET_SERVER_FIELD_FORBIDDEN', 409),
  );
});

test('default canonical source is explicit fail-closed while non-canonical Paper remains available', async () => {
  const state = createPaperTradingState(10_000, NOW);
  assert.equal(await unavailableManualPaperCanonicalEvidenceSource(input(state, null)), undefined);
  await assert.rejects(
    () => unavailableManualPaperCanonicalEvidenceSource(input(state, 'canonical-candidate')),
    paperError('CANONICAL_PAPER_OWNER_EVIDENCE_SOURCE_UNAVAILABLE', 503),
  );
});
