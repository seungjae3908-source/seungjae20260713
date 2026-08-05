import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteScannerSavedSearch,
  parseScannerSavedSearches,
  resetScannerSearchStorage,
  updateScannerSavedSearch,
  writeScannerSavedSearches,
} from './scanner-saved-searches';

const RAW = JSON.stringify([{
  id: 'saved-1', name: '국내 돌파', assetType: 'stock', market: 'KR', timeframe: '1D',
  selected: ['거래량 증가', '5일선 돌파'], preset: 'swing', volumeThreshold: 150,
  tradingValueThreshold: 150, volumeLookbackDays: 5, tradingValueLookbackDays: 5,
  marketCapThreshold: 1_000_000_000, minimumScore: 70, maximumRiskScore: 50,
  createdAt: '2026-08-04T00:00:00.000Z', updatedAt: '2026-08-04T00:00:00.000Z',
}]);

test('parses and validates the existing scanner local-storage shape', () => {
  const items = parseScannerSavedSearches(RAW);
  assert.equal(items.length, 1);
  assert.equal(items[0].market, 'KR');
  assert.deepEqual(items[0].selected, ['거래량 증가', '5일선 돌파']);
  assert.equal(items[0].minimumScore, 70);
});

test('deduplicates ids and rejects searches without conditions', () => {
  const source = JSON.parse(RAW);
  const items = parseScannerSavedSearches(JSON.stringify([
    source[0],
    { ...source[0], name: 'duplicate' },
    { ...source[0], id: 'empty', selected: [] },
  ]));
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '국내 돌파');
});

test('updates editable fields while preserving id and creation time', () => {
  const items = parseScannerSavedSearches(RAW);
  const updated = updateScannerSavedSearch(items, 'saved-1', {
    name: '미국 스윙', market: 'US', timeframe: '1H', selected: ['MACD 골든크로스'],
    minimumScore: 80, maximumRiskScore: 25,
  }, new Date('2026-08-04T01:00:00.000Z'));
  assert.equal(updated[0].id, 'saved-1');
  assert.equal(updated[0].createdAt, '2026-08-04T00:00:00.000Z');
  assert.equal(updated[0].updatedAt, '2026-08-04T01:00:00.000Z');
  assert.equal(updated[0].market, 'US');
  assert.deepEqual(updated[0].selected, ['MACD 골든크로스']);
});

test('writes normalized searches, deletes one, and clears all scanner keys', () => {
  const values = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const items = parseScannerSavedSearches(RAW);
  writeScannerSavedSearches(items, storage);
  assert.equal(values.size, 1);
  writeScannerSavedSearches(deleteScannerSavedSearch(items, 'saved-1'), storage);
  assert.equal(JSON.parse([...values.values()][0]).length, 0);
  values.set('scanner.threshold.v1', '150');
  values.set('scanner-market', 'US');
  resetScannerSearchStorage(storage);
  assert.equal(values.size, 0);
});
