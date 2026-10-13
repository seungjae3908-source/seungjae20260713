import test from 'node:test';
import assert from 'node:assert/strict';
import { kiwoomReadonlyRecoverySnapshot, readCompleteKiwoomOrderRows } from './kiwoom-readonly-order-recovery.service';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import type { PreparedExchangeRequest } from './trade-exchange-adapters.service';

const kr = { exchange: 'kiwoom', market: 'KR', symbol: '005930', side: 'buy' } as TradingPlan;
const us = { ...kr, market: 'US', symbol: 'AAPL' } as TradingPlan;
const order = (isUs = false) => ({ exchange: 'kiwoom', exchangeOrderId: isUs ? '000000252' : '0000050',
  requestedQuantity: 5 } as TradingOrder);
const krRow = () => ({ ord_no: '0000050', stk_cd: 'A005930', io_tp_nm: '현금매수', ord_qty: '0000000005',
  cntr_qty: '0000000005', ord_remnq: '0000000000', cntr_uv: '0000050000', acpt_tp: '접수', mdfy_cncl: '' });
const usRow = () => ({ ord_no: '000000252', stk_cd: 'AAPL', crnc_code: 'USD', slby_tp_nm: '매수',
  ord_qty: '000000000005', cntr_qty: '000000000005', ord_remnq: '000000000000', cntr_uv: '201.3147',
  cncl_qty: '000000000000', mdfy_qty: '000000000000', ord_stat_nm: '체결완료' });
const request = { method: 'POST', path: '/api/us/acnt', query: '', headers: { 'api-id': 'ust21150' },
  body: JSON.stringify({ ord_dt: '20261009', query_tp: '1', slby_tp: '0' }) } as PreparedExchangeRequest;

test('official readonly complete pagination preserves request identity and continuation headers', async () => {
  const calls: PreparedExchangeRequest[] = [];
  const rows = await readCompleteKiwoomOrderRows(request, async (next) => {
    calls.push(next);
    return calls.length === 1 ? { payload: { return_code: 0, result_list: [{ ord_no: '000000251' }] },
      apiId: 'ust21150', contYn: 'Y', nextKey: 'page-2' } : { payload: { return_code: 0, result_list: [usRow()] },
      apiId: 'ust21150', contYn: 'N', nextKey: null };
  });
  assert.equal(rows.length, 2);
  assert.equal(calls[1]?.body, request.body);
  assert.equal(calls[1]?.headers['next-key'], 'page-2');
  assert.equal(calls[1]?.headers['cont-yn'], 'Y');
  assert.equal(kiwoomReadonlyRecoverySnapshot(rows, us, order(true), 'ust21150')?.filledQuantity, 5);
});

test('complete pagination rejects missing/replayed keys, malformed rows, wrong API and error payloads', async () => {
  for (const response of [
    { payload: { return_code: 0, result_list: [usRow()] }, apiId: null, contYn: 'Y', nextKey: null },
    { payload: { return_code: 0, result_list: [] }, apiId: null, contYn: 'Y', nextKey: 'page-2' },
    { payload: { return_code: 0, result_lsit: [usRow()] }, apiId: null, contYn: null, nextKey: null },
    { payload: { return_code: 0, result_list: [null] }, apiId: null, contYn: null, nextKey: null },
    { payload: { return_code: 0, result_list: [] }, apiId: 'kt10000', contYn: null, nextKey: null },
    { payload: { return_code: 10, result_list: [] }, apiId: null, contYn: null, nextKey: null },
    { payload: { return_code: 0, result_list: [] }, apiId: null, contYn: 'N', nextKey: 'unconsumed' },
  ]) await assert.rejects(readCompleteKiwoomOrderRows(request, async () => response), /KIWOOM_RECOVERY_/u);
  let calls = 0;
  await assert.rejects(readCompleteKiwoomOrderRows(request, async () => {
    calls++;
    return { payload: { return_code: 0, result_list: [usRow()] }, apiId: null, contYn: 'Y', nextKey: 'repeated' };
  }), /CONTINUATION_INVALID/u);
  assert.equal(calls, 2);
});

test('readonly pagination cannot dispatch a financial API', async () => {
  let sent = 0;
  for (const invalid of [{ ...request, path: '/api/us/ordr' },
    { ...request, headers: { 'api-id': 'ust10000' } }, { ...request, method: 'GET' }]) {
    await assert.rejects(readCompleteKiwoomOrderRows(invalid as PreparedExchangeRequest, async () => {
      sent++; throw new Error('NOT_REACHABLE');
    }), /READ_CONTRACT_REQUIRED/u);
  }
  assert.equal(sent, 0);
});

test('unique official KR/US full-fill rows retain actual quantity/price without invented fees or fills', () => {
  for (const [p, o, row, contract] of [[kr, order(), krRow(), 'kt00007'],
    [us, order(true), usRow(), 'ust21150']] as const) {
    const result = kiwoomReadonlyRecoverySnapshot([row], p, o, contract)!;
    assert.equal(result.state, 'FILLED');
    assert.equal(result.filledQuantity, 5);
    assert.equal(result.remainingQuantity, 0);
    assert.equal(result.feeAmount, null);
    assert.equal(result.feeCurrency, null);
    assert.deepEqual(result.fills, []);
    assert.equal(result.cancelable, false);
  }
});

test('partial, accepted and explicit canceled states cannot be confused with full fills', () => {
  const partial = { ...usRow(), cntr_qty: '2', ord_remnq: '3', ord_stat_nm: '부분체결' };
  assert.equal(kiwoomReadonlyRecoverySnapshot([partial], us, order(true), 'ust21150')?.state, 'PARTIALLY_FILLED');
  const accepted = { ...partial, cntr_qty: '0', ord_remnq: '5', ord_stat_nm: '접수', cntr_uv: '0' };
  assert.equal(kiwoomReadonlyRecoverySnapshot([accepted], us, order(true), 'ust21150')?.state, 'ACCEPTED');
  const canceled = { ...partial, ord_remnq: '0', cncl_qty: '3', ord_stat_nm: '취소확인' };
  assert.equal(kiwoomReadonlyRecoverySnapshot([canceled], us, order(true), 'ust21150')?.state, 'CANCELED');
  assert.throws(() => kiwoomReadonlyRecoverySnapshot([{ ...partial, ord_remnq: '0' }], us, order(true), 'ust21150'), /STATUS_UNKNOWN/u);
  assert.equal(kiwoomReadonlyRecoverySnapshot([], us, order(true), 'ust21150'), null);
});

test('US symbol starting with A remains exact; wrong currency/side/ID/duplicates/quantities fail closed', () => {
  for (const patch of [{ stk_cd: 'APL' }, { crnc_code: 'KRW' }, { slby_tp_nm: '매도' },
    { slby_tp_nm: '' }, { ord_qty: '6' }, { cntr_qty: '6' }, { cntr_qty: '-1' },
    { ord_remnq: '' }, { cntr_uv: '0' }, { ord_stat_nm: 'unknown' }, { mdfy_qty: '1' }, { cncl_qty: '1' }]) {
    assert.throws(() => kiwoomReadonlyRecoverySnapshot([{ ...usRow(), ...patch }], us, order(true), 'ust21150'), /KIWOOM_/u);
  }
  assert.throws(() => kiwoomReadonlyRecoverySnapshot([usRow(), usRow()], us, order(true), 'ust21150'), /AMBIGUOUS/u);
  assert.throws(() => kiwoomReadonlyRecoverySnapshot([usRow()], us, { ...order(true), exchangeOrderId: 'forged' }, 'ust21150'), /ORDER_ID_INVALID/u);
  assert.throws(() => kiwoomReadonlyRecoverySnapshot([usRow()], us, { ...order(true), exchangeOrderId: '000000000' }, 'ust21150'), /ORDER_ID_INVALID/u);
  assert.throws(() => kiwoomReadonlyRecoverySnapshot([krRow()], kr, order(), 'ust21150'), /MARKET_CONTRACT_MISMATCH/u);
});

test('KR open order uses actual aggregate filled value and does not treat closed page absence as canceled', () => {
  const row = { ...krRow(), oso_qty: '3', cntr_tot_amt: '100000', ord_stt: '접수' };
  const result = kiwoomReadonlyRecoverySnapshot([row], kr, order(), 'ka10075')!;
  assert.equal(result.state, 'PARTIALLY_FILLED');
  assert.equal(result.filledQuantity, 2);
  assert.equal(result.averageFillPrice, 50000);
  assert.equal(kiwoomReadonlyRecoverySnapshot([], kr, order(), 'ka10075'), null);
  assert.throws(() => kiwoomReadonlyRecoverySnapshot([{ ...krRow(), cntr_qty: '2', ord_remnq: '0' }], kr, order(), 'kt00007'), /STATUS_UNKNOWN/u);
  const canceled = { ...krRow(), cntr_qty: '2', cnfm_qty: '3', acpt_tp: '확인', mdfy_cncl: '취소' };
  assert.equal(kiwoomReadonlyRecoverySnapshot([canceled], kr, order(), 'kt00007')?.state, 'CANCELED');
  assert.throws(() => kiwoomReadonlyRecoverySnapshot([{ ...canceled, cnfm_qty: '0' }], kr, order(), 'kt00007'), /STATUS_QUANTITY_MISMATCH/u);
});
