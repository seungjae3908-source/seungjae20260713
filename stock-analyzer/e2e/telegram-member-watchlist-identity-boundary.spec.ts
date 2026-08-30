import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function repositoryRoot() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? path.resolve(process.cwd(), '..')
    : process.cwd();
}

test('legacy device watchlist ownership is closed and member sync invalidates old identities', () => {
  const root = repositoryRoot();
  const route = fs.readFileSync(path.join(root, 'api-server/src/routes/watchlist.ts'), 'utf8');
  const sync = fs.readFileSync(path.join(root, 'stock-analyzer/src/lib/watchlist-sync.ts'), 'utf8');

  expect(route).toContain("router.use('/', memberWatchlistRouter)");
  expect(route).toContain('LEGACY_DEVICE_WATCHLIST_DISABLED');
  expect(route).toContain("router.get('/watchlist', legacyDeviceWatchlistDisabled)");
  expect(route).toContain("router.post('/watchlist/sync', legacyDeviceWatchlistDisabled)");
  expect(route).not.toContain('WatchlistService');
  expect(route).not.toContain('deviceIdOf');
  expect(route).not.toContain("return id.length > 0 && id.length <= 128 ? id : 'default'");

  expect(sync).toContain("const MEMBER_CACHE_PREFIX = 'seungjae_member_watchlist_v1:'");
  expect(sync).toContain("const LEGACY_QUARANTINE_KEY = 'seungjae_watchlist_legacy_quarantine_v1'");
  expect(sync).toContain('requestedIdentityVersion');
  expect(sync).toContain('identityGeneration');
  expect(sync).toContain('identityAbort?.abort');
  expect(sync).toContain('validateEnvelope');
  expect(sync).toContain('same ticker in two');
  expect(sync).toContain("request('/member-watchlist/sync'");
  expect(sync).not.toContain('deviceId: getDeviceId()');
  expect(sync).not.toContain('body: JSON.stringify({ userId');
});
