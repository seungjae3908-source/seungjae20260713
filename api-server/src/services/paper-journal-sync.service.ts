import { createHash } from 'node:crypto';
import {
  CLOCK_SKEW_WARNING_MS,
  DELETE_ALL_CONFIRMATION,
  JOURNAL_SYNC_MODE,
  MAX_SNAPSHOT_PAGE_SIZE,
  MAX_SYNC_RECORDS,
  PAPER_JOURNAL_RECORD_KINDS,
  PaperJournalError,
  type ConflictResolutionChoice,
  type ConflictResolutionResult,
  type PaperJournalConflict,
  type PaperJournalRecordKind,
  type PaperJournalRepository,
  type PaperJournalSnapshotResult,
  type PaperJournalSyncRecord,
  type PaperJournalSyncRequest,
  type PaperJournalSyncResult,
  type StoredPaperJournalRecord,
} from './paper-journal.types';

const forbiddenKey = /(?:api.?key|secret|authorization|bearer|access.?token|refresh.?token|private.?key)/i;
const userIdentityKey = /^(?:user_?id|userid)$/i;
const unsafeObjectKey = /^(?:__proto__|prototype|constructor)$/i;
const idPattern = /^[A-Za-z0-9._:-]{1,160}$/;
const idempotencyPattern = /^[A-Za-z0-9._:-]{8,160}$/;
const inFlightSync = new Map<string, Promise<PaperJournalSyncResult>>();

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function scanForbidden(value: unknown, path = 'payload'): { path: string; code: string } | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = scanForbidden(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (unsafeObjectKey.test(key)) return { path: `${path}.${key}`, code: 'UNSAFE_PAYLOAD_KEY' };
    if (forbiddenKey.test(key)) return { path: `${path}.${key}`, code: 'SECRET_FIELD_FORBIDDEN' };
    if (userIdentityKey.test(key)) return { path: `${path}.${key}`, code: 'CLIENT_USER_ID_FORBIDDEN' };
    const found = scanForbidden(item, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function parseTimestamp(value: unknown, code: string) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new PaperJournalError(code, '동기화 시각 형식을 확인하세요.');
  return new Date(value).toISOString();
}

function validateRecord(value: unknown): PaperJournalSyncRecord {
  if (!isObject(value)) throw new PaperJournalError('INVALID_SYNC_RECORD', '동기화 레코드 형식을 확인하세요.');
  if (!PAPER_JOURNAL_RECORD_KINDS.includes(value.kind as PaperJournalRecordKind)) throw new PaperJournalError('INVALID_RECORD_KIND', '지원하지 않는 동기화 레코드 종류입니다.');
  if (typeof value.id !== 'string' || !idPattern.test(value.id)) throw new PaperJournalError('INVALID_RECORD_ID', '동기화 레코드 ID를 확인하세요.');
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) throw new PaperJournalError('INVALID_RECORD_VERSION', '동기화 version은 1 이상의 정수여야 합니다.');
  const updatedAt = parseTimestamp(value.updatedAt, 'INVALID_RECORD_TIMESTAMP');
  const deletedAt = value.deletedAt == null ? null : parseTimestamp(value.deletedAt, 'INVALID_TOMBSTONE_TIMESTAMP');
  if (!isObject(value.payload)) throw new PaperJournalError('INVALID_RECORD_PAYLOAD', '동기화 payload를 확인하세요.');
  const forbidden = scanForbidden(value.payload);
  if (forbidden) throw new PaperJournalError(forbidden.code, '사용자 식별자, Secret 또는 안전하지 않은 객체 키는 payload에 포함할 수 없습니다.');
  return { kind: value.kind as PaperJournalRecordKind, id: value.id, version: Number(value.version), updatedAt, deletedAt, payload: structuredClone(value.payload) };
}

export function validatePaperJournalSyncRequest(value: unknown): PaperJournalSyncRequest {
  if (!isObject(value)) throw new PaperJournalError('INVALID_SYNC_REQUEST', '동기화 요청 형식을 확인하세요.');
  if ('user_id' in value || 'userId' in value) throw new PaperJournalError('CLIENT_USER_ID_FORBIDDEN', '사용자 ID는 로그인 세션에서만 결정됩니다.');
  if (typeof value.idempotencyKey !== 'string' || !idempotencyPattern.test(value.idempotencyKey)) throw new PaperJournalError('INVALID_IDEMPOTENCY_KEY', '동기화 idempotency key를 확인하세요.');
  const clientTime = parseTimestamp(value.clientTime, 'INVALID_CLIENT_TIME');
  if (!Array.isArray(value.records)) throw new PaperJournalError('INVALID_SYNC_RECORDS', '동기화 records 배열이 필요합니다.');
  if (value.records.length > MAX_SYNC_RECORDS) throw new PaperJournalError('TOO_MANY_SYNC_RECORDS', `한 번에 최대 ${MAX_SYNC_RECORDS}개 레코드만 동기화할 수 있습니다.`, 413);
  const records = value.records.map(validateRecord);
  const unique = new Set<string>();
  for (const record of records) {
    const key = `${record.kind}:${record.id}`;
    if (unique.has(key)) throw new PaperJournalError('DUPLICATE_SYNC_RECORD', '한 요청에 같은 레코드를 중복 포함할 수 없습니다.');
    unique.add(key);
  }
  return { idempotencyKey: value.idempotencyKey, clientTime, records };
}

function sameRecord(server: StoredPaperJournalRecord, device: PaperJournalSyncRecord) {
  return server.version === device.version && server.deletedAt === device.deletedAt && canonical(server.payload) === canonical(device.payload);
}

function differenceSummary(server: StoredPaperJournalRecord, device: PaperJournalSyncRecord) {
  const differences: string[] = [];
  if (server.deletedAt !== device.deletedAt) differences.push('삭제 상태가 다릅니다.');
  const keys = new Set([...Object.keys(server.payload), ...Object.keys(device.payload)]);
  for (const key of [...keys].sort()) {
    if (canonical(server.payload[key]) !== canonical(device.payload[key])) differences.push(`${key} 값이 다릅니다.`);
    if (differences.length >= 20) break;
  }
  return differences.length ? differences : ['같은 version이지만 내용 해시가 다릅니다.'];
}

function conflictId(record: PaperJournalSyncRecord) {
  const digest = createHash('sha256').update(`${record.kind}:${record.id}:${record.version}:${canonical(record.payload)}:${record.deletedAt ?? ''}`).digest('hex').slice(0, 24);
  return `conflict:${digest}`;
}

function safeFailure(record: PaperJournalSyncRecord, cause: unknown) {
  if (cause instanceof PaperJournalError) return { kind: record.kind, id: record.id, code: cause.code, message: cause.message };
  return { kind: record.kind, id: record.id, code: 'SYNC_ITEM_FAILED', message: '이 레코드를 동기화하지 못했습니다.' };
}

async function executeSync(
  repository: PaperJournalRepository,
  userId: string,
  request: PaperJournalSyncRequest,
  now: Date,
): Promise<PaperJournalSyncResult> {
  const cached = await repository.getIdempotentResponse(userId, request.idempotencyKey);
  if (cached) return cached;

  const serverTime = now.toISOString();
  const clockSkewMs = Date.parse(request.clientTime) - now.getTime();
  const warnings = Math.abs(clockSkewMs) > CLOCK_SKEW_WARNING_MS
    ? ['기기 시각과 서버 시각 차이가 큽니다. version을 우선하고 서버 시각을 기록했습니다.'] : [];
  const uploaded: StoredPaperJournalRecord[] = [];
  const downloaded: StoredPaperJournalRecord[] = [];
  const unchanged: PaperJournalSyncResult['unchanged'] = [];
  const conflicts: PaperJournalConflict[] = [];
  const failed: PaperJournalSyncResult['failed'] = [];

  for (const record of request.records) {
    try {
      const server = await repository.getRecord(userId, record.kind, record.id);
      if (!server || record.version > server.version) {
        uploaded.push(await repository.upsertRecord(userId, record, serverTime));
      } else if (record.version < server.version) {
        downloaded.push(server);
      } else if (sameRecord(server, record)) {
        unchanged.push({ kind: record.kind, id: record.id, version: record.version });
      } else {
        const conflict: PaperJournalConflict = {
          id: conflictId(record), kind: record.kind, recordId: record.id, version: record.version,
          serverRecord: server, deviceRecord: record,
          differenceSummary: differenceSummary(server, record), createdAt: serverTime, status: 'open',
        };
        await repository.saveConflict(userId, conflict);
        conflicts.push(conflict);
      }
    } catch (cause) { failed.push(safeFailure(record, cause)); }
  }

  const result: PaperJournalSyncResult = {
    ok: true, mode: JOURNAL_SYNC_MODE, orderSubmitted: false, exchangeRequestSent: false,
    idempotencyKey: request.idempotencyKey, serverTime, uploaded, downloaded, unchanged,
    conflicts, failed, warnings, clockSkewMs,
  };
  await repository.saveIdempotentResponse(userId, request.idempotencyKey, result, serverTime);
  return result;
}

export async function syncPaperJournal(repository: PaperJournalRepository, userId: string, input: unknown, now = new Date()) {
  if (!userId) throw new PaperJournalError('LOGIN_REQUIRED', '로그인이 필요합니다.', 401);
  const request = validatePaperJournalSyncRequest(input);
  const key = `${userId}:${request.idempotencyKey}`;
  const existing = inFlightSync.get(key);
  if (existing) return existing;
  const task = executeSync(repository, userId, request, now).finally(() => {
    if (inFlightSync.get(key) === task) inFlightSync.delete(key);
  });
  inFlightSync.set(key, task);
  return task;
}

function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown) {
  if (value == null || value === '') return 0;
  if (typeof value !== 'string' || value.length > 200) throw new PaperJournalError('INVALID_CURSOR', 'snapshot cursor를 확인하세요.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { offset?: unknown };
    if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error('invalid');
    return Number(parsed.offset);
  } catch { throw new PaperJournalError('INVALID_CURSOR', 'snapshot cursor를 확인하세요.'); }
}

export async function getPaperJournalSnapshot(repository: PaperJournalRepository, userId: string, cursorValue: unknown, limitValue: unknown, now = new Date()): Promise<PaperJournalSnapshotResult> {
  const cursor = decodeCursor(cursorValue);
  const requested = Number(limitValue ?? 50);
  if (!Number.isSafeInteger(requested) || requested < 1) throw new PaperJournalError('INVALID_PAGE_SIZE', '페이지 크기를 확인하세요.');
  const limit = Math.min(requested, MAX_SNAPSHOT_PAGE_SIZE);
  const records = (await repository.listSnapshot(userId)).sort((left, right) => left.serverUpdatedAt.localeCompare(right.serverUpdatedAt) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const page = records.slice(cursor, cursor + limit);
  return {
    ok: true, mode: JOURNAL_SYNC_MODE, orderSubmitted: false, exchangeRequestSent: false,
    records: page, nextCursor: cursor + page.length < records.length ? encodeCursor(cursor + page.length) : null,
    serverTime: now.toISOString(),
  };
}

function cloneWithVersion(record: PaperJournalSyncRecord, version: number, updatedAt: string, id = record.id): PaperJournalSyncRecord {
  return { ...structuredClone(record), id, version, updatedAt };
}

export async function resolvePaperJournalConflict(repository: PaperJournalRepository, userId: string, conflictIdValue: unknown, choiceValue: unknown, now = new Date()): Promise<ConflictResolutionResult> {
  if (typeof conflictIdValue !== 'string' || !idPattern.test(conflictIdValue)) throw new PaperJournalError('INVALID_CONFLICT_ID', '충돌 ID를 확인하세요.');
  if (!['server', 'device', 'preserve_both'].includes(String(choiceValue))) throw new PaperJournalError('INVALID_CONFLICT_CHOICE', '충돌 해결 방법을 확인하세요.');
  const choice = choiceValue as ConflictResolutionChoice;
  const conflict = await repository.getConflict(userId, conflictIdValue);
  if (!conflict || conflict.status !== 'open') throw new PaperJournalError('CONFLICT_NOT_FOUND', '열린 충돌을 찾지 못했습니다.', 404);
  const serverTime = now.toISOString();
  const records: StoredPaperJournalRecord[] = [];
  if (choice === 'server') records.push(conflict.serverRecord);
  else if (choice === 'device') records.push(await repository.upsertRecord(userId, cloneWithVersion(conflict.deviceRecord, Math.max(conflict.serverRecord.version, conflict.deviceRecord.version) + 1, serverTime), serverTime));
  else {
    records.push(conflict.serverRecord);
    const suffix = createHash('sha256').update(`${conflict.id}:${serverTime}`).digest('hex').slice(0, 10);
    const copyId = `${conflict.deviceRecord.id}-copy-${suffix}`.slice(0, 160);
    records.push(await repository.upsertRecord(userId, cloneWithVersion(conflict.deviceRecord, 1, serverTime, copyId), serverTime));
  }
  await repository.markConflictResolved(userId, conflict.id, serverTime);
  return { ok: true, mode: JOURNAL_SYNC_MODE, orderSubmitted: false, exchangeRequestSent: false, conflictId: conflict.id, choice, records, serverTime };
}

export async function deleteAllPaperJournalData(repository: PaperJournalRepository, userId: string, confirmation: unknown) {
  if (confirmation !== DELETE_ALL_CONFIRMATION) throw new PaperJournalError('DELETE_CONFIRMATION_REQUIRED', `확인 문자열 ${DELETE_ALL_CONFIRMATION}을 입력해야 합니다.`);
  return { ok: true as const, mode: JOURNAL_SYNC_MODE, orderSubmitted: false as const, exchangeRequestSent: false as const, deleted: await repository.deleteAll(userId) };
}
