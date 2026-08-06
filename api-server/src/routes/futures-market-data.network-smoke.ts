import express from 'express';
import type { AddressInfo } from 'node:net';
import healthRouter from './health';
import futuresMarketDataRouter from './futures-market-data';
import orderbookRouter from './stock-orderbook';

type PublicCall = {
  host: string;
  path: string;
  method: string;
  privateHeaderDetected: boolean;
  privatePathDetected: boolean;
};

function containsSensitiveText(value: unknown) {
  const text = JSON.stringify(value);
  return /(?:api[_-]?key|secret|authorization|bearer|private[_-]?key|stack)/i.test(text);
}

async function getJson(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json' },
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

async function main() {
  const nativeFetch = globalThis.fetch;
  const publicCalls: PublicCall[] = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'api.upbit.com' || url.hostname === 'api.bitget.com') {
      const headers = request.headers;
      publicCalls.push({
        host: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        privateHeaderDetected: [
          'authorization',
          'access-key',
          'access-sign',
          'access-passphrase',
        ].some((name) => headers.has(name)),
        privatePathDetected: /\/(?:account|accounts|balance|balances|position|positions|order|orders|private)(?:\/|$)/i.test(url.pathname),
      });
    }
    return nativeFetch(input, init);
  };

  const app = express();
  app.use('/api', healthRouter);
  app.use('/api', futuresMarketDataRouter);
  app.use('/api', orderbookRouter);
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
    const upbitOrderbook = await getJson(
      baseUrl,
      '/api/orderbook?assetClass=crypto_spot&market=UPBIT&symbol=BTC',
    );
    const bitgetOrderbook = await getJson(
      baseUrl,
      '/api/orderbook?assetClass=crypto_futures&market=BITGET&symbol=BTCUSDT',
    );

    const statusBody = status.body as Record<string, unknown> | null;
    const snapshotBody = snapshot.body as Record<string, unknown> | null;
    const snapshotData = snapshotBody?.data as Record<string, unknown> | undefined;
    const contractBody = contractRules.body as Record<string, unknown> | null;
    const contractData = contractBody?.data as Record<string, unknown> | undefined;
    const candlesBody = candles.body as Record<string, unknown> | null;
    const candleData = Array.isArray(candlesBody?.data) ? candlesBody.data : [];
    const upbitBody = upbitOrderbook.body as Record<string, unknown> | null;
    const bitgetBody = bitgetOrderbook.body as Record<string, unknown> | null;
    const upbitAsks = Array.isArray(upbitBody?.asks) ? upbitBody.asks : [];
    const upbitBids = Array.isArray(upbitBody?.bids) ? upbitBody.bids : [];
    const bitgetAsks = Array.isArray(bitgetBody?.asks) ? bitgetBody.asks : [];
    const bitgetBids = Array.isArray(bitgetBody?.bids) ? bitgetBody.bids : [];

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
      upbitOrderbook: {
        httpStatus: upbitOrderbook.httpStatus,
        provider: upbitBody?.provider ?? null,
        status: upbitBody?.status ?? null,
        symbol: upbitBody?.symbol ?? null,
        asks: upbitAsks.length,
        bids: upbitBids.length,
        freshness: upbitBody?.freshness ?? null,
        orderSubmitted: upbitBody?.orderSubmitted ?? null,
        exchangeRequestSent: upbitBody?.exchangeRequestSent ?? null,
      },
      bitgetOrderbook: {
        httpStatus: bitgetOrderbook.httpStatus,
        provider: bitgetBody?.provider ?? null,
        status: bitgetBody?.status ?? null,
        symbol: bitgetBody?.symbol ?? null,
        asks: bitgetAsks.length,
        bids: bitgetBids.length,
        freshness: bitgetBody?.freshness ?? null,
        orderSubmitted: bitgetBody?.orderSubmitted ?? null,
        exchangeRequestSent: bitgetBody?.exchangeRequestSent ?? null,
      },
      publicTransport: {
        upbitOrderbookCalled: publicCalls.some((call) =>
          call.host === 'api.upbit.com' && call.path.startsWith('/v1/orderbook?')),
        bitgetOrderbookCalled: publicCalls.some((call) =>
          call.host === 'api.bitget.com' && call.path.startsWith('/api/v2/mix/market/merge-depth?')),
        nonGetRequests: publicCalls.filter((call) => call.method !== 'GET').length,
        privateHeaderRequests: publicCalls.filter((call) => call.privateHeaderDetected).length,
        privatePathRequests: publicCalls.filter((call) => call.privatePathDetected).length,
      },
      sensitiveTextDetected:
        health.sensitiveTextDetected
        || status.sensitiveTextDetected
        || snapshot.sensitiveTextDetected
        || contractRules.sensitiveTextDetected
        || candles.sensitiveTextDetected
        || upbitOrderbook.sensitiveTextDetected
        || bitgetOrderbook.sensitiveTextDetected,
    };

    console.log(JSON.stringify(report, null, 2));

    const requiredStatuses = [
      health.httpStatus,
      status.httpStatus,
      snapshot.httpStatus,
      contractRules.httpStatus,
      candles.httpStatus,
      upbitOrderbook.httpStatus,
      bitgetOrderbook.httpStatus,
    ];
    if (requiredStatuses.some((code) => code !== 200)) process.exitCode = 1;
    if (report.sensitiveTextDetected) process.exitCode = 1;
    if (report.status.orderCapability !== false) process.exitCode = 1;
    if (report.contractRules.publicDataOnly !== true) process.exitCode = 1;
    if (report.contractRules.orderCapability !== false) process.exitCode = 1;
    if (report.contractRules.symbol !== 'BTCUSDT') process.exitCode = 1;
    if (report.candles.count < 1) process.exitCode = 1;
    if (!['ready', 'partial'].includes(String(report.upbitOrderbook.status))) process.exitCode = 1;
    if (report.upbitOrderbook.provider !== 'upbit') process.exitCode = 1;
    if (report.upbitOrderbook.symbol !== 'BTC') process.exitCode = 1;
    if (report.upbitOrderbook.asks < 1 || report.upbitOrderbook.bids < 1) process.exitCode = 1;
    if (report.upbitOrderbook.orderSubmitted !== false) process.exitCode = 1;
    if (report.upbitOrderbook.exchangeRequestSent !== false) process.exitCode = 1;
    if (!['ready', 'partial'].includes(String(report.bitgetOrderbook.status))) process.exitCode = 1;
    if (report.bitgetOrderbook.provider !== 'bitget') process.exitCode = 1;
    if (report.bitgetOrderbook.symbol !== 'BTCUSDT') process.exitCode = 1;
    if (report.bitgetOrderbook.asks < 1 || report.bitgetOrderbook.bids < 1) process.exitCode = 1;
    if (report.bitgetOrderbook.orderSubmitted !== false) process.exitCode = 1;
    if (report.bitgetOrderbook.exchangeRequestSent !== false) process.exitCode = 1;
    if (!report.publicTransport.upbitOrderbookCalled) process.exitCode = 1;
    if (!report.publicTransport.bitgetOrderbookCalled) process.exitCode = 1;
    if (report.publicTransport.nonGetRequests !== 0) process.exitCode = 1;
    if (report.publicTransport.privateHeaderRequests !== 0) process.exitCode = 1;
    if (report.publicTransport.privatePathRequests !== 0) process.exitCode = 1;
  } finally {
    globalThis.fetch = nativeFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown network smoke error';
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
