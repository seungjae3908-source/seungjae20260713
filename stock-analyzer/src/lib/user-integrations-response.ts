export const INVALID_USER_INTEGRATIONS_RESPONSE = 'INVALID_USER_INTEGRATIONS_RESPONSE';

const PREFERENCE_KEYS = [
  'ORDER_SUBMITTED',
  'ORDER_PARTIALLY_FILLED',
  'ORDER_FILLED',
  'ORDER_CANCELLED',
  'ORDER_REJECTED',
  'POSITION_OPENED',
  'POSITION_INCREASED',
  'POSITION_REDUCED',
  'POSITION_CLOSED',
  'TAKE_PROFIT_FILLED',
  'STOP_FILLED',
  'MANUAL_PORTFOLIO_ENTRY',
] as const;

const POLICY_MARKETS = ['KR', 'US', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const;
const POLICY_SIGNAL_TYPES = [
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
const POLICY_PRIORITIES = ['CRITICAL', 'IMPORTANT', 'INFO'] as const;
const TELEGRAM_STATUSES = ['ACTIVE', 'REVOKED', 'DISCONNECTED', 'UNAVAILABLE'] as const;
const ALERT_POLICY_SOURCES = ['STORED', 'DEFAULT_MISSING', 'DEFAULT_INVALID'] as const;
const BROKER_EXCHANGES = ['bitget', 'upbit', 'kiwoom'] as const;
const BROKER_ACCOUNT_MODES = ['paper', 'mock', 'live'] as const;
const FUTURE_SKEW_MS = 5_000;
const MAX_POLICY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function fail(): never {
  throw new Error(INVALID_USER_INTEGRATIONS_RESPONSE);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nullableString(value: unknown): boolean {
  return value === null || nonEmptyString(value);
}

function nonNegativeFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function finitePolicyWindow(value: unknown): boolean {
  return nonNegativeFinite(value) && (value as number) <= MAX_POLICY_WINDOW_MS;
}

function minuteOfDay(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function validTimeZone(value: unknown): boolean {
  if (!nonEmptyString(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function timestampOrNull(value: unknown, now: number): boolean {
  if (value === null) return true;
  if (!nonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + FUTURE_SKEW_MS;
}

function exactKnownArray<T extends string>(value: unknown, allowed: readonly T[]): value is T[] {
  if (!Array.isArray(value)) return false;
  if (!value.every((item) => typeof item === 'string' && allowed.includes(item as T))) return false;
  return new Set(value).size === value.length;
}

function validAvailabilityError(available: unknown, code: unknown): boolean {
  if (typeof available !== 'boolean') return false;
  return available ? code === null : nonEmptyString(code);
}

function validateBrokerConnections(
  value: unknown,
  availability: unknown,
  expectedUserId: string,
  now: number,
): void {
  if (!Array.isArray(value)) fail();
  if (availability !== true && value.length !== 0) fail();
  const seen = new Set<string>();
  for (const item of value) {
    const connection = record(item);
    if (!connection) fail();
    if (connection.userId !== expectedUserId
      || typeof connection.exchange !== 'string'
      || !BROKER_EXCHANGES.includes(connection.exchange as (typeof BROKER_EXCHANGES)[number])
      || typeof connection.accountMode !== 'string'
      || !BROKER_ACCOUNT_MODES.includes(connection.accountMode as (typeof BROKER_ACCOUNT_MODES)[number])) fail();
    if (typeof connection.configured !== 'boolean') fail();
    if (!timestampOrNull(connection.lastVerifiedAt, now)
      || !timestampOrNull(connection.updatedAt, now)
      || connection.updatedAt === null
      || !nullableString(connection.lastErrorCode)) fail();
    if (connection.credentialsExposed !== false) fail();
    const identity = connection.exchange.trim().toLowerCase();
    if (seen.has(identity)) fail();
    seen.add(identity);
  }
}

function validatePreferences(value: unknown): void {
  const preferences = record(value);
  if (!preferences) fail();
  for (const key of PREFERENCE_KEYS) {
    if (typeof preferences[key] !== 'boolean') fail();
  }
}

function validateAlertPolicy(value: unknown, expectedUserId: string): void {
  const policy = record(value);
  if (!policy || policy.userId !== expectedUserId || typeof policy.enabled !== 'boolean') fail();
  if (!exactKnownArray(policy.markets, POLICY_MARKETS)) fail();
  if (!exactKnownArray(policy.signalTypes, POLICY_SIGNAL_TYPES)) fail();
  if (!exactKnownArray(policy.priorities, POLICY_PRIORITIES)) fail();

  const quietHours = record(policy.quietHours);
  const quietStart = minuteOfDay(quietHours?.start);
  const quietEnd = minuteOfDay(quietHours?.end);
  if (!quietHours
    || typeof quietHours.enabled !== 'boolean'
    || quietStart === null
    || quietEnd === null
    || (quietHours.enabled && quietStart === quietEnd)
    || !validTimeZone(quietHours.timeZone)
    || typeof quietHours.criticalBypass !== 'boolean') fail();

  if (!finitePolicyWindow(policy.cooldownMs)
    || !finitePolicyWindow(policy.sameEventDedupeMs)
    || !finitePolicyWindow(policy.sameSymbolWindowMs)
    || !nonNegativeFinite(policy.sameSymbolRepeatLimit)
    || !Number.isInteger(policy.sameSymbolRepeatLimit)
    || (policy.sameSymbolRepeatLimit as number) > 100) fail();
  if (policy.deliveryMode !== 'IMMEDIATE' && policy.deliveryMode !== 'BATCHED') fail();

  const digest = record(policy.digest);
  if (!digest
    || typeof digest.enabled !== 'boolean'
    || !finitePolicyWindow(digest.windowMs)
    || (policy.deliveryMode === 'BATCHED' && (!digest.enabled || digest.windowMs === 0))) fail();
}

function validateTelegramRuntime(value: unknown): void {
  const runtime = record(value);
  if (!runtime) fail();
  for (const key of [
    'deliveryReady',
    'linkingReady',
    'webhookConfigured',
    'botUsernameConfigured',
    'stockRoomReady',
    'cryptoRoomReady',
    'richSignalEnabled',
    'aiExplanationEnabled',
    'signalFollowupEnabled',
    'memberHoldingsEnabled',
  ] as const) {
    if (typeof runtime[key] !== 'boolean') fail();
  }
  const expectedLinkingReady = runtime.deliveryReady === true
    && runtime.webhookConfigured === true
    && runtime.botUsernameConfigured === true;
  if (runtime.linkingReady !== expectedLinkingReady) fail();
  if (runtime.orderAuthority !== 'NONE'
    || runtime.privateTradingApiAllowed !== false
    || runtime.realOrderAllowed !== false) fail();
}

export function requireUserIntegrationsResponse(
  value: unknown,
  expectedUserId: string,
  now = Date.now(),
): unknown {
  if (!nonEmptyString(expectedUserId) || !Number.isFinite(now)) fail();
  const root = record(value);
  if (!root || root.ok !== true) fail();

  if (root.prioritySemantics !== 'DELIVERY_URGENCY_ONLY'
    || root.privateApiRequests !== 0
    || root.ordersSubmitted !== 0
    || root.ordersCancelled !== 0) fail();

  const telegram = record(root.telegram);
  if (!telegram
    || typeof telegram.connected !== 'boolean'
    || !TELEGRAM_STATUSES.includes(telegram.status as (typeof TELEGRAM_STATUSES)[number])
    || !timestampOrNull(telegram.connectedAt, now)) fail();
  if (telegram.connected === true) {
    if (telegram.status !== 'ACTIVE' || telegram.connectedAt === null) fail();
  } else if (telegram.status === 'ACTIVE'
    || ((telegram.status === 'DISCONNECTED' || telegram.status === 'UNAVAILABLE')
      && telegram.connectedAt !== null)) {
    fail();
  }

  validatePreferences(root.preferences);
  if (!Array.isArray(root.deliveries)) fail();

  if (!validAvailabilityError(root.telegramStorageAvailable, root.telegramStorageErrorCode)) fail();
  if (!validAvailabilityError(root.alertPolicyStorageAvailable, root.alertPolicyStorageErrorCode)) fail();
  if (root.brokerConnectionsAvailable !== null
    && typeof root.brokerConnectionsAvailable !== 'boolean') fail();
  if (root.brokerConnectionsAvailable === true) {
    if (root.brokerConnectionsErrorCode !== null) fail();
  } else if (root.brokerConnectionsAvailable === false) {
    if (!nonEmptyString(root.brokerConnectionsErrorCode)) fail();
  } else if (root.brokerConnectionsErrorCode !== null) {
    fail();
  }

  validateBrokerConnections(root.brokerConnections, root.brokerConnectionsAvailable, expectedUserId, now);
  if (typeof root.brokerMetadataRead !== 'boolean'
    || root.brokerMetadataRead !== (root.brokerConnectionsAvailable === true)) fail();

  validateAlertPolicy(root.alertPolicy, expectedUserId);
  if (!ALERT_POLICY_SOURCES.includes(root.alertPolicySource as (typeof ALERT_POLICY_SOURCES)[number])) fail();
  validateTelegramRuntime(root.telegramRuntime);

  const expectedPartial = root.telegramStorageAvailable === false
    || root.brokerConnectionsAvailable === false
    || root.alertPolicyStorageAvailable === false;
  if (root.partial !== expectedPartial) fail();

  return value;
}
