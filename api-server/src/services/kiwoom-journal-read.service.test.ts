import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertKiwoomJournalReadRequest,
  prepareKiwoomDomesticFillHistory,
  prepareKiwoomUsDailyFillHistory,
} from './kiwoom-journal-read.service';
import {
  normalizeKiwoomDomesticFills,
  normalizeKiwoomUsDailyFills,
} from './kiwoom-journal-normalizer.service';
import type { KiwoomCredentials, PreparedExchangeRequest } from './trade-exchange-adapters.service';

const credentials: KiwoomCredentials = {
  appKey: 'app-key-fixture',
  secretKey: 'secret-key-fixture',
  accessToken: 'access-token-fixture',
};

test('Kiwoom domestic fill inquiry is fixed to official ka10076 account-read contract', () => {
  const request = prepareKiwoomDomesticFillHistory(credentials, {
    symbol: '005930', side: 'buy', exchange: 'krx',
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/dostk/acnt');
  assert.equal(request.headers['api-id'], 'ka10076');
  assert.deepEqual(JSON.parse(request.body ?? '{}'), {
    stk_cd: '005930', qry_tp: '1', sell_tp: '2', ord_no: '', stex_tp: '1',
  });
  assert.doesNotThrow(() => assertKiwoomJournalReadRequest(request));
  assert.throws(() => prepareKiwoomDomesticFillHistory(credentials, { symbol: 'AAPL' }), /KIWOOM_SYMBOL_INVALID/);
});

test('Kiwoom US daily fill inquiry is fixed to official ust21150 filled-order contract', () => {
  const request = prepareKiwoomUsDailyFillHistory(credentials, new Date('2026-08-12T00:00:00Z'));
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/us/acnt');
  assert.equal(request.headers['api-id'], 'ust21150');
  assert.deepEqual(JSON.parse(request.body ?? '{}'), {
    query_tp: '5', slby_tp: '0', ord_dt: '20260812',
  });
  assert.doesNotThrow(() => assertKiwoomJournalReadRequest(request));
});

test('Kiwoom journal guard rejects order and arbitrary POST mutations', () => {
  const orderMutation: PreparedExchangeRequest = {
    method: 'POST', path: '/api/dostk/ordr', query: '',
    headers: { Authorization: 'Bearer fixture', 'api-id': 'kt10000' }, body: '{}',
  };
  const arbitraryAccountPost: PreparedExchangeRequest = {
    method: 'POST', path: '/api/dostk/acnt', query: '',
    headers: { Authorization: 'Bearer fixture', 'api-id': 'kt00018' }, body: '{}',
  };
  assert.throws(() => assertKiwoomJournalReadRequest(orderMutation), /KIWOOM_JOURNAL_MUTATION_FORBIDDEN/);
  assert.throws(() => assertKiwoomJournalReadRequest(arbitraryAccountPost), /KIWOOM_JOURNAL_MUTATION_FORBIDDEN/);
});

test('Kiwoom domestic fills normalize into KR unified journal records without raw account exposure', () => {
  const result = normalizeKiwoomDomesticFills({
    return_code: 0,
    cntr: [{
      ord_no: '0000123', stk_nm: '삼성전자', io_tp_nm: '+매수', ord_pric: '70000', ord_qty: '10',
      cntr_pric: '69900', cntr_qty: '4', oso_qty: '6', tdy_trde_cmsn: '110', tdy_trde_tax: '0',
      ord_stt: '접수', trde_tp: '보통', orig_ord_no: '', ord_tm: '101530', stk_cd: '005930', stex_tp: 'KRX',
    }],
  }, '1234567890', new Date('2026-08-12T00:00:00Z'), '2026-08-12T01:30:00.000Z');

  assert.equal(result.issues.length, 0);
  assert.equal(result.records.length, 1);
  const record = result.records[0]!;
  assert.equal(record.source, 'KIWOOM_API');
  assert.equal(record.broker, 'KIWOOM');
  assert.equal(record.market, 'KR_STOCK');
  assert.equal(record.symbol, '005930');
  assert.equal(record.side, 'BUY');
  assert.equal(record.filledQuantity, 4);
  assert.equal(record.remainingQuantity, 6);
  assert.equal(record.averageFillPrice, 69900);
  assert.equal(record.status, 'PARTIALLY_FILLED');
  assert.equal(record.accountIdMasked.includes('1234567890'), false);
});

test('Kiwoom US fills normalize into USD unified journal records', () => {
  const result = normalizeKiwoomUsDailyFills({
    return_code: 0,
    result_list: [{
      ord_no: 'US00001', crnc_code: 'USD', stk_cd: 'AAPL', frgn_trde_tp: '2', ord_qty: '3', cntr_qty: '3',
      slby_tp_nm: '매수', ord_time: '093001', cntr_uv: '210.25', ord_remnq: '0', cntr_time: '093010',
    }],
  }, '0987654321', new Date('2026-08-12T00:00:00Z'), '2026-08-12T01:00:00.000Z');

  assert.equal(result.issues.length, 0);
  assert.equal(result.records.length, 1);
  const record = result.records[0]!;
  assert.equal(record.market, 'US_STOCK');
  assert.equal(record.currency, 'USD');
  assert.equal(record.symbol, 'AAPL');
  assert.equal(record.side, 'BUY');
  assert.equal(record.status, 'FILLED');
  assert.equal(record.accountIdMasked.includes('0987654321'), false);
});
