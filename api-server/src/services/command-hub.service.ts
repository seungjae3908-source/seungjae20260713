import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 512 * 1024;
const DEFAULT_LOG_LINES = 120;
const MAX_LOG_LINES = 500;

const projectRoot = path.resolve(
  process.env.COMMAND_HUB_PROJECT_ROOT ?? process.cwd(),
);

const pm2AppName =
  process.env.COMMAND_HUB_PM2_APP?.trim() || 'stock-app';

const auditLogPath = path.resolve(
  process.env.COMMAND_HUB_AUDIT_LOG ??
    path.join(os.tmpdir(), 'command-hub-audit.jsonl'),
);

const SAFE_PM2_APP_NAME = /^[a-zA-Z0-9._-]{1,80}$/;

export type CommandHubAuditEvent = {
  action: string;
  success: boolean;
  remoteIp?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
};

export type CommandExecutionResult = {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

function clampInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

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
  const maxLength = 100_000;

  if (redacted.length <= maxLength) {
    return redacted;
  }

  return `${redacted.slice(0, maxLength)}\n...[OUTPUT_TRUNCATED]`;
}

function runFixedCommand(
  command: string,
  args: string[],
  options?: {
    timeoutMs?: number;
    cwd?: string;
  },
): Promise<CommandExecutionResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options?.cwd ?? projectRoot,
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        env: process.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const errorWithCode = error as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
        };

        const numericExitCode =
          typeof errorWithCode?.code === 'number'
            ? errorWithCode.code
            : error
              ? 1
              : 0;

        resolve({
          command,
          args,
          exitCode: numericExitCode,
          stdout: trimOutput(stdout ?? ''),
          stderr: trimOutput(
            `${stderr ?? ''}${
              error && !stderr ? `\n${error.message}` : ''
            }`,
          ).trim(),
          durationMs: Date.now() - startedAt,
        });
      },
    );
  });
}

function assertSafePm2AppName(): void {
  if (!SAFE_PM2_APP_NAME.test(pm2AppName)) {
    throw new Error('COMMAND_HUB_PM2_APP contains invalid characters.');
  }
}

export function getCommandHubConfig() {
  return {
    mode: 'read-only' as const,
    projectRoot,
    pm2AppName,
    auditLogPath,
    writeActionsEnabled: false,
  };
}

export function getSystemStatus() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
    totalMemoryBytes: totalMemory,
    freeMemoryBytes: freeMemory,
    usedMemoryBytes: totalMemory - freeMemory,
    systemUptimeSeconds: os.uptime(),
    apiProcess: {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: process.uptime(),
      memoryUsage: process.memoryUsage(),
    },
    checkedAt: new Date().toISOString(),
  };
}

export async function getDiskStatus(): Promise<CommandExecutionResult> {
  return runFixedCommand('df', ['-h', projectRoot]);
}

export async function getGitStatus() {
  const [status, branch, commit, recentCommits] = await Promise.all([
    runFixedCommand('git', ['-C', projectRoot, 'status', '--short', '--branch']),
    runFixedCommand('git', ['-C', projectRoot, 'branch', '--show-current']),
    runFixedCommand('git', ['-C', projectRoot, 'rev-parse', 'HEAD']),
    runFixedCommand('git', [
      '-C',
      projectRoot,
      'log',
      '-5',
      '--date=iso-strict',
      '--pretty=format:%h%x09%ad%x09%an%x09%s',
    ]),
  ]);

  return {
    projectRoot,
    branch: branch.stdout.trim(),
    commit: commit.stdout.trim(),
    status,
    recentCommits,
    checkedAt: new Date().toISOString(),
  };
}

export async function getPm2Status() {
  assertSafePm2AppName();

  const result = await runFixedCommand('pm2', ['jlist']);

  if (result.exitCode !== 0) {
    return {
      ok: false,
      pm2AppName,
      command: result,
      processes: [],
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    const processes = parsed.map((item) => {
      const pm2Env = (item.pm2_env ?? {}) as Record<string, unknown>;
      const monitor = (item.monit ?? {}) as Record<string, unknown>;

      return {
        name: item.name,
        pmId: item.pm_id,
        pid: item.pid,
        status: pm2Env.status,
        version: pm2Env.version,
        restartCount: pm2Env.restart_time,
        unstableRestarts: pm2Env.unstable_restarts,
        startedAtEpochMs: pm2Env.pm_uptime,
        cpuPercent: monitor.cpu,
        memoryBytes: monitor.memory,
      };
    });

    return {
      ok: true,
      pm2AppName,
      processes,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      pm2AppName,
      command: {
        ...result,
        stdout: '[PM2_JSON_PARSE_FAILED]',
      },
      processes: [],
      error: error instanceof Error ? error.message : 'Unknown parse error',
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function getPm2Logs(requestedLines?: unknown) {
  assertSafePm2AppName();

  const lines = clampInteger(
    requestedLines,
    DEFAULT_LOG_LINES,
    20,
    MAX_LOG_LINES,
  );

  const command = await runFixedCommand(
    'pm2',
    [
      'logs',
      pm2AppName,
      '--nostream',
      '--raw',
      '--lines',
      String(lines),
    ],
    { timeoutMs: 15_000 },
  );

  return {
    pm2AppName,
    lines,
    command,
    checkedAt: new Date().toISOString(),
  };
}

export async function getReadOnlySnapshot(requestedLines?: unknown) {
  const [disk, git, pm2, logs] = await Promise.all([
    getDiskStatus(),
    getGitStatus(),
    getPm2Status(),
    getPm2Logs(requestedLines),
  ]);

  return {
    mode: 'read-only' as const,
    writeActionsEnabled: false,
    system: getSystemStatus(),
    disk,
    git,
    pm2,
    logs,
    checkedAt: new Date().toISOString(),
  };
}

export async function writeCommandHubAuditEvent(
  event: CommandHubAuditEvent,
): Promise<void> {
  const entry = {
    time: new Date().toISOString(),
    ...event,
  };

  try {
    await mkdir(path.dirname(auditLogPath), { recursive: true });
    await appendFile(auditLogPath, `${JSON.stringify(entry)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (error) {
    console.error(
      '[command-hub] failed to write audit log:',
      error instanceof Error ? error.message : error,
    );
  }
}
