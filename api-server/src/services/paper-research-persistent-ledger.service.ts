import {
  syncPaperJournal,
} from './paper-journal-sync.service.ts';
import type {
  PaperJournalRepository,
  PaperJournalSyncRecord,
  StoredPaperJournalRecord,
} from './paper-journal.types.ts';
import type {
  PaperResearchCurrencyLedger,
} from './paper-research-currency-ledger.service.ts';

export const PAPER_RESEARCH_PERSISTED_LEDGER_ID = 'paper-research-currency-ledger-v1' as const;
export const PAPER_RESEARCH_PERSISTED_LEDGER_SCHEMA = 'paper-research-persisted-ledger-v1' as const;

export type PaperResearchPersistedLedgerPayload = Readonly<{
  schemaVersion: typeof PAPER_RESEARCH_PERSISTED_LEDGER_SCHEMA;
  adapterVersion: 'v1';
  persistedAt: string;
  ledger: PaperResearchCurrencyLedger;
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  profitabilityClaimAllowed: false;
}>;

export type PaperResearchPersistentLedgerResult = Readonly<{
  ok: boolean;
  persistentLedgerIntegrated: boolean;
  recordId: typeof PAPER_RESEARCH_PERSISTED_LEDGER_ID;
  recordVersion: number;
  uploaded: number;
  downloaded: number;
  unchanged: number;
  conflicts: number;
  failed: number;
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  profitabilityClaimAllowed: false;
}>;

function finitePositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertPersistableLedger(ledger: PaperResearchCurrencyLedger) {
  if (ledger.schemaVersion !== 'paper-research-currency-ledger-v1') {
    throw new Error('PAPER_LEDGER_SCHEMA_UNSUPPORTED');
  }
  if (ledger.status === 'BLOCKED') {
    throw new Error('PAPER_LEDGER_BLOCKED');
  }
  if (ledger.currencyAwareLedgerIntegrated !== true) {
    throw new Error('PAPER_LEDGER_NOT_CURRENCY_AWARE');
  }
  if (
    ledger.simulatedOnly !== true
    || ledger.liveOrderAllowed !== false
    || ledger.privateTradingApiAllowed !== false
    || ledger.orderSubmitted !== false
    || ledger.autoPaperAllowed !== false
    || ledger.profitabilityClaimAllowed !== false
  ) {
    throw new Error('PAPER_LEDGER_SAFETY_CONTRACT_VIOLATION');
  }
}

export function buildPaperResearchLedgerSyncRecord(
  ledger: PaperResearchCurrencyLedger,
  input: Readonly<{ version: number; updatedAt: string }>,
): PaperJournalSyncRecord {
  assertPersistableLedger(ledger);
  if (!finitePositiveSafeInteger(input.version)) throw new Error('PAPER_LEDGER_VERSION_INVALID');
  if (!validIsoTimestamp(input.updatedAt)) throw new Error('PAPER_LEDGER_TIMESTAMP_INVALID');
  const persistedAt = new Date(input.updatedAt).toISOString();

  const payload: PaperResearchPersistedLedgerPayload = Object.freeze({
    schemaVersion: PAPER_RESEARCH_PERSISTED_LEDGER_SCHEMA,
    adapterVersion: 'v1',
    persistedAt,
    ledger: structuredClone(ledger),
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  });

  return {
    kind: 'account',
    id: PAPER_RESEARCH_PERSISTED_LEDGER_ID,
    version: input.version,
    updatedAt: persistedAt,
    deletedAt: null,
    payload: payload as unknown as Record<string, unknown>,
  };
}

function resultShape(
  recordVersion: number,
  counts: Readonly<{
    uploaded: number;
    downloaded: number;
    unchanged: number;
    conflicts: number;
    failed: number;
  }>,
): PaperResearchPersistentLedgerResult {
  const persistentLedgerIntegrated = counts.failed === 0
    && counts.conflicts === 0
    && counts.downloaded === 0
    && counts.uploaded + counts.unchanged === 1;
  return Object.freeze({
    ok: persistentLedgerIntegrated,
    persistentLedgerIntegrated,
    recordId: PAPER_RESEARCH_PERSISTED_LEDGER_ID,
    recordVersion,
    ...counts,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  });
}

export async function persistPaperResearchCurrencyLedger(
  repository: PaperJournalRepository,
  userId: string,
  ledger: PaperResearchCurrencyLedger,
  input: Readonly<{
    version: number;
    idempotencyKey: string;
    clientTime: string;
  }>,
  now = new Date(),
): Promise<PaperResearchPersistentLedgerResult> {
  const record = buildPaperResearchLedgerSyncRecord(ledger, {
    version: input.version,
    updatedAt: input.clientTime,
  });
  const result = await syncPaperJournal(repository, userId, {
    idempotencyKey: input.idempotencyKey,
    clientTime: input.clientTime,
    records: [record],
  }, now);

  return resultShape(input.version, {
    uploaded: result.uploaded.length,
    downloaded: result.downloaded.length,
    unchanged: result.unchanged.length,
    conflicts: result.conflicts.length,
    failed: result.failed.length,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePersistedPayload(record: StoredPaperJournalRecord): PaperResearchPersistedLedgerPayload {
  if (record.kind !== 'account' || record.id !== PAPER_RESEARCH_PERSISTED_LEDGER_ID) {
    throw new Error('PAPER_LEDGER_RECORD_IDENTITY_INVALID');
  }
  if (!isObject(record.payload)) throw new Error('PAPER_LEDGER_PAYLOAD_INVALID');
  const payload = record.payload as Record<string, unknown>;
  if (payload.schemaVersion !== PAPER_RESEARCH_PERSISTED_LEDGER_SCHEMA) {
    throw new Error('PAPER_LEDGER_PERSISTED_SCHEMA_UNSUPPORTED');
  }
  if (payload.adapterVersion !== 'v1' || !validIsoTimestamp(payload.persistedAt)) {
    throw new Error('PAPER_LEDGER_PERSISTED_METADATA_INVALID');
  }
  if (!isObject(payload.ledger)) throw new Error('PAPER_LEDGER_PERSISTED_BODY_INVALID');
  const ledger = payload.ledger as unknown as PaperResearchCurrencyLedger;
  assertPersistableLedger(ledger);
  if (
    payload.simulatedOnly !== true
    || payload.liveOrderAllowed !== false
    || payload.privateTradingApiAllowed !== false
    || payload.orderSubmitted !== false
    || payload.exchangeRequestSent !== false
    || payload.profitabilityClaimAllowed !== false
  ) {
    throw new Error('PAPER_LEDGER_PERSISTED_SAFETY_VIOLATION');
  }
  return payload as unknown as PaperResearchPersistedLedgerPayload;
}

export async function loadPaperResearchCurrencyLedger(
  repository: PaperJournalRepository,
  userId: string,
): Promise<Readonly<{
  found: boolean;
  recordVersion: number | null;
  payload: PaperResearchPersistedLedgerPayload | null;
  persistentLedgerIntegrated: boolean;
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  profitabilityClaimAllowed: false;
}>> {
  const record = await repository.getRecord(userId, 'account', PAPER_RESEARCH_PERSISTED_LEDGER_ID);
  if (!record || record.deletedAt != null) {
    return Object.freeze({
      found: false,
      recordVersion: null,
      payload: null,
      persistentLedgerIntegrated: false,
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
      profitabilityClaimAllowed: false,
    });
  }
  const payload = parsePersistedPayload(record);
  return Object.freeze({
    found: true,
    recordVersion: record.version,
    payload,
    persistentLedgerIntegrated: true,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  });
}
