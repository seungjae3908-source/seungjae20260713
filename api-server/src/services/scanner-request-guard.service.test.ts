import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ScannerRequestGuard,
  ScannerRequestGuardError,
} from './scanner-request-guard.service';

test('same member and same active conditions are rejected as a duplicate', () => {
  const guard = new ScannerRequestGuard();
  const first = guard.acquire('member-1', 'KR:1D:volume');
  assert.throws(
    () => guard.acquire('member-1', 'KR:1D:volume'),
    (error: unknown) => error instanceof ScannerRequestGuardError
      && error.code === 'SCAN_DUPLICATE_REQUEST'
      && error.status === 409,
  );
  first.release();
  const next = guard.acquire('member-1', 'KR:1D:volume');
  next.release();
});

test('concurrency is isolated per member', () => {
  const guard = new ScannerRequestGuard({ maxConcurrentPerMember: 2 });
  const first = guard.acquire('member-1', 'request-a');
  const second = guard.acquire('member-1', 'request-b');
  assert.throws(
    () => guard.acquire('member-1', 'request-c'),
    (error: unknown) => error instanceof ScannerRequestGuardError
      && error.code === 'SCAN_CONCURRENCY_LIMIT'
      && error.status === 429,
  );
  const otherMember = guard.acquire('member-2', 'request-c');
  otherMember.release();
  first.release();
  second.release();
});

test('fixed-window rate limit returns a bounded retry time', () => {
  let now = 1_000;
  const guard = new ScannerRequestGuard({
    windowMs: 10_000,
    maxRequestsPerWindow: 2,
    now: () => now,
  });
  guard.acquire('member-1', 'a').release();
  guard.acquire('member-1', 'b').release();
  assert.throws(
    () => guard.acquire('member-1', 'c'),
    (error: unknown) => error instanceof ScannerRequestGuardError
      && error.code === 'SCAN_RATE_LIMITED'
      && error.retryAfterSeconds === 10,
  );
  now += 10_000;
  guard.acquire('member-1', 'c').release();
});
