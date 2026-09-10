import type { ThemesData } from '@/lib/api';

type ThemeMarket = 'KR' | 'US';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isThemeStock(value: unknown, expectedMarket: ThemeMarket): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.ticker) || !isNonEmptyString(value.name)) return false;
  if (value.market !== expectedMarket) return false;
  if (value.currency !== (expectedMarket === 'KR' ? 'KRW' : 'USD')) return false;
  if (!isFiniteNumber(value.price) || value.price <= 0) return false;
  if (!isFiniteNumber(value.changePercent)) return false;
  return true;
}

function isThemeGroup(value: unknown, expectedMarket: ThemeMarket): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.key) || !isNonEmptyString(value.label)) return false;
  if (!Number.isInteger(value.count) || (value.count as number) < 0) return false;
  if (!Array.isArray(value.stocks)) return false;
  return value.stocks.every((stock) => isThemeStock(stock, expectedMarket));
}

/**
 * HTTP 200 is transport success only. Theme/classification data is investment-facing,
 * so malformed or cross-market payloads must fail closed instead of becoming a
 * legitimate-looking empty theme list or a falsely classified stock row.
 */
export function requireThemesData(payload: unknown, expectedMarket: ThemeMarket): ThemesData {
  if (!isRecord(payload)) throw new Error('INVALID_THEMES_RESPONSE');
  if (payload.market !== expectedMarket) throw new Error('INVALID_THEMES_RESPONSE');
  if (!Array.isArray(payload.themes)) throw new Error('INVALID_THEMES_RESPONSE');
  if (!payload.themes.every((theme) => isThemeGroup(theme, expectedMarket))) {
    throw new Error('INVALID_THEMES_RESPONSE');
  }
  return payload as unknown as ThemesData;
}
