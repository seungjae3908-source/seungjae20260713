export const PAPER_STORAGE_KEY = 'seungjae.paper-trading.v1';
export const PAPER_ARCHIVE_KEY = 'seungjae.paper-trading.archive.v1';
export const PAPER_STORAGE_SCHEMA_VERSION = 1;
export const PAPER_STORAGE_LIMITS = Object.freeze({ orders: 500, positions: 200, fills: 1_000, journal: 500, events: 500 });

import type { PaperTradingState } from './paper-trading';
import { validPaperJournal, validPaperState } from '../../../packages/api-zod/src/paper-state-evidence.js';

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
  return validPaperState(value, Date.now());
}

function validArchiveRows(value: unknown): value is PaperTradingState['journal'] {
  return Array.isArray(value) && value.length <= 10000 && value.every((entry) => validPaperJournal(entry, Date.now()))
    && new Set(value.map((entry) => entry.id)).size === value.length;
}

export function loadPaperArchive(storage: StorageLike) {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PAPER_ARCHIVE_KEY);
    if (raw === null) return { journal: [] as PaperTradingState['journal'], recovered: false, blocked: false, warning: '' };
    const parsed = JSON.parse(raw) as Partial<PaperArchiveEnvelope>;
    if (!parsed || parsed.schemaVersion !== 1 || !validArchiveRows(parsed.journal)) throw new Error('invalid');
    const journal = parsed.journal;
    return { journal, recovered: false, blocked: false, warning: journal.length ? `보존된 과거 거래일지 ${journal.length}건이 있습니다.` : '' };
  } catch {
    return { journal: [] as PaperTradingState['journal'], recovered: false, blocked: true, warning: '과거 거래일지를 검증하지 못했습니다. 원본을 유지하고 archive 저장·동기화를 차단합니다.' };
  }
}

export function savePaperArchive(storage: StorageLike, journal: PaperTradingState['journal']) {
  if (loadPaperArchive(storage).blocked) throw new Error('기존 archive를 검증하지 못해 덮어쓰지 않았습니다.');
  if (containsSecretKey(journal) || !journal.every((entry) => validPaperJournal(entry, Date.now()))) throw new Error('archive 기록 또는 Secret 유사 필드를 확인하세요.');
  const byId = new Map<string, PaperTradingState['journal'][number]>();
  for (const entry of journal) byId.set(entry.id, entry);
  if (!validArchiveRows([...byId.values()])) throw new Error('archive 크기 또는 기록을 확인하세요. 자동 삭제하지 않았습니다.');
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
    // Journal overflow is archived by savePaperState before this compaction.
    // Pending orders, open positions, fills, notes and idempotency evidence must not be trimmed here.
    journal: state.journal.slice(-PAPER_STORAGE_LIMITS.journal),
  };
}

export function savePaperState(storage: StorageLike, state: PaperTradingState, options: { replaceCorrupt?: boolean } = {}) {
  if (!validatePaperState(state)) throw new Error('저장할 모의거래 상태가 올바르지 않습니다.');
  if (!options.replaceCorrupt) {
    const raw = storage.getItem(PAPER_STORAGE_KEY);
    if (raw !== null) {
      try {
        const existing = JSON.parse(raw) as Partial<PaperStorageEnvelope>;
        if (!existing || existing.schemaVersion !== 1 || !validatePaperState(existing.state)) throw new Error('invalid');
      } catch { throw new Error('기존 모의거래 원본을 검증하지 못해 덮어쓰지 않았습니다. 명시적으로 가져오거나 초기화하세요.'); }
    }
  }
  const overflowCount = Math.max(0, state.journal.length - PAPER_STORAGE_LIMITS.journal);
  if (overflowCount > 0) {
    const existing = loadPaperArchive(storage);
    if (existing.blocked) throw new Error(existing.warning);
    savePaperArchive(storage, [...existing.journal, ...state.journal.slice(0, overflowCount)]);
  }
  const envelope: PaperStorageEnvelope = { schemaVersion: 1, savedAt: new Date().toISOString(), state: repairPaperState(state) };
  storage.setItem(PAPER_STORAGE_KEY, JSON.stringify(envelope));
  return envelope.state;
}

export function loadPaperState(storage: StorageLike, initialBalance = 10_000) {
  const archive = loadPaperArchive(storage);
  let raw: string | null = null;
  try {
    raw = storage.getItem(PAPER_STORAGE_KEY);
    if (raw === null) return { state: createLocalPaperState(initialBalance), recovered: false, blocked: false, rawExport: null, warning: archive.warning };
    const envelope = JSON.parse(raw) as Partial<PaperStorageEnvelope>;
    if (!envelope || envelope.schemaVersion !== 1 || !validatePaperState(envelope.state)) throw new Error('invalid');
    return { state: envelope.state, recovered: false, blocked: false, rawExport: null, warning: archive.warning };
  } catch {
    // Placeholder only: consumers must hide this state and block actions while blocked.
    return { state: createLocalPaperState(initialBalance), recovered: false, blocked: true, rawExport: raw, warning: '모의거래 저장 기록을 검증하지 못했습니다. 원본을 변경하지 않았으며 잔액·성과를 표시하거나 거래하지 않습니다.' };
  }
}

export function exportPaperState(state: PaperTradingState) {
  if (!validatePaperState(state)) throw new Error('내보낼 모의거래 상태가 올바르지 않습니다.');
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), state }, null, 2);
}

export function exportPaperArchive(storage: StorageLike) {
  const archive = loadPaperArchive(storage);
  if (archive.blocked) throw new Error(archive.warning);
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), archiveCandidate: true, journal: archive.journal }, null, 2);
}

export function importPaperState(text: string) {
  if (text.length > 2_000_000) throw new Error('가져오기 파일이 너무 큽니다.');
  const payload = JSON.parse(text) as { schemaVersion?: unknown; state?: unknown };
  if (!payload || payload.schemaVersion !== 1 || !validatePaperState(payload.state)) throw new Error('올바른 모의거래 JSON 파일이 아닙니다.');
  return payload.state;
}

export function clearPaperState(storage: StorageLike, initialBalance = 10_000) {
  // The archive is intentionally preserved. Historical journal deletion requires
  // a separate explicit user action/export flow and is never automatic.
  const next = createLocalPaperState(initialBalance);
  storage.removeItem(PAPER_STORAGE_KEY);
  return next;
}
