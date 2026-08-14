import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'paper-research-persistent-ledger-'));
const entry = path.join(temporaryDirectory, 'entry.ts');
const output = path.join(temporaryDirectory, 'bundle.mjs');
const NOW = 1_800_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

class MemoryRepository {
  records = new Map();
  idempotent = new Map();
  conflicts = new Map();
  writeCount = 0;

  key(userId, kind, id) { return `${userId}:${kind}:${id}`; }

  async getRecord(userId, kind, id) {
    return structuredClone(this.records.get(this.key(userId, kind, id)) ?? null);
  }

  async upsertRecord(userId, record, serverTime) {
    this.writeCount += 1;
    const key = this.key(userId, record.kind, record.id);
    const previous = this.records.get(key);
    const stored = {
      ...structuredClone(record),
      createdAt: previous?.createdAt ?? serverTime,
      serverUpdatedAt: serverTime,
    };
    this.records.set(key, stored);
    return structuredClone(stored);
  }

  async listSnapshot(userId) {
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(`${userId}:`))
      .map(([, value]) => structuredClone(value));
  }

  async getIdempotentResponse(userId, key) {
    return structuredClone(this.idempotent.get(`${userId}:${key}`) ?? null);
  }

  async saveIdempotentResponse(userId, key, result) {
    this.idempotent.set(`${userId}:${key}`, structuredClone(result));
  }

  async saveConflict(userId, conflict) {
    this.conflicts.set(`${userId}:${conflict.id}`, structuredClone(conflict));
  }

  async getConflict(userId, conflictId) {
    return structuredClone(this.conflicts.get(`${userId}:${conflictId}`) ?? null);
  }

  async markConflictResolved(userId, conflictId) {
    const key = `${userId}:${conflictId}`;
    const conflict = this.conflicts.get(key);
    if (conflict) this.conflicts.set(key, { ...conflict, status: 'resolved' });
  }

  async listJournalPayloads() { return []; }
  async deleteAll() { this.records.clear(); this.idempotent.clear(); this.conflicts.clear(); return { account: 0, order: 0, position: 0, fill: 0, journal: 0, syncState: 0 }; }
}

const fxEvidence = () => [
  { market: 'KR_STOCK', quoteCurrency: 'KRW', krwPerUnit: 1, observedAtMs: NOW - 1_000, source: 'identity-krw', provenance: 'canonical-krw-settlement', version: 'fx-v1' },
  { market: 'US_STOCK', quoteCurrency: 'USD', krwPerUnit: 1_350, observedAtMs: NOW - 1_000, source: 'yahoo-public:KRW=X', provenance: 'usdkrw-public', version: 'fx-v1' },
  { market: 'CRYPTO_SPOT', quoteCurrency: 'KRW', krwPerUnit: 1, observedAtMs: NOW - 1_000, source: 'identity-krw', provenance: 'upbit-krw-settlement', version: 'fx-v1' },
  { market: 'CRYPTO_FUTURES', quoteCurrency: 'USDT', krwPerUnit: 1_360, observedAtMs: NOW - 1_000, source: 'upbit-public:KRW-USDT', provenance: 'usdtkrw-public', version: 'fx-v1' },
];

const entries = (usAmount = 100) => [
  { id: 'cash', bucket: 'CASH', nativeAmount: 400_000, quoteCurrency: 'KRW', observedAtMs: NOW - 1_000, source: 'paper-ledger', provenance: 'paper-cash-v1', version: 'ledger-v1', quality: 'LIVE' },
  { id: 'kr', bucket: 'KR_STOCK', nativeAmount: 200_000, quoteCurrency: 'KRW', observedAtMs: NOW - 1_000, source: 'paper-ledger', provenance: 'kr-stock-v1', version: 'ledger-v1', quality: 'LIVE' },
  { id: 'us', bucket: 'US_STOCK', nativeAmount: usAmount, quoteCurrency: 'USD', observedAtMs: NOW - 1_000, source: 'paper-ledger', provenance: 'us-stock-v1', version: 'ledger-v1', quality: 'LIVE' },
  { id: 'spot', bucket: 'CRYPTO_SPOT', nativeAmount: 100_000, quoteCurrency: 'KRW', observedAtMs: NOW - 1_000, source: 'paper-ledger', provenance: 'upbit-spot-v1', version: 'ledger-v1', quality: 'LIVE' },
  { id: 'futures', bucket: 'CRYPTO_FUTURES', nativeAmount: 50, quoteCurrency: 'USDT', observedAtMs: NOW - 1_000, source: 'paper-ledger', provenance: 'bitget-equity-v1', version: 'ledger-v1', quality: 'LIVE' },
];

try {
  await writeFile(entry, `
    export * from ${JSON.stringify(path.join(root, 'src/services/paper-research-currency-ledger.service.ts'))};
    export * from ${JSON.stringify(path.join(root, 'src/services/paper-research-persistent-ledger.service.ts'))};
  `);
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });

  const module = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);
  const {
    PAPER_RESEARCH_LEDGER_MARKETS,
    PAPER_RESEARCH_PERSISTED_LEDGER_ID,
    buildPaperResearchCurrencyLedger,
    buildPaperResearchLedgerSyncRecord,
    loadPaperResearchCurrencyLedger,
    persistPaperResearchCurrencyLedger,
  } = module;

  const buildLedger = (usAmount = 100, extra = {}) => buildPaperResearchCurrencyLedger({
    initialCapitalKrw: 1_000_000,
    markets: PAPER_RESEARCH_LEDGER_MARKETS,
    fxEvidence: fxEvidence(),
    entries: entries(usAmount),
    ...extra,
  }, NOW);

  const canonical = buildLedger();
  assert.equal(canonical.status, 'READY');
  assert.equal(canonical.totalEquityKrw, 903_000);

  const record = buildPaperResearchLedgerSyncRecord(canonical, { version: 1, updatedAt: NOW_ISO });
  assert.equal(record.kind, 'account');
  assert.equal(record.id, PAPER_RESEARCH_PERSISTED_LEDGER_ID);
  assert.equal(record.version, 1);
  assert.equal(record.payload.schemaVersion, 'paper-research-persisted-ledger-v1');
  assert.equal(record.payload.ledger.currencyAwareLedgerIntegrated, true);
  assert.equal(record.payload.ledger.persistentLedgerIntegrated, false);
  assert.equal(record.payload.liveOrderAllowed, false);
  assert.equal(record.payload.privateTradingApiAllowed, false);
  assert.equal(record.payload.orderSubmitted, false);
  assert.equal(record.payload.exchangeRequestSent, false);
  assert.equal(record.payload.profitabilityClaimAllowed, false);

  const repository = new MemoryRepository();
  const first = await persistPaperResearchCurrencyLedger(repository, 'user-a', canonical, {
    version: 1,
    idempotencyKey: 'paper-ledger-0001',
    clientTime: NOW_ISO,
  }, new Date(NOW));
  assert.equal(first.ok, true);
  assert.equal(first.persistentLedgerIntegrated, true);
  assert.equal(first.uploaded, 1);
  assert.equal(first.conflicts, 0);
  assert.equal(first.failed, 0);
  assert.equal(repository.writeCount, 1);

  const loaded = await loadPaperResearchCurrencyLedger(repository, 'user-a');
  assert.equal(loaded.found, true);
  assert.equal(loaded.persistentLedgerIntegrated, true);
  assert.equal(loaded.recordVersion, 1);
  assert.equal(loaded.payload.ledger.totalEquityKrw, canonical.totalEquityKrw);
  assert.deepEqual(loaded.payload.ledger.components, canonical.components);
  assert.equal(loaded.payload.ledger.components.find((row) => row.id === 'us').fxProvenance, 'usdkrw-public');
  assert.equal(loaded.payload.ledger.components.find((row) => row.id === 'futures').quoteCurrency, 'USDT');

  const repeated = await persistPaperResearchCurrencyLedger(repository, 'user-a', canonical, {
    version: 1,
    idempotencyKey: 'paper-ledger-0001',
    clientTime: NOW_ISO,
  }, new Date(NOW));
  assert.equal(repeated.persistentLedgerIntegrated, true);
  assert.equal(repository.writeCount, 1, 'idempotent retry must not create another write');

  const otherUser = await loadPaperResearchCurrencyLedger(repository, 'user-b');
  assert.equal(otherUser.found, false);
  assert.equal(otherUser.persistentLedgerIntegrated, false);

  const changed = buildLedger(101);
  const conflict = await persistPaperResearchCurrencyLedger(repository, 'user-a', changed, {
    version: 1,
    idempotencyKey: 'paper-ledger-0002',
    clientTime: NOW_ISO,
  }, new Date(NOW));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.persistentLedgerIntegrated, false);
  assert.equal(conflict.conflicts, 1);
  assert.equal(repository.writeCount, 1);

  const nextVersion = await persistPaperResearchCurrencyLedger(repository, 'user-a', changed, {
    version: 2,
    idempotencyKey: 'paper-ledger-0003',
    clientTime: new Date(NOW + 1_000).toISOString(),
  }, new Date(NOW + 1_000));
  assert.equal(nextVersion.ok, true);
  assert.equal(nextVersion.persistentLedgerIntegrated, true);
  assert.equal(nextVersion.uploaded, 1);
  assert.equal(repository.writeCount, 2);
  const loadedV2 = await loadPaperResearchCurrencyLedger(repository, 'user-a');
  assert.equal(loadedV2.recordVersion, 2);
  assert.equal(loadedV2.payload.ledger.components.find((row) => row.id === 'us').nativeAmount, 101);

  const partial = buildLedger(100, { fxEvidence: fxEvidence().filter((row) => row.market !== 'US_STOCK') });
  assert.equal(partial.status, 'PARTIAL');
  const partialRecord = buildPaperResearchLedgerSyncRecord(partial, { version: 3, updatedAt: NOW_ISO });
  assert.equal(partialRecord.payload.ledger.totalEquityKrw, null);
  assert.equal(partialRecord.payload.profitabilityClaimAllowed, false);

  const blocked = buildLedger(100, { entries: entries().map((row) => row.id === 'us' ? { ...row, quoteCurrency: 'KRW' } : row) });
  assert.equal(blocked.status, 'BLOCKED');
  assert.throws(() => buildPaperResearchLedgerSyncRecord(blocked, { version: 4, updatedAt: NOW_ISO }), /PAPER_LEDGER_BLOCKED/);

  assert.throws(() => buildPaperResearchLedgerSyncRecord(canonical, { version: 0, updatedAt: NOW_ISO }), /PAPER_LEDGER_VERSION_INVALID/);
  assert.throws(() => buildPaperResearchLedgerSyncRecord(canonical, { version: 1, updatedAt: 'not-a-time' }), /PAPER_LEDGER_TIMESTAMP_INVALID/);

  const serialized = JSON.stringify(record);
  for (const forbidden of ['apiKey', 'secret', 'accessToken', 'refreshToken', 'privateKey', 'userId', 'user_id']) {
    assert.equal(serialized.includes(forbidden), false, `forbidden field leaked: ${forbidden}`);
  }

  console.log(JSON.stringify({
    status: 'pass',
    recordId: PAPER_RESEARCH_PERSISTED_LEDGER_ID,
    canonicalInitialCapitalKrw: canonical.initialCapitalKrw,
    currencyAwareLedgerIntegrated: canonical.currencyAwareLedgerIntegrated,
    persistentLedgerIntegrated: first.persistentLedgerIntegrated,
    roundTripPreserved: loaded.payload.ledger.totalEquityKrw === canonical.totalEquityKrw,
    userIsolationVerified: otherUser.found === false,
    idempotencyVerified: repository.writeCount === 2,
    conflictFailClosed: conflict.persistentLedgerIntegrated === false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    profitabilityClaimAllowed: false,
  }));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
