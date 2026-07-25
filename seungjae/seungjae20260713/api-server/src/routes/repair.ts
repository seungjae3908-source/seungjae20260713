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
