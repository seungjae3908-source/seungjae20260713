// block19-neutral-grid.test.mjs
// BLOCK 19 Step 6-C — NEUTRAL_GRID Paper 테스트 (levels 동적 참조)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createNeutralGridState,
  processNeutralGridCandle,
  executeNeutralGridStep,
  saveNeutralState,
  loadNeutralStateSafe,
  validateCandle,
} from '../src/neutral-grid-paper.mjs';
import { processAIPaperBar, getRuntimePaths } from '../src/orchestrator-ai-paper.mjs';
import { DIRECTION, STRATEGY } from '../src/ai-strategy-selector.mjs';

const NOW = 1_700_000_000_000;
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'b19n-')); }

// levels = [90, 94, 98, 102, 106] (gridCount=5, slice 로 5개만 유지)
function baseStateInit(over = {}) {
  const r = createNeutralGridState({
    symbol: 'BTCUSDT', lowerPrice: 90, upperPrice: 110, gridCount: 5,
    quantityPerGrid: 10, initialUsdt: 1000, feeRate: 0.0006, nowMs: NOW,
    ...over,
  });
  assert.equal(r.ok, true, `init 실패: ${r.reason}`);
  // levels[0..2]=[90,94,98] < close=100 → BUY_PENDING, [3..4] > 100 → EMPTY
  for (const lv of r.state.levels) if (lv.price < 100) lv.state = 'BUY_PENDING';
  return r.state;
}
function candle(over = {}) {
  return { open: 100, high: 101, low: 99, close: 100, volume: 1000, ts: NOW + 1, ...over };
}
function sidewaysIndicators() {
  return { atr: 0.5, adx: 15, rsi: 50, macdHistogram: 0.01, bbWidth: 0.02, vwap: 100, currentPrice: 100 };
}

test('N1: NEUTRAL 정상 실행 — orchestrator 경유', () => {
  const dir = tmpDir();
  const paths = getRuntimePaths(path.join(dir, 'paper-ai'));
  const r = processAIPaperBar({
    symbol: 'BTCUSDT', candle: candle(), indicators: sidewaysIndicators(),
    candlesCount: 50, bConfig: null, aiState: null, bState: null, neutralState: null,
    env: {}, marketData: { lastUpdateMs: NOW - 500, nowMs: NOW },
    accountData: { lastAccountSyncMs: NOW - 5000, expected: null, observed: null },
    config: {}, nowMs: NOW, paths,
  });
  assert.equal(r.ok, true);
  assert.equal(r.aiDecision.strategy, STRATEGY.NEUTRAL_GRID);
  assert.equal(r.aiDecision.direction, DIRECTION.NEUTRAL);
  assert.ok(r.neutralState, 'neutralState 생성');
  assert.equal(r.paperResult.kind, 'NEUTRAL_GRID');
});

test('N2: 하단 BUY_PENDING fill (levels[1]=94)', () => {
  const state = baseStateInit();
  const lv = state.levels[1]; // 94
  assert.equal(lv.state, 'BUY_PENDING');
  // candle.low <= lv.price 이면 fill
  const r = processNeutralGridCandle(state, candle({ low: lv.price - 1, high: 100, close: lv.price + 1, ts: NOW + 1 }));
  assert.equal(r.ok, true);
  const buys = r.fills.filter((f) => f.type === 'BUY');
  assert.ok(buys.length >= 1, 'BUY fill 존재');
  assert.equal(r.state.levels[1].state, 'HOLDING');
});

test('N2b: HOLDING 상단 exit + pnl (levels[1] 매수 → levels[2] 매도)', () => {
  const state = baseStateInit();
  const buyLv = state.levels[1]; // 94
  const sellLv = state.levels[2]; // 98
  const r1 = processNeutralGridCandle(state, candle({ low: buyLv.price - 1, high: 100, close: buyLv.price + 1, ts: NOW + 1 }));
  assert.equal(r1.state.levels[1].state, 'HOLDING');
  // candle.high >= sellLv.price 이면 매도
  const r2 = processNeutralGridCandle(r1.state, candle({ low: buyLv.price, high: sellLv.price + 1, close: sellLv.price, ts: NOW + 2 }));
  const sells = r2.fills.filter((f) => f.type === 'SELL');
  assert.ok(sells.length >= 1, 'SELL fill 존재');
  assert.ok(r2.state.realizedPnl > 0, '실현 손익 양수');
  assert.ok(r2.state.roundTrips >= 1);
});

test('N3: BREACH_HIGH 시 신규 진입 차단', () => {
  const state = baseStateInit();
  const r = processNeutralGridCandle(state, candle({ high: 115, low: 99, close: 112, ts: NOW + 1 }));
  assert.equal(r.boundaryState, 'BREACH_HIGH');
  assert.equal(r.allowNewEntry, false);
});

test('N3b: BREACH_LOW 시 신규 진입 차단', () => {
  const state = baseStateInit();
  const r = processNeutralGridCandle(state, candle({ high: 95, low: 85, close: 88, ts: NOW + 1 }));
  assert.equal(r.boundaryState, 'BREACH_LOW');
  assert.equal(r.allowNewEntry, false);
});

test('N4: NaN low → fail-closed', () => {
  const r = processNeutralGridCandle(baseStateInit(), candle({ low: NaN }));
  assert.equal(r.ok, false);
});
test('N4b: Infinity close → fail-closed', () => {
  const r = processNeutralGridCandle(baseStateInit(), candle({ close: Infinity }));
  assert.equal(r.ok, false);
});
test('N4c: high < low → fail-closed', () => {
  const r = processNeutralGridCandle(baseStateInit(), candle({ high: 90, low: 100 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CANDLE_HIGH_LT_LOW');
});
test('N4d: close outside range → fail-closed', () => {
  const r = processNeutralGridCandle(baseStateInit(), candle({ high: 100, low: 95, close: 110 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CANDLE_CLOSE_OUTSIDE');
});

test('N5: initialUsdt=0 → init 실패', () => {
  const r = createNeutralGridState({ symbol: 'BTCUSDT', lowerPrice: 90, upperPrice: 110, gridCount: 5, quantityPerGrid: 10, initialUsdt: 0, nowMs: NOW });
  assert.equal(r.ok, false);
});
test('N5b: gridCount=1 → init 실패', () => {
  const r = createNeutralGridState({ symbol: 'BTCUSDT', lowerPrice: 90, upperPrice: 110, gridCount: 1, quantityPerGrid: 10, initialUsdt: 1000, nowMs: NOW });
  assert.equal(r.ok, false);
});

test('N6: buy fee 반영', () => {
  const state = baseStateInit();
  const bal0 = state.usdtBalance;
  const buyLv = state.levels[1];
  const r = processNeutralGridCandle(state, candle({ low: buyLv.price - 1, high: 100, close: buyLv.price + 1, ts: NOW + 1 }));
  assert.ok(r.state.feesPaid > 0);
  assert.ok(r.state.usdtBalance < bal0);
});
test('N6b: sell 시 exitFee + realizedPnl', () => {
  const state = baseStateInit();
  const buyLv = state.levels[1];
  const sellLv = state.levels[2];
  const r1 = processNeutralGridCandle(state, candle({ low: buyLv.price - 1, high: 100, close: buyLv.price + 1, ts: NOW + 1 }));
  const p1 = r1.state.realizedPnl;
  const r2 = processNeutralGridCandle(r1.state, candle({ low: buyLv.price, high: sellLv.price + 1, close: sellLv.price, ts: NOW + 2 }));
  assert.ok(r2.state.realizedPnl > p1);
  assert.ok(r2.state.roundTrips >= 1);
});

test('N7: save → load 동일', () => {
  const dir = tmpDir();
  const sp = path.join(dir, 'state-neutral.json');
  const state = baseStateInit();
  const buyLv = state.levels[1];
  const r1 = processNeutralGridCandle(state, candle({ low: buyLv.price - 1, high: 100, close: buyLv.price + 1, ts: NOW + 1 }));
  assert.equal(saveNeutralState({ statePath: sp, state: r1.state }).saved, true);
  const l = loadNeutralStateSafe({ statePath: sp });
  assert.equal(l.ok, true);
  assert.equal(l.state.usdtBalance, r1.state.usdtBalance);
});
test('N7b: 손상 state → 격리', () => {
  const dir = tmpDir();
  const sp = path.join(dir, 'state-neutral.json');
  fs.writeFileSync(sp, 'NOT_JSON', 'utf8');
  const l = loadNeutralStateSafe({ statePath: sp });
  assert.equal(l.corrupt, true);
  assert.ok(l.quarantinePath);
  assert.equal(fs.existsSync(l.quarantinePath), true);
});

test('N8: 동일 ts 재입력 → DUPLICATE_TS', () => {
  const state = baseStateInit();
  const buyLv = state.levels[1];
  const c = candle({ low: buyLv.price - 1, high: 100, close: buyLv.price + 1, ts: NOW + 1 });
  const r1 = processNeutralGridCandle(state, c);
  const r2 = processNeutralGridCandle(r1.state, c);
  assert.equal(r2.skipped, 'DUPLICATE_TS');
  assert.equal(r2.fills.length, 0);
});
test('N8b: ts 역순 → skip', () => {
  const state = baseStateInit();
  const r1 = processNeutralGridCandle(state, candle({ ts: NOW + 10 }));
  const r2 = processNeutralGridCandle(r1.state, candle({ ts: NOW + 5 }));
  assert.equal(r2.skipped, 'DUPLICATE_TS');
});

test('N9: LONG 여전히 정상', () => {
  const dir = tmpDir();
  const paths = getRuntimePaths(path.join(dir, 'paper-ai'));
  const r = processAIPaperBar({
    symbol: 'BTCUSDT', candle: candle({ close: 101 }),
    indicators: { atr: 0.5, adx: 35, rsi: 60, macdHistogram: 0.5, bbWidth: 0.02, vwap: 98, currentPrice: 101 },
    candlesCount: 50, bConfig: null, aiState: null, bState: null, neutralState: null,
    env: {}, marketData: { lastUpdateMs: NOW - 500, nowMs: NOW },
    accountData: { lastAccountSyncMs: NOW - 5000, expected: null, observed: null },
    config: {}, nowMs: NOW, paths,
  });
  assert.equal(r.aiDecision.strategy, STRATEGY.LONG_TRAILING_GRID);
  assert.equal(r.neutralState, null);
});
test('N9b: SHORT 여전히 정상', () => {
  const dir = tmpDir();
  const paths = getRuntimePaths(path.join(dir, 'paper-ai'));
  const r = processAIPaperBar({
    symbol: 'BTCUSDT', candle: candle({ close: 99 }),
    indicators: { atr: 0.5, adx: 35, rsi: 35, macdHistogram: -0.5, bbWidth: 0.02, vwap: 102, currentPrice: 99 },
    candlesCount: 50, bConfig: null, aiState: null, bState: null, neutralState: null,
    env: {}, marketData: { lastUpdateMs: NOW - 500, nowMs: NOW },
    accountData: { lastAccountSyncMs: NOW - 5000, expected: null, observed: null },
    config: {}, nowMs: NOW, paths,
  });
  assert.equal(r.aiDecision.strategy, STRATEGY.SHORT_TRAILING_GRID);
});

test('N10: B Trailing NEUTRAL과 병렬', () => {
  const dir = tmpDir();
  const paths = getRuntimePaths(path.join(dir, 'paper-ai'));
  const r = processAIPaperBar({
    symbol: 'BTCUSDT', candle: candle(), indicators: sidewaysIndicators(),
    candlesCount: 50,
    bConfig: { gridCount: 20, investmentUsdt: 300, leverage: 2, rangePct: 0.15, pricePlace: 2, volumePlace: 4, minTradeNum: 0.0001 },
    aiState: null, bState: null, neutralState: null, env: {},
    marketData: { lastUpdateMs: NOW - 500, nowMs: NOW },
    accountData: { lastAccountSyncMs: NOW - 5000, expected: null, observed: null },
    config: {}, nowMs: NOW, paths,
  });
  assert.equal(r.bResult.ok, true);
  assert.ok(r.neutralState);
});

test('N11: NEUTRAL 실행 시에도 allowed=false', () => {
  const dir = tmpDir();
  const paths = getRuntimePaths(path.join(dir, 'paper-ai'));
  const r = processAIPaperBar({
    symbol: 'BTCUSDT', candle: candle(), indicators: sidewaysIndicators(),
    candlesCount: 50, bConfig: null, aiState: null, bState: null, neutralState: null,
    env: {}, marketData: { lastUpdateMs: NOW - 500, nowMs: NOW },
    accountData: { lastAccountSyncMs: NOW - 5000, expected: null, observed: null },
    config: {}, nowMs: NOW, paths,
  });
  assert.equal(r.gate.allowed, false);
  assert.equal(r.gate.wouldExecute, false);
  assert.equal(r.gate.realApiCalled, false);
});
test('N11b: neutral-grid-paper 정적 — 네트워크/주문 import 없음', () => {
  const p = '/opt/smart-grid-dev/packages/smart-grid-engine/src/neutral-grid-paper.mjs';
  const src = fs.readFileSync(p, 'utf8');
  assert.equal(/\bfetch\s*\(/.test(src), false);
  assert.equal(/import.*axios/.test(src), false);
  assert.equal(/from ['"]\.\/bitget-adapter/.test(src), false);
  assert.equal(/bitget-private/.test(src), false);
  assert.equal(/placeOrder|submitOrder|createOrder/.test(src), false);
});
test('N11c: paper-abc 참조 0', () => {
  const p = '/opt/smart-grid-dev/packages/smart-grid-engine/src/neutral-grid-paper.mjs';
  assert.equal(fs.readFileSync(p, 'utf8').includes('paper-abc'), false);
});

test('N12: gridPlan 누락 → reject', () => {
  const r = executeNeutralGridStep({ gridPlan: null, candle: candle(), symbol: 'X', nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'GRID_PLAN_MISSING');
});
test('N12b: direction 불일치 → reject', () => {
  const r = executeNeutralGridStep({
    gridPlan: { direction: DIRECTION.LONG, grid: { lowerPrice: 90, upperPrice: 110, gridCount: 5 }, capital: { deployUsdt: 100 }, ok: true, failClosed: false },
    candle: candle(), symbol: 'X', nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NOT_NEUTRAL');
});

test('N13: validateCandle 정상/무효', () => {
  assert.equal(validateCandle(candle()).ok, true);
  assert.equal(validateCandle({}).ok, false);
  assert.equal(validateCandle({ open: 1, high: 1, low: 1, close: 1, ts: NaN }).ok, false);
});
