import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackupMutationCoordinator,
  prepareBackupForSessionEnd,
  registerBackupSessionLifecycle,
  resumeBackupForSession,
} from './backup-sync-lifecycle';

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('backup mutations are single-flight and drain waits for completion', async () => {
  const coordinator = new BackupMutationCoordinator();
  const pending = deferred();
  let executions = 0;

  const first = coordinator.run(async () => {
    executions += 1;
    await pending.promise;
  });
  const second = coordinator.run(async () => {
    executions += 1;
  });
  const drained = coordinator.drain();

  assert.equal(first, second);
  assert.equal(coordinator.hasActiveMutation(), true);
  assert.equal(executions, 0);

  await Promise.resolve();
  assert.equal(executions, 1);
  pending.resolve();
  await Promise.all([first, second, drained]);
  assert.equal(coordinator.hasActiveMutation(), false);
});

test('drain handles a rejected mutation and a later mutation can run', async () => {
  const coordinator = new BackupMutationCoordinator();
  const pending = deferred();
  const failed = coordinator.run(() => pending.promise);
  const drained = coordinator.drain();

  pending.reject(new Error('backup request failed'));
  await assert.rejects(failed, /backup request failed/);
  await drained;

  let completed = false;
  await coordinator.run(async () => {
    completed = true;
  });
  assert.equal(completed, true);
  assert.equal(coordinator.hasActiveMutation(), false);
});

test('session lifecycle prepares before auth changes and resumes explicitly', async () => {
  const events: string[] = [];
  const unregister = registerBackupSessionLifecycle({
    async prepareForSessionEnd() {
      events.push('prepare');
    },
    resume(memberId) {
      events.push(`resume:${memberId}`);
    },
  });

  await prepareBackupForSessionEnd();
  resumeBackupForSession('member-1');
  unregister();
  await prepareBackupForSessionEnd();
  resumeBackupForSession('member-2');

  assert.deepEqual(events, ['prepare', 'resume:member-1']);
});
