# AI 복구 기사 앱 아이콘 기능 — 변경 파일 전체 코드

## `.gitignore`

```text
# Dependencies and local caches
node_modules/
.local/
*.tsbuildinfo

# Build output
dist/
**/dist/

# Runtime data and logs
api-server/data/
# DART 기업코드 매핑은 콜드스타트 대비 번들로 유지 (벌크 다운로드가 3~4분 걸림)
!api-server/data/dart-corpmap.json
*.log

# Local environment/secrets
.env
.env.*
!.env.example

# OS/editor
.DS_Store
Thumbs.db
.vscode/
.idea/
*.backup-*

# AI repair runtime staging, backups, approvals
.ai-repair/

```

## `api-server/src/index.ts`

```ts
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import apiRouter from './routes';
import { startPriceAlertMonitor } from './services/notification.service';
import { apiRateLimit } from './middleware/security';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const port = Number(
  process.env.PORT ??
    process.env.API_PORT ??
    8080,
);

app.disable('x-powered-by');

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

app.use('/api', apiRateLimit);

app.use(
  express.json({
    limit: '12mb',
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '1mb',
  }),
);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'api-server',
    route: '/health',
    time: new Date().toISOString(),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'api-server',
    route: '/api/health',
    time: new Date().toISOString(),
  });
});

/*
 * API 라우트는 반드시 프론트 정적 파일보다 먼저 등록합니다.
 */
app.use('/api', apiRouter);

const frontendDistCandidates = [
  path.resolve(
    __dirname,
    '../../stock-analyzer/dist/public',
  ),

  path.resolve(
    __dirname,
    '../../stock-analyzer/dist',
  ),

  path.resolve(
    __dirname,
    '../../../stock-analyzer/dist/public',
  ),

  path.resolve(
    __dirname,
    '../../../stock-analyzer/dist',
  ),

  path.resolve(
    process.cwd(),
    '../stock-analyzer/dist/public',
  ),

  path.resolve(
    process.cwd(),
    '../stock-analyzer/dist',
  ),

  path.resolve(
    process.cwd(),
    'artifacts/stock-analyzer/dist/public',
  ),

  path.resolve(
    process.cwd(),
    'artifacts/stock-analyzer/dist',
  ),

  path.resolve(
    process.cwd(),
    'stock-analyzer/dist/public',
  ),

  path.resolve(
    process.cwd(),
    'stock-analyzer/dist',
  ),
];

const frontendDist =
  frontendDistCandidates.find(
    (candidate) =>
      fs.existsSync(
        path.join(
          candidate,
          'index.html',
        ),
      ),
  );

if (frontendDist) {
  app.use(
    express.static(
      frontendDist,
    ),
  );
}

const availableRoutes = [
  '/api',
  '/api/health',
  '/api/config',
  '/api/search?q=삼성전자',
  '/api/quotes?tickers=005930,NVDA,AAPL',
  '/api/market/movers?market=KR',
  '/api/market/movers?market=US',
  '/api/kiwoom/status',
  '/api/kiwoom/token-test',
  '/api/kiwoom/test',
  '/api/kiwoom/rankings?market=KR&type=volume&limit=30',
  '/api/kiwoom/rankings?market=US&type=tradingValue&limit=30',
  '/api/stocks/005930/quote',
  '/api/watchlist',
  '/api/admin/repair/icon/jobs',
];

app.use((req, res) => {
  if (
    req.path.startsWith(
      '/api',
    )
  ) {
    res.status(404).json({
      ok: false,
      error: 'API_ROUTE_NOT_FOUND',
      path: req.path,
      available: availableRoutes,
    });

    return;
  }

  if (frontendDist) {
    res.sendFile(
      path.join(
        frontendDist,
        'index.html',
      ),
    );

    return;
  }

  res.status(200).json({
    ok: true,
    service: 'api-server',
    message:
      'API server is running, but frontend dist was not found.',

    available: [
      '/health',
      ...availableRoutes,
    ],
  });
});

app.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `[api-server] listening on 0.0.0.0:${port}`,
    );

    console.log(
      '[api-server] Kiwoom routes enabled at /api/kiwoom',
    );

    startPriceAlertMonitor();

    if (frontendDist) {
      console.log(
        `[api-server] serving frontend from ${frontendDist}`,
      );
    } else {
      console.log(
        '[api-server] frontend dist not found, api only mode',
      );
    }
  },
);
```

## `api-server/src/routes/index.ts`

```ts
import { Router, type IRouter } from 'express';
import healthRouter from './health';
import marketRouter from './market';
import newsRouter from './news.route';
import providerDebugRouter from './provider-debug';
import pushRouter from './push';
import stocksRouter from './stocks';
import watchlistRouter from './watchlist';
import kiwoomRouter from './kiwoom.routes';
import adminRouter from './admin';
import secRouter from './sec.routes';
import cryptoRouter from './crypto';
import backupRouter from './backup';
import accountRecoveryRouter from './account-recovery';
import repairRouter from './repair';
import { requireAdmin, requireMember } from '../middleware/auth';

const router: IRouter = Router();

// -------------------------------------------------------------------
// Public routes (no auth required)
// -------------------------------------------------------------------
router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'seungjae-stock-api' });
});

router.use('/', healthRouter);
router.use('/', accountRecoveryRouter);
router.use('/', marketRouter);
router.use('/', newsRouter);
router.use('/kiwoom', kiwoomRouter);
router.use('/', cryptoRouter);

// -------------------------------------------------------------------
// Admin routes (auth + admin role required — checked inside adminRouter)
// -------------------------------------------------------------------
router.use('/admin', adminRouter);
router.use('/admin/repair', repairRouter);

// -------------------------------------------------------------------
// Authenticated routes (login required)
// -------------------------------------------------------------------
router.use(requireMember);
router.use('/debug', requireAdmin, providerDebugRouter);
router.use('/', pushRouter);
router.use('/', watchlistRouter);
router.use('/stocks', stocksRouter);
router.use('/', secRouter);
router.use('/backup', backupRouter);

export default router;

```

## `api-server/src/routes/repair.ts`

```ts
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Router } from 'express';
import { requireAdmin, requireMember, type AuthenticatedRequest } from '../middleware/auth';
import { getSupabase } from '../lib/supabase';

const router = Router();
router.use(requireMember, requireAdmin);

const APPLY_PHRASE = '아이콘 소스 적용';
const MAX_VARIANT_BYTES = Math.floor(1.5 * 1024 * 1024);
const MAX_JOBS = 50;

type IconVariantKey = 'favicon' | 'appleTouch' | 'icon192' | 'icon512' | 'maskable512';

type IconVariantDefinition = {
  key: IconVariantKey;
  width: number;
  height: number;
  targetRelativePath: string;
  stagedFileName: string;
};

const ICON_VARIANTS: IconVariantDefinition[] = [
  {
    key: 'favicon',
    width: 64,
    height: 64,
    targetRelativePath: 'stock-analyzer/public/favicon.png',
    stagedFileName: 'favicon.png',
  },
  {
    key: 'appleTouch',
    width: 180,
    height: 180,
    targetRelativePath: 'stock-analyzer/public/icons/apple-touch-icon.png',
    stagedFileName: 'apple-touch-icon.png',
  },
  {
    key: 'icon192',
    width: 192,
    height: 192,
    targetRelativePath: 'stock-analyzer/public/icons/icon-192.png',
    stagedFileName: 'icon-192.png',
  },
  {
    key: 'icon512',
    width: 512,
    height: 512,
    targetRelativePath: 'stock-analyzer/public/icons/icon-512.png',
    stagedFileName: 'icon-512.png',
  },
  {
    key: 'maskable512',
    width: 512,
    height: 512,
    targetRelativePath: 'stock-analyzer/public/icons/maskable-512.png',
    stagedFileName: 'maskable-512.png',
  },
];

type IconJobStatus =
  | 'staged_awaiting_approval'
  | 'source_applied_build_pending'
  | 'rolled_back'
  | 'cancelled'
  | 'failed';

type IconJobFile = {
  key: IconVariantKey;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  targetRelativePath: string;
  stagedFileName: string;
  previousExists?: boolean;
};

type IconJob = {
  id: string;
  kind: 'pwa_icon_change';
  status: IconJobStatus;
  sourceName: string;
  note: string;
  backgroundColor: string;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  appliedAt?: string;
  rolledBackAt?: string;
  failedAt?: string;
  error?: string;
  buildCommand: string;
  files: IconJobFile[];
};

type CreateIconJobBody = {
  sourceName?: unknown;
  note?: unknown;
  backgroundColor?: unknown;
  variants?: Partial<Record<IconVariantKey, unknown>>;
};

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function parsePngDataUrl(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('PNG_DATA_REQUIRED');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error('ONLY_PNG_DATA_URL_ALLOWED');
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > MAX_VARIANT_BYTES) throw new Error('PNG_SIZE_INVALID');
  return buffer;
}

function readPngSize(buffer: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('PNG_SIGNATURE_INVALID');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || chunkEnd > buffer.length) throw new Error('PNG_CHUNK_INVALID');
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) throw new Error('PNG_IHDR_MISSING');
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      sawHeader = true;
    }
    if (type === 'IEND') {
      if (length !== 0 || chunkEnd !== buffer.length) throw new Error('PNG_IEND_INVALID');
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawHeader || !sawEnd || width < 1 || height < 1) throw new Error('PNG_STRUCTURE_INVALID');
  return { width, height };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findWorkspaceRoot(): Promise<string> {
  const configured = text(process.env.AI_REPAIR_WORKSPACE_ROOT, 1000);
  const candidates = [
    configured,
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '../..'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const publicDir = path.join(resolved, 'stock-analyzer', 'public');
    const apiDir = path.join(resolved, 'api-server', 'src');
    if (await pathExists(publicDir) && await pathExists(apiDir)) return resolved;
  }

  throw new Error('AI_REPAIR_WORKSPACE_ROOT_NOT_FOUND');
}

async function repairPaths() {
  const workspaceRoot = await findWorkspaceRoot();
  const repairRoot = path.join(workspaceRoot, '.ai-repair');
  const jobsDir = path.join(repairRoot, 'jobs');
  const stagingDir = path.join(repairRoot, 'staging');
  const backupsDir = path.join(repairRoot, 'backups');
  await Promise.all([
    fs.mkdir(jobsDir, { recursive: true }),
    fs.mkdir(stagingDir, { recursive: true }),
    fs.mkdir(backupsDir, { recursive: true }),
  ]);
  return { workspaceRoot, repairRoot, jobsDir, stagingDir, backupsDir };
}

function assertJobId(jobId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('JOB_ID_INVALID');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function saveJob(job: IconJob): Promise<void> {
  const { jobsDir } = await repairPaths();
  await writeJsonAtomic(path.join(jobsDir, `${job.id}.json`), job);
}

async function readJob(jobId: string): Promise<IconJob> {
  assertJobId(jobId);
  const { jobsDir } = await repairPaths();
  const raw = await fs.readFile(path.join(jobsDir, `${jobId}.json`), 'utf8');
  return JSON.parse(raw) as IconJob;
}

async function listJobs(): Promise<IconJob[]> {
  const { jobsDir } = await repairPaths();
  const names = (await fs.readdir(jobsDir)).filter((name) => name.endsWith('.json'));
  const jobs = await Promise.all(
    names.map(async (name) => {
      try {
        return JSON.parse(await fs.readFile(path.join(jobsDir, name), 'utf8')) as IconJob;
      } catch {
        return null;
      }
    }),
  );
  return jobs
    .filter((job): job is IconJob => Boolean(job))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_JOBS);
}

async function copyFileAtomic(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.copyFile(source, temporary);
  await fs.rename(temporary, target);
}

async function writeFileAtomic(target: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data);
  await fs.rename(temporary, target);
}

type IconBackupMeta = {
  indexPreviousExists: boolean;
  versionPreviousExists: boolean;
};

async function restoreIconBackup(job: IconJob): Promise<void> {
  const { workspaceRoot, backupsDir, repairRoot } = await repairPaths();
  const jobBackupDir = path.join(backupsDir, job.id);

  for (const file of job.files) {
    const targetPath = path.join(workspaceRoot, file.targetRelativePath);
    const backupPath = path.join(jobBackupDir, file.targetRelativePath);
    if (file.previousExists) await copyFileAtomic(backupPath, targetPath);
    else await fs.rm(targetPath, { force: true });
  }

  const metaPath = path.join(jobBackupDir, 'backup-meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as IconBackupMeta;
  const indexRelativePath = 'stock-analyzer/index.html';
  const indexPath = path.join(workspaceRoot, indexRelativePath);
  const indexBackupPath = path.join(jobBackupDir, indexRelativePath);
  if (meta.indexPreviousExists) await copyFileAtomic(indexBackupPath, indexPath);
  else await fs.rm(indexPath, { force: true });

  const versionRelativePath = 'stock-analyzer/public/icon-version.json';
  const versionPath = path.join(workspaceRoot, versionRelativePath);
  const versionBackupPath = path.join(jobBackupDir, versionRelativePath);
  if (meta.versionPreviousExists) await copyFileAtomic(versionBackupPath, versionPath);
  else await fs.rm(versionPath, { force: true });

  await fs.rm(path.join(repairRoot, 'pending-build.json'), { force: true });
}

async function audit(req: AuthenticatedRequest, action: string, targetId: string, details: unknown): Promise<void> {
  try {
    await getSupabase().from('audit_logs').insert({
      actor_id: req.member?.id,
      action,
      target_type: 'ai_repair_icon_job',
      target_id: targetId,
      details,
      ip_address: req.ip,
    });
  } catch {
    // 파일 작업은 감사 로그 저장 실패 때문에 되돌리지 않는다.
  }
}

function publicJob(job: IconJob) {
  return {
    ...job,
    approvalPhrase: job.status === 'staged_awaiting_approval' ? APPLY_PHRASE : undefined,
  };
}

router.get('/icon/jobs', async (_req, res) => {
  try {
    return res.json({
      ok: true,
      jobs: (await listJobs()).map(publicJob),
      policy: {
        buildsAutomatically: false,
        appliesSourceOnlyAfterApproval: true,
        approvalPhrase: APPLY_PHRASE,
        supportedTargets: ICON_VARIANTS.map((variant) => variant.targetRelativePath),
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'ICON_JOB_LIST_FAILED',
    });
  }
});

router.post('/icon/jobs', async (req: AuthenticatedRequest, res) => {
  const body = (req.body ?? {}) as CreateIconJobBody;
  const sourceName = text(body.sourceName, 180) || 'uploaded-icon.png';
  const note = text(body.note, 1000);
  const requestedBackground = text(body.backgroundColor, 20);
  const backgroundColor = isHexColor(requestedBackground) ? requestedBackground.toLowerCase() : '#b91c1c';

  try {
    const { stagingDir } = await repairPaths();
    const id = randomUUID();
    const jobStageDir = path.join(stagingDir, id);
    await fs.mkdir(jobStageDir, { recursive: true });

    const files: IconJobFile[] = [];
    for (const definition of ICON_VARIANTS) {
      const buffer = parsePngDataUrl(body.variants?.[definition.key]);
      const dimensions = readPngSize(buffer);
      if (dimensions.width !== definition.width || dimensions.height !== definition.height) {
        throw new Error(`PNG_DIMENSION_INVALID_${definition.key.toUpperCase()}`);
      }
      await writeFileAtomic(path.join(jobStageDir, definition.stagedFileName), buffer);
      files.push({
        key: definition.key,
        width: definition.width,
        height: definition.height,
        bytes: buffer.length,
        sha256: sha256(buffer),
        targetRelativePath: definition.targetRelativePath,
        stagedFileName: definition.stagedFileName,
      });
    }

    const job: IconJob = {
      id,
      kind: 'pwa_icon_change',
      status: 'staged_awaiting_approval',
      sourceName,
      note,
      backgroundColor,
      createdAt: new Date().toISOString(),
      createdBy: req.member?.id ?? 'unknown',
      createdByName: req.member?.display_name ?? req.member?.login_name ?? '관리자',
      buildCommand: 'pnpm --filter @workspace/stock-analyzer run build',
      files,
    };

    await saveJob(job);
    await audit(req, 'ai_repair.icon.stage', id, {
      sourceName,
      backgroundColor,
      files: files.map((file) => ({ path: file.targetRelativePath, sha256: file.sha256, bytes: file.bytes })),
    });

    return res.status(201).json({
      ok: true,
      job: publicJob(job),
      message: '아이콘 파일이 서버 작업공간에 올라갔습니다. 아직 앱 소스와 빌드에는 적용되지 않았습니다.',
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'ICON_JOB_CREATE_FAILED',
    });
  }
});

router.post('/icon/jobs/:jobId/apply-source', async (req: AuthenticatedRequest, res) => {
  const approvalPhrase = text(req.body?.approvalPhrase, 100);
  if (approvalPhrase !== APPLY_PHRASE) {
    return res.status(409).json({ ok: false, error: 'APPROVAL_PHRASE_MISMATCH' });
  }

  let job: IconJob | null = null;
  let backupReady = false;
  try {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    job = await readJob(jobId);
    if (job.status !== 'staged_awaiting_approval') {
      return res.status(409).json({ ok: false, error: 'ICON_JOB_NOT_APPLICABLE', status: job.status });
    }

    const { workspaceRoot, stagingDir, backupsDir, repairRoot } = await repairPaths();
    const jobStageDir = path.join(stagingDir, job.id);
    const jobBackupDir = path.join(backupsDir, job.id);
    await fs.rm(jobBackupDir, { recursive: true, force: true });
    await fs.mkdir(jobBackupDir, { recursive: true });

    const updatedFiles: IconJobFile[] = [];
    for (const file of job.files) {
      const stagedPath = path.join(jobStageDir, file.stagedFileName);
      const targetPath = path.resolve(workspaceRoot, file.targetRelativePath);
      if (!targetPath.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error('TARGET_PATH_OUTSIDE_WORKSPACE');
      if (!(await pathExists(stagedPath))) throw new Error(`STAGED_FILE_MISSING_${file.key.toUpperCase()}`);
      const stagedBuffer = await fs.readFile(stagedPath);
      if (sha256(stagedBuffer) !== file.sha256) throw new Error(`STAGED_FILE_HASH_MISMATCH_${file.key.toUpperCase()}`);
      const previousExists = await pathExists(targetPath);
      if (previousExists) await copyFileAtomic(targetPath, path.join(jobBackupDir, file.targetRelativePath));
      updatedFiles.push({ ...file, previousExists });
    }

    const indexRelativePath = 'stock-analyzer/index.html';
    const versionRelativePath = 'stock-analyzer/public/icon-version.json';
    const indexPath = path.join(workspaceRoot, indexRelativePath);
    const versionPath = path.join(workspaceRoot, versionRelativePath);
    const indexPreviousExists = await pathExists(indexPath);
    const versionPreviousExists = await pathExists(versionPath);
    if (!indexPreviousExists) throw new Error('FRONTEND_INDEX_NOT_FOUND');
    await copyFileAtomic(indexPath, path.join(jobBackupDir, indexRelativePath));
    if (versionPreviousExists) await copyFileAtomic(versionPath, path.join(jobBackupDir, versionRelativePath));
    await writeJsonAtomic(path.join(jobBackupDir, 'backup-meta.json'), {
      indexPreviousExists,
      versionPreviousExists,
    } satisfies IconBackupMeta);

    job = { ...job, files: updatedFiles };
    await saveJob(job);
    backupReady = true;

    for (const file of updatedFiles) {
      await copyFileAtomic(
        path.join(jobStageDir, file.stagedFileName),
        path.join(workspaceRoot, file.targetRelativePath),
      );
    }

    const originalIndex = await fs.readFile(indexPath, 'utf8');
    const nextIndex = originalIndex.replace(
      /<link\s+rel="icon"[^>]*>/i,
      '<link rel="icon" type="image/png" sizes="64x64" href="/favicon.png" />',
    );
    if (nextIndex === originalIndex) throw new Error('FAVICON_LINK_NOT_FOUND');
    await writeFileAtomic(indexPath, nextIndex);

    const version = updatedFiles.find((file) => file.key === 'icon512')?.sha256.slice(0, 16) ?? job.id.slice(0, 16);
    await writeJsonAtomic(versionPath, {
      jobId: job.id,
      version,
      sourceName: job.sourceName,
      appliedAt: new Date().toISOString(),
    });

    job = {
      ...job,
      status: 'source_applied_build_pending',
      appliedAt: new Date().toISOString(),
      error: undefined,
    };
    await saveJob(job);
    await writeJsonAtomic(path.join(repairRoot, 'pending-build.json'), {
      kind: 'pwa_icon_change',
      jobId: job.id,
      status: 'source_applied_build_pending',
      buildCommand: job.buildCommand,
      createdAt: job.createdAt,
      appliedAt: job.appliedAt,
      warning: '소스 파일까지만 적용됐습니다. 빌드와 배포는 별도 승인 후 실행하세요.',
    });
    await audit(req, 'ai_repair.icon.apply_source', job.id, {
      files: updatedFiles.map((file) => file.targetRelativePath),
      buildExecuted: false,
    });

    return res.json({
      ok: true,
      job: publicJob(job),
      message: '서버의 앱 아이콘 소스 파일까지 적용했습니다. 빌드는 실행하지 않고 승인 대기 상태로 멈췄습니다.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'ICON_SOURCE_APPLY_FAILED';
    if (job && backupReady) await restoreIconBackup(job).catch(() => undefined);
    if (job) {
      job = {
        ...job,
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: backupReady ? `${errorMessage} · 자동 원복 처리됨` : errorMessage,
      };
      await saveJob(job).catch(() => undefined);
    }
    return res.status(500).json({ ok: false, error: errorMessage });
  }
});

router.post('/icon/jobs/:jobId/rollback', async (req: AuthenticatedRequest, res) => {
  const approvalPhrase = text(req.body?.approvalPhrase, 100);
  if (approvalPhrase !== '아이콘 원복') {
    return res.status(409).json({ ok: false, error: 'ROLLBACK_PHRASE_MISMATCH' });
  }

  try {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    const job = await readJob(jobId);
    if (job.status !== 'source_applied_build_pending' && job.status !== 'failed') {
      return res.status(409).json({ ok: false, error: 'ICON_JOB_NOT_ROLLBACKABLE', status: job.status });
    }

    await restoreIconBackup(job);

    const rolledBack: IconJob = {
      ...job,
      status: 'rolled_back',
      rolledBackAt: new Date().toISOString(),
      error: undefined,
    };
    await saveJob(rolledBack);
    await audit(req, 'ai_repair.icon.rollback', job.id, {
      files: job.files.map((file) => file.targetRelativePath),
    });

    return res.json({
      ok: true,
      job: publicJob(rolledBack),
      message: '아이콘 소스 파일을 변경 전 상태로 원복했습니다.',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'ICON_ROLLBACK_FAILED',
    });
  }
});

export default router;

```

## `stock-analyzer/src/pages/admin.tsx`

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Image as ImageIcon,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Upload,
  Users,
  Wrench,
} from 'lucide-react';
import { useAuth, type MemberProfile } from '@/lib/auth';

async function adminFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`;
    const message = typeof payload.message === 'string' ? payload.message : code;
    throw new Error(message);
  }
  return payload as T;
}

type AdminTab = 'members' | 'repair';
type IconJobStatus =
  | 'staged_awaiting_approval'
  | 'source_applied_build_pending'
  | 'rolled_back'
  | 'cancelled'
  | 'failed';

type IconJobFile = {
  key: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  targetRelativePath: string;
};

type IconJob = {
  id: string;
  kind: 'pwa_icon_change';
  status: IconJobStatus;
  sourceName: string;
  note: string;
  backgroundColor: string;
  createdAt: string;
  createdByName: string;
  appliedAt?: string;
  rolledBackAt?: string;
  error?: string;
  buildCommand: string;
  approvalPhrase?: string;
  files: IconJobFile[];
};

type IconJobsResponse = {
  ok: true;
  jobs: IconJob[];
  policy: {
    buildsAutomatically: boolean;
    appliesSourceOnlyAfterApproval: boolean;
    approvalPhrase: string;
    supportedTargets: string[];
  };
};

type GeneratedIcons = {
  favicon: string;
  appleTouch: string;
  icon192: string;
  icon512: string;
  maskable512: string;
};

function loadImage(file: File): Promise<{ image: HTMLImageElement; cleanup: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, cleanup: () => URL.revokeObjectURL(url) });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 읽지 못했습니다. PNG, JPG 또는 WEBP 파일인지 확인해 주세요.'));
    };
    image.src = url;
  });
}

function drawSquareIcon(
  image: HTMLImageElement,
  size: number,
  backgroundColor: string,
  paddingRatio: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('브라우저에서 아이콘 변환 기능을 사용할 수 없습니다.');

  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, size, size);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const available = size * (1 - paddingRatio * 2);
  const scale = Math.min(available / image.naturalWidth, available / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = (size - width) / 2;
  const y = (size - height) / 2;
  context.drawImage(image, x, y, width, height);
  return canvas.toDataURL('image/png');
}

async function generateIcons(file: File, backgroundColor: string): Promise<GeneratedIcons> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('PNG, JPG 또는 WEBP 이미지만 사용할 수 있습니다.');
  }
  if (file.size > 8 * 1024 * 1024) throw new Error('원본 이미지는 8MB 이하여야 합니다.');

  const { image, cleanup } = await loadImage(file);
  try {
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('이미지 크기를 확인할 수 없습니다.');
    return {
      favicon: drawSquareIcon(image, 64, backgroundColor, 0.04),
      appleTouch: drawSquareIcon(image, 180, backgroundColor, 0.05),
      icon192: drawSquareIcon(image, 192, backgroundColor, 0.05),
      icon512: drawSquareIcon(image, 512, backgroundColor, 0.05),
      maskable512: drawSquareIcon(image, 512, backgroundColor, 0.14),
    };
  } finally {
    cleanup();
  }
}

function statusText(status: IconJobStatus): string {
  if (status === 'staged_awaiting_approval') return '서버 업로드 완료 · 소스 적용 승인 대기';
  if (status === 'source_applied_build_pending') return '소스 적용 완료 · 빌드 전 승인 대기';
  if (status === 'rolled_back') return '변경 전 상태로 원복 완료';
  if (status === 'failed') return '작업 실패 · 원복 가능 여부 확인 필요';
  return '취소됨';
}

function statusClass(status: IconJobStatus): string {
  if (status === 'source_applied_build_pending') return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  if (status === 'staged_awaiting_approval') return 'bg-primary/10 text-primary';
  if (status === 'rolled_back') return 'bg-positive/10 text-positive';
  if (status === 'failed') return 'bg-destructive/10 text-destructive';
  return 'bg-secondary text-muted-foreground';
}

function MembersPanel({ token }: { token: string }) {
  const client = useQueryClient();
  const members = useQuery<{ members: MemberProfile[] }>({
    queryKey: ['admin-members'],
    queryFn: () => adminFetch('/members', token),
    enabled: Boolean(token),
  });

  async function update(id: string, changes: Partial<Pick<MemberProfile, 'status' | 'role'>>) {
    await adminFetch(`/members/${id}`, token, { method: 'PATCH', body: JSON.stringify(changes) });
    await client.invalidateQueries({ queryKey: ['admin-members'] });
  }

  return (
    <div className="space-y-3">
      {members.isLoading && <p>회원 목록을 불러오는 중입니다.</p>}
      {members.error && <p className="text-destructive">{members.error.message}</p>}
      {members.data?.members.map((member: MemberProfile) => (
        <article key={member.id} className="rounded-3xl border border-card-border bg-card p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-black">{member.display_name}</p>
              <p className="truncate text-xs text-muted-foreground">{member.login_name}</p>
            </div>
            <span className="shrink-0 rounded-full bg-secondary px-3 py-1 text-xs font-bold">
              {member.role === 'admin' ? '관리자' : member.role === 'member' ? '정회원' : '일반회원'}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <select
              aria-label={`${member.display_name} 상태`}
              value={member.status}
              onChange={(event) => void update(member.id, { status: event.target.value as MemberProfile['status'] })}
              className="min-w-0 rounded-xl border border-card-border bg-background p-2 text-sm font-bold"
            >
              <option value="pending">승인대기</option>
              <option value="approved">승인</option>
              <option value="rejected">반려</option>
              <option value="suspended">정지</option>
              <option value="withdrawn">탈퇴</option>
            </select>
            <select
              aria-label={`${member.display_name} 권한`}
              value={member.role}
              onChange={(event) => void update(member.id, { role: event.target.value as MemberProfile['role'] })}
              className="min-w-0 rounded-xl border border-card-border bg-background p-2 text-sm font-bold"
            >
              <option value="user">일반회원</option>
              <option value="member">정회원</option>
              <option value="admin">관리자</option>
            </select>
          </div>
        </article>
      ))}
    </div>
  );
}

function IconRepairPanel({ token }: { token: string }) {
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [backgroundColor, setBackgroundColor] = useState('#b91c1c');
  const [note, setNote] = useState('앱 아이콘 변경');
  const [message, setMessage] = useState('');
  const [approvalInputs, setApprovalInputs] = useState<Record<string, string>>({});

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const jobs = useQuery<IconJobsResponse>({
    queryKey: ['admin-icon-repair-jobs'],
    queryFn: () => adminFetch('/repair/icon/jobs', token),
    enabled: Boolean(token),
  });

  const createJob = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('먼저 아이콘 이미지를 선택해 주세요.');
      setMessage('아이콘 크기별 파일을 만들고 서버에 업로드하는 중입니다.');
      const variants = await generateIcons(file, backgroundColor);
      return adminFetch<{ ok: true; job: IconJob; message: string }>('/repair/icon/jobs', token, {
        method: 'POST',
        body: JSON.stringify({
          sourceName: file.name,
          note,
          backgroundColor,
          variants,
        }),
      });
    },
    onSuccess: async (result: { ok: true; job: IconJob; message: string }) => {
      setMessage(result.message);
      await client.invalidateQueries({ queryKey: ['admin-icon-repair-jobs'] });
    },
    onError: (error: Error) => setMessage(error instanceof Error ? error.message : '아이콘 작업 생성에 실패했습니다.'),
  });

  const applySource = useMutation({
    mutationFn: async (job: IconJob) => {
      const approvalPhrase = approvalInputs[job.id] ?? '';
      return adminFetch<{ ok: true; job: IconJob; message: string }>(
        `/repair/icon/jobs/${job.id}/apply-source`,
        token,
        { method: 'POST', body: JSON.stringify({ approvalPhrase }) },
      );
    },
    onSuccess: async (result: { ok: true; job: IconJob; message: string }) => {
      setMessage(result.message);
      await client.invalidateQueries({ queryKey: ['admin-icon-repair-jobs'] });
    },
    onError: (error: Error) => setMessage(error instanceof Error ? error.message : '소스 적용에 실패했습니다.'),
  });

  const rollback = useMutation({
    mutationFn: async (job: IconJob) => adminFetch<{ ok: true; job: IconJob; message: string }>(
      `/repair/icon/jobs/${job.id}/rollback`,
      token,
      { method: 'POST', body: JSON.stringify({ approvalPhrase: approvalInputs[job.id] ?? '' }) },
    ),
    onSuccess: async (result: { ok: true; job: IconJob; message: string }) => {
      setMessage(result.message);
      await client.invalidateQueries({ queryKey: ['admin-icon-repair-jobs'] });
    },
    onError: (error: Error) => setMessage(error instanceof Error ? error.message : '원복에 실패했습니다.'),
  });

  const busy = createJob.isPending || applySource.isPending || rollback.isPending;

  return (
    <div className="space-y-4">
      <section className="rounded-3xl border border-card-border bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-primary/10 p-3 text-primary"><ImageIcon className="h-6 w-6" /></div>
          <div className="min-w-0">
            <h2 className="font-black">앱 아이콘 서버 작업</h2>
            <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
              이미지를 필요한 크기로 만든 뒤 서버 작업공간에 올립니다. 소스 적용은 문구 승인 후 실행되며 빌드와 배포는 실행하지 않습니다.
            </p>
          </div>
        </div>

        <label className="mt-5 block cursor-pointer rounded-2xl border border-dashed border-card-border bg-background p-4 text-center">
          <Upload className="mx-auto h-6 w-6 text-primary" />
          <span className="mt-2 block text-sm font-black">PNG·JPG·WEBP 선택</span>
          <span className="mt-1 block text-xs text-muted-foreground">최대 8MB</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>

        {previewUrl && (
          <div className="mt-4 flex items-center gap-4 rounded-2xl bg-background p-3">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl" style={{ backgroundColor }}>
              <img src={previewUrl} alt="선택한 아이콘 미리보기" className="h-full w-full object-contain p-1" />
            </div>
            <div className="min-w-0 text-left">
              <p className="truncate text-sm font-black">{file?.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {file ? `${Math.ceil(file.size / 1024).toLocaleString('ko-KR')}KB` : ''}
              </p>
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-[auto_1fr] items-center gap-3">
          <label htmlFor="icon-background" className="text-xs font-black">배경색</label>
          <div className="flex items-center gap-2">
            <input
              id="icon-background"
              type="color"
              value={backgroundColor}
              onChange={(event) => setBackgroundColor(event.target.value)}
              className="h-10 w-14 rounded-xl border border-card-border bg-background p-1"
            />
            <input
              value={backgroundColor}
              onChange={(event) => setBackgroundColor(event.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-card-border bg-background px-3 py-2 text-sm font-bold"
            />
          </div>
          <label htmlFor="icon-note" className="text-xs font-black">요청내용</label>
          <input
            id="icon-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="예: 119 로고로 앱 아이콘 변경"
            className="min-w-0 rounded-xl border border-card-border bg-background px-3 py-2 text-sm"
          />
        </div>

        <button
          type="button"
          disabled={!file || busy}
          onClick={() => createJob.mutate()}
          className="mt-4 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createJob.isPending ? '서버에 업로드 중…' : '서버에 올리고 작업 생성'}
        </button>
      </section>

      {message && <p className="rounded-2xl border border-card-border bg-card p-3 text-sm font-bold">{message}</p>}

      <section className="rounded-3xl border border-card-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-black">아이콘 작업 기록</h2>
            <p className="mt-1 text-xs text-muted-foreground">최근 작업 최대 50개</p>
          </div>
          <button type="button" aria-label="아이콘 작업 새로고침" onClick={() => void jobs.refetch()}>
            <RefreshCw className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {jobs.isLoading && <p className="text-sm text-muted-foreground">작업 기록을 불러오는 중입니다.</p>}
          {jobs.error && <p className="text-sm text-destructive">{jobs.error.message}</p>}
          {!jobs.isLoading && !jobs.data?.jobs.length && (
            <p className="rounded-2xl bg-background p-4 text-sm text-muted-foreground">아직 아이콘 작업이 없습니다.</p>
          )}
          {jobs.data?.jobs.map((job: IconJob) => {
            const isApply = job.status === 'staged_awaiting_approval';
            const isRollback = job.status === 'source_applied_build_pending' || job.status === 'failed';
            const expectedPhrase = isApply ? '아이콘 소스 적용' : '아이콘 원복';
            return (
              <article key={job.id} className="rounded-2xl border border-card-border bg-background p-4 text-left">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-black">{job.sourceName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(job.createdAt).toLocaleString('ko-KR')} · {job.createdByName}
                    </p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-[11px] font-black ${statusClass(job.status)}`}>
                    {statusText(job.status)}
                  </span>
                </div>

                {job.note && <p className="mt-3 break-keep text-sm">{job.note}</p>}
                <div className="mt-3 rounded-xl bg-card p-3 text-xs text-muted-foreground">
                  <p className="font-bold text-foreground">변경 파일 {job.files.length}개</p>
                  {job.files.map((item: IconJobFile) => (
                    <p key={item.targetRelativePath} className="mt-1 truncate">
                      {item.width}×{item.height} · {item.targetRelativePath}
                    </p>
                  ))}
                </div>

                {job.status === 'source_applied_build_pending' && (
                  <div className="mt-3 rounded-xl bg-amber-500/10 p-3 text-xs font-bold text-amber-800 dark:text-amber-200">
                    <Clock3 className="mr-1 inline h-4 w-4" />
                    소스까지만 바뀌었습니다. 빌드 명령은 실행되지 않았습니다: {job.buildCommand}
                  </div>
                )}
                {job.status === 'rolled_back' && (
                  <p className="mt-3 rounded-xl bg-positive/10 p-3 text-xs font-bold text-positive">
                    <CheckCircle2 className="mr-1 inline h-4 w-4" />변경 전 아이콘으로 원복됐습니다.
                  </p>
                )}
                {job.error && <p className="mt-3 rounded-xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{job.error}</p>}

                {(isApply || isRollback) && (
                  <div className="mt-3">
                    <p className="mb-2 text-xs font-bold text-muted-foreground">
                      아래 문구 입력: <strong className="text-foreground">{expectedPhrase}</strong>
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        value={approvalInputs[job.id] ?? ''}
                        onChange={(event) => setApprovalInputs((current) => ({ ...current, [job.id]: event.target.value }))}
                        placeholder={expectedPhrase}
                        className="min-w-0 flex-1 rounded-xl border border-card-border bg-card px-3 py-2 text-sm font-bold"
                      />
                      {isApply ? (
                        <button
                          type="button"
                          disabled={busy || approvalInputs[job.id] !== expectedPhrase}
                          onClick={() => applySource.mutate(job)}
                          className="rounded-xl bg-primary px-4 py-2 text-sm font-black text-primary-foreground disabled:opacity-40"
                        >
                          소스 적용 · 빌드 전 멈춤
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || approvalInputs[job.id] !== expectedPhrase}
                          onClick={() => rollback.mutate(job)}
                          className="rounded-xl bg-destructive px-4 py-2 text-sm font-black text-destructive-foreground disabled:opacity-40"
                        >
                          <RotateCcw className="mr-1 inline h-4 w-4" />원복
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default function AdminPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const token = auth.session?.access_token ?? '';
  const [tab, setTab] = useState<AdminTab>('repair');

  if (!auth.isAdmin) {
    return (
      <div className="p-6">
        <ShieldAlert className="h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-xl font-black">관리자 권한이 필요합니다.</h1>
        <button onClick={() => navigate('/account')} className="mt-5 rounded-2xl bg-primary px-4 py-3 font-bold text-primary-foreground">
          계정으로 돌아가기
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background pb-12">
      <header className="sticky top-0 z-30 border-b border-card-border bg-background/95 px-4 py-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <button aria-label="뒤로 가기" onClick={() => navigate('/account')}><ArrowLeft /></button>
          <div className="flex-1 text-left">
            <h1 className="text-xl font-black">관리자 관리센터</h1>
            <p className="text-xs text-muted-foreground">회원 관리와 승인형 AI 복구 작업</p>
          </div>
          <Wrench className="h-5 w-5 text-primary" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl bg-secondary p-1">
          <button
            type="button"
            onClick={() => setTab('repair')}
            className={`rounded-xl px-3 py-2 text-sm font-black ${tab === 'repair' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
          >
            <Wrench className="mr-1 inline h-4 w-4" />AI 복구 기사
          </button>
          <button
            type="button"
            onClick={() => setTab('members')}
            className={`rounded-xl px-3 py-2 text-sm font-black ${tab === 'members' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
          >
            <Users className="mr-1 inline h-4 w-4" />회원 관리
          </button>
        </div>
      </header>
      <main className="p-4">
        {tab === 'repair' ? <IconRepairPanel token={token} /> : <MembersPanel token={token} />}
      </main>
    </div>
  );
}

```

## `stock-analyzer/src/pages/account.tsx`

```tsx
import { useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, Clock3, Eye, EyeOff, LogIn, LogOut, ShieldCheck, UserPlus } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { useAuth } from '@/lib/auth';

type AccountMode = 'login' | 'register' | 'find-id' | 'reset-password';

async function recoveryRequest(path: string, body: Record<string, string>) {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.message ?? payload?.error ?? '계정 확인에 실패했습니다.'));
  return payload as Record<string, unknown>;
}

export default function AccountPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const [mode, setMode] = useState<AccountMode>('login');
  const [loginName, setLoginName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const changeMode = (next: AccountMode) => {
    setMode(next);
    setNotice('');
    setError('');
    setPassword('');
    setConfirm('');
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if ((mode === 'register' || mode === 'reset-password') && password !== confirm) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await auth.signIn(loginName, password);
        navigate('/');
      } else if (mode === 'register') {
        await auth.signUp(loginName, password, displayName, birthDate);
        setNotice('가입 신청이 완료되었습니다. 관리자 승인 후 이용할 수 있습니다.');
      } else if (mode === 'find-id') {
        const result = await recoveryRequest('find-id', { displayName, birthDate });
        setNotice(`확인된 아이디: ${String(result.maskedLoginName ?? '')}`);
      } else {
        await recoveryRequest('reset-password', { loginName, birthDate, newPassword: password });
        setNotice('비밀번호를 재설정했습니다. 새 비밀번호로 로그인해 주세요.');
        setMode('login');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '계정 처리에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  const stateMessage = auth.profile?.status === 'pending' ? '관리자 승인 대기 중입니다.'
    : auth.profile?.status === 'rejected' ? '가입 신청이 반려되었습니다.'
      : auth.profile?.status === 'suspended' ? '이용이 정지된 계정입니다.'
        : auth.profile?.status === 'withdrawn' ? '탈퇴 처리된 계정입니다.' : '';

  return <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
	<header className="sticky top-0 z-30 border-b border-card-border bg-background/95 px-4 py-4 backdrop-blur"><div className="flex items-center gap-3">
      <button type="button" aria-label="뒤로 가기" onClick={() => navigate(auth.isApproved ? '/settings' : '/')} className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border"><ArrowLeft className="h-5 w-5" /></button>
      <div className="min-w-0"><h1 className="text-left text-xl font-extrabold">계정</h1><p className="mt-1 break-keep text-left text-xs text-muted-foreground">가입, 승인, 로그인과 계정 복구를 관리합니다.</p></div>
    </div></header>
    <main className="flex-1 px-4 pb-28 pt-5">
      {!auth.configured && <Card><p className="font-extrabold text-destructive">계정 저장소 설정이 필요합니다.</p><p className="mt-2 text-sm text-muted-foreground">Supabase 연결 정보를 관리자 설정에 등록해 주세요.</p></Card>}
      {auth.loading && <Card>계정 상태를 확인하고 있습니다.</Card>}
      {!auth.loading && auth.user ? <Card>
        <div className="flex items-center gap-3"><ShieldCheck className="h-8 w-8 text-primary" /><div className="min-w-0"><p className="text-xs text-muted-foreground">로그인 중</p><p className="truncate text-xl font-black">{auth.displayName ?? '사용자'}</p></div></div>
        {stateMessage && <div className="mt-4 flex gap-2 rounded-2xl bg-warning/10 p-4 text-sm font-bold text-warning"><Clock3 className="h-5 w-5 shrink-0" />{stateMessage}</div>}
        {auth.isApproved && <p className="mt-4 rounded-2xl bg-positive/10 p-4 text-sm font-bold text-positive">승인된 {auth.profile?.role === 'admin' ? '관리자' : auth.profile?.role === 'member' ? '정회원' : '일반회원'} 계정입니다.</p>}
        {auth.isAdmin && <button type="button" onClick={() => navigate('/admin')} className="mt-4 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground">관리자 관리센터</button>}
        <button type="button" onClick={() => void auth.signOut()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-extrabold"><LogOut className="h-4 w-4" />로그아웃</button>
      </Card> : !auth.loading && auth.configured && <Card>
        <div className="grid grid-cols-2 gap-1 rounded-2xl bg-secondary p-1">
          <ModeButton active={mode === 'login'} onClick={() => changeMode('login')}>로그인</ModeButton>
          <ModeButton active={mode === 'register'} onClick={() => changeMode('register')}>회원가입</ModeButton>
          <ModeButton active={mode === 'find-id'} onClick={() => changeMode('find-id')}>아이디 찾기</ModeButton>
          <ModeButton active={mode === 'reset-password'} onClick={() => changeMode('reset-password')}>비밀번호 재설정</ModeButton>
        </div>
        <form onSubmit={submit} className="mt-5 space-y-4">
          {(mode === 'login' || mode === 'register' || mode === 'reset-password') && <Field label="아이디"><input value={loginName} onChange={(event) => setLoginName(event.target.value)} minLength={2} maxLength={20} required autoComplete="username" className="input" placeholder="한글·영문·숫자 2~20자" /></Field>}
          {(mode === 'register' || mode === 'find-id') && <Field label="이름"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={40} required autoComplete="name" className="input" placeholder="이름" /></Field>}
          {(mode === 'register' || mode === 'find-id' || mode === 'reset-password') && <Field label="생년월일 앞 6자리"><input value={birthDate} onChange={(event) => setBirthDate(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" pattern="\d{6}" minLength={6} maxLength={6} required className="input" placeholder="YYMMDD" /></Field>}
          {(mode === 'login' || mode === 'register' || mode === 'reset-password') && <Field label={mode === 'reset-password' ? '새 비밀번호' : '비밀번호'}><div className="relative"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={72} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className="input pr-12" placeholder="8자 이상" /><button type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 보기'} className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-muted-foreground">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></Field>}
          {(mode === 'register' || mode === 'reset-password') && <Field label="비밀번호 확인"><input type={showPassword ? 'text' : 'password'} value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={8} maxLength={72} required className="input" placeholder="비밀번호 다시 입력" /></Field>}
          <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50">{mode === 'register' ? <UserPlus className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}{busy ? '처리 중…' : mode === 'login' ? '로그인' : mode === 'register' ? '가입 신청' : mode === 'find-id' ? '아이디 확인' : '비밀번호 재설정'}</button>
        </form>
        {(mode === 'find-id' || mode === 'reset-password') && <p className="mt-4 break-keep text-left text-[11px] font-bold leading-relaxed text-muted-foreground">생년월일 원문은 저장하지 않고 서버 HMAC 값으로만 비교합니다. 기존 비밀번호는 표시하지 않습니다.</p>}
      </Card>}
      {(notice || error) && <p className={`mt-3 break-keep rounded-2xl p-4 text-left text-sm font-bold ${error ? 'bg-destructive/10 text-destructive' : 'bg-positive/10 text-positive'}`}>{error || notice}</p>}
    </main>{auth.isApproved && <BottomNav />}
  </div>;
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button type="button" onClick={onClick} className={`rounded-xl px-2 py-2 text-xs font-bold ${active ? 'bg-card shadow' : 'text-muted-foreground'}`}>{children}</button>; }
function Card({ children }: { children: React.ReactNode }) { return <section className="rounded-3xl border border-card-border bg-card p-5 text-left shadow-sm">{children}</section>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="text-xs font-extrabold text-muted-foreground">{label}</span><div className="mt-2 [&_.input]:h-12 [&_.input]:w-full [&_.input]:rounded-2xl [&_.input]:border [&_.input]:border-card-border [&_.input]:bg-background [&_.input]:px-4 [&_.input]:text-sm [&_.input]:font-bold [&_.input]:outline-none [&_.input]:focus:border-primary">{children}</div></label>; }

```

## `AI_REPAIR_ICON_GUIDE.md`

```md
# AI 복구 기사 — 앱 아이콘 작업 1단계

이 버전은 관리자 화면에서 앱 아이콘 이미지를 서버에 업로드하고, 승인 후 PWA 아이콘 소스 파일에 적용한 다음 **빌드 직전에서 멈추는 기능**입니다.

## 동작 순서

1. 관리자 계정으로 로그인합니다.
2. `계정 → 관리자 관리센터 → AI 복구 기사`로 이동합니다.
3. PNG, JPG 또는 WEBP 이미지를 선택합니다.
4. 배경색과 요청내용을 입력하고 `서버에 올리고 작업 생성`을 누릅니다.
5. 브라우저가 64, 180, 192, 512, 마스커블 512 크기의 PNG를 생성합니다.
6. 서버가 PNG 구조, 파일 크기, 정확한 가로·세로 크기를 다시 검사하고 `.ai-repair/staging`에 저장합니다.
7. `아이콘 소스 적용` 문구를 직접 입력한 뒤 승인하면 기존 파일을 백업하고 소스 파일을 교체합니다.
8. `.ai-repair/pending-build.json`을 생성하고 빌드·배포는 실행하지 않습니다.
9. 문제가 있으면 `아이콘 원복` 문구를 입력해 변경 전 파일로 복구할 수 있습니다.

## 변경 대상

- `stock-analyzer/public/favicon.png`
- `stock-analyzer/public/icons/apple-touch-icon.png`
- `stock-analyzer/public/icons/icon-192.png`
- `stock-analyzer/public/icons/icon-512.png`
- `stock-analyzer/public/icons/maskable-512.png`
- `stock-analyzer/index.html`의 favicon 링크
- `stock-analyzer/public/icon-version.json`

## 안전장치

- 승인된 관리자만 접근 가능
- 업로드 파일은 브라우저에서 PNG로 변환
- 서버에서 PNG 시그니처, IHDR/IEND 구조, 크기 재검사
- 파일별 SHA-256 기록 및 적용 직전 재검사
- 기존 파일 전체 백업
- 임시 파일에 쓴 뒤 원자적 교체
- 중간 실패 시 자동 원복
- 빌드와 배포 자동 실행 금지
- Supabase 감사 로그 best-effort 기록
- `.env`, 비밀키, 주문 기능 및 데이터베이스는 변경하지 않음

## 서버 설정

서버가 프로젝트 루트를 자동으로 찾지 못하면 환경변수를 지정합니다.

```bash
AI_REPAIR_WORKSPACE_ROOT=/실제/프로젝트/루트
```

프로젝트 루트에는 `api-server/src`와 `stock-analyzer/public`이 모두 있어야 합니다.

## 빌드 승인 이후 수동 명령

이 버전에서는 아래 명령을 자동 실행하지 않습니다.

```bash
pnpm --filter @workspace/stock-analyzer run build
```

빌드 후 서버 재시작·배포·헬스체크·실패 시 롤백은 다음 단계에서 별도 승인 기능으로 연결합니다.

## Replit 배포 주의

Replit 작업공간에서는 소스 변경이 저장될 수 있지만, Cloud Run 형태의 배포 컨테이너 파일시스템은 재시작 시 변경이 사라질 수 있습니다. 영구 반영은 Git 저장소 또는 Vultr의 지속 디스크에 연결해야 합니다.

```

## `DEPLOY_AI_REPAIR_PREBUILD_ONLY.ps1`

```powershell
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$')]
    [string]$Server = 'root@lsj119.duckdns.org',

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^/[A-Za-z0-9._/-]+$')]
    [string]$RemoteProjectPath,

    [Parameter(Mandatory = $false)]
    [string]$PatchZip = (Join-Path $PSScriptRoot 'seungjae_AI복구기사_아이콘_빌드전_패치.zip')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $PatchZip -PathType Leaf)) {
    throw "패치 ZIP을 찾지 못했습니다: $PatchZip"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$remoteZip = "/tmp/seungjae-ai-repair-prebuild-$stamp.zip"
$remoteBackup = "$RemoteProjectPath/.manual-backups/ai-repair-prebuild-$stamp"

Write-Host "[1/4] 서버 연결과 프로젝트 경로를 확인합니다."
ssh $Server "set -eu; test -d '$RemoteProjectPath/api-server/src'; test -d '$RemoteProjectPath/stock-analyzer/src'; mkdir -p '$remoteBackup'"
if ($LASTEXITCODE -ne 0) { throw '서버 경로 확인에 실패했습니다.' }

Write-Host "[2/4] 변경 파일 패치를 서버 임시 경로에 업로드합니다."
scp -- $PatchZip "${Server}:$remoteZip"
if ($LASTEXITCODE -ne 0) { throw '패치 업로드에 실패했습니다.' }

Write-Host "[3/4] 기존 파일을 백업하고 소스 파일만 교체합니다."
$remoteCommand = @"
set -eu
cd '$RemoteProjectPath'
files='api-server/src/index.ts api-server/src/routes/index.ts stock-analyzer/src/pages/admin.tsx stock-analyzer/src/pages/account.tsx .gitignore'
for file in `$files; do
  if [ -f "`$file" ]; then
    mkdir -p '$remoteBackup/'"`$(dirname "`$file")"
    cp -p "`$file" '$remoteBackup/'"`$file"
  fi
done
mkdir -p '$remoteBackup/api-server/src/routes'
if [ -f api-server/src/routes/repair.ts ]; then cp -p api-server/src/routes/repair.ts '$remoteBackup/api-server/src/routes/repair.ts'; fi
unzip -oq '$remoteZip' -d '$RemoteProjectPath'
rm -f '$remoteZip'
printf '%s\n' 'SOURCE_APPLIED_BUILD_NOT_RUN' > '$RemoteProjectPath/.ai-repair-prebuild-state'
echo '소스 적용 완료. 빌드와 서버 재시작은 실행하지 않았습니다.'
echo '백업 위치: $remoteBackup'
"@

ssh $Server $remoteCommand
if ($LASTEXITCODE -ne 0) { throw '서버 소스 적용에 실패했습니다. 백업 폴더를 확인해 주세요.' }

Write-Host "[4/4] 적용 파일을 확인합니다."
ssh $Server "set -eu; test -f '$RemoteProjectPath/api-server/src/routes/repair.ts'; grep -q 'AI 복구 기사' '$RemoteProjectPath/stock-analyzer/src/pages/admin.tsx'; test -f '$RemoteProjectPath/.ai-repair-prebuild-state'; echo '검증 완료: 빌드 전 상태로 멈췄습니다.'"
if ($LASTEXITCODE -ne 0) { throw '적용 후 파일 검증에 실패했습니다.' }

Write-Host ''
Write-Host '완료: 서버 소스까지만 적용했고 빌드·배포·재시작은 하지 않았습니다.' -ForegroundColor Green
Write-Host "서버 백업: $remoteBackup"

```
