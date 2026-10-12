import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareKiwoomOrderable, prepareKiwoomUnfilled, prepareKiwoomUsOrderable } from './trade-exchange-adapters.service';
import { buildKiwoomExecutionSnapshot, buildKiwoomUsExecutionSnapshot } from './trade-execution-snapshot.service';
import type { TradingPlan } from './trade-automation.types';

// Field facts verified against the provider's official kiwoom_api_spec.json,
// https://github.com/Kiwoom-Securities/Kiwoom-REST-API/tree/main/kiwoom/_data
// No provider transport or real credentials are used by this contract test.
const credentials = { appKey: 'TEST_ONLY', secretKey: 'TEST_ONLY', accessToken: 'TEST_ONLY' };
const plan = { exchange: 'kiwoom', market: 'KR', symbol: '005930', side: 'buy', orderType: 'market',
  quantity: 1, estimatedKrw: 70_000, leverage: null, marginMode: null, entryPrice: 70_000,
  limitPrice: null, marketSnapshot: { currentPrice: 70_000, estimatedFeePercent: 0.1 } } as TradingPlan;
const usPlan = { ...plan, market: 'US', symbol: 'AAPL', stockExchange: 'NASDAQ', estimatedKrw: 140_000,
  entryPrice: 100, marketSnapshot: { ...plan.marketSnapshot, currentPrice: 100 } } as TradingPlan;
const signal: Parameters<typeof buildKiwoomExecutionSnapshot>[0]['signal'] = {
  state: 'entry_ready', observedAt: new Date().toISOString(),
};
const usInput = () => ({ plan: usPlan, signal, observedAt: new Date(), holdings: { result_list: [] },
  unfilled: { result_list: [] }, orderable: { crnc_code: 'USD', ord_alowa_100: '200', ord_alowa: '2000' },
  orderbook: { cur_prc: '100', sel_1bid: '100', sel_1bid_req: '100', buy_1bid: '99.9', buy_1bid_req: '100' } });

test('Kiwoom KR and US orderability include every official required field before submission', () => {
  const kr = prepareKiwoomOrderable(credentials, plan);
  assert.equal(kr.headers['api-id'], 'kt00010');
  assert.equal(kr.path, '/api/dostk/acnt');
  assert.deepEqual(JSON.parse(kr.body!), { stk_cd: '005930', trde_tp: '2', uv: '70000' });
  assert.equal(JSON.parse(prepareKiwoomOrderable(credentials, { ...plan, side: 'sell' }).body!).trde_tp, '1');
  const us = prepareKiwoomUsOrderable(credentials, usPlan);
  assert.equal(us.headers['api-id'], 'ust31490');
  assert.equal(us.path, '/api/us/ordr', 'this TR is a query despite its provider path');
  assert.deepEqual(JSON.parse(us.body!), { stk_cd: 'AAPL', stex_tp: 'ND', uv: '100' });
  const limit = prepareKiwoomOrderable(credentials, { ...plan, orderType: 'limit', limitPrice: 69_000 });
  assert.equal(JSON.parse(limit.body!).uv, '69000');
});
test('Kiwoom KR unfilled inspection includes both sides and exchanges across the entire account', () => {
  const query = prepareKiwoomUnfilled(credentials);
  assert.equal(query.headers['api-id'], 'ka10075');
  assert.deepEqual(JSON.parse(query.body!), { all_stk_tp: '0', trde_tp: '0', stex_tp: '0' });
});
test('Kiwoom orderability does not fabricate a missing price or accept cash short or margin plans', () => {
  for (const change of [{ entryPrice: null, marketSnapshot: {} }, { side: 'short' }, { leverage: 2 }, { marginMode: 'isolated' }]) {
    assert.throws(() => prepareKiwoomOrderable(credentials, { ...plan, ...change } as TradingPlan), /ORDERABILITY_INPUT_INVALID/u);
    assert.throws(() => prepareKiwoomUsOrderable(credentials, { ...usPlan, ...change } as TradingPlan), /ORDERABILITY_INPUT_INVALID/u);
  }
});
test('Kiwoom KR cash capacity recognizes official 100% margin field instead of assuming a zero balance', () => {
  const snapshot = buildKiwoomExecutionSnapshot({ plan, signal, observedAt: new Date(), unfilled: { oso: [] },
    orderable: { profa_100ord_alow_amt: '70000', ord_alowa: '700000' },
    orderbook: { sel_fpr_bid: '70000', sel_fpr_req: '100', buy_fpr_bid: '69900', buy_fpr_req: '100' } });
  assert.equal(snapshot.availableBalance, 70_000);
  assert.equal(snapshot.currentPrice, 70_000);
});
test('Kiwoom US uses 100% USD capacity, never treats a KRW capacity as dollars or a higher loan capacity as cash', () => {
  const input = usInput();
  assert.equal(buildKiwoomUsExecutionSnapshot(input).availableBalance, 280_000);
  assert.equal(buildKiwoomUsExecutionSnapshot({ ...input, orderable: { krw_ord_alowa_100: '1_000_000' } }).availableBalance, 0);
  assert.equal(buildKiwoomUsExecutionSnapshot({ ...input, orderable: { ord_alowa_100: '0', ord_alowa: '2000' } }).availableBalance, 0);
  assert.throws(() => buildKiwoomUsExecutionSnapshot({ ...input, orderable: { crnc_code: 'KRW', ord_alowa_100: '1000000' } }), /CURRENCY_MISMATCH/u);
});
