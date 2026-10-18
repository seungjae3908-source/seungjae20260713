import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileUpbitNoTradeMinutesV1, fillVerifiedNoTradeBarsV1 } from '../src/upbit-no-trade-reconcile-v1.mjs';

const DAY = 1_760_000_000_000 - (1_760_000_000_000 % 86_400_000);
function day(missing = []) {
  const bars = [];
  let price = 100;
  for (let i = 0; i < 1440; i += 1) {
    if (missing.includes(i)) continue;
    const open = price; price += (i % 3) - 1; const closeP = price;
    bars.push({ timestamp: DAY + i * 60_000, open, high: Math.max(open, closeP) + 0.5, low: Math.min(open, closeP) - 0.5, close: closeP, volume: 1 + (i % 5) });
  }
  const candle = {
    open: bars[0].open, close: bars.at(-1).close, high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)), volume: bars.reduce((s, b) => s + b.volume, 0),
  };
  return { bars, candle };
}

test('complete day passes without gaps', () => {
  const { bars, candle } = day();
  assert.equal(reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY, minuteBars: bars, dayCandle: candle }).status, 'COMPLETE');
});

test('missing minutes certified as no-trade only when volume, range, open and close all reconcile', () => {
  const { bars, candle } = day([500, 501, 1200]);
  const proof = reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY, minuteBars: bars, dayCandle: candle });
  assert.equal(proof.status, 'VERIFIED_NO_TRADE_GAPS');
  assert.equal(proof.noTradeCount, 3);
  const filled = fillVerifiedNoTradeBarsV1(bars, proof, candle);
  assert.equal(filled.length, 1440);
  const synth = filled.filter((b) => b.synthetic);
  assert.equal(synth.length, 3);
  assert.ok(synth.every((b) => b.volume === 0 && b.open === b.close && b.high === b.low));
});

test('a collection gap (traded minute dropped) is rejected: volume no longer reconciles', () => {
  const { bars, candle } = day();
  const dropped = bars.filter((_, i) => i !== 700);
  const r = reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY, minuteBars: dropped, dayCandle: candle });
  assert.equal(r.status, 'HOLD');
  assert.equal(r.code, 'VOLUME_MISMATCH_COLLECTION_GAP');
  assert.equal(fillVerifiedNoTradeBarsV1(dropped, r, candle), null);
});

test('dropping the extreme-high minute with volume that hides elsewhere is still caught by range/open/close', () => {
  const { bars, candle } = day();
  const hi = bars.findIndex((b) => b.high === candle.high);
  const tampered = bars.map((b, i) => (i === hi ? { ...b, high: candle.high - 5, close: b.close } : b));
  const r = reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY, minuteBars: tampered.filter((_, i) => i !== 5), dayCandle: candle });
  assert.equal(r.status, 'HOLD');
});

test('too many missing minutes, empty day, malformed input, misaligned day and duplicates all fail closed', () => {
  const many = day(Array.from({ length: 100 }, (_, i) => i * 10));
  assert.equal(reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY, minuteBars: many.bars, dayCandle: many.candle }).code, 'TOO_MANY_MISSING_MINUTES');
  assert.equal(reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY, minuteBars: [], dayCandle: { open: 1, high: 1, low: 1, close: 1, volume: 5 } }).code, 'DAY_EMPTY_BUT_DAY_CANDLE_HAS_VOLUME');
  assert.equal(reconcileUpbitNoTradeMinutesV1(null).status, 'HOLD');
  assert.equal(reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY + 1, minuteBars: [], dayCandle: many.candle }).code, 'DAY_START_NOT_UTC_DAY_ALIGNED');
  const { bars, candle } = day([10]);
  assert.equal(reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY, minuteBars: [...bars, bars[0]], dayCandle: candle }).code, 'MINUTE_BAR_DUPLICATE');
  assert.equal(reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY, minuteBars: [...bars, { ...bars[0], timestamp: DAY + 86_400_000 }], dayCandle: candle }).code, 'MINUTE_BAR_OUTSIDE_DAY');
  assert.equal(reconcileUpbitNoTradeMinutesV1({ dayStartMs: DAY, minuteBars: bars, dayCandle: candle, maxNoTradeMinutes: 0 }).code, 'TOO_MANY_MISSING_MINUTES');
});
