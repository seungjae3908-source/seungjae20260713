import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteScannerSavedSearch,
  loadScannerSavedSearchStore,
  saveScannerSavedSearch,
  scannerSavedSearchStorageKey,
  type ScannerSavedSearch,
} from './scanner-saved-searches';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    values,
  };
}

function saved(overrides: Partial<ScannerSavedSearch> = {}): ScannerSavedSearch {
  return {
    id: 'search-1',
    name: 'KR 15m',
    assetClass: 'stock',
    market: 'KR',
    symbols: ['005930'],
    timeframe: '15m',
    selected: ['VOLUME', 'TREND'],
    alertEnabled: true,
    createdAt: '2026-08-06T07:00:00.000Z',
    updatedAt: '2026-08-06T07:00:00.000Z',
    ...overrides,
  };
}

test('saved searches are isolated by user', () => {
  const target = storage();
  const first = saveScannerSavedSearch('member-1', 0, saved(), target);
  assert.equal(first.ok, true);
  assert.equal(loadScannerSavedSearchStore('member-2', target).items.length, 0);
  assert.notEqual(scannerSavedSearchStorageKey('member-1'), scannerSavedSearchStorageKey('member-2'));
});

test('save, read, alert toggle and delete preserve market symbol and timeframe identity', () => {
  const target = storage();
  const first = saveScannerSavedSearch('member-1', 0, saved(), target);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.store.items[0].symbols, ['005930']);
  assert.equal(first.store.items[0].market, 'KR');
  assert.equal(first.store.items[0].timeframe, '15m');
  assert.equal(first.store.items[0].alertEnabled, true);

  const toggled = saveScannerSavedSearch(
    'member-1',
    first.store.revision,
    { ...first.store.items[0], alertEnabled: false },
    target,
  );
  assert.equal(toggled.ok, true);
  if (!toggled.ok) return;
  assert.equal(toggled.store.items[0].alertEnabled, false);

  const removed = deleteScannerSavedSearch('member-1', toggled.store.revision, 'search-1', target);
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.store.items.length, 0);
});

test('duplicate conditions are rejected even when names and ids differ', () => {
  const target = storage();
  const first = saveScannerSavedSearch('member-1', 0, saved(), target);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const duplicate = saveScannerSavedSearch(
    'member-1',
    first.store.revision,
    saved({ id: 'search-2', name: 'duplicate' }),
    target,
  );
  assert.deepEqual(duplicate, { ok: false, error: 'SAVED_SEARCH_DUPLICATE' });
});

test('stock spot and futures searches remain distinct', () => {
  const target = storage();
  const stock = saveScannerSavedSearch('member-1', 0, saved(), target);
  assert.equal(stock.ok, true);
  if (!stock.ok) return;
  const spot = saveScannerSavedSearch('member-1', stock.store.revision, saved({
    id: 'spot', assetClass: 'coin_spot', market: 'UPBIT_KRW', symbols: ['BTC'],
  }), target);
  assert.equal(spot.ok, true);
  if (!spot.ok) return;
  const futures = saveScannerSavedSearch('member-1', spot.store.revision, saved({
    id: 'futures', assetClass: 'coin_futures', market: 'BITGET_USDT_FUTURES', symbols: ['BTCUSDT'],
  }), target);
  assert.equal(futures.ok, true);
  if (futures.ok) assert.equal(futures.store.items.length, 3);
});

test('invalid and missing searches fail closed', () => {
  const target = storage();
  const invalid = saveScannerSavedSearch('member-1', 0, saved({ market: '', selected: [] }), target);
  assert.deepEqual(invalid, { ok: false, error: 'SAVED_SEARCH_INVALID' });
  const missing = deleteScannerSavedSearch('member-1', 0, 'missing', target);
  assert.deepEqual(missing, { ok: false, error: 'SAVED_SEARCH_NOT_FOUND' });
  assert.throws(() => scannerSavedSearchStorageKey(''), /SAVED_SEARCH_USER_REQUIRED/);
});

test('fast save and delete races reject stale revisions', () => {
  const target = storage();
  const first = saveScannerSavedSearch('member-1', 0, saved(), target);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const staleSave = saveScannerSavedSearch('member-1', 0, saved({
    id: 'stale', market: 'US', symbols: ['AAPL'],
  }), target);
  assert.deepEqual(staleSave, { ok: false, error: 'SAVED_SEARCH_CONFLICT' });
  const staleDelete = deleteScannerSavedSearch('member-1', 0, 'search-1', target);
  assert.deepEqual(staleDelete, { ok: false, error: 'SAVED_SEARCH_CONFLICT' });
});
