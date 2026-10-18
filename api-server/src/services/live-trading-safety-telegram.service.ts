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
import type { TrendPilotLaneEvent } from './trend-pilot-v1-lane.service';
import type { PaperCostRuleHealth } from './trade-execution.service';

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
  LIVE_FIRST_WEEK_ORDER_CAP: '실거래를 켠 첫 7일이라 10만 원이 넘는 자동매매 주문을 막았습니다.',
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
          ? '이 시장에서 실제 주문이 나갈 수 있습니다. 첫 7일 자동매매 주문은 1회 10만 원 이하로 제한됩니다. 설정에서 언제든 끌 수 있습니다.'
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

export type TrendPilotAlert = { dedupe: string; title: string; details: string; symbol?: string };

/**
 * Pure: which lane events deserve an owner alert. Only conditions where a held
 * position may be unprotected or the lane stopped itself: a kill, an exit that
 * did not go out, and lane-level (symbol-less) errors such as a ledger read/save
 * failure. Per-symbol data hiccups (stale quote, fast move) stay silent.
 */
export function trendPilotAlerts(venue: 'bitget' | 'upbit', events: readonly TrendPilotLaneEvent[]): TrendPilotAlert[] {
  const venueLabel = venue === 'bitget' ? '코인선물' : '코인현물';
  const out = new Map<string, TrendPilotAlert>();
  for (const event of events) {
    if (event.kind === 'KILL') {
      out.set(`kill:${venue}`, {
        dedupe: `kill:${venue}`, title: `${venueLabel} 추세 파일럿 정지`,
        details: `손실 보호 조건으로 새 진입을 멈췄습니다 (${event.reason}). 보유 포지션은 손절/청산 규칙으로 계속 관리됩니다. 재가동은 직접 승인해야 합니다.`,
      });
    } else if (event.kind === 'EXIT' && event.status !== 'SUBMITTED' && event.status !== 'DUPLICATE' && event.status !== 'STALE_POSITION') {
      out.set(`exit:${venue}:${event.symbol}`, {
        dedupe: `exit:${venue}:${event.symbol}`, title: `${venueLabel} 청산 주문 실패`, symbol: event.symbol,
        details: `${event.symbol} ${event.reason} 청산 주문이 나가지 않았습니다 (${event.status}). 포지션을 직접 확인하세요.`,
      });
    } else if (event.kind === 'ERROR' && event.symbol === null) {
      out.set(`state:${venue}:${event.code}`, {
        dedupe: `state:${venue}:${event.code}`, title: `${venueLabel} 파일럿 상태 오류`,
        details: `상태 파일 처리 오류(${event.code})로 이번 주기의 새 진입을 건너뛰었습니다. 보유 포지션은 직접 확인하세요.`,
      });
    }
  }
  return [...out.values()];
}

export async function notifyTrendPilotEvents(
  input: { userId: string; venue: 'bitget' | 'upbit'; events: readonly TrendPilotLaneEvent[]; now?: Date },
  deliver: Deliver = deliverPersonalTelegramAlert,
) {
  const alerts = trendPilotAlerts(input.venue, input.events);
  if (!alerts.length) return [];
  const now = input.now ?? new Date();
  const market: TradingAssetClass = input.venue === 'bitget' ? 'crypto_futures' : 'crypto_spot';
  const results = [];
  for (const alert of alerts) {
    // One alert per condition per KST hour: loud enough to notice, quiet enough to not flood.
    const eventId = `trend-pilot:${input.userId}:${alert.dedupe}:${new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 13)}`;
    try {
      results.push(await deliver({
        userId: input.userId,
        event: {
          userId: input.userId, eventId, market: POLICY_MARKET[market],
          signalType: 'STRATEGY_HEALTH', priority: 'CRITICAL', symbol: alert.symbol, occurredAt: now.toISOString(),
        },
        alert: {
          type: 'system_critical', title: alert.title, symbol: alert.symbol, market: MARKET_LABEL[market],
          details: alert.details, timestamp: now.toISOString(), dedupeKey: eventId, duplicateWindowMs: 3_600_000, cooldownMs: 0,
        },
        now,
      }));
    } catch {
      results.push(null);
    }
  }
  return results;
}

const COST_MARKET_ASSET: Record<PaperCostRuleHealth['market'], TradingAssetClass> = {
  KR_STOCK: 'domestic_stock', US_STOCK: 'us_stock', CRYPTO_SPOT: 'crypto_spot', CRYPTO_FUTURES: 'crypto_futures',
};

/** Pure: markets this member trades in Paper whose cost schedule is not safely current. */
export function paperCostRuleAlerts(
  health: readonly PaperCostRuleHealth[],
  marketEnabled: Readonly<Record<TradingAssetClass, boolean>>,
): Array<{ market: TradingAssetClass; text: string }> {
  const out: Array<{ market: TradingAssetClass; text: string }> = [];
  for (const row of health) {
    const asset = COST_MARKET_ASSET[row.market];
    if (!marketEnabled[asset] || row.state === 'ACTIVE') continue;
    const why = row.state === 'EXPIRING' ? `비용 규칙이 약 ${Math.max(0, Math.round(row.hoursLeft ?? 0))}시간 뒤 만료됩니다`
      : row.state === 'EXPIRED' ? '비용 규칙이 만료되었습니다'
        : row.state === 'NOT_YET_EFFECTIVE' ? '비용 규칙이 아직 시작 전입니다'
          : row.state === 'INVALID_CONFIG' ? '비용 규칙 설정이 올바르지 않습니다' : '비용 규칙이 없습니다';
    out.push({ market: asset, text: `${why}. 만료되면 이 시장의 모의 자동 정산(전비용 증거)이 멈춥니다. 서버 비용 규칙을 갱신해 주세요.` });
  }
  return out;
}

export async function notifyPaperCostRuleHealth(
  input: { userId: string; health: readonly PaperCostRuleHealth[]; marketEnabled: Readonly<Record<TradingAssetClass, boolean>>; now?: Date },
  deliver: Deliver = deliverPersonalTelegramAlert,
) {
  const alerts = paperCostRuleAlerts(input.health, input.marketEnabled);
  const now = input.now ?? new Date();
  const results = [];
  for (const alert of alerts) {
    const eventId = `paper-cost-rules:${input.userId}:${alert.market}:${kstDay(now)}`; // once per market per KST day
    try {
      results.push(await deliver({
        userId: input.userId,
        event: { userId: input.userId, eventId, market: POLICY_MARKET[alert.market], signalType: 'STRATEGY_HEALTH', priority: 'CRITICAL', occurredAt: now.toISOString() },
        alert: {
          type: 'system_critical', title: `${MARKET_LABEL[alert.market]} 모의 비용 규칙 점검`, market: MARKET_LABEL[alert.market],
          details: alert.text, timestamp: now.toISOString(), dedupeKey: eventId, duplicateWindowMs: 24 * 3_600_000, cooldownMs: 0,
        },
        now,
      }));
    } catch {
      results.push(null);
    }
  }
  return results;
}
