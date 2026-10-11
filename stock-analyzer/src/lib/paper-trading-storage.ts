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

/** This is the legacy browser-local MANUAL futures simulator archive only.
 * A new research round is never a server 4-market Paper wallet, LIVE account,
 * transfer, or authority to invent historical profit.
 */
export const PAPER_MANUAL_ROUNDS_KEY = 'seungjae.paper-trading.manual-rounds.v1';
export const MANUAL_PAPER_NEXT_ROUND_CONFIRMATION = 'START_NEXT_LOCAL_MANUAL_PAPER_ROUND_WITH_HISTORY';
const MANUAL_ROUND_MAX_COUNT = 40;
const MANUAL_ROUND_MAX_BYTES = 3_500_000;

export type ManualPaperRoundRecord = Readonly<{
  round: number;
  previousAccountId: string;
  nextAccountId: string;
  closedAt: string;
  finalEquity: number;
  initialCapital: number;
  netPnl: number;
  bankrupt: boolean;
  archived: PaperTradingState;
}>;

function readManualPaperRounds(storage: StorageLike): ManualPaperRoundRecord[] {
  const raw = storage.getItem(PAPER_MANUAL_ROUNDS_KEY);
  if (!raw) return [];
  if (raw.length > MANUAL_ROUND_MAX_BYTES) throw new Error('모의 연구 회차 보관 용량을 초과했습니다. 기록을 먼저 내보내세요.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('기존 수동모의 회차 보관 기록이 손상되어 신규 회차를 차단했습니다.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('수동모의 회차 보관 형식이 올바르지 않습니다.');
  }
  const obj = parsed as {schemaVersion?:unknown; rounds?:unknown};
  if (obj.schemaVersion !== 1 || !Array.isArray(obj.rounds) || obj.rounds.length > MANUAL_ROUND_MAX_COUNT
    || containsSecretKey(obj.rounds)) throw new Error('수동모의 회차 보관 검증에 실패했습니다.');
  const previous = new Set<string>();
  return obj.rounds.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('수동모의 회차 이력이 올바르지 않습니다.');
    const record = row as ManualPaperRoundRecord;
    if (record.round !== i+1
      || typeof record.previousAccountId !== 'string' || !record.previousAccountId
      || typeof record.nextAccountId !== 'string' || !record.nextAccountId
      || record.previousAccountId === record.nextAccountId
      || previous.has(record.previousAccountId)
      || !Number.isFinite(Date.parse(record.closedAt))
      || !finite(record.finalEquity) || !finite(record.initialCapital) || !finite(record.netPnl)
      || typeof record.bankrupt !== 'boolean' || !validatePaperState(record.archived)
      || record.archived.account.id !== record.previousAccountId
      || record.archived.account.initialBalance !== record.initialCapital) {
      throw new Error('수동모의 회차 이력 검증에 실패했습니다.');
    }
    previous.add(record.previousAccountId);
    return record;
  });
}

export function getManualPaperRoundSummary(storage: StorageLike, activeState?: PaperTradingState) {
  const rounds = readManualPaperRounds(storage);
  const totalIssued = rounds.reduce((sum, row) => sum + row.initialCapital, 0);
  const totalNet = rounds.reduce((sum, row) => sum + row.netPnl, 0);
  if (!Number.isFinite(totalIssued) || !Number.isFinite(totalNet)) {
    throw new Error('수동모의 전체 회차 손익이 올바르지 않습니다.');
  }
  // Running PnL belongs in the total score as a separate open campaign:
  // a second round at +20% cannot conceal the first -100% bankruptcy.
  const activeValid=activeState === undefined ? false : validatePaperState(activeState)
    && !rounds.some(row => row.previousAccountId === activeState.account.id)
    && (rounds.length === 0 || rounds.at(-1)!.nextAccountId === activeState.account.id);
  const activeSeed=activeValid ? activeState!.account.initialBalance : 0;
  const activeNet=activeValid ? activeState!.account.equity-activeSeed : 0;
  const issuedIncludingActive=totalIssued+activeSeed;
  const netIncludingActive=totalNet+activeNet;
  return {
    completedRounds:rounds.length,
    bankruptcies:rounds.filter(row => row.bankrupt).length,
    totalIssued,
    totalNet,
    issuedCapitalReturnPercent:totalIssued > 0 ? totalNet / totalIssued * 100 : null,
    cumulativeIncludingActive: {
      rounds:rounds.length + Number(activeValid),
      totalIssued:issuedIncludingActive,
      totalNet:netIncludingActive,
      totalReturnPercent:issuedIncludingActive>0 ? netIncludingActive/issuedIncludingActive*100 : null,
    },
    // Historical rounds are immutable browser snapshots; no withdrawal/transfer.
    records:rounds.map(({archived, ...summary}) => summary),
  };
}

/** Explicit human confirmation, flat position/order and durable archive first.
 * A failure after archive commit can be retried against the SAME previous ID
 * without issuing a second round. There is no automatic cash refill.
 */
export function startNextLocalManualPaperRound(
  storage: StorageLike,
  state: PaperTradingState,
  confirmation: string,
  now = new Date(),
): PaperTradingState {
  if (confirmation !== MANUAL_PAPER_NEXT_ROUND_CONFIRMATION) {
    throw new Error('수동모의 연구 회차 시작을 명시적으로 확인해야 합니다.');
  }
  if (!validatePaperState(state) || !Number.isFinite(now.getTime())) {
    throw new Error('현재 모의매매 상태가 유효하지 않습니다.');
  }
  if (state.positions.some(row => row.status !== 'closed' && row.remainingQuantity > 0)
      || state.orders.some(row => row.status === 'pending')) {
    throw new Error('열린 포지션과 미체결 주문이 있으면 새 회차를 시작할 수 없습니다.');
  }
  if (state.account.equity > 0.01) {
    throw new Error('운용 가능한 자본이 남아 있어 새 회차를 시작하지 않습니다. 먼저 현재 회차를 유지하세요.');
  }
  if (Math.abs(state.account.equity - state.account.cashBalance) > 0.01
      || state.account.usedMargin > 0.01 || state.account.unrealizedPnl !== 0) {
    throw new Error('모의계좌 잔량과 현금 정산이 일치하지 않아 새 회차를 차단했습니다.');
  }
  const stored = storage.getItem(PAPER_STORAGE_KEY);
  if (stored) {
    let current: Partial<PaperStorageEnvelope>;
    try {current = JSON.parse(stored);}
    catch {throw new Error('현재 저장된 모의계좌 데이터가 손상되어 있습니다.');}
    if (!validatePaperState(current.state) || current.state.account.id !== state.account.id) {
      throw new Error('다른 화면에서 모의계좌가 변경되었습니다. 다시 불러온 뒤 진행하세요.');
    }
  }
  const records = readManualPaperRounds(storage);
  const last = records.at(-1);
  const alreadyArchived = last?.previousAccountId === state.account.id;
  if (records.some(row => row.previousAccountId === state.account.id) && !alreadyArchived) {
    throw new Error('이미 종료된 과거 모의계좌를 다시 시작할 수 없습니다.');
  }
  if (records.length >= MANUAL_ROUND_MAX_COUNT && !alreadyArchived) {
    throw new Error('브라우저 보관 회차 40개 한도입니다. 전체 이력을 먼저 내보내세요.');
  }
  const nextRound = alreadyArchived ? last!.round + 1 : records.length + 2;
  const nextAccount = alreadyArchived ? last!.nextAccountId
    : `paper_manual_round_${nextRound}_${now.getTime()}`;
  const nextState = createLocalPaperState(state.account.initialBalance, now);
  nextState.account.id = nextAccount;
  if (!alreadyArchived) {
    const ending = {
      round:records.length + 1, previousAccountId:state.account.id,
      nextAccountId:nextAccount, closedAt:now.toISOString(),
      finalEquity:state.account.equity, initialCapital:state.account.initialBalance,
      netPnl:state.account.equity - state.account.initialBalance,
      bankrupt:state.account.equity <= 0,
      archived:state,
    };
    const raw = JSON.stringify({schemaVersion:1,savedAt:now.toISOString(),rounds:[...records,ending]});
    if (raw.length > MANUAL_ROUND_MAX_BYTES) {
      throw new Error('회차 이력 보관 공간이 부족합니다. 내보낸 뒤 별도 보관하세요.');
    }
    storage.setItem(PAPER_MANUAL_ROUNDS_KEY,raw);
  }
  // Round archive is durable before replacing the local active Paper state.
  // If storage fails here, the next explicit attempt resumes the same round.
  savePaperState(storage,nextState);
  return nextState;
}

export function exportManualPaperRounds(storage: StorageLike): string {
  return JSON.stringify({
    schemaVersion:1,exportedAt:new Date().toISOString(),
    localManualPaperOnly:true,rounds:readManualPaperRounds(storage),
  },null,2);
}
