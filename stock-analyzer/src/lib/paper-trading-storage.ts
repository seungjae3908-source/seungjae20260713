export const PAPER_STORAGE_KEY = 'seungjae.paper-trading.v1';
export const PAPER_STORAGE_SCHEMA_VERSION = 1;
export const PAPER_STORAGE_LIMITS = Object.freeze({ orders: 500, positions: 200, fills: 1_000, journal: 500, events: 500 });

import type { PaperTradingState } from './paper-trading';

export type StorageLike = Pick<Storage, 'getItem'|'setItem'|'removeItem'>;
export type PaperStorageEnvelope = { schemaVersion: 1; savedAt: string; state: PaperTradingState };

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

export function repairPaperState(state: PaperTradingState): PaperTradingState {
  return {
    ...state,
    schemaVersion: 1,
    orders: state.orders.slice(-PAPER_STORAGE_LIMITS.orders),
    positions: state.positions.slice(-PAPER_STORAGE_LIMITS.positions),
    fills: state.fills.slice(-PAPER_STORAGE_LIMITS.fills),
    journal: state.journal.slice(-PAPER_STORAGE_LIMITS.journal).map((entry) => ({ ...entry, note: String(entry.note ?? '').slice(0, 2_000) })),
    processedEventIds: state.processedEventIds.slice(-PAPER_STORAGE_LIMITS.events),
  };
}

export function savePaperState(storage: StorageLike, state: PaperTradingState) {
  if (!validatePaperState(state)) throw new Error('저장할 모의거래 상태가 올바르지 않습니다.');
  const envelope: PaperStorageEnvelope = { schemaVersion: 1, savedAt: new Date().toISOString(), state: repairPaperState(state) };
  storage.setItem(PAPER_STORAGE_KEY, JSON.stringify(envelope));
  return envelope.state;
}

export function loadPaperState(storage: StorageLike, initialBalance = 10_000) {
  const raw = storage.getItem(PAPER_STORAGE_KEY);
  if (!raw) return { state: createLocalPaperState(initialBalance), recovered: false, warning: '' };
  try {
    const envelope = JSON.parse(raw) as Partial<PaperStorageEnvelope>;
    if (envelope.schemaVersion !== 1 || !validatePaperState(envelope.state)) throw new Error('invalid');
    return { state: repairPaperState(envelope.state), recovered: false, warning: '' };
  } catch {
    storage.removeItem(PAPER_STORAGE_KEY);
    return { state: createLocalPaperState(initialBalance), recovered: true, warning: '손상된 모의거래 저장 데이터를 초기 상태로 복구했습니다.' };
  }
}

export function exportPaperState(state: PaperTradingState) {
  if (!validatePaperState(state)) throw new Error('내보낼 모의거래 상태가 올바르지 않습니다.');
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), state: repairPaperState(state) }, null, 2);
}

export function importPaperState(text: string) {
  if (text.length > 2_000_000) throw new Error('가져오기 파일이 너무 큽니다.');
  const payload = JSON.parse(text) as { schemaVersion?: unknown; state?: unknown };
  if (payload.schemaVersion !== 1 || !validatePaperState(payload.state)) throw new Error('올바른 모의거래 JSON 파일이 아닙니다.');
  return repairPaperState(payload.state);
}

export function clearPaperState(storage: StorageLike, initialBalance = 10_000) {
  storage.removeItem(PAPER_STORAGE_KEY);
  return createLocalPaperState(initialBalance);
}
