import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  acquireWorkerLock,
  WorkerAlreadyRunningError,
} from '../src/workers/worker-lock';

async function withLockDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'worker-lock-test-'));
  const previous = process.env.WORKER_LOCK_DIR;
  process.env.WORKER_LOCK_DIR = directory;
  try {
    await run(directory);
  } finally {
    if (previous == null) delete process.env.WORKER_LOCK_DIR;
    else process.env.WORKER_LOCK_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('same worker lock blocks a second process and allows restart', async () => {
  await withLockDirectory(async () => {
    const first = await acquireWorkerLock('signal-worker');
    await assert.rejects(
      acquireWorkerLock('signal-worker'),
      (error) =>
        error instanceof WorkerAlreadyRunningError &&
        error.code === 'WORKER_ALREADY_RUNNING' &&
        error.exitCode === 73,
    );

    await first.release();
    const restarted = await acquireWorkerLock('signal-worker');
    await restarted.release();
  });
});

test('signal and alert workers use independent locks', async () => {
  await withLockDirectory(async () => {
    const [signal, alert] = await Promise.all([
      acquireWorkerLock('signal-worker'),
      acquireWorkerLock('alert-worker'),
    ]);
    assert.notEqual(signal.path, alert.path);
    await Promise.all([signal.release(), alert.release()]);
  });
});

test('atomic concurrent acquisition has exactly one winner', async () => {
  await withLockDirectory(async () => {
    const rows = await Promise.allSettled([
      acquireWorkerLock('signal-worker'),
      acquireWorkerLock('signal-worker'),
    ]);
    assert.equal(rows.filter((row) => row.status === 'fulfilled').length, 1);
    assert.equal(rows.filter((row) => row.status === 'rejected').length, 1);

    for (const row of rows) {
      if (row.status === 'fulfilled') await row.value.release();
      else assert.ok(row.reason instanceof WorkerAlreadyRunningError);
    }
  });
});

test('dead PID stale lock is recovered', async () => {
  await withLockDirectory(async (directory) => {
    await mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, 'signal-worker.lock');
    const token = 'stale-test-token';
    const old = new Date(Date.now() - 60_000).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        name: 'signal-worker',
        pid: 2_147_483_647,
        token,
        createdAt: old,
      }),
      'utf8',
    );
    await writeFile(`${lockPath}.${token}.heartbeat`, old, 'utf8');

    const recovered = await acquireWorkerLock('signal-worker');
    assert.equal(recovered.path, lockPath);
    await recovered.release();
  });
});
