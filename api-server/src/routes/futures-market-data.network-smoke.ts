import express from 'express';
import type { AddressInfo } from 'node:net';
import healthRouter from './health';
import futuresMarketDataRouter from './futures-market-data';

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
  const app = express();
  app.use('/api', healthRouter);
  app.use('/api', futuresMarketDataRouter);
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
    const candles = await getJson(baseUrl, '/api/crypto/futures/BTCUSDT/candles?timeframe=15m&limit=100');

    const statusBody = status.body as Record<string, unknown> | null;
    const snapshotBody = snapshot.body as Record<string, unknown> | null;
    const snapshotData = snapshotBody?.data as Record<string, unknown> | undefined;
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
      candles: {
        httpStatus: candles.httpStatus,
        symbol: candlesBody?.symbol ?? null,
        status: candlesBody?.status ?? null,
        count: candleData.length,
        updatedAt: candlesBody?.updatedAt ?? null,
        warnings: candlesBody?.warnings ?? [],
      },
      sensitiveTextDetected:
        health.sensitiveTextDetected ||
        status.sensitiveTextDetected ||
        snapshot.sensitiveTextDetected ||
        candles.sensitiveTextDetected,
    };

    console.log(JSON.stringify(report, null, 2));

    const requiredStatuses = [health.httpStatus, status.httpStatus, snapshot.httpStatus, candles.httpStatus];
    if (requiredStatuses.some((code) => code !== 200)) process.exitCode = 1;
    if (report.sensitiveTextDetected) process.exitCode = 1;
    if (report.status.orderCapability !== false) process.exitCode = 1;
    if (report.candles.count < 1) process.exitCode = 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown network smoke error';
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
