import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMOTION_CRITERIA,
  ROUND_TRIP_COST,
  buildScorecard,
  emptyLedger,
  formatScorecardKo,
  openFromSnapshot,
  planEntry,
  settle,
  summarizeTrades,
  updateOpenPositions,
  walkPosition,
} from '../src/forward-ledger.mjs';

const T0 = Date.UTC(2026, 9, 15, 0, 0);
const H = 3_600_000;

function longPlan(overrides = {}) {
  return { price: 100, entryZone: { from: 98, to: 101 }, stopLoss: 95, targets: [110, 120], ...overrides };
}
function row(overrides = {}) {
  return {
    id: 'r1', state: 'CANDIDATE', market: 'CRYPTO_SPOT', symbol: 'BTC', direction: 'BUY', strategy: 'SWING', timeframe: '60m',
    provenance: { signalPlan: longPlan(), researchEvidence: { ruleId: 'rule-a' } }, ...overrides,
  };
}
function bar(hourIndex, o, h, l, c) { return { time: T0 + (hourIndex * H), open: o, high: h, low: l, close: c }; }

test('plan: stop and target must sit on the correct side and reward/risk is enforced outside the zone', () => {
  assert.equal(planEntry({ direction: 'BUY', plan: longPlan() }).ok, true);
  assert.equal(planEntry({ direction: 'BUY', plan: longPlan({ stopLoss: 101 }) }).reason, 'PRICE_AT_OR_BEYOND_STOP');
  assert.equal(planEntry({ direction: 'BUY', plan: longPlan({ targets: [99] }) }).reason, 'PRICE_AT_OR_BEYOND_TARGET');
  assert.equal(planEntry({ direction: 'BUY', plan: longPlan({ price: undefined }) }).reason, 'PLAN_INCOMPLETE');
  // above the zone with reward 4 vs risk 11 is refused; with reward 20 vs risk 5 it is allowed
  assert.equal(planEntry({ direction: 'BUY', plan: longPlan({ price: 106, targets: [110] }) }).reason, 'OUTSIDE_ZONE_LOW_REWARD_RISK');
  assert.equal(planEntry({ direction: 'BUY', plan: longPlan({ price: 106, stopLoss: 101, targets: [126] }) }).ok, true);
  const short = { price: 100, entryZone: { from: 99, to: 102 }, stopLoss: 105, targets: [90] };
  assert.equal(planEntry({ direction: 'SHORT', plan: short }).ok, true);
  assert.equal(planEntry({ direction: 'SHORT', plan: { ...short, stopLoss: 99 } }).reason, 'PRICE_AT_OR_BEYOND_STOP');
  assert.equal(planEntry({ direction: 'NEUTRAL', plan: short }).reason, 'DIRECTION_NOT_TRACKED');
});

test('opening: only CANDIDATE rows with a usable plan, once per identity, with a source label', () => {
  const snapshot = { lists: { spotBuy: [row(), row({ id: 'r2', state: 'ABSTAIN' }), row({ id: 'r3', provenance: { signalPlan: null } })] } };
  const first = openFromSnapshot({ ledger: emptyLedger(T0), snapshot, nowMs: T0 });
  assert.deepEqual(first.opened.map((p) => p.id), ['r1']);
  assert.equal(first.opened[0].source, 'RESEARCH:rule-a');
  assert.equal(first.opened[0].executionAuthority, 'NONE');
  assert.equal(first.ledger.skipped.r3.reason, 'PLAN_INCOMPLETE');
  const again = openFromSnapshot({ ledger: first.ledger, snapshot, nowMs: T0 + H });
  assert.equal(again.opened.length, 0, 'an open identity is never opened twice');
});

test('walk: target, stop, gap through stop, both in one bar (stop wins) and time exit', () => {
  const pos = openFromSnapshot({ ledger: emptyLedger(T0), snapshot: { lists: { x: [row()] } }, nowMs: T0 }).opened[0];
  const hit = walkPosition(pos, [bar(1, 100, 111, 99, 110)], T0 + (3 * H));
  assert.deepEqual([hit.closed, hit.reason, hit.exit], [true, 'TARGET', 110]);
  const stop = walkPosition(pos, [bar(1, 100, 101, 94, 96)], T0 + (3 * H));
  assert.deepEqual([stop.reason, stop.exit], ['STOP', 95]);
  const gap = walkPosition(pos, [bar(1, 92, 99, 90, 98)], T0 + (3 * H));
  assert.deepEqual([gap.reason, gap.exit], ['STOP_GAP', 92]);
  const both = walkPosition(pos, [bar(1, 100, 112, 94, 100)], T0 + (3 * H));
  assert.equal(both.reason, 'STOP', 'pessimistic: the stop counts when both are touched');
  const quiet = walkPosition(pos, [bar(1, 100, 103, 99, 101)], T0 + (3 * H));
  assert.deepEqual([quiet.closed, quiet.lastPrice], [false, 101]);
  const expired = walkPosition(pos, [bar(47, 100, 103, 99, 101), bar(48, 101, 104, 100, 102)], T0 + (49 * H));
  assert.deepEqual([expired.closed, expired.reason], [true, 'TIME']);
});

test('walk: candles from before the entry do not trigger exits; the running entry candle only uses its latest price', () => {
  const pos = openFromSnapshot({ ledger: emptyLedger(T0 + (30 * 60_000)), snapshot: { lists: { x: [row()] } }, nowMs: T0 + (30 * 60_000) }).opened[0];
  const before = walkPosition(pos, [bar(-3, 100, 130, 80, 100)], T0 + H);
  assert.equal(before.closed, false);
  // The candle running at entry (00:00-01:00) had a low of 90 before the entry; only its close counts.
  const running = walkPosition(pos, [bar(0, 100, 120, 90, 101)], T0 + (45 * 60_000));
  assert.deepEqual([running.closed, running.lastPrice], [false, 101]);
});

test('settle: costs are charged, shorts mirror, futures pay funding for the time held', () => {
  const longPos = openFromSnapshot({ ledger: emptyLedger(T0), snapshot: { lists: { x: [row()] } }, nowMs: T0 }).opened[0];
  const win = settle(longPos, { exit: 110, exitTimeMs: T0 + H, reason: 'TARGET' });
  assert.ok(Math.abs(win.grossReturn - 0.1) < 1e-12);
  assert.ok(Math.abs(win.netReturn - (0.1 - ROUND_TRIP_COST.CRYPTO_SPOT)) < 1e-12);
  assert.ok(Math.abs(win.rMultiple - (win.netReturn / 0.05)) < 1e-12);
  const shortPos = openFromSnapshot({
    ledger: emptyLedger(T0),
    snapshot: { lists: { x: [row({ id: 's', market: 'CRYPTO_FUTURES', direction: 'SHORT', provenance: { signalPlan: { price: 100, entryZone: { from: 99, to: 102 }, stopLoss: 105, targets: [90] } } })] } },
    nowMs: T0,
  }).opened[0];
  const shortWin = settle(shortPos, { exit: 90, exitTimeMs: T0 + (16 * H), reason: 'TARGET' });
  assert.ok(Math.abs(shortWin.grossReturn - 0.1) < 1e-12, 'a falling price is a gain for a short');
  assert.ok(Math.abs(shortWin.cost - (ROUND_TRIP_COST.CRYPTO_FUTURES + (0.0001 * 2))) < 1e-12, '16h held = two funding periods');
});

test('update: closes finished positions, keeps failed fetches open, sets a cooldown and force-closes lost data', async () => {
  const opened = openFromSnapshot({
    ledger: emptyLedger(T0),
    snapshot: { lists: { x: [row(), row({ id: 'r2', symbol: 'ETH' }), row({ id: 'r3', symbol: 'XRP' })] } },
    nowMs: T0,
  }).ledger;
  const fetchCandles = async (p) => {
    if (p.id === 'r1') return [bar(1, 100, 111, 99, 110)];
    if (p.id === 'r2') throw new Error('UPBIT_HTTP_500');
    return [bar(1, 100, 103, 99, 101)];
  };
  const now = T0 + (3 * H);
  const result = await updateOpenPositions({ ledger: opened, nowMs: now, fetchCandles });
  assert.deepEqual(result.closedNow.map((t) => [t.id, t.reason]), [['r1', 'TARGET']]);
  assert.deepEqual(Object.keys(result.ledger.positions).sort(), ['r2', 'r3']);
  assert.equal(result.errors[0].id, 'r2');
  assert.ok(result.ledger.cooldowns.r1 > now, 'the closed identity cannot reopen immediately');
  const reopened = openFromSnapshot({ ledger: result.ledger, snapshot: { lists: { x: [row()] } }, nowMs: now + H });
  assert.equal(reopened.opened.length, 0);
  const lost = await updateOpenPositions({ ledger: result.ledger, nowMs: T0 + (200 * H), fetchCandles: async () => { throw new Error('GONE'); } });
  assert.ok(lost.closedNow.every((t) => t.reason === 'DATA_LOST'));
  assert.equal(Object.keys(lost.ledger.positions).length, 0);
});

function trade(symbol, net, extra = {}) {
  return { id: `${symbol}-${net}-${Math.random()}`, market: 'KR_STOCK', symbol, direction: 'BUY', source: 'RESEARCH:a', reason: 'TARGET', netReturn: net, rMultiple: net / 0.05, ...extra };
}

test('scorecard: promotion needs enough trades, a positive 95% lower bound and positive breadth over symbols', () => {
  const symbols = ['A', 'B', 'C', 'D'];
  const winners = Array.from({ length: 40 }, (_, i) => trade(symbols[i % 4], i % 5 === 0 ? -0.01 : 0.02));
  const ready = summarizeTrades(winners);
  assert.equal(ready.promotionReady, true, JSON.stringify(ready.checks));
  assert.ok(ready.confidenceLow > 0);
  const few = summarizeTrades(winners.slice(0, 10));
  assert.equal(few.checks.enoughTrades, false);
  assert.equal(few.promotionReady, false);
  const noisy = summarizeTrades(Array.from({ length: 40 }, (_, i) => trade(symbols[i % 4], i % 2 === 0 ? 0.03 : -0.029)));
  assert.equal(noisy.checks.confidenceAboveZero, false, 'a tiny edge inside the noise is not enough');
  const oneSymbol = summarizeTrades(Array.from({ length: 40 }, () => trade('A', 0.02)));
  assert.equal(oneSymbol.checks.enoughSymbols, false);
  assert.equal(PROMOTION_CRITERIA.minimumTrades, 30);
});

test('scorecard builds per market/source groups and a Korean summary without orders', () => {
  const ledger = { ...emptyLedger(T0), closed: Array.from({ length: 35 }, (_, i) => trade(['A', 'B', 'C'][i % 3], i % 4 === 0 ? -0.01 : 0.02)) };
  const card = buildScorecard(ledger, T0);
  assert.equal(card.executionAuthority, 'NONE');
  assert.ok(card.bySource['KR_STOCK|BUY|RESEARCH:a']);
  const text = formatScorecardKo(card);
  assert.match(text, /신호 모의매매 성적표/);
  assert.match(text, /실주문 없음/);
  assert.match(text, /35건/);
  assert.match(formatScorecardKo(buildScorecard(emptyLedger(T0), T0)), /아직 종료된 가상 거래가 없습니다/);
});
