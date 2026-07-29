import { constants } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LOCK_VERSION = 1 as const;
const DEFAULT_STALE_MS = 120_000;
const MIN_STALE_MS = 10_000;
const MAX_STALE_MS = 30 * 60_000;

interface LockRecord {
  version: typeof LOCK_VERSION;
  name: string;
  pid: number;
  token: string;
  createdAt: string;
}

export interface WorkerLock {
  name: string;
  path: string;
  release: () => Promise<void>;
}

export class WorkerAlreadyRunningError extends Error {
  readonly code = 'WORKER_ALREADY_RUNNING';
  readonly exitCode = 73;

  constructor(readonly workerName: string) {
    super(`${workerName} already has an active process`);
    this.name = 'WorkerAlreadyRunningError';
  }
}

function boundedStaleMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_STALE_MS;
  return Math.max(MIN_STALE_MS, Math.min(MAX_STALE_MS, Math.trunc(parsed)));
}

function safeLockName(value: string): string {
  const name = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) throw new Error('WORKER_LOCK_NAME_REQUIRED');
  return name.slice(0, 80);
}

function lockDirectory(): string {
  const configured = process.env.WORKER_LOCK_DIR?.trim();
  if (configured) return path.resolve(configured);

  const cwd = process.cwd();
  const apiRoot =
    path.basename(cwd) === 'api-server' ? cwd : path.join(cwd, 'api-server');
  return path.join(apiRoot, 'data', 'worker', 'locks');
}

function heartbeatPath(lockPath: string, token: string): string {
  return `${lockPath}.${token}.heartbeat`;
}

function isRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<LockRecord>;
  return Boolean(
    row.version === LOCK_VERSION &&
      row.name &&
      Number.isInteger(row.pid) &&
      Number(row.pid) > 0 &&
      row.token &&
      row.createdAt,
  );
}

async function readRecord(lockPath: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
    return code === 'EPERM';
  }
}

async function heartbeatIsFresh(
  lockPath: string,
  record: LockRecord,
  staleMs: number,
): Promise<boolean> {
  try {
    const raw = await readFile(heartbeatPath(lockPath, record.token), 'utf8');
    const updatedAt = Date.parse(raw.trim());
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= staleMs;
  } catch {
    const createdAt = Date.parse(record.createdAt);
    return Number.isFinite(createdAt) && Date.now() - createdAt <= staleMs;
  }
}

async function activeLock(
  lockPath: string,
  staleMs: number,
): Promise<{ active: boolean; record: LockRecord | null }> {
  const record = await readRecord(lockPath);
  if (!record) return { active: false, record: null };

  const [alive, fresh] = await Promise.all([
    Promise.resolve(pidExists(record.pid)),
    heartbeatIsFresh(lockPath, record, staleMs),
  ]);
  return { active: alive && fresh, record };
}

async function retireStaleLock(
  lockPath: string,
  record: LockRecord | null,
): Promise<void> {
  const retired = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, retired);
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
    if (code === 'ENOENT') return;
    throw error;
  }

  await rm(retired, { force: true });
  if (record?.token) {
    await rm(heartbeatPath(lockPath, record.token), { force: true });
  }
}

export async function acquireWorkerLock(
  workerName: string,
): Promise<WorkerLock> {
  const name = safeLockName(workerName);
  const directory = lockDirectory();
  const lockPath = path.join(directory, `${name}.lock`);
  const staleMs = boundedStaleMs(process.env.WORKER_LOCK_STALE_MS);
  const token = randomUUID();
  const record: LockRecord = {
    version: LOCK_VERSION,
    name,
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  };

  await mkdir(directory, { recursive: true });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8');
      } finally {
        await handle.close();
      }

      const ownedHeartbeat = heartbeatPath(lockPath, token);
      await writeFile(ownedHeartbeat, new Date().toISOString(), {
        encoding: 'utf8',
        mode: 0o600,
      });

      const heartbeatMs = Math.max(
        1_000,
        Math.min(30_000, Math.trunc(staleMs / 3)),
      );
      const heartbeat = setInterval(() => {
        void writeFile(ownedHeartbeat, new Date().toISOString(), 'utf8').catch(
          () => undefined,
        );
      }, heartbeatMs);
      heartbeat.unref();

      let released = false;
      return {
        name,
        path: lockPath,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);

          const current = await readRecord(lockPath);
          if (current?.token === token) {
            await rm(lockPath, { force: true });
          }
          await rm(ownedHeartbeat, { force: true });
        },
      };
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
      if (code !== 'EEXIST') throw error;

      const existing = await activeLock(lockPath, staleMs);
      if (existing.active) throw new WorkerAlreadyRunningError(name);
      await retireStaleLock(lockPath, existing.record);
    }
  }

  throw new Error(`WORKER_LOCK_ACQUIRE_RETRY_EXHAUSTED:${name}`);
}
