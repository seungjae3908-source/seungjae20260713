export const INVALID_PRICE_ALERT_RESPONSE = 'INVALID_PRICE_ALERT_RESPONSE';

const FUTURE_SKEW_MS = 60_000;
const PRICE_ALERT_LIST_SUFFIX = '/notifications/price-alerts';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function positivePrice(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function validTimestamp(value: unknown, nowMs: number): boolean {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs + FUTURE_SKEW_MS;
}

function fail(): never {
  throw new Error(INVALID_PRICE_ALERT_RESPONSE);
}

function validateRow(value: unknown, nowMs: number): JsonRecord {
  if (!isRecord(value)) fail();
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.symbol)) fail();
  if (value.asset_type !== 'stock' && value.asset_type !== 'coin_spot' && value.asset_type !== 'coin_futures') fail();
  if (!isNonEmptyString(value.market)) fail();
  if (value.asset_type === 'stock' && value.market !== 'KR' && value.market !== 'US') fail();
  if (value.direction !== 'above' && value.direction !== 'below') fail();
  if (!positivePrice(value.target_price)) fail();
  if (!isBoolean(value.repeat_enabled) || !isBoolean(value.app_enabled) || !isBoolean(value.push_enabled)) fail();
  if (!isBoolean(value.enabled) || !isBoolean(value.condition_met)) fail();
  if (!validTimestamp(value.created_at, nowMs) || !validTimestamp(value.updated_at, nowMs)) fail();
  return value;
}

function effectiveRow(value: JsonRecord): JsonRecord {
  if (value.enabled !== false || (value.app_enabled !== true && value.push_enabled !== true)) return value;
  return {
    ...value,
    app_enabled: false,
    push_enabled: false,
  };
}

function normalizeRow(value: unknown, nowMs: number): JsonRecord {
  return effectiveRow(validateRow(value, nowMs));
}

function deleteIdFromPath(path: string): string | null {
  const marker = `${PRICE_ALERT_LIST_SUFFIX}/`;
  const index = path.lastIndexOf(marker);
  if (index < 0) return null;
  const encoded = path.slice(index + marker.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function isPriceAlertResponsePath(path: string, method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (path.endsWith(PRICE_ALERT_LIST_SUFFIX)) return normalizedMethod === 'GET' || normalizedMethod === 'POST';
  return normalizedMethod === 'DELETE' && deleteIdFromPath(path) !== null;
}

export function normalizePriceAlertSuccessPayload(
  path: string,
  method: string,
  payload: unknown,
  nowMs = Date.now(),
): unknown {
  if (!isRecord(payload)) fail();
  const normalizedMethod = method.toUpperCase();

  if (path.endsWith(PRICE_ALERT_LIST_SUFFIX) && normalizedMethod === 'GET') {
    if (!Array.isArray(payload.alerts)) fail();
    let changed = false;
    const alerts = payload.alerts.map((row) => {
      const normalized = normalizeRow(row, nowMs);
      if (normalized !== row) changed = true;
      return normalized;
    });
    return changed ? { ...payload, alerts } : payload;
  }

  if (path.endsWith(PRICE_ALERT_LIST_SUFFIX) && normalizedMethod === 'POST') {
    const normalized = normalizeRow(payload.alert, nowMs);
    return normalized === payload.alert ? payload : { ...payload, alert: normalized };
  }

  if (normalizedMethod === 'DELETE') {
    const expectedId = deleteIdFromPath(path);
    if (!expectedId || payload.ok !== true || !isNonEmptyString(payload.deletedId) || payload.deletedId !== expectedId) fail();
    return payload;
  }

  fail();
}
