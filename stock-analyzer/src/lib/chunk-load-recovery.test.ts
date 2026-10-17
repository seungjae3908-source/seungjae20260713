import assert from 'node:assert/strict';
import test from 'node:test';
import { CHUNK_RELOAD_STORAGE_KEY, CHUNK_RELOAD_WINDOW_MS, claimChunkReload, shouldAutoReloadForChunkError } from './chunk-load-recovery';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

test('allows exactly one automatic reload inside the guard window', () => {
  const storage = memoryStorage();
  assert.equal(claimChunkReload(storage, 1_000_000), true);
  assert.equal(storage.values.get(CHUNK_RELOAD_STORAGE_KEY), '1000000');
  assert.equal(claimChunkReload(storage, 1_000_000 + 5_000), false);
  assert.equal(claimChunkReload(storage, 1_000_000 + CHUNK_RELOAD_WINDOW_MS + 1), true);
});

test('never reloads when storage is missing or throws', () => {
  assert.equal(claimChunkReload(null), false);
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.equal(claimChunkReload(throwing), false);
});

test('never reloads while the browser is offline and keeps the one-shot guard unspent', () => {
  const storage = memoryStorage();
  assert.equal(shouldAutoReloadForChunkError(false, storage, 1_000_000), false);
  assert.equal(storage.values.has(CHUNK_RELOAD_STORAGE_KEY), false);
  assert.equal(shouldAutoReloadForChunkError(true, storage, 1_000_000 + 1_000), true);
  // Unknown connectivity (no navigator) keeps the normal one-shot behavior.
  assert.equal(shouldAutoReloadForChunkError(undefined, memoryStorage(), 1_000_000), true);
});
