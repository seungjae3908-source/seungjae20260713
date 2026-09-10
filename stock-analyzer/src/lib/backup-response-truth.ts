export const INVALID_BACKUP_RESPONSE = 'INVALID_BACKUP_RESPONSE';

export const BACKUP_ALLOWED_KEYS = [
  'knowledge-info-asset-mode-v1',
  'sa-settings-v1',
  'stock-currency-mode',
  'app-accent-color',
  'app-appearance-mode',
  'seungjae_watchlist_v1',
  'scanner.threshold.v1',
  'scanner-market',
  'sa-saved-searches-v1',
  'sa-analysis-selection-v1',
  'sa-auto-trade-settings-v1',
  'sa-portfolio-chart-overlays-v1',
  'sa-portfolio-purchase-dates-v1',
  'sa-chart-volume-height-v1',
  'sa-chart-frames-v1',
  'sa-chart-ma-v1',
] as const;

const allowedKeySet = new Set<string>(BACKUP_ALLOWED_KEYS);
const MAX_ITEMS = 500;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function fail(): never {
  throw new Error(INVALID_BACKUP_RESPONSE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > Date.now() + MAX_FUTURE_SKEW_MS) fail();
  return value;
}

function requireChecksum(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) fail();
  return value;
}

function requireSchemaVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value !== 1) fail();
  return value;
}

function requireItemCount(value: unknown, expected: number): number {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value !== expected
    || expected < 0
    || expected > MAX_ITEMS
  ) fail();
  return value;
}

export function requireBackupStorage(value: unknown): Record<string, string> {
  if (!isRecord(value)) fail();
  const entries = Object.entries(value);
  if (entries.length > MAX_ITEMS) fail();
  for (const [key, item] of entries) {
    if (!allowedKeySet.has(key) || typeof item !== 'string') fail();
  }
  return value as Record<string, string>;
}

function parseRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') fail();
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) fail();
    return parsed;
  } catch {
    fail();
  }
}

export function isBackupSuccessResponsePath(path: string, method: string): boolean {
  return path === '/api/backup/latest' && (method === 'GET' || method === 'PUT');
}

export function requireBackupSuccessResponse(
  method: string,
  value: unknown,
  requestBody?: BodyInit | null,
): void {
  if (!isRecord(value) || value.ok !== true || typeof value.exists !== 'boolean') fail();

  if (method === 'GET') {
    if (value.exists === false) {
      const truthFields = ['schemaVersion', 'localStorage', 'itemCount', 'checksum', 'clientUpdatedAt', 'updatedAt'];
      if (truthFields.some((field) => value[field] !== undefined && value[field] !== null)) fail();
      return;
    }

    requireSchemaVersion(value.schemaVersion);
    const storage = requireBackupStorage(value.localStorage);
    requireItemCount(value.itemCount, Object.keys(storage).length);
    requireChecksum(value.checksum);
    requireTimestamp(value.clientUpdatedAt);
    requireTimestamp(value.updatedAt);
    return;
  }

  if (method === 'PUT') {
    if (value.exists !== true) fail();
    const request = parseRequestBody(requestBody);
    const schemaVersion = requireSchemaVersion(request.schemaVersion);
    const storage = requireBackupStorage(request.localStorage);
    requireTimestamp(request.clientUpdatedAt);
    if (value.schemaVersion !== schemaVersion) fail();
    requireItemCount(value.itemCount, Object.keys(storage).length);
    requireChecksum(value.checksum);
    requireTimestamp(value.clientUpdatedAt);
    requireTimestamp(value.updatedAt);
    return;
  }

  fail();
}
