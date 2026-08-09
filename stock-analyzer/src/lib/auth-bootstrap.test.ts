import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FiniteDeadlineError,
  runFiniteAuthBootstrap,
  withFiniteDeadline,
} from './auth-bootstrap';

const never = <T>() => new Promise<T>(() => undefined);

test('finite deadline resolves successful work without changing the value', async () => {
  const value = await withFiniteDeadline(Promise.resolve('ready'), 50, 'AUTH_SESSION_TIMEOUT');
  assert.equal(value, 'ready');
});

test('finite deadline preserves an immediate provider failure', async () => {
  const providerError = new Error('SUPABASE_UNAVAILABLE');
  await assert.rejects(
    () => withFiniteDeadline(Promise.reject(providerError), 50, 'AUTH_SESSION_TIMEOUT'),
    (error: unknown) => error === providerError,
  );
});

test('hung session bootstrap terminates with AUTH_SESSION_TIMEOUT', async () => {
  await assert.rejects(
    () => runFiniteAuthBootstrap({
      getSession: () => never<string>(),
      applySession: () => assert.fail('session must not be applied after a timeout'),
      loadProfile: async () => assert.fail('profile must not load after a session timeout'),
      sessionTimeoutMs: 20,
      profileTimeoutMs: 20,
    }),
    (error: unknown) => error instanceof FiniteDeadlineError && error.code === 'AUTH_SESSION_TIMEOUT',
  );
});

test('hung profile bootstrap terminates with AUTH_PROFILE_TIMEOUT after applying session', async () => {
  let applied = '';
  await assert.rejects(
    () => runFiniteAuthBootstrap({
      getSession: async () => 'session-1',
      applySession: (session) => { applied = session; },
      loadProfile: () => never<void>(),
      sessionTimeoutMs: 20,
      profileTimeoutMs: 20,
    }),
    (error: unknown) => error instanceof FiniteDeadlineError && error.code === 'AUTH_PROFILE_TIMEOUT',
  );
  assert.equal(applied, 'session-1');
});

test('successful bootstrap applies session before profile and completes', async () => {
  const order: string[] = [];
  await runFiniteAuthBootstrap({
    getSession: async () => {
      order.push('session-read');
      return 'session-2';
    },
    applySession: (session) => order.push(`session-apply:${session}`),
    loadProfile: async (session) => { order.push(`profile:${session}`); },
    sessionTimeoutMs: 50,
    profileTimeoutMs: 50,
  });
  assert.deepEqual(order, ['session-read', 'session-apply:session-2', 'profile:session-2']);
});
