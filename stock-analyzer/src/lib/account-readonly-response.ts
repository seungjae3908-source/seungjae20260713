export const INVALID_ACCOUNT_READONLY_RESPONSE = 'INVALID_ACCOUNT_READONLY_RESPONSE';

const FUTURE_SKEW_MS = 60_000;
const PROVIDERS = ['toss', 'upbit', 'bitget'] as const;
const STATUSES = [
  'CONNECTED',
  'CONFIGURED_UNVERIFIED',
  'NOT_CONFIGURED',
  'STALE',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'UNAVAILABLE',
] as const;
const ACCOUNT_MARKETS = ['KR', 'US', 'UPBIT', 'BITGET'] as const;

type Provider = (typeof PROVIDERS)[number];
type JsonRecord = Record<string, unknown>;

function fail(): never {
  throw new Error(INVALID_ACCOUNT_READONLY_RESPONSE);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isFiniteOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isTimestamp(value: unknown, nowMs: number): boolean {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs + FUTURE_SKEW_MS;
}

function providerFromPath(path: string): Provider | null {
  const match = path.match(/\/accounts\/read-only\/(toss|upbit|bitget)\/?$/);
  return match?.[1] as Provider | undefined ?? null;
}

export function isAccountReadonlySnapshotPath(path: string, method: string): boolean {
  return method.toUpperCase() === 'GET' && providerFromPath(path) !== null;
}

function validArrayOrNull(
  value: unknown,
  validate: (row: unknown) => boolean,
): boolean {
  return value === null || (Array.isArray(value) && value.every(validate));
}

function validAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!ACCOUNT_MARKETS.includes(value.market as (typeof ACCOUNT_MARKETS)[number])) return false;
  if (!isNullableString(value.accountRef) || !isNullableString(value.currency)) return false;
  return isFiniteOrNull(value.buyingPower);
}

function validBalance(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.currency)) return false;
  return [value.available, value.locked, value.total, value.estimatedKrwValue].every(isFiniteOrNull);
}

function validPosition(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.market) || !isNonEmptyString(value.symbol)) return false;
  if (!isNullableString(value.marginMode) || !isNullableString(value.side)) return false;
  return [
    value.quantity,
    value.availableQuantity,
    value.averageEntryPrice,
    value.currentPrice,
    value.marketValue,
    value.unrealizedPnl,
    value.unrealizedPnlPercent,
    value.leverage,
    value.liquidationPrice,
  ].every(isFiniteOrNull);
}

function validOpenOrder(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNullableString(value.id) || !isNullableString(value.market) || !isNullableString(value.symbol)) return false;
  if (!isNullableString(value.side) || !isNullableString(value.status)) return false;
  return [value.price, value.quantity, value.remainingQuantity].every(isFiniteOrNull);
}

function validateStateCoherence(value: JsonRecord): void {
  const status = value.status;
  const connected = value.connected;
  const stale = value.stale;

  if (status === 'CONNECTED' && (connected !== true || stale !== false)) fail();
  if (status === 'STALE' && (connected !== true || stale !== true)) fail();
  if (status !== 'CONNECTED' && status !== 'STALE' && connected !== false) fail();
  if (status !== 'STALE' && stale !== false) fail();
}

export function requireAccountReadonlySnapshotResponse(
  path: string,
  method: string,
  payload: unknown,
  nowMs = Date.now(),
): unknown {
  const provider = providerFromPath(path);
  if (method.toUpperCase() !== 'GET' || provider === null || !isRecord(payload)) fail();

  if (payload.provider !== provider) fail();
  if (payload.readOnly !== true || typeof payload.connected !== 'boolean') fail();
  if (!STATUSES.includes(payload.status as (typeof STATUSES)[number])) fail();
  if (typeof payload.stale !== 'boolean') fail();
  validateStateCoherence(payload);

  if (!validArrayOrNull(payload.accounts, validAccount)) fail();
  if (!validArrayOrNull(payload.balances, validBalance)) fail();
  if (!validArrayOrNull(payload.positions, validPosition)) fail();
  if (!validArrayOrNull(payload.openOrders, validOpenOrder)) fail();

  if (!isTimestamp(payload.checkedAt, nowMs)) fail();
  if (payload.lastGoodAt !== null && !isTimestamp(payload.lastGoodAt, nowMs)) fail();
  if (payload.errorCode !== null && !isNonEmptyString(payload.errorCode)) fail();

  if (payload.orderRequests !== 0 || payload.cancelRequests !== 0 || payload.amendRequests !== 0) fail();
  if (payload.transferRequests !== 0 || payload.withdrawalRequests !== 0) fail();
  if (payload.credentialsReturned !== false) fail();
  if (payload.liveTradingEnabled !== false || payload.autoTradingEnabled !== false) fail();

  return payload;
}
