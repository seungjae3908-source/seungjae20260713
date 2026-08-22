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
  'PRICE_TARGET',
  'STRATEGY_HEALTH',
  'CHAMPION',
  'RESEARCH',
  'SETTLEMENT',
  'PROVIDER_SERVER_ERROR',
] as const;
export type TelegramPolicySignalType = (typeof TELEGRAM_POLICY_SIGNAL_TYPES)[number];

export const TELEGRAM_POLICY_PRIORITIES = ['CRITICAL', 'IMPORTANT', 'INFO'] as const;
export type TelegramPolicyPriority = (typeof TELEGRAM_POLICY_PRIORITIES)[number];
export const TELEGRAM_POLICY_DELIVERY_MODES = ['IMMEDIATE', 'BATCHED'] as const;
export type TelegramPolicyDeliveryMode = (typeof TELEGRAM_POLICY_DELIVERY_MODES)[number];

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
const MAX_RUNTIME_HISTORY_PER_USER = 256;
const runtimeHistoryByUser = new Map<string, TelegramPolicyDeliveryHistory[]>();
const POLICY_PATCH_KEYS = new Set([
  'enabled',
  'markets',
  'signalTypes',
  'priorities',
  'quietHours',
  'cooldownMs',
  'sameEventDedupeMs',
  'sameSymbolWindowMs',
  'sameSymbolRepeatLimit',
  'deliveryMode',
  'digest',
]);
const QUIET_HOURS_PATCH_KEYS = new Set([
  'enabled',
  'start',
  'end',
  'timeZone',
  'criticalBypass',
]);
const DIGEST_PATCH_KEYS = new Set(['enabled', 'windowMs']);

function finiteWindow(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_WINDOW_MS;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function uniqueKnown<T extends string>(values: readonly T[], allowed: readonly T[]): boolean {
  return values.every((value) => isOneOf(value, allowed)) && new Set(values).size === values.length;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  }
}

function knownArray<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || !uniqueKnown(value as T[], allowed)) {
    throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  }
  return [...value] as T[];
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  return value;
}

function minuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
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

export function defaultTelegramAlertPolicy(userId: string): TelegramAlertPolicy {
  return {
    userId: userId.trim(),
    enabled: false,
    markets: [...TELEGRAM_POLICY_MARKETS],
    signalTypes: [...TELEGRAM_POLICY_SIGNAL_TYPES],
    priorities: [...TELEGRAM_POLICY_PRIORITIES],
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '07:00',
      timeZone: 'Asia/Seoul',
      criticalBypass: false,
    },
    cooldownMs: 5 * 60 * 1000,
    sameEventDedupeMs: 24 * 60 * 60 * 1000,
    sameSymbolWindowMs: 60 * 60 * 1000,
    sameSymbolRepeatLimit: 3,
    deliveryMode: 'IMMEDIATE',
    digest: {
      enabled: false,
      windowMs: 30 * 60 * 1000,
    },
  };
}

export function isValidTelegramAlertPolicy(policy: TelegramAlertPolicy): boolean {
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
    && isOneOf(policy.deliveryMode, TELEGRAM_POLICY_DELIVERY_MODES)
    && typeof policy.digest.enabled === 'boolean'
    && finiteWindow(policy.digest.windowMs)
    && (policy.deliveryMode !== 'BATCHED' || (policy.digest.enabled && policy.digest.windowMs > 0))
  );
}

export function applyTelegramAlertPolicyPatch(
  current: TelegramAlertPolicy,
  value: unknown,
): TelegramAlertPolicy {
  if (!isValidTelegramAlertPolicy(current)) throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  const patch = record(value);
  if (!patch) throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  assertKnownKeys(patch, POLICY_PATCH_KEYS);

  const next: TelegramAlertPolicy = {
    ...current,
    markets: [...current.markets],
    signalTypes: [...current.signalTypes],
    priorities: [...current.priorities],
    quietHours: { ...current.quietHours },
    digest: { ...current.digest },
  };

  if ('enabled' in patch) next.enabled = booleanValue(patch.enabled);
  if ('markets' in patch) next.markets = knownArray(patch.markets, TELEGRAM_POLICY_MARKETS);
  if ('signalTypes' in patch) next.signalTypes = knownArray(patch.signalTypes, TELEGRAM_POLICY_SIGNAL_TYPES);
  if ('priorities' in patch) next.priorities = knownArray(patch.priorities, TELEGRAM_POLICY_PRIORITIES);
  if ('cooldownMs' in patch) next.cooldownMs = finiteNumber(patch.cooldownMs);
  if ('sameEventDedupeMs' in patch) next.sameEventDedupeMs = finiteNumber(patch.sameEventDedupeMs);
  if ('sameSymbolWindowMs' in patch) next.sameSymbolWindowMs = finiteNumber(patch.sameSymbolWindowMs);
  if ('sameSymbolRepeatLimit' in patch) next.sameSymbolRepeatLimit = finiteNumber(patch.sameSymbolRepeatLimit);
  if ('deliveryMode' in patch) {
    if (!isOneOf(patch.deliveryMode, TELEGRAM_POLICY_DELIVERY_MODES)) {
      throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
    }
    next.deliveryMode = patch.deliveryMode;
  }

  if ('quietHours' in patch) {
    const quietPatch = record(patch.quietHours);
    if (!quietPatch) throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
    assertKnownKeys(quietPatch, QUIET_HOURS_PATCH_KEYS);
    if ('enabled' in quietPatch) next.quietHours.enabled = booleanValue(quietPatch.enabled);
    if ('start' in quietPatch) next.quietHours.start = stringValue(quietPatch.start);
    if ('end' in quietPatch) next.quietHours.end = stringValue(quietPatch.end);
    if ('timeZone' in quietPatch) next.quietHours.timeZone = stringValue(quietPatch.timeZone);
    if ('criticalBypass' in quietPatch) next.quietHours.criticalBypass = booleanValue(quietPatch.criticalBypass);
  }

  if ('digest' in patch) {
    const digestPatch = record(patch.digest);
    if (!digestPatch) throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
    assertKnownKeys(digestPatch, DIGEST_PATCH_KEYS);
    if ('enabled' in digestPatch) next.digest.enabled = booleanValue(digestPatch.enabled);
    if ('windowMs' in digestPatch) next.digest.windowMs = finiteNumber(digestPatch.windowMs);
  }

  if (!isValidTelegramAlertPolicy(next)) throw new Error('TELEGRAM_ALERT_POLICY_INVALID');
  return next;
}

function validEvent(event: TelegramPolicyEvent): boolean {
  const occurredAt = Date.parse(event.occurredAt);
  if (!event.userId.trim() || !event.eventId.trim() || !Number.isFinite(occurredAt)) return false;
  if (!isOneOf(event.signalType, TELEGRAM_POLICY_SIGNAL_TYPES)) return false;
  if (!isOneOf(event.priority, TELEGRAM_POLICY_PRIORITIES)) return false;
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

function runtimeHistory(userId: string, now: Date): TelegramPolicyDeliveryHistory[] {
  const nowMs = now.getTime();
  const current = runtimeHistoryByUser.get(userId) ?? [];
  const pruned = current.filter((item) => {
    const at = deliveredAt(item);
    return at != null && nowMs >= at && nowMs - at <= MAX_WINDOW_MS;
  });
  if (pruned.length) runtimeHistoryByUser.set(userId, pruned);
  else runtimeHistoryByUser.delete(userId);
  return pruned;
}

function recordRuntimeDelivery(event: TelegramPolicyEvent, now: Date): void {
  const current = runtimeHistory(event.userId, now);
  const next: TelegramPolicyDeliveryHistory[] = [
    ...current,
    {
      userId: event.userId,
      eventId: event.eventId,
      market: event.market,
      signalType: event.signalType,
      priority: event.priority,
      symbol: event.symbol,
      deliveredAt: now.toISOString(),
    },
  ];
  runtimeHistoryByUser.set(event.userId, next.slice(-MAX_RUNTIME_HISTORY_PER_USER));
}

export function clearTelegramAlertPolicyRuntimeHistory(): void {
  runtimeHistoryByUser.clear();
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
  if (!isValidTelegramAlertPolicy(policy)) return suppressed(userId, 'INVALID_POLICY');
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
    return item.eventId === event.eventId
      && at != null
      && nowMs >= at
      && nowMs - at < policy.sameEventDedupeMs;
  });
  if (duplicate) return suppressed(policy.userId, 'SAME_EVENT_DUPLICATE');

  const subject = eventSubject(event);
  const cooldownHit = userHistory.some((item) => {
    const at = deliveredAt(item);
    const sameSubject = [
      item.market ?? 'GLOBAL',
      item.signalType,
      normalizedSymbol(item.symbol) ?? 'GLOBAL',
    ].join(':') === subject;
    return sameSubject && at != null && nowMs >= at && nowMs - at < policy.cooldownMs;
  });
  if (cooldownHit) return suppressed(policy.userId, 'COOLDOWN');

  const symbol = normalizedSymbol(event.symbol);
  if (symbol && policy.sameSymbolRepeatLimit > 0 && policy.sameSymbolWindowMs > 0) {
    const repeats = userHistory.filter((item) => {
      const at = deliveredAt(item);
      return normalizedSymbol(item.symbol) === symbol
        && at != null
        && nowMs >= at
        && nowMs - at < policy.sameSymbolWindowMs;
    }).length;
    if (repeats >= policy.sameSymbolRepeatLimit) {
      return suppressed(policy.userId, 'SAME_SYMBOL_REPEAT_LIMIT');
    }
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
  const now = input.now ?? new Date();
  const history = input.history ?? runtimeHistory(input.policy.userId, now);
  const decision = evaluateTelegramAlertPolicy(input.policy, input.event, history, now);
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
  if (transport.ok && input.history == null) recordRuntimeDelivery(input.event, now);
  return { decision, transport, safety: TELEGRAM_POLICY_SAFETY };
}
