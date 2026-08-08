import { createHash } from 'node:crypto';
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
  lastAlertKey: string | null;
};

type LegacyTradingLifecycleState =
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

function alertKey(signalId: string, expiresAt: string): string {
  return `scanner-alert:${createHash('sha256')
    .update(`${signalId}:APPROVAL_PENDING:${expiresAt}`)
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

function legacyTradingState(state: ScannerSignalState): LegacyTradingLifecycleState {
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
  return 'INVALIDATED';
}

function nextState(
  previousState: ScannerSignalState | null,
  card: ScannerSignalCard,
  now: number,
): ScannerSignalState {
  const previous = normalizedPrevious(previousState);
  if (Date.parse(card.expiresAt) <= now) return 'EXPIRED';
  if (previous && ORDER_OWNED_STATES.has(previous)) return previous;
  if (invalid(card)) return 'INVALIDATED';
  if (!card.strongSignalEligible) {
    return previous && ['CONFIRMED', 'ARMED', 'ENTRY_ZONE', 'APPROVAL_PENDING'].includes(previous)
      ? 'INVALIDATED'
      : 'CANDIDATE';
  }
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

export function clearScannerSignalLifecycleForTests(): void {
  records.clear();
}

export function getScannerLifecycleSnapshot(memberId: string, signalId: string) {
  const { baseSignalId, cycle } = splitSignalId(signalId);
  const record = records.get(lifecycleKey(memberId, baseSignalId));
  if (!record || record.cycle !== cycle) return null;
  return {
    signalId,
    state: record.state,
    observedAt: new Date(record.lastSeenAt).toISOString(),
  };
}

// Backward-compatible bridge for the existing Risk/Order execution snapshot.
// The Scanner owns its richer lifecycle, while the execution layer continues
// to receive only the legacy TradingSignalState-shaped contract it already understands.
export function getScannerSignalLifecycleSnapshot(memberId: string, signalId: string): {
  signalId: string;
  state: LegacyTradingLifecycleState;
  observedAt: string;
} | null {
  const snapshot = getScannerLifecycleSnapshot(memberId, signalId);
  if (!snapshot) return null;
  return {
    signalId: snapshot.signalId,
    state: legacyTradingState(snapshot.state),
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
    const baseSignalId = splitSignalId(card.signalId).baseSignalId;
    const key = lifecycleKey(memberId, baseSignalId);
    const existing = records.get(key);
    let cycle = existing?.cycle ?? 1;
    const existingState = normalizedPrevious(existing?.state ?? null);
    if (
      existing
      && existingState != null
      && SCANNER_TERMINAL_STATES.has(existingState)
      && card.strongSignalEligible
      && !['APPROVED', 'EXECUTING', 'PARTIALLY_FILLED', 'FILLED', 'MANAGING'].includes(existingState)
    ) {
      cycle += 1;
    }
    const resetCycle = !existing || cycle !== existing.cycle;
    const previous = resetCycle ? null : existingState;
    const state = nextState(previous, card, now);
    const confirmationStreak = card.strongSignalEligible
      ? resetCycle ? 1 : (existing?.confirmationStreak ?? 0) + 1
      : 0;
    const signalId = cycle === 1 ? baseSignalId : `${baseSignalId}:cycle:${cycle}`;
    const nextCard: ScannerSignalCard = { ...card, signalId, signalState: state };
    const idempotencyKey = alertKey(signalId, card.expiresAt);
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
      lastAlertKey,
    });
    return nextCard;
  });

  return { cards: updated, alerts };
}