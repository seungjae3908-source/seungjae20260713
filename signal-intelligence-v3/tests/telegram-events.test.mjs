import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverSignalIntelligenceEvents,
  telegramRoomForSignalEvent,
  toCanonicalTelegramAlert,
} from '../src/telegram-events.mjs';

const room = (name) => ({
  KR_STOCK_ROOM: 'kr-stock-chat',
  US_STOCK_ROOM: 'us-stock-chat',
  CRYPTO_SPOT_ROOM: 'crypto-spot-chat',
  CRYPTO_FUTURES_ROOM: 'crypto-futures-chat',
})[name] ?? null;

test('KR, US, spot, and futures each route to their own Telegram room', () => {
  assert.equal(telegramRoomForSignalEvent({ market: 'KR_STOCK' }), 'KR_STOCK_ROOM');
  assert.equal(telegramRoomForSignalEvent({ market: 'US_STOCK' }), 'US_STOCK_ROOM');
  assert.equal(telegramRoomForSignalEvent({ market: 'CRYPTO_SPOT' }), 'CRYPTO_SPOT_ROOM');
  assert.equal(telegramRoomForSignalEvent({ market: 'CRYPTO_FUTURES' }), 'CRYPTO_FUTURES_ROOM');
});

test('new futures LONG/SHORT use existing canonical Telegram alert types', () => {
  const long = toCanonicalTelegramAlert({
    type: 'NEW_CANDIDATE', id: 'a', market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT',
    strategy: 'SWING', timeframe: '1h', direction: 'LONG', state: 'CANDIDATE', utilityR: 1.2,
    leverage: { status: 'INDICATIVE_ONLY', recommendedRange: { min: 1, max: 3 }, hardMaximum: 5 },
  }, room);
  const short = toCanonicalTelegramAlert({
    type: 'NEW_CANDIDATE', id: 'b', market: 'CRYPTO_FUTURES', symbol: 'ETHUSDT',
    strategy: 'SWING', timeframe: '1h', direction: 'SHORT', state: 'CANDIDATE', utilityR: 1.1,
  }, room);
  assert.equal(long.type, 'crypto_futures_long');
  assert.equal(short.type, 'crypto_futures_short');
  assert.equal(long.destinationChatId, 'crypto-futures-chat');
  assert.match(long.details, /신호 LONG/);
  assert.match(long.details, /적정 레버리지/);
  assert.match(long.details, /INDICATIVE_ONLY/);
});

test('state changes are intelligence reports, not opposite-side trade recommendations', () => {
  const alert = toCanonicalTelegramAlert({
    type: 'STATE_CHANGED', id: 'x', market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT',
    strategy: 'SWING', timeframe: '1h', direction: 'LONG', previousState: 'CANDIDATE', state: 'ABSTAIN',
    reasons: ['AI_CONTRADICTION:news_vs_price'],
  }, room);
  assert.equal(alert.type, 'intelligence_report');
  assert.match(alert.details, /CANDIDATE → ABSTAIN/);
});

test('missing dedicated room fails closed', () => {
  const alert = toCanonicalTelegramAlert({
    type: 'NEW_CANDIDATE', id: 'x', market: 'KR_STOCK', symbol: '005930',
    strategy: 'SWING', timeframe: '1D', direction: 'BUY', state: 'CANDIDATE', utilityR: 1,
  }, () => null);
  assert.equal(alert, null);
});

test('delivery failure does not mutate signal authority or throw through the cycle', async () => {
  const results = await deliverSignalIntelligenceEvents([{
    type: 'NEW_CANDIDATE', id: 'x', market: 'US_STOCK', symbol: 'AAPL',
    strategy: 'SWING', timeframe: '1D', direction: 'BUY', state: 'CANDIDATE', utilityR: 1,
  }], {
    resolveRoomChatId: room,
    sender: async () => { throw new Error('network'); },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].skipped, 'DELIVERY_FAILED');
});
