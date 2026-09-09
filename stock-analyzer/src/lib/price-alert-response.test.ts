import { describe, expect, it } from 'vitest';
import {
  INVALID_PRICE_ALERT_RESPONSE,
  isPriceAlertResponsePath,
  normalizePriceAlertSuccessPayload,
} from './price-alert-response';

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

describe('price alert success response truth', () => {
  it('recognizes only canonical price-alert list/save/delete response paths', () => {
    expect(isPriceAlertResponsePath('/api/notifications/price-alerts', 'GET')).toBe(true);
    expect(isPriceAlertResponsePath('/api/notifications/price-alerts', 'POST')).toBe(true);
    expect(isPriceAlertResponsePath('/api/notifications/price-alerts/alert-1', 'DELETE')).toBe(true);
    expect(isPriceAlertResponsePath('/api/notifications/price-alerts/check-now', 'POST')).toBe(false);
  });

  it('rejects malformed HTTP 200 list envelopes instead of producing a safe-looking empty list', () => {
    expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', {}, now))
      .toThrow(INVALID_PRICE_ALERT_RESPONSE);
    expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: null }, now))
      .toThrow(INVALID_PRICE_ALERT_RESPONSE);
    expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: [{ ...row, asset_type: undefined }] }, now))
      .toThrow(INVALID_PRICE_ALERT_RESPONSE);
    expect(normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: [] }, now))
      .toEqual({ alerts: [] });
  });

  it('rejects impossible investment facts and materially future row timestamps', () => {
    expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: [{ ...row, target_price: 0 }] }, now))
      .toThrow(INVALID_PRICE_ALERT_RESPONSE);
    expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: [{ ...row, market: 'UPBIT' }] }, now))
      .toThrow(INVALID_PRICE_ALERT_RESPONSE);
    expect(() => normalizePriceAlertSuccessPayload('/api/notifications/price-alerts', 'GET', { alerts: [{ ...row, updated_at: '2026-09-09T13:47:00.000Z' }] }, now))
      .toThrow(INVALID_PRICE_ALERT_RESPONSE);
  });

  it('projects the canonical enabled switch into the existing channel-state consumer', () => {
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

  it('requires canonical save and delete success evidence', () => {
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
});
