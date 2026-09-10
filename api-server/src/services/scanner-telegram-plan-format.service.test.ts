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

test('Telegram signal shows entry, split sell targets, and stop without implying execution', () => {
  const input = scannerTelegramInput(alert(), () => 'stock-room');
  assert.ok(input);
  const details = input?.details ?? '';
  assert.match(details, /진입가\/진입구간 100~101/);
  assert.match(details, /분할 매도가 TP1 105 · TP2 110 · TP3 115/);
  assert.match(details, /손절가 95/);
  assert.match(details, /실제 주문\/체결 아님/);
});

test('Telegram signal never invents missing sell targets or stop prices', () => {
  const input = scannerTelegramInput(alert({ targets: [], stopLoss: null, entryZone: null }), () => 'stock-room');
  assert.ok(input);
  const details = input?.details ?? '';
  assert.match(details, /진입가\/진입구간 N\/A/);
  assert.match(details, /분할 매도가 N\/A/);
  assert.match(details, /손절가 N\/A/);
});
