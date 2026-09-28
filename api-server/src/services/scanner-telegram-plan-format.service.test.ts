import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScannerAlertCandidate } from './scanner-signal.types';
import { scannerTelegramInput } from './scanner-telegram-delivery.service';

function alert(overrides: Partial<ScannerAlertCandidate> = {}): ScannerAlertCandidate {
  return {
    idempotencyKey: 'telegram-plan:test',
    signalId: 'signal:test',
    assetClass: 'stock',
    market: 'KR',
    symbol: '005930',
    direction: 'LONG',
    state: 'READY_FOR_APPROVAL',
    entryZone: { from: 100, to: 101 },
    stopLoss: 95,
    targets: [105, 110, 115],
    expiresAt: '2026-08-21T23:59:59.000Z',
    evidence: ['거래량 증가'],
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...overrides,
  };
}

test('Telegram cash signal uses unified buy wording and the same compact price plan as rich cards', () => {
  const input = scannerTelegramInput(alert(), () => 'stock-room');
  assert.ok(input);
  const details = input?.details ?? '';
  assert.match(details, /🟢 신호: 매수/);
  assert.match(details, /🟢 신호: 매수/);
  assert.match(details, /1차 진입 101 · 기본 60%/);
  assert.match(details, /1차 목표 105 · 2차 목표 110/);
  assert.match(details, /3차 목표 115/);
  assert.match(details, /손절\/무효 95/);
  assert.match(details, /근거:\n거래량 증가/);
  assert.match(details, /거래량 증가/);
});

test('Telegram signal never invents missing targets or stop prices', () => {
  const input = scannerTelegramInput(alert({ targets: [], stopLoss: null, entryZone: null }), () => 'stock-room');
  assert.ok(input);
  const details = input?.details ?? '';
  assert.match(details, /1차 진입 N\/A · 기본 60%/);
  assert.match(details, /1차 목표 N\/A · 2차 목표 N\/A/);
  assert.match(details, /손절\/무효 N\/A/);
});


test('Telegram futures SHORT keeps the same compact entry target and stop copy', () => {
  const input = scannerTelegramInput(alert({
    assetClass: 'coin_futures',
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    direction: 'SHORT',
    action: 'SHORT',
    entryZone: { from: 99, to: 101 },
    stopLoss: 105,
    targets: [95, 90],
    evidence: ['하락 구조 확인'],
  }), () => 'crypto-room');
  assert.ok(input);
  const details = input?.details ?? '';
  assert.match(details, /🟢 신호: SHORT/);
  assert.match(details, /1차 목표 95 · 2차 목표 90/);
  assert.match(details, /손절\/무효 105/);
  assert.match(details, /근거:\n하락 구조 확인/);
});
