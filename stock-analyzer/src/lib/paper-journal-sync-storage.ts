import type { PaperTradingState, StorageLike } from './paper-trading';
import { PAPER_STORAGE_KEY } from './paper-trading-storage';
import type {
  ConflictResolutionResult,
  JournalConflict,
  JournalRecordKind,
  JournalSnapshotResult,
  JournalSyncRecord,
  JournalSyncResult,
  StoredJournalSyncRecord,
} from './paper-journal-sync';

export const JOURNAL_SYNC_STORAGE_SCHEMA_VERSION = 2;
export const JOURNAL_SYNC_STORAGE_PREFIX = 'seungjae.paper-trading.v2';
export const JOURNAL_SYNC_METADATA_PREFIX = 'seungjae.paper-journal-sync.v2';
export const LEGACY_OWNER_KEY = 'seungjae.paper-trading.v1.owner';
export const JOURNAL_SYNC_LIMITS = Object.freeze({ metadataRecords: 2_700, conflicts: 200 });

export type SyncMetadataRecord = {
  kind: JournalRecordKind;
  id: string;
  version: number;
  hash: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type JournalSyncMetadata = {
  schemaVersion: 2;
  ownerNamespace: string;
  migratedFromV1: boolean;
  migrationBackupKey: string | null;
  status: 'local-only'|'pending'|'syncing'|'completed'|'offline'|'conflict'|'failed';
  lastSyncAt: string | null;
  uploadedCount: number;
  downloadedCount: number;
  failedCount: number;
  records: Record<string, SyncMetadataRecord>;
  conflicts: JournalConflict[];
  warning: string;
};

const forbiddenKey = /(?:api.?key|secret|authorization|bearer|access.?token|refresh.?token|private.?key)/i;

function containsForbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => forbiddenKey.test(key) || containsForbidden(item));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function paperOwnerNamespace(userId: string) {
  if (!userId.trim()) throw new Error('사용자 ID가 필요합니다.');
  return `u_${fnv1a(userId.trim())}`;
}

export function namespacedPaperStorageKey(userId: string) {
  return `${JOURNAL_SYNC_STORAGE_PREFIX}:${paperOwnerNamespace(userId)}`;
}

export function syncMetadataStorageKey(userId: string) {
  return `${JOURNAL_SYNC_METADATA_PREFIX}:${paperOwnerNamespace(userId)}`;
}

function createMetadata(userId: string): JournalSyncMetadata {
  return {
    schemaVersion: 2,
    ownerNamespace: paperOwnerNamespace(userId),
    migratedFromV1: false,
    migrationBackupKey: null,
    status: 'local-only',
    lastSyncAt: null,
    uploadedCount: 0,
    downloadedCount: 0,
    failedCount: 0,
    records: {},
    conflicts: [],
    warning: '',
  };
}

function migrateLegacyIfEligible(storage: StorageLike, userId: string, now: Date) {
  const namespace = paperOwnerNamespace(userId);
  const targetKey = namespacedPaperStorageKey(userId);
  const existing = storage.getItem(targetKey);
  if (existing) return { value: existing, migrated: false, backupKey: null as string | null };
  const legacy = storage.getItem(PAPER_STORAGE_KEY);
  if (!legacy) return { value: null, migrated: false, backupKey: null as string | null };
  const claimedBy = storage.getItem(LEGACY_OWNER_KEY);
  if (claimedBy && claimedBy !== namespace) return { value: null, migrated: false, backupKey: null as string | null };
  const backupKey = `${PAPER_STORAGE_KEY}.backup:${namespace}:${now.toISOString().replace(/[:.]/g, '-')}`;
  storage.setItem(backupKey, legacy);
  storage.setItem(targetKey, legacy);
  storage.setItem(LEGACY_OWNER_KEY, namespace);
  return { value: legacy, migrated: true, backupKey };
}

export function createUserPaperStorage(storage: StorageLike, userId: string, now = new Date()): StorageLike {
  const targetKey = namespacedPaperStorageKey(userId);
  return {
    getItem(key) {
      if (key !== PAPER_STORAGE_KEY) return storage.getItem(key);
      return migrateLegacyIfEligible(storage, userId, now).value;
    },
    setItem(key, value) {
      storage.setItem(key === PAPER_STORAGE_KEY ? targetKey : key, value);
    },
    removeItem(key) {
      storage.removeItem(key === PAPER_STORAGE_KEY ? targetKey : key);
    },
  };
}

export function loadJournalSyncMetadata(storage: StorageLike, userId: string, now = new Date()) {
  const key = syncMetadataStorageKey(userId);
  const fresh = createMetadata(userId);
  const migrated = migrateLegacyIfEligible(storage, userId, now);
  const raw = storage.getItem(key);
  if (!raw) {
    fresh.migratedFromV1 = migrated.migrated;
    fresh.migrationBackupKey = migrated.backupKey;
    saveJournalSyncMetadata(storage, userId, fresh);
    return { metadata: fresh, recovered: false };
  }
  try {
    const parsed = JSON.parse(raw) as JournalSyncMetadata;
    if (parsed.schemaVersion !== 2 || parsed.ownerNamespace !== fresh.ownerNamespace || containsForbidden(parsed)) throw new Error('invalid');
    return { metadata: repairMetadata(parsed), recovered: false };
  } catch {
    const backupKey = `${key}.corrupt:${now.toISOString().replace(/[:.]/g, '-')}`;
    storage.setItem(backupKey, raw);
    storage.removeItem(key);
    fresh.warning = '손상된 동기화 메타데이터를 백업하고 새 상태로 복구했습니다.';
    saveJournalSyncMetadata(storage, userId, fresh);
    return { metadata: fresh, recovered: true };
  }
}

function repairMetadata(metadata: JournalSyncMetadata): JournalSyncMetadata {
  const entries = Object.entries(metadata.records ?? {}).slice(-JOURNAL_SYNC_LIMITS.metadataRecords);
  return {
    ...metadata,
    schemaVersion: 2,
    records: Object.fromEntries(entries),
    conflicts: (metadata.conflicts ?? []).slice(-JOURNAL_SYNC_LIMITS.conflicts),
    warning: String(metadata.warning ?? '').slice(0, 500),
  };
}

export function saveJournalSyncMetadata(storage: StorageLike, userId: string, metadata: JournalSyncMetadata) {
  if (metadata.ownerNamespace !== paperOwnerNamespace(userId) || containsForbidden(metadata)) {
    throw new Error('동기화 메타데이터에 잘못된 사용자 범위 또는 Secret 유사 필드가 있습니다.');
  }
  const repaired = repairMetadata(metadata);
  storage.setItem(syncMetadataStorageKey(userId), JSON.stringify(repaired));
  return repaired;
}

function currentPayloads(state: PaperTradingState) {
  const ordersById = new Map(state.orders.map((order) => [order.id, order]));
  return [
    { kind: 'account' as const, id: state.account.id, payload: state.account as unknown as Record<string, unknown> },
    ...state.orders.map((payload) => ({ kind: 'order' as const, id: payload.id, payload: payload as unknown as Record<string, unknown> })),
    ...state.positions.map((payload) => ({ kind: 'position' as const, id: payload.id, payload: payload as unknown as Record<string, unknown> })),
    ...state.fills.map((payload) => ({ kind: 'fill' as const, id: payload.id, payload: payload as unknown as Record<string, unknown> })),
    ...state.journal.map((payload) => {
      const order = ordersById.get(payload.orderId);
      return {
        kind: 'journal' as const,
        id: payload.id,
        payload: {
          ...(payload as unknown as Record<string, unknown>),
          riskPercent: order?.riskResult?.actualRiskPercent ?? null,
        },
      };
    }),
  ];
}

function recordKey(kind: JournalRecordKind, id: string) {
  return `${kind}:${id}`;
}

export function prepareJournalSync(
  storage: StorageLike,
  userId: string,
  state: PaperTradingState,
  now = new Date(),
) {
  const loaded = loadJournalSyncMetadata(storage, userId, now);
  const metadata = structuredClone(loaded.metadata);
  const at = now.toISOString();
  const records: JournalSyncRecord[] = [];
  const currentKeys = new Set<string>();

  for (const item of currentPayloads(state)) {
    if (containsForbidden(item.payload)) throw new Error('로컬 기록에 Secret 유사 필드가 있어 동기화하지 않았습니다.');
    const key = recordKey(item.kind, item.id);
    currentKeys.add(key);
    const hash = fnv1a(stable(item.payload));
    const previous = metadata.records[key];
    const changed = !previous || previous.hash !== hash || previous.deletedAt != null;
    const next: SyncMetadataRecord = {
      kind: item.kind,
      id: item.id,
      version: previous ? previous.version + (changed ? 1 : 0) : 1,
      hash,
      updatedAt: changed ? at : previous.updatedAt,
      deletedAt: null,
    };
    metadata.records[key] = next;
    records.push({ kind: item.kind, id: item.id, version: next.version, updatedAt: next.updatedAt, deletedAt: null, payload: structuredClone(item.payload) });
  }

  for (const [key, previous] of Object.entries(metadata.records)) {
    if (currentKeys.has(key)) continue;
    const next = previous.deletedAt
      ? previous
      : { ...previous, version: previous.version + 1, hash: fnv1a('{}'), updatedAt: at, deletedAt: at };
    metadata.records[key] = next;
    records.push({ kind: next.kind, id: next.id, version: next.version, updatedAt: next.updatedAt, deletedAt: next.deletedAt, payload: {} });
  }

  metadata.status = 'pending';
  saveJournalSyncMetadata(storage, userId, metadata);
  return { records, metadata };
}

function replaceById<T extends { id: string }>(items: T[], id: string, payload: Record<string, unknown>, deleted: boolean) {
  const without = items.filter((item) => item.id !== id);
  if (deleted) return without;
  return [...without, payload as unknown as T];
}

export function applyServerRecords(state: PaperTradingState, records: readonly StoredJournalSyncRecord[]) {
  let next = structuredClone(state);
  for (const record of records) {
    const deleted = record.deletedAt != null;
    if (record.kind === 'account') {
      if (!deleted && record.payload.id === record.id) next.account = record.payload as unknown as PaperTradingState['account'];
    } else if (record.kind === 'order') next.orders = replaceById(next.orders, record.id, record.payload, deleted);
    else if (record.kind === 'position') next.positions = replaceById(next.positions, record.id, record.payload, deleted);
    else if (record.kind === 'fill') next.fills = replaceById(next.fills, record.id, record.payload, deleted);
    else next.journal = replaceById(next.journal, record.id, record.payload, deleted);
  }
  next.updatedAt = records.at(-1)?.serverUpdatedAt ?? next.updatedAt;
  return next;
}

function updateMetadataRecords(metadata: JournalSyncMetadata, records: readonly StoredJournalSyncRecord[]) {
  for (const record of records) {
    metadata.records[recordKey(record.kind, record.id)] = {
      kind: record.kind,
      id: record.id,
      version: record.version,
      hash: fnv1a(stable(record.payload)),
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
    };
  }
}

export function applyJournalSyncResult(
  storage: StorageLike,
  userId: string,
  state: PaperTradingState,
  result: JournalSyncResult,
) {
  const loaded = loadJournalSyncMetadata(storage, userId);
  const metadata = structuredClone(loaded.metadata);
  const applied = [...result.uploaded, ...result.downloaded];
  updateMetadataRecords(metadata, applied);
  metadata.lastSyncAt = result.serverTime;
  metadata.uploadedCount = result.uploaded.length;
  metadata.downloadedCount = result.downloaded.length;
  metadata.failedCount = result.failed.length;
  metadata.conflicts = result.conflicts;
  metadata.warning = result.warnings.join(' ');
  metadata.status = result.conflicts.length ? 'conflict' : result.failed.length ? 'failed' : 'completed';
  saveJournalSyncMetadata(storage, userId, metadata);
  return { state: applyServerRecords(state, applied), metadata };
}

export function applyJournalSnapshot(
  storage: StorageLike,
  userId: string,
  state: PaperTradingState,
  snapshot: JournalSnapshotResult,
) {
  const loaded = loadJournalSyncMetadata(storage, userId);
  const metadata = structuredClone(loaded.metadata);
  updateMetadataRecords(metadata, snapshot.records);
  metadata.lastSyncAt = snapshot.serverTime;
  metadata.downloadedCount += snapshot.records.length;
  metadata.status = metadata.conflicts.length ? 'conflict' : metadata.failedCount ? 'failed' : 'completed';
  saveJournalSyncMetadata(storage, userId, metadata);
  return { state: applyServerRecords(state, snapshot.records), metadata };
}

export function applyConflictResolution(
  storage: StorageLike,
  userId: string,
  state: PaperTradingState,
  result: ConflictResolutionResult,
) {
  const loaded = loadJournalSyncMetadata(storage, userId);
  const metadata = structuredClone(loaded.metadata);
  updateMetadataRecords(metadata, result.records);
  metadata.conflicts = metadata.conflicts.filter((conflict) => conflict.id !== result.conflictId);
  metadata.status = metadata.conflicts.length ? 'conflict' : metadata.failedCount ? 'failed' : 'completed';
  metadata.lastSyncAt = result.serverTime;
  saveJournalSyncMetadata(storage, userId, metadata);
  return { state: applyServerRecords(state, result.records), metadata };
}

export function markJournalSyncOffline(storage: StorageLike, userId: string, message = '오프라인 상태입니다. 로컬 기록은 유지됩니다.') {
  const metadata = structuredClone(loadJournalSyncMetadata(storage, userId).metadata);
  metadata.status = 'offline';
  metadata.warning = message;
  return saveJournalSyncMetadata(storage, userId, metadata);
}

export function markJournalSyncFailed(storage: StorageLike, userId: string, message = '동기화에 실패했습니다. 로컬 기록은 유지됩니다.') {
  const metadata = structuredClone(loadJournalSyncMetadata(storage, userId).metadata);
  metadata.status = 'failed';
  metadata.failedCount = Math.max(1, metadata.failedCount);
  metadata.warning = message.slice(0, 500);
  return saveJournalSyncMetadata(storage, userId, metadata);
}

export function clearUserJournalNamespace(storage: StorageLike, userId: string) {
  storage.removeItem(namespacedPaperStorageKey(userId));
  storage.removeItem(syncMetadataStorageKey(userId));
}
