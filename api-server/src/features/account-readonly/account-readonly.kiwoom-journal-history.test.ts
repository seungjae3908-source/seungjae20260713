import assert from 'node:assert/strict';
import test from 'node:test';
import { readKiwoomJournalHistory } from './account-readonly.kiwoom-journal-history';

const NOW = Date.parse('2026-09-25T03:30:00.000Z');
const USER_ID = 'kiwoom-history-user';

test('Kiwoom KR and US fills normalize from official fill fields without inventing costs', async () => {
  let requestedDates: readonly string[] = [];
  const result = await readKiwoomJournalHistory({
    provider: {
      async journalFillRows(_credentials, dates) {
        requestedDates = dates;
        return {
          privateProviderRequests: 14,
          domestic: [{
            orderDate: dates.at(-1)!,
            row: {
              ord_no: 'KR-ORDER-1',
              stk_cd: 'A005930',
              trde_tp: '2',
              io_tp_nm: '매수',
              cntr_no: 'KR-FILL-1',
              cntr_qty: '3',
              cntr_uv: '70000',
              cntr_tm: '101530',
            },
          }],
          us: [{
            orderDate: dates.at(-1)!,
            row: {
              ord_no: 'US-ORDER-1',
              crnc_code: 'USD',
              stk_cd: 'AAPL',
              frgn_trde_tp: '1',
              slby_tp_nm: '매도',
              cntr_qty: '2',
              cntr_uv: '200.5',
              ord_time: '090000',
              cntr_time: '091500',
            },
          }],
        };
      },
    },
    credentials: { appKey: 'KIWOOM_APP_TEST_ONLY', appSecret: 'KIWOOM_SECRET_TEST_ONLY' },
    userId: USER_ID,
    requestedDays: 30,
    endMs: NOW,
  });

  assert.equal(requestedDates.length, 7);
  assert.equal(result.effectiveDays, 7);
  assert.equal(result.rangeCapped, true);
  assert.equal(result.truncated, true);
  assert.equal(result.privateProviderRequests, 14);
  assert.equal(result.normalizationFailures, 0);
  assert.equal(result.payloads.length, 2);

  const kr = result.payloads.find((row) => row.market === 'KR_STOCK')!;
  assert.equal(kr.source, 'KIWOOM_API');
  assert.equal(kr.broker, 'KIWOOM');
  assert.equal(kr.symbol, '005930');
  assert.equal(kr.side, 'BUY');
  assert.equal(kr.fillId, 'KR-FILL-1');
  assert.equal(kr.filledQuantity, 3);
  assert.equal(kr.averageFillPrice, 70000);
  assert.equal(kr.fees, null);
  assert.equal(kr.tax, null);
  assert.match(String(kr.filledAt), /\+09:00$/);
  assert.ok((kr.warnings as string[]).includes('KIWOOM_PROVIDER_TIMEZONE_ASSUMED_KST_NOT_OFFICIALLY_DOCUMENTED'));

  const us = result.payloads.find((row) => row.market === 'US_STOCK')!;
  assert.equal(us.symbol, 'AAPL');
  assert.equal(us.side, 'SELL');
  assert.equal(us.currency, 'USD');
  assert.equal(us.filledQuantity, 2);
  assert.equal(us.averageFillPrice, 200.5);
  assert.equal(us.fillId, null);
  assert.match(String(us.brokerOrderId), /^US-ORDER-1:[0-9a-f]{16}$/);
  assert.ok((us.warnings as string[]).includes('KIWOOM_PROVIDER_TIMEZONE_ASSUMED_KST_NOT_OFFICIALLY_DOCUMENTED'));
  assert.equal(String(us.accountIdMasked).includes(USER_ID), false);
  assert.equal(JSON.stringify(result).includes('KIWOOM_SECRET_TEST_ONLY'), false);
});

test('Kiwoom malformed or duplicate fills stay partial instead of becoming fake trades', async () => {
  const result = await readKiwoomJournalHistory({
    provider: {
      async journalFillRows(_credentials, dates) {
        const row = {
          ord_no: 'KR-ORDER-1',
          stk_cd: '005930',
          trde_tp: '2',
          cntr_no: 'KR-FILL-1',
          cntr_qty: '1',
          cntr_uv: '70000',
          cntr_tm: '101530',
        };
        return {
          privateProviderRequests: 2,
          domestic: [
            { orderDate: dates[0]!, row },
            { orderDate: dates[0]!, row },
            { orderDate: dates[0]!, row: { ...row, cntr_no: 'BROKEN', cntr_tm: '99:99:99' } },
          ],
          us: [],
        };
      },
    },
    credentials: { appKey: 'A', appSecret: 'S' },
    userId: USER_ID,
    requestedDays: 1,
    endMs: NOW,
  });

  assert.equal(result.payloads.length, 1);
  assert.equal(result.normalizationFailures, 2);
  assert.equal(result.truncated, true);
});
