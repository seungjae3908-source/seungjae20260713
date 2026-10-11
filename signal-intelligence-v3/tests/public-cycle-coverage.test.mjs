import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_CYCLE_COVERAGE_POLICY_VERSION,
  PUBLIC_V3_SPOT_STAGE_TWO_LIMIT,
  classifyPublicCycleLaneStatus,
  decidePublicCycleCursor,
  parsePublicRetryAfterMs,
  publicUpbitGroupForUrl,
  createPublicUpbitGroupPacer,
  PUBLIC_V3_UPBIT_GROUP_INTERVAL_MS,
  PUBLIC_V3_BITGET_MARKET_INTERVAL_MS,
  publicBitgetMarketEndpoint,
  createPublicBitgetMarketPacer,
} from '../src/public-cycle-coverage.mjs';

function result(changes={}) {
  return {
    outcome: null, dataState: 'untrusted', cards: [],
    universe: {
      totalCount: 4010, cursor: 0, nextCursor: 20,
      source: 'krx-symbol-master', partial: true, stale: false,
    },
    execution: {
      requestedCount: 20, startedCount: 20, completedCount: 20,
      providerErrorCount: 0, timeoutCount: 0, partial: false,
    },
    ...changes,
  };
}
test('partial current KRX eligible roster stays BLOCKED_DATA but advances attempted-only cursor', () => {
  const evidence = result();
  const status = classifyPublicCycleLaneStatus(evidence);
  assert.equal(status, 'BLOCKED_DATA');
  const decision = decidePublicCycleCursor({response:evidence,status,cursor:0});
  assert.equal(decision.nextCursor, 20);
  assert.equal(decision.blockedObservationOnly, true);
  assert.equal(decision.reason, 'BLOCKED_RESEARCH_ROTATION_ONLY');
  assert.equal(evidence.cards.length, 0);
  assert.equal(PUBLIC_CYCLE_COVERAGE_POLICY_VERSION, 'public-cycle-coverage-v1');
  assert.equal(PUBLIC_V3_SPOT_STAGE_TWO_LIMIT, 5, 'V3 must not request twenty deep Upbit symbols per strategy');
});
test('partial but provider errors, timeouts, stale or incomplete batch cannot advance', () => {
  const variants = [
    result({execution:{...result().execution,providerErrorCount:1}}),
    result({execution:{...result().execution,timeoutCount:1}}),
    result({execution:{...result().execution,completedCount:19}}),
    result({universe:{...result().universe,stale:true,source:'last-good-cache'}}),
    result({universe:{...result().universe,source:'curated-fallback'}}),
    result({outcome:'PROVIDER_FAILURE'}),
    result({universe:{...result().universe,nextCursor:10}}),
  ];
  for(const data of variants) {
    const status=classifyPublicCycleLaneStatus(data);
    const decision=decidePublicCycleCursor({response:data,status,cursor:0});
    assert.equal(decision.nextCursor,0,JSON.stringify(data));
    assert.equal(decision.blockedObservationOnly,false);
    assert.ok(status==='BLOCKED_DATA'||status==='SEARCH_FAILURE');
  }
});
test('valid full batch rotates, while missing evidence never becomes zero-trade', () => {
  const complete=result({
    dataState:'complete',
    cards:[{symbol:'BTC',direction:'LONG'}],
    universe:{...result().universe,partial:false},
  });
  assert.equal(classifyPublicCycleLaneStatus(complete),'CANDIDATES_AVAILABLE');
  const rotated=decidePublicCycleCursor({
    response:complete,status:'CANDIDATES_AVAILABLE',cursor:0,
  });
  assert.equal(rotated.nextCursor,20);
  assert.equal(rotated.blockedObservationOnly,false);
  const zero={...complete,cards:[]};
  assert.equal(classifyPublicCycleLaneStatus(zero),'VALID_NO_TRADE');
  const unavailable={...complete,execution:{...complete.execution,providerErrorCount:1},cards:[]};
  assert.equal(classifyPublicCycleLaneStatus(unavailable),'SEARCH_FAILURE');
  assert.equal(decidePublicCycleCursor({
    response:unavailable,status:'SEARCH_FAILURE',cursor:0,
  }).nextCursor,0);
  assert.equal(classifyPublicCycleLaneStatus(null),'SEARCH_FAILURE');
});
test('missing completed symbols cannot masquerade as valid no-trade or advance cursor', () => {
  const full=result({
    dataState:'complete',cards:[],
    universe:{...result().universe,partial:false},
  });
  for (const broken of [
    {...full, execution:{...full.execution,startedCount:19}},
    {...full, execution:{...full.execution,completedCount:19}},
    {...full, execution:{...full.execution,partial:true}},
    {...full, universe:{...full.universe,nextCursor:19}},
    {...full, universe:{...full.universe,nextCursor:null}},
    {...full, universe:{...full.universe,cursor:20}},
    {...full, universe:{...full.universe,totalCount:10}},
    {...full, execution:{...full.execution,requestedCount:0}},
  ]) {
    const status=classifyPublicCycleLaneStatus(broken);
    assert.equal(status,'SEARCH_FAILURE',JSON.stringify(broken));
    const cursor=decidePublicCycleCursor({response:broken,status,cursor:0});
    assert.equal(cursor.nextCursor,0);
    assert.equal(cursor.blockedObservationOnly,false);
  }
  const mismatched=decidePublicCycleCursor({
    response:full,status:'BLOCKED_DATA',cursor:0,
  });
  assert.equal(mismatched.nextCursor,0);
  assert.equal(mismatched.reason,'STATUS_EVIDENCE_MISMATCH');
});

test('a complete last page wraps, without pretending first-page or all-universe coverage', () => {
  const evidence=result({
    dataState:'complete',cards:[],
    universe:{totalCount:41,cursor:40,nextCursor:null,source:'bitget-public',partial:false,stale:false},
    execution:{requestedCount:1,startedCount:1,completedCount:1,providerErrorCount:0,timeoutCount:0,partial:false},
  });
  assert.equal(decidePublicCycleCursor({
    response:evidence,status:classifyPublicCycleLaneStatus(evidence),cursor:40,
  }).nextCursor,0);
  assert.throws(()=>decidePublicCycleCursor({response:evidence,status:'VALID_NO_TRADE',cursor:-1}),/CURSOR_INVALID/);
});

test('fallback or unknown stock roster is never promoted to verified no-trade or signal', () => {
  const verified = result({
    outcome: 'VALID_ZERO_SIGNAL',
    dataState: 'complete',
    universe: { ...result().universe, partial: false },
  });
  assert.equal(classifyPublicCycleLaneStatus(verified), 'VALID_NO_TRADE');
  for (const source of ['curated-fallback', 'last-good-cache', 'unknown', null]) {
    const response = { ...verified, universe: { ...verified.universe, source } };
    const status = classifyPublicCycleLaneStatus(response);
    assert.equal(status, 'BLOCKED_DATA', String(source));
    const cursor = decidePublicCycleCursor({ response, status, cursor: 0 });
    assert.equal(cursor.nextCursor, 0);
    assert.equal(cursor.reason, 'BLOCKED_WITHOUT_PROVEN_ROSTER');
  }
});

test('explicit mapping, quality and render errors cannot become zero-trade coverage', () => {
  const healthy = result({
    dataState: 'complete', cards: [],
    universe: { ...result().universe, partial: false },
  });
  for (const outcome of [
    'UNIVERSE_EMPTY', 'SYMBOL_MAPPING_FAILURE',
    'DATA_QUALITY_REJECT', 'FRONTEND_RENDER_FAILURE',
    'PROVIDER_FAILURE', 'REQUEST_TIMEOUT',
  ]) {
    const response = { ...healthy, outcome };
    const status = classifyPublicCycleLaneStatus(response);
    assert.equal(status, 'SEARCH_FAILURE', outcome);
    assert.equal(decidePublicCycleCursor({ response, status, cursor: 0 }).nextCursor, 0);
  }
  // Legitimate completed business filtering is still a valid zero-signal page.
  assert.equal(classifyPublicCycleLaneStatus({
    ...healthy, outcome: 'FILTER_TOO_STRICT',
  }), 'VALID_NO_TRADE');
});

test('contradictory card count and declared outcome fail closed without candidate promotion', () => {
  const healthy = result({
    dataState: 'complete', cards: [],
    universe: { ...result().universe, partial: false },
  });
  for (const response of [
    { ...healthy, outcome: 'CANDIDATES_AVAILABLE' },
    { ...healthy, outcome: 'VALID_ZERO_SIGNAL', cards: [{ symbol: '005930', direction: 'LONG' }] },
  ]) {
    const status = classifyPublicCycleLaneStatus(response);
    assert.equal(status, 'SEARCH_FAILURE');
    assert.equal(decidePublicCycleCursor({ response, status, cursor: 0 }).nextCursor, 0);
  }
});

test('HTTP Retry-After seconds, dates and malformed values honor conservative 429 backpressure', () => {
  const now = Date.parse('2026-10-11T01:00:00.000Z');
  assert.equal(parsePublicRetryAfterMs(null, now), null);
  assert.equal(parsePublicRetryAfterMs('2', now), 2000);
  assert.equal(parsePublicRetryAfterMs('0.5', now), 500);
  assert.equal(parsePublicRetryAfterMs('0', now), 0);
  assert.equal(parsePublicRetryAfterMs(new Date(now + 15000).toUTCString(), now), 15000);
  assert.equal(parsePublicRetryAfterMs(new Date(now - 2000).toUTCString(), now), 0);
  for (const value of ['-1', 'not-a-date', 'Infinity', '999999999999999999999999']) {
    assert.equal(parsePublicRetryAfterMs(value, now), Number.POSITIVE_INFINITY, value);
  }
  assert.throws(() => parsePublicRetryAfterMs('2', Number.NaN), /CLOCK_INVALID/);
});

test('known-partial KRX eligible page rotates observation-only despite inherited execution.partial', () => {
  const evidence = result({
    dataState: 'partial',
    universe: { ...result().universe, partial: true },
    execution: { ...result().execution, partial: true },
  });
  const status = classifyPublicCycleLaneStatus(evidence);
  assert.equal(status, 'BLOCKED_DATA');
  const cursor = decidePublicCycleCursor({ response: evidence, status, cursor: 0 });
  assert.equal(cursor.nextCursor, 20);
  assert.equal(cursor.blockedObservationOnly, true);
  assert.equal(cursor.reason, 'BLOCKED_RESEARCH_ROTATION_ONLY');
  assert.equal(evidence.cards.length, 0);
});

test('no source-partial waiver for aborted or timed-out pages, failed or incomplete work', () => {
  const baseline = result({
    dataState: 'partial',
    execution: { ...result().execution, partial: true },
  });
  for (const broken of [
    { ...baseline, execution: { ...baseline.execution, cancelled: true } },
    { ...baseline, execution: { ...baseline.execution, timedOut: true } },
    { ...baseline, execution: { ...baseline.execution, duplicate: true } },
    { ...baseline, execution: { ...baseline.execution, completedCount: 19 } },
    { ...baseline, execution: { ...baseline.execution, startedCount: 19 } },
    { ...baseline, execution: { ...baseline.execution, timeoutCount: 1 } },
    { ...baseline, execution: { ...baseline.execution, providerErrorCount: 1 } },
    { ...baseline, universe: { ...baseline.universe, stale: true } },
  ]) {
    const status = classifyPublicCycleLaneStatus(broken);
    assert.equal(status, 'SEARCH_FAILURE');
    const cursor = decidePublicCycleCursor({ response: broken, status, cursor: 0 });
    assert.equal(cursor.nextCursor, 0);
    assert.equal(cursor.blockedObservationOnly, false);
  }
  const completeRoster = {
    ...baseline, universe: { ...baseline.universe, partial: false },
  };
  assert.equal(classifyPublicCycleLaneStatus(completeRoster), 'SEARCH_FAILURE');
});

test('stale underlying candles hold research cursor even with a fresh public roster', () => {
  for (const partial of [false, true]) {
    const data = result({
      dataState: 'stale',
      cards: [],
      universe: {
        totalCount: 50, cursor: 20, nextCursor: 40,
        source: partial ? 'krx-symbol-master' : 'upbit-public',
        partial, stale: false,
      },
      execution: {
        ...result().execution,
        requestedCount: 20, startedCount: 20, completedCount: 20, partial,
      },
    });
    const status = classifyPublicCycleLaneStatus(data);
    assert.equal(status, 'BLOCKED_DATA');
    const resultCursor = decidePublicCycleCursor({ response: data, status, cursor: 20 });
    assert.equal(resultCursor.nextCursor, 20);
    assert.equal(resultCursor.blockedObservationOnly, false);
    assert.equal(resultCursor.reason, 'STALE_CANDLE_HOLD');
  }
});

test('synthetic four-market paginated research windows visit every eligible index once without cursor skips', () => {
  const scenarios = [
    { market: 'KR_STOCK', total: 4010, batch: 20, source: 'krx-symbol-master', partial: true },
    { market: 'US_STOCK', total: 12322, batch: 20, source: 'nasdaq-trader-public-directory', partial: false },
    { market: 'CRYPTO_SPOT', total: 294, batch: PUBLIC_V3_SPOT_STAGE_TWO_LIMIT, source: 'upbit-public', partial: false },
    { market: 'CRYPTO_FUTURES', total: 820, batch: 20, source: 'bitget-public', partial: false },
  ];
  for (const { market, total, batch, source, partial } of scenarios) {
    let cursor = 0;
    const visited = new Set();
    const pageCount = Math.ceil(total / batch);
    for (let page = 0; page < pageCount; page += 1) {
      const count = Math.min(batch, total - cursor);
      const after = cursor + count < total ? cursor + count : null;
      const data = result({
        outcome: null,
        dataState: partial ? 'partial' : 'complete',
        cards: [],
        universe: { totalCount: total, cursor, nextCursor: after, source, partial, stale: false },
        execution: {
          requestedCount: count, startedCount: count, completedCount: count,
          providerErrorCount: 0, timeoutCount: 0, partial,
          cancelled: false, timedOut: false, duplicate: false,
        },
      });
      const status = classifyPublicCycleLaneStatus(data);
      assert.equal(status, partial ? 'BLOCKED_DATA' : 'VALID_NO_TRADE', market);
      const decision = decidePublicCycleCursor({ response: data, status, cursor });
      assert.equal(decision.nextCursor, after ?? 0, market);
      assert.equal(decision.blockedObservationOnly, partial, market);
      for (let index = cursor; index < cursor + count; index += 1) {
        assert.equal(visited.has(index), false, `${market} duplicate index ${index}`);
        visited.add(index);
      }
      cursor = decision.nextCursor;
    }
    assert.equal(cursor, 0, `${market} did not wrap after last eligible index`);
    assert.equal(visited.size, total, `${market} dropped or skipped source indexes`);
  }
  // These are synthetic index-rotation tests, not proof of authentic whole-
  // market quotes, provider uptime, OOS, Paper fills, or profitability.
});

test('synthetic independent Upbit pacing classifies only permitted public endpoint groups', () => {
  assert.equal(publicUpbitGroupForUrl('https://api.upbit.com/v1/candles/days?market=KRW-BTC'), 'candle');
  assert.equal(publicUpbitGroupForUrl('https://api.upbit.com/v1/candles/minutes/240?market=KRW-BTC'), 'candle');
  assert.equal(publicUpbitGroupForUrl('https://api.upbit.com/v1/orderbook?markets=KRW-BTC'), 'orderbook');
  assert.equal(publicUpbitGroupForUrl('https://api.upbit.com/v1/orderbook/instruments?markets=KRW-BTC'), 'orderbook');
  assert.equal(publicUpbitGroupForUrl('https://api.upbit.com/v1/ticker?markets=KRW-BTC'), 'ticker');
  assert.equal(publicUpbitGroupForUrl('https://api.upbit.com/v1/market/all?isDetails=true'), 'market');
  assert.equal(publicUpbitGroupForUrl('https://api.bitget.com/api/v2/mix/market/tickers'), null);
  for (const url of [
    'https://api.upbit.com/v1/accounts',
    'https://api.upbit.com/v1/orders',
    'http://api.upbit.com/v1/orderbook',
    'https://user:password@api.upbit.com/v1/orderbook',
    'https://api.upbit.com/v1/orderbook#fragment',
  ]) assert.throws(() => publicUpbitGroupForUrl(url), /UNSAFE_ENDPOINT/u);
  assert.equal(PUBLIC_V3_UPBIT_GROUP_INTERVAL_MS.candle, 250);
  // 5 spot symbols × 2 candle requests = 10 group calls; 9 gaps × 250ms.
  assert.ok(9 * PUBLIC_V3_UPBIT_GROUP_INTERVAL_MS.candle < 3500);
  assert.ok(PUBLIC_V3_UPBIT_GROUP_INTERVAL_MS.orderbook >= 100);
});

test('Upbit V3 separate rate-group queues honor cooldown and cancellation', async () => {
  let at = 0;
  const starts = [];
  const pacer = createPublicUpbitGroupPacer({
    now: () => at,
    wait: async ms => { at += ms; },
  });
  await Promise.all(Array.from({ length: 10 }, () => pacer.schedule('candle', () => {
    starts.push(at);
  })));
  assert.deepEqual(starts, Array.from({ length: 10 }, (_, i) => i * 250));
  const before = at;
  await pacer.schedule('orderbook', () => assert.equal(at, before));
  pacer.cooldown('orderbook', 1000);
  await pacer.schedule('orderbook', () => assert.ok(at >= before + 1000));
  const aborted = new AbortController();
  aborted.abort(new Error('mock caller stopped'));
  let unwanted = 0;
  await assert.rejects(
    pacer.schedule('candle', () => { unwanted += 1; }, aborted.signal),
    /mock caller stopped/u,
  );
  assert.equal(unwanted, 0);
  assert.throws(() => pacer.cooldown('candle', Infinity), /COOLDOWN_INVALID/u);
  await assert.rejects(pacer.schedule('orders', () => {}), /GROUP_UNSUPPORTED/u);
});

test('Bitget V3 only paces explicit public contract market endpoints', () => {
  for (const endpoint of ['tickers','candles','contracts','query-position-lever']) {
    assert.equal(
      publicBitgetMarketEndpoint('https://api.bitget.com/api/v2/mix/market/' + endpoint + '?productType=USDT-FUTURES'),
      'public-market',
    );
  }
  assert.equal(publicBitgetMarketEndpoint('https://api.upbit.com/v1/ticker'), null);
  for (const uri of [
    'http://api.bitget.com/api/v2/mix/market/candles',
    'https://api.bitget.com/api/v2/mix/order/place-order',
    'https://api.bitget.com/api/v2/mix/account/accounts',
    'https://user:secret@api.bitget.com/api/v2/mix/market/candles',
    'https://api.bitget.com/api/v2/mix/market/candles#frag',
  ]) assert.throws(() => publicBitgetMarketEndpoint(uri), /UNSAFE_ENDPOINT/u);
  assert.equal(PUBLIC_V3_BITGET_MARKET_INTERVAL_MS, 100);
});

test('Bitget V3 public candle batches keep starts under 10/sec; aborted callers never send', async () => {
  let at = 0;
  const times = [];
  const pacer = createPublicBitgetMarketPacer({
    now: () => at,
    wait: async ms => { at += ms; },
  });
  await Promise.all(Array.from({length: 10}, () => pacer.schedule(() => {
    times.push(at);
  })));
  assert.deepEqual(times, Array.from({length:10},(_,i)=>i*100));
  const before = at;
  pacer.cooldown(2000);
  await pacer.schedule(() => assert.ok(at >= before+2000));
  const aborted = new AbortController();
  aborted.abort(new Error('futures public scan stopped'));
  let sent = 0;
  await assert.rejects(pacer.schedule(() => { sent += 1; }, aborted.signal), /scan stopped/u);
  assert.equal(sent,0);
  assert.throws(() => pacer.cooldown(Infinity), /COOLDOWN_INVALID/u);
});
