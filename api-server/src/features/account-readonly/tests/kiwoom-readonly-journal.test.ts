import assert from 'node:assert/strict';
import test from 'node:test';
import { KiwoomReadonlyProvider } from '../providers/kiwoom-readonly.provider';

test('Kiwoom journal fill reader uses only official account history APIs and bounded continuation', async () => {
  const seen: Array<{ path: string; method: string; apiId: string | null; body: string }> = [];
  const provider = new KiwoomReadonlyProvider(
    async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      seen.push({
        path: url.pathname,
        method: String(init?.method ?? ''),
        apiId: headers.get('api-id'),
        body,
      });

      if (url.pathname === '/oauth2/token') {
        return new Response(JSON.stringify({
          return_code: 0,
          token: 'KIWOOM_TOKEN_TEST_ONLY',
          expires_dt: '20260926090000',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/api/dostk/acnt') {
        assert.equal(headers.get('api-id'), 'kt00009');
        const parsed = JSON.parse(body) as Record<string, string>;
        assert.equal(parsed.ord_dt, '20260925');
        assert.equal(parsed.qry_tp, '1');
        return new Response(JSON.stringify({
          return_code: 0,
          acnt_ord_cntr_prst_array: [{
            ord_no: 'KR-1',
            stk_cd: '005930',
            trde_tp: '2',
            cntr_no: 'KR-FILL-1',
            cntr_qty: '1',
            cntr_uv: '70000',
            cntr_tm: '101530',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'cont-yn': 'N' },
        });
      }

      if (url.pathname === '/api/us/acnt') {
        assert.equal(headers.get('api-id'), 'ust21150');
        const parsed = JSON.parse(body) as Record<string, string>;
        assert.equal(parsed.ord_dt, '20260925');
        assert.equal(parsed.query_tp, '5');
        return new Response(JSON.stringify({
          return_code: 0,
          result_list: [{
            ord_no: 'US-1',
            crnc_code: 'USD',
            stk_cd: 'AAPL',
            frgn_trde_tp: '1',
            cntr_qty: '2',
            cntr_uv: '200',
            ord_time: '090000',
            cntr_time: '091500',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'cont-yn': 'N' },
        });
      }

      return new Response('{}', { status: 404 });
    },
    () => Date.parse('2026-09-25T03:30:00.000Z'),
  );

  const result = await provider.journalFillRows(
    { appKey: 'KIWOOM_APP_TEST_ONLY', appSecret: 'KIWOOM_SECRET_TEST_ONLY' },
    ['20260925'],
  );

  assert.equal(result.domestic.length, 1);
  assert.equal(result.us.length, 1);
  assert.equal(result.privateProviderRequests, 2);
  assert.deepEqual(seen.map((row) => [row.method, row.path, row.apiId]), [
    ['POST', '/oauth2/token', null],
    ['POST', '/api/dostk/acnt', 'kt00009'],
    ['POST', '/api/us/acnt', 'ust21150'],
  ]);
  assert.equal(seen.some((row) => row.path.includes('/ordr')), false);
  assert.equal(JSON.stringify(result).includes('KIWOOM_TOKEN_TEST_ONLY'), false);
  assert.equal(JSON.stringify(result).includes('KIWOOM_SECRET_TEST_ONLY'), false);
});

test('Kiwoom journal fill reader rejects more than seven requested dates before provider reads', async () => {
  let calls = 0;
  const provider = new KiwoomReadonlyProvider(async () => {
    calls += 1;
    return new Response('{}', { status: 500 });
  });

  await assert.rejects(
    () => provider.journalFillRows(
      { appKey: 'A', appSecret: 'S' },
      Array.from({ length: 8 }, (_, index) => `202609${String(index + 1).padStart(2, '0')}`),
    ),
    /KIWOOM_JOURNAL_DATE_RANGE_INVALID/,
  );
  assert.equal(calls, 0);
});
