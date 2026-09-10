import { expect, test } from '@playwright/test';
import type { SummaryItem } from '../src/lib/api';
import {
  normalizeMarketSummaryResponse,
  validMarketSummaryItems,
} from '../src/lib/market-summary';

function item(
  key: string,
  overrides: Partial<SummaryItem> = {},
): SummaryItem {
  return {
    key,
    label: key.toUpperCase(),
    price: 100,
    changePercent: 1,
    spark: [],
    unit: 'index',
    ok: true,
    ...overrides,
  };
}

test('mixed provider results stay partial and expose missing keys', () => {
  const ready = item('kospi');
  const failed = item('kosdaq', { price: 0, changePercent: 0, ok: false });
  const result = normalizeMarketSummaryResponse({
    items: [ready, failed],
    ok: true,
    updatedAt: '2026-08-30T10:00:00.000Z',
  });

  expect(result.available).toBe(true);
  expect(result.partial).toBe(true);
  expect(result.dataState).toBe('partial');
  expect(result.availableCount).toBe(1);
  expect(result.totalCount).toBe(2);
  expect(result.missingKeys).toEqual(['kosdaq']);
  expect(result.retryable).toBe(true);
  expect(result.error).toBe('SUMMARY_PROVIDER_PARTIAL');
  expect(validMarketSummaryItems(result.items)).toEqual([ready]);
});

test('failed rows never receive usable market-value credit even with a numeric price', () => {
  const failed = item('nasdaq', { price: 18_000, changePercent: 2.5, ok: false });
  const result = normalizeMarketSummaryResponse({ items: [failed] });

  expect(result.available).toBe(false);
  expect(result.partial).toBe(false);
  expect(result.dataState).toBe('provider_error');
  expect(result.availableCount).toBe(0);
  expect(result.missingKeys).toEqual(['nasdaq']);
  expect(result.error).toBe('SUMMARY_PROVIDER_UNAVAILABLE');
  expect(validMarketSummaryItems(result.items)).toEqual([]);
});

test('zero-price rows fail closed even if a provider marks them ok', () => {
  const invalid = item('sp500', { price: 0, ok: true });
  const result = normalizeMarketSummaryResponse({ items: [invalid] });

  expect(result.dataState).toBe('provider_error');
  expect(result.available).toBe(false);
  expect(result.availableCount).toBe(0);
  expect(result.missingKeys).toEqual(['sp500']);
});

test('complete usable results remain ready without inventing missing state', () => {
  const rows = [item('kospi'), item('nasdaq', { price: 20_000, changePercent: -0.5 })];
  const result = normalizeMarketSummaryResponse({ items: rows, provider: 'yahoo' });

  expect(result.ok).toBe(true);
  expect(result.available).toBe(true);
  expect(result.partial).toBe(false);
  expect(result.dataState).toBe('ready');
  expect(result.availableCount).toBe(2);
  expect(result.totalCount).toBe(2);
  expect(result.missingKeys).toEqual([]);
  expect(result.retryable).toBe(false);
  expect(result.error).toBeNull();
  expect(result.errorCode).toBeNull();
  expect(result.message).toBeNull();
});
