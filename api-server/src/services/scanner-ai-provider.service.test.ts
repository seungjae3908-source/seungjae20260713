import test from 'node:test';
import assert from 'node:assert/strict';
import './scanner-ai-failover.service.test';
import {
  FutureProvider,
  ScannerAiProviderError,
  ScannerAiProviderScheduler,
  ScannerAiSingleFlightAdapter,
  parseRetryAfterMs,
  type ScannerAiValidationInput,
} from './scanner-ai-provider.service';

const request: ScannerAiValidationInput = {
  signalId: 'signal:test',
  symbol: 'BTCUSDT',
  market: 'BITGET_USDT_FUTURES',
  strategy: 'scalping',
  direction: 'LONG',
  score: 80,
  riskScore: 20,
  dataQualityScore: 100,
  evidence: ['trend'],
  warnings: [],
};

const pass = {
  status: 'PASS' as const,
  provider: 'future-test',
  counterEvidence: [],
  missingData: [],
  risks: [],
  explanation: '검증 통과',
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('provider scheduler enforces concurrency limit', async () => {
  let active = 0;
  let maximum = 0;
  const adapter = new FutureProvider('future-test', async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await wait(12);
    active -= 1;
    return pass;
  });
  const scheduler = new ScannerAiProviderScheduler(adapter, { concurrency: 2 });
  const results = await Promise.all(Array.from({ length: 6 }, () => scheduler.validate(request)));
  assert.equal(results.length, 6);
  assert.ok(maximum <= 2);
  assert.equal(scheduler.activeCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

test('retryable provider errors use retry policy and Retry-After parsing is supported', async () => {
  let attempts = 0;
  const adapter = new FutureProvider('future-test', async () => {
    attempts += 1;
    if (attempts < 3) throw new ScannerAiProviderError('RATE_LIMIT', true, 1);
    return pass;
  });
  const scheduler = new ScannerAiProviderScheduler(adapter, {
    maxRetries: 3,
    baseBackoffMs: 10,
    maxBackoffMs: 20,
    random: () => 0,
    circuitFailureThreshold: 10,
  });
  const result = await scheduler.validate(request);
  assert.equal(result.status, 'PASS');
  assert.equal(attempts, 3);
  assert.equal(parseRetryAfterMs('2'), 2_000);
  assert.equal(parseRetryAfterMs('invalid'), null);
});

test('AbortSignal cancels a request while it is waiting in exponential backoff', async () => {
  const adapter = new FutureProvider('future-test', async () => {
    throw new ScannerAiProviderError('TEMPORARY', true, 100);
  });
  const scheduler = new ScannerAiProviderScheduler(adapter, {
    maxRetries: 3,
    baseBackoffMs: 50,
    circuitFailureThreshold: 10,
  });
  const controller = new AbortController();
  const promise = scheduler.validate(request, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(promise, (error: unknown) => (
    error instanceof Error && (error.name === 'AbortError' || error.message === 'SCANNER_AI_ABORTED')
  ));
});

test('circuit breaker opens after configured consecutive failures', async () => {
  let attempts = 0;
  const adapter = new FutureProvider('future-test', async () => {
    attempts += 1;
    throw new ScannerAiProviderError('DOWN', true, 1);
  });
  const scheduler = new ScannerAiProviderScheduler(adapter, {
    maxRetries: 3,
    circuitFailureThreshold: 1,
    circuitResetMs: 10_000,
  });
  await assert.rejects(scheduler.validate(request), /DOWN/);
  await assert.rejects(scheduler.validate(request), /SCANNER_AI_CIRCUIT_OPEN/);
  assert.equal(attempts, 1);
});

test('queued cancellation is immediate and does not start a provider request', async () => {
  let calls = 0;
  const scheduler = new ScannerAiProviderScheduler(new FutureProvider('test', async () => {
    calls += 1;
    return new Promise(() => {});
  }), { concurrency: 1, requestTimeoutMs: 60 });
  const blocked = scheduler.validate(request);
  const blockedFailure = assert.rejects(blocked, /SCANNER_AI_DEADLINE/);
  const controller = new AbortController();
  const queued = scheduler.validate(request, controller.signal);
  const queuedFailure = assert.rejects(queued, /cancel-queued/);
  controller.abort(new Error('cancel-queued'));
  await queuedFailure;
  assert.equal(scheduler.pendingCount, 0);
  await blockedFailure;
  await wait(0);
  assert.equal(calls, 1);
  assert.equal(scheduler.activeCount, 0);
});

test('AI queue is bounded and malformed results never become PASS', async () => {
  const scheduler = new ScannerAiProviderScheduler(new FutureProvider('test', async () => new Promise(() => {})),
    { concurrency: 1, maxQueueLength: 1, requestTimeoutMs: 30 });
  const first = assert.rejects(scheduler.validate(request), /SCANNER_AI_DEADLINE/);
  const second = assert.rejects(scheduler.validate(request), /SCANNER_AI_DEADLINE/);
  await assert.rejects(scheduler.validate(request), /SCANNER_AI_QUEUE_FULL/);
  await Promise.all([first, second]);
  const malformed = new ScannerAiProviderScheduler(new FutureProvider('test', async () => ({ status: 'PASS' } as typeof pass)));
  await assert.rejects(malformed.validate(request), /SCANNER_AI_RESPONSE_INVALID/);
  assert.throws(() => new ScannerAiProviderScheduler(new FutureProvider('test', async () => pass), { concurrency: NaN }), /OPTION_INVALID/);
});

test('shared AI requests release capacity when a delegate ignores cancellation', async () => {
  let calls = 0;
  const shared = new ScannerAiSingleFlightAdapter(new FutureProvider('hung', async () => { calls++; return new Promise(() => {}); }), undefined, 20);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(shared.validate(request, controller.signal)); assert.equal(calls, 0);
  await assert.rejects(shared.validate(request, new AbortController().signal), /SCANNER_AI_DEADLINE/);
  assert.equal(shared.stats.inFlight, 0);
});
