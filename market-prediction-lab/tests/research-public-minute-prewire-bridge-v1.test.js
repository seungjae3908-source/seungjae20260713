import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validatePublicMinutePrewireForNativeArchiveV1 as verify,
  importPublicMinutePrewireIntoNativeArchiveV1 as imported,
} from '../src/research-public-minute-prewire-bridge-v1.js';

const DAY = 86_400_000;
const MS = 60_000;
const PINNED = 'a'.repeat(40);
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const midnight = Date.parse('2025-01-01T00:00:00Z');
function fakeSealedPrewire(market = 'CRYPTO_SPOT', sourcePageCount = 12) {
  const spot = market === 'CRYPTO_SPOT';
  const venue = spot ? 'UPBIT_KRW' : 'BITGET_USDT_FUTURES';
  const sourceId = spot ? 'UPBIT_PUBLIC_1M' : 'BITGET_PUBLIC_FUTURES_1M';
  const symbol = spot ? 'BTC' : 'BTCUSDT';
  const baseLastReceipt = midnight + DAY + 10 * MS;
  // This is a synthetic test-only retrospective receipt: the newer gap
  // supplement may be later than the original page's last receipt.
  const availableAtMs = baseLastReceipt + 5 * MS;
  const asOfMs = baseLastReceipt + 30 * MS;
  const rows = Array.from({ length: 1440 }, (_, i) => ({
    market, venue, symbol, sourceId,
    timestampMs: midnight + i * MS, availableAtMs,
    open: 100, high: 101, low: 99, close: 100.5, volume: 1,
  }));
  const digest = hash(rows);
  const original = {
    market, venue, symbol, sourceId,
    session: {
      startMs: midnight, endMs: midnight + DAY,
      kind: 'UTC_24H', timeZone: 'UTC',
      calendarSourceId: 'CRYPTO_UTC_DAY_SOURCE_ONLY',
    },
    minuteBars: rows, sourceMinuteRowsSha256: digest, asOfMs,
  };
  return {
    contract: 'research-original-minute-backtester-prewire/v1',
    status: 'RETROSPECTIVE_RESEARCH_MODEL_INPUT_ONLY',
    market, symbol, day: '2025-01-01', modelInput: original,
    sourceMinuteDigest: digest, sourceMinuteRows: 1440,
    oldestActualReceiptMs: midnight + DAY + MS,
    newestActualReceiptMs: baseLastReceipt,
    sourceArchiveDigests: Array.from({ length: sourcePageCount }, (_, i) =>
      hash(['test-fixture-only', i])),
    sourceArchiveProducerShas: [PINNED],
    metadata: {
      sourceMinutePages: sourcePageCount, missingOneMinuteSlots: 0,
      allSourceSlotsObserved: true, sourceDigestMatchesCanonicalModel: true,
      independentMarketLicenseOrPITProven: false,
      retrospectiveTimeCannotBeUsedAsScannerTime: true,
    },
    providerGETCount: 0, archiveFilesWritten: 0,
    executionAuthority: 'NONE', profitabilityProven: false,
    historicalPITProven: false, independentOosProven: false,
    fullCostProfitabilityProven: false, paperAdmissionAllowed: false,
  };
}

test('off by default: no inputs, root, account, network or disk required', async () => {
  const value = await imported();
  assert.equal(value.status, 'DISABLED');
  assert.equal(value.archiveFilesWritten, 0);
  assert.equal(value.executionAuthority, 'NONE');
  assert.equal(value.profitabilityProven, false);
  const hold = await imported({ enabled: true, prewire: fakeSealedPrewire() });
  assert.equal(hold.status, 'HOLD_OPERATOR_APPROVAL');
  assert.equal(hold.archiveFilesWritten, 0);
});

test('private source validation accepts exact 1440-row retrospective crypto day only', () => {
  for (const market of ['CRYPTO_SPOT', 'CRYPTO_FUTURES']) {
    const readback = fakeSealedPrewire(market);
    const verified = verify(readback, { expectedResearchSha: PINNED });
    assert.equal(verified.status, 'RETROSPECTIVE_ORIGINAL_SOURCE_COMPATIBLE');
    assert.equal(verified.observedMinuteRows, 1440);
    assert.equal(verified.profitabilityProven, false);
    assert.equal(verified.independentOosProven, false);
    assert.equal(verified.executionAuthority, 'NONE');
    // No raw candles returned by a status-only exported inspector.
    assert.ok(!Object.hasOwn(verified, 'modelInput'));
    assert.ok(!JSON.stringify(verified).includes('"minuteBars"'));
  }
});


test('eight verified 180m source receipts allow source-only compatibility but not economic credit', () => {
  for(const market of ['CRYPTO_SPOT','CRYPTO_FUTURES']){
    const v=fakeSealedPrewire(market,8);
    const good=verify(v,{expectedResearchSha:PINNED});
    assert.equal(good.status,'RETROSPECTIVE_ORIGINAL_SOURCE_COMPATIBLE');
    assert.equal(good.actualSourceReceipts,8);
    assert.equal(good.profitabilityProven,false);
    assert.equal(good.paperAdmissionAllowed,false);
    assert.equal(good.executionAuthority,'NONE');
    const short=verify(fakeSealedPrewire(market,7),{expectedResearchSha:PINNED});
    assert.equal(short.status,'BLOCKED_DATA');
    const mismatched=verify({...v,metadata:{...v.metadata,sourceMinutePages:12}},
      {expectedResearchSha:PINNED});
    assert.equal(mismatched.status,'BLOCKED_DATA');
  }
});

test('tampered, incomplete, identity-swapped and forged economic input is never imported', () => {
  const valid = fakeSealedPrewire();
  const bad = [
    { ...valid, sourceMinuteRows: 1439 },
    { ...valid, sourceMinuteDigest: 'b'.repeat(64) },
    { ...valid, sourceArchiveDigests: [hash('fake-one-page')] },
    { ...valid, sourceArchiveProducerShas: ['b'.repeat(40)] },
    { ...valid, metadata: { ...valid.metadata, missingOneMinuteSlots: 1 } },
    { ...valid, status: 'PROFITABILITY_PROVEN' },
    { ...valid, paperAdmissionAllowed: true },
    { ...valid, modelInput: { ...valid.modelInput, market: 'KR_STOCK' } },
    { ...valid, modelInput: { ...valid.modelInput,
      minuteBars: valid.modelInput.minuteBars.slice(0, 1439) } },
    { ...valid, modelInput: { ...valid.modelInput,
      asOfMs: valid.newestActualReceiptMs - MS } },
  ];
  for (const row of bad) {
    const result = verify(row, { expectedResearchSha: PINNED });
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.equal(result.archiveFilesWritten, 0);
    assert.equal(result.profitabilityProven, false);
  }
});

test('authorized offline fixture import seals one native revision and idempotently reuses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-native-public-bridge-'));
  try {
    await chmod(root, 0o700);
    const prewire = fakeSealedPrewire();
    const opts = { enabled: true, operatorApproved: true,
      prewire, archiveRoot: root, expectedResearchSha: PINNED };
    const first = await imported(opts);
    assert.equal(first.status, 'IMPORTED_RETROSPECTIVE_SOURCE_ONLY');
    assert.equal(first.archiveFilesWritten, 1);
    assert.equal(first.nativeArchivedMinuteRows, 1440);
    assert.equal(first.executionAuthority, 'NONE');
    assert.equal(first.profitabilityProven, false);
    assert.equal(first.actualFillsProven, false);
    const again = await imported(opts);
    assert.equal(again.status, 'IMPORTED_RETROSPECTIVE_SOURCE_ONLY');
    assert.equal(again.archiveFilesWritten, 0);
    assert.equal(again.reusedIdenticalSource, true);
    assert.equal(again.nativeImmutableArchiveDigest, first.nativeImmutableArchiveDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected app root and future as-of are blocked before any archive write', async () => {
  const v = fakeSealedPrewire();
  await assert.rejects(() => imported({
    enabled: true, operatorApproved: true, prewire: v,
    archiveRoot: '/opt/stock-app-data/secret',
    expectedResearchSha: PINNED,
  }), /NATIVE_MINUTE_PREWIRE_PROTECTED_ARCHIVE_ROOT/);
  const blocked = await imported({
    enabled: true, operatorApproved: true, prewire: v,
    archiveRoot: '/tmp/research-fixture-not-accessed',
    expectedResearchSha: PINNED,
    now: () => midnight + DAY,
  });
  assert.equal(blocked.status, 'BLOCKED_DATA');
  assert.equal(blocked.reason, 'PUBLIC_MINUTE_PREWIRE_FUTURE_ASOF_UNVERIFIED');
});
