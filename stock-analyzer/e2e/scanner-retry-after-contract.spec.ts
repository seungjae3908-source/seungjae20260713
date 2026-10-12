import { test, expect } from '@playwright/test';
import { parseSignalScannerRetryAfter } from '../src/lib/scanner-retry-after';

test('missing Retry-After header falls back to the actual server JSON retry', () => {
  expect(parseSignalScannerRetryAfter(null, 19)).toBe(19);
  expect(parseSignalScannerRetryAfter('', '35')).toBe(35);
  expect(parseSignalScannerRetryAfter(null, undefined)).toBeNull();
  expect(parseSignalScannerRetryAfter(undefined as unknown as null, null)).toBeNull();
});

test('valid server header wins and malformed values never bypass backoff', () => {
  expect(parseSignalScannerRetryAfter('5', 24)).toBe(5);
  expect(parseSignalScannerRetryAfter(' 2.1 ', 20)).toBe(3);
  expect(parseSignalScannerRetryAfter('invalid', 12)).toBe(12);
  expect(parseSignalScannerRetryAfter('-1', 15)).toBe(15);
  expect(parseSignalScannerRetryAfter(null, 'NaN')).toBeNull();
  expect(parseSignalScannerRetryAfter('99999999', 1)).toBe(3_600);
});
