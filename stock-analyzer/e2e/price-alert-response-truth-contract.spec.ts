import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const watchlistPath = fileURLToPath(new URL('../src/pages/watchlist.tsx', import.meta.url));
const authFetchPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const validatorPath = fileURLToPath(new URL('../src/lib/price-alert-response.ts', import.meta.url));
const backendPath = fileURLToPath(new URL('../../api-server/src/routes/push.ts', import.meta.url));

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

  expect(backend).toContain('res.json({ alerts: rows || [] });');
  expect(backend).toContain('res.status(201).json({ alert: data });');
  expect(backend).toContain('res.json({ ok: true, deletedId: id });');
});
