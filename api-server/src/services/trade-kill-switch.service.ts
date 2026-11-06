import type { TradingRepository } from './trade-automation.repository';
import type { TradingPlanInput } from './trade-automation.types';
import { isRiskReducingExitPlan } from './live-connection-verification.service';
import { autoStopRunForLossLimit, killSwitchStopMemberEntries } from './trade-automation-run-control.service';
import { sendTelegramAlert, type TelegramAlertInput, type TelegramAlertResult } from './telegram-notification.service';

export type AutomaticTradingHaltEvent =
  | 'KILL_SWITCH'
  | 'MEMBER_EMERGENCY_STOP'
  | 'GLOBAL_EMERGENCY_STOP'
  | 'MEMBER_RESUME'
  | 'GLOBAL_RESUME'
  | 'ORDER_MANUAL_REVIEW';

type AutomaticTradingAlertSender = (input: TelegramAlertInput) => Promise<TelegramAlertResult>;
let automaticTradingAlertSender: AutomaticTradingAlertSender = sendTelegramAlert;

/** Tests swap the Telegram transport; `null` restores the real sender. */
export function setAutomaticTradingAlertSenderForTests(sender: AutomaticTradingAlertSender | null) {
  automaticTradingAlertSender = sender ?? sendTelegramAlert;
}

/** Owner auto-trading room first; the generic TELEGRAM_CHAT_ID is the fallback inside the sender. */
export function automaticTradingAlertChatId(): string | undefined {
  return process.env.TELEGRAM_AUTO_TRADING_CHAT_ID?.trim() || undefined;
}

const HALT_TITLES: Record<AutomaticTradingHaltEvent, string> = {
  KILL_SWITCH: '자동매매 킬스위치 작동',
  MEMBER_EMERGENCY_STOP: '회원 긴급정지',
  GLOBAL_EMERGENCY_STOP: '전체 긴급정지',
  MEMBER_RESUME: '회원 거래 재개',
  GLOBAL_RESUME: '전체 신규주문 평가 재개',
  ORDER_MANUAL_REVIEW: '주문 상태 불명 · 수동 확인 필요',
};

function maskedUserId(userId: string): string {
  const value = String(userId ?? '').trim();
  return value.length <= 8 ? value || '(unknown)' : `${value.slice(0, 8)}…`;
}

/**
 * Owner Telegram notice for every automatic-trading stop, resume and
 * unknown-order escalation. Strictly best-effort: the stop or resume is
 * already persisted before this runs, a delivery failure never throws, and
 * the alert can never undo or weaken the block that triggered it.
 */
export async function notifyAutomaticTradingHalt(input: {
  event: AutomaticTradingHaltEvent;
  userId: string;
  scope?: KillSwitchScope | null;
  reasons?: readonly string[];
  details?: string;
  now?: Date;
}): Promise<TelegramAlertResult | null> {
  try {
    const reasons = [...new Set((input.reasons ?? []).map((code) => String(code).trim()).filter(Boolean))];
    const at = (input.now ?? new Date()).toISOString();
    const lines = [
      `범위: ${input.scope ?? (input.event.startsWith('GLOBAL') ? 'GLOBAL' : 'MEMBER')}`,
      `회원: ${maskedUserId(input.userId)}`,
      reasons.length > 0 ? `사유: ${reasons.join(', ')}` : null,
      input.details?.trim() ? input.details.trim() : null,
      `시각: ${at}`,
    ].filter((line): line is string => line != null);
    return await automaticTradingAlertSender({
      type: 'system_critical',
      title: HALT_TITLES[input.event],
      details: lines.join('\n'),
      timestamp: at,
      dedupeKey: `auto-trading-halt:${input.event}:${input.scope ?? ''}:${input.userId}:${reasons.join('|')}`,
      cooldownMs: 60_000,
      duplicateWindowMs: 60_000,
      destinationChatId: automaticTradingAlertChatId(),
    });
  } catch {
    // Alerting is observability only; it must never affect the trading block.
    return null;
  }
}

const KILL_SWITCH_CODES = new Set([
  'MARKET_DATA_TIMESTAMP_UNAVAILABLE',
  'MARKET_DATA_FROM_FUTURE',
  'MARKET_DATA_STALE',
  'MARKET_DATA_DELAY_UNKNOWN',
  'MARKET_DATA_DELAY_INCONSISTENT',
  'MARKET_DATA_SOURCE_UNAVAILABLE',
  'MARKET_SNAPSHOT_TIMESTAMP_INVALID',
  'MARKET_SNAPSHOT_STALE',
  'MARKET_SNAPSHOT_FROM_FUTURE',
  'MARKET_DATA_DELAYED',
  'RISK_EVIDENCE_STALE',
  'PROVIDER_CLOCK_OFFSET_TOO_LARGE',
  'MARKET_HALTED',
  'EXCHANGE_API_FAILURE',
  'EXCHANGE_NETWORK_ERROR',
  'EXCHANGE_TIMEOUT',
  'ACCOUNT_STATE_MISMATCH',
  'ACCOUNT_MODE_MISMATCH',
  'ORDER_STATE_UNKNOWN',
  'FAST_MOVE_DETECTED',
  'ONE_MINUTE_VOLATILITY',
  'DAILY_LOSS_LIMIT',
  'APPROVAL_PRICE_DRIFT_EXCEEDED',
  'EXECUTION_RECONCILIATION_FAILED',
  'RECOVERY_RECONCILIATION_FAILED',
]);

/**
 * Owner decision 2026-10-18 (범위 좁히기): only exchange/provider-outage and
 * unknown-order-state codes halt every member. They describe a shared venue,
 * clock or order-state failure that other members' orders would hit too.
 * Every other kill code (per-symbol market data freshness, fast moves, price
 * drift, a member's own loss limit or account state) stops only the member
 * whose plan raised it.
 */
const SYSTEM_KILL_SWITCH_CODES = new Set([
  'EXCHANGE_API_FAILURE',
  'EXCHANGE_NETWORK_ERROR',
  'EXCHANGE_TIMEOUT',
  'MARKET_HALTED',
  'PROVIDER_CLOCK_OFFSET_TOO_LARGE',
  'ORDER_STATE_UNKNOWN',
  'EXECUTION_RECONCILIATION_FAILED',
  'RECOVERY_RECONCILIATION_FAILED',
]);

export type KillSwitchScope = 'GLOBAL' | 'MEMBER';
export type KillSwitchPlan = Pick<TradingPlanInput, 'accountMode' | 'reduceOnly' | 'exchange' | 'side'>;

export function killSwitchReasons(blockCodes: readonly string[]) {
  return [...new Set(blockCodes.filter((code) => KILL_SWITCH_CODES.has(code)))];
}

/** Which stop a kill reason trips. A plan that is not known to be simulated is treated as LIVE. */
export function killSwitchScope(reasons: readonly string[], plan?: KillSwitchPlan | null): KillSwitchScope {
  const simulated = plan != null && plan.accountMode !== 'live';
  return !simulated && reasons.some((code) => SYSTEM_KILL_SWITCH_CODES.has(code)) ? 'GLOBAL' : 'MEMBER';
}

export async function tripKillSwitchForRiskFailure(input: {
  repository: TradingRepository;
  userId: string;
  blockCodes: readonly string[];
  /** The plan being evaluated; omitted only when it cannot be read (treated as a LIVE entry). */
  plan?: KillSwitchPlan | null;
}) {
  // A protective exit only reduces risk: its failure is retried by the next
  // tick and never stops this member. A shared venue or order-state failure
  // seen on an exit still halts new entries for everyone (exits keep running
  // under a global stop). The order itself is still rejected by the caller.
  if (input.plan && isRiskReducingExitPlan(input.plan)) {
    const systemReasons = killSwitchReasons(input.blockCodes).filter((code) => SYSTEM_KILL_SWITCH_CODES.has(code));
    if (systemReasons.length === 0 || input.plan.accountMode !== 'live') {
      return { tripped: false, reasons: [] as string[], scope: null };
    }
    await input.repository.setGlobalEmergencyStop(true, input.userId);
    await notifyAutomaticTradingHalt({ event: 'KILL_SWITCH', userId: input.userId, scope: 'GLOBAL', reasons: systemReasons,
      details: '보호 청산 주문 평가 중 공용 거래소/주문상태 장애: 전체 신규 진입 정지(청산은 계속)' });
    return { tripped: true, reasons: systemReasons, scope: 'GLOBAL' as const };
  }
  // A daily loss limit also auto-stops this member's 작동 state (recorded with
  // its reason). This never weakens the block itself: the order is still rejected.
  await autoStopRunForLossLimit(input.repository, input.userId, input.blockCodes);
  const reasons = killSwitchReasons(input.blockCodes);
  if (reasons.length === 0) return { tripped: false, reasons, scope: null };
  const scope = killSwitchScope(reasons, input.plan);
  if (scope === 'GLOBAL') {
    await input.repository.setGlobalEmergencyStop(true, input.userId);
  } else {
    // Member scope: this member's new entries stop until the confirmed resume;
    // protective exits of owned positions keep running.
    await killSwitchStopMemberEntries(input.repository, input.userId, reasons[0]);
  }
  await notifyAutomaticTradingHalt({ event: 'KILL_SWITCH', userId: input.userId, scope, reasons,
    details: scope === 'GLOBAL' ? '전체 신규 진입 정지(보호 청산은 계속)' : '해당 회원 신규 진입 정지(확인 후 재개 필요)' });
  return { tripped: true, reasons, scope };
}
