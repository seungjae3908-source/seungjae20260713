import test from 'node:test';
import assert from 'node:assert/strict';
import { readAutomaticFuturesNativeProtection, sendBitgetNativeProtectionReadonly } from './bitget-native-protection-readonly.service';
import { prepareBitgetSinglePosition } from './trade-exchange-adapters.service';
import type { TradingPlan, TradingOrder } from './trade-automation.types';
import type { PreparedExchangeRequest } from './trade-exchange-adapters.service';
const now = Date.parse('2026-10-12T03:00:00.000Z');
const credentials = { apiKey: 'fake-key', secretKey: 'fake-secret', passphrase: 'fake-pass' };
function fixture(short = false) {
  const plan = { id: 'auto-entry', userId: 'owner', exchange: 'bitget', accountMode: 'live', reduceOnly: false,
    side: short ? 'short' : 'long', symbol: 'BTCUSDT', stopPrice: short ? 102 : 98,
    targetPrices: [short ? 95 : 105], leverage: 7 } as TradingPlan;
  const order = { id: 'entry-order', userId: 'owner', planId: plan.id, exchange: 'bitget', state: 'FILLED',
    filledQuantity: 1, createdAt: new Date(now - 60_000).toISOString() } as TradingOrder;
  const position = { symbol: 'BTCUSDT', marginCoin: 'USDT', holdSide: plan.side, posMode: 'one_way_mode',
    marginMode: 'isolated', total: '1', leverage: '7', stopLoss: String(plan.stopPrice),
    takeProfit: String(plan.targetPrices[0]), stopLossId: '1001', takeProfitId: '1002' };
  const pending = (stop: boolean) => ({ orderId: stop ? '1001' : '1002', symbol: 'BTCUSDT',
    planType: stop ? 'loss_plan' : 'profit_plan', planStatus: 'not_trigger', marginCoin: 'USDT',
    marginMode: 'isolated', posMode: 'one_way_mode', posSide: plan.side, size: '1',
    triggerPrice: String(stop ? plan.stopPrice : plan.targetPrices[0]), triggerType: 'mark_price',
    executePrice: '0', cTime: String(now - 59_000) });
  return { owned: { plan, order, remainingQuantity: 1 }, position, stop: pending(true), target: pending(false) };
}
async function run(f = fixture(), transform: (v: any, request: PreparedExchangeRequest) => any = (v) => v) {
  const requests: PreparedExchangeRequest[] = [];
  const proof = await readAutomaticFuturesNativeProtection({ positions: [f.owned], credentials, now: () => now,
    send: async (request) => {
      requests.push(request);
      assert.equal(request.method, 'GET'); assert.equal(request.body, null);
      const response = request.path.endsWith('single-position') ? [f.position]
        : { entrustedList: [request.query.includes('orderId=1001') ? f.stop : f.target], endId: '' };
      return transform({ code: '00000', requestTime: now, data: response }, request);
    } });
  return { proof, requests };
}
test('both LONG/SHORT 7x isolated positions require real exact-ID native TP/SL readback, three GETs only', async () => {
  for (const short of [false, true]) {
    const { proof, requests } = await run(fixture(short));
    assert.equal(proof.ready, true); assert.equal(proof.proofs.length, 2);
    assert.equal(proof.privateReads, 3); assert.equal(requests.length, 3);
    assert.deepEqual([proof.orders, proof.cancels, proof.amends, proof.transfers, proof.withdrawals], [0, 0, 0, 0, 0]);
    assert.equal(proof.executionAuthority, 'NONE');
    assert.deepEqual(proof.proofs.map((r) => r.protectionOrderId), ['1001', '1002']);
  }
});
test('missing/duplicate native IDs, different quantity/direction/leverage/margin and stale response never prove protection', async () => {
  for (const mutate of [
    (f: any) => { f.position.stopLossId = null; },
    (f: any) => { f.position.takeProfitId = '1001'; },
    (f: any) => { f.position.total = '2'; },
    (f: any) => { f.position.holdSide = 'short'; },
    (f: any) => { f.position.leverage = '2'; },
    (f: any) => { f.position.marginMode = 'crossed'; },
    (f: any) => { f.position.posMode = 'hedge_mode'; },
    (f: any) => { f.position.stopLoss = '97'; },
    (f: any) => { f.owned.order.planId = 'other-plan'; },
  ]) { const f = fixture(); mutate(f); await assert.rejects(run(f), /BITGET_NATIVE_PROTECTION/u); }
  await assert.rejects(run(fixture(), (v) => ({ ...v, requestTime: now - 30_001 })), /RESPONSE_NOT_FRESH/u);
  await assert.rejects(run(fixture(), (v) => ({ ...v, requestTime: now + 5_001 })), /RESPONSE_NOT_FRESH/u);
});
test('position absence cannot be recorded as a native fill or zero-fee close', async () => {
  await assert.rejects(run(fixture(), (v, r) => r.path.endsWith('single-position') ? { ...v, data: [] } : v),
    /NATIVE_CLOSE_RECONCILIATION_REQUIRED/u);
});
test('pending protection requires exact unique order, trigger, full quantity, position direction and newer-than-entry provenance', async () => {
  for (const mutate of [
    (f: any) => { f.stop.orderId = '999'; }, (f: any) => { f.stop.triggerPrice = '99'; },
    (f: any) => { f.stop.size = '0.5'; }, (f: any) => { f.stop.posSide = 'short'; },
    (f: any) => { f.stop.planType = 'normal_plan'; }, (f: any) => { f.stop.planStatus = 'executed'; },
    (f: any) => { f.stop.executePrice = '97'; }, (f: any) => { f.stop.cTime = String(now - 300_000); },
  ]) { const f = fixture(); mutate(f); await assert.rejects(run(f), /BITGET_NATIVE_PROTECTION/u); }
  await assert.rejects(run(fixture(), (v, r) => r.path.endsWith('orders-plan-pending')
    ? { ...v, data: { entrustedList: [v.data.entrustedList[0], v.data.entrustedList[0]] } } : v), /EXACT_PENDING_ORDER_REQUIRED/u);
});
test('position-level TPSL only covers an exclusively AUTO-owned exact position, never a manual mixed position', async () => {
  const f = fixture(); f.stop.planType = 'pos_loss'; f.target.planType = 'pos_profit';
  f.stop.size = ''; f.target.size = '';
  assert.equal((await run(f)).proof.ready, true);
  f.position.total = '1.1'; await assert.rejects(run(f), /POSITION_POLICY_MISMATCH/u);
});
test('vacant canonical AUTO futures needs no provider requests and never invents protection evidence', async () => {
  const proof = await readAutomaticFuturesNativeProtection({ positions: [], credentials, now: () => now,
    send: async () => { throw new Error('UNEXPECTED_PROVIDER_READ'); } });
  assert.equal(proof.activeAutomaticPositionCount, 0); assert.equal(proof.privateReads, 0);
  assert.deepEqual(proof.proofs, []);
});

test('official lowercase pending marginCoin and exact-ID end cursor are accepted, unrelated cursors are rejected', async () => {
  const f = fixture(); f.stop.marginCoin = 'usdt'; f.target.marginCoin = 'usdt';
  const exactCursor = (v: any, r: PreparedExchangeRequest) => r.path.endsWith('orders-plan-pending')
    ? { ...v, data: { ...v.data, endId: v.data.entrustedList[0].orderId } } : v;
  assert.equal((await run(f, exactCursor)).proof.ready, true);
  await assert.rejects(run(f, (v, r) => r.path.endsWith('orders-plan-pending')
    ? { ...v, data: { ...v.data, endId: '999' } } : v), /EXACT_PENDING_ORDER_REQUIRED/u);
  await assert.rejects(run(f, (v) => ({ ...v, code: '40014', msg: 'RAW_PROVIDER_DETAIL_MUST_NOT_ESCAPE' })),
    (e: unknown) => e instanceof Error && e.message === 'BITGET_NATIVE_PROTECTION_QUERY_40014');
});

test('native protection transport cannot call mutation paths and sanitizes HTTP, network and invalid response errors', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const request = prepareBitgetSinglePosition(credentials, 'BTCUSDT', String(now));
  try {
    globalThis.fetch = async () => { calls += 1; throw new Error('NO_REAL_PROVIDER_REQUEST'); };
    for (const unsafe of [
      { ...request, method: 'POST' as const }, { ...request, body: '{}' },
      { ...request, path: '/api/v2/mix/order/place-order' },
      { ...request, query: '?symbol=BTCUSDT#unsafe' },
    ]) await assert.rejects(sendBitgetNativeProtectionReadonly(unsafe), /READONLY_CONTRACT_REQUIRED/u);
    assert.equal(calls, 0);
    globalThis.fetch = async (url, options) => {
      calls += 1; assert.equal(new URL(String(url)).host, 'api.bitget.com');
      assert.equal(options?.method, 'GET'); assert.equal(options?.body, null); assert.equal(options?.redirect, 'error');
      return new Response('RAW_PROVIDER_DETAIL', { status: 403 });
    };
    await assert.rejects(sendBitgetNativeProtectionReadonly(request), (e: unknown) =>
      e instanceof Error && !e.message.includes('RAW_PROVIDER_DETAIL') && /BITGET_/u.test(e.message));
    globalThis.fetch = async () => { throw new TypeError('RAW_NETWORK_DETAIL'); };
    await assert.rejects(sendBitgetNativeProtectionReadonly(request), /BITGET_NETWORK/u);
    globalThis.fetch = async () => new Response('not-json', { status: 200 });
    await assert.rejects(sendBitgetNativeProtectionReadonly(request), /RESPONSE_INVALID/u);
  } finally { globalThis.fetch = original; }
});
