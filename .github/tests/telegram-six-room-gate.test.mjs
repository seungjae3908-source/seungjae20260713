import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const release = fs.readFileSync('.github/workflows/telegram-production-release.yml', 'utf8');
const start = release.indexOf('function requireIsolatedSixRooms(runtime) {');
const end = release.indexOf('requireIsolatedSixRooms(env);', start);
assert.ok(start > 0 && end > start, 'isolation code must be present before any remote mutations');
const guard = vm.runInNewContext(release.slice(start, end) + '\nrequireIsolatedSixRooms;');

function rooms() {
  return {
    TELEGRAM_KR_STOCK_CHAT_ID: '-100000001',
    TELEGRAM_US_STOCK_CHAT_ID: '-100000002',
    TELEGRAM_CRYPTO_SPOT_CHAT_ID: '-100000003',
    TELEGRAM_CRYPTO_FUTURES_CHAT_ID: '-100000004',
    TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID: '-100000005',
    TELEGRAM_AUTO_TRADING_CHAT_ID: '-100000006',
    TELEGRAM_OWNER_MEMBER_ID: 'owner-member',
    TELEGRAM_STOCK_CHAT_ID: '-100000001',
    TELEGRAM_CRYPTO_CHAT_ID: '-100000003',
  };
}

test('six independent rooms and owner identity pass without exposing chat IDs', () => {
  assert.equal(guard(rooms()), true);
});
test('legacy stock and crypto fallbacks cannot replace an absent dedicated room', () => {
  const value = rooms();
  delete value.TELEGRAM_US_STOCK_CHAT_ID;
  assert.throws(() => guard(value), /TELEGRAM_SIX_ROOM_CONFIG_MISSING/);
});
test('all six rooms must be distinct, including holdings and AUTO notifications', () => {
  const value = rooms();
  value.TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID = value.TELEGRAM_AUTO_TRADING_CHAT_ID;
  assert.throws(() => guard(value), /TELEGRAM_SIX_ROOM_ROUTING_COLLISION/);
});
test('space-padded duplicate destinations still fail', () => {
  const value = rooms();
  value.TELEGRAM_US_STOCK_CHAT_ID = ' ' + value.TELEGRAM_KR_STOCK_CHAT_ID + ' ';
  assert.throws(() => guard(value), /TELEGRAM_SIX_ROOM_ROUTING_COLLISION/);
});
test('owner holdings require a configured owner member even with six chat IDs', () => {
  const value = rooms();
  value.TELEGRAM_OWNER_MEMBER_ID = '';
  assert.throws(() => guard(value), /TELEGRAM_SIX_ROOM_CONFIG_MISSING/);
});
test('same guard is required before mutation, before activation, and after PM2 restart', () => {
  assert.equal((release.match(/function requireIsolatedSixRooms\(runtime\) \{/g) || []).length, 2);
  assert.ok((release.match(/requireIsolatedSixRooms\(env\);/g) || []).length >= 3);
  assert.ok(release.indexOf('requireIsolatedSixRooms(env);') < release.indexOf('Apply and verify Production personal Telegram storage atomically'));
  assert.ok(release.lastIndexOf('requireIsolatedSixRooms(env);') > release.indexOf('TELEGRAM_POST_RESTART_IDENTITY_MISMATCH'));
});


test('market signal, follow-up and intelligence subscriber never fall back to shared legacy rooms', () => {
  const marketSources = [
    'api-server/src/services/scanner-telegram-delivery.service.ts',
    'api-server/src/services/telegram-signal-followup.service.ts',
    'api-server/src/services/signal-intelligence-telegram-subscriber.service.ts',
  ];
  for (const filename of marketSources) {
    const source = fs.readFileSync(filename, 'utf8');
    assert.ok(source.includes('telegramMarketRoomChatId('), `${filename}: dedicated market router required`);
    assert.ok(!source.includes('allowLegacyFallback: true'), `${filename}: legacy market room fallback is unsafe`);
  }
  const router = fs.readFileSync('api-server/src/services/telegram-market-room.service.ts', 'utf8');
  assert.ok(router.includes('if (options.allowLegacyFallback !== true) return null;'), 'missing dedicated IDs fail closed');
});
