import type {
  ScannerDecisionHistoryEntry,
  ScannerDecisionOutcome,
  ScannerSignalCard,
} from './scanner-signal.types';

type DecisionRecord = {
  lastSeenAt: number;
  lastDecisionKey: string | null;
  history: ScannerDecisionHistoryEntry[];
};

const records = new Map<string, DecisionRecord>();
const RECORD_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_DECISION_HISTORY = 12;

function decisionOutcome(card: ScannerSignalCard): ScannerDecisionOutcome {
  if (['INVALIDATED', 'EXPIRED', 'REJECTED', 'CANCELLED', 'CLOSED'].includes(card.signalState)) return 'BLOCKED';
  if (card.themeSwing?.state === 'REJECT') return 'BLOCKED';
  if (!card.strongSignalEligible) return 'WATCH';
  if (card.direction === 'LONG') return 'LONG_REVIEW';
  if (card.direction === 'SHORT') return 'SHORT_REVIEW';
  return 'NO_TRADE';
}

function decisionReasons(previous: ScannerDecisionHistoryEntry | undefined, card: ScannerSignalCard): string[] {
  const reasons: string[] = [];
  if (!previous) reasons.push(`신호 상태 시작: ${card.signalState}`);
  else if (previous.state !== card.signalState) reasons.push(`신호 상태 ${previous.state} → ${card.signalState}`);
  if (!card.strongSignalEligible) reasons.push('강신호 Gate 미충족');
  reasons.push(...(card.dataQuality?.issues ?? [])
    .filter((issue) => issue.severity === 'blocking')
    .map((issue) => issue.message));
  reasons.push(...(card.candidateRanking?.watchReasons ?? []));
  reasons.push(...(card.themeSwing?.blockers ?? []));
  reasons.push(...card.notMatched.slice(0, 2));
  reasons.push(...card.warnings.slice(0, 2));
  if (card.strongSignalEligible && card.direction === 'LONG') reasons.push('현재 LONG 방향 검토 조건 유지');
  if (card.strongSignalEligible && card.direction === 'SHORT') reasons.push('현재 SHORT 방향 검토 조건 유지');
  return [...new Set(reasons.filter(Boolean))].slice(0, 6);
}

function decisionKey(card: ScannerSignalCard): string {
  const blocking = (card.dataQuality?.issues ?? [])
    .filter((issue) => issue.severity === 'blocking')
    .map((issue) => issue.code)
    .sort()
    .join(',');
  return [
    card.signalState,
    card.direction,
    card.action ?? 'NONE',
    card.strongSignalEligible ? 'eligible' : 'blocked',
    card.signalGrade ?? 'NO_GRADE',
    card.dataState,
    card.riskLevel,
    card.themeSwing?.state ?? 'NO_THEME',
    blocking,
    (card.candidateRanking?.watchReasons ?? []).slice(0, 3).join('|'),
  ].join(':');
}

function recordKey(memberId: string, card: ScannerSignalCard): string {
  return `${memberId}:${card.signalId}`;
}

export function observeScannerDecisionHistory(
  memberId: string,
  cards: ScannerSignalCard[],
  now = Date.now(),
): ScannerSignalCard[] {
  for (const [key, record] of records) {
    if (now - record.lastSeenAt > RECORD_TTL_MS) records.delete(key);
  }

  return cards.map((card) => {
    const key = recordKey(memberId, card);
    const record = records.get(key);
    const decisionKeyValue = decisionKey(card);
    const priorHistory = record?.history ?? [];

    if (record?.lastDecisionKey === decisionKeyValue) {
      record.lastSeenAt = now;
      return { ...card, decisionHistory: priorHistory };
    }

    const entry: ScannerDecisionHistoryEntry = {
      sequence: (priorHistory.at(-1)?.sequence ?? 0) + 1,
      state: card.signalState,
      direction: card.direction,
      action: card.action ?? null,
      decision: decisionOutcome(card),
      eligible: card.strongSignalEligible,
      observedAt: new Date(now).toISOString(),
      reasons: decisionReasons(priorHistory.at(-1), card),
    };
    const history = [...priorHistory, entry].slice(-MAX_DECISION_HISTORY);
    records.set(key, { lastSeenAt: now, lastDecisionKey: decisionKeyValue, history });
    return { ...card, decisionHistory: history };
  });
}

export function clearScannerDecisionHistoryForTests(): void {
  records.clear();
}
