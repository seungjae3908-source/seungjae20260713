// block19-d1-d2-d3.test.mjs — D-1/D-2/D-3 확정 결함 회귀 (네트워크 0건)
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGridQuantity } from '../src/grid-math.mjs';

// ─── D-1: strictCapitalSplit 정합 ───
test('D-1-a: 기본 동작 (strictCapitalSplit=false) — 하위 호환', () => {
  const q = calculateGridQuantity({
    totalInvestmentUsdt: 300, gridCount: 10, currentPrice: 100,
    leverage: 5, volumePlace: 4, minTradeNum: 0,
  });
  // 기존: perGrid = 300/10 = 30, rawSize = 30*5/100 = 1.5
  assert.equal(q, 1.5);
});

test('D-1-b: strictCapitalSplit=true — N+1 레벨 정합', () => {
  const q = calculateGridQuantity({
    totalInvestmentUsdt: 300, gridCount: 10, currentPrice: 100,
    leverage: 5, volumePlace: 4, minTradeNum: 0,
    strictCapitalSplit: true,
  });
  // perGrid = 300/11 ≈ 27.2727, rawSize = 27.2727*5/100 ≈ 1.3636
  // floor(1.3636 * 10^4) / 10^4 = 1.3636
  assert.ok(Math.abs(q - 1.3636) < 1e-4, `got ${q}`);
});

// ─── D-2: minTradeUSDT 검증 ───
test('D-2-a: minTradeUSDT=0 — 검증 skip (하위 호환)', () => {
  const q = calculateGridQuantity({
    totalInvestmentUsdt: 1, gridCount: 10, currentPrice: 100,
    leverage: 1, volumePlace: 4, minTradeNum: 0, minTradeUSDT: 0,
  });
  assert.ok(q > 0);
});

test('D-2-b: minTradeUSDT 초과 시 throw', () => {
  assert.throws(
    () => calculateGridQuantity({
      totalInvestmentUsdt: 1, gridCount: 10, currentPrice: 100,
      leverage: 1, volumePlace: 4, minTradeNum: 0,
      minTradeUSDT: 10, // notional(0.1*100=10) 이하 → throw
    }),
    /NOTIONAL_BELOW_MIN_USDT/
  );
});

test('D-2-c: minTradeUSDT 충분하면 통과', () => {
  const q = calculateGridQuantity({
    totalInvestmentUsdt: 300, gridCount: 10, currentPrice: 100,
    leverage: 5, volumePlace: 4, minTradeNum: 0,
    minTradeUSDT: 1,
  });
  assert.ok(q * 100 >= 1);
});

// ─── D-3: PF Infinity JSON-safe ───
test('D-3: computeFinalTotals 는 Infinity 처리와 무관 (스키마 회귀 방지)', async () => {
  const { computeFinalTotals } = await import('../src/backtest-engine.mjs');
  const r = computeFinalTotals({ realizedPnl: 10, unrealizedPnl: 0, investmentUsdt: 100 });
  assert.ok(Number.isFinite(r.returnPct));
});
