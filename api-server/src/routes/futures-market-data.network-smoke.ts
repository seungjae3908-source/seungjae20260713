import express from 'express';
import type { AddressInfo } from 'node:net';
import healthRouter from './health';
import futuresMarketDataRouter from './futures-market-data';
import stocksRouter from './stocks';
import cryptoRouter from './crypto';

function containsSensitiveText(value: unknown) {
  const text = JSON.stringify(value);
  return /(?:api[_-]?key|secret|authorization|bearer|private[_-]?key|stack)/i.test(text);
}

async function getJson(baseUrl: string, path: string, signal?: AbortSignal) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { parseError: true, text: text.slice(0, 200) };
  }
  return {
    path,
    httpStatus: response.status,
    contentType,
    body,
    sensitiveTextDetected: containsSensitiveText(body),
  };
}


/** Real upstream data through this checkout's four PUBLIC historical GET routes.
 * Diagnostic evidence only: outages/retention gaps stay INCOMPLETE and do not
 * silently become successful historical-coverage claims or trade permissions.
 */
async function probePublicHistoricalRoutes(baseUrl: string) {
  const beforeMs = Date.now() - 60 * 60_000;
  const cases = [
    { market: 'KR', provider: 'yahoo-history', url: `/api/stocks/005930/history-candles?tf=1D&before=${beforeMs}` },
    { market: 'US', provider: 'yahoo-history', url: `/api/stocks/AAPL/history-candles?tf=1D&before=${beforeMs}` },
    { market: 'SPOT', provider: 'upbit', url: `/api/crypto/spot/candles?symbol=BTC&unit=5&before=${encodeURIComponent(new Date(beforeMs).toISOString())}` },
    { market: 'FUTURES', provider: 'bitget', url: `/api/crypto/futures/candles?symbol=BTCUSDT&granularity=5m&before=${beforeMs}` },
  ] as const;

  return Promise.all(cases.map(async ({ market, provider, url }) => {
    try {
      const response = await getJson(baseUrl, url, AbortSignal.timeout(24_000));
      const body = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
        ? response.body as Record<string, unknown> : {};
      const rows = Array.isArray(body.candles) ? body.candles : [];
      const timestamp = (raw: unknown): number => {
        if (typeof raw === 'number') return raw > 10_000_000_000 ? raw : raw * 1_000;
        return typeof raw === 'string' ? Date.parse(raw) : NaN;
      };
      const times = rows.map((row: unknown) => timestamp(
        row && typeof row === 'object' ? (row as Record<string, unknown>).time : null,
      ));
      const priorOnly = times.every(time => Number.isFinite(time) && time > 0 && time < beforeMs);
      const ordered = times.every((time, index) => index === 0 || time > times[index - 1]);
      const validOhlcv = rows.every((row: unknown) => {
        if (!row || typeof row !== 'object') return false;
        const c = row as Record<string, unknown>;
        const [open, high, low, close, volume] =
          [c.open, c.high, c.low, c.close, c.volume].map(Number);
        return [open, high, low, close, volume].every(Number.isFinite)
          && open > 0 && low > 0 && high >= Math.max(open, close)
          && low <= Math.min(open, close) && volume >= 0;
      });
      const sourceMatches = body.provider === provider;
      const countMatches = body.count === rows.length;
      const received = response.httpStatus === 200 && body.ok === true && rows.length > 0;
      const confirmed = received && priorOnly && ordered && validOhlcv && sourceMatches && countMatches;
      return {
        market,
        verdict: confirmed ? 'CONFIRMED' : received ? 'INVALID_SOURCE_ROWS'
          : response.httpStatus === 200 && body.ok === true && rows.length === 0
            ? 'NO_ROWS_AT_CURSOR' : 'PROVIDER_OR_ROUTE_UNAVAILABLE',
        httpStatus: response.httpStatus,
        candleCount: rows.length,
        provider: sourceMatches ? provider : null,
        priorOnly, ordered, validOhlcv, countMatches,
        sourceExhausted: body.sourceExhausted === true,
        errorCode: typeof body.error === 'string' ? body.error.slice(0, 64) : null,
        sensitiveTextDetected: response.sensitiveTextDetected,
      };
    } catch (error) {
      return {
        market, verdict: 'NETWORK_OR_TIMEOUT', httpStatus: null,
        candleCount: 0, provider: null, priorOnly: false, ordered: false,
        validOhlcv: false, countMatches: false, sourceExhausted: false,
        errorCode: error instanceof Error ? error.name.slice(0, 32) : 'UNKNOWN',
        sensitiveTextDetected: false,
      };
    }
  }));
}

async function main() {
  const app = express();
  app.use('/api', healthRouter);
  app.use('/api', futuresMarketDataRouter);
  app.use('/api/stocks', stocksRouter);
  app.use('/api', cryptoRouter);
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await getJson(baseUrl, '/api/healthz');
    const status = await getJson(baseUrl, '/api/crypto/futures/status');
    const snapshot = await getJson(baseUrl, '/api/crypto/futures/BTCUSDT/snapshot');
    const contractRules = await getJson(baseUrl, '/api/crypto/futures/BTCUSDT/contract-rules');
    const candles = await getJson(baseUrl, '/api/crypto/futures/BTCUSDT/candles?timeframe=15m&limit=100');
    const historical = await probePublicHistoricalRoutes(baseUrl);

    const statusBody = status.body as Record<string, unknown> | null;
    const snapshotBody = snapshot.body as Record<string, unknown> | null;
    const snapshotData = snapshotBody?.data as Record<string, unknown> | undefined;
    const contractBody = contractRules.body as Record<string, unknown> | null;
    const contractData = contractBody?.data as Record<string, unknown> | undefined;
    const candlesBody = candles.body as Record<string, unknown> | null;
    const candleData = Array.isArray(candlesBody?.data) ? candlesBody.data : [];

    const report = {
      health: {
        httpStatus: health.httpStatus,
        contentType: health.contentType,
      },
      status: {
        httpStatus: status.httpStatus,
        provider: statusBody?.provider ?? null,
        status: statusBody?.status ?? null,
        updatedAt: statusBody?.updatedAt ?? null,
        warnings: statusBody?.warnings ?? [],
        orderCapability: statusBody?.orderCapability ?? null,
      },
      snapshot: {
        httpStatus: snapshot.httpStatus,
        symbol: snapshotData?.symbol ?? null,
        status: snapshotData?.status ?? null,
        markPrice: snapshotData?.markPrice ?? null,
        indexPrice: snapshotData?.indexPrice ?? null,
        openInterest: snapshotData?.openInterest ?? null,
        fundingRate: snapshotData?.fundingRate ?? null,
        nextFundingAt: snapshotData?.nextFundingAt ?? null,
        updatedAt: snapshotData?.updatedAt ?? null,
        warnings: snapshotData?.warnings ?? [],
      },
      contractRules: {
        httpStatus: contractRules.httpStatus,
        publicDataOnly: contractBody?.publicDataOnly ?? null,
        orderCapability: contractBody?.orderCapability ?? null,
        symbol: contractData?.symbol ?? null,
        status: contractData?.status ?? null,
        quantityStep: contractData?.quantityStep ?? null,
        minimumQuantity: contractData?.minimumQuantity ?? null,
        minimumNotional: contractData?.minimumNotional ?? null,
        maximumLeverage: contractData?.maximumLeverage ?? null,
        updatedAt: contractData?.updatedAt ?? null,
        warnings: contractData?.warnings ?? [],
      },
      candles: {
        httpStatus: candles.httpStatus,
        symbol: candlesBody?.symbol ?? null,
        status: candlesBody?.status ?? null,
        count: candleData.length,
        updatedAt: candlesBody?.updatedAt ?? null,
        warnings: candlesBody?.warnings ?? [],
      },
      historicalPublic: {
        scope: 'REAL_PUBLIC_GET_DIAGNOSTICS_ONLY',
        allFourConfirmed: historical.every(item => item.verdict === 'CONFIRMED'),
        results: historical,
      },
      sensitiveTextDetected:
        historical.some(item => item.sensitiveTextDetected) ||
        health.sensitiveTextDetected ||
        status.sensitiveTextDetected ||
        snapshot.sensitiveTextDetected ||
        contractRules.sensitiveTextDetected ||
        candles.sensitiveTextDetected,
    };

    console.log(JSON.stringify(report, null, 2));

    const requiredStatuses = [
      health.httpStatus,
      status.httpStatus,
      snapshot.httpStatus,
      contractRules.httpStatus,
      candles.httpStatus,
    ];
    if (requiredStatuses.some((code) => code !== 200)) process.exitCode = 1;
    if (report.sensitiveTextDetected) process.exitCode = 1;
    if (report.status.orderCapability !== false) process.exitCode = 1;
    if (report.contractRules.publicDataOnly !== true) process.exitCode = 1;
    if (report.contractRules.orderCapability !== false) process.exitCode = 1;
    if (report.contractRules.symbol !== 'BTCUSDT') process.exitCode = 1;
    if (report.candles.count < 1) process.exitCode = 1;
    // Historical diagnostics must report failures truthfully, but are not the
    // legacy mandatory Bitget API smoke or a live-trading release authorization.
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown network smoke error';
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
