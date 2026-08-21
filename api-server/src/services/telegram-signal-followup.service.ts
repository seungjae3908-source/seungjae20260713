import type {
  ScannerAlertCandidate,
  ScannerSignalCard,
  ScannerSignalState,
} from './scanner-signal.types';
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

function prune(now: number): void {
  for (const [signalId, state] of announced) {
    if (now - state.lastSeenAt > LEDGER_TTL_MS) announced.delete(signalId);
  }
}

export function clearTelegramSignalFollowupState(): void {
  announced.clear();
}

export function markTelegramSignalAnnounced(alert: ScannerAlertCandidate, now = Date.now()): void {
  prune(now);
  announced.set(alert.signalId, {
    signalId: alert.signalId,
    expiresAt: alert.expiresAt,
    lastState: 'APPROVAL_PENDING',
    lastPrice: null,
    reachedTargets: new Set<number>(),
    stopReached: false,
    announcedAt: now,
    lastSeenAt: now,
  });
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
): Promise<void> {
  const cardBySignalId = new Map(cards.map((card) => [card.signalId, card]));
  for (const update of buildTelegramSignalFollowups(cards, now)) {
    const card = cardBySignalId.get(update.signalId);
    if (!card) continue;
    const destinationChatId = destinationFor(card);
    if (!destinationChatId) continue;
    await sender({
      type: 'intelligence_report',
      symbol: update.symbol,
      market: update.market,
      details: update.details,
      destinationChatId,
      dedupeKey: update.dedupeKey,
      duplicateWindowMs: 24 * 60 * 60_000,
      cooldownMs: 0,
    });
  }
}
