import { createHash } from 'node:crypto';
import { scannerTimestampMs } from './scanner-data-quality.service';
import type {
  ScannerAlertCandidate,
  ScannerSignalCard,
  ScannerSignalState,
} from './scanner-signal.types';

type LifecycleRecord = {
  baseSignalId: string;
  cycle: number;
  state: ScannerSignalState;
  confirmationStreak: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastEvidenceAt: number;
  expiresAt: number;
  pricePlan: ScannerSignalCard['pricePlan'];
  lastAlertKey: string | null;
};

export type LegacyTradingLifecycleState =
  | 'DETECTED'
  | 'WATCHING'
  | 'READY_FOR_APPROVAL'
  | 'WEAKENED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'approved';

const records = new Map<string, LifecycleRecord>();
const RECORD_TTL_MS = 7 * 24 * 60 * 60_000;
const SCANNER_TERMINAL_STATES = new Set<ScannerSignalState>([
  'INVALIDATED',
  'EXPIRED',
  'REJECTED',
  'CANCELLED',
  'CLOSED',
]);
const ORDER_OWNED_STATES = new Set<ScannerSignalState>([
  'APPROVED',
  'EXECUTING',
  'PARTIALLY_FILLED',
  'FILLED',
  'MANAGING',
  'CLOSED',
  'REJECTED',
  'CANCELLED',
]);

function alertKey(signalId: string): string {
  return `scanner-alert:${createHash('sha256')
    .update(`${signalId}:APPROVAL_PENDING`)
    .digest('hex')
    .slice(0, 32)}`;
}

function lifecycleKey(memberId: string, baseSignalId: string): string {
  return `${memberId}:${baseSignalId}`;
}

function invalid(card: ScannerSignalCard): boolean {
  return card.dataState === 'unavailable'
    || card.dataState === 'untrusted'
    || card.dataQuality?.state === 'DATA_UNTRUSTED'
    || card.dataQuality?.strongSignalAllowed === false
    || (card.riskScore != null && card.riskScore >= 80)
    || card.listingStatus === 'UNKNOWN' && card.dataState !== 'complete';
}

function insideEntryZone(card: ScannerSignalCard): boolean {
  const zone = card.pricePlan.entryZone;
  if (!zone || !Number.isFinite(card.price)) return false;
  const low = Math.min(zone.from, zone.to);
  const high = Math.max(zone.from, zone.to);
  return card.price >= low && card.price <= high;
}

function normalizedPrevious(previous: ScannerSignalState | null): ScannerSignalState | null {
  if (previous === 'DETECTED') return 'CANDIDATE';
  if (previous === 'WATCHING') return 'CONFIRMED';
  if (previous === 'READY_FOR_APPROVAL') return 'APPROVAL_PENDING';
  if (previous === 'WEAKENED') return 'INVALIDATED';
  return previous;
}

export function scannerLifecycleStateForRiskBridge(state: ScannerSignalState | string): LegacyTradingLifecycleState {
  if (state === 'CANDIDATE' || state === 'DETECTED') return 'DETECTED';
  if (state === 'CONFIRMED' || state === 'ARMED' || state === 'ENTRY_ZONE' || state === 'WATCHING') {
    return 'WATCHING';
  }
  if (state === 'APPROVAL_PENDING' || state === 'READY_FOR_APPROVAL') return 'READY_FOR_APPROVAL';
  if (state === 'APPROVED' || state === 'EXECUTING' || state === 'PARTIALLY_FILLED' || state === 'FILLED' || state === 'MANAGING') {
    return 'approved';
  }
  if (state === 'EXPIRED') return 'EXPIRED';
  if (state === 'WEAKENED') return 'WEAKENED';
  // CLOSED/INVALIDATED/REJECTED/CANCELLED and every unknown/future state are
  // deliberately non-executable at the Scanner -> Risk/Order compatibility boundary.
  return 'INVALIDATED';
}

function nextState(
  previousState: ScannerSignalState | null,
  card: ScannerSignalCard,
  now: number,
  freshEvidence: boolean,
): ScannerSignalState {
  const previous = normalizedPrevious(previousState);
  if (previous && ORDER_OWNED_STATES.has(previous)) return previous;
  if (!Number.isFinite(Date.parse(card.expiresAt)) || Date.parse(card.expiresAt) <= now) return 'EXPIRED';
  if (invalid(card)) return 'INVALIDATED';
  if (!card.strongSignalEligible) {
    return previous && ['CONFIRMED', 'ARMED', 'ENTRY_ZONE', 'APPROVAL_PENDING'].includes(previous)
      ? 'INVALIDATED'
      : 'CANDIDATE';
  }
  if (!freshEvidence) return previous ?? 'CANDIDATE';
  if (previous == null || previous === 'INVALIDATED' || previous === 'EXPIRED') return 'CANDIDATE';
  if (previous === 'CANDIDATE') return 'CONFIRMED';
  if (previous === 'CONFIRMED') return 'ARMED';
  if (previous === 'ARMED') return insideEntryZone(card) ? 'ENTRY_ZONE' : 'ARMED';
  if (previous === 'ENTRY_ZONE') return insideEntryZone(card) ? 'APPROVAL_PENDING' : 'ARMED';
  if (previous === 'APPROVAL_PENDING') return insideEntryZone(card) ? 'APPROVAL_PENDING' : 'ARMED';
  return 'CANDIDATE';
}

function alertFrom(card: ScannerSignalCard, idempotencyKey: string): ScannerAlertCandidate {
  return {
    idempotencyKey,
    signalId: card.signalId,
    assetClass: card.assetClass,
    market: card.market,
    symbol: card.symbol,
    direction: card.direction,
    state: 'APPROVAL_PENDING',
    entryZone: card.pricePlan.entryZone,
    stopLoss: card.pricePlan.stopLoss,
    targets: card.pricePlan.targets,
    expiresAt: card.expiresAt,
    evidence: card.evidence
      .filter((item) => item.status === 'matched')
      .flatMap((item) => item.reasons)
      .slice(0, 8),
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function splitSignalId(signalId: string): { baseSignalId: string; cycle: number } {
  const cycleMarker = ':cycle:';
  const markerIndex = signalId.lastIndexOf(cycleMarker);
  return {
    baseSignalId: markerIndex >= 0 ? signalId.slice(0, markerIndex) : signalId,
    cycle: markerIndex >= 0 ? Number(signalId.slice(markerIndex + cycleMarker.length)) : 1,
  };
}

function strategyScopedBaseSignalId(card: ScannerSignalCard): string {
  const baseSignalId = splitSignalId(card.signalId).baseSignalId;
  if (!card.strategyMode || baseSignalId.includes(':strategy:')) return baseSignalId;
  return `${baseSignalId}:strategy:${card.strategyMode}`;
}

export function clearScannerSignalLifecycleForTests(): void {
  records.clear();
}

export function getScannerLifecycleSnapshot(memberId: string, signalId: string, now = Date.now()) {
  const { baseSignalId, cycle } = splitSignalId(signalId);
  const record = records.get(lifecycleKey(memberId, baseSignalId));
  if (!record || record.cycle !== cycle) return null;
  return {
    signalId,
    state: record.expiresAt <= now && !ORDER_OWNED_STATES.has(record.state) ? 'EXPIRED' : record.state,
    observedAt: new Date(record.lastEvidenceAt).toISOString(),
  };
}

// Backward-compatible, one-way bridge for the existing Risk/Order execution snapshot.
// The Scanner owns its richer lifecycle; unknown/future states fail closed.
export function getScannerSignalLifecycleSnapshot(memberId: string, signalId: string, now = Date.now()): {
  signalId: string;
  state: LegacyTradingLifecycleState;
  observedAt: string;
} | null {
  const snapshot = getScannerLifecycleSnapshot(memberId, signalId, now);
  if (!snapshot) return null;
  return {
    signalId: snapshot.signalId,
    state: scannerLifecycleStateForRiskBridge(snapshot.state),
    observedAt: snapshot.observedAt,
  };
}

export function setScannerExternalLifecycleState(
  memberId: string,
  signalId: string,
  state: Extract<ScannerSignalState,
    | 'APPROVED'
    | 'EXECUTING'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'MANAGING'
    | 'CLOSED'
    | 'REJECTED'
    | 'CANCELLED'>,
  now = Date.now(),
): boolean {
  if (!ORDER_OWNED_STATES.has(state)) return false;
  const { baseSignalId, cycle } = splitSignalId(signalId);
  const key = lifecycleKey(memberId, baseSignalId);
  const record = records.get(key);
  if (!record || record.cycle !== cycle) return false;
  record.state = state;
  record.lastSeenAt = now;
  records.set(key, record);
  return true;
}

export function applyScannerSignalLifecycle(
  memberId: string,
  cards: ScannerSignalCard[],
  now = Date.now(),
): { cards: ScannerSignalCard[]; alerts: ScannerAlertCandidate[] } {
  for (const [key, record] of records) {
    if (now - record.lastSeenAt > RECORD_TTL_MS) records.delete(key);
  }

  const alerts: ScannerAlertCandidate[] = [];
  const updated = cards.map((card) => {
    const baseSignalId = strategyScopedBaseSignalId(card);
    const key = lifecycleKey(memberId, baseSignalId);
    const existing = records.get(key);
    const observed = card.evidence.find((item) => item.key === 'data-quality')?.observedAt ?? card.observedAt;
    const evidenceAt = scannerTimestampMs(observed);
    const validEvidence = evidenceAt != null && evidenceAt <= now;
    const freshEvidence = validEvidence && (!existing || evidenceAt > existing.lastEvidenceAt);
    let cycle = existing?.cycle ?? 1;
    const existingState = normalizedPrevious(existing?.state ?? null);
    if (
      existing
      && existingState != null
      && SCANNER_TERMINAL_STATES.has(existingState)
      && card.strongSignalEligible
      && freshEvidence
      && !['APPROVED', 'EXECUTING', 'PARTIALLY_FILLED', 'FILLED', 'MANAGING'].includes(existingState)
    ) {
      cycle += 1;
    }
    const resetCycle = !existing || cycle !== existing.cycle;
    const previous = resetCycle ? null : existingState;
    const expiresAt = resetCycle ? Date.parse(card.expiresAt) : existing!.expiresAt;
    const pricePlan = structuredClone(resetCycle ? card.pricePlan : existing!.pricePlan);
    const stableCard = { ...card, expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : '', pricePlan };
    const state = nextState(previous, validEvidence ? stableCard : { ...stableCard, dataState: 'untrusted' }, now, freshEvidence);
    const confirmationStreak = card.strongSignalEligible
      ? resetCycle ? 1 : (existing?.confirmationStreak ?? 0) + (freshEvidence ? 1 : 0)
      : 0;
    const signalId = cycle === 1 ? baseSignalId : `${baseSignalId}:cycle:${cycle}`;
    const nextCard: ScannerSignalCard = { ...stableCard, signalId, signalState: state,
      strongSignalEligible: card.strongSignalEligible && !SCANNER_TERMINAL_STATES.has(state) };
    const idempotencyKey = alertKey(signalId);
    let lastAlertKey = resetCycle ? null : existing?.lastAlertKey ?? null;
    if (state === 'APPROVAL_PENDING' && lastAlertKey !== idempotencyKey) {
      alerts.push(alertFrom(nextCard, idempotencyKey));
      lastAlertKey = idempotencyKey;
    }
    records.set(key, {
      baseSignalId,
      cycle,
      state,
      confirmationStreak,
      firstSeenAt: resetCycle ? now : existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastEvidenceAt: validEvidence ? Math.max(evidenceAt, resetCycle ? 0 : existing!.lastEvidenceAt) : resetCycle ? now : existing!.lastEvidenceAt,
      expiresAt,
      pricePlan: structuredClone(pricePlan),
      lastAlertKey,
    });
    return nextCard;
  });

  return { cards: updated, alerts };
}
