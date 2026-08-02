export const PAPER_STORAGE_KEY = 'seungjae.paper-trading.v1';
export const PAPER_ARCHIVE_KEY = 'seungjae.paper-trading.archive.v1';
export const PAPER_STORAGE_SCHEMA_VERSION = 1;
export const PAPER_STORAGE_LIMITS = Object.freeze({ orders: 500, positions: 200, fills: 1_000, journal: 500, events: 500 });

import type { PaperTradingState } from './paper-trading';

export type StorageLike = Pick<Storage, 'getItem'|'setItem'|'removeItem'>;
export type PaperStorageEnvelope = { schemaVersion: 1; savedAt: string; state: PaperTradingState };
export type PaperArchiveEnvelope = {
  schemaVersion: 1;
  savedAt: string;
  journal: PaperTradingState['journal'];
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const forbiddenKey = /(?:api.?key|secret|authorization|bearer|access.?token|refresh.?token|private.?key)/i;

function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => forbiddenKey.test(key) || containsSecretKey(item));
}

export function createLocalPaperState(initialBalance = 10_000, now = new Date()): PaperTradingState {
  if (!finite(initialBalance) || initialBalance <= 0) throw new Error('초기 자본은 0보다 커야 합니다.');
  const at = now.toISOString();
  return {
    schemaVersion: 1,
    account: { id: `paper_${now.getTime()}`, initialBalance, cashBalance: initialBalance, realizedPnl: 0, unrealizedPnl: 0, equity: initialBalance, usedMargin: 0, availableMargin: initialBalance, createdAt: at, updatedAt: at },
    orders: [], positions: [], fills: [], journal: [],
    riskState: { dayKey: at.slice(0,10), weekKey: '', dailyRealizedPnl: 0, weeklyRealizedPnl: 0, consecutiveLosses: 0 },
    processedEventIds: [], createdAt: at, updatedAt: at,
  };
}

export function validatePaperState(value: unknown): value is PaperTradingState {
  if (!value || typeof value !== 'object' || containsSecretKey(value)) return false;
  const state = value as Partial<PaperTradingState>;
  if (state.schemaVersion !== 1 || !state.account || !Array.isArray(state.orders) || !Array.isArray(state.positions) || !Array.isArray(state.fills) || !Array.isArray(state.journal) || !Array.isArray(state.processedEventIds)) return false;
  const numbers = [state.account.initialBalance, state.account.cashBalance, state.account.realizedPnl, state.account.unrealizedPnl, state.account.equity, state.account.usedMargin, state.account.availableMargin];
  return numbers.every(finite) && (state.account.initialBalance ?? 0) > 0;
}

function safeJournalEntry(entry: PaperTradingState['journal'][number]) {
  return { ...entry, note: String(entry.note ?? '').slice(0, 2_000) };
}

export function loadPaperArchive(storage: StorageLike) {
  const raw = storage.getItem(PAPER_ARCHIVE_KEY);
  if (!raw) return { journal: [] as PaperTradingState['journal'], recovered: false, warning: '' };
  try {
    const parsed = JSON.parse(raw) as Partial<PaperArchiveEnvelope>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.journal) || containsSecretKey(parsed.journal)) throw new Error('invalid');
    const seen = new Set<string>();
    const journal = parsed.journal.filter((entry): entry is PaperTradingState['journal'][number] => {
      if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string') return false;
      const id = (entry as { id: string }).id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map(safeJournalEntry);
    return { journal, recovered: false, warning: journal.length ? `보존된 과거 거래일지 ${journal.length}건이 있습니다.` : '' };
  } catch {
    const backupKey = `${PAPER_ARCHIVE_KEY}.corrupt:${new Date().toISOString().replace(/[:.]/g, '-')}`;
    storage.setItem(backupKey, raw);
    storage.removeItem(PAPER_ARCHIVE_KEY);
    return { journal: [] as PaperTradingState['journal'], recovered: true, warning: '손상된 거래일지 archive를 백업하고 빈 archive로 복구했습니다.' };
  }
}

export function savePaperArchive(storage: StorageLike, journal: PaperTradingState['journal']) {
  if (containsSecretKey(journal)) throw new Error('archive에 Secret 유사 필드를 저장할 수 없습니다.');
  const byId = new Map<string, PaperTradingState['journal'][number]>();
  for (const entry of journal) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, safeJournalEntry(entry));
  }
  const envelope: PaperArchiveEnvelope = {
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    journal: [...byId.values()],
  };
  storage.setItem(PAPER_ARCHIVE_KEY, JSON.stringify(envelope));
  return envelope.journal;
}

export function repairPaperState(state: PaperTradingState): PaperTradingState {
  return {
    ...state,
    schemaVersion: 1,
    orders: state.orders.slice(-PAPER_STORAGE_LIMITS.orders),
    positions: state.positions.slice(-PAPER_STORAGE_LIMITS.positions),
    fills: state.fills.slice(-PAPER_STORAGE_LIMITS.fills),
    journal: state.journal.slice(-PAPER_STORAGE_LIMITS.journal).map(safeJournalEntry),
    processedEventIds: state.processedEventIds.slice(-PAPER_STORAGE_LIMITS.events),
  };
}

export function savePaperState(storage: StorageLike, state: PaperTradingState) {
  if (!validatePaperState(state)) throw new Error('저장할 모의거래 상태가 올바르지 않습니다.');
  const overflowCount = Math.max(0, state.journal.length - PAPER_STORAGE_LIMITS.journal);
  if (overflowCount > 0) {
    const existing = loadPaperArchive(storage).journal;
    savePaperArchive(storage, [...existing, ...state.journal.slice(0, overflowCount)]);
  }
  const envelope: PaperStorageEnvelope = { schemaVersion: 1, savedAt: new Date().toISOString(), state: repairPaperState(state) };
  storage.setItem(PAPER_STORAGE_KEY, JSON.stringify(envelope));
  return envelope.state;
}

export function loadPaperState(storage: StorageLike, initialBalance = 10_000) {
  const raw = storage.getItem(PAPER_STORAGE_KEY);
  const archive = loadPaperArchive(storage);
  if (!raw) return { state: createLocalPaperState(initialBalance), recovered: archive.recovered, warning: archive.warning };
  try {
    const envelope = JSON.parse(raw) as Partial<PaperStorageEnvelope>;
    if (envelope.schemaVersion !== 1 || !validatePaperState(envelope.state)) throw new Error('invalid');
    return { state: repairPaperState(envelope.state), recovered: archive.recovered, warning: archive.warning };
  } catch {
    const backupKey = `${PAPER_STORAGE_KEY}.corrupt:${new Date().toISOString().replace(/[:.]/g, '-')}`;
    storage.setItem(backupKey, raw);
    storage.removeItem(PAPER_STORAGE_KEY);
    return { state: createLocalPaperState(initialBalance), recovered: true, warning: '손상된 모의거래 저장 데이터를 백업하고 초기 상태로 복구했습니다.' };
  }
}

export function exportPaperState(state: PaperTradingState) {
  if (!validatePaperState(state)) throw new Error('내보낼 모의거래 상태가 올바르지 않습니다.');
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), state: repairPaperState(state) }, null, 2);
}

export function exportPaperArchive(storage: StorageLike) {
  const archive = loadPaperArchive(storage);
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), archiveCandidate: true, journal: archive.journal }, null, 2);
}

export function importPaperState(text: string) {
  if (text.length > 2_000_000) throw new Error('가져오기 파일이 너무 큽니다.');
  const payload = JSON.parse(text) as { schemaVersion?: unknown; state?: unknown };
  if (payload.schemaVersion !== 1 || !validatePaperState(payload.state)) throw new Error('올바른 모의거래 JSON 파일이 아닙니다.');
  return repairPaperState(payload.state);
}

export function clearPaperState(storage: StorageLike, initialBalance = 10_000) {
  // The archive is intentionally preserved. Historical journal deletion requires
  // a separate explicit user action/export flow and is never automatic.
  storage.removeItem(PAPER_STORAGE_KEY);
  return createLocalPaperState(initialBalance);
}
