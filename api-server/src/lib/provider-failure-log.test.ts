import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError } from './errors';
import { logProviderFailure, resetProviderFailureLogForTest } from './provider-failure-log';

function capture(run: () => void): unknown[][] {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { calls.push(args); };
  try { run(); } finally { console.error = original; }
  return calls;
}

test('a provider that is not configured is logged once per process, without a stack trace', () => {
  resetProviderFailureLogForTest();
  const calls = capture(() => {
    for (const ticker of ['000230', '000240', '000250']) {
      logProviderFailure(`live financials failed for ${ticker}:`, new ProviderError('NOT_CONFIGURED', 'dart'));
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1, 'only a message string, never the error object');
  assert.match(String(calls[0][0]), /dart is not configured/u);
});

test('different unconfigured providers are each logged once', () => {
  resetProviderFailureLogForTest();
  const calls = capture(() => {
    logProviderFailure('a', new ProviderError('NOT_CONFIGURED', 'dart'));
    logProviderFailure('b', new ProviderError('NOT_CONFIGURED', 'finnhub'));
    logProviderFailure('c', new ProviderError('NOT_CONFIGURED', 'dart'));
  });
  assert.equal(calls.length, 2);
});

test('every other failure is still logged in full, every time', () => {
  resetProviderFailureLogForTest();
  const timeout = new ProviderError('UPSTREAM_ERROR', 'dart');
  const plain = new Error('boom');
  const calls = capture(() => {
    logProviderFailure('x', timeout);
    logProviderFailure('x', timeout);
    logProviderFailure('y', plain);
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1], timeout);
  assert.equal(calls[2][1], plain);
});
