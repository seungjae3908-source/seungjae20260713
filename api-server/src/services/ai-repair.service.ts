// AI_REPAIR_COST_CONSENT_V1
// AI_REPAIR_LIVE_DIAGNOSTIC_V1
// AI_REPAIR_HISTORY_SETTINGS_V1
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import { deliverMemberNotification } from './notification.service';
import type {
  AiRepairAttempt,
  AiRepairChangedFile,
  AiRepairCheckName,
  AiRepairCheckResult,
  AiRepairCostEstimate,
  AiRepairCostHistoryItem,
  AiRepairCostHistoryPage,
  AiRepairCostSummary,
  AiRepairFeatureSettings,
  AiRepairJob,
  AiRepairJobKind,
  AiRepairPublicConfig,
  AiRepairUsage,
} from '../types/ai-repair';

const CHECKS: Array<{
  name: AiRepairCheckName;
  label: string;
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
}> = [
  {
    name: 'front-typecheck',
    label: '프론트 TypeScript 검사',
    cwd: '.',
    command: process.env.AI_REPAIR_PNPM_BIN?.trim() || 'pnpm',
    args: ['--dir', 'stock-analyzer', 'run', 'typecheck'],
    timeoutMs: 8 * 60_000,
  },
  {
    name: 'api-typecheck',
    label: '백엔드 TypeScript 검사',
    cwd: '.',
    command: process.env.AI_REPAIR_PNPM_BIN?.trim() || 'pnpm',
    args: ['--dir', 'api-server', 'run', 'typecheck'],
    timeoutMs: 8 * 60_000,
  },
  {
    name: 'front-build',
    label: '프론트 프로덕션 빌드',
    cwd: '.',
    command: process.env.AI_REPAIR_PNPM_BIN?.trim() || 'pnpm',
    args: ['--dir', 'stock-analyzer', 'run', 'build'],
    timeoutMs: 12 * 60_000,
  },
  {
    name: 'api-build',
    label: '백엔드 프로덕션 빌드',
    cwd: 'api-server',
    command: process.execPath,
    args: ['build.mjs'],
    timeoutMs: 8 * 60_000,
  },
];

const ACTIVE_STATUSES = new Set([
  'queued',
  'preparing',
  'diagnosing',
  'repairing',
  'verifying',
  'applying',
]);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const MAX_LOG_LINES = 1_200;
const MAX_LOG_CHARS = 8_000;
const MAX_COMMAND_OUTPUT = 160_000;
const MAX_AI_CONTEXT_CHARS = 600_000;
const MAX_AI_FILE_CHARS = 180_000;
const MAX_AI_FILES = 12;

const jobs = new Map<string, AiRepairJob>();
const queue: string[] = [];
const activeChildren = new Map<string, ChildProcessWithoutNullStreams>();
let workerStarted = false;
let workerRunning = false;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function now(): string {
  return new Date().toISOString();
}

function findWorkspaceRoot(start: string): string {
  let current = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(current, 'pnpm-workspace.yaml')) &&
      fs.existsSync(path.join(current, 'api-server')) &&
      fs.existsSync(path.join(current, 'stock-analyzer'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(start, '..');
}

function dataDir(): string {
  return path.resolve(
    process.env.AI_REPAIR_DATA_DIR?.trim() ||
      path.join(findWorkspaceRoot(process.cwd()), '.ai-repair-data'),
  );
}

function jobsDir(): string {
  return path.join(dataDir(), 'jobs');
}

function workspacesDir(): string {
  return path.join(dataDir(), 'workspaces');
}

function repoPath(): string {
  return path.resolve(
    process.env.AI_REPAIR_REPO_PATH?.trim() || findWorkspaceRoot(process.cwd()),
  );
}

function deployScriptPath(): string | null {
  const value = process.env.AI_REPAIR_DEPLOY_SCRIPT?.trim();
  return value ? path.resolve(value) : null;
}

function baseBranch(): string {
  return process.env.AI_REPAIR_BASE_BRANCH?.trim() || 'v8-ai-live';
}

function maxAttempts(): number {
  const configured = Number(process.env.AI_REPAIR_MAX_ATTEMPTS ?? 5);
  return clamp(Number.isFinite(configured) ? Math.floor(configured) : 5, 1, 10);
}

function isEnabled(): boolean {
  return process.env.AI_REPAIR_ENABLED === 'true';
}


function repairModel(): string {
  return process.env.OPENAI_REPAIR_MODEL?.trim() || 'gpt-5.1';
}

function configuredRate(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function costRates() {
  return {
    model: repairModel(),
    inputUsdPerMillion: configuredRate('OPENAI_REPAIR_INPUT_USD_PER_1M', 1.25),
    cachedInputUsdPerMillion: configuredRate('OPENAI_REPAIR_CACHED_INPUT_USD_PER_1M', 0.125),
    outputUsdPerMillion: configuredRate('OPENAI_REPAIR_OUTPUT_USD_PER_1M', 10),
  };
}

function roundCost(value: number, digits = 6): number {
  const multiplier = 10 ** digits;
  return Math.round(Math.max(0, value) * multiplier) / multiplier;
}

function calculateCost(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const rates = costRates();
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);

  return roundCost(
    (uncachedInput / 1_000_000) * rates.inputUsdPerMillion +
      (cachedInputTokens / 1_000_000) * rates.cachedInputUsdPerMillion +
      (outputTokens / 1_000_000) * rates.outputUsdPerMillion,
  );
}

function monthKey(value = now()): string {
  return value.slice(0, 7);
}

function costLedgerFile(): string {
  return path.join(dataDir(), 'cost-ledger.jsonl');
}


const DEFAULT_FEATURE_SETTINGS: Omit<AiRepairFeatureSettings, 'updatedAt'> = {
  freeDiagnosisEnabled: true,
  paidDiagnosisEnabled: true,
  improvementEnabled: true,
};

function featureSettingsFile(): string {
  return path.join(dataDir(), 'feature-settings.json');
}

export function getAiRepairFeatureSettings(): AiRepairFeatureSettings {
  ensureDirectories();

  const file = featureSettingsFile();

  if (!fs.existsSync(file)) {
    return {
      ...DEFAULT_FEATURE_SETTINGS,
      updatedAt: now(),
    };
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(file, 'utf8'),
    ) as Partial<AiRepairFeatureSettings>;

    return {
      freeDiagnosisEnabled:
        typeof parsed.freeDiagnosisEnabled === 'boolean'
          ? parsed.freeDiagnosisEnabled
          : true,
      paidDiagnosisEnabled:
        typeof parsed.paidDiagnosisEnabled === 'boolean'
          ? parsed.paidDiagnosisEnabled
          : true,
      improvementEnabled:
        typeof parsed.improvementEnabled === 'boolean'
          ? parsed.improvementEnabled
          : true,
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : now(),
    };
  } catch {
    return {
      ...DEFAULT_FEATURE_SETTINGS,
      updatedAt: now(),
    };
  }
}

export function updateAiRepairFeatureSettings(
  input: Partial<
    Pick<
      AiRepairFeatureSettings,
      | 'freeDiagnosisEnabled'
      | 'paidDiagnosisEnabled'
      | 'improvementEnabled'
    >
  >,
): AiRepairFeatureSettings {
  const current = getAiRepairFeatureSettings();

  const next: AiRepairFeatureSettings = {
    freeDiagnosisEnabled:
      typeof input.freeDiagnosisEnabled === 'boolean'
        ? input.freeDiagnosisEnabled
        : current.freeDiagnosisEnabled,
    paidDiagnosisEnabled:
      typeof input.paidDiagnosisEnabled === 'boolean'
        ? input.paidDiagnosisEnabled
        : current.paidDiagnosisEnabled,
    improvementEnabled:
      typeof input.improvementEnabled === 'boolean'
        ? input.improvementEnabled
        : current.improvementEnabled,
    updatedAt: now(),
  };

  const target = featureSettingsFile();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(
    temp,
    `${JSON.stringify(next, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  fs.renameSync(temp, target);

  return next;
}


export function estimateAiRepairCost(input: {
  kind: AiRepairJobKind;
  request: string;
  jobId?: string;
  paid?: boolean;
}): AiRepairCostEstimate {
  const model = repairModel();

  if (
    input.kind === 'diagnosis' &&
    !input.jobId &&
    input.paid !== true
  ) {
    return {
      currency: 'USD',
      model,
      free: true,
      minUsd: 0,
      likelyUsd: 0,
      maxUsd: 0,
      maxAttempts: 0,
      note: 'TypeScript·빌드·격리 서버 검사만 실행합니다. 오류가 발견되어도 AI 수정은 별도 승인을 받기 전까지 실행하지 않습니다.',
    };
  }

  const existing = input.jobId ? jobs.get(input.jobId) : undefined;

  if (input.jobId && !existing) {
    throw new Error('비용을 계산할 AI 복구 작업을 찾을 수 없습니다.');
  }

  const request = `${input.request || existing?.request || ''}`.trim();
  const failedChecks = existing?.checks.filter((item) => !item.ok) ?? [];
  const diagnosticChars = failedChecks.reduce(
    (total, item) => total + item.output.length,
    0,
  );

  const complexityTerms = [
    '서버',
    '데이터베이스',
    '로그인',
    '권한',
    '배포',
    '차트',
    '실시간',
    'api',
    '오류',
    '리팩터링',
    '모바일',
    'pc',
    'ui',
  ];

  const lowerRequest = request.toLowerCase();
  const complexity = complexityTerms.filter((term) =>
    lowerRequest.includes(term),
  ).length;

  const estimatedInput = clamp(
    Math.round(
      28_000 +
        request.length * 24 +
        diagnosticChars / 4 +
        complexity * 9_000,
    ),
    25_000,
    180_000,
  );

  const estimatedOutput = clamp(
    Math.round(3_500 + request.length * 4 + complexity * 1_100),
    3_500,
    20_000,
  );

  const likelyAttempts = clamp(
    1 +
      Math.floor(complexity / 4) +
      (failedChecks.length >= 3 ? 1 : 0),
    1,
    Math.min(3, maxAttempts()),
  );

  const minUsd = calculateCost(
    Math.round(estimatedInput * 0.65),
    0,
    Math.round(estimatedOutput * 0.55),
  );

  const likelyUsd =
    calculateCost(estimatedInput, 0, estimatedOutput) * likelyAttempts;

  const maxUsd =
    calculateCost(
      Math.round(estimatedInput * 1.35),
      0,
      Math.round(estimatedOutput * 1.5),
    ) * maxAttempts();

  return {
    currency: 'USD',
    model,
    free: false,
    minUsd: roundCost(minUsd, 4),
    likelyUsd: roundCost(likelyUsd, 4),
    maxUsd: roundCost(maxUsd, 4),
    maxAttempts: maxAttempts(),
    note: '요청 길이·검사 오류·예상 수정 반복 횟수로 계산한 사전 추정치입니다. 실제 청구액은 사용 토큰에 따라 달라질 수 있습니다.',
  };
}

function recordOpenAiUsage(
  job: AiRepairJob,
  payload: unknown,
  model: string,
): void {
  if (!payload || typeof payload !== 'object') return;

  const usage = (payload as {
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      total_tokens?: unknown;
      input_tokens_details?: {
        cached_tokens?: unknown;
      };
    };
  }).usage;

  if (!usage) return;

  const inputTokens = Math.max(0, Number(usage.input_tokens) || 0);
  const cachedInputTokens = Math.max(
    0,
    Number(usage.input_tokens_details?.cached_tokens) || 0,
  );
  const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);
  const totalTokens = Math.max(
    0,
    Number(usage.total_tokens) || inputTokens + outputTokens,
  );

  if (inputTokens === 0 && outputTokens === 0) return;

  const entry: AiRepairUsage = {
    month: monthKey(),
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: calculateCost(
      inputTokens,
      cachedInputTokens,
      outputTokens,
    ),
    recordedAt: now(),
  };

  ensureDirectories();

  fs.appendFileSync(
    costLedgerFile(),
    `${JSON.stringify({
      jobId: job.id,
      createdBy: job.createdBy,
      ...entry,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  job.usage = [...(job.usage ?? []), entry];
  job.actualCostUsd = roundCost(
    (job.actualCostUsd ?? 0) + entry.estimatedCostUsd,
  );

  logJob(
    job,
    `OpenAI 사용량 기록: 입력 ${inputTokens}, 출력 ${outputTokens}, 예상 $${entry.estimatedCostUsd.toFixed(6)}`,
  );
}

export function getAiRepairCostSummary(
  requestedMonth?: string,
): AiRepairCostSummary {
  const month =
    requestedMonth && /^\d{4}-\d{2}$/.test(requestedMonth)
      ? requestedMonth
      : monthKey();

  let calls = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;

  const ledger = costLedgerFile();

  if (fs.existsSync(ledger)) {
    const lines = fs
      .readFileSync(ledger, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Partial<AiRepairUsage>;

        if (entry.month !== month) continue;

        calls += 1;
        inputTokens += Number(entry.inputTokens) || 0;
        cachedInputTokens += Number(entry.cachedInputTokens) || 0;
        outputTokens += Number(entry.outputTokens) || 0;
        estimatedCostUsd += Number(entry.estimatedCostUsd) || 0;
      } catch {
        // 손상된 한 줄은 건너뜁니다.
      }
    }
  }

  return {
    month,
    currency: 'USD',
    estimatedCostUsd: roundCost(estimatedCostUsd),
    calls,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    modelRates: costRates(),
  };
}


function createPagination(
  total: number,
  requestedPage: number,
  requestedPageSize: number,
): {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
} {
  const pageSize = clamp(
    Number.isFinite(requestedPageSize)
      ? Math.floor(requestedPageSize)
      : 10,
    1,
    100,
  );

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const page = clamp(
    Number.isFinite(requestedPage)
      ? Math.floor(requestedPage)
      : 1,
    1,
    totalPages,
  );

  return {
    page,
    pageSize,
    total,
    totalPages,
  };
}

export function getAiRepairCostHistoryPage(
  requestedPage = 1,
  requestedPageSize = 10,
): AiRepairCostHistoryPage {
  startAiRepairWorker();
  ensureDirectories();

  const aggregated = new Map<string, AiRepairCostHistoryItem>();
  const ledger = costLedgerFile();

  if (fs.existsSync(ledger)) {
    const lines = fs
      .readFileSync(ledger, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          jobId?: unknown;
          model?: unknown;
          inputTokens?: unknown;
          cachedInputTokens?: unknown;
          outputTokens?: unknown;
          totalTokens?: unknown;
          estimatedCostUsd?: unknown;
          recordedAt?: unknown;
        };

        const jobId = String(entry.jobId ?? '').trim();

        if (!jobId) continue;

        const job = jobs.get(jobId);
        const current = aggregated.get(jobId);

        const recordedAt =
          typeof entry.recordedAt === 'string'
            ? entry.recordedAt
            : now();

        const next: AiRepairCostHistoryItem = current ?? {
          jobId,
          title: job?.title ?? '삭제되거나 이전된 AI 작업',
          kind: job?.kind ?? 'diagnosis',
          model:
            typeof entry.model === 'string'
              ? entry.model
              : repairModel(),
          calls: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          recordedAt,
        };

        next.calls += 1;
        next.inputTokens += Number(entry.inputTokens) || 0;
        next.cachedInputTokens +=
          Number(entry.cachedInputTokens) || 0;
        next.outputTokens += Number(entry.outputTokens) || 0;
        next.totalTokens += Number(entry.totalTokens) || 0;
        next.estimatedCostUsd = roundCost(
          next.estimatedCostUsd +
            (Number(entry.estimatedCostUsd) || 0),
        );

        if (recordedAt > next.recordedAt) {
          next.recordedAt = recordedAt;
        }

        aggregated.set(jobId, next);
      } catch {
        // 손상된 비용 내역은 건너뜁니다.
      }
    }
  }

  const all = [...aggregated.values()].sort(
    (a, b) => b.recordedAt.localeCompare(a.recordedAt),
  );

  const pagination = createPagination(
    all.length,
    requestedPage,
    requestedPageSize,
  );

  const start =
    (pagination.page - 1) * pagination.pageSize;

  return {
    items: all.slice(start, start + pagination.pageSize),
    pagination,
  };
}

function jobFile(id: string): string {
  return path.join(jobsDir(), `${id}.json`);
}

function ensureDirectories(): void {
  fs.mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspacesDir(), { recursive: true, mode: 0o700 });
}

function redactSensitive(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[OPENAI_KEY_REDACTED]')
    .replace(/(github_pat_[A-Za-z0-9_]{12,})/g, '[GITHUB_TOKEN_REDACTED]')
    .replace(/(service_role[^\s"']*)/gi, '[SERVICE_ROLE_REDACTED]');
}

function cleanLog(value: string): string {
  return redactSensitive(value).slice(0, MAX_LOG_CHARS);
}

function persist(job: AiRepairJob): void {
  ensureDirectories();
  job.updatedAt = now();
  const target = jobFile(job.id);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
  jobs.set(job.id, job);
}

function logJob(job: AiRepairJob, message: string): void {
  job.logs.push(`[${now()}] ${cleanLog(message)}`);
  if (job.logs.length > MAX_LOG_LINES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  }
  persist(job);
}

function updateJob(
  job: AiRepairJob,
  input: Partial<Pick<AiRepairJob, 'status' | 'progress' | 'message' | 'error'>>,
): void {
  if (input.status) job.status = input.status;
  if (typeof input.progress === 'number') job.progress = clamp(Math.round(input.progress), 0, 100);
  if (typeof input.message === 'string') job.message = input.message;
  if (typeof input.error === 'string') job.error = cleanLog(input.error);
  persist(job);
}

function loadPersistedJobs(): void {
  ensureDirectories();
  for (const name of fs.readdirSync(jobsDir()).filter((value) => value.endsWith('.json'))) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir(), name), 'utf8')) as AiRepairJob;
      jobs.set(job.id, job);
      if (ACTIVE_STATUSES.has(job.status)) {
        job.currentCheck = undefined;
        job.status = job.status === 'applying' ? 'applying' : 'queued';
        job.message = job.status === 'applying'
          ? '서버 재시작 후 승인 작업 재개 대기'
          : '서버 재시작 후 작업 재개 대기';
        job.error = undefined;
        persist(job);
        queue.push(job.id);
      }
    } catch (error) {
      console.error('[ai-repair] invalid persisted job:', name, error);
    }
  }
}

function isGitRepository(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'));
}

function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function fileHash(filePath: string): string {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? sha256(fs.readFileSync(filePath))
    : sha256('');
}

function shellDisplay(command: string, args: string[]): string {
  return [command, ...args]
    .map((value) => (/^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(' ');
}

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
};

async function runCommand(
  job: AiRepairJob,
  cwd: string,
  command: string,
  args: string[],
  timeoutMs: number,
  options: { allowFailure?: boolean; quiet?: boolean } = {},
): Promise<CommandResult> {
  if (job.cancellationRequested) throw new Error('사용자가 작업 중단을 요청했습니다.');
  if (!options.quiet) logJob(job, `$ ${shellDisplay(command, args)}`);
  const started = Date.now();
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        CI: '1',
        FORCE_COLOR: '0',
        NODE_ENV: process.env.NODE_ENV || 'production',
      },
      shell: false,
      windowsHide: true,
    });
    activeChildren.set(job.id, child);
    let output = '';
    const append = (chunk: Buffer): void => {
      if (output.length >= MAX_COMMAND_OUTPUT) return;
      output += chunk.toString('utf8').slice(0, MAX_COMMAND_OUTPUT - output.length);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      activeChildren.delete(job.id);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      activeChildren.delete(job.id);
      const result: CommandResult = {
        ok: code === 0,
        exitCode: code,
        output: cleanLog(output || '(출력 없음)'),
        durationMs: Date.now() - started,
      };
      if (!options.quiet) logJob(job, result.output.slice(-MAX_LOG_CHARS));
      if (!result.ok && !options.allowFailure) {
        reject(new Error(`${shellDisplay(command, args)} 실패 (종료코드 ${String(code)})\n${result.output}`));
        return;
      }
      resolve(result);
    });
  });
}

async function gitRefExists(job: AiRepairJob, root: string, ref: string): Promise<boolean> {
  const result = await runCommand(job, root, 'git', ['rev-parse', '--verify', '--quiet', ref], 30_000, {
    allowFailure: true,
    quiet: true,
  });
  return result.ok;
}

function copyFilter(source: string): boolean {
  const normalized = source.replace(/\\/g, '/');
  const base = path.basename(source);
  if (['node_modules', '.git', '.ai-repair-data', 'dist', '.cache'].includes(base)) return false;
  if (base === '.env' || base.startsWith('.env.')) return false;
  if (/\/(\.ssh|credentials|secrets?|certificates?|keystore)(\/|$)/i.test(normalized)) return false;
  return true;
}

function packageFolders(root: string): string[] {
  const folders = [root, path.join(root, 'stock-analyzer'), path.join(root, 'api-server')];
  const packages = path.join(root, 'packages');
  if (fs.existsSync(packages)) {
    for (const name of fs.readdirSync(packages)) {
      const candidate = path.join(packages, name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) folders.push(candidate);
    }
  }
  return folders;
}

function linkNodeModules(sourceRoot: string, workspace: string): void {
  const sourceFolders = packageFolders(sourceRoot);
  for (const sourceFolder of sourceFolders) {
    const relative = path.relative(sourceRoot, sourceFolder);
    const sourceModules = path.join(sourceFolder, 'node_modules');
    if (!fs.existsSync(sourceModules)) continue;
    const targetModules = path.join(workspace, relative, 'node_modules');
    try {
      fs.rmSync(targetModules, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(targetModules), { recursive: true });
      fs.symlinkSync(sourceModules, targetModules, 'junction');
    } catch (error) {
      console.warn('[ai-repair] node_modules link failed:', targetModules, error);
    }
  }
}

async function prepareWorkspace(job: AiRepairJob): Promise<string> {
  const sourceRoot = repoPath();
  if (!fs.existsSync(sourceRoot)) throw new Error(`AI_REPAIR_REPO_PATH가 존재하지 않습니다: ${sourceRoot}`);
  const workspace = path.join(workspacesDir(), job.id);
  if (fs.existsSync(path.join(workspace, 'package.json'))) {
    linkNodeModules(sourceRoot, workspace);
    job.workspacePath = workspace;
    persist(job);
    return workspace;
  }

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(workspace), { recursive: true, mode: 0o700 });

  if (isGitRepository(sourceRoot)) {
    if (process.env.AI_REPAIR_GIT_FETCH !== 'false') {
      await runCommand(job, sourceRoot, 'git', ['fetch', 'origin', baseBranch()], 3 * 60_000, {
        allowFailure: true,
      });
    }
    const remoteRef = `origin/${baseBranch()}`;
    const baseRef = (await gitRefExists(job, sourceRoot, remoteRef))
      ? remoteRef
      : (await gitRefExists(job, sourceRoot, baseBranch()))
        ? baseBranch()
        : 'HEAD';
    const branch = `ai-repair/${job.id.replace(/[^A-Za-z0-9._-]/g, '-')}`;
    job.branch = branch;
    const add = await runCommand(
      job,
      sourceRoot,
      'git',
      ['worktree', 'add', '--force', '-b', branch, workspace, baseRef],
      3 * 60_000,
      { allowFailure: true },
    );
    if (!add.ok) {
      await runCommand(job, sourceRoot, 'git', ['branch', '-D', branch], 30_000, { allowFailure: true });
      await runCommand(
        job,
        sourceRoot,
        'git',
        ['worktree', 'add', '--force', '-b', branch, workspace, baseRef],
        3 * 60_000,
      );
    }
  } else {
    logJob(job, 'Git 저장소가 없어 격리 복사본을 생성합니다. Git 브랜치·push는 비활성화됩니다.');
    fs.cpSync(sourceRoot, workspace, { recursive: true, filter: copyFilter });
  }

  linkNodeModules(sourceRoot, workspace);
  job.workspacePath = workspace;
  persist(job);
  return workspace;
}

function checkRow(
  name: AiRepairCheckName,
  label: string,
  result: CommandResult,
  startedAt: string,
): AiRepairCheckResult {
  return {
    name,
    label,
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output: result.output,
    startedAt,
    completedAt: now(),
  };
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function runApplicationSmoke(
  job: AiRepairJob,
  workspace: string,
): Promise<AiRepairCheckResult[]> {
  const port = await reservePort();
  const startedAt = now();
  const started = Date.now();
  const child = spawn(process.execPath, ['api-server/dist/index.mjs'], {
    cwd: workspace,
    env: {
      ...process.env,
      PORT: String(port),
      API_PORT: String(port),
      AI_REPAIR_ENABLED: 'false',
      NODE_ENV: 'production',
      CI: '1',
      FORCE_COLOR: '0',
    },
    shell: false,
    windowsHide: true,
  });
  activeChildren.set(job.id, child);
  let output = '';
  const append = (chunk: Buffer): void => {
    if (output.length < MAX_COMMAND_OUTPUT) {
      output += chunk.toString('utf8').slice(0, MAX_COMMAND_OUTPUT - output.length);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  let apiOk = false;
  let apiError = '';
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (job.cancellationRequested) throw new Error('사용자가 작업 중단을 요청했습니다.');
      if (child.exitCode !== null) {
        apiError = `격리 API 서버가 조기 종료되었습니다. 종료코드 ${String(child.exitCode)}`;
        break;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        const payload = await response.json().catch(() => null) as { ok?: unknown } | null;
        if (response.ok && payload?.ok === true) {
          apiOk = true;
          break;
        }
        apiError = `격리 API 상태 응답 실패: HTTP ${response.status}`;
      } catch (error) {
        apiError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    const results: AiRepairCheckResult[] = [
      checkRow(
        'api-smoke',
        '격리 API 기동·상태 검사',
        {
          ok: apiOk,
          exitCode: apiOk ? 0 : child.exitCode,
          output: cleanLog(`${apiError ? `${apiError}
` : ''}${output || '(서버 출력 없음)'}`),
          durationMs: Date.now() - started,
        },
        startedAt,
      ),
    ];

    const chromium = process.env.AI_REPAIR_CHROMIUM_BIN?.trim();
    if (apiOk && chromium) {
      const browserStartedAt = now();
      if (!path.isAbsolute(chromium) || !fs.existsSync(chromium)) {
        results.push(checkRow(
          'browser-smoke',
          '격리 브라우저 화면 검사',
          { ok: false, exitCode: null, output: 'AI_REPAIR_CHROMIUM_BIN 경로가 올바르지 않습니다.', durationMs: 0 },
          browserStartedAt,
        ));
      } else {
        const browser = await runCommand(
          job,
          workspace,
          chromium,
          [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--virtual-time-budget=12000',
            '--dump-dom',
            `http://127.0.0.1:${port}/settings`,
          ],
          90_000,
          { allowFailure: true },
        );
        const domOk = browser.ok && /<html[\s>]/i.test(browser.output) && /id=["']root["']/i.test(browser.output);
        results.push(checkRow(
          'browser-smoke',
          '격리 브라우저 화면 검사',
          { ...browser, ok: domOk, output: domOk ? '설정 화면 DOM 로드 성공' : browser.output },
          browserStartedAt,
        ));
      }
    }
    return results;
  } finally {
    activeChildren.delete(job.id);
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 3_000).unref();
    }
  }
}

async function runChecks(job: AiRepairJob, workspace: string): Promise<AiRepairCheckResult[]> {
  const results: AiRepairCheckResult[] = [];
  for (let index = 0; index < CHECKS.length; index += 1) {
    if (job.cancellationRequested) throw new Error('사용자가 작업 중단을 요청했습니다.');
    const check = CHECKS[index];
    const startedAt = now();

    job.currentCheck = {
      name: check.name,
      label: check.label,
      startedAt,
    };
    job.progress = clamp(
      12 + Math.round((index / CHECKS.length) * 24),
      0,
      100,
    );
    job.message = `${check.label} 진단 중`;
    persist(job);

    const result = await runCommand(
      job,
      path.resolve(workspace, check.cwd),
      check.command,
      check.args,
      check.timeoutMs,
      { allowFailure: true },
    );

    if (job.cancellationRequested) {
      job.currentCheck = undefined;
      persist(job);
      throw new Error('사용자가 작업 중단을 요청했습니다.');
    }

    const row = checkRow(
      check.name,
      check.label,
      result,
      startedAt,
    );

    results.push(row);
    job.checks = results;

    if (!result.ok) {
      job.diagnosticErrors = [
        ...(job.diagnosticErrors ?? []).filter(
          (item) => item.name !== check.name,
        ),
        {
          name: check.name,
          label: check.label,
          output: result.output.slice(-20_000),
          detectedAt: now(),
        },
      ];
    }

    job.currentCheck = undefined;
    job.progress = clamp(
      18 + Math.round(((index + 1) / CHECKS.length) * 20),
      0,
      100,
    );
    job.message = `${check.label}: ${result.ok ? '성공' : '오류 발견'}`;
    persist(job);
  }
  if (results.every((item) => item.ok)) {
    const smoke = await runApplicationSmoke(job, workspace);
    results.push(...smoke);
    job.checks = results;
    job.message = smoke.every((item) => item.ok) ? '격리 실행 검사 성공' : '격리 실행 검사 실패';
    persist(job);
  }
  return results;
}

function normalizeSourcePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`허용되지 않은 파일 경로입니다: ${value}`);
  }
  const allowed = [
    /^stock-analyzer\/src\/.+\.(?:ts|tsx|js|jsx|json|css)$/,
    /^api-server\/src\/.+\.(?:ts|tsx|js|jsx|json)$/,
    /^packages\/[^/]+\/src\/.+\.(?:ts|tsx|js|jsx|json)$/,
  ].some((pattern) => pattern.test(normalized));
  if (!allowed) throw new Error(`AI가 수정할 수 없는 경로입니다: ${normalized}`);
  if (/\/(?:node_modules|dist|\.git|\.ssh|secrets?|credentials?|certificates?|keystore)\//i.test(`/${normalized}/`)) {
    throw new Error(`보안상 수정이 차단된 경로입니다: ${normalized}`);
  }
  return normalized;
}

function safetyCheckContent(relative: string, content: string): void {
  const forbidden = [
    /KIWOOM_AUTO_TRADE_ENABLED\s*=\s*true/i,
    /X-Auto-Trade-Key/i,
    /service_role/i,
    /process\.env\.[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY).*console/i,
    /rm\s+-rf\s+\//i,
    /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i,
  ];
  const hit = forbidden.find((pattern) => pattern.test(content));
  if (hit) throw new Error(`위험한 변경이 감지되어 차단했습니다: ${relative}`);
}

function listSourceFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.ai-repair-data', '.cache'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(root, absolute).replace(/\\/g, '/');
        if (/^(?:stock-analyzer|api-server)\/src\/.+\.(?:ts|tsx|js|jsx|json|css)$/.test(relative) ||
          /^packages\/[^/]+\/src\/.+\.(?:ts|tsx|js|jsx|json)$/.test(relative)) {
          output.push(relative);
        }
      }
      if (output.length >= 5_000) return;
    }
  };
  visit(root);
  return output;
}

function chooseContextFiles(workspace: string, request: string, diagnostics: AiRepairCheckResult[]): string[] {
  const all = listSourceFiles(workspace);
  const combined = `${request}\n${diagnostics.map((item) => item.output).join('\n')}`;
  const explicit = [...combined.matchAll(/(?:^|[\s("'])(?:(?:\.\/)?)(stock-analyzer|api-server|packages)\/[^\s:"')]+\.(?:ts|tsx|js|jsx|json|css)/g)]
    .map((match) => `${match[1]}/${match[0].trim().replace(/^\.\//, '').split(`${match[1]}/`)[1] ?? ''}`)
    .map((value) => value.replace(/[),.;]+$/, ''))
    .filter((value) => all.includes(value));
  const core = [
    'stock-analyzer/src/pages/more.tsx',
    'stock-analyzer/src/App.tsx',
    'api-server/src/routes/index.ts',
    'api-server/src/index.ts',
  ].filter((value) => all.includes(value));
  const terms = combined
    .toLowerCase()
    .split(/[^a-z0-9가-힣_.-]+/)
    .filter((term) => term.length >= 3)
    .slice(0, 120);
  const scored = all
    .map((file) => ({
      file,
      score: terms.reduce((score, term) => score + (file.toLowerCase().includes(term) ? 2 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return [...new Set([...explicit, ...core, ...scored.filter((item) => item.score > 0).map((item) => item.file), ...all])]
    .slice(0, MAX_AI_FILES);
}

function redactSourceForAi(content: string): string {
  return content
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[OPENAI_KEY_REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, '[GITHUB_TOKEN_REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[GITHUB_TOKEN_REDACTED]')
    .replace(/(service_role(?:_key)?\s*[:=]\s*["']?)[A-Za-z0-9._-]{20,}/gi, '$1[SERVICE_ROLE_REDACTED]')
    .replace(/((?:secret|password|private[_-]?key|access[_-]?token)\s*[:=]\s*["'])[^"'\n]{8,}(["'])/gi, '$1[SECRET_REDACTED]$2');
}

function buildContext(workspace: string, files: string[]): string {
  const parts: string[] = [];
  let total = 0;
  for (const relative of files) {
    const absolute = path.resolve(workspace, relative);
    if (!absolute.startsWith(`${path.resolve(workspace)}${path.sep}`)) continue;
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const content = redactSourceForAi(fs.readFileSync(absolute, 'utf8')).slice(0, MAX_AI_FILE_CHARS);
    if (total + content.length > MAX_AI_CONTEXT_CHARS) break;
    total += content.length;
    parts.push(`<file path="${relative}">\n${content}\n</file>`);
  }
  return parts.join('\n\n');
}

type AiRepairProposal = {
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  findings: string[];
  changes: Array<{
    path: string;
    explanation: string;
    operation: 'edit' | 'create';
    fullContent: string;
    edits: Array<{ search: string; replacement: string }>;
  }>;
};

function responseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const output = (payload as { output?: unknown[] }).output;
  if (!Array.isArray(output)) return '';
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'output_text') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') texts.push(text);
      }
    }
  }
  return texts.join('\n');
}

async function askAiForRepair(
  job: AiRepairJob,
  workspace: string,
  diagnostics: AiRepairCheckResult[],
  attemptNumber: number,
): Promise<AiRepairProposal> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY가 설정되지 않아 자동 수정안을 만들 수 없습니다.');
  const model = repairModel();
  const files = chooseContextFiles(workspace, job.request, diagnostics);
  const context = buildContext(workspace, files);
  if (!context) throw new Error('AI가 읽을 수 있는 소스 파일을 찾지 못했습니다.');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['severity', 'summary', 'findings', 'changes'],
    properties: {
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      summary: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } },
      changes: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'explanation', 'operation', 'fullContent', 'edits'],
          properties: {
            path: { type: 'string' },
            explanation: { type: 'string' },
            operation: { type: 'string', enum: ['edit', 'create'] },
            fullContent: { type: 'string' },
            edits: {
              type: 'array',
              maxItems: 16,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['search', 'replacement'],
                properties: {
                  search: { type: 'string' },
                  replacement: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  };
  const diagnosticText = diagnostics
    .map((item) => `## ${item.label}: ${item.ok ? '성공' : '실패'}\n${item.output}`)
    .join('\n\n');
  logJob(job, `AI 수정안 생성 요청: ${files.length}개 파일, ${context.length}자 컨텍스트`);
  const response = await fetch('https://api.openai.com/v1/responses', {
    signal: AbortSignal.timeout(12 * 60_000),
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 30_000,
      text: {
        format: {
          type: 'json_schema',
          name: 'seungjae_ai_repair_proposal',
          strict: true,
          schema,
        },
      },
      instructions: [
        'You are a cautious senior TypeScript, React, Node.js and production reliability engineer.',
        'Return only the structured result.',
        'For existing files use operation=edit and provide small exact search/replacement edits. Each search must match exactly once in the supplied file. Set fullContent to an empty string for edits.',
        'For a new file use operation=create, provide complete UTF-8 fullContent, and set edits to an empty array.',
        'Keep unrelated behavior and UI unchanged and make the smallest safe change.',
        'Never read, print, modify, or request .env files, API keys, tokens, passwords, SSH keys, signing keys, node_modules, dist files, or files outside the supplied project.',
        'Never enable real stock or crypto orders, auto trading, payments, destructive database operations, arbitrary shell execution, or security bypasses.',
        'Only modify paths under stock-analyzer/src, api-server/src, or packages/*/src.',
        'Write summary, findings, and explanations in Korean.',
      ].join(' '),
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `작업 종류: ${job.kind}`,
                `사용자 요청: ${job.request}`,
                `현재 반복: ${attemptNumber}/${job.maxAttempts}`,
                `검사 결과:\n${diagnosticText}`,
                `읽은 파일:\n${context}`,
              ].join('\n\n'),
            },
          ],
        },
      ],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object'
      ? JSON.stringify((payload as { error?: unknown }).error ?? payload)
      : `HTTP ${response.status}`;
    throw new Error(`OpenAI 수정안 생성 실패: ${message}`);
  }
  const text = responseText(payload);
  if (!text) throw new Error('OpenAI 응답에 수정안 텍스트가 없습니다.');
  const parsed = JSON.parse(text) as AiRepairProposal;
  if (!Array.isArray(parsed.changes) || parsed.changes.length > 8) {
    throw new Error('AI 수정 파일 수가 허용 범위를 벗어났습니다.');
  }

  recordOpenAiUsage(job, payload, model);
  return parsed;
}

async function applyAiProposal(
  job: AiRepairJob,
  workspace: string,
  proposal: AiRepairProposal,
): Promise<AiRepairChangedFile[]> {
  const changes: AiRepairChangedFile[] = [];
  for (const proposed of proposal.changes) {
    const relative = normalizeSourcePath(proposed.path);
    const target = path.resolve(workspace, relative);
    const root = path.resolve(workspace);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`프로젝트 밖 경로가 차단되었습니다: ${relative}`);

    const existed = fs.existsSync(target);
    let nextContent = '';
    if (proposed.operation === 'create') {
      if (existed) throw new Error(`이미 존재하는 파일은 create로 만들 수 없습니다: ${relative}`);
      if (proposed.edits.length > 0) throw new Error(`새 파일에는 부분 수정 목록을 사용할 수 없습니다: ${relative}`);
      nextContent = proposed.fullContent;
    } else {
      if (!existed || !fs.statSync(target).isFile()) throw new Error(`수정할 기존 파일을 찾을 수 없습니다: ${relative}`);
      if (proposed.fullContent.trim()) throw new Error(`기존 파일 수정에는 전체 파일 덮어쓰기를 사용할 수 없습니다: ${relative}`);
      if (!Array.isArray(proposed.edits) || proposed.edits.length === 0 || proposed.edits.length > 16) {
        throw new Error(`부분 수정 개수가 허용 범위를 벗어났습니다: ${relative}`);
      }
      nextContent = fs.readFileSync(target, 'utf8');
      for (const [index, edit] of proposed.edits.entries()) {
        if (!edit.search || edit.search.length > 120_000 || edit.replacement.length > 160_000) {
          throw new Error(`수정 조각 ${index + 1}의 크기 또는 검색문이 올바르지 않습니다: ${relative}`);
        }
        const first = nextContent.indexOf(edit.search);
        const last = nextContent.lastIndexOf(edit.search);
        if (first < 0) throw new Error(`수정 조각 ${index + 1}을 파일에서 찾지 못했습니다: ${relative}`);
        if (first !== last) throw new Error(`수정 조각 ${index + 1}이 여러 곳과 일치하여 안전상 차단했습니다: ${relative}`);
        nextContent = `${nextContent.slice(0, first)}${edit.replacement}${nextContent.slice(first + edit.search.length)}`;
      }
    }

    if (nextContent.length > 1_500_000) throw new Error(`수정 파일이 너무 큽니다: ${relative}`);
    safetyCheckContent(relative, nextContent);
    const beforeHash = fileHash(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, nextContent, 'utf8');
    fs.renameSync(temp, target);
    const afterHash = fileHash(target);
    if (beforeHash === afterHash) throw new Error(`실제 내용이 바뀌지 않은 수정안입니다: ${relative}`);

    let diff = '';
    if (isGitRepository(workspace)) {
      const diffResult = await runCommand(job, workspace, 'git', ['diff', '--', relative], 60_000, {
        allowFailure: true,
        quiet: true,
      });
      diff = diffResult.output;
      if (!diff.trim()) {
        const untracked = await runCommand(job, workspace, 'git', ['diff', '--no-index', '--', '/dev/null', relative], 60_000, {
          allowFailure: true,
          quiet: true,
        });
        diff = untracked.output;
      }
    }
    changes.push({
      path: relative,
      explanation: proposed.explanation.slice(0, 2_000),
      beforeHash,
      afterHash,
      diff: redactSensitive(diff).slice(0, 120_000),
    });
  }
  return changes;
}

async function commitVerifiedChanges(job: AiRepairJob, workspace: string): Promise<void> {
  if (!isGitRepository(workspace) || job.changedFiles.length === 0) return;
  await runCommand(job, workspace, 'git', ['config', 'user.name', 'Seungjae AI Repair'], 30_000);
  await runCommand(job, workspace, 'git', ['config', 'user.email', 'ai-repair@localhost'], 30_000);
  await runCommand(job, workspace, 'git', ['add', '--', ...job.changedFiles.map((item) => item.path)], 60_000);
  const status = await runCommand(job, workspace, 'git', ['diff', '--cached', '--name-only'], 30_000, { allowFailure: true });
  if (!status.output.trim()) throw new Error('검증된 변경 파일을 Git 스테이징에서 찾지 못했습니다.');
  await runCommand(
    job,
    workspace,
    'git',
    ['commit', '-m', `AI repair: ${job.title.slice(0, 120)}`],
    2 * 60_000,
  );
  const sha = await runCommand(job, workspace, 'git', ['rev-parse', 'HEAD'], 30_000, { quiet: true });
  job.commitSha = sha.output.trim().split(/\s+/)[0];
  persist(job);
}

async function sendJobNotification(
  job: AiRepairJob,
  title: string,
  body: string,
): Promise<void> {
  try {
    const result = await deliverMemberNotification({
      memberId: job.createdBy,
      type: 'system',
      title,
      body,
      url: `/settings?aiRepairJob=${encodeURIComponent(job.id)}`,
      app: true,
      push: true,
      eventKey: `ai-repair:${job.id}:${job.status}`,
      metadata: { jobId: job.id, status: job.status },
    });
    job.notification = { sentAt: now(), ...result };
    persist(job);
  } catch (error) {
    logJob(job, `푸시 알림 전송 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function allChecksPassed(checks: AiRepairCheckResult[]): boolean {
  const expected: AiRepairCheckName[] = [
    ...CHECKS.map((item) => item.name),
    'api-smoke',
    ...(process.env.AI_REPAIR_CHROMIUM_BIN?.trim() ? ['browser-smoke' as const] : []),
  ];
  return expected.every((name) => checks.some((item) => item.name === name && item.ok));
}

async function processRepairJob(job: AiRepairJob): Promise<void> {
  if (!isEnabled()) throw new Error('AI 복구 기능이 비활성화되어 있습니다. AI_REPAIR_ENABLED=true 설정이 필요합니다.');
  if (!job.startedAt) job.startedAt = now();
  updateJob(job, { status: 'preparing', progress: 5, message: '격리 작업공간 준비 중' });
  const workspace = await prepareWorkspace(job);
  logJob(job, `격리 작업공간 준비 완료: ${workspace}`);

  updateJob(job, { status: 'diagnosing', progress: 12, message: '초기 진단 실행 중' });
  let checks = await runChecks(job, workspace);
  job.checks = checks;
  persist(job);

  if (allChecksPassed(checks) && job.kind === 'diagnosis') {
    job.status = 'completed';
    job.progress = 100;
    job.message = '무료 진단 완료 — 오류가 발견되지 않았습니다.';
    job.completedAt = now();
    persist(job);
    await sendJobNotification(job, '무료 진단 완료', '전체 검사에서 오류가 발견되지 않았습니다.');
    return;
  }

  if (
    job.kind === 'diagnosis' &&
    job.billingMode !== 'paid' &&
    !job.aiCostApproved
  ) {
    job.status = 'awaiting_ai_approval';
    job.progress = 40;
    job.message = '무료 진단 완료 — 유료 AI 수정 승인 대기';
    job.costEstimate = estimateAiRepairCost({
      kind: job.kind,
      request: job.request,
      jobId: job.id,
    });
    job.error = undefined;
    persist(job);

    await sendJobNotification(
      job,
      '무료 진단에서 오류 발견',
      'AI 수정은 비용 확인과 별도 승인을 받은 뒤에만 시작됩니다.',
    );
    return;
  }

  for (let attemptNumber = Math.max(1, job.currentAttempt || 1); attemptNumber <= job.maxAttempts; attemptNumber += 1) {
    if (job.cancellationRequested) throw new Error('사용자가 작업 중단을 요청했습니다.');
    job.currentAttempt = attemptNumber;
    const attempt: AiRepairAttempt = {
      number: attemptNumber,
      startedAt: now(),
      findings: [],
      checks,
      changes: [],
    };
    job.attempts.push(attempt);
    persist(job);

    updateJob(job, {
      status: 'repairing',
      progress: 40 + Math.round(((attemptNumber - 1) / job.maxAttempts) * 35),
      message: `AI 수정안 생성 중 (${attemptNumber}/${job.maxAttempts})`,
    });

    try {
      const proposal = await askAiForRepair(job, workspace, checks, attemptNumber);
      attempt.summary = proposal.summary.slice(0, 4_000);
      attempt.findings = proposal.findings.slice(0, 30).map((item) => item.slice(0, 2_000));
      const changed = await applyAiProposal(job, workspace, proposal);
      attempt.changes = changed;
      job.changedFiles = [
        ...job.changedFiles.filter((existing) => !changed.some((item) => item.path === existing.path)),
        ...changed,
      ];
      persist(job);
      logJob(job, `AI 수정안 적용 완료: ${changed.map((item) => item.path).join(', ') || '변경 없음'}`);

      updateJob(job, {
        status: 'verifying',
        progress: 58 + Math.round((attemptNumber / job.maxAttempts) * 25),
        message: `수정 후 정상 작동 검사 중 (${attemptNumber}/${job.maxAttempts})`,
      });
      checks = await runChecks(job, workspace);
      attempt.checks = checks;
      attempt.completedAt = now();
      job.checks = checks;
      persist(job);

      if (allChecksPassed(checks)) {
        if (job.changedFiles.length === 0) {
          throw new Error('검사는 통과했지만 적용할 코드 변경이 없습니다.');
        }
        await commitVerifiedChanges(job, workspace);
        job.status = 'awaiting_approval';
        job.progress = 95;
        job.message = '정상 작동 확인 완료 — 운영 적용 승인 대기';
        job.approvalPhrase = `APPLY-${job.id.slice(-6).toUpperCase()}`;
        job.error = undefined;
        persist(job);
        await sendJobNotification(
          job,
          'AI 복구 테스트 통과',
          `${job.title} 수정안이 모든 검사를 통과했습니다. 앱에서 변경 내용을 확인하고 운영 적용을 승인해 주세요.`,
        );
        return;
      }

      const failed = checks.find((item) => !item.ok);
      attempt.error = failed ? `${failed.label} 실패` : '검증 실패';
      logJob(job, `검증 실패 — 다음 수정 반복으로 진행: ${attempt.error}`);
    } catch (error) {
      attempt.error = cleanLog(error instanceof Error ? error.message : String(error));
      attempt.completedAt = now();
      persist(job);
      logJob(job, `수정 반복 ${attemptNumber} 실패: ${attempt.error}`);
      if (attemptNumber >= job.maxAttempts) throw error;
    }
  }

  throw new Error(`최대 ${job.maxAttempts}회 수정 후에도 정상 검사를 통과하지 못했습니다.`);
}

function validateDeployScript(script: string | null): string {
  if (!script || !path.isAbsolute(script)) throw new Error('AI_REPAIR_DEPLOY_SCRIPT 절대경로가 설정되지 않았습니다.');
  const stat = fs.statSync(script);
  if (!stat.isFile()) throw new Error('승인 배포 스크립트가 파일이 아닙니다.');
  if ((stat.mode & 0o022) !== 0) throw new Error('배포 스크립트가 그룹 또는 전체 사용자에게 쓰기 가능하여 차단했습니다.');
  return script;
}

async function processApprovedDeployment(job: AiRepairJob): Promise<void> {
  if (!job.workspacePath || !job.commitSha) throw new Error('검증된 작업공간 또는 커밋 정보가 없습니다.');
  const workspace = path.resolve(job.workspacePath);
  if (!workspace.startsWith(`${path.resolve(workspacesDir())}${path.sep}`)) {
    throw new Error('승인 작업공간 경로가 허용 범위를 벗어났습니다.');
  }
  updateJob(job, { status: 'applying', progress: 96, message: '승인된 변경을 GitHub와 운영 서버에 반영 중' });

  if (isGitRepository(workspace) && process.env.AI_REPAIR_PUSH_BRANCH !== 'false') {
    if (!job.branch) throw new Error('Git 브랜치 정보가 없습니다.');
    await runCommand(job, workspace, 'git', ['push', '--set-upstream', 'origin', job.branch], 5 * 60_000);
  }

  const script = validateDeployScript(deployScriptPath());
  await runCommand(
    job,
    workspace,
    script,
    [job.id, workspace, job.commitSha, job.branch ?? 'no-git-branch'],
    30 * 60_000,
  );
  job.deployedAt = now();
  persist(job);

  if (isGitRepository(workspace) && process.env.AI_REPAIR_PUSH_BRANCH !== 'false') {
    await runCommand(
      job,
      workspace,
      'git',
      ['push', 'origin', `${job.commitSha}:refs/heads/${baseBranch()}`],
      5 * 60_000,
    );
  }

  job.status = 'completed';
  job.progress = 100;
  job.message = '운영 반영 및 배포 후 상태 확인 완료';
  job.completedAt = now();
  job.error = undefined;
  persist(job);
  await sendJobNotification(job, 'AI 복구 운영 반영 완료', `${job.title} 작업이 운영 서버에 반영되고 상태 검사까지 통과했습니다.`);
}

async function executeJob(job: AiRepairJob): Promise<void> {
  try {
    if (job.status === 'applying') {
      await processApprovedDeployment(job);
    } else {
      await processRepairJob(job);
    }
  } catch (error) {
    const message = cleanLog(error instanceof Error ? error.message : String(error));
    if (job.cancellationRequested || message.includes('작업 중단')) {
      job.status = 'cancelled';
      job.message = '사용자 요청으로 작업을 중단했습니다.';
      job.cancelledAt = now();
    } else {
      job.status = 'failed';
      job.message = job.deployedAt
        ? '운영 반영과 상태 검사는 성공했지만 GitHub 기준 브랜치 동기화를 완료하지 못했습니다.'
        : '자동 복구 작업이 완료되지 못했습니다.';
      job.error = message;
    }
    job.currentCheck = undefined;
    job.progress = 100;
    job.completedAt = now();
    persist(job);
    await sendJobNotification(
      job,
      job.status === 'cancelled' ? 'AI 복구 작업 중단' : 'AI 복구 확인 필요',
      job.status === 'cancelled'
        ? `${job.title} 작업이 중단되었습니다.`
        : `${job.title} 작업을 자동으로 완료하지 못했습니다. 앱에서 오류 기록을 확인해 주세요.`,
    );
  }
}

async function drainQueue(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) continue;
      const job = jobs.get(id);
      if (!job || TERMINAL_STATUSES.has(job.status) || job.status === 'awaiting_approval') continue;
      await executeJob(job);
    }
  } finally {
    workerRunning = false;
  }
}

function enqueue(id: string): void {
  if (!queue.includes(id)) queue.push(id);
  queueMicrotask(() => void drainQueue());
}

function publicJob(job: AiRepairJob): AiRepairJob {
  const copy = structuredClone(job);
  delete copy.workspacePath;
  return copy;
}

export function startAiRepairWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  loadPersistedJobs();
  queueMicrotask(() => void drainQueue());
  console.log(`[ai-repair] worker ${isEnabled() ? 'enabled' : 'disabled'}, jobs=${jobs.size}, repo=${repoPath()}`);
}

export function getAiRepairConfig(): AiRepairPublicConfig {
  const script = deployScriptPath();
  let deploymentReady = false;
  try {
    if (script) {
      validateDeployScript(script);
      deploymentReady = true;
    }
  } catch {
    deploymentReady = false;
  }
  return {
    enabled: isEnabled(),
    aiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    repositoryReady: fs.existsSync(repoPath()) && isGitRepository(repoPath()),
    deploymentReady,
    repoPath: fs.existsSync(repoPath()) ? repoPath() : null,
    baseBranch: baseBranch(),
    maxAttempts: maxAttempts(),
    features: getAiRepairFeatureSettings(),
    checks: [
      ...CHECKS.map(({ name, label }) => ({ name, label })),
      { name: 'api-smoke' as const, label: '격리 API 기동·상태 검사' },
      ...(process.env.AI_REPAIR_CHROMIUM_BIN?.trim()
        ? [{ name: 'browser-smoke' as const, label: '격리 브라우저 화면 검사' }]
        : []),
    ],
    healthUrl: process.env.AI_REPAIR_HEALTH_URL?.trim() || null,
  };
}

export function createAiRepairJob(input: {
  kind: AiRepairJobKind;
  request: string;
  createdBy: string;
  costConsent?: boolean;
  paidDiagnosis?: boolean;
}): AiRepairJob {
  startAiRepairWorker();
  if (!isEnabled()) throw new Error('AI 복구 기능이 아직 서버에서 활성화되지 않았습니다.');

  const features = getAiRepairFeatureSettings();
  const paidDiagnosis =
    input.kind === 'diagnosis' &&
    input.paidDiagnosis === true;

  if (
    input.kind === 'diagnosis' &&
    !paidDiagnosis &&
    !features.freeDiagnosisEnabled
  ) {
    throw new Error('무료 진단 기능이 환경설정에서 꺼져 있습니다.');
  }

  if (
    input.kind === 'diagnosis' &&
    paidDiagnosis &&
    !features.paidDiagnosisEnabled
  ) {
    throw new Error('유료 진단·복구 기능이 환경설정에서 꺼져 있습니다.');
  }

  if (
    input.kind === 'improvement' &&
    !features.improvementEnabled
  ) {
    throw new Error('개선 작업 기능이 환경설정에서 꺼져 있습니다.');
  }

  if (
    (input.kind === 'improvement' || paidDiagnosis) &&
    input.costConsent !== true
  ) {
    throw new Error('예상 비용 확인과 유료 AI 작업 동의가 필요합니다.');
  }

  const request = input.request.trim().slice(0, 20_000);
  if (input.kind === 'improvement' && request.length < 3) throw new Error('개선 요청을 3자 이상 입력해 주세요.');
  const id = `repair-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const job: AiRepairJob = {
    id,
    kind: input.kind,
    title: input.kind === 'diagnosis' ? '전체 시스템 진단' : request.slice(0, 80),
    request: input.kind === 'diagnosis'
      ? request || '현재 프로젝트의 타입 오류, 빌드 오류, API 오류를 진단하고 안전하게 복구해 주세요.'
      : request,
    createdBy: input.createdBy,
    status: 'queued',
    progress: 0,
    message: '서버 작업 대기열에 접수됨',
    createdAt: now(),
    updatedAt: now(),
    maxAttempts: maxAttempts(),
    currentAttempt: 0,
    billingMode:
      input.kind === 'diagnosis' && !paidDiagnosis
        ? 'free'
        : 'paid',
    costEstimate: estimateAiRepairCost({
      kind: input.kind,
      request,
      paid:
        input.kind === 'improvement' ||
        paidDiagnosis,
    }),
    aiCostApproved:
      (input.kind === 'improvement' || paidDiagnosis) &&
      input.costConsent === true,
    aiCostApprovedAt:
      (input.kind === 'improvement' || paidDiagnosis) &&
      input.costConsent === true
        ? now()
        : undefined,
    aiCostApprovedBy:
      (input.kind === 'improvement' || paidDiagnosis) &&
      input.costConsent === true
        ? input.createdBy
        : undefined,
    actualCostUsd: 0,
    usage: [],
    attempts: [],
    checks: [],
    currentCheck: undefined,
    diagnosticErrors: [],
    changedFiles: [],
    logs: [],
  };
  persist(job);
  logJob(job, '휴대폰 연결이 종료되어도 Vultr 서버에서 작업을 계속합니다.');
  enqueue(job.id);
  return publicJob(job);
}

export function listAiRepairJobs(limit = 30): AiRepairJob[] {
  startAiRepairWorker();
  return [...jobs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, clamp(limit, 1, 100))
    .map(publicJob);
}


export function listAiRepairJobsPage(
  requestedPage = 1,
  requestedPageSize = 10,
): {
  jobs: AiRepairJob[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  activeCount: number;
} {
  startAiRepairWorker();

  const all = [...jobs.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt),
  );

  const pagination = createPagination(
    all.length,
    requestedPage,
    requestedPageSize,
  );

  const start =
    (pagination.page - 1) * pagination.pageSize;

  return {
    jobs: all
      .slice(start, start + pagination.pageSize)
      .map(publicJob),
    pagination,
    activeCount: all.filter(
      (job) => ACTIVE_STATUSES.has(job.status),
    ).length,
  };
}

export function getAiRepairJob(id: string): AiRepairJob {
  startAiRepairWorker();
  const job = jobs.get(id);
  if (!job) throw new Error('AI 복구 작업을 찾을 수 없습니다.');
  return publicJob(job);
}


export function approveAiRepairCost(
  id: string,
  costConsent: boolean,
  approvedBy: string,
): AiRepairJob {
  startAiRepairWorker();

  const job = jobs.get(id);

  if (!job) {
    throw new Error('AI 복구 작업을 찾을 수 없습니다.');
  }

  if (job.status !== 'awaiting_ai_approval') {
    throw new Error('현재 유료 AI 수정 승인을 받을 수 있는 상태가 아닙니다.');
  }

  if (costConsent !== true) {
    throw new Error('예상 비용 확인과 유료 AI 작업 동의가 필요합니다.');
  }

  const features = getAiRepairFeatureSettings();

  if (!features.paidDiagnosisEnabled) {
    throw new Error('유료 진단·복구 기능이 환경설정에서 꺼져 있습니다.');
  }

  job.billingMode = 'paid';
  job.aiCostApproved = true;
  job.aiCostApprovedAt = now();
  job.aiCostApprovedBy = approvedBy;
  job.costEstimate = estimateAiRepairCost({
    kind: job.kind,
    request: job.request,
    jobId: job.id,
  });
  job.status = 'queued';
  job.progress = 40;
  job.message = '유료 AI 수정 승인 완료 — 작업 대기열 접수';
  job.error = undefined;

  persist(job);
  enqueue(job.id);

  return publicJob(job);
}

export function approveAiRepairJob(id: string, approvalPhrase: string, approvedBy: string): AiRepairJob {
  startAiRepairWorker();
  const job = jobs.get(id);
  if (!job) throw new Error('AI 복구 작업을 찾을 수 없습니다.');
  if (job.status !== 'awaiting_approval') throw new Error('현재 운영 적용 승인을 받을 수 있는 상태가 아닙니다.');
  if (!job.approvalPhrase || approvalPhrase.trim() !== job.approvalPhrase) {
    throw new Error('승인 문구가 일치하지 않습니다.');
  }
  job.status = 'applying';
  job.progress = 96;
  job.message = '운영 적용 승인 완료 — 서버 반영 대기';
  job.approvedAt = now();
  job.approvedBy = approvedBy;
  persist(job);
  enqueue(job.id);
  return publicJob(job);
}

export function cancelAiRepairJob(id: string, requestedBy: string): AiRepairJob {
  startAiRepairWorker();
  const job = jobs.get(id);
  if (!job) throw new Error('AI 복구 작업을 찾을 수 없습니다.');
  if (TERMINAL_STATUSES.has(job.status)) return publicJob(job);
  job.cancellationRequested = true;
  logJob(job, `관리자 ${requestedBy}님이 작업 중단을 요청했습니다.`);
  const child = activeChildren.get(job.id);
  if (child) child.kill('SIGTERM');
  if (!ACTIVE_STATUSES.has(job.status)) {
    job.status = 'cancelled';
    job.progress = 100;
    job.message = '사용자 요청으로 작업을 중단했습니다.';
    job.cancelledAt = now();
    job.completedAt = now();
    persist(job);
  }
  return publicJob(job);
}
