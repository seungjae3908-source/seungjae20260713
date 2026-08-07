import assert from 'node:assert/strict';
import test from 'node:test';
import { BackupMutationCoordinator } from './backup-sync-lifecycle';

test('backup mutations are single-flight', async () => {
  const coordinator = new BackupMutationCoordinator();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const first = coordinator.run(async () => { executions += 1; await pending; });
  const second = coordinator.run(async () => { executions += 1; });
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(executions, 1);
  release();
  await Promise.all([first, second, coordinator.drain()]);
  assert.equal(coordinator.hasActiveMutation(), false);
});
