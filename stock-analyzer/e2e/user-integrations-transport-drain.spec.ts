import { expect, test } from '@playwright/test';
import { UserIntegrationsRequestLifecycle } from '../src/lib/user-integrations-request-lifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

test('logical user-integrations timeout does not abort transport and logout waits for its HTTP terminal', async () => {
  const lifecycle = new UserIntegrationsRequestLifecycle<string>(20, 200);
  lifecycle.setIdentity('user-a', 'session-a');
  const transport = deferred<string>();
  let transportSignal: AbortSignal | null = null;

  const result = await lifecycle.request({
    identity: 'user-a',
    requestKey: 'session-a',
    load: async (signal) => {
      transportSignal = signal;
      return transport.promise;
    },
  });

  expect(result.status).toBe('failure');
  if (result.status === 'failure') expect(result.error).toMatchObject({ name: 'TimeoutError' });
  expect(transportSignal).not.toBeNull();
  expect(transportSignal?.aborted).toBe(false);
  expect(lifecycle.snapshot()).toMatchObject({ activeCount: 0, transportCount: 1, terminalStatus: 'failure' });

  let drained = false;
  const drain = lifecycle.beginLogout().then(() => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(drained).toBe(false);
  expect(transportSignal?.aborted).toBe(false);

  transport.resolve('http-200-terminal');
  await drain;
  expect(drained).toBe(true);
  expect(transportSignal?.aborted).toBe(false);
  expect(lifecycle.snapshot().transportCount).toBe(0);
});

test('bounded logout drain fails closed without physically aborting a hung integration transport', async () => {
  const lifecycle = new UserIntegrationsRequestLifecycle<string>(10, 30);
  lifecycle.setIdentity('user-a', 'session-a');
  let transportSignal: AbortSignal | null = null;

  const result = await lifecycle.request({
    identity: 'user-a',
    requestKey: 'session-a',
    load: async (signal) => {
      transportSignal = signal;
      return new Promise<string>(() => undefined);
    },
  });

  expect(result.status).toBe('failure');
  expect(transportSignal?.aborted).toBe(false);
  await expect(lifecycle.beginLogout()).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(transportSignal?.aborted).toBe(false);
  expect(lifecycle.snapshot()).toMatchObject({ blocked: true, transportCount: 1 });
});
