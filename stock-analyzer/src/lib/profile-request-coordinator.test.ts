import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileRequestCoordinator } from './profile-request-coordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test('coalesces login, restore, auth callback, focus, reconnect, and remount races', async () => {
  for (let iteration = 0; iteration < 25; iteration += 1) {
    let now = iteration * 1_000;
    let loads = 0;
    const source = deferred<string>();
    const applied: string[] = [];
    const first = new ProfileRequestCoordinator<string>(() => now);
    const second = new ProfileRequestCoordinator<string>(() => now);
    first.setIdentity('user-a', 'session-a');
    second.setIdentity('user-a', 'session-a');

    const load = () => {
      loads += 1;
      return source.promise;
    };
    const calls = [
      first.request({ identity: 'user-a', requestKey: 'session-a', load, apply: (value) => applied.push(`first:${value}`) }),
      first.request({ identity: 'user-a', requestKey: 'session-a', load, apply: (value) => applied.push(`callback:${value}`) }),
      first.request({ identity: 'user-a', requestKey: 'session-a', load, apply: (value) => applied.push(`focus:${value}`), maxAgeMs: 30_000 }),
      first.request({ identity: 'user-a', requestKey: 'session-a', load, apply: (value) => applied.push(`reconnect:${value}`), maxAgeMs: 30_000 }),
      second.request({ identity: 'user-a', requestKey: 'session-a', load, apply: (value) => applied.push(`remount:${value}`) }),
    ];

    await flush();
    assert.equal(loads, 1, `iteration ${iteration}: one shared /profiles request`);
    source.resolve('profile-a');
    await Promise.all(calls);
    assert.deepEqual(applied.sort(), ['first:profile-a', 'remount:profile-a']);

    await first.request({
      identity: 'user-a', requestKey: 'session-a', load,
      apply: (value) => applied.push(`fresh:${value}`), maxAgeMs: 30_000,
    });
    assert.equal(loads, 1, `iteration ${iteration}: fresh focus/reconnect does not refetch`);

    now += 30_001;
    const stale = deferred<string>();
    const staleLoad = () => { loads += 1; return stale.promise; };
    const staleRequest = first.request({
      identity: 'user-a', requestKey: 'session-a', load: staleLoad,
      apply: (value) => applied.push(`stale:${value}`), maxAgeMs: 30_000,
    });
    await flush();
    assert.equal(loads, 2, `iteration ${iteration}: stale focus/reconnect refreshes once`);
    stale.resolve('profile-a-2');
    await staleRequest;
  }
});

test('logout drains the active request, blocks new starts, and rejects late state application', async () => {
  for (let iteration = 0; iteration < 25; iteration += 1) {
    const coordinator = new ProfileRequestCoordinator<string>();
    coordinator.setIdentity('user-a', 'session-a');
    const source = deferred<string>();
    let loads = 0;
    let applications = 0;
    const request = coordinator.request({
      identity: 'user-a', requestKey: 'session-a',
      load: () => { loads += 1; return source.promise; },
      apply: () => { applications += 1; },
    });
    await flush();

    const logoutDrain = coordinator.beginLogout();
    await coordinator.request({
      identity: 'user-a', requestKey: 'session-a',
      load: async () => { loads += 1; return 'forbidden'; },
      apply: () => { applications += 1; }, force: true,
    });
    assert.equal(loads, 1, `iteration ${iteration}: post-logout profile starts remain zero`);

    let drained = false;
    void logoutDrain.then(() => { drained = true; });
    await flush();
    assert.equal(drained, false, `iteration ${iteration}: signOut waits for the profile request`);
    source.resolve('late-profile');
    await Promise.all([request, logoutDrain]);
    assert.equal(applications, 0, `iteration ${iteration}: late profile response is not applied`);
    coordinator.finishLogout();
  }
});

test('double logout, immediate logout, expiry, failed logout restore, and different-user relogin stay isolated', async () => {
  const coordinator = new ProfileRequestCoordinator<string>();
  coordinator.setIdentity('user-a', 'session-a');
  const immediateDrain = coordinator.beginLogout();
  const duplicateDrain = coordinator.beginLogout();
  await Promise.all([immediateDrain, duplicateDrain]);
  coordinator.finishLogout();

  let loads = 0;
  await coordinator.request({
    identity: 'user-a', requestKey: 'session-a',
    load: async () => { loads += 1; return 'forbidden'; }, apply: () => undefined,
  });
  assert.equal(loads, 0, 'expired/logged-out session cannot start a profile request');

  coordinator.restoreAfterFailedLogout('user-a', 'session-a');
  const old = deferred<string>();
  let oldApplied = 0;
  const oldRequest = coordinator.request({
    identity: 'user-a', requestKey: 'session-a',
    load: () => { loads += 1; return old.promise; },
    apply: () => { oldApplied += 1; }, force: true,
  });
  await flush();
  coordinator.setIdentity('user-b', 'session-b');
  const newRequest = coordinator.request({
    identity: 'user-b', requestKey: 'session-b',
    load: async () => { loads += 1; return 'profile-b'; },
    apply: (value) => assert.equal(value, 'profile-b'),
  });
  old.resolve('profile-a');
  await Promise.all([oldRequest, newRequest]);
  assert.equal(oldApplied, 0, 'old user response cannot cross into a new login');
  assert.equal(loads, 2);
});

test('failed profile loads are released and may retry without leaking a shared flight', async () => {
  const coordinator = new ProfileRequestCoordinator<string>();
  coordinator.setIdentity('user-a', 'session-a');
  const failed = deferred<string>();
  const first = coordinator.request({
    identity: 'user-a', requestKey: 'session-a', load: () => failed.promise, apply: () => undefined,
  });
  failed.reject(new Error('provider failed'));
  await assert.rejects(first, /provider failed/);

  let applications = 0;
  await coordinator.request({
    identity: 'user-a', requestKey: 'session-a', load: async () => 'recovered',
    apply: () => { applications += 1; },
  });
  assert.equal(applications, 1);
});
