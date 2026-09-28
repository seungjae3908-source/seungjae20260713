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
  editTelegramMessage,
  escapeTelegramHtml,
  normalizeTelegramHttpUrl,
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
  type TelegramMessageKind,
  type TelegramUrlButton,
} from './telegram-notification.service';
import { buildTelegramSignalAppButtons } from './telegram-investment-intelligence.service';
import {
  telegramMarketRoomChatId,
  telegramMarketRoomForLane,
} from './telegram-market-room.service';

export type TelegramSignalFollowupKind =
  | 'REARMED'
  | 'ENTRY_ZONE_LEFT'
  | 'TARGET_REACHED'
  | 'STOP_THRESHOLD_REACHED'
  | 'APPROVED'
  | 'EXECUTING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CLOSED'
  | 'REJECTED'
  | 'CANCELLED'
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
  telegramMessageId?: number;
  telegramMessageKind?: TelegramMessageKind;
  baseMessageText?: string;
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
  receipt?: {
    messageId: number | null;
    messageKind: TelegramMessageKind;
    renderedText: string;
  } | null,
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
    ...(receipt?.messageId != null && receipt.renderedText.trim()
      ? {
          telegramMessageId: receipt.messageId,
          telegramMessageKind: receipt.messageKind,
          baseMessageText: receipt.renderedText,
        }
      : {}),
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
    return { kind: 'INVALIDATED', details: '🔴 기존 진입 조건이 무효화되었습니다. 주문 버튼을 비활성화합니다.' };
  }
  if (current === 'EXPIRED') {
    return { kind: 'EXPIRED', details: '⌛ 신호 유효시간이 만료되었습니다. 주문 버튼을 비활성화합니다.' };
  }
  if (current === 'CANCELLED') {
    return { kind: 'CANCELLED', details: '⛔ 신호 또는 주문 준비가 취소되었습니다. 새 활성 신호 전에는 주문하지 않습니다.' };
  }
  if (current === 'REJECTED') {
    return { kind: 'REJECTED', details: '⛔ 현재 진입 조건이 거절되었습니다. 주문 버튼을 비활성화합니다.' };
  }
  if (current === 'CLOSED') {
    return { kind: 'CLOSED', details: '🏁 포지션이 종료되었습니다. 기존 진입 버튼을 제거합니다.' };
  }
  if (current === 'FILLED') {
    return { kind: 'FILLED', details: '✅ 체결 상태가 확인되어 중복 주문 버튼을 제거합니다.' };
  }
  if (current === 'PARTIALLY_FILLED') {
    return { kind: 'PARTIALLY_FILLED', details: '🔵 부분 체결 상태입니다. 중복 주문을 막기 위해 주문 버튼을 제거합니다.' };
  }
  if (current === 'EXECUTING') {
    return { kind: 'EXECUTING', details: '🟦 주문 처리 중입니다. 중복 주문을 막기 위해 주문 버튼을 제거합니다.' };
  }
  if (current === 'APPROVED') {
    return { kind: 'APPROVED', details: '✅ 주문 승인이 확인되었습니다. 중복 주문을 막기 위해 주문 버튼을 제거합니다.' };
  }
  if (current === 'ARMED' && ['ENTRY_ZONE', 'APPROVAL_PENDING', 'READY_FOR_APPROVAL'].includes(previous)) {
    return { kind: 'ENTRY_ZONE_LEFT', details: '🟡 진입구간을 벗어나 관망 상태로 전환되었습니다. 주문 버튼을 비활성화합니다.' };
  }
  if ((current === 'ENTRY_ZONE' || current === 'APPROVAL_PENDING' || current === 'READY_FOR_APPROVAL') && previous === 'ARMED') {
    return { kind: 'REARMED', details: '🟢 조건이 회복되어 진입 신호가 다시 활성화되었습니다.' };
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

function publicStatusLabel(
  card: ScannerSignalCard,
  state: AnnouncedSignal,
  updates: readonly TelegramSignalFollowup[],
): string {
  const signal = card.assetClass === 'coin_futures'
    ? (card.direction === 'SHORT' ? 'SHORT' : 'LONG')
    : '매수';
  if (state.stopReached || updates.some((update) => update.kind === 'STOP_THRESHOLD_REACHED')) return '🔴 손절 기준 도달 · 주문 비활성';
  if (card.signalState === 'INVALIDATED' || updates.some((update) => update.kind === 'INVALIDATED')) return `🔴 ${signal} 신호 무효 · 주문 비활성`;
  if (card.signalState === 'EXPIRED' || updates.some((update) => update.kind === 'EXPIRED')) return `⌛ ${signal} 신호 만료 · 주문 비활성`;
  if (card.signalState === 'CANCELLED' || card.signalState === 'REJECTED') return `⛔ ${signal} 신호 종료 · 주문 비활성`;
  if (card.signalState === 'APPROVED' || card.signalState === 'EXECUTING' || card.signalState === 'PARTIALLY_FILLED') return '🟦 주문 진행 중 · 중복 주문 비활성';
  if (card.signalState === 'FILLED' || card.signalState === 'MANAGING') return '✅ 체결/보유중 · 중복 주문 비활성';
  if (card.signalState === 'CLOSED') return '🏁 포지션 종료 · 주문 비활성';
  const reached = [...state.reachedTargets].sort((left, right) => left - right);
  if (reached.length) return `🎯 TP${reached.at(-1)! + 1} 도달`;
  if (card.signalState === 'ENTRY_ZONE' || card.signalState === 'APPROVAL_PENDING' || card.signalState === 'READY_FOR_APPROVAL') {
    return `🟢 ${signal} 활성`;
  }
  return '🟡 관망 · 주문 비활성';
}

function editedSignalMessage(
  card: ScannerSignalCard,
  state: AnnouncedSignal,
  updates: readonly TelegramSignalFollowup[],
  now: number,
): string {
  const reachedTargets = new Set(state.reachedTargets);
  const targetLine = card.pricePlan.targets.slice(0, 3).map((target, index) => (
    `TP${index + 1} ${escapeTelegramHtml(target)} ${reachedTargets.has(index) ? '✅' : '·'}`
  )).join(' · ') || 'TP N/A';
  const entry = card.pricePlan.entryZone
    ? `${escapeTelegramHtml(card.pricePlan.entryZone.from)}~${escapeTelegramHtml(card.pricePlan.entryZone.to)}`
    : 'N/A';
  const stop = card.pricePlan.stopLoss == null ? 'N/A' : escapeTelegramHtml(card.pricePlan.stopLoss);
  const price = finite(card.price) ? escapeTelegramHtml(card.price) : 'N/A';
  const stateDetail = updates
    .map((update) => update.details)
    .find((details) => /주문 버튼|진입구간|체결|포지션|만료|무효|취소|거절/u.test(details));
  const dynamic = [
    '<b>현재 상태</b>',
    publicStatusLabel(card, state, updates),
    stateDetail ? escapeTelegramHtml(stateDetail) : null,
    `현재가 ${price}`,
    `진입 ${entry}`,
    targetLine,
    `Stop ${stop} ${state.stopReached ? '🛑' : ''}`,
  ].filter(Boolean).join('\n');

  const limit = state.telegramMessageKind === 'PHOTO' ? 1_024 : 4_096;
  const rawBase = state.baseMessageText ?? '';
  const orderEnabled = lifecycleOrderEnabled(card, state, now);
  const base = orderEnabled
    ? rawBase.replace(/🔴 기존 신호:/gu, '🟢 신호:').replace(/🟡 기존 신호:/gu, '🟢 신호:')
    : card.signalState === 'INVALIDATED' || card.signalState === 'EXPIRED' || card.signalState === 'REJECTED' || card.signalState === 'CANCELLED' || state.stopReached
      ? rawBase.replace(/🟢 신호:/gu, '🔴 기존 신호:')
      : rawBase.replace(/🟢 신호:/gu, '🟡 기존 신호:');
  if (base.length + dynamic.length + 2 <= limit) return `${dynamic}\n\n${base}`;

  return [
    `<b>${escapeTelegramHtml(card.symbol)} · 신호 업데이트</b>`,
    `시장 ${escapeTelegramHtml(card.market)}`,
    dynamic.trimStart(),
  ].join('\n').slice(0, limit);
}

function destinationFor(card: ScannerSignalCard): string | null {
  const lane = card.assetClass === 'coin_spot'
    ? 'CRYPTO_SPOT'
    : card.assetClass === 'coin_futures'
      ? 'CRYPTO_FUTURES'
      : card.market.trim().toUpperCase().includes('US')
        ? 'US_STOCK'
        : 'KR_STOCK';
  return telegramMarketRoomChatId(
    telegramMarketRoomForLane(lane),
    process.env,
    { allowLegacyFallback: true },
  );
}

function lifecycleTimeframe(card: ScannerSignalCard, state: AnnouncedSignal): string {
  const base = state.baseMessageText ?? '';
  const match = base.match(/(?:신호:[^\n]*·\s*)(1m|3m|5m|15m|30m|60m|1H|4H|6H|12H|1D|1W|1M)\b/u);
  if (match?.[1]) return match[1];
  if (card.strategyMode === 'scalping') return '15m';
  if (card.strategyMode === 'swing') return '60m';
  return '1D';
}

function lifecycleOrderEnabled(card: ScannerSignalCard, state: AnnouncedSignal, now: number): boolean {
  if (!['ENTRY_ZONE', 'APPROVAL_PENDING', 'READY_FOR_APPROVAL'].includes(card.signalState)) return false;
  if (state.stopReached || state.reachedTargets.size > 0) return false;
  if (card.dataState !== 'complete' || card.strongSignalEligible !== true) return false;
  if (card.direction !== 'LONG' && card.direction !== 'SHORT') return false;
  const expiresAt = Date.parse(card.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const zone = card.pricePlan.entryZone;
  if (!zone || !finite(card.price)) return false;
  const low = Math.min(zone.from, zone.to);
  const high = Math.max(zone.from, zone.to);
  return card.price >= low && card.price <= high;
}

function lifecycleButtons(card: ScannerSignalCard, state: AnnouncedSignal, now: number): TelegramUrlButton[][] {
  const context = {
    timeframe: lifecycleTimeframe(card, state),
    strategyMode: card.strategyMode ?? 'swing',
  } as const;
  const buttons = buildTelegramSignalAppButtons(card, context, {
    orderEnabled: lifecycleOrderEnabled(card, state, now),
    displayName: card.name,
  });
  const base = normalizeTelegramHttpUrl(process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL);
  if (!base) return buttons;
  const url = new URL(base);
  const detail = card.assetClass === 'stock'
    ? new URL('/stock-info', url)
    : new URL(card.assetClass === 'coin_futures' ? '/coins/futures' : '/coins/spot', url);
  detail.searchParams.set('symbol', card.symbol);
  if (card.assetClass === 'stock') {
    detail.searchParams.set('ticker', card.symbol);
    detail.searchParams.set('market', card.market.toUpperCase().includes('US') ? 'US' : 'KR');
    detail.searchParams.set('tab', 'news');
  }
  buttons.push([{ text: card.assetClass === 'stock' ? '📰 뉴스·공시' : '📰 뉴스', url: detail.toString() }]);
  return buttons;
}

export async function deliverScannerTelegramFollowups(
  cards: readonly ScannerSignalCard[],
  sender: (input: TelegramAlertInput) => Promise<TelegramAlertResult> = sendTelegramAlert,
  now = Date.now(),
  repository: TelegramSignalFollowupRepository = createTelegramSignalFollowupRepository(),
  editor: typeof editTelegramMessage = editTelegramMessage,
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
  const updatesBySignal = new Map<string, TelegramSignalFollowup[]>();
  for (const update of updates) {
    const list = updatesBySignal.get(update.signalId) ?? [];
    list.push(update);
    updatesBySignal.set(update.signalId, list);
  }

  for (const [signalId, signalUpdates] of updatesBySignal) {
    const card = cardBySignalId.get(signalId);
    const state = announced.get(signalId);
    if (!card || !state) continue;
    const destinationChatId = destinationFor(card);
    if (!destinationChatId) {
      failedSignals.add(signalId);
      continue;
    }

    if (
      state.telegramMessageId != null
      && state.telegramMessageKind != null
      && state.baseMessageText
    ) {
      try {
        const result = await editor({
          destinationChatId,
          messageId: state.telegramMessageId,
          messageKind: state.telegramMessageKind,
          text: editedSignalMessage(card, state, signalUpdates, now),
          buttons: lifecycleButtons(card, state, now),
          linkPreview: false,
        });
        if (!result.ok) failedSignals.add(signalId);
      } catch (error) {
        failedSignals.add(signalId);
        logger.warn(
          { signalId, errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Telegram signal edit-in-place failed; restoring prior checkpoint for retry',
        );
      }
      continue;
    }

    if (process.env.NODE_ENV === 'production') {
      logger.warn(
        { signalId },
        'Telegram signal followup has no message receipt; legacy public alert is not duplicated',
      );
      continue;
    }

    for (const update of signalUpdates) {
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
        if (!result.ok && result.skipped !== 'DUPLICATE') failedSignals.add(signalId);
      } catch (error) {
        failedSignals.add(signalId);
        logger.warn(
          { signalId, errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Telegram signal followup transport failed; restoring prior checkpoint when durable storage is available',
        );
      }
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
