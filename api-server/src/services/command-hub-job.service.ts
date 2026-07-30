import { execFile } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const projectRoot = path.resolve(
  process.env.COMMAND_HUB_PROJECT_ROOT ?? process.cwd(),
);

const apiServerRoot = path.resolve(
  process.env.COMMAND_HUB_API_SERVER_ROOT ??
    path.join(projectRoot, 'api-server'),
);

const runnerEnabled =
  process.env.COMMAND_HUB_RUNNER_ENABLED?.trim().toLowerCase() === 'true';

const MAX_OUTPUT_LENGTH = 120_000;
const MAX_JOBS = 50;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export const commandHubCheckActions = [
  'typecheck',
  'build-server',
  'build-all',
] as const;

export type CommandHubCheckAction =
  (typeof commandHubCheckActions)[number];

export type CommandHubJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out';

export type CommandHubJob = {
  id: string;
  action: CommandHubCheckAction;
  status: CommandHubJobStatus;
  command: string;
  args: string[];
  cwd: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

type JobDefinition = {
  command: 'pnpm';
  args: string[];
  cwd: string;
  timeoutMs: number;
};

const jobs = new Map<string, CommandHubJob>();
const queue: string[] = [];
let activeJobId: string | null = null;

function redactSecrets(input: string): string {
  return input
    .replace(
      /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:api[_-]?key|secret|token|password|passwd|anon[_-]?key|service[_-]?role[_-]?key)\s*[:=]\s*)["']?[^\s,"'}]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g,
      '[REDACTED_JWT]',
    )
    .replace(
      /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
      '[REDACTED_PRIVATE_KEY]',
    );
}

function trimOutput(input: string): string {
  const redacted = redactSecrets(input);

  if (redacted.length <= MAX_OUTPUT_LENGTH) {
    return redacted;
  }

  return `${redacted.slice(0, MAX_OUTPUT_LENGTH)}\n...[OUTPUT_TRUNCATED]`;
}

function isCheckAction(value: unknown): value is CommandHubCheckAction {
  return (
    typeof value === 'string' &&
    commandHubCheckActions.includes(value as CommandHubCheckAction)
  );
}

function getJobDefinition(action: CommandHubCheckAction): JobDefinition {
  switch (action) {
    case 'typecheck':
      return {
        command: 'pnpm',
        args: ['--dir', apiServerRoot, 'run', 'typecheck'],
        cwd: projectRoot,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      };

    case 'build-server':
      return {
        command: 'pnpm',
        args: ['--dir', apiServerRoot, 'run', 'build:server'],
        cwd: projectRoot,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      };

    case 'build-all':
      return {
        command: 'pnpm',
        args: ['--dir', apiServerRoot, 'run', 'build'],
        cwd: projectRoot,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      };
  }
}

function pruneOldJobs(): void {
  if (jobs.size <= MAX_JOBS) {
    return;
  }

  const completed = [...jobs.values()]
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  while (jobs.size > MAX_JOBS && completed.length > 0) {
    const oldest = completed.shift();

    if (oldest) {
      jobs.delete(oldest.id);
    }
  }
}

function runJobProcess(
  definition: JobDefinition,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    execFile(
      definition.command,
      definition.args,
      {
        cwd: definition.cwd,
        timeout: definition.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const processError = error as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
          signal?: NodeJS.Signals;
        };

        const timedOut = Boolean(
          processError?.killed || processError?.signal === 'SIGTERM',
        );

        const exitCode =
          typeof processError?.code === 'number'
            ? processError.code
            : error
              ? 1
              : 0;

        resolve({
          exitCode,
          stdout: trimOutput(stdout ?? ''),
          stderr: trimOutput(
            `${stderr ?? ''}${
              error && !stderr ? `\n${error.message}` : ''
            }`,
          ).trim(),
          timedOut,
        });
      },
    );
  });
}

async function executeJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);

  if (!job) {
    activeJobId = null;
    drainQueue();
    return;
  }

  activeJobId = jobId;
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  const startedAt = Date.now();
  const definition = getJobDefinition(job.action);
  const result = await runJobProcess(definition);

  job.durationMs = Date.now() - startedAt;
  job.finishedAt = new Date().toISOString();
  job.exitCode = result.exitCode;
  job.stdout = result.stdout;
  job.stderr = result.stderr;
  job.status = result.timedOut
    ? 'timed_out'
    : result.exitCode === 0
      ? 'succeeded'
      : 'failed';

  activeJobId = null;
  pruneOldJobs();
  drainQueue();
}

function drainQueue(): void {
  if (activeJobId || queue.length === 0) {
    return;
  }

  const nextJobId = queue.shift();

  if (!nextJobId) {
    return;
  }

  setImmediate(() => {
    void executeJob(nextJobId);
  });
}

export function getCommandHubRunnerConfig() {
  return {
    enabled: runnerEnabled,
    mode: 'fixed-checks' as const,
    concurrency: 1,
    actions: [...commandHubCheckActions],
    projectRoot,
    apiServerRoot,
  };
}

export function createCheckJob(actionValue: unknown): CommandHubJob {
  if (!runnerEnabled) {
    throw new Error('COMMAND_HUB_RUNNER_DISABLED');
  }

  if (!isCheckAction(actionValue)) {
    throw new Error('COMMAND_HUB_INVALID_CHECK_ACTION');
  }

  const definition = getJobDefinition(actionValue);
  const job: CommandHubJob = {
    id: randomUUID(),
    action: actionValue,
    status: 'queued',
    command: definition.command,
    args: [...definition.args],
    cwd: definition.cwd,
    createdAt: new Date().toISOString(),
  };

  jobs.set(job.id, job);
  queue.push(job.id);
  pruneOldJobs();
  drainQueue();

  return { ...job, args: [...job.args] };
}

export function getCheckJob(jobId: string): CommandHubJob | null {
  const job = jobs.get(jobId);

  if (!job) {
    return null;
  }

  return { ...job, args: [...job.args] };
}

export function listCheckJobs(): CommandHubJob[] {
  return [...jobs.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((job) => ({ ...job, args: [...job.args] }));
}
