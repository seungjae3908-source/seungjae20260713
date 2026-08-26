import {
  findMemberWatchlistSubscribers,
  type MemberWatchlistMarket,
  type MemberWatchlistSubscriber,
} from './member-watchlist.service';
import { deliverPersonalTelegramAlert } from './personal-telegram-alert.service';
import type {
  TelegramPolicyMarket,
  TelegramPolicySignalType,
} from './telegram-alert-policy.service';
import type { TelegramAlertInput } from './telegram-notification.service';

export type MemberWatchlistSignalEvent = {
  type: 'NEW_CANDIDATE' | 'STATE_CHANGED' | 'RESCAN_REQUESTED';
  id: string;
  serviceSha: string;
  market: MemberWatchlistMarket;
  symbol: string;
  strategy: string;
  timeframe: string;
  direction: 'BUY' | 'LONG' | 'SHORT' | null;
  validationTier?: 'RESEARCH_CANDIDATE' | 'FORWARD_VALIDATED' | 'CHAMPION';
  occurredAt: string;
};

type Finder = (market: MemberWatchlistMarket, symbol: string) => Promise<MemberWatchlistSubscriber[]>;
type Deliverer = typeof deliverPersonalTelegramAlert;

export type MemberWatchlistTelegramProducerDependencies = {
  findSubscribers?: Finder;
  deliver?: Deliverer;
};

export type MemberWatchlistTelegramProducerResult = {
  eligible: boolean;
  matched: number;
  attempted: number;
  delivered: number;
  skipped: number;
  failed: number;
  reason:
    | 'DISABLED'
    | 'INELIGIBLE'
    | 'NO_MATCH'
    | 'COMPLETE'
    | 'PARTIAL'
    | 'DELIVERY_FAILED'
    | 'STORAGE_UNAVAILABLE';
};

const MAX_MEMBER_WATCHLIST_DELIVERY_CONCURRENCY = 8;

export function memberWatchlistTelegramProducerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEMBER_WATCHLIST_TELEGRAM_PRODUCER_ENABLED === 'true';
}

function signalContract(event: MemberWatchlistSignalEvent): {
  market: TelegramPolicyMarket;
  signalType: TelegramPolicySignalType;
  alertType: TelegramAlertInput['type'];
} | null {
  if (event.type !== 'NEW_CANDIDATE') return null;
  if (event.market === 'KR_STOCK' && event.direction === 'BUY') {
    return { market: 'KR', signalType: 'BUY', alertType: 'strong_buy' };
  }
  if (event.market === 'US_STOCK' && event.direction === 'BUY') {
    return { market: 'US', signalType: 'BUY', alertType: 'strong_buy' };
  }
  if (event.market === 'CRYPTO_SPOT' && event.direction === 'BUY') {
    return { market: 'CRYPTO_SPOT', signalType: 'BUY', alertType: 'crypto_spot_buy' };
  }
  if (event.market === 'CRYPTO_FUTURES' && event.direction === 'LONG') {
    return { market: 'CRYPTO_FUTURES', signalType: 'LONG', alertType: 'crypto_futures_long' };
  }
  if (event.market === 'CRYPTO_FUTURES' && event.direction === 'SHORT') {
    return { market: 'CRYPTO_FUTURES', signalType: 'SHORT', alertType: 'crypto_futures_short' };
  }
  return null;
}

function tierLabel(tier: MemberWatchlistSignalEvent['validationTier']): string {
  if (tier === 'CHAMPION') return 'Champion 검증';
  if (tier === 'FORWARD_VALIDATED') return 'Forward 검증';
  return 'Research 후보 · 실전수익 미검증';
}

export async function deliverMemberWatchlistTelegramForSignal(
  event: MemberWatchlistSignalEvent,
  dependencies: MemberWatchlistTelegramProducerDependencies = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemberWatchlistTelegramProducerResult> {
  const empty = (reason: MemberWatchlistTelegramProducerResult['reason'], eligible = false): MemberWatchlistTelegramProducerResult => ({
    eligible,
    matched: 0,
    attempted: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
    reason,
  });
  if (!memberWatchlistTelegramProducerEnabled(env)) return empty('DISABLED');
  const contract = signalContract(event);
  if (!contract) return empty('INELIGIBLE');

  const findSubscribers = dependencies.findSubscribers ?? findMemberWatchlistSubscribers;
  const deliver = dependencies.deliver ?? deliverPersonalTelegramAlert;
  let subscribers: MemberWatchlistSubscriber[];
  try {
    subscribers = await findSubscribers(event.market, event.symbol);
  } catch {
    return { ...empty('STORAGE_UNAVAILABLE', true), failed: 1 };
  }
  if (subscribers.length === 0) return empty('NO_MATCH', true);

  const result: MemberWatchlistTelegramProducerResult = {
    eligible: true,
    matched: subscribers.length,
    attempted: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
    reason: 'COMPLETE',
  };
  const eventId = `member-watchlist:${event.serviceSha}:${event.id}`;
  const details = [
    '관심종목 신호',
    `${event.strategy}/${event.timeframe} · ${event.direction}`,
    tierLabel(event.validationTier),
    '실제 주문/체결 아님 · 주문 권한 없음',
  ].join('\n');

  for (let index = 0; index < subscribers.length; index += MAX_MEMBER_WATCHLIST_DELIVERY_CONCURRENCY) {
    const batch = subscribers.slice(index, index + MAX_MEMBER_WATCHLIST_DELIVERY_CONCURRENCY);
    result.attempted += batch.length;
    const settled = await Promise.allSettled(batch.map((subscriber) => deliver({
      userId: subscriber.userId,
      event: {
        userId: subscriber.userId,
        eventId,
        market: contract.market,
        signalType: contract.signalType,
        priority: 'IMPORTANT',
        symbol: event.symbol,
        occurredAt: event.occurredAt,
      },
      alert: {
        type: contract.alertType,
        symbol: event.symbol,
        market: event.market,
        details,
        timestamp: event.occurredAt,
        dedupeKey: eventId,
        duplicateWindowMs: 14 * 24 * 60 * 60 * 1000,
        cooldownMs: 0,
      },
      now: new Date(event.occurredAt),
    })));

    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        result.failed += 1;
        continue;
      }
      const dispatch = outcome.value;
      if (dispatch.status === 'SKIPPED') {
        if (dispatch.reason === 'STORAGE_UNAVAILABLE') result.failed += 1;
        else result.skipped += 1;
        continue;
      }
      if (dispatch.policy.decision.action !== 'IMMEDIATE') {
        result.skipped += 1;
        continue;
      }
      if (dispatch.policy.transport?.ok) result.delivered += 1;
      else result.failed += 1;
    }
  }

  if (result.failed === result.attempted) result.reason = 'DELIVERY_FAILED';
  else if (result.failed > 0) result.reason = 'PARTIAL';
  return result;
}
