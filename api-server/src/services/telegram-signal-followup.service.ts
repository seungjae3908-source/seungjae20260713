import { logger } from '../lib/logger';
import type {
  ScannerAlertCandidate,
  ScannerSignalCard,
  ScannerSignalState,
} from './scanner-signal.types';
import {
  createTelegramSignalFollowupRepository,
  validateStoredTelegramSignalFollowupState,
  type StoredTelegramSignalFollowupState,
  type TelegramSignalFollowupRepository,
} from './telegram-signal-followup.repository';
import {
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
} from './telegram-notification.service';

export type TelegramSignalFollowupKind =
  | 'REARMED'
  | 'ENTRY_ZONE_LEFT'
  | 'TARGET_REACHED'
  | 'STOP_THRESHOLD_REACHED'
  | 'INVALIDATED'
  | 'EXPIRED';

export type TelegramSignalFollowup = {
  kind: TelegramSignalFollowupKind;
  signalId: string;
  symbol: string;
  market: string;
  details: string;
  dedupeKey: string;
};

type AnnouncedSignal = {
  signalId: string;
  expiresAt: string;
  lastState: ScannerSignalState;
  lastPrice: number | null;
  reachedTargets: Set<number>;
  stopReached: boolean;
  announcedAt: number;
  lastSeenAt: number;
};

const announced = new Map<string, AnnouncedSignal>();
const LEDGER_TTL_MS = 7 * 24 * 60 * 60_000;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function cloneState(state: AnnouncedSignal): AnnouncedSignal {
  return { ...state, reachedTargets: new Set(state.reachedTargets) };
}

function toStored(state: AnnouncedSignal): StoredTelegramSignalFollowupState {
  return validateStoredTelegramSignalFollowupState({
    ...state,
    reachedTargets: [...state.reachedTargets].sort((left, right) => left - right),
  });
}

function fromStored(state: StoredTelegramSignalFollowupState): AnnouncedSignal {
  const valid = validateStoredTelegramSignalFollowupState(state);
  return {
    ...valid,
    reachedTargets: new Set(valid.reachedTargets),
  };
}

function prune(now: number): void {
  for (const [signalId, state] of announced) {
    if (now - state.lastSeenAt > LEDGER_TTL_MS) announced.delete(signalId);
  }
}

async function hydrateFromDurableLedger(
  cards: readonly ScannerSignalCard[],
  repository: TelegramSignalFollowupRepository,
  now: number,
): Promise<void> {
  prune(now);
  const missingIds = [...new Set(cards.map((card) => card.signalId))]
    .filter((signalId) => !announced.has(signalId));
  if (!missingIds.length) return;

  await repository.pruneBefore(now - LEDGER_TTL_MS);
  const stored = await repository.list(missingIds);
  for (const state of stored) {
    const restored = fromStored(state);
    if (now - restored.lastSeenAt > LEDGER_TTL_MS) continue;
    announced.set(restored.signalId, restored);
  }
}

async function persistCurrentStates(
  signalIds: readonly string[],
  repository: TelegramSignalFollowupRepository,
): Promise<void> {
  const states = [...new Set(signalIds)]
    .map((signalId) => announced.get(signalId))
    .filter((state): state is AnnouncedSignal => Boolean(state))
    .map(toStored);
  await repository.save(states);
}

function restoreSnapshots(
  signalIds: readonly string[],
  snapshots: ReadonlyMap<string, AnnouncedSignal>,
): void {
  for (const signalId of new Set(signalIds)) {
    const snapshot = snapshots.get(signalId);
    if (snapshot) announced.set(signalId, cloneState(snapshot));
    else announced.delete(signalId);
  }
}

export function clearTelegramSignalFollowupState(): void {
  announced.clear();
}

export async function markTelegramSignalAnnounced(
  alert: ScannerAlertCandidate,
  now = Date.now(),
  repository: TelegramSignalFollowupRepository = createTelegramSignalFollowupRepository(),
): Promise<void> {
  prune(now);
  const state: AnnouncedSignal = {
    signalId: alert.signalId,
    expiresAt: alert.expiresAt,
    lastState: 'APPROVAL_PENDING',
    lastPrice: null,
    reachedTargets: new Set<number>(),
    stopReached: false,
    announcedAt: now,
    lastSeenAt: now,
  };
  await repository.save([toStored(state)]);
  announced.set(alert.signalId, state);
}

function crossedTarget(
  direction: ScannerSignalCard['direction'],
  current: number,
  previous: number | null,
  target: number,
): boolean {
  if (direction === 'LONG') return current >= target && (previous == null || previous < target);
  if (direction === 'SHORT') return current <= target && (previous == null || previous > target);
  return false;
}

function crossedStop(
  direction: ScannerSignalCard['direction'],
  current: number,
  previous: number | null,
  stop: number,
): boolean {
  if (direction === 'LONG') return current <= stop && (previous == null || previous > stop);
  if (direction === 'SHORT') return current >= stop && (previous == null || previous < stop);
  return false;
}

function stateEvent(
  card: ScannerSignalCard,
  previous: ScannerSignalState,
): { kind: TelegramSignalFollowupKind; details: string } | null {
  const current = card.signalState;
  if (!current || current === previous) return null;
  if (current === 'INVALIDATED') {
    return { kind: 'INVALIDATED', details: '🛑 Scanner 근거 또는 위험 조건이 무효 상태로 전환되었습니다.' };
  }
  if (current === 'EXPIRED') {
    return { kind: 'EXPIRED', details: '⌛ 신호 유효시간이 만료되었습니다. 새 신호 없이는 재사용하지 않습니다.' };
  }
  if (current === 'ARMED' && ['ENTRY_ZONE', 'APPROVAL_PENDING'].includes(previous)) {
    return { kind: 'ENTRY_ZONE_LEFT', details: '⚠️ 진입구간을 벗어나 재관찰 상태로 전환되었습니다.' };
  }
  if ((current === 'ENTRY_ZONE' || current === 'APPROVAL_PENDING') && previous === 'ARMED') {
    return { kind: 'REARMED', details: '✅ 조건이 회복되어 진입구간 감시 상태로 다시 전환되었습니다.' };
  }
  return null;
}

export function buildTelegramSignalFollowups(
  cards: readonly ScannerSignalCard[],
  now = Date.now(),
): TelegramSignalFollowup[] {
  prune(now);
  const updates: TelegramSignalFollowup[] = [];

  for (const card of cards) {
    const state = announced.get(card.signalId);
    if (!state) continue;
    state.lastSeenAt = now;

    if (finite(card.price)) {
      const targets = card.pricePlan.targets.filter((target) => finite(target) && target > 0);
      targets.forEach((target, index) => {
        if (state.reachedTargets.has(index)) return;
        if (!crossedTarget(card.direction, card.price, state.lastPrice, target)) return;
        state.reachedTargets.add(index);
        updates.push({
          kind: 'TARGET_REACHED',
          signalId: card.signalId,
          symbol: card.symbol,
          market: card.market,
          details: `🎯 TP${index + 1} 가격 기준 도달 · 현재가 ${card.price} · 기준 ${target}. 체결을 의미하지 않습니다.`,
          dedupeKey: `signal-followup:${card.signalId}:target:${index + 1}`,
        });
      });

      const stop = card.pricePlan.stopLoss;
      if (!state.stopReached && finite(stop) && stop > 0 && crossedStop(card.direction, card.price, state.lastPrice, stop)) {
        state.stopReached = true;
        updates.push({
          kind: 'STOP_THRESHOLD_REACHED',
          signalId: card.signalId,
          symbol: card.symbol,
          market: card.market,
          details: `🛑 손절 기준 가격 도달 · 현재가 ${card.price} · 기준 ${stop}. 실제 주문/체결을 의미하지 않습니다.`,
          dedupeKey: `signal-followup:${card.signalId}:stop`,
        });
      }
      state.lastPrice = card.price;
    }

    const lifecycle = stateEvent(card, state.lastState);
    if (lifecycle) {
      updates.push({
        kind: lifecycle.kind,
        signalId: card.signalId,
        symbol: card.symbol,
        market: card.market,
        details: lifecycle.details,
        dedupeKey: `signal-followup:${card.signalId}:state:${card.signalState}`,
      });
    }
    if (card.signalState) state.lastState = card.signalState;
    announced.set(card.signalId, state);
  }
  return updates;
}

function destinationFor(card: ScannerSignalCard): string | null {
  return card.assetClass === 'stock'
    ? process.env.TELEGRAM_STOCK_CHAT_ID?.trim() || null
    : process.env.TELEGRAM_CRYPTO_CHAT_ID?.trim() || null;
}

export async function deliverScannerTelegramFollowups(
  cards: readonly ScannerSignalCard[],
  sender: (input: TelegramAlertInput) => Promise<TelegramAlertResult> = sendTelegramAlert,
  now = Date.now(),
  repository: TelegramSignalFollowupRepository = createTelegramSignalFollowupRepository(),
): Promise<void> {
  if (process.env.TELEGRAM_SIGNAL_FOLLOWUP_ENABLED !== 'true') return;

  try {
    await hydrateFromDurableLedger(cards, repository, now);
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Telegram signal followup persistence unavailable; followups fail closed to avoid duplicate lifecycle alerts',
    );
    return;
  }

  const cardBySignalId = new Map(cards.map((card) => [card.signalId, card]));
  const snapshots = new Map<string, AnnouncedSignal>();
  for (const card of cards) {
    const state = announced.get(card.signalId);
    if (state) snapshots.set(card.signalId, cloneState(state));
  }

  const updates = buildTelegramSignalFollowups(cards, now);
  const signalIds = cards.map((card) => card.signalId);

  // A follow-up is never emitted unless the advanced lifecycle checkpoint is
  // durable first. This deliberately prefers at-most-once/fail-closed behavior
  // over a restart window where Telegram may receive the same follow-up twice.
  try {
    await persistCurrentStates(signalIds, repository);
  } catch (error) {
    restoreSnapshots(signalIds, snapshots);
    logger.warn(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Telegram signal followup checkpoint unavailable before delivery; transport skipped fail closed',
    );
    return;
  }

  const failedSignals = new Set<string>();

  for (const update of updates) {
    const card = cardBySignalId.get(update.signalId);
    if (!card) continue;
    const destinationChatId = destinationFor(card);
    if (!destinationChatId) {
      failedSignals.add(update.signalId);
      continue;
    }
    try {
      const result = await sender({
        type: 'intelligence_report',
        symbol: update.symbol,
        market: update.market,
        details: update.details,
        destinationChatId,
        dedupeKey: update.dedupeKey,
        duplicateWindowMs: 24 * 60 * 60_000,
        cooldownMs: 0,
      });
      if (!result.ok && result.skipped !== 'DUPLICATE') failedSignals.add(update.signalId);
    } catch (error) {
      failedSignals.add(update.signalId);
      logger.warn(
        { signalId: update.signalId, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'Telegram signal followup transport failed; restoring prior checkpoint when durable storage is available',
      );
    }
  }

  if (failedSignals.size === 0) return;

  restoreSnapshots([...failedSignals], snapshots);
  try {
    await persistCurrentStates([...failedSignals], repository);
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Telegram signal followup durable rollback unavailable; precommitted checkpoint remains fail closed across restart',
    );
  }
}
