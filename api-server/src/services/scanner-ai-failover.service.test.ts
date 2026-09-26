import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FutureProvider,
  ScannerAiFailoverAdapter,
  ScannerAiProviderError,
  ScannerAiSingleFlightAdapter,
  type ScannerAiValidationInput,
} from './scanner-ai-provider.service';

const input: ScannerAiValidationInput = {
  signalId: 'sig-1', symbol: 'BTCUSDT', market: 'BITGET_USDT_FUTURES', strategy: 'scalping',
  direction: 'LONG', score: 80, riskScore: 20, dataQualityScore: 100, evidence: ['trend'], warnings: [],
};
const pass = { status: 'PASS' as const, provider: 'test', counterEvidence: [], missingData: [], risks: [], explanation: 'ok' };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('retryable primary failure uses secondary provider', async () => {
  let secondaryCalls = 0;
  const primary = new FutureProvider('gemini', async () => { throw new ScannerAiProviderError('RATE_LIMIT', true); });
  const secondary = new FutureProvider('groq', async () => { secondaryCalls += 1; return { ...pass, provider: 'groq' }; });
  const router = new ScannerAiFailoverAdapter(primary, secondary);
  const result = await router.validate(input, new AbortController().signal);
  assert.equal(result.provider, 'groq');
  assert.equal(secondaryCalls, 1);
  assert.equal(router.stats.fallbackSuccess, 1);
});

test('non-retryable primary failure never falls through', async () => {
  let secondaryCalls = 0;
  const primary = new FutureProvider('gemini', async () => { throw new ScannerAiProviderError('REJECTED', false); });
  const secondary = new FutureProvider('groq', async () => { secondaryCalls += 1; return pass; });
  const router = new ScannerAiFailoverAdapter(primary, secondary);
  await assert.rejects(router.validate(input, new AbortController().signal), /REJECTED/);
  assert.equal(secondaryCalls, 0);
  assert.equal(router.stats.primaryFailureNoFallback, 1);
});

test('single-flight shares identical concurrent requests', async () => {
  let calls = 0;
  const provider = new FutureProvider('free-ai', async () => { calls += 1; await wait(15); return pass; });
  const router = new ScannerAiSingleFlightAdapter(provider);
  const results = await Promise.all(Array.from({ length: 5 }, () => router.validate(input, new AbortController().signal)));
  assert.equal(results.length, 5);
  assert.equal(calls, 1);
  assert.equal(router.stats.sharedHits, 4);
  assert.equal(router.stats.inFlight, 0);
});

test('one cancelled waiter does not cancel shared provider work', async () => {
  let calls = 0;
  const provider = new FutureProvider('free-ai', async () => { calls += 1; await wait(15); return pass; });
  const router = new ScannerAiSingleFlightAdapter(provider);
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = router.validate(input, first.signal);
  const survivor = router.validate(input, second.signal);
  first.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal((await survivor).status, 'PASS');
  assert.equal(calls, 1);
});
