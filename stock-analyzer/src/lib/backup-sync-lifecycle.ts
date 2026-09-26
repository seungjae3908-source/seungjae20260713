export type BackupSessionLifecycle = {
  prepareForSessionEnd(): Promise<void>;
  resume(memberId: string): void;
};

let sessionLifecycle: BackupSessionLifecycle | null = null;

export function registerBackupSessionLifecycle(lifecycle: BackupSessionLifecycle): () => void {
  sessionLifecycle = lifecycle;
  return () => {
    if (sessionLifecycle === lifecycle) sessionLifecycle = null;
  };
}

export async function prepareBackupForSessionEnd(): Promise<void> {
  await sessionLifecycle?.prepareForSessionEnd();
}

export function resumeBackupForSession(memberId: string): void {
  if (!memberId) return;
  sessionLifecycle?.resume(memberId);
}

export class BackupMutationCoordinator {
  private active: Promise<void> | null = null;

  run(execute: () => Promise<void>): Promise<void> {
    if (this.active) return this.active;

    let task: Promise<void>;
    task = Promise.resolve()
      .then(execute)
      .finally(() => {
        if (this.active === task) this.active = null;
      });
    this.active = task;
    return task;
  }

  async drain(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await active.then(() => undefined, () => undefined);
  }

  hasActiveMutation(): boolean {
    return this.active !== null;
  }
}

export const backupMutationCoordinator = new BackupMutationCoordinator();
