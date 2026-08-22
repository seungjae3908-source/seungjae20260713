import {
  sendTelegramAlert,
  type TelegramAlertInput,
  type TelegramAlertResult,
} from './telegram-notification.service';

export const TELEGRAM_POLICY_MARKETS = [
  'KR',
  'US',
  'CRYPTO_SPOT',
  'CRYPTO_FUTURES',
] as const;
export type TelegramPolicyMarket = (typeof TELEGRAM_POLICY_MARKETS)[number];

export const TELEGRAM_POLICY_SIGNAL_TYPES = [
  'BUY',
  'LONG',
  'SHORT',
  'NO_TRADE',
  'STRATEGY_HEALTH',
  'CHAMPION',
  'RESEARCH',
  'SETTLEMENT',
  'PROVIDER_SERVER_ERROR',
] as const;
export type TelegramPolicySignalType = (typeof TELEGRAM_POLICY_SIGNAL_TYPES)[number];

export const TELEGRAM_POLICY_PRIORITIES = ['CRITICAL', 'IMPORTANT', 'INFO'] as const;
export type TelegramPolicyPriority = (typeof TELEGRAM_POLICY_PRIORITIES)[number];
export type TelegramPolicyDeliveryMode = 'IMMEDIATE' | 'BATCHED';

export type TelegramQuietHours = {
  enabled: boolean;
  start: string;
  end: string;
  timeZone: string;
  criticalBypass: boolean;
};

export type TelegramDigestPolicy = {
  enabled: boolean;
  windowMs: number;
};

export type TelegramAlertPolicy = {
  userId: string;
  enabled: boolean;
  markets: readonly TelegramPolicyMarket[];
  signalTypes: readonly TelegramPolicySignalType[];
  priorities: readonly TelegramPolicyPriority[];
  quietHours: TelegramQuietHours;
  cooldownMs: number;
  sameEventDedupeMs: number;
  sameSymbolWindowMs: number;
  sameSymbolRepeatLimit: number;
  deliveryMode: TelegramPolicyDeliveryMode;
  digest: TelegramDigestPolicy;
};

export type TelegramPolicyEvent = {
  userId: string;
  eventId: string;
  market?: TelegramPolicyMarket;
  signalType: TelegramPolicySignalType;
  priority: TelegramPolicyPriority;
  symbol?: string;
  occurredAt: string;
};

export type TelegramPolicyDeliveryHistory = {
  userId: string;
  eventId: string;
  market?: TelegramPolicyMarket;
  signalType: TelegramPolicySignalType;
  priority: TelegramPolicyPriority;
  symbol?: string;
  deliveredAt: string;
};

export const TELEGRAM_POLICY_SAFETY = Object.freeze({
  investmentDecisionChanged: false as const,
  strategyStateChanged: false as const,
  orderAuthority: 'NONE' as const,
  privateTradingApiAllowed: false as const,
  realOrderAllowed: false as const,
});

export type TelegramPolicyReason =
  | 'ALLOWED'
  | 'DISABLED'
  | 'OWNER_MISMATCH'
  | 'INVALID_POLICY'
  | 'INVALID_EVENT'
  | 'MARKET_FILTERED'
  | 'SIGNAL_FILTERED'
  | 'PRIORITY_FILTERED'
  | 'QUIET_HOURS'
  | 'SAME_EVENT_DUPLICATE'
  | 'COOLDOWN'
  | 'SAME_SYMBOL_REPEAT_LIMIT'
  | 'DIGEST_BATCHED';

export type TelegramPolicyDecision = {
  action: 'SUPPRESSED' | 'IMMEDIATE' | 'BATCHED';
  reason: TelegramPolicyReason;
  userId: string;
  prioritySemantics: 'DELIVERY_URGENCY_ONLY';
  digestKey: string | null;
  digestWindowMs: number | null;
  safety: typeof TELEGRAM_POLICY_SAFETY;
};

export type TelegramPolicyDeliveryResult = {
  decision: TelegramPolicyDecision;
  transport: TelegramAlertResult | null;
  safety: typeof TELEGRAM_POLICY_SAFETY;
};

type TelegramAlertSender = (input: TelegramAlertInput) => Promise<TelegramAlertResult>;

const GLOBAL_SIGNAL_TYPES = new Set<TelegramPolicySignalType>([
  'STRATEGY_HEALTH',
  'CHAMPION',
  'RESEARCH',
  'SETTLEMENT',
  'PROVIDER_SERVER_ERROR',
]);
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function finiteWindow(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_WINDOW_MS;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function uniqueKnown<T extends string>(values: readonly T[], allowed: readonly T[]): boolean {
  return values.every((value) => isOneOf(value, allowed)) && new Set(values).size === values.length;
}

function minuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function validPolicy(policy: TelegramAlertPolicy): boolean {
  const start = minuteOfDay(policy.quietHours.start);
  const end = minuteOfDay(policy.quietHours.end);
  return Boolean(
    policy.userId.trim()
    && uniqueKnown(policy.markets, TELEGRAM_POLICY_MARKETS)
    && uniqueKnown(policy.signalTypes, TELEGRAM_POLICY_SIGNAL_TYPES)
    && uniqueKnown(policy.priorities, TELEGRAM_POLICY_PRIORITIES)
    && start != null
    && end != null
    && (!policy.quietHours.enabled || start !== end)
    && validTimeZone(policy.quietHours.timeZone)
    && typeof policy.quietHours.criticalBypass === 'boolean'
    && finiteWindow(policy.cooldownMs)
    && finiteWindow(policy.sameEventDedupeMs)
    && finiteWindow(policy.sameSymbolWindowMs)
    && Number.isInteger(policy.sameSymbolRepeatLimit)
    && policy.sameSymbolRepeatLimit >= 0
    && policy.sameSymbolRepeatLimit <= 100
    && ['IMMEDIATE', 'BATCHED'].includes(policy.deliveryMode)
    && typeof policy.digest.enabled === 'boolean'
    && finiteWindow(policy.digest.windowMs)
    && (policy.deliveryMode !== 'BATCHED' || (policy.digest.enabled && policy.digest.windowMs > 0))
  );
}

function validEvent(event: TelegramPolicyEvent): boolean {
  const occurredAt = Date.parse(event.occurredAt);
  if (!event.userId.trim() || !event.eventId.trim() || !Number.isFinite(occurredAt)) return false;
  if (!isOneOf(event.signalType, TELEGRAM_POLICY_SIGNAL_TYPES) || !isOneOf(event.priority, TELEGRAM_POLICY_PRIORITIES)) return false;
  if (event.market != null && !isOneOf(event.market, TELEGRAM_POLICY_MARKETS)) return false;
  if (event.market == null && !GLOBAL_SIGNAL_TYPES.has(event.signalType)) return false;
  return true;
}

function localMinute(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}

function isQuietHours(now: Date, quietHours: TelegramQuietHours): boolean | null {
  if (!quietHours.enabled) return false;
  const current = localMinute(now, quietHours.timeZone);
  const start = minuteOfDay(quietHours.start);
  const end = minuteOfDay(quietHours.end);
  if (current == null || start == null || end == null || start === end) return null;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function normalizedSymbol(symbol: string | undefined): string | null {
  const value = symbol?.normalize('NFKC').trim().toUpperCase();
  return value ? value.slice(0, 64) : null;
}

function eventSubject(event: TelegramPolicyEvent): string {
  return [event.market ?? 'GLOBAL', event.signalType, normalizedSymbol(event.symbol) ?? 'GLOBAL'].join(':');
}

function deliveredAt(history: TelegramPolicyDeliveryHistory): number | null {
  const parsed = Date.parse(history.deliveredAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function historyForUser(
  userId: string,
  history: readonly TelegramPolicyDeliveryHistory[],
): TelegramPolicyDeliveryHistory[] {
  return history.filter((item) => item.userId === userId && deliveredAt(item) != null);
}

function suppressed(userId: string, reason: TelegramPolicyReason): TelegramPolicyDecision {
  return {
    action: 'SUPPRESSED',
    reason,
    userId,
    prioritySemantics: 'DELIVERY_URGENCY_ONLY',
    digestKey: null,
    digestWindowMs: null,
    safety: TELEGRAM_POLICY_SAFETY,
  };
}

export function evaluateTelegramAlertPolicy(
  policy: TelegramAlertPolicy,
  event: TelegramPolicyEvent,
  history: readonly TelegramPolicyDeliveryHistory[] = [],
  now = new Date(),
): TelegramPolicyDecision {
  const userId = policy.userId || event.userId || 'UNKNOWN';
  if (!validPolicy(policy)) return suppressed(userId, 'INVALID_POLICY');
  if (!validEvent(event) || !Number.isFinite(now.getTime())) return suppressed(userId, 'INVALID_EVENT');
  if (policy.userId !== event.userId) return suppressed(policy.userId, 'OWNER_MISMATCH');
  if (!policy.enabled) return suppressed(policy.userId, 'DISABLED');
  if (event.market != null && !policy.markets.includes(event.market)) return suppressed(policy.userId, 'MARKET_FILTERED');
  if (!policy.signalTypes.includes(event.signalType)) return suppressed(policy.userId, 'SIGNAL_FILTERED');
  if (!policy.priorities.includes(event.priority)) return suppressed(policy.userId, 'PRIORITY_FILTERED');

  const quiet = isQuietHours(now, policy.quietHours);
  if (quiet == null) return suppressed(policy.userId, 'INVALID_POLICY');
  if (quiet && !(event.priority === 'CRITICAL' && policy.quietHours.criticalBypass)) {
    return suppressed(policy.userId, 'QUIET_HOURS');
  }

  const nowMs = now.getTime();
  const userHistory = historyForUser(policy.userId, history);
  const duplicate = userHistory.some((item) => {
    const at = deliveredAt(item);
    return item.eventId === event.eventId && at != null && nowMs >= at && nowMs - at < policy.sameEventDedupeMs;
  });
  if (duplicate) return suppressed(policy.userId, 'SAME_EVENT_DUPLICATE');

  const subject = eventSubject(event);
  const cooldownHit = userHistory.some((item) => {
    const at = deliveredAt(item);
    const sameSubject = [item.market ?? 'GLOBAL', item.signalType, normalizedSymbol(item.symbol) ?? 'GLOBAL'].join(':') === subject;
    return sameSubject && at != null && nowMs >= at && nowMs - at < policy.cooldownMs;
  });
  if (cooldownHit) return suppressed(policy.userId, 'COOLDOWN');

  const symbol = normalizedSymbol(event.symbol);
  if (symbol && policy.sameSymbolRepeatLimit >= 0) {
    const repeats = userHistory.filter((item) => {
      const at = deliveredAt(item);
      return normalizedSymbol(item.symbol) === symbol
        && at != null
        && nowMs >= at
        && nowMs - at < policy.sameSymbolWindowMs;
    }).length;
    if (repeats >= policy.sameSymbolRepeatLimit) return suppressed(policy.userId, 'SAME_SYMBOL_REPEAT_LIMIT');
  }

  if (policy.deliveryMode === 'BATCHED') {
    return {
      action: 'BATCHED',
      reason: 'DIGEST_BATCHED',
      userId: policy.userId,
      prioritySemantics: 'DELIVERY_URGENCY_ONLY',
      digestKey: `${policy.userId}:${event.market ?? 'GLOBAL'}:${event.priority}`,
      digestWindowMs: policy.digest.windowMs,
      safety: TELEGRAM_POLICY_SAFETY,
    };
  }

  return {
    action: 'IMMEDIATE',
    reason: 'ALLOWED',
    userId: policy.userId,
    prioritySemantics: 'DELIVERY_URGENCY_ONLY',
    digestKey: null,
    digestWindowMs: null,
    safety: TELEGRAM_POLICY_SAFETY,
  };
}

export async function deliverTelegramAlertWithPolicy(input: {
  policy: TelegramAlertPolicy;
  event: TelegramPolicyEvent;
  alert: TelegramAlertInput;
  history?: readonly TelegramPolicyDeliveryHistory[];
  now?: Date;
  sender?: TelegramAlertSender;
}): Promise<TelegramPolicyDeliveryResult> {
  const decision = evaluateTelegramAlertPolicy(
    input.policy,
    input.event,
    input.history ?? [],
    input.now ?? new Date(),
  );
  if (decision.action !== 'IMMEDIATE') {
    return { decision, transport: null, safety: TELEGRAM_POLICY_SAFETY };
  }

  const sender = input.sender ?? sendTelegramAlert;
  let transport: TelegramAlertResult;
  try {
    transport = await sender(input.alert);
  } catch {
    transport = { ok: false, attempts: 0, skipped: 'DELIVERY_FAILED' };
  }
  return { decision, transport, safety: TELEGRAM_POLICY_SAFETY };
}
