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

test('Telegram signal shows direction, action, TP/SL percentages, reasons, and no-order action state', () => {
  const input = scannerTelegramInput(alert(), () => 'stock-room');
  assert.ok(input);
  const details = input?.details ?? '';
  assert.match(details, /🚨 진입가능/);
  assert.match(details, /신호 LONG · 행동 BUY/);
  assert.match(details, /진입 100~101/);
  assert.match(details, /익절 TP1 105 \(\+4\.48%\) · TP2 110 \(\+9\.45%\) · TP3 115 \(\+14\.43%\)/);
  assert.match(details, /손절 95 \(-5\.47%\)/);
  assert.match(details, /실제 행동: 주문 미제출 · 거래소 요청 없음/);
  assert.match(details, /판단 이유: 거래량 증가/);
});

test('Telegram signal never invents missing targets or stop prices', () => {
  const input = scannerTelegramInput(alert({ targets: [], stopLoss: null, entryZone: null }), () => 'stock-room');
  assert.ok(input);
  const details = input?.details ?? '';
  assert.match(details, /진입 N\/A/);
  assert.match(details, /익절 N\/A/);
  assert.match(details, /손절 N\/A \(N\/A\)/);
});


test('Telegram futures SHORT expresses favorable target and adverse stop as signed percentages', () => {
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
  assert.match(details, /신호 SHORT · 행동 SHORT/);
  assert.match(details, /TP1 95 \(\+5\.00%\)/);
  assert.match(details, /TP2 90 \(\+10\.00%\)/);
  assert.match(details, /손절 105 \(-5\.00%\)/);
  assert.match(details, /판단 이유: 하락 구조 확인/);
});
