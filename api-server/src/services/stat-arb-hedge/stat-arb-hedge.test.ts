import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_AUTHORITY_RELEASED, StatArbHedgeAdapter } from './stat-arb-hedge-adapter';
import { evaluateHedgeCapability, HEDGE_VENUE_CAPABILITIES } from './stat-arb-hedge-capabilities';
import { evaluatePerformanceGate, hedgeClientOrderId, hedgeLegIdempotencyKey, validateHedgeSignalShape } from './stat-arb-hedge-validation';
import { FX, PERP_PX, QTY, SHA, SPOT_PX, USER, makeHarness, makeSignal, passingEvidence } from './stat-arb-hedge-test-fixtures';
import { VirtualClock } from './stat-arb-hedge-mock';
import type { HedgeSignal } from './stat-arb-hedge.types';

/* ------------------------------ schema ---------------------------------- */

test('hedge signal schema rejects missing or malformed fields', () => {
  const clock = new VirtualClock();
  assert.deepEqual(validateHedgeSignalShape(makeSignal(clock)), []);
  const codes = validateHedgeSignalShape({ ...makeSignal(clock), schema: 'x', researchCodeSha: 'short', signalId: '', legs: [], fx: {}, leverage: 2.5 });
  for (const expected of ['SIGNAL_SCHEMA_MISMATCH', 'SIGNAL_RESEARCH_SHA_INVALID', 'SIGNAL_SIGNALID_MISSING', 'SIGNAL_LEGS_COUNT_INVALID', 'FX_RATE_INVALID', 'SIGNAL_LEVERAGE_INVALID']) {
    assert.ok(codes.includes(expected), expected);
  }
  const dup = validateHedgeSignalShape(makeSignal(clock, {}, { perp: { role: 'SPOT', legId: 'spot' } }));
  assert.ok(dup.includes('LEG_ID_DUPLICATE:spot'));
  assert.ok(dup.includes('LEG_ROLE_DUPLICATE:SPOT'));
  assert.ok(validateHedgeSignalShape(makeSignal(clock, { action: 'EXIT' })).includes('SIGNAL_EXIT_PAIR_ID_MISSING'));
});

test('idempotency keys are stable per leg and distinct across legs, signals and actions', () => {
  const clock = new VirtualClock();
  const signal = makeSignal(clock);
  const a = hedgeLegIdempotencyKey(USER, signal, 'spot');
  assert.equal(a, hedgeLegIdempotencyKey(USER, signal, 'spot'));
  assert.notEqual(a, hedgeLegIdempotencyKey(USER, signal, 'perp'));
  assert.notEqual(a, hedgeLegIdempotencyKey(USER, { ...signal, signalId: 'sig-2' }, 'spot'));
  assert.notEqual(a, hedgeLegIdempotencyKey(USER, { ...signal, action: 'EXIT' }, 'spot'));
  assert.match(hedgeClientOrderId('bitget', a), /^sah-bitget-[0-9a-f]{20}$/u);
  assert.ok(hedgeClientOrderId('upbit', a).length <= 40);
});

/* --------------------------- capability matrix -------------------------- */

test('only upbit spot long + bitget usdt perp short is supported; everything else is blocked', () => {
  const clock = new VirtualClock();
  assert.equal(evaluateHedgeCapability(makeSignal(clock)).supported, true);
  const binance = evaluateHedgeCapability(makeSignal(clock, {}, { spot: { venue: 'binance' } }));
  assert.equal(binance.supported, false);
  assert.ok(binance.blockCodes.includes('VENUE_ADAPTER_MISSING:binance'));
  assert.ok(binance.blockCodes.includes('UNSUPPORTED_HEDGE_COMBINATION'));
  const hyperliquid = evaluateHedgeCapability(makeSignal(clock, {}, { perp: { venue: 'hyperliquid' } }));
  assert.ok(hyperliquid.blockCodes.includes('VENUE_ADAPTER_MISSING:hyperliquid'));
  const bitgetSpot = evaluateHedgeCapability(makeSignal(clock, {}, { spot: { venue: 'bitget', quoteCurrency: 'USDT' } }));
  assert.ok(bitgetSpot.blockCodes.includes('VENUE_PRODUCT_UNSUPPORTED:bitget:spot'));
  const reversed = evaluateHedgeCapability(makeSignal(clock, {}, { spot: { side: 'sell' }, perp: { side: 'long' } }));
  assert.ok(reversed.blockCodes.includes('SPOT_SIDE_UNSUPPORTED:sell'));
  assert.ok(reversed.blockCodes.includes('PERP_SIDE_UNSUPPORTED:long'));
  assert.ok(evaluateHedgeCapability(makeSignal(clock, { leverage: 1 })).blockCodes.includes('PERP_LEVERAGE_OUTSIDE_LIVE_RANGE'));
  assert.ok(evaluateHedgeCapability(makeSignal(clock, { leverage: 8 })).blockCodes.includes('PERP_LEVERAGE_OUTSIDE_LIVE_RANGE'));
  assert.equal(HEDGE_VENUE_CAPABILITIES.upbit.canShort, false);
  assert.equal(HEDGE_VENUE_CAPABILITIES.binance.adapterPresent, false);
});

/* --------------------------- performance gate --------------------------- */

test('performance gate passes only on OK rows with positive net return, pf>1, no liquidations, >=180d, >=30 trades', () => {
  const signal = { strategyId: 'carry', researchCodeSha: SHA, leverage: 3 };
  assert.equal(evaluatePerformanceGate(passingEvidence(), signal).authority, 'LIVE_ELIGIBLE');
  assert.deepEqual(evaluatePerformanceGate(null, signal).reasons, ['PERFORMANCE_EVIDENCE_MISSING']);
  assert.ok(evaluatePerformanceGate({ ...passingEvidence(), researchCodeSha: 'a'.repeat(40) }, signal).reasons.includes('PERFORMANCE_EVIDENCE_SHA_MISMATCH'));
  assert.ok(evaluatePerformanceGate(passingEvidence({ net_return: -0.0056 }), signal).reasons[0].startsWith('PERFORMANCE_NET_RETURN_NOT_POSITIVE'));
  assert.ok(evaluatePerformanceGate(passingEvidence({ trades: 3 }), signal).reasons[0].startsWith('PERFORMANCE_TRADES_TOO_FEW'));
  assert.ok(evaluatePerformanceGate(passingEvidence({ status: 'INCOMPLETE', data_verdict: 'INCOMPLETE_DATA' }), signal).reasons.some((r) => r.startsWith('PERFORMANCE_DATA_VERDICT_NOT_OK')));
  assert.ok(evaluatePerformanceGate(passingEvidence({ window_end_exclusive: '2023-08-23' }), signal).reasons[0].startsWith('PERFORMANCE_WINDOW_TOO_SHORT'));
  assert.ok(evaluatePerformanceGate(passingEvidence({ liquidations: 8 }), signal).reasons.some((r) => r.startsWith('PERFORMANCE_LIQUIDATIONS')));
  assert.ok(evaluatePerformanceGate(passingEvidence({ pf_net: 0.9 }), signal).reasons.some((r) => r.startsWith('PERFORMANCE_PROFIT_FACTOR_LOW')));
  assert.ok(evaluatePerformanceGate(passingEvidence({ leverage: 10 }), signal).reasons.includes('PERFORMANCE_EVIDENCE_NO_MATCHING_ROW'));
  assert.ok(evaluatePerformanceGate(passingEvidence({ cost_profile: 'zero_cost' }), signal).reasons.includes('PERFORMANCE_EVIDENCE_NO_MATCHING_ROW'));
  // One failing row among passing rows still fails (fail-closed).
  const mixed = { ...passingEvidence(), rows: [...passingEvidence().rows, ...passingEvidence({ window: 'recent', net_return: -0.01 }).rows] };
  assert.equal(evaluatePerformanceGate(mixed, signal).authority, 'NONE');
});

/* ------------------------- authority and gating ------------------------- */

test('default authority NONE places nothing; LIVE is not released and refuses mock ports', async () => {
  assert.equal(LIVE_AUTHORITY_RELEASED, false);
  const none = makeHarness({ executionAuthority: 'NONE' });
  const r1 = await none.adapter.enter(makeSignal(none.clock), passingEvidence());
  assert.equal(r1.accepted, false);
  assert.ok(r1.blockCodes.includes('EXECUTION_AUTHORITY_NONE'));
  assert.equal(none.upbit.placed.length + none.bitget.placed.length, 0);
  const live = makeHarness({ executionAuthority: 'LIVE' });
  const r2 = await live.adapter.enter(makeSignal(live.clock), passingEvidence());
  assert.ok(r2.blockCodes.includes('LIVE_AUTHORITY_NOT_RELEASED'));
  assert.ok(r2.blockCodes.includes('LIVE_AUTHORITY_REFUSES_MOCK_PORT:upbit'));
  assert.equal(live.upbit.placed.length + live.bitget.placed.length, 0);
});

test('a strategy that failed performance validation never reaches the venues', async () => {
  const h = makeHarness();
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence({ net_return: -0.0039, trades: 44 }));
  assert.equal(r.accepted, false);
  assert.ok(r.blockCodes.includes('PERFORMANCE_GATE_FAILED'));
  assert.equal(h.upbit.placed.length + h.bitget.placed.length, 0);
});

test('stale data, expired signal, stale fx, future data are rejected before any port call', async () => {
  const h = makeHarness();
  const now = h.clock.nowMs();
  const stale = await h.adapter.enter(makeSignal(h.clock, { dataAsOfMs: now - 61_000, signalAtMs: now - 60_000 }), passingEvidence());
  assert.ok(stale.blockCodes.includes('SIGNAL_DATA_STALE'));
  const expired = await h.adapter.enter(makeSignal(h.clock, { expiresAtMs: now - 1 }), passingEvidence());
  assert.ok(expired.blockCodes.includes('SIGNAL_EXPIRED'));
  const fx = await h.adapter.enter(makeSignal(h.clock, { fx: { krwPerUsdt: FX, asOfMs: now - 61_000, source: 't' } }), passingEvidence());
  assert.ok(fx.blockCodes.includes('FX_QUOTE_STALE'));
  const future = await h.adapter.enter(makeSignal(h.clock, { dataAsOfMs: now + 60_000, signalAtMs: now + 60_000 }), passingEvidence());
  assert.ok(future.blockCodes.includes('SIGNAL_DATA_FROM_FUTURE'));
  assert.equal(h.upbit.placed.length + h.bitget.placed.length, 0);
});

test('emergency stop, new-entries stop, missing order/cancel permission and leverage policy mismatch block entries', async () => {
  const h = makeHarness();
  h.control.snapshot = { ...h.control.snapshot, emergencyStopped: true, newEntriesStopped: true, canCancelOrders: { ...h.control.snapshot.canCancelOrders, bitget: false }, canPlaceOrders: { ...h.control.snapshot.canPlaceOrders, upbit: false }, policyBitgetLeverage: 2 };
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  for (const code of ['EMERGENCY_STOPPED', 'NEW_ENTRIES_STOPPED', 'CANCEL_PERMISSION_MISSING:bitget', 'ORDER_PERMISSION_MISSING:upbit', 'LEVERAGE_POLICY_MISMATCH']) assert.ok(r.blockCodes.includes(code), code);
  assert.equal(h.upbit.placed.length + h.bitget.placed.length, 0);
});

test('existing strategy positions or open orders on the same venue+symbol block the hedge', async () => {
  const h = makeHarness();
  h.conflicts.byKey.set('bitget:BTCUSDT', { foreignPositionSide: 'long', foreignOpenOrders: 0, foreignStrategyIds: ['pump_reversal'] });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.ok(r.blockCodes.includes('STRATEGY_ORDER_CONFLICT:bitget:BTCUSDT:pump_reversal'));
  assert.equal(h.bitget.placed.length, 0);
});

test('ledger drift, insufficient balance, position mismatch and allowed-entry limits fail closed', async () => {
  const drift = makeHarness();
  drift.upbit.available.KRW = 100_000; // ledger says 3,000,000 available → shortfall > tolerance
  const r1 = await drift.adapter.enter(makeSignal(drift.clock), passingEvidence());
  assert.ok(r1.blockCodes.includes('MARKET_LEDGER_EXCHANGE_DRIFT_UNRESOLVED:crypto_spot'));
  assert.ok(r1.blockCodes.includes('ENTRY_EXCEEDS_ALLOWED:crypto_spot:EXCHANGE_AVAILABLE'));
  assert.ok(r1.blockCodes.includes('INSUFFICIENT_BALANCE:upbit'));
  const mismatch = makeHarness();
  mismatch.bitget.position = { quantity: 0.002, side: 'short', averagePrice: PERP_PX, unrealizedPnl: 0 };
  const r2 = await mismatch.adapter.enter(makeSignal(mismatch.clock), passingEvidence());
  assert.ok(r2.blockCodes.includes('POSITION_MISMATCH:bitget'));
  const opposite = makeHarness();
  opposite.bitget.position = { quantity: 0.002, side: 'long', averagePrice: PERP_PX, unrealizedPnl: 0 };
  const r3 = await opposite.adapter.enter(makeSignal(opposite.clock), passingEvidence());
  assert.ok(r3.blockCodes.includes('OPPOSITE_POSITION_OPEN:bitget'));
  const cap = makeHarness();
  cap.control.snapshot = { ...cap.control.snapshot, policyMaxOrderKrw: 100_000 };
  const r4 = await cap.adapter.enter(makeSignal(cap.clock), passingEvidence());
  assert.ok(r4.blockCodes.includes('ENTRY_EXCEEDS_ALLOWED:crypto_spot:POLICY_MAX_ORDER'));
  const tiny = makeHarness();
  const r5 = await tiny.adapter.enter(makeSignal(tiny.clock, {}, { spot: { quantity: 0.00002 }, perp: { quantity: 0.00002 } }), passingEvidence());
  assert.ok(r5.blockCodes.includes('SPOT_NOTIONAL_BELOW_UPBIT_MINIMUM'));
  assert.ok(r5.blockCodes.includes('QUANTITY_BELOW_MINIMUM:perp'));
  for (const h of [drift, mismatch, opposite, cap, tiny]) assert.equal(h.upbit.placed.length + h.bitget.placed.length, 0);
});

/* ------------------------------ order flow ------------------------------ */

test('both legs fill: pair HEDGED, simulated flag set, fills/fees/slippage/timestamps recorded', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'fill', price: SPOT_PX * 1.0005, fee: 207 });
  h.bitget.queue({ kind: 'fill', price: PERP_PX * 0.9996, fee: 0.18 });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.accepted, true, r.blockCodes.join(','));
  assert.equal(r.simulated, true);
  const pair = r.pair!;
  assert.equal(pair.phase, 'HEDGED');
  assert.equal(pair.simulated, true);
  assert.equal(pair.legs.SPOT.filledQuantity, QTY);
  assert.equal(pair.legs.PERP.filledQuantity, QTY);
  assert.equal(pair.exposure.balanced, true);
  assert.equal(pair.legs.SPOT.feePaid, 207);
  assert.equal(pair.legs.PERP.feeCurrency, 'USDT');
  assert.ok(Math.abs(pair.legs.SPOT.slippageBps! - 5) < 1e-6);
  assert.ok(Math.abs(pair.legs.PERP.slippageBps! - 4) < 1e-6);
  assert.ok(pair.legs.SPOT.firstFillAtMs! <= pair.legs.PERP.submittedAtMs!);
  assert.equal(pair.fundingStatus, 'NOT_AVAILABLE_LIVE');
  assert.equal(h.upbit.placed[0].clientOrderId.startsWith('sah-upbit-'), true);
  assert.equal(h.bitget.placed[0].side, 'short');
  assert.equal(h.bitget.placed[0].marginMode, 'isolated');
  assert.equal(h.bitget.placed[0].leverage, 3);
  assert.equal(h.bitget.position.side, 'short');
});

test('duplicate signal is idempotent: no second order, and a replayed clientOrderId is rejected by the venue', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'fill', price: SPOT_PX });
  h.bitget.queue({ kind: 'fill', price: PERP_PX });
  const first = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(first.accepted, true);
  const again = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(again.accepted, false);
  assert.deepEqual([...again.blockCodes], ['DUPLICATE_SIGNAL']);
  assert.equal(again.pair!.pairId, first.pair!.pairId);
  assert.equal(h.upbit.placed.length, 1);
  assert.equal(h.bitget.placed.length, 1);
  await assert.rejects(h.upbit.placeOrder(h.upbit.placed[0]), /DUPLICATE_CLIENT_ORDER_ID/u);
});

test('spot leg rejected: pair REJECTED, perp never submitted', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'reject', reason: 'INSUFFICIENT_FUNDS' });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.accepted, false);
  assert.deepEqual([...r.blockCodes], ['LEG1_REJECTED']);
  assert.equal(r.pair!.phase, 'REJECTED');
  assert.equal(r.pair!.legs.SPOT.rejectReason, 'INSUFFICIENT_FUNDS');
  assert.equal(h.bitget.placed.length, 0);
});

test('perp leg rejected after spot filled: spot is unwound, pair UNWOUND, no naked exposure left', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'fill', price: SPOT_PX, fee: 100 }, { kind: 'fill', price: SPOT_PX * 0.999, fee: 100 });
  h.bitget.queue({ kind: 'reject', reason: 'LEVERAGE_NOT_SET' });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.accepted, false);
  assert.deepEqual([...r.blockCodes], ['LEG2_REJECTED']);
  assert.equal(r.pair!.phase, 'UNWOUND');
  assert.equal(h.upbit.placed.length, 2);
  assert.equal(h.upbit.placed[1].side, 'sell');
  assert.equal(h.upbit.placed[1].quantity, QTY);
  assert.ok(r.pair!.realizedPnlKrw! < 0);
  assert.equal((await h.store.listOpen(USER)).length, 0);
});

test('partial spot fill then timeout: remainder cancelled, perp sized to the fill, imbalance flagged and blocks the next entry', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'partial', price: SPOT_PX, fraction: 0.5 }); // 0.0015 BTC
  h.bitget.queue({ kind: 'fill', price: PERP_PX });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.accepted, false);
  assert.deepEqual([...r.blockCodes], ['HEDGE_UNBALANCED']);
  const pair = r.pair!;
  assert.equal(pair.legs.SPOT.status, 'TIMEOUT');
  assert.equal(pair.legs.SPOT.filledQuantity, 0.0015);
  assert.equal(pair.legs.PERP.targetQuantity, 0.001); // rounded DOWN to the 0.001 contract step
  assert.equal(pair.legs.PERP.filledQuantity, 0.001);
  assert.equal(pair.phase, 'UNBALANCED');
  assert.ok(Math.abs(pair.exposure.imbalanceQuantity - 0.0005) < 1e-12);
  assert.ok(h.alerts.sent.some((a) => a.title.includes('unbalanced')));
  const next = await h.adapter.enter(makeSignal(h.clock, { signalId: 'sig-2' }), passingEvidence());
  assert.ok(next.blockCodes.some((c) => c.startsWith(`HEDGE_IMBALANCE_OPEN:${pair.pairId}:UNBALANCED`)));
  assert.equal(h.upbit.placed.length, 1);
});

test('order still open: adapter polls until the venue fills it', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'open_then_fill', price: SPOT_PX, afterQueries: 2 });
  h.bitget.queue({ kind: 'open_then_fill', price: PERP_PX, afterQueries: 1 });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.accepted, true, r.blockCodes.join(','));
  assert.equal(r.pair!.phase, 'HEDGED');
});

test('perp timeout with no order found: pair UNKNOWN, halted, alert sent, spot NOT unwound, next entry blocked', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'fill', price: SPOT_PX });
  h.bitget.queue({ kind: 'timeout_not_placed' });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.deepEqual([...r.blockCodes], ['ORDER_STATE_UNKNOWN']);
  assert.equal(r.pair!.phase, 'UNKNOWN');
  assert.equal(r.pair!.haltReason, 'ORDER_STATE_UNKNOWN');
  assert.equal(h.upbit.placed.length, 1);
  assert.ok(h.alerts.sent.some((a) => a.type === 'system_critical'));
  const next = await h.adapter.enter(makeSignal(h.clock, { signalId: 'sig-2' }), passingEvidence());
  assert.ok(next.blockCodes.some((c) => c.startsWith('HEDGE_IMBALANCE_OPEN')));
});

test('timeout or disconnect after the venue accepted the order is reconciled by query, not assumed', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'timeout_but_filled', price: SPOT_PX });
  h.bitget.queue({ kind: 'disconnect_then_filled', price: PERP_PX });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.accepted, true, r.blockCodes.join(','));
  assert.equal(r.pair!.phase, 'HEDGED');
  assert.equal(r.pair!.legs.SPOT.filledQuantity, QTY);
});

/* --------------------------------- exit --------------------------------- */

async function openHedged(h: ReturnType<typeof makeHarness>) {
  h.upbit.queue({ kind: 'fill', price: SPOT_PX, fee: 100 });
  h.bitget.queue({ kind: 'fill', price: PERP_PX, fee: 0.2 });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.accepted, true, r.blockCodes.join(','));
  return r.pair!;
}

function exitSignal(h: ReturnType<typeof makeHarness>, pairId: string, overrides: Partial<HedgeSignal> = {}): HedgeSignal {
  return makeSignal(h.clock, { action: 'EXIT', pairId, signalId: 'sig-exit-1', ...overrides });
}

test('exit closes perp first then spot, records realized PnL, funding unavailable is reported not assumed', async () => {
  const h = makeHarness();
  const pair = await openHedged(h);
  h.clock.advance(3_600_000);
  h.bitget.queue({ kind: 'fill', price: PERP_PX * 0.98, fee: 0.2 }); // short gains 2%
  h.upbit.queue({ kind: 'fill', price: SPOT_PX * 0.985, fee: 100 }); // spot loses 1.5%
  const r = await h.adapter.exit(exitSignal(h, pair.pairId));
  assert.equal(r.accepted, true, r.blockCodes.join(','));
  assert.equal(r.pair!.phase, 'CLOSED');
  assert.equal(h.bitget.placed[1].reduceOnly, true);
  assert.equal(h.bitget.placed[1].side, 'long');
  assert.ok(h.bitget.placed[1].clientOrderId !== h.bitget.placed[0].clientOrderId);
  assert.equal(h.bitget.position.quantity, 0);
  const spotPnl = (SPOT_PX * 0.985 - SPOT_PX) * QTY - 200;
  const perpPnl = (PERP_PX - PERP_PX * 0.98) * QTY - 0.4;
  assert.ok(Math.abs(r.pair!.realizedPnlKrw! - (spotPnl + perpPnl * FX)) < 1e-6);
  assert.equal(r.pair!.fundingStatus, 'NOT_AVAILABLE_LIVE');
  assert.equal(r.pair!.fundingPaidUsdt, null);
  assert.equal((await h.store.listOpen(USER)).length, 0);
  const again = await h.adapter.exit(exitSignal(h, pair.pairId));
  assert.deepEqual([...again.blockCodes], ['DUPLICATE_SIGNAL']);
});

test('funding is only recorded when the venue reports it', async () => {
  const h = makeHarness();
  const pair = await openHedged(h);
  h.bitget.fundingPaidUsdt = 0.35;
  h.bitget.queue({ kind: 'fill', price: PERP_PX });
  h.upbit.queue({ kind: 'fill', price: SPOT_PX });
  const r = await h.adapter.exit(exitSignal(h, pair.pairId));
  assert.equal(r.pair!.fundingStatus, 'REPORTED');
  assert.equal(r.pair!.fundingPaidUsdt, 0.35);
  assert.ok(Math.abs(r.pair!.realizedPnlKrw! - (-100 + (-0.2 + 0.35) * FX)) < 1e-6); // entry fees only; exit fills carried no fee
});

test('exit perp leg fails: hedge is kept, spot not sold, alert sent; exit still allowed under emergency stop', async () => {
  const h = makeHarness();
  const pair = await openHedged(h);
  h.control.snapshot = { ...h.control.snapshot, emergencyStopped: true, newEntriesStopped: true };
  h.bitget.queue({ kind: 'reject', reason: 'REDUCE_ONLY_REJECTED' });
  const r = await h.adapter.exit(exitSignal(h, pair.pairId));
  assert.deepEqual([...r.blockCodes], ['EXIT_PERP_REJECTED']);
  assert.equal(r.pair!.phase, 'HEDGED');
  assert.equal(h.upbit.placed.length, 1);
  assert.ok(h.alerts.sent.some((a) => a.title.includes('exit perp leg failed')));
  h.bitget.queue({ kind: 'fill', price: PERP_PX });
  h.upbit.queue({ kind: 'fill', price: SPOT_PX });
  const retry = await h.adapter.exit(exitSignal(h, pair.pairId, { signalId: 'sig-exit-2' }));
  assert.equal(retry.accepted, true, retry.blockCodes.join(','));
  assert.equal(retry.pair!.phase, 'CLOSED');
});

test('exit spot leg fails after perp closed: pair UNBALANCED (naked spot) and alert sent', async () => {
  const h = makeHarness();
  const pair = await openHedged(h);
  h.bitget.queue({ kind: 'fill', price: PERP_PX });
  h.upbit.queue({ kind: 'reject', reason: 'MARKET_CLOSED' });
  const r = await h.adapter.exit(exitSignal(h, pair.pairId));
  assert.deepEqual([...r.blockCodes], ['EXIT_SPOT_REJECTED']);
  assert.equal(r.pair!.phase, 'UNBALANCED');
  assert.ok(h.alerts.sent.some((a) => a.title.includes('naked spot')));
});

test('exit on an unknown or already-closed pair and an EXIT with mismatched symbols are rejected', async () => {
  const h = makeHarness();
  const r1 = await h.adapter.exit(exitSignal(h, 'nope'));
  assert.deepEqual([...r1.blockCodes], ['PAIR_NOT_FOUND']);
  const pair = await openHedged(h);
  const r2 = await h.adapter.exit(makeSignal(h.clock, { action: 'EXIT', pairId: pair.pairId, signalId: 'x' }, { spot: { symbol: 'KRW-ETH' } }));
  assert.deepEqual([...r2.blockCodes], ['EXIT_SYMBOL_MISMATCH']);
});

/* ------------------------------- recovery ------------------------------- */

test('restart recovery: perp leg lost mid-flight, venue filled it offline, a fresh adapter reconciles to HEDGED', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'fill', price: SPOT_PX });
  h.bitget.queue({ kind: 'disconnect_unknown' });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.pair!.phase, 'UNKNOWN');
  const pairId = r.pair!.pairId;
  // "Restart": new adapter instance over the same store and venues.
  const fresh = new StatArbHedgeAdapter({ userId: USER, executionAuthority: 'MOCK' },
    { exchanges: { upbit: h.upbit, bitget: h.bitget }, store: h.store, control: h.control, ledger: h.ledger, conflicts: h.conflicts, alerts: h.alerts, clock: h.clock });
  const stillUnknown = await fresh.recover(pairId);
  assert.equal(stillUnknown!.phase, 'UNKNOWN'); // venue still unreachable → stays halted
  h.bitget.settleOffline(h.bitget.placed[0].clientOrderId, PERP_PX);
  const recovered = await fresh.recover(pairId);
  assert.equal(recovered!.phase, 'HEDGED');
  assert.equal(recovered!.haltReason, null);
  assert.equal(recovered!.legs.PERP.filledQuantity, QTY);
  assert.equal(h.bitget.placed.length, 1); // recovery places no orders
  const next = await fresh.enter(makeSignal(h.clock, { signalId: 'sig-2' }), passingEvidence());
  assert.ok(!next.blockCodes.some((c) => c.startsWith('HEDGE_IMBALANCE_OPEN')), next.blockCodes.join(','));
});

test('restart recovery: a perp order that never reached the venue leaves naked spot → UNBALANCED, entries blocked', async () => {
  const h = makeHarness();
  h.upbit.queue({ kind: 'fill', price: SPOT_PX });
  h.bitget.queue({ kind: 'timeout_not_placed' });
  const r = await h.adapter.enter(makeSignal(h.clock), passingEvidence());
  assert.equal(r.pair!.phase, 'UNKNOWN');
  const recovered = await h.adapter.recover(r.pair!.pairId);
  assert.equal(recovered!.phase, 'UNBALANCED');
  assert.equal(recovered!.legs.PERP.filledQuantity, 0);
  assert.equal(recovered!.legs.PERP.status, 'REJECTED');
  assert.equal(recovered!.legs.PERP.rejectReason, 'NOT_FOUND_ON_RECOVERY');
  const next = await h.adapter.enter(makeSignal(h.clock, { signalId: 'sig-2' }), passingEvidence());
  assert.ok(next.blockCodes.some((c) => c.startsWith('HEDGE_IMBALANCE_OPEN')));
});

test('recovery detects a venue position that disagrees with the ledger and halts', async () => {
  const h = makeHarness();
  const pair = await openHedged(h);
  h.store.pairs.get(pair.pairId)!.phase = 'EXITING';
  h.store.pairs.get(pair.pairId)!.exitLegs = null;
  h.bitget.position = { quantity: 0, side: null, averagePrice: null, unrealizedPnl: null }; // someone closed it outside the adapter
  const recovered = await h.adapter.recover(pair.pairId);
  assert.equal(recovered!.phase, 'UNKNOWN');
  assert.equal(recovered!.haltReason, 'RECOVERY_RECONCILIATION_FAILED');
  assert.ok(recovered!.blockCodes.includes('RECOVERY_POSITION_MISMATCH'));
});
