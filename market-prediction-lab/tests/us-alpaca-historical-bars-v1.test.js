import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { collectAlpacaHistoricalBarsV1 as collect } from "../src/us-alpaca-historical-bars-v1.js";

const KEY = "fixture-alpaca-key";
const SECRET = "fixture-alpaca-secret";
const NOW = Date.parse("2026-10-11T08:00:00Z");
const START = "2020-01-02T14:00:00Z";
const END = "2020-01-02T14:02:00Z";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const at = minute => "2020-01-02T14:" + String(minute).padStart(2, "0") + ":00Z";
const bar = (minute = 0, changes = {}) => ({
  t: at(minute), o: 100, h: 103, l: 99, c: 101, v: 200, n: 10, vw: 100.5,
  ...changes,
});
const page = (bars, next = null) => ({ bars, next_page_token: next });
const response = value => new Response(JSON.stringify(value), {
  status: 200, headers: { "content-type": "application/json" },
});
function options(extra = {}) {
  return {
    symbols: ["AAPL"], startTime: START, endTime: END,
    apiKey: KEY, apiSecret: SECRET, allowHistoricalDataRead: true,
    nowImpl: () => NOW, ...extra,
  };
}
function mockPages(...pages) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      assert.ok(calls.length <= pages.length, "unexpected extra provider request");
      const value = pages[calls.length - 1];
      return typeof value === "function" ? value() : response(value);
    },
  };
}
function proofRemainsBlocked(result) {
  for (const field of ["historicalUniverseComplete", "sourceArchiveCompletenessProven",
    "permanentShareClassIdentityVerified", "corporateActionsVerified",
    "profitabilityProven", "paperAdmissionAllowed", "sourceRedistributionAllowed"]) {
    assert.equal(result[field], false, field);
  }
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.sourceLimited, true);
  assert.equal(result.trueMarketWideRecall, null);
  assert.equal(result.netProfitPct, null);
  assert.equal(result.OOSPassCount, 0);
}

test("default is blocked without opt-in or explicit credentials and performs no GET", async () => {
  const noFetch = async () => assert.fail("must not call any provider");
  const cases = [
    [{ fetchImpl: noFetch }, "EXPLICIT_HISTORICAL_DATA_READ_OPT_IN_REQUIRED"],
    [options({ allowHistoricalDataRead: false, fetchImpl: noFetch }),
      "EXPLICIT_HISTORICAL_DATA_READ_OPT_IN_REQUIRED"],
    [options({ apiKey: null, fetchImpl: noFetch }), "ALPACA_DEDICATED_DATA_CREDENTIALS_REQUIRED"],
    [options({ apiSecret: null, fetchImpl: noFetch }), "ALPACA_DEDICATED_DATA_CREDENTIALS_REQUIRED"],
    [options({ apiKey: "key\nheader", fetchImpl: noFetch }), "ALPACA_DEDICATED_DATA_CREDENTIALS_REQUIRED"],
  ];
  for (const [args, reason] of cases) {
    const result = await collect(args);
    assert.equal(result.status, "BLOCKED_DATA");
    assert.equal(result.reason, reason);
    assert.equal(result.providerReadOnlyGETs, 0);
    assert.equal(result.count, null);
    assert.equal(result.actualInterval, null);
    proofRemainsBlocked(result);
  }
});

test("ambient credentials cannot authorize a historical read", async () => {
  const envNames = ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY", "ALPACA_API_KEY", "ALPACA_API_SECRET"];
  const old = envNames.map(name => [name, process.env[name]]);
  try {
    for (const name of envNames) process.env[name] = "fixture-ambient-only";
    const result = await collect(options({
      apiKey: null, apiSecret: null, fetchImpl: async () => assert.fail("no ambient key lookup"),
    }));
    assert.equal(result.reason, "ALPACA_DEDICATED_DATA_CREDENTIALS_REQUIRED");
    assert.equal(result.providerReadOnlyGETs, 0);
  } finally {
    for (const [name, value] of old) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("follows symbol-starved pages, preserves the supplied cohort and never promotes PIT", async () => {
  const mock = mockPages(page({ AAPL: [bar(0), bar(1)] }, "cursor-one"),
    page({ MSFT: [bar(2, { c: 102 })] }));
  const result = await collect(options({ symbols: ["MSFT", "AAPL"], fetchImpl: mock.fetchImpl }));
  assert.equal(result.status, "SOURCE_LIMITED_HISTORICAL_BARS_COLLECTED_ONLY");
  assert.deepEqual(result.symbols, ["MSFT", "AAPL"]);
  assert.equal(result.count, 3);
  assert.equal(result.barsBySymbol.AAPL.length, 2);
  assert.equal(result.barsBySymbol.MSFT.length, 1);
  assert.equal(result.pageCount, 2);
  assert.equal(result.providerReadOnlyGETs, 2);
  assert.equal(result.paginationComplete, true);
  assert.deepEqual(result.missingRequestedSymbols, []);
  assert.equal(result.actualInterval.firstBarStartTimeMs, Date.parse(START));
  assert.equal(result.actualInterval.lastBarStartTimeMs, Date.parse(END));
  assert.equal(result.actualInterval.lastBarEndTimeMs, Date.parse(END) + 60_000);
  assert.equal(mock.calls[1].url.searchParams.get("page_token"), "cursor-one");
  proofRemainsBlocked(result);
});

test("uses only the fixed GET endpoint with explicit raw SIP and original-symbol mapping", async () => {
  const mock = mockPages(page({ AAPL: [bar(0)] }));
  await collect(options({ fetchImpl: mock.fetchImpl }));
  const { url, init } = mock.calls[0];
  assert.equal(url.origin, "https://data.alpaca.markets");
  assert.equal(url.pathname, "/v2/stocks/bars");
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.equal(init.body, undefined);
  assert.equal(init.headers["APCA-API-KEY-ID"], KEY);
  assert.equal(init.headers["APCA-API-SECRET-KEY"], SECRET);
  for (const [key, value] of Object.entries({
    feed: "sip", adjustment: "raw", asof: "-", sort: "asc",
    timeframe: "1Min", limit: "10000", currency: "USD", symbols: "AAPL",
  })) assert.equal(url.searchParams.get(key), value, key);
  assert.equal(url.searchParams.get("start"), new Date(START).toISOString());
  assert.equal(url.searchParams.get("end"), new Date(END).toISOString());
  assert.ok(!url.toString().includes(KEY));
  assert.ok(!url.toString().includes(SECRET));
});

test("keeps an exact raw-page digest and untouched raw rows separately from canonical rows", async () => {
  const raw = bar(0, { t: "2020-01-02T14:00:00.000000000Z" });
  const rawText = " \n" + JSON.stringify(page({ AAPL: [raw] }), null, 2) + "\n";
  const result = await collect(options({ fetchImpl: async () => new Response(rawText) }));
  assert.deepEqual(result.rawRowsBySymbol.AAPL, [raw]);
  assert.equal(result.rawRowsBySymbol.AAPL[0].t, raw.t);
  assert.equal(result.barsBySymbol.AAPL[0].timestamp, Date.parse(START));
  assert.equal(result.barsBySymbol.AAPL[0].open, raw.o);
  assert.equal(result.rawPages[0].rawPageSha256,
    createHash("sha256").update(rawText).digest("hex"));
  assert.equal(result.rawPages[0].rawPageByteLength, Buffer.byteLength(rawText));
  assert.ok(Object.isFrozen(result.rawRowsBySymbol.AAPL[0]));
  assert.ok(Object.isFrozen(result.barsBySymbol.AAPL));
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(result.rawPages[0].rawText, undefined);
});

test("end is an inclusive bar-start boundary, including exactly 15 minutes ago", async () => {
  const end = NOW - 15 * 60_000;
  const mock = mockPages(page({ AAPL: [bar(0, { t: new Date(end).toISOString() })] }));
  const result = await collect(options({
    startTime: end - 60_000, endTime: end, fetchImpl: mock.fetchImpl,
  }));
  assert.equal(result.count, 1);
  assert.equal(result.requestedInterval.startInclusive, true);
  assert.equal(result.requestedInterval.endInclusive, true);
  assert.equal(mock.calls[0].url.searchParams.get("end"), new Date(end).toISOString());
  const blocked = await collect(options({
    startTime: end - 60_000, endTime: end + 1,
    fetchImpl: async () => assert.fail("too-recent end must be blocked before GET"),
  }));
  assert.equal(blocked.reason, "ALPACA_FREE_SIP_END_NOT_15_MINUTES_OLD");
  assert.equal(blocked.providerReadOnlyGETs, 0);
});

test("31 inclusive UTC calendar days is a task bound, without a three-year history cap", async () => {
  const mock = mockPages(page({ AAPL: [bar(0, { t: "2016-01-04T14:00:00Z" })] }));
  const result = await collect(options({
    startTime: "2016-01-01", endTime: "2016-01-31T23:59:59.999Z", fetchImpl: mock.fetchImpl,
  }));
  assert.equal(result.count, 1);
  assert.equal(result.requestedInterval.inclusiveUtcCalendarDays, 31);
  const blocked = await collect(options({
    startTime: "2016-01-01", endTime: "2016-02-01",
    fetchImpl: async () => assert.fail("oversized task must not read"),
  }));
  assert.equal(blocked.reason, "ALPACA_TASK_EXCEEDS_31_UTC_CALENDAR_DAYS");
  assert.equal(blocked.providerReadOnlyGETs, 0);
});

test("strict input dates and bounded cohort/page arguments fail before any GET", async () => {
  const fetchImpl = async () => assert.fail("invalid input must not read");
  for (const changes of [
    { startTime: "2026-02-30" }, { startTime: "2026-01-02T14:00:00" },
    { startTime: "2026-01-02T14:00:00+24:00" }, { startTime: NaN },
    { endTime: Infinity }, { endTime: START }, { startTime: END, endTime: START },
    { timeframe: "5Min" }, { maxPages: 0 }, { maxPages: 33 }, { maxPages: 2.5 },
    { symbols: [] }, { symbols: ["AAPL", "AAPL"] }, { symbols: ["AAPL,MSFT"] },
    { symbols: [" AAPL"] }, { symbols: Array.from({ length: 21 }, (_, i) => "TEST" + i) },
  ]) await assert.rejects(collect(options({ ...changes, fetchImpl })), TypeError);
});

test("unknown returned ticker blocks the entire unvalidated page", async () => {
  const result = await collect(options({
    fetchImpl: mockPages(page({ AAPL: [bar(0)], MSFT: [bar(1)] })).fetchImpl,
  }));
  assert.equal(result.reason, "ALPACA_UNREQUESTED_SYMBOL_RETURNED");
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.count, null);
  assert.equal(result.retainedBarCount, 0);
  assert.equal(result.rawPages.length, 1);
  assert.equal(result.paginationComplete, false);
});

test("valid identical duplicates retain raw evidence but conflicts block", async () => {
  const same = mockPages(page({ AAPL: [bar(0)] }, "cursor-two"),
    page({ AAPL: [bar(0), bar(1)] }));
  const result = await collect(options({ fetchImpl: same.fetchImpl }));
  assert.equal(result.count, 2);
  assert.equal(result.rawRowCount, 3);
  assert.equal(result.duplicateRowCount, 1);
  assert.equal(result.rawRowsBySymbol.AAPL.length, 3);
  const conflict = mockPages(page({ AAPL: [bar(0)] }, "cursor-two"),
    page({ AAPL: [bar(0, { c: 102 })] }));
  const rejected = await collect(options({ fetchImpl: conflict.fetchImpl }));
  assert.equal(rejected.reason, "ALPACA_DUPLICATE_BAR_CONFLICT");
  assert.equal(rejected.count, null);
  assert.equal(rejected.retainedBarCount, 1);
  assert.equal(rejected.rawRowsBySymbol.AAPL.length, 1);
  assert.equal(rejected.paginationComplete, false);
});

test("token loops and page-budget exhaustion cannot certify partial data", async () => {
  const loop = mockPages(page({ AAPL: [bar(0)] }, "same-cursor"),
    page({ AAPL: [bar(1)] }, "same-cursor"));
  const result = await collect(options({ fetchImpl: loop.fetchImpl }));
  assert.equal(result.reason, "ALPACA_PAGINATION_TOKEN_LOOP");
  assert.equal(result.providerReadOnlyGETs, 2);
  assert.equal(result.count, null);
  assert.equal(result.retainedBarCount, 2);
  assert.equal(result.paginationComplete, false);
  const limited = mockPages(page({ AAPL: [bar(0)] }, "more-pages"));
  const incomplete = await collect(options({
    symbols: ["AAPL", "MSFT"], maxPages: 1, fetchImpl: limited.fetchImpl,
  }));
  assert.equal(incomplete.reason, "ALPACA_MAX_PAGES_REACHED");
  assert.equal(incomplete.providerReadOnlyGETs, 1);
  assert.equal(incomplete.count, null);
  assert.deepEqual(incomplete.missingRequestedSymbols, ["MSFT"]);
});

test("missing or invalid cursors never mean completed pagination", async () => {
  for (const [value, expected] of [
    [{ bars: { AAPL: [bar()] } }, "ALPACA_PAGINATION_TOKEN_MISSING"],
    [page({ AAPL: [bar()] }, ""), "ALPACA_PAGINATION_TOKEN_INVALID"],
    [page({ AAPL: [bar()] }, 1), "ALPACA_PAGINATION_TOKEN_INVALID"],
    [page({ AAPL: [bar()] }, "cursor\nnext"), "ALPACA_PAGINATION_TOKEN_INVALID"],
    [page({ AAPL: [bar()] }, SECRET), "ALPACA_PAGINATION_TOKEN_INVALID"],
  ]) {
    const result = await collect(options({ fetchImpl: mockPages(value).fetchImpl }));
    assert.equal(result.reason, expected);
    assert.equal(result.paginationComplete, false);
    assert.equal(result.count, null);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test("empty data and missing requested names are unknown rather than successful zero results", async () => {
  const empty = await collect(options({ fetchImpl: mockPages(page({})).fetchImpl }));
  assert.equal(empty.reason, "ALPACA_NO_BARS_RETURNED");
  assert.equal(empty.paginationComplete, true);
  assert.equal(empty.count, null);
  assert.equal(empty.actualInterval, null);
  const partial = await collect(options({
    symbols: ["AAPL", "MSFT"],
    fetchImpl: mockPages(page({ AAPL: [bar()], MSFT: [] })).fetchImpl,
  }));
  assert.equal(partial.reason, "ALPACA_REQUESTED_SYMBOL_DATA_MISSING");
  assert.equal(partial.count, null);
  assert.equal(partial.retainedBarCount, 1);
  assert.deepEqual(partial.missingRequestedSymbols, ["MSFT"]);
  proofRemainsBlocked(partial);
});

test("empty intermediate pages can continue to a populated final page", async () => {
  const result = await collect(options({
    fetchImpl: mockPages(page({}, "next"), page({ AAPL: [bar()] })).fetchImpl,
  }));
  assert.equal(result.count, 1);
  assert.equal(result.pageCount, 2);
  assert.equal(result.paginationComplete, true);
});

test("malformed OHLCV and unexpected bar fields are rejected without repairs or raw leaks", async () => {
  for (const change of [
    { h: 100 }, { l: 102 }, { o: -100 }, { c: 0 }, { v: -1 }, { v: "200" },
    { n: 1.5 }, { vw: 0 }, { h: null }, { debug: SECRET },
  ]) {
    const result = await collect(options({
      fetchImpl: mockPages(page({ AAPL: [bar(0, change)] })).fetchImpl,
    }));
    assert.equal(result.status, "BLOCKED_DATA");
    assert.ok(["ALPACA_BAR_OHLCV_INVALID", "ALPACA_BAR_SCHEMA_INVALID"].includes(result.reason));
    assert.equal(result.retainedBarCount, 0);
    assert.equal(result.rawRowsBySymbol.AAPL.length, 0);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test("timestamps must be strict, aligned and inside the inclusive request", async () => {
  for (const timestamp of [
    "2020-01-02T14:00:30Z", "2020-01-02T14:00:00.000000001Z",
    "2020-02-30T14:00:00Z", "2020-01-02T13:59:00Z", "2020-01-02T14:03:00Z",
    Date.parse(START),
  ]) {
    const result = await collect(options({
      fetchImpl: mockPages(page({ AAPL: [bar(0, { t: timestamp })] })).fetchImpl,
    }));
    assert.equal(result.status, "BLOCKED_DATA");
    assert.ok(["ALPACA_BAR_TIMESTAMP_INVALID", "ALPACA_BAR_OUTSIDE_REQUEST"].includes(result.reason));
    assert.equal(result.retainedBarCount, 0);
  }
  const unordered = await collect(options({
    fetchImpl: mockPages(page({ AAPL: [bar(1), bar(0)] })).fetchImpl,
  }));
  assert.equal(unordered.reason, "ALPACA_BAR_ORDER_INVALID");
});

test("daily bars close at the next New York midnight across both DST transitions", async () => {
  for (const [start, end, expectedHours] of [
    ["2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 23],
    ["2025-11-02T04:00:00Z", "2025-11-03T05:00:00Z", 25],
  ]) {
    const result = await collect(options({
      timeframe: "1Day", startTime: start, endTime: end,
      fetchImpl: mockPages(page({ AAPL: [bar(0, { t: start })] })).fetchImpl,
    }));
    assert.equal(result.count, 1);
    const row = result.barsBySymbol.AAPL[0];
    assert.equal(row.barEndTimeMs, Date.parse(end));
    assert.equal(row.barEndTimeMs - row.timestamp, expectedHours * 3_600_000);
  }
});

test("UTC-midnight daily bars and current unclosed New York days are blocked", async () => {
  const wrong = await collect(options({
    timeframe: "1Day", startTime: "2026-10-09", endTime: "2026-10-10",
    fetchImpl: mockPages(page({ AAPL: [bar(0, { t: "2026-10-09T00:00:00Z" })] })).fetchImpl,
  }));
  assert.equal(wrong.reason, "ALPACA_DAILY_BAR_BOUNDARY_INVALID");
  const unclosed = await collect(options({
    timeframe: "1Day", startTime: "2026-10-11T04:00:00Z",
    endTime: "2026-10-11T07:45:00Z",
    fetchImpl: mockPages(page({ AAPL: [bar(0, { t: "2026-10-11T04:00:00Z" })] })).fetchImpl,
  }));
  assert.equal(unclosed.reason, "ALPACA_BAR_NOT_CLOSED");
  assert.equal(unclosed.retainedBarCount, 0);
});

test("HTTP 403 and 429 remain distinct and no error body or credential is exposed", async () => {
  for (const [status, reason] of [
    [403, "ALPACA_SIP_ENTITLEMENT_OR_AUTHORIZATION_DENIED"],
    [429, "ALPACA_RATE_LIMITED"], [401, "ALPACA_AUTHENTICATION_REJECTED"],
    [500, "ALPACA_SOURCE_UNAVAILABLE"], [302, "ALPACA_REDIRECT_REJECTED"],
  ]) {
    const result = await collect(options({
      fetchImpl: async () => ({
        status, statusText: SECRET, text: async () => assert.fail("never read an error body"),
      }),
    }));
    assert.equal(result.reason, reason);
    assert.equal(result.httpStatus, status);
    assert.equal(result.providerReadOnlyGETs, 1);
    assert.equal(result.count, null);
    assert.equal(result.pageCount, 0);
    assert.ok(!JSON.stringify(result).includes(SECRET));
    proofRemainsBlocked(result);
  }
});

test("later-page HTTP failure preserves earlier evidence without returning success or zero", async () => {
  const mock = mockPages(page({ AAPL: [bar()] }, "second-page"), () => ({
    status: 429, text: async () => assert.fail("no error-body retention"),
  }));
  const result = await collect(options({ fetchImpl: mock.fetchImpl }));
  assert.equal(result.reason, "ALPACA_RATE_LIMITED");
  assert.equal(result.providerReadOnlyGETs, 2);
  assert.equal(result.pageCount, 1);
  assert.equal(result.retainedBarCount, 1);
  assert.equal(result.count, null);
  assert.equal(result.paginationComplete, false);
});

test("redirected responses and an unexpected response host are rejected", async () => {
  for (const envelope of [
    { status: 200, redirected: true },
    { status: 200, url: "https://untrusted.example/v2/stocks/bars" },
  ]) {
    const result = await collect(options({ fetchImpl: async () => ({
      ...envelope, text: async () => assert.fail("do not read a redirected response"),
    }) }));
    assert.equal(result.status, "BLOCKED_DATA");
    assert.equal(result.count, null);
  }
});

test("bad JSON and application-error envelopes cannot become an empty successful page", async () => {
  const invalid = await collect(options({ fetchImpl: async () => new Response("invalid-json") }));
  assert.equal(invalid.reason, "ALPACA_RESPONSE_JSON_INVALID");
  assert.equal(invalid.pageCount, 1);
  const failure = await collect(options({
    fetchImpl: mockPages({ code: 42210000, message: SECRET, bars: {}, next_page_token: null }).fetchImpl,
  }));
  assert.equal(failure.reason, "ALPACA_RESPONSE_BARS_INVALID");
  assert.ok(!JSON.stringify(failure).includes(SECRET));
});

test("provider pages obey a global row budget", async () => {
  const rows = Array.from({ length: 10_001 }, () => bar());
  const result = await collect(options({ fetchImpl: mockPages(page({ AAPL: rows })).fetchImpl }));
  assert.equal(result.reason, "ALPACA_PAGE_ROW_LIMIT_EXCEEDED");
  assert.equal(result.retainedBarCount, 0);
  assert.equal(result.providerReadOnlyGETs, 1);
});

test("known transport failures are normalized but programming errors still throw", async () => {
  const network = await collect(options({ fetchImpl: async () => { throw new TypeError("fetch failed"); } }));
  assert.equal(network.reason, "ALPACA_SOURCE_NETWORK_ERROR");
  assert.equal(network.providerReadOnlyGETs, 1);
  const timeout = await collect(options({ fetchImpl: async () => { throw new DOMException(SECRET, "TimeoutError"); } }));
  assert.equal(timeout.reason, "ALPACA_SOURCE_TIMEOUT");
  assert.ok(!JSON.stringify(timeout).includes(SECRET));
  const bug = new TypeError("unrelated parser programming failure");
  await assert.rejects(collect(options({ fetchImpl: async () => { throw bug; } })),
    error => error === bug);
  await assert.rejects(collect(options({ nowImpl: () => NaN })),
    /ALPACA_CAPTURE_CLOCK_INVALID/u);
});

test("oversized Content-Length cancels the body before reading any chunk", async () => {
  let reads = 0, cancelled = 0;
  const body = new ReadableStream({
    pull() { reads++; assert.fail("oversized declared body must not be read"); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  const result = await collect(options({ fetchImpl: async () => new Response(body, {
    headers: { "content-length": String(MAX_BODY_BYTES + 1) },
  }) }));
  assert.equal(result.reason, "ALPACA_RESPONSE_SIZE_LIMIT_EXCEEDED");
  assert.equal(reads, 0);
  assert.equal(cancelled, 1);
  assert.equal(result.pageCount, 0);
  assert.equal(result.rawPages.length, 0);
  assert.equal(result.count, null);
  assert.equal(result.providerReadOnlyGETs, 1);
});

test("chunked bodies cannot exceed 8 MiB even with a short declared length", async () => {
  for (const [chunks, headers] of [
    [[Buffer.alloc(MAX_BODY_BYTES - 1), Buffer.alloc(2)], { "content-length": "1" }],
    [[Buffer.alloc(MAX_BODY_BYTES + 1)], {}],
  ]) {
    let reads = 0, cancelled = 0;
    const body = new ReadableStream({
      pull(controller) {
        assert.ok(reads < chunks.length, "stop at the first oversized chunk");
        controller.enqueue(chunks[reads++]);
      },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    const result = await collect(options({
      fetchImpl: async () => new Response(body, { headers }),
    }));
    assert.equal(result.reason, "ALPACA_RESPONSE_SIZE_LIMIT_EXCEEDED");
    assert.equal(reads, chunks.length);
    assert.equal(cancelled, 1);
    assert.equal(result.count, null);
    assert.equal(result.pageCount, 0);
    assert.equal(result.rawPages.length, 0);
    assert.equal(result.paginationComplete, false);
  }
});

test("an exactly 8 MiB body is accepted without using an unbounded text reader", async () => {
  const payload = Buffer.from(JSON.stringify(page({ AAPL: [bar()] })));
  const bytes = Buffer.concat([payload, Buffer.alloc(MAX_BODY_BYTES - payload.length, 0x20)]);
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 65_536));
      offset += 65_536;
    },
  }, { highWaterMark: 0 });
  const reply = new Response(body, { headers: { "content-length": String(bytes.length) } });
  reply.text = () => assert.fail("never buffer through Response.text");
  const result = await collect(options({ fetchImpl: async () => reply }));
  assert.equal(result.count, 1);
  assert.equal(result.rawPages[0].rawPageByteLength, MAX_BODY_BYTES);
  assert.equal(result.rawPages[0].rawPageSha256,
    createHash("sha256").update(bytes).digest("hex"));
  proofRemainsBlocked(result);
});

test("the raw digest includes original BOM bytes and survives split multibyte characters", async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify({ ...page({ AAPL: [bar()] }), note: "한" }))]);
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, ++offset));
    },
  }, { highWaterMark: 0 });
  const result = await collect(options({ fetchImpl: async () => new Response(body) }));
  assert.equal(result.count, 1);
  assert.equal(result.rawPages[0].rawPageSha256,
    createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.rawPages[0].rawPageByteLength, bytes.length);
  assert.notEqual(result.rawPages[0].rawPageSha256,
    createHash("sha256").update(new TextDecoder().decode(bytes)).digest("hex"));
});

test("invalid UTF-8 in otherwise valid JSON cannot be repaired into successful data", async () => {
  const [prefix, suffix] = JSON.stringify({ ...page({ AAPL: [bar()] }),
    note: SECRET + "MARKER" }).split("MARKER");
  for (const invalid of [[0xff], [0xc0, 0xaf], [0xea, 0xb0]]) {
    const bytes = Buffer.concat([Buffer.from(prefix), Buffer.from(invalid), Buffer.from(suffix)]);
    const result = await collect(options({ fetchImpl: async () => new Response(bytes) }));
    assert.equal(result.reason, "ALPACA_RESPONSE_ENCODING_INVALID");
    assert.equal(result.count, null);
    assert.equal(result.pageCount, 1);
    assert.equal(result.retainedBarCount, 0);
    assert.equal(result.rawRowsBySymbol.AAPL.length, 0);
    assert.equal(result.rawPages[0].rawPageSha256,
      createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.rawPages[0].rawPageByteLength, bytes.length);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test("successful envelopes require a byte stream and never fall back to text-only doubles", async () => {
  for (const reply of [{ status: 200, text: () => assert.fail("no text fallback") },
    new Response(null)]) {
    const result = await collect(options({ fetchImpl: async () => reply }));
    assert.equal(result.reason, "ALPACA_RESPONSE_BODY_STREAM_REQUIRED");
    assert.equal(result.count, null);
    assert.equal(result.rawPages.length, 0);
  }
  const body = new Response(JSON.stringify(page({ AAPL: [bar()] }))).body;
  const boundedDouble = await collect(options({ fetchImpl: async () => ({ status: 200, body }) }));
  assert.equal(boundedDouble.count, 1);
});

test("non-byte chunks and known body transport errors block, while body programming errors throw", async () => {
  let cancelled = 0;
  const invalid = new ReadableStream({
    start(controller) { controller.enqueue(SECRET); },
    cancel() { cancelled++; },
  });
  const rejected = await collect(options({ fetchImpl: async () => new Response(invalid) }));
  assert.equal(rejected.reason, "ALPACA_RESPONSE_BODY_CHUNK_INVALID");
  assert.equal(cancelled, 1);
  assert.ok(!JSON.stringify(rejected).includes(SECRET));
  const network = Object.assign(new Error(SECRET), { code: "ECONNRESET" });
  const failedBody = error => new Response(new ReadableStream({
    start(controller) { controller.error(error); },
  }));
  const expected = await collect(options({ fetchImpl: async () => failedBody(network) }));
  assert.equal(expected.reason, "ALPACA_SOURCE_NETWORK_ERROR");
  assert.ok(!JSON.stringify(expected).includes(SECRET));
  const bug = new TypeError("body adapter implementation bug");
  await assert.rejects(collect(options({ fetchImpl: async () => failedBody(bug) })),
    error => error === bug);
});

test("the same fetch deadline cancels a stalled body and bounds stalled cancellation", async () => {
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let timer, reads = 0, cancelled = 0;
  AbortSignal.timeout = duration => {
    assert.equal(duration, 12_000);
    timer = setTimeout(() => controller.abort(new DOMException(SECRET, "TimeoutError")), 20);
    return controller.signal;
  };
  try {
    const body = new ReadableStream({
      pull() { reads++; return new Promise(() => {}); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    const result = await collect(options({ fetchImpl: async (url, init) => {
      assert.equal(init.signal, controller.signal);
      return new Response(body);
    } }));
    assert.equal(result.reason, "ALPACA_SOURCE_TIMEOUT");
    assert.equal(reads, 1);
    assert.equal(cancelled, 1);
    assert.equal(result.pageCount, 0);
    assert.equal(result.rawPages.length, 0);
    assert.equal(result.count, null);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  } finally {
    clearTimeout(timer);
    AbortSignal.timeout = originalTimeout;
  }
});

test("an already expired signal cancels the body without starting a read", async () => {
  const originalTimeout = AbortSignal.timeout;
  let cancelled = 0;
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException(SECRET, "TimeoutError"));
  try {
    const body = new ReadableStream({
      pull() { assert.fail("no body read after the page deadline"); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    const result = await collect(options({ fetchImpl: async () => new Response(body) }));
    assert.equal(result.reason, "ALPACA_SOURCE_TIMEOUT");
    assert.equal(cancelled, 1);
    assert.equal(result.count, null);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("malformed Content-Length is a source protocol failure before body reads", async () => {
  for (const length of ["-1", "not-a-number", "1.5"]) {
    let cancelled = 0;
    const body = new ReadableStream({
      pull() { assert.fail("invalid declared length must not be read"); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    const result = await collect(options({ fetchImpl: async () => new Response(body, {
      headers: { "content-length": length },
    }) }));
    assert.equal(result.reason, "ALPACA_RESPONSE_CONTENT_LENGTH_INVALID");
    assert.equal(cancelled, 1);
    assert.equal(result.count, null);
  }
});
