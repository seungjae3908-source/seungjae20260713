import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getKiwoomChartCandlesMeta,
  resolveKiwoomRawTargetCandles,
} from './kiwoom-chart';
import {
  clearKiwoomTokenCache,
  getKiwoomToken,
  kiwoomRequest,
} from './providers/kiwoom';
import MarketDataService, {
  APP_KR_INTRADAY_DEADLINE_MS,
  resolveKrInteractiveMaxPages,
} from './services/market-data.service';

const KIWOOM_TEST_ENV_KEYS = [
  'KIWOOM_MODE',
  'KIWOOM_APP_KEY',
  'KIWOOM_APP_SECRET',
  'KIWOOM_PROXY_KEY',
] as const;

function jsonResponse(
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function chartRows(count: number, offset = 0): Array<Record<string, string>> {
  return Array.from({ length: count }, (_, index) => ({
    dt: '20260818',
    cntr_tm: String(90_000 + offset + index).padStart(6, '0'),
    cur_prc: '1000',
    open_pric: '1000',
    high_pric: '1010',
    low_pric: '990',
    trde_qty: '100',
  }));
}

function yahooChartPayload(count = 6): Record<string, unknown> {
  const base = Date.parse('2026-08-18T00:00:00.000Z') / 1000;
  const timestamp = Array.from({ length: count }, (_, index) => base + index * 60);
  const values = Array.from({ length: count }, (_, index) => 100 + index);
  return {
    chart: {
      result: [{
        timestamp,
        indicators: {
          quote: [{
            open: values,
            high: values.map((value) => value + 1),
            low: values.map((value) => value - 1),
            close: values,
            volume: values.map(() => 1000),
          }],
        },
      }],
    },
  };
}

async function withMockKiwoom<T>(
  mockFetch: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalEnv = new Map<string, string | undefined>(
    KIWOOM_TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  process.env.KIWOOM_MODE = 'mock';
  process.env.KIWOOM_APP_KEY = 'test-app-key';
  process.env.KIWOOM_APP_SECRET = 'test-app-secret';
  delete process.env.KIWOOM_PROXY_KEY;
  globalThis.fetch = mockFetch;
  clearKiwoomTokenCache();

  try {
    return await run();
  } finally {
    clearKiwoomTokenCache();
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function mockTokenOrChartFetch(
  chartHandler: (url: string) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.endsWith('/oauth2/token')) {
      return jsonResponse({
        return_code: 0,
        return_msg: 'OK',
        token: 'test-token',
      });
    }

    if (url.endsWith('/api/dostk/chart')) {
      return chartHandler(url);
    }

    throw new Error(`unexpected Kiwoom test URL: ${url}`);
  }) as typeof fetch;
}

test('Kiwoom deep-history remains unbounded when no visible-window limit is requested', () => {
  assert.equal(resolveKiwoomRawTargetCandles(undefined, 1), undefined);
  assert.equal(resolveKiwoomRawTargetCandles(0, 1), undefined);
  assert.equal(resolveKiwoomRawTargetCandles(Number.NaN, 1), undefined);
});

test('KR visible-window limit bounds raw Kiwoom continuation work', () => {
  assert.equal(resolveKiwoomRawTargetCandles(300, 1), 300);
  assert.equal(resolveKiwoomRawTargetCandles(300, 4), 1_200);
});

test('visible-window target is normalized without weakening minimum candle evidence', () => {
  assert.equal(resolveKiwoomRawTargetCandles(1, 1), 2);
  assert.equal(resolveKiwoomRawTargetCandles(300.9, 1), 300);
});

test('KR interactive page budgets are deterministic by interval', () => {
  assert.equal(resolveKrInteractiveMaxPages('1m'), 6);
  assert.equal(resolveKrInteractiveMaxPages('3m'), 6);
  assert.equal(resolveKrInteractiveMaxPages('5m'), 8);
  assert.equal(resolveKrInteractiveMaxPages('15m'), 8);
  assert.equal(resolveKrInteractiveMaxPages('30m'), 8);
  assert.equal(resolveKrInteractiveMaxPages('60m'), 10);
  assert.equal(resolveKrInteractiveMaxPages('4H'), 12);
  assert.equal(resolveKrInteractiveMaxPages('1D'), 4);
});

test('KR interactive provider deadline remains below the browser primary endpoint budget', () => {
  assert.ok(APP_KR_INTRADAY_DEADLINE_MS > 0);
  assert.ok(APP_KR_INTRADAY_DEADLINE_MS < 2_500);
});

test('caller abort reaches Kiwoom token acquisition before credentials or network work', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    getKiwoomToken(controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      assert.match(error.message, /호출자에 의해 취소/);
      return true;
    },
  );
});

test('caller abort reaches Kiwoom request queue/transport contract before provider work', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    kiwoomRequest({
      apiId: 'ka10080',
      path: '/api/dostk/chart',
      body: { stk_cd: '005930', tic_scope: '1' },
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      assert.match(error.message, /호출자에 의해 취소/);
      return true;
    },
  );
});

test('expired interactive deadline fails closed before Kiwoom network work', async () => {
  let fetchCalls = 0;
  const mockFetch = (async () => {
    fetchCalls += 1;
    throw new Error('network must not start after deadline');
  }) as typeof fetch;

  await withMockKiwoom(mockFetch, async () => {
    await assert.rejects(
      getKiwoomChartCandlesMeta('005930', '1m', 300, {
        deadlineAt: Date.now() - 1,
        maxPages: 6,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /stopReason=DEADLINE_REACHED/);
        return true;
      },
    );
  });

  assert.equal(fetchCalls, 0);
});

test('mid-collection caller abort returns truthful partial evidence', async () => {
  const controller = new AbortController();
  let chartCalls = 0;
  const mockFetch = mockTokenOrChartFetch(() => {
    chartCalls += 1;
    controller.abort();
    return jsonResponse(
      { return_code: 0, rows: chartRows(3) },
      { 'cont-yn': 'Y', 'next-key': 'page-2' },
    );
  });

  await withMockKiwoom(mockFetch, async () => {
    const result = await getKiwoomChartCandlesMeta('005930', '1m', 300, {
      signal: controller.signal,
      maxPages: 6,
    });

    assert.equal(result.completeness, 'partial');
    assert.equal(result.stopReason, 'ABORTED');
    assert.equal(result.pagesFetched, 1);
    assert.equal(result.targetCandles, 300);
    assert.equal(result.candles.length, 3);
  });

  assert.equal(chartCalls, 1);
});

test('page budget exhaustion returns partial provenance instead of complete history', async () => {
  const mockFetch = mockTokenOrChartFetch(() => jsonResponse(
    { return_code: 0, rows: chartRows(3) },
    { 'cont-yn': 'Y', 'next-key': 'page-2' },
  ));

  await withMockKiwoom(mockFetch, async () => {
    const result = await getKiwoomChartCandlesMeta('005930', '3m', 300, {
      maxPages: 1,
    });

    assert.equal(result.completeness, 'partial');
    assert.equal(result.stopReason, 'PAGE_BUDGET_REACHED');
    assert.equal(result.pagesFetched, 1);
    assert.equal(result.targetCandles, 300);
    assert.equal(result.candles.length, 3);
  });
});

test('app-facing KR 1m/3m/1D routes use the bounded Kiwoom evidence contract', async () => {
  let chartCalls = 0;
  const mockFetch = mockTokenOrChartFetch(() => {
    chartCalls += 1;
    return jsonResponse({
      return_code: 0,
      rows: chartRows(300, chartCalls * 1_000),
    });
  });

  await withMockKiwoom(mockFetch, async () => {
    for (const timeframe of ['1m', '3m', '1D'] as const) {
      const result = await MarketDataService.getCandlesMeta('005930', timeframe);
      assert.equal(result.provider, 'kiwoom');
      assert.equal(result.candles.length, 300);
      assert.deepEqual(result.evidence, {
        completeness: 'complete',
        reason: 'TARGET_REACHED',
        pagesFetched: 1,
        targetCandles: 300,
      });
    }
  });

  assert.equal(chartCalls, 3);
});

test('KR interactive insufficient Kiwoom evidence never re-enters deep Kiwoom history', async () => {
  let chartCalls = 0;
  const mockFetch = mockTokenOrChartFetch(() => {
    chartCalls += 1;
    return jsonResponse({ return_code: 0, rows: chartRows(1) });
  });

  await withMockKiwoom(mockFetch, async () => {
    const result = await MarketDataService.getCandlesMeta('005930', '1m');
    assert.equal(result.provider, 'none');
    assert.equal(result.candles.length, 0);
    assert.equal(result.fallbackFrom?.provider, 'kiwoom');
    assert.match(String(result.fallbackFrom?.reason), /INSUFFICIENT_CANDLES/);
  });

  assert.equal(chartCalls, 1);
});

test('KR 1D insufficient Kiwoom evidence never re-enters deep Kiwoom history', async () => {
  let chartCalls = 0;
  const mockFetch = mockTokenOrChartFetch(() => {
    chartCalls += 1;
    return jsonResponse({ return_code: 0, rows: chartRows(1) });
  });

  await withMockKiwoom(mockFetch, async () => {
    const result = await MarketDataService.getCandlesMeta('005930', '1D');
    assert.equal(result.provider, 'none');
    assert.equal(result.candles.length, 0);
    assert.equal(result.fallbackFrom?.provider, 'kiwoom');
    assert.match(String(result.fallbackFrom?.reason), /INSUFFICIENT_CANDLES/);
  });

  assert.equal(chartCalls, 1);
});

test('KR interactive public Yahoo hedge can satisfy the chart without a second Kiwoom pass', async () => {
  let chartCalls = 0;
  let yahooCalls = 0;
  const mockFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.endsWith('/oauth2/token')) {
      return jsonResponse({ return_code: 0, return_msg: 'OK', token: 'test-token' });
    }
    if (url.endsWith('/api/dostk/chart')) {
      chartCalls += 1;
      return jsonResponse({ return_code: 0, rows: chartRows(1) });
    }
    if (/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\/005930\.KS/.test(url)) {
      yahooCalls += 1;
      return jsonResponse(yahooChartPayload());
    }
    throw new Error(`unexpected chart fallback URL: ${url}`);
  }) as typeof fetch;

  // Kiwoom mock requests are paced by a module-global 260ms minimum interval.
  // A preceding test can legitimately leave that throttle active, allowing the
  // 100ms Yahoo hedge to win before the first Kiwoom fetch starts. Wait past the
  // pacing window so this regression deterministically exercises exactly one
  // insufficient Kiwoom pass followed by the public Yahoo hedge, while still
  // proving that no second/deep Kiwoom pass occurs.
  await new Promise((resolve) => setTimeout(resolve, 320));

  await withMockKiwoom(mockFetch, async () => {
    const result = await MarketDataService.getCandlesMeta('005930', '1m');
    assert.equal(result.provider, 'yahoo');
    assert.ok(result.candles.length >= 2);
    assert.equal(result.fallbackFrom?.provider, 'kiwoom');
  });

  assert.equal(chartCalls, 1);
  assert.ok(yahooCalls >= 1);
});

test('KR 1D public Yahoo hedge can satisfy the chart without a second Kiwoom pass', async () => {
  let chartCalls = 0;
  let yahooCalls = 0;
  const mockFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.endsWith('/oauth2/token')) {
      return jsonResponse({ return_code: 0, return_msg: 'OK', token: 'test-token' });
    }
    if (url.endsWith('/api/dostk/chart')) {
      chartCalls += 1;
      return jsonResponse({ return_code: 0, rows: chartRows(1) });
    }
    if (/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\/005930\.KS/.test(url)) {
      yahooCalls += 1;
      return jsonResponse(yahooChartPayload(40));
    }
    throw new Error(`unexpected chart fallback URL: ${url}`);
  }) as typeof fetch;

  await new Promise((resolve) => setTimeout(resolve, 320));

  await withMockKiwoom(mockFetch, async () => {
    const result = await MarketDataService.getCandlesMeta('005930', '1D');
    assert.equal(result.provider, 'yahoo');
    assert.ok(result.candles.length >= 30);
    assert.equal(result.fallbackFrom?.provider, 'kiwoom');
  });

  assert.equal(chartCalls, 1);
  assert.ok(yahooCalls >= 1);
});

test('KR 1D whole provider hedge terminates at the existing interactive deadline', async () => {
  let chartCalls = 0;
  let yahooCalls = 0;
  const neverSettles = new Promise<Response>(() => {});
  const mockFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.endsWith('/oauth2/token')) {
      return jsonResponse({ return_code: 0, return_msg: 'OK', token: 'test-token' });
    }
    if (url.endsWith('/api/dostk/chart')) {
      chartCalls += 1;
      return jsonResponse({ return_code: 0, rows: chartRows(1) });
    }
    if (/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\/005930\.KS/.test(url)) {
      yahooCalls += 1;
      return neverSettles;
    }
    throw new Error(`unexpected chart hard-deadline URL: ${url}`);
  }) as typeof fetch;

  await new Promise((resolve) => setTimeout(resolve, 320));

  await withMockKiwoom(mockFetch, async () => {
    const startedAt = Date.now();
    const result = await MarketDataService.getCandlesMeta('005930', '1D');
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.provider, 'none');
    assert.equal(result.candles.length, 0);
    assert.equal(result.fallbackFrom?.provider, 'kiwoom');
    assert.equal(result.fallbackFrom?.reason, 'DEADLINE_REACHED');
    assert.ok(elapsedMs < APP_KR_INTRADAY_DEADLINE_MS + 750);
  });

  assert.equal(chartCalls, 1);
  assert.ok(yahooCalls >= 1);
});

test('interactive fallback classification keeps deadline/abort/upstream timeout distinct', async () => {
  const { readFile } = await import('node:fs/promises');
  const cwd = process.cwd();
  const sourcePath = cwd.endsWith('/api-server') || cwd.endsWith('\\api-server')
    ? `${cwd}/src/services/market-data.service.ts`
    : `${cwd}/api-server/src/services/market-data.service.ts`;
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /if \(deadlineReached\) return 'DEADLINE_REACHED'/);
  assert.match(source, /error\.name === 'AbortError'\) return 'ABORTED'/);
  assert.match(source, /시간이 초과되었습니다.*UPSTREAM_TIMEOUT/s);
  assert.match(source, /fallbackFrom:[\s\S]*provider: 'kiwoom'/);
  assert.doesNotMatch(source, /fallbackFrom:[\s\S]*reason:\s*'0'/);
  assert.match(
    source,
    /if \(isBoundedKrInteractiveRequest\(ticker, timeframe\)\) \{\s*return getBoundedKrInteractiveCandlesMeta\(ticker, timeframe\);\s*\}/,
  );
  assert.match(source, /KR_INTERACTIVE_TIMEFRAMES[\s\S]*'1D'/);
  assert.match(source, /Promise\.race\(\[\s*Promise\.any\(\[kiwoomAttempt, yahooAttempt\]\),\s*terminalDeadline,\s*\]\)/);
});
