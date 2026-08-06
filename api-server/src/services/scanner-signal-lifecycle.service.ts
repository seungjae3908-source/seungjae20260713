import { createHash } from 'node:crypto';
import { enrichScannerMarketAction } from './scanner-market-action.service';
import { applyScannerApprovalSafety } from './scanner-market-approval-safety.service';
import type {
  ScannerAlertCandidate,
  ScannerSignalCard,
  ScannerSignalState,
} from './scanner-signal.types';

type LifecycleRecord = {
  baseSignalId: string;
  cycle: number;
  state: ScannerSignalState;
  readyStreak: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastAlertKey: string | null;
};

const records = new Map<string, LifecycleRecord>();
const RECORD_TTL_MS = 7 * 24 * 60 * 60_000;

function alertKey(signalId: string, expiresAt: string): string {
  return `scanner-alert:${createHash('sha256')
    .update(`${signalId}:READY_FOR_APPROVAL:${expiresAt}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function lifecycleKey(memberId: string, baseSignalId: string): string {
  return `${memberId}:${baseSignalId}`;
}

function approvalEligible(card: ScannerSignalCard): boolean {
  return card.marketApprovalEligible ?? card.strongSignalEligible;
}

function invalid(card: ScannerSignalCard): boolean {
  return card.dataState === 'unavailable'
    || (card.riskScore != null && card.riskScore >= 80)
    || card.listingStatus === 'UNKNOWN' && card.dataState !== 'complete';
}

function nextState(
  previous: ScannerSignalState | null,
  readyStreak: number,
  card: ScannerSignalCard,
  now: number,
): ScannerSignalState {
  if (Date.parse(card.expiresAt) <= now) return 'EXPIRED';
  if (invalid(card)) return 'INVALIDATED';
  if (approvalEligible(card)) {
    if (readyStreak <= 1) return 'DETECTED';
    if (readyStreak === 2) return 'WATCHING';
    return 'READY_FOR_APPROVAL';
  }
  if (previous === 'READY_FOR_APPROVAL' || previous === 'WATCHING') return 'WEAKENED';
  return 'DETECTED';
}

function alertFrom(card: ScannerSignalCard, idempotencyKey: string): ScannerAlertCandidate | null {
  if (
    !card.marketClass
    || !card.action
    || card.action === 'NONE'
    || !card.executionIntent
    || card.executionIntent === 'NO_ACTION'
    || !card.strategy
    || !card.regime
    || !card.modelVersion
    || !card.performanceKey
    || !card.approvalPolicyVersion
    || !card.approvalPolicyStatus
    || !card.chaseRisk
  ) return null;
  return {
    idempotencyKey,
    signalId: card.signalId,
    assetClass: card.assetClass,
    market: card.market,
    symbol: card.symbol,
    direction: card.direction,
    marketClass: card.marketClass,
    action: card.action,
    executionIntent: card.executionIntent,
    strategy: card.strategy,
    regime: card.regime,
    modelVersion: card.modelVersion,
    performanceKey: card.performanceKey,
    approvalPolicyVersion: card.approvalPolicyVersion,
    approvalPolicyStatus: card.approvalPolicyStatus,
    chaseRisk: card.chaseRisk,
    requiresExistingPosition: card.requiresExistingPosition === true,
    state: 'READY_FOR_APPROVAL',
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

export function clearScannerSignalLifecycleForTests(): void {
  records.clear();
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
  const updated = cards.map((rawCard) => {
    const card = applyScannerApprovalSafety(enrichScannerMarketAction(rawCard), now);
    const baseSignalId = card.signalId;
    const key = lifecycleKey(memberId, baseSignalId);
    const existing = records.get(key);
    let cycle = existing?.cycle ?? 1;
    if (
      existing
      && ['WEAKENED', 'INVALIDATED', 'EXPIRED'].includes(existing.state)
      && approvalEligible(card)
    ) {
      cycle += 1;
    }
    const resetCycle = !existing || cycle !== existing.cycle;
    const readyStreak = approvalEligible(card)
      ? resetCycle ? 1 : (existing?.readyStreak ?? 0) + 1
      : 0;
    const state = nextState(resetCycle ? null : existing?.state ?? null, readyStreak, card, now);
    const signalId = cycle === 1 ? baseSignalId : `${baseSignalId}:cycle:${cycle}`;
    const nextCard: ScannerSignalCard = { ...card, signalId, signalState: state };
    const idempotencyKey = alertKey(signalId, card.expiresAt);
    let lastAlertKey = resetCycle ? null : existing?.lastAlertKey ?? null;
    if (state === 'READY_FOR_APPROVAL' && lastAlertKey !== idempotencyKey) {
      const alert = alertFrom(nextCard, idempotencyKey);
      if (alert) {
        alerts.push(alert);
        lastAlertKey = idempotencyKey;
      }
    }
    records.set(key, {
      baseSignalId,
      cycle,
      state,
      readyStreak,
      firstSeenAt: resetCycle ? now : existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastAlertKey,
    });
    return nextCard;
  });

  return { cards: updated, alerts };
}
