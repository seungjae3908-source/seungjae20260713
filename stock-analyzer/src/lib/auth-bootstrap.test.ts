import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FiniteDeadlineError,
  reconcileInitialSessionProfile,
  runFiniteAuthBootstrap,
  shouldReconcileInitialSession,
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

test('hung profile bootstrap terminates, aborts the request, and frees retry work', async () => {
  let applied = '';
  let aborted = false;
  await assert.rejects(
    () => runFiniteAuthBootstrap({
      getSession: async () => 'session-1',
      applySession: (session) => { applied = session; },
      loadProfile: (_session, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      sessionTimeoutMs: 20,
      profileTimeoutMs: 20,
    }),
    (error: unknown) => error instanceof FiniteDeadlineError && error.code === 'AUTH_PROFILE_TIMEOUT',
  );
  assert.equal(applied, 'session-1');
  assert.equal(aborted, true);
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

test('INITIAL_SESSION only reconciles a restored authenticated identity that is not fully hydrated', () => {
  assert.equal(shouldReconcileInitialSession({
    event: 'INITIAL_SESSION',
    incomingUserId: 'user-1',
    currentUserId: null,
    hasProfile: false,
    profileHydrationUserId: null,
  }), true);
  assert.equal(shouldReconcileInitialSession({
    event: 'INITIAL_SESSION',
    incomingUserId: 'user-1',
    currentUserId: 'user-1',
    hasProfile: false,
    profileHydrationUserId: null,
  }), true);
  assert.equal(shouldReconcileInitialSession({
    event: 'INITIAL_SESSION',
    incomingUserId: 'user-1',
    currentUserId: 'user-1',
    hasProfile: true,
    profileHydrationUserId: null,
  }), false);
  assert.equal(shouldReconcileInitialSession({
    event: 'INITIAL_SESSION',
    incomingUserId: null,
    currentUserId: null,
    hasProfile: false,
    profileHydrationUserId: null,
  }), false);
  assert.equal(shouldReconcileInitialSession({
    event: 'TOKEN_REFRESHED',
    incomingUserId: 'user-1',
    currentUserId: null,
    hasProfile: false,
    profileHydrationUserId: null,
  }), false);
});

test('INITIAL_SESSION does not duplicate an in-flight profile hydration for the same identity', () => {
  assert.equal(shouldReconcileInitialSession({
    event: 'INITIAL_SESSION',
    incomingUserId: 'user-1',
    currentUserId: 'user-1',
    hasProfile: false,
    profileHydrationUserId: 'user-1',
  }), false);
  assert.equal(shouldReconcileInitialSession({
    event: 'INITIAL_SESSION',
    incomingUserId: 'user-2',
    currentUserId: 'user-1',
    hasProfile: false,
    profileHydrationUserId: 'user-1',
  }), true);
});

test('transient null bootstrap is recoverable by one persisted INITIAL_SESSION hydration', async () => {
  const bootstrapOrder: string[] = [];
  await runFiniteAuthBootstrap<null>({
    getSession: async () => null,
    applySession: () => bootstrapOrder.push('bootstrap:null'),
    loadProfile: async () => { bootstrapOrder.push('profile:null'); },
    sessionTimeoutMs: 50,
    profileTimeoutMs: 50,
  });

  assert.deepEqual(bootstrapOrder, ['bootstrap:null', 'profile:null']);
  assert.equal(shouldReconcileInitialSession({
    event: 'INITIAL_SESSION',
    incomingUserId: 'restored-user',
    currentUserId: null,
    hasProfile: false,
    profileHydrationUserId: null,
  }), true);

  let profileReads = 0;
  let hydrated = false;
  await reconcileInitialSessionProfile({
    loadProfile: async () => {
      profileReads += 1;
      hydrated = true;
    },
    hasProfile: () => hydrated,
    isSessionCurrent: () => true,
  });

  assert.equal(profileReads, 1);
  assert.equal(hydrated, true);
  assert.equal(shouldReconcileInitialSession({
    event: 'INITIAL_SESSION',
    incomingUserId: 'restored-user',
    currentUserId: 'restored-user',
    hasProfile: true,
    profileHydrationUserId: null,
  }), false);
});

test('initial session profile recovery retries once when the first hydration read is still empty', async () => {
  let attempts = 0;
  let hydrated = false;
  await reconcileInitialSessionProfile({
    loadProfile: async () => {
      attempts += 1;
      if (attempts === 2) hydrated = true;
    },
    hasProfile: () => hydrated,
    isSessionCurrent: () => true,
  });
  assert.equal(attempts, 2);
  assert.equal(hydrated, true);
});

test('initial session profile recovery does not retry after identity changes', async () => {
  let attempts = 0;
  await reconcileInitialSessionProfile({
    loadProfile: async () => { attempts += 1; },
    hasProfile: () => false,
    isSessionCurrent: () => false,
  });
  assert.equal(attempts, 1);
});
