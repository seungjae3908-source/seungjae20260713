// block19-backtest-accounting.test.mjs
// BLOCK 19 Phase 1 — 손익 회계 수정 검증 (네트워크 0건)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTradeNetPnl,
  computeUnrealizedPnl,
  computeFinalTotals,
} from '../src/backtest-engine.mjs';

const EPS = 1e-9;
const approx = (a, b) => Math.abs(a - b) < EPS;

test('T1: 완료 거래 — 수수료 이중 차감 방지', () => {
  const r = computeTradeNetPnl({ entryPrice: 100, exitPrice: 110, qty: 1, direction: 'BUY', feeRate: 0.001 });
  assert.ok(approx(r.gross, 10), `gross ${r.gross} !== 10`);
  assert.ok(approx(r.entryFee, 0.10), `entryFee ${r.entryFee} !== 0.10`);
  assert.ok(approx(r.exitFee, 0.11), `exitFee ${r.exitFee} !== 0.11`);
  assert.ok(approx(r.netPnl, 9.79), `netPnl ${r.netPnl} !== 9.79`);
  assert.ok(approx(r.totalFees, 0.21), `totalFees ${r.totalFees} !== 0.21`);

  const agg = computeFinalTotals({ realizedPnl: r.netPnl, unrealizedPnl: 0, investmentUsdt: 1000 });
  assert.ok(approx(agg.netPnl, 9.79), `aggregate netPnl ${agg.netPnl} !== 9.79 (double-subtract bug?)`);
  assert.ok(approx(agg.finalEquity, 1009.79), `finalEquity ${agg.finalEquity} !== 1009.79`);
});

test('T2: 손실 거래', () => {
  const r = computeTradeNetPnl({ entryPrice: 100, exitPrice: 90, qty: 1, direction: 'BUY', feeRate: 0.001 });
  assert.ok(approx(r.gross, -10));
  assert.ok(approx(r.totalFees, 0.19));
  assert.ok(approx(r.netPnl, -10.19));
});

test('T3: 미청산 포지션 — 진입 수수료 1회만', () => {
  const u = computeUnrealizedPnl({ entryPrice: 100, markPrice: 110, qty: 1, direction: 'BUY', entryFee: 0.10 });
  assert.ok(approx(u, 9.90), `unreal ${u} !== 9.90`);

  const agg = computeFinalTotals({ realizedPnl: 0, unrealizedPnl: u, investmentUsdt: 1000 });
  assert.ok(approx(agg.finalEquity, 1009.90), `finalEquity ${agg.finalEquity} !== 1009.90`);
});

test('T4: 완료 거래 + 미청산 혼합', () => {
  const t1 = computeTradeNetPnl({ entryPrice: 100, exitPrice: 110, qty: 1, direction: 'BUY', feeRate: 0.001 });
  const u1 = computeUnrealizedPnl({ entryPrice: 100, markPrice: 105, qty: 1, direction: 'BUY', entryFee: 0.10 });
  const agg = computeFinalTotals({ realizedPnl: t1.netPnl, unrealizedPnl: u1, investmentUsdt: 1000 });
  assert.ok(approx(agg.netPnl, 9.79 + 4.90), `netPnl ${agg.netPnl} !== 14.69`);
  assert.ok(approx(agg.finalEquity, 1000 + 9.79 + 4.90));
});

test('T5: Equity — totalFees 재차감 없음', () => {
  const t = computeTradeNetPnl({ entryPrice: 100, exitPrice: 110, qty: 1, direction: 'BUY', feeRate: 0.001 });
  const agg = computeFinalTotals({ realizedPnl: t.netPnl, unrealizedPnl: 0, investmentUsdt: 1000 });
  // Old bug: 1000 + 9.79 - 0.21 = 1009.58
  // Fixed:   1000 + 9.79 = 1009.79
  assert.ok(approx(agg.finalEquity, 1009.79), `finalEquity ${agg.finalEquity} — double-subtract?`);
  assert.ok(!approx(agg.finalEquity, 1009.58), `finalEquity ${agg.finalEquity} equals buggy value!`);
});

test('T6: PF Infinity — JSON null (문서화, 코드 변경 없음)', () => {
  const json = JSON.parse(JSON.stringify({ pf: Infinity }));
  assert.equal(json.pf, null); // V8 quirk — 별도 이슈로 보고
});

test('T-Short: SHORT 방향 회계도 net 1회', () => {
  const r = computeTradeNetPnl({ entryPrice: 100, exitPrice: 90, qty: 1, direction: 'SELL', feeRate: 0.001 });
  assert.ok(approx(r.gross, 10));
  assert.ok(approx(r.netPnl, 10 - 0.10 - 0.09));
  assert.ok(approx(r.totalFees, 0.19));
});

test('T-Edge: qty=0 방어', () => {
  const r = computeTradeNetPnl({ entryPrice: 100, exitPrice: 110, qty: 0, direction: 'BUY', feeRate: 0.001 });
  assert.equal(r.gross, 0);
  assert.equal(r.netPnl, 0);
  assert.equal(r.totalFees, 0);
});
