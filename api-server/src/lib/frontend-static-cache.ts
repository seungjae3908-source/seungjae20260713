import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

export const FRONTEND_REVALIDATE_CACHE_CONTROL = 'no-cache, no-store, must-revalidate';
export const FRONTEND_IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const FRONTEND_DEFAULT_CACHE_CONTROL = 'public, max-age=3600';
export const FRONTEND_WARMUP_MAX_FILES = 128;
export const FRONTEND_WARMUP_MAX_BYTES = 64 * 1024 * 1024;

const MUST_REVALIDATE_FILES = new Set([
  'index.html',
  'sw.js',
  'registerSW.js',
  'push-sw.js',
  'manifest.webmanifest',
]);
const WARMABLE_ASSET_EXTENSIONS = new Set(['.js', '.css']);
const CRITICAL_WARMUP_CHUNK = /(ai-chart|backtests|paper-trading)/i;

type FrontendWarmupOptions = {
  maxFiles?: number;
  maxBytes?: number;
};

export type FrontendWarmupPlan = {
  files: string[];
  plannedBytes: number;
  criticalFiles: number;
  truncated: boolean;
};

export type FrontendWarmupResult = FrontendWarmupPlan & {
  warmedFiles: number;
  warmedBytes: number;
  errors: number;
};

function productionFrontendDistCandidates(cwd = process.cwd()) {
  return [
    path.resolve(cwd, '../stock-analyzer/dist/public'),
    path.resolve(cwd, '../stock-analyzer/dist'),
    path.resolve(cwd, 'artifacts/stock-analyzer/dist/public'),
    path.resolve(cwd, 'artifacts/stock-analyzer/dist'),
    path.resolve(cwd, 'stock-analyzer/dist/public'),
    path.resolve(cwd, 'stock-analyzer/dist'),
  ];
}

function listWarmableAssets(root: string) {
  const files: string[] = [];
  if (!existsSync(root)) return files;

  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.isFile() && WARMABLE_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(absolute);
      }
    }
  };

  visit(root);
  return files;
}

export function planFrontendStaticWarmup(
  frontendDist: string,
  options: FrontendWarmupOptions = {},
): FrontendWarmupPlan {
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? FRONTEND_WARMUP_MAX_FILES));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? FRONTEND_WARMUP_MAX_BYTES));
  const indexPath = path.join(frontendDist, 'index.html');
  const candidates = [
    ...(existsSync(indexPath) ? [indexPath] : []),
    ...listWarmableAssets(path.join(frontendDist, 'assets')),
  ].sort((left, right) => {
    const leftPriority = left === indexPath ? 0 : CRITICAL_WARMUP_CHUNK.test(path.basename(left)) ? 1 : 2;
    const rightPriority = right === indexPath ? 0 : CRITICAL_WARMUP_CHUNK.test(path.basename(right)) ? 1 : 2;
    return leftPriority - rightPriority || left.localeCompare(right);
  });

  const files: string[] = [];
  let plannedBytes = 0;
  let criticalFiles = 0;
  let truncated = false;

  for (const filePath of candidates) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      truncated = true;
      continue;
    }
    if (size < 0 || plannedBytes + size > maxBytes) {
      truncated = true;
      continue;
    }
    files.push(filePath);
    plannedBytes += size;
    if (CRITICAL_WARMUP_CHUNK.test(path.basename(filePath))) criticalFiles += 1;
  }

  if (files.length < candidates.length) truncated = true;
  return { files, plannedBytes, criticalFiles, truncated };
}

export function warmFrontendStaticFiles(
  frontendDist: string,
  options: FrontendWarmupOptions = {},
): FrontendWarmupResult {
  const plan = planFrontendStaticWarmup(frontendDist, options);
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let warmedFiles = 0;
  let warmedBytes = 0;
  let errors = 0;

  for (const filePath of plan.files) {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(filePath, 'r');
      let bytesRead = 0;
      do {
        bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
        warmedBytes += bytesRead;
      } while (bytesRead > 0);
      warmedFiles += 1;
    } catch {
      errors += 1;
    } finally {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { errors += 1; }
      }
    }
  }

  return { ...plan, warmedFiles, warmedBytes, errors };
}

export function resolveProductionFrontendDist(cwd = process.cwd()) {
  return productionFrontendDistCandidates(cwd).find((candidate) =>
    existsSync(path.join(candidate, 'index.html')),
  );
}

function scheduleProductionFrontendWarmup() {
  if (process.env.NODE_ENV !== 'production' || process.env.FRONTEND_STATIC_WARMUP === 'false') return;

  queueMicrotask(() => {
    try {
      const frontendDist = resolveProductionFrontendDist();
      if (!frontendDist) {
        console.warn('[frontend-static-warmup] skipped: frontend dist not found');
        return;
      }
      const result = warmFrontendStaticFiles(frontendDist);
      console.info(
        `[frontend-static-warmup] files=${result.warmedFiles}/${result.files.length} bytes=${result.warmedBytes} critical=${result.criticalFiles} truncated=${String(result.truncated)} errors=${result.errors}`,
      );
    } catch (error) {
      console.warn(
        `[frontend-static-warmup] failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

scheduleProductionFrontendWarmup();

export function frontendStaticCacheControl(frontendDist: string, filePath: string): string {
  const relative = path.relative(frontendDist, filePath).split(path.sep).join('/');

  if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
    return FRONTEND_REVALIDATE_CACHE_CONTROL;
  }

  if (MUST_REVALIDATE_FILES.has(relative)) {
    return FRONTEND_REVALIDATE_CACHE_CONTROL;
  }

  if (relative.startsWith('assets/') || /^workbox-[A-Za-z0-9_-]+\.js$/.test(relative)) {
    return FRONTEND_IMMUTABLE_CACHE_CONTROL;
  }

  return FRONTEND_DEFAULT_CACHE_CONTROL;
}

export function setFrontendStaticCacheHeaders(
  response: { setHeader(name: string, value: string): unknown },
  frontendDist: string,
  filePath: string,
) {
  response.setHeader('Cache-Control', frontendStaticCacheControl(frontendDist, filePath));
}
