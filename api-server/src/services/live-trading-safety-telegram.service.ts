/**
 * Personal Telegram alerts for real-money safety events (owner's own chat only).
 *
 * - The owner turned a market's real-order switch ON or OFF.
 * - A LIVE order was refused by a loss limit (daily / weekly / consecutive losses)
 *   or by the first-week order cap. One alert per user, rule and KST day.
 *
 * Fills, take-profit and stop fills are already sent by the execution event bridge.
 * Alerts are best-effort: a Telegram or storage failure never changes trading.
 */
import { deliverPersonalTelegramAlert } from './personal-telegram-alert.service';
import type { TelegramPolicyMarket } from './telegram-alert-policy.service';
import type { TradingAssetClass, TradingPlanInput } from './trade-automation.types';

type Deliver = typeof deliverPersonalTelegramAlert;

const MARKET_LABEL: Record<TradingAssetClass, string> = {
  domestic_stock: '국내주식',
  us_stock: '미국주식',
  crypto_spot: '코인현물',
  crypto_futures: '코인선물',
};
const POLICY_MARKET: Record<TradingAssetClass, TelegramPolicyMarket> = {
  domestic_stock: 'KR',
  us_stock: 'US',
  crypto_spot: 'CRYPTO_SPOT',
  crypto_futures: 'CRYPTO_FUTURES',
};

export const LIVE_SAFETY_ALERT_CODES = Object.freeze({
  DAILY_LOSS_LIMIT: '일일 손실 한도에 도달해 오늘 새 실거래 주문을 막았습니다.',
  WEEKLY_LOSS_LIMIT: '주간 손실 한도에 도달해 새 실거래 주문을 막았습니다.',
  CONSECUTIVE_LOSS_LIMIT: '연속 손실 한도에 도달해 새 실거래 주문을 막았습니다.',
  LIVE_FIRST_WEEK_ORDER_CAP: '실거래를 켠 첫 7일이라 10만 원이 넘는 주문을 막았습니다.',
} as const);

function kstDay(now: Date) {
  return new Date(now.getTime() + (9 * 3_600_000)).toISOString().slice(0, 10);
}

export function assetClassOfPlan(plan: Pick<TradingPlanInput, 'exchange' | 'market'>): TradingAssetClass {
  if (plan.exchange === 'bitget') return 'crypto_futures';
  if (plan.exchange === 'upbit') return 'crypto_spot';
  return plan.market.toUpperCase() === 'US' ? 'us_stock' : 'domestic_stock';
}

/** Pure: which safety alerts a refused plan should raise (LIVE entries only). */
export function liveSafetyAlertCodes(plan: Pick<TradingPlanInput, 'accountMode'>, blockCodes: readonly string[]) {
  if (plan.accountMode !== 'live') return [];
  return (Object.keys(LIVE_SAFETY_ALERT_CODES) as Array<keyof typeof LIVE_SAFETY_ALERT_CODES>)
    .filter((code) => blockCodes.includes(code));
}

export async function notifyLiveMarketSwitch(
  input: { userId: string; market: TradingAssetClass; enabled: boolean; now?: Date },
  deliver: Deliver = deliverPersonalTelegramAlert,
) {
  const now = input.now ?? new Date();
  const eventId = `live-switch:${input.userId}:${input.market}:${input.enabled ? 'on' : 'off'}:${now.getTime()}`;
  try {
    return await deliver({
      userId: input.userId,
      event: {
        userId: input.userId, eventId, market: POLICY_MARKET[input.market],
        signalType: 'STRATEGY_HEALTH', priority: 'CRITICAL', occurredAt: now.toISOString(),
      },
      alert: {
        type: 'system_critical',
        title: `${MARKET_LABEL[input.market]} 실거래 ${input.enabled ? '켜짐' : '꺼짐'}`,
        details: input.enabled
          ? '이 시장에서 실제 주문이 나갈 수 있습니다. 첫 7일은 1회 10만 원 이하로 제한됩니다. 설정에서 언제든 끌 수 있습니다.'
          : '이 시장의 새 실거래 주문을 멈췄습니다. 보유 포지션 청산은 계속 가능합니다.',
        timestamp: now.toISOString(),
        dedupeKey: eventId,
        cooldownMs: 0,
      },
      now,
    });
  } catch {
    return null;
  }
}

export async function notifyLiveSafetyBlock(
  input: { userId: string; plan: Pick<TradingPlanInput, 'accountMode' | 'exchange' | 'market' | 'symbol'>; blockCodes: readonly string[]; now?: Date },
  deliver: Deliver = deliverPersonalTelegramAlert,
) {
  const codes = liveSafetyAlertCodes(input.plan, input.blockCodes);
  if (!codes.length) return [];
  const now = input.now ?? new Date();
  const market = assetClassOfPlan(input.plan);
  const results = [];
  for (const code of codes) {
    // Loss limits are account-wide: one alert per rule per KST day. The cap is per market.
    const scope = code === 'LIVE_FIRST_WEEK_ORDER_CAP' ? market : 'account';
    const eventId = `live-safety:${input.userId}:${code}:${scope}:${kstDay(now)}`;
    try {
      results.push(await deliver({
        userId: input.userId,
        event: {
          userId: input.userId, eventId, market: POLICY_MARKET[market],
          signalType: 'STRATEGY_HEALTH', priority: 'CRITICAL', symbol: input.plan.symbol, occurredAt: now.toISOString(),
        },
        alert: {
          type: 'system_critical',
          title: '실거래 안전장치 작동',
          symbol: input.plan.symbol,
          market: MARKET_LABEL[market],
          details: LIVE_SAFETY_ALERT_CODES[code],
          timestamp: now.toISOString(),
          dedupeKey: eventId,
          duplicateWindowMs: 24 * 3_600_000,
          cooldownMs: 0,
        },
        now,
      }));
    } catch {
      results.push(null);
    }
  }
  return results;
}
