import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  INVALID_PRICE_ALERT_RESPONSE,
  isPriceAlertResponsePath,
  normalizePriceAlertSuccessPayload,
} from '../src/lib/price-alert-response';

const watchlistPath = fileURLToPath(new URL('../src/pages/watchlist.tsx', import.meta.url));
const authFetchPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const validatorPath = fileURLToPath(new URL('../src/lib/price-alert-response.ts', import.meta.url));
const backendPath = fileURLToPath(new URL('../../api-server/src/routes/push.ts', import.meta.url));
const now = Date.parse('2026-09-09T13:45:00.000Z');
const row = {
  id: 'alert-1',
  asset_type: 'stock',
  market: 'KR',
  symbol: '005930',
  direction: 'above',
  target_price: '70000',
  repeat_enabled: false,
  app_enabled: true,
  push_enabled: true,
  enabled: true,
  condition_met: false,
  created_at: '2026-09-09T13:40:00.000Z',
  updated_at: '2026-09-09T13:40:00.000Z',
};

test('price-alert response guard recognizes only canonical list/save/delete paths', () => {
  expect(isPriceAlertResponsePath('/api/notifications/price-alerts', 'GET')).toBe(true);
  expect(isPriceAlertResponsePath('/api/notifications/price-alerts', 'POST')).toBe(true);
  expect(isPriceAlertResponsePath('/api/notifications/price-alerts/alert-1', 'DELETE')).toBe(true);
  expect(isPriceAlertResponsePath('/api/notifications/price-alerts/check-now', 'POST')).toBe(false);
});

test('malformed price-alert success never becomes an empty or impossible investment fact', () => {
  expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', {}, now))
    .toThrow(INVALID_PRICE_ALERT_RESPONSE);
  expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: null }, now))
    .toThrow(INVALID_PRICE_ALERT_RESPONSE);
  expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: [{ ...row, target_price: 0 }] }, now))
    .toThrow(INVALID_PRICE_ALERT_RESPONSE);
  expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: [{ ...row, market: 'UPBIT' }] }, now))
    .toThrow(INVALID_PRICE_ALERT_RESPONSE);
  expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: [{ ...row, updated_at: '2026-09-09T13:47:00.000Z' }] }, now))
    .toThrow(INVALID_PRICE_ALERT_RESPONSE);
  expect(normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: [] }, now))
    .toEqual({ alerts: [] });
});

test('inactive one-shot alerts cannot retain an effective enabled channel state', () => {
  const payload = normalizePriceAlertSuccessPayload(
    '/api/notifications/price-alerts',
    'GET',
    { alerts: [{ ...row, enabled: false, condition_met: true }] },
    now,
  ) as { alerts: Array<Record<string, unknown>> };

  expect(payload.alerts[0]?.enabled).toBe(false);
  expect(payload.alerts[0]?.app_enabled).toBe(false);
  expect(payload.alerts[0]?.push_enabled).toBe(false);
});

test('save and delete require canonical authoritative success evidence', () => {
  expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'POST', { ok: true }, now))
    .toThrow(INVALID_PRICE_ALERT_RESPONSE);
  expect(normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'POST', { alert: row }, now))
    .toEqual({ alert: row });
  expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts/alert-1', 'DELETE', { ok: true }, now))
    .toThrow(INVALID_PRICE_ALERT_RESPONSE);
  expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts/alert-1', 'DELETE', { ok: true, deletedId: 'other' }, now))
    .toThrow(INVALID_PRICE_ALERT_RESPONSE);
  expect(normalizePriceAlertSuccessPayload('/api/notifications/price-alerts/alert-1', 'DELETE', { ok: true, deletedId: 'alert-1' }, now))
    .toEqual({ ok: true, deletedId: 'alert-1' });
});

test('price-alert HTTP 200 responses fail closed before watchlist empty/success state', async () => {
  const [watchlist, authFetch, validator, backend] = await Promise.all([
    readFile(watchlistPath, 'utf8'),
    readFile(authFetchPath, 'utf8'),
    readFile(validatorPath, 'utf8'),
    readFile(backendPath, 'utf8'),
  ]);

  expect(watchlist).toContain('apiGet<{ alerts?: PriceAlertRow[] }>("/notifications/price-alerts")');
  expect(watchlist).toContain('(alertsQuery.data?.alerts ?? [])');
  expect(watchlist).toContain('alertsError={alertsQuery.isError}');
  expect(watchlist).toContain('row.app_enabled === true || row.push_enabled === true');

  expect(authFetch).toContain('isPriceAlertResponsePath(path, method)');
  expect(authFetch).toContain('normalizePriceAlertSuccessPayload(path, method, payload)');
  expect(authFetch).toContain('throw new Error(INVALID_PRICE_ALERT_RESPONSE)');

  expect(validator).toContain("value.asset_type !== 'stock'");
  expect(validator).toContain('!isBoolean(value.enabled) || !isBoolean(value.condition_met)');
  expect(validator).toContain('value.enabled !== false');
  expect(validator).toContain('payload.deletedId !== expectedId');

  expect(backend).toContain('res.json({ alerts: data ?? [] });');
  expect(backend).toContain('res.json({ alert: data });');
  expect(backend).toContain('deletedId: String(data.id),');
});
