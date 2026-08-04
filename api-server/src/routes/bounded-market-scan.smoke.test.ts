import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import boundedMarketScanRouter from './bounded-market-scan';
import {
  BoundedScannerService,
  ScanProviderUnavailableError,
  type BoundedScanResult,
} from '../services/bounded-scanner.service';

interface ScanResponseBody {
  ok?: boolean;
  partial?: boolean;
  timedOut?: boolean;
  dataState?: string;
  timeoutCount?: number;
  error?: string;
  cards?: unknown[];
}

const completeResult = (overrides: Partial<BoundedScanResult> = {}): BoundedScanResult => ({
  cards: [],
  selected: ['PER 낮음'],
  supportedIndicators: ['PER 낮음'],
  scanned: 2,
  requestedCount: 2,
  completedCount: 2,
  providerErrorCount: 0,
  timeoutCount: 0,
  excludedCount: 2,
  appliedFilters: {
    volumeThreshold: null,
    tradingValueThreshold: null,
    marketCapThreshold: null,
    minimumScore: null,
    maximumRiskScore: null,
  },
  timeframe: '1D',
  partial: false,
  timedOut: false,
  elapsedMs: 100,
  dataState: 'complete',
  message: '스캔은 정상 완료됐지만 조건에 맞는 종목이 없습니다.',
  maxConcurrency: 2,
  deadlineMs: 12_000,
  itemTimeoutMs: 4_000,
  ...overrides,
});

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/api/market/scan', boundedMarketScanRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('normal zero-match scan returns HTTP 200 empty', async () => {
  const original = BoundedScannerService.scan;
  BoundedScannerService.scan = async () => completeResult();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/market/scan?market=KR&indicators=PER%20낮음`);
      assert.equal(response.status, 200);
      const body = await response.json() as ScanResponseBody;
      assert.equal(body.ok, true);
      assert.equal(body.partial, false);
      assert.equal(body.dataState, 'complete');
      assert.deepEqual(body.cards, []);
    });
  } finally {
    BoundedScannerService.scan = original;
  }
});

test('some item timeouts return explicit partial HTTP 200', async () => {
  const original = BoundedScannerService.scan;
  BoundedScannerService.scan = async () => completeResult({
    scanned: 5,
    requestedCount: 10,
    completedCount: 4,
    timeoutCount: 1,
    partial: true,
    timedOut: true,
    dataState: 'partial',
    elapsedMs: 11_900,
    message: '일부 데이터가 지연됐습니다.',
  });
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/market/scan?market=KR`);
      assert.equal(response.status, 200);
      const body = await response.json() as ScanResponseBody;
      assert.equal(body.partial, true);
      assert.equal(body.timedOut, true);
      assert.equal(body.timeoutCount, 1);
      assert.equal(body.dataState, 'partial');
    });
  } finally {
    BoundedScannerService.scan = original;
  }
});

test('unreliable provider scan remains strict HTTP 502', async () => {
  const original = BoundedScannerService.scan;
  const originalConsoleError = console.error;
  BoundedScannerService.scan = async () => {
    throw new ScanProviderUnavailableError('provider unavailable');
  };
  console.error = () => undefined;
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/market/scan?market=KR`);
      assert.equal(response.status, 502);
      const body = await response.json() as ScanResponseBody;
      assert.equal(body.ok, false);
      assert.equal(body.error, 'SCAN_PROVIDER_ERROR');
      assert.deepEqual(body.cards, []);
    });
  } finally {
    console.error = originalConsoleError;
    BoundedScannerService.scan = original;
  }
});

test('scanner smoke path sends zero order-capable requests', async () => {
  const original = BoundedScannerService.scan;
  BoundedScannerService.scan = async () => completeResult();
  const requestedPaths: string[] = [];
  try {
    await withServer(async (baseUrl) => {
      const url = `${baseUrl}/api/market/scan?market=US&timeframe=1D`;
      requestedPaths.push(new URL(url).pathname);
      const response = await fetch(url);
      assert.equal(response.status, 200);
    });
    assert.deepEqual(requestedPaths, ['/api/market/scan']);
    assert.ok(requestedPaths.every((path) => !/(?:order|trade|position|execute|approve)/i.test(path)));
  } finally {
    BoundedScannerService.scan = original;
  }
});
