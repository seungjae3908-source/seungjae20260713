import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const read = file => fs.readFileSync(file,'utf8');
const sync = read('stock-analyzer/src/lib/watchlist-sync.ts');
const page = read('stock-analyzer/src/pages/watchlist.tsx');
const flow = read('.github/workflows/telegram-only-staging-qa.yml');
test('import is opt-in; old device data is never silently member-owned', () => {
  assert.match(sync,/q\.importedIntoMember !== false/);
  assert.match(sync,/!activeMemberId \|\| !identityHydrated/);
  assert.ok(sync.includes('importConfirmedLegacyWatchlist'));
  assert.ok(page.includes('watchlist-legacy-consent-review'));
  assert.ok(page.includes('disabled={!legacyConsent || legacyBusy}'));
  assert.ok(page.includes('onClick={() => void confirmLegacyImport()}'));
  assert.ok(sync.includes('LEGACY_WATCHLIST_IMPORT_MARKET_CONFLICT'));
});
test('only the authenticated account can confirm server-echoed imports', () => {
  for(const required of [
    'await authenticatedMemberId() !== memberId',
    "request('/member-watchlist', { method: 'GET' }",
    "request('/member-watchlist/sync'",
    'LEGACY_WATCHLIST_IMPORT_NOT_CONFIRMED',
    'window.localStorage.getItem(LEGACY_QUARANTINE_KEY) !== oldQuarantine',
    'activeMemberId !== memberId || identityGeneration !== version',
  ])assert.ok(sync.includes(required),required);
  assert.ok(sync.includes('body: JSON.stringify({ items: desired })'));
  assert.ok(!sync.includes('body: JSON.stringify({ userId'));
  assert.ok(!sync.includes('body: JSON.stringify({ deviceId'));
  assert.ok(!sync.includes('legacyDetailRaw: value.legacyDetailRaw'));
});
test('Telegram Staging QA checks the UI consent implementation on changes', () => {
  for(const file of [
    'stock-analyzer/src/lib/watchlist-sync.ts',
    'stock-analyzer/src/pages/watchlist.tsx',
    'stock-analyzer/e2e/telegram-member-watchlist-identity-boundary.spec.ts',
    '.github/tests/telegram-watchlist-consent-contract.test.mjs',
  ])assert.ok(flow.includes(file),file);
  assert.ok(flow.includes("environment: staging"));
  assert.ok(flow.includes("github.event.comment.author_association == 'OWNER'"));
  assert.ok(flow.includes("Telegram-only service tests (no Browser, no network delivery)"));
});
