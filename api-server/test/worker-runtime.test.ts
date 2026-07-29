import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runWorker } from '../src/workers/worker-runtime';

test('worker waits for each cycle and releases lock on SIGTERM', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'worker-runtime-'));
  const previous = process.env.WORKER_LOCK_DIR;
  process.env.WORKER_LOCK_DIR = directory;
  let active = 0;
  let maximumActive = 0;
  let runs = 0;

  try {
    const completion = runWorker({
      name: 'runtime-test',
      intervalMs: 1_000,
      run: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
      },
    });
    setTimeout(() => process.emit('SIGTERM'), 1_150);
    await completion;

    assert.equal(maximumActive, 1);
    assert.equal(active, 0);
    assert.ok(runs >= 2);

    const restarted = runWorker({
      name: 'runtime-test',
      intervalMs: 1_000,
      run: async () => undefined,
    });
    setTimeout(() => process.emit('SIGTERM'), 50);
    await restarted;
  } finally {
    if (previous == null) delete process.env.WORKER_LOCK_DIR;
    else process.env.WORKER_LOCK_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
