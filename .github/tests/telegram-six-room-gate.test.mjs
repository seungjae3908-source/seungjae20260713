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


test('scanner and signal follow-ups reuse strict venue recognition, never "includes US" defaults', () => {
  const scanner = fs.readFileSync('api-server/src/services/scanner-telegram-delivery.service.ts', 'utf8');
  const followup = fs.readFileSync('api-server/src/services/telegram-signal-followup.service.ts', 'utf8');
  const router = fs.readFileSync('api-server/src/services/telegram-market-room.service.ts', 'utf8');
  for (const source of [scanner, followup]) {
    assert.ok(source.includes('telegramStockLaneForMarket('), 'shared stock venue classifier required');
    assert.ok(!source.includes("market.trim().toUpperCase().includes('US')"), 'legacy ambiguous US substring detection forbidden');
  }
  assert.ok(router.includes('telegramStockLaneForMarket(market: string)'));
  for (const id of ['TELEGRAM_KR_STOCK_CHAT_ID', 'TELEGRAM_US_STOCK_CHAT_ID',
    'TELEGRAM_CRYPTO_SPOT_CHAT_ID', 'TELEGRAM_CRYPTO_FUTURES_CHAT_ID',
    'TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID', 'TELEGRAM_AUTO_TRADING_CHAT_ID']) {
    assert.ok(router.includes('env.' + id), 'six-room collision guard must check ' + id);
  }
  assert.ok(router.includes('return new Set(dedicatedIds).size === dedicatedIds.length;'));
  assert.ok(router.includes('if (!telegramSixRoomRoutingIsolated(env)) return null;'));
  const holdings = fs.readFileSync('api-server/src/services/member-holdings-telegram-alert.service.ts','utf8');
  const auto = fs.readFileSync('api-server/src/features/user-broker-telegram/user-broker-telegram.service.ts','utf8');
  assert.ok(holdings.includes('telegramSixRoomRoutingIsolated(env)'), 'owner holdings mirror must share six-room gate');
  assert.ok(auto.includes('telegramSixRoomRoutingIsolated({'), 'owner AUTO mirror must share six-room gate');
});


test('both protected Telegram preflights verify room types and bot posting rights read-only', () => {
  const begin = 'function telegramDedicatedRoomGuard(label, chat, member) {';
  const starts = [...release.matchAll(/function telegramDedicatedRoomGuard\(label, chat, member\) \{/g)].map(match => match.index);
  assert.equal(starts.length, 2, 'must guard both pre-mutation and pre-activation checks');
  const first = release.slice(starts[0], release.indexOf('const errors = [];', starts[0]));
  const second = release.slice(starts[1], release.indexOf('const telegramPreflightErrors = [];', starts[1]));
  const classify = vm.runInNewContext(first + '\ntelegramDedicatedRoomGuard;');
  const classifyAgain = vm.runInNewContext(second + '\ntelegramDedicatedRoomGuard;');
  const cases = [
    ['KR_STOCK_CHAT', {type: 'group'}, {status:'member'}, null],
    ['US_STOCK_CHAT', {type: 'supergroup'}, {status:'administrator'}, null],
    ['AUTO_TRADING_CHAT', {type:'channel'}, {status:'administrator',can_post_messages:true}, null],
    ['HOLDINGS_CHAT', {type:'channel'}, {status:'creator'}, null],
    ['KR_STOCK_CHAT', {type:'private'}, {status:'member'}, 'KR_STOCK_CHAT_INVALID_ROOM_TYPE'],
    ['US_STOCK_CHAT', {type:'channel'}, {status:'member'}, 'US_STOCK_CHAT_CHANNEL_POST_DENIED'],
    ['AUTO_TRADING_CHAT', {type:'channel'}, {status:'administrator',can_post_messages:false}, 'AUTO_TRADING_CHAT_CHANNEL_POST_DENIED'],
    ['HOLDINGS_CHAT', {type:'supergroup'}, {status:'restricted',can_send_messages:false}, 'HOLDINGS_CHAT_BOT_WRITE_DENIED'],
    ['CRYPTO_SPOT_CHAT', {type:'supergroup'}, {status:'kicked'}, 'CRYPTO_SPOT_CHAT_BOT_MEMBERSHIP_INVALID'],
    ['CRYPTO_FUTURES_CHAT', {type:'supergroup'}, null, 'CRYPTO_FUTURES_CHAT_BOT_MEMBERSHIP_INVALID'],
    ['DEFAULT_CHAT', {type:'private'}, {status:'member'}, null],
  ];
  for (const [label, chat, member, expected] of cases) {
    assert.equal(classify(label, chat, member), expected, label + ' first');
    assert.equal(classifyAgain(label, chat, member), expected, label + ' second');
  }
  const beforeMutation = release.indexOf('Apply and verify Production personal Telegram storage atomically');
  const activate = release.indexOf('const activationChanged = activateApprovedTelegram(');
  assert.ok(starts[0] > 0 && starts[0] < beforeMutation, 'first read-only gate runs before DB migration');
  assert.ok(starts[1] > beforeMutation && starts[1] < activate, 'second read-only gate runs before activation');
  assert.equal((release.match(/getChatMember', \{ chat_id:/g) ?? []).length, 2,
    'must read each dedicated bot membership twice across protected preflights');
  assert.equal((release.match(/_INVALID_ROOM_TYPE/g) ?? []).length >= 4, true);
  assert.equal(release.includes("console.log(chat.value?.result)"), false);
  assert.equal(release.includes("console.log(membership.value?.result)"), false);
  assert.equal(release.includes("console.log(room.value?.result)"), false);
});
