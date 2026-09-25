import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTelegramScannerIntent } from './telegram-scanner-intent';

test('parses public Telegram scanner order-preparation intent without identity', () => {
  const intent = parseTelegramScannerIntent('?source=telegram&orderPreparation=1&market=KR&symbol=005930&strategyMode=scalping&timeframe=15m&action=BUY');
  assert.deepEqual(intent, {
    source: 'telegram',
    market: 'KR',
    view: 'KR',
    symbol: '005930',
    strategyMode: 'scalping',
    timeframe: '15m',
    action: 'BUY',
    orderPreparation: true,
  });
});

test('rejects Telegram intent that tries to carry user or account identity', () => {
  for (const key of ['userId', 'memberId', 'chatId', 'accountId']) {
    assert.equal(
      parseTelegramScannerIntent(`?source=telegram&orderPreparation=1&market=KR&symbol=005930&action=BUY&${key}=someone-else`),
      null,
    );
  }
});

test('normalizes crypto markets and keeps futures direction explicit', () => {
  assert.deepEqual(
    parseTelegramScannerIntent('?source=telegram&orderPreparation=1&market=BITGET&symbol=dogeusdt&strategyMode=swing&action=SHORT'),
    {
      source: 'telegram',
      market: 'BITGET',
      view: 'FUTURES',
      symbol: 'DOGEUSDT',
      strategyMode: 'swing',
      timeframe: null,
      action: 'SHORT',
      orderPreparation: true,
    },
  );
  assert.equal(
    parseTelegramScannerIntent('?source=telegram&orderPreparation=1&market=UPBIT&symbol=KRW-DOGE&action=SHORT'),
    null,
  );
});

test('rejects malformed or non-Telegram deep links', () => {
  assert.equal(parseTelegramScannerIntent('?market=KR&symbol=005930'), null);
  assert.equal(parseTelegramScannerIntent('?source=telegram&orderPreparation=1&market=KR&symbol=%3Cscript%3E'), null);
});
