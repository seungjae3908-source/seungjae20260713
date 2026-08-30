import type { PaperTradingState, StorageLike } from './paper-trading';
import { validPaperRecord, validPaperState, validPaperTimestamp } from '../../../packages/api-zod/src/paper-state-evidence.js';
import {
  PAPER_ARCHIVE_KEY,
  PAPER_STORAGE_KEY,
  loadPaperArchive,
} from './paper-trading-storage';
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
export const JOURNAL_SYNC_STORAGE_PREFIX = 'seungjae.paper-trading.v3';
export const JOURNAL_ARCHIVE_STORAGE_PREFIX = 'seungjae.paper-journal-archive.v2';
export const JOURNAL_SYNC_METADATA_PREFIX = 'seungjae.paper-journal-sync.v3';
export const LEGACY_OWNER_KEY = 'seungjae.paper-trading.v1.owner';
// Warning thresholds only. Phase 8 does not silently trim records or conflicts.
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
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(userId)) throw new Error('유효한 사용자 ID가 필요합니다.');
  // Exact, reversible encoding of the opaque auth ID, not a privacy/security hash.
  // Unlike the old 32-bit hash, two different IDs cannot share a storage key.
  return `u3_${btoa(userId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export function namespacedPaperStorageKey(userId: string) {
  return `${JOURNAL_SYNC_STORAGE_PREFIX}:${paperOwnerNamespace(userId)}`;
}

export function namespacedPaperArchiveKey(userId: string) {
  return `${JOURNAL_ARCHIVE_STORAGE_PREFIX}:${paperOwnerNamespace(userId)}`;
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

export function legacyPaperStorageWarning(storage: StorageLike, userId: string) {
  const oldNamespace = `u_${fnv1a(userId)}`;
  const legacyKeys = [PAPER_STORAGE_KEY, `seungjae.paper-trading.v2:${oldNamespace}`, `seungjae.paper-journal-archive.v1:${oldNamespace}`];
  try {
    return legacyKeys.some((key) => storage.getItem(key) !== null)
      ? '소유자를 검증할 수 없는 이전 모의거래 기록은 원본 그대로 보존하며 자동으로 가져오지 않습니다. 현재 계정의 서버 동기화 또는 소유자가 확인한 JSON 가져오기를 사용하세요.' : '';
  } catch { return '브라우저 저장소를 읽지 못했습니다. 이전 기록을 복구하거나 자동 이전하지 않았습니다.'; }
}

export function createUserPaperStorage(storage: StorageLike, userId: string, _now?: Date): StorageLike {
  const stateKey = namespacedPaperStorageKey(userId);
  const archiveKey = namespacedPaperArchiveKey(userId);
  const remap = (key: string) => key.startsWith(PAPER_STORAGE_KEY) ? stateKey + key.slice(PAPER_STORAGE_KEY.length)
    : key.startsWith(PAPER_ARCHIVE_KEY) ? archiveKey + key.slice(PAPER_ARCHIVE_KEY.length)
      : `${stateKey}:aux:${encodeURIComponent(key)}`;
  return {
    getItem(key) {
      return storage.getItem(remap(key));
    },
    setItem(key, value) { storage.setItem(remap(key), value); },
    removeItem(key) { storage.removeItem(remap(key)); },
  };
}

export function loadJournalSyncMetadata(storage: StorageLike, userId: string, now = new Date()) {
  const key = syncMetadataStorageKey(userId);
  const fresh = createMetadata(userId);
  let raw: string | null;
  try { raw = storage.getItem(key); }
  catch { fresh.status = 'failed'; fresh.warning = '동기화 저장소를 읽지 못했습니다. 기존 기록을 변경하지 않았습니다.'; return { metadata: fresh, recovered: false }; }
  if (raw === null) {
    fresh.warning = legacyPaperStorageWarning(storage, userId);
    try { saveJournalSyncMetadata(storage, userId, fresh); }
    catch { fresh.status = 'failed'; fresh.warning = '동기화 상태를 저장하지 못했습니다. 기록을 동기화 완료로 간주하지 않습니다.'; }
    return { metadata: fresh, recovered: false };
  }
  try {
    const parsed = JSON.parse(raw) as JournalSyncMetadata;
    assertMetadata(parsed, userId);
    return { metadata: repairMetadata(parsed), recovered: false };
  } catch {
    const backupKey = `${key}.corrupt:${now.toISOString().replace(/[:.]/g, '-')}`;
    fresh.warning = '손상된 동기화 메타데이터를 백업하고 새 상태로 복구했습니다.';
    fresh.status = 'failed';
    try { storage.setItem(backupKey, raw); saveJournalSyncMetadata(storage, userId, fresh); }
    catch { fresh.warning = '동기화 메타데이터를 검증하거나 저장하지 못했습니다. 원본을 삭제하지 않았습니다.'; return { metadata: fresh, recovered: false }; }
    return { metadata: fresh, recovered: true };
  }
}

function repairMetadata(metadata: JournalSyncMetadata): JournalSyncMetadata {
  const records = metadata.records && typeof metadata.records === 'object' && !Array.isArray(metadata.records)
    ? metadata.records
    : {};
  const conflicts = Array.isArray(metadata.conflicts) ? metadata.conflicts : [];
  const warnings: string[] = [];
  if (Object.keys(records).length > JOURNAL_SYNC_LIMITS.metadataRecords) warnings.push('동기화 메타데이터가 장기 보존 기준을 넘었습니다. 자동 삭제하지 않았습니다.');
  if (conflicts.length > JOURNAL_SYNC_LIMITS.conflicts) warnings.push('미해결 충돌이 많습니다. 충돌을 자동 폐기하지 않았습니다.');
  return {
    ...metadata,
    schemaVersion: 2,
    records,
    conflicts,
    warning: [String(metadata.warning ?? '').slice(0, 500), ...warnings].filter(Boolean).join(' ').slice(0, 1_000),
  };
}

export function saveJournalSyncMetadata(storage: StorageLike, userId: string, metadata: JournalSyncMetadata) {
  assertMetadata(metadata, userId);
  const repaired = repairMetadata(metadata);
  storage.setItem(syncMetadataStorageKey(userId), JSON.stringify(repaired));
  return repaired;
}

function currentPayloads(state: PaperTradingState, archivedJournal: PaperTradingState['journal']) {
  const ordersById = new Map(state.orders.map((order) => [order.id, order]));
  const journalById = new Map([...archivedJournal, ...state.journal].map((entry) => [entry.id, entry]));
  return [
    { kind: 'account' as const, id: state.account.id, payload: state.account as unknown as Record<string, unknown> },
    ...state.orders.map((payload) => ({ kind: 'order' as const, id: payload.id, payload: payload as unknown as Record<string, unknown> })),
    ...state.positions.map((payload) => ({ kind: 'position' as const, id: payload.id, payload: payload as unknown as Record<string, unknown> })),
    ...state.fills.map((payload) => ({ kind: 'fill' as const, id: payload.id, payload: payload as unknown as Record<string, unknown> })),
    ...[...journalById.values()].map((payload) => {
      const order = ordersById.get(payload.orderId);
      return {
        kind: 'journal' as const,
        id: payload.id,
        payload: {
          ...(payload as unknown as Record<string, unknown>),
          riskPercent: order?.riskResult?.actualRiskPercent ?? (payload as unknown as Record<string, unknown>).riskPercent ?? null,
        },
      };
    }),
  ];
}

function recordKey(kind: JournalRecordKind, id: string) {
  return `${kind}:${id}`;
}

export function prepareJournalSync(storage: StorageLike, userId: string, state: PaperTradingState, now = new Date()) {
  if (!validPaperState(state, now.getTime())) throw new Error('로컬 원장을 검증하지 못해 동기화하지 않았습니다.');
  const loaded = loadJournalSyncMetadata(storage, userId, now);
  const metadata = structuredClone(loaded.metadata);
  const at = now.toISOString();
  const records: JournalSyncRecord[] = [];
  const currentKeys = new Set<string>();
  const userStorage = createUserPaperStorage(storage, userId, now);
  const archive = loadPaperArchive(userStorage);
  if (archive.blocked) throw new Error(archive.warning);

  for (const item of currentPayloads(state, archive.journal)) {
    if (containsForbidden(item.payload)) throw new Error('로컬 기록에 Secret 유사 필드가 있어 동기화하지 않았습니다.');
    const key = recordKey(item.kind, item.id);
    currentKeys.add(key);
    const hash = stable(item.payload);
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
    const next = previous.deletedAt ? previous : { ...previous, version: previous.version + 1, hash: '{}', updatedAt: at, deletedAt: at };
    metadata.records[key] = next;
    records.push({ kind: next.kind, id: next.id, version: next.version, updatedAt: next.updatedAt, deletedAt: next.deletedAt, payload: {} });
  }

  metadata.status = 'pending';
  if (archive.journal.length) {
    metadata.warning = `활성 거래일지 500개를 넘은 과거 기록 ${archive.journal.length}건을 사용자별 archive에 보존하고 동기화 대상에 포함했습니다.`;
  }
  saveJournalSyncMetadata(storage, userId, metadata);
  return { records, metadata, archiveCount: archive.journal.length };
}

function replaceById<T extends { id: string }>(items: T[], id: string, payload: Record<string, unknown>, deleted: boolean) {
  const without = items.filter((item) => item.id !== id);
  if (deleted) return without;
  return [...without, payload as unknown as T];
}

function assertServerRecords(records: readonly StoredJournalSyncRecord[]) {
  if (!Array.isArray(records) || records.length > 10000) throw new Error('서버 원장 목록이 올바르지 않습니다.');
  const latest = Date.now();
  const seen = new Map<string, string>();
  for (const row of records) {
    if (!row || !['account', 'order', 'position', 'fill', 'journal'].includes(row.kind)
      || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 500
      || !Number.isSafeInteger(row.version) || row.version < 1 || containsForbidden(row)
      || !validPaperTimestamp(row.updatedAt, latest) || !validPaperTimestamp(row.createdAt, latest)
      || !validPaperTimestamp(row.serverUpdatedAt, latest) || Date.parse(row.createdAt) > Date.parse(row.serverUpdatedAt)
      || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)
      || (row.deletedAt === null ? row.payload.id !== row.id || !validPaperRecord(row.kind, row.payload, latest)
        : !validPaperTimestamp(row.deletedAt, latest) || Object.keys(row.payload).length !== 0)) {
      throw new Error('서버 원장의 식별자·시각·수치 근거를 검증하지 못했습니다.');
    }
    const key = recordKey(row.kind, row.id);
    const canonical = stable(row);
    if (seen.has(key) && seen.get(key) !== canonical) throw new Error('서버 원장에 서로 다른 중복 기록이 있습니다.');
    seen.set(key, canonical);
  }
}

function assertSyncResponse(value: JournalSyncResult | JournalSnapshotResult | ConflictResolutionResult) {
  if (!value || value.ok !== true || value.mode !== 'journal-sync-only' || value.orderSubmitted !== false
    || value.exchangeRequestSent !== false || !validPaperTimestamp(value.serverTime, Date.now())) {
    throw new Error('거래일지 동기화 안전 계약 또는 서버 시각을 확인하지 못했습니다.');
  }
}

function assertConflicts(conflicts: readonly JournalConflict[]) {
  if (!Array.isArray(conflicts)) throw new Error('동기화 충돌 목록을 확인하지 못했습니다.');
  for (const conflict of conflicts) {
    if (!conflict || typeof conflict.id !== 'string' || !conflict.id || typeof conflict.recordId !== 'string'
      || !Number.isSafeInteger(conflict.version) || conflict.version < 1 || !['open', 'resolved'].includes(conflict.status)
      || !validPaperTimestamp(conflict.createdAt, Date.now()) || !Array.isArray(conflict.differenceSummary)
      || !conflict.differenceSummary.every((line: unknown) => typeof line === 'string')
      || conflict.serverRecord?.id !== conflict.recordId || conflict.serverRecord?.kind !== conflict.kind
      || conflict.deviceRecord?.id !== conflict.recordId || conflict.deviceRecord?.kind !== conflict.kind) throw new Error('동기화 충돌 기록을 확인하지 못했습니다.');
    assertServerRecords([conflict.serverRecord]);
    const device = conflict.deviceRecord;
    if (!Number.isSafeInteger(device.version) || device.version < 1 || !validPaperTimestamp(device.updatedAt, Date.now())
      || (device.deletedAt === null ? device.payload?.id !== device.id || !validPaperRecord(device.kind, device.payload, Date.now())
        : !validPaperTimestamp(device.deletedAt, Date.now()) || !device.payload || Object.keys(device.payload).length !== 0)) throw new Error('기기 충돌 기록을 검증하지 못했습니다.');
  }
}

function assertMetadata(metadata: JournalSyncMetadata, userId: string) {
  if (!metadata || metadata.schemaVersion !== 2 || metadata.ownerNamespace !== paperOwnerNamespace(userId) || containsForbidden(metadata)
    || !['local-only', 'pending', 'syncing', 'completed', 'offline', 'conflict', 'failed'].includes(metadata.status)
    || ![metadata.uploadedCount, metadata.downloadedCount, metadata.failedCount].every((value) => Number.isSafeInteger(value) && value >= 0)
    || (metadata.lastSyncAt !== null && !validPaperTimestamp(metadata.lastSyncAt, Date.now()))
    || !metadata.records || typeof metadata.records !== 'object' || Array.isArray(metadata.records)) {
    throw new Error('동기화 메타데이터의 사용자 범위·수치·시각 또는 Secret 유사 필드를 확인하세요.');
  }
  assertConflicts(metadata.conflicts);
  for (const [key, row] of Object.entries(metadata.records)) {
    if (!row || !['account', 'order', 'position', 'fill', 'journal'].includes(row.kind) || typeof row.id !== 'string'
      || key !== recordKey(row.kind, row.id) || typeof row.hash !== 'string' || !Number.isSafeInteger(row.version) || row.version < 1
      || !validPaperTimestamp(row.updatedAt, Date.now()) || (row.deletedAt !== null && !validPaperTimestamp(row.deletedAt, Date.now()))) throw new Error('동기화 버전 기록을 확인하지 못했습니다.');
  }
}

export function applyServerRecords(state: PaperTradingState, records: readonly StoredJournalSyncRecord[]) {
  if (!validPaperState(state, Date.now())) throw new Error('로컬 원장을 검증하지 못했습니다.');
  assertServerRecords(records);
  let next = structuredClone(state);
  for (const record of records) {
    const deleted = record.deletedAt != null;
    if (record.kind === 'account') {
      if (record.id !== state.account.id || deleted) throw new Error('다른 모의계좌 또는 삭제된 계좌를 현재 원장에 합칠 수 없습니다.');
      next.account = record.payload as unknown as PaperTradingState['account'];
    } else if (record.kind === 'order') next.orders = replaceById(next.orders, record.id, record.payload, deleted);
    else if (record.kind === 'position') next.positions = replaceById(next.positions, record.id, record.payload, deleted);
    else if (record.kind === 'fill') next.fills = replaceById(next.fills, record.id, record.payload, deleted);
    else next.journal = replaceById(next.journal, record.id, record.payload, deleted);
  }
  next.updatedAt = records.reduce((at, row) => Date.parse(row.serverUpdatedAt) > Date.parse(at) ? row.serverUpdatedAt : at, next.updatedAt);
  if (!validPaperState(next, Date.now())) throw new Error('동기화 후 원장 검증에 실패했습니다. 기존 원본을 유지합니다.');
  return next;
}

function updateMetadataRecords(metadata: JournalSyncMetadata, records: readonly StoredJournalSyncRecord[]) {
  for (const record of records) {
    const previous = metadata.records[recordKey(record.kind, record.id)];
    if (previous && (record.version < previous.version || record.version === previous.version &&
      (previous.hash !== stable(record.payload) || previous.deletedAt !== record.deletedAt))) throw new Error('오래되거나 충돌한 서버 버전으로 로컬 기록을 덮어쓸 수 없습니다.');
    metadata.records[recordKey(record.kind, record.id)] = {
      kind: record.kind,
      id: record.id,
      version: record.version,
      hash: stable(record.payload),
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
    };
  }
}

export function applyJournalSyncResult(storage: StorageLike, userId: string, state: PaperTradingState, result: JournalSyncResult) {
  assertSyncResponse(result);
  if (!Array.isArray(result.uploaded) || !Array.isArray(result.downloaded) || !Array.isArray(result.failed)
    || !Array.isArray(result.conflicts) || !Array.isArray(result.warnings) || !result.warnings.every((warning) => typeof warning === 'string')) {
    throw new Error('거래일지 동기화 결과 목록을 확인하지 못했습니다.');
  }
  assertConflicts(result.conflicts);
  const applied = [...result.uploaded, ...result.downloaded];
  const next = applyServerRecords(state, applied);
  const metadata = structuredClone(loadJournalSyncMetadata(storage, userId).metadata);
  updateMetadataRecords(metadata, applied);
  metadata.lastSyncAt = result.serverTime;
  metadata.uploadedCount += result.uploaded.length;
  metadata.downloadedCount += result.downloaded.length;
  metadata.failedCount = result.failed.length;
  metadata.conflicts = [...metadata.conflicts.filter((existing) => !result.conflicts.some((next) => next.id === existing.id)), ...result.conflicts];
  metadata.warning = result.warnings.join(' ');
  metadata.status = metadata.conflicts.length ? 'conflict' : result.failed.length ? 'failed' : 'completed';
  return { state: next, metadata };
}

export function applyJournalSnapshot(storage: StorageLike, userId: string, state: PaperTradingState, snapshot: JournalSnapshotResult, priorMetadata?: JournalSyncMetadata) {
  assertSyncResponse(snapshot);
  if (snapshot.scope !== undefined && snapshot.scope !== 'manual-paper-trading'
    || snapshot.excludedNamespaces !== undefined && (!Array.isArray(snapshot.excludedNamespaces)
      || snapshot.scope !== 'manual-paper-trading' || snapshot.excludedNamespaces.length > 3
      || snapshot.excludedNamespaces.some((item) => !item || !['currency-research', 'signal-performance', 'broker-execution'].includes(item.namespace)
        || !Number.isSafeInteger(item.count) || item.count < 1))) throw new Error('서버 원장의 복원 범위를 확인하지 못했습니다.');
  if (snapshot.nextCursor !== null && (typeof snapshot.nextCursor !== 'string' || !snapshot.nextCursor || snapshot.nextCursor.length > 2000)) throw new Error('거래일지 페이지 커서를 확인하지 못했습니다.');
  const next = applyServerRecords(state, snapshot.records);
  const metadata = structuredClone(priorMetadata ?? loadJournalSyncMetadata(storage, userId).metadata);
  assertMetadata(metadata, userId);
  updateMetadataRecords(metadata, snapshot.records);
  metadata.lastSyncAt = snapshot.serverTime;
  metadata.downloadedCount += snapshot.records.length;
  if (snapshot.excludedNamespaces?.length) metadata.warning = '일반 모의거래 원장만 동기화했습니다. 연구 성과·다중 통화·브로커 기록은 별도 원장에 보존되며 합산하지 않습니다.';
  metadata.status = metadata.conflicts.length ? 'conflict' : metadata.failedCount ? 'failed' : 'completed';
  return { state: next, metadata };
}

export function applyConflictResolution(storage: StorageLike, userId: string, state: PaperTradingState, result: ConflictResolutionResult) {
  assertSyncResponse(result);
  const next = applyServerRecords(state, result.records);
  const metadata = structuredClone(loadJournalSyncMetadata(storage, userId).metadata);
  updateMetadataRecords(metadata, result.records);
  metadata.conflicts = metadata.conflicts.filter((conflict) => conflict.id !== result.conflictId);
  metadata.status = metadata.conflicts.length ? 'conflict' : metadata.failedCount ? 'failed' : 'completed';
  metadata.lastSyncAt = result.serverTime;
  return { state: next, metadata };
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
  storage.removeItem(namespacedPaperArchiveKey(userId));
  storage.removeItem(syncMetadataStorageKey(userId));
}
