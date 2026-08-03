import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const deployScript = await readFile(path.join(root, 'ops/deploy-staging.sh'), 'utf8');

const fail = (message) => {
  throw new Error(`[staging-runtime-dependencies] ${message}`);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};

const promotionStart = deployScript.indexOf('ROLLBACK_REQUIRED=1\n\nrsync -a --delete');
assert(promotionStart >= 0, 'live promotion rsync block was not found');
const promotionEndMarker = '  "$RELEASE_DIR/" "$STAGING_DIR/"';
const promotionEnd = deployScript.indexOf(promotionEndMarker, promotionStart);
assert(promotionEnd >= 0, 'live promotion rsync destination was not found');
const promotionBlock = deployScript.slice(promotionStart, promotionEnd + promotionEndMarker.length);
const actualExcludes = [...promotionBlock.matchAll(/--exclude='([^']+)'/g)].map((match) => match[1]);

assert(!actualExcludes.some((pattern) => pattern === 'node_modules/' || pattern === '*/node_modules/'),
  'live promotion still excludes node_modules even though dist/index.mjs has runtime package imports');
assert(deployScript.includes('pnpm install --frozen-lockfile'),
  'release runtime dependencies must be installed before canary and promotion');

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'staging-runtime-deps-'));
const releaseDir = path.join(tempRoot, 'release');
const legacyDir = path.join(tempRoot, 'legacy-live');
const fixedDir = path.join(tempRoot, 'fixed-live');

async function createReleaseFixture() {
  await mkdir(path.join(releaseDir, 'api-server', 'dist'), { recursive: true });
  await mkdir(path.join(releaseDir, 'node_modules', 'express'), { recursive: true });
  await writeFile(
    path.join(releaseDir, 'api-server', 'dist', 'index.mjs'),
    "import express from 'express';\nconsole.log(express());\n",
  );
  await writeFile(
    path.join(releaseDir, 'node_modules', 'express', 'package.json'),
    JSON.stringify({ name: 'express', type: 'module', exports: './index.mjs' }, null, 2),
  );
  await writeFile(
    path.join(releaseDir, 'node_modules', 'express', 'index.mjs'),
    "export default function express() { return 'runtime-dependency-ok'; }\n",
  );
}

function syncRelease(destination, excludes) {
  const args = ['-a', '--delete'];
  for (const pattern of excludes) args.push('--exclude', pattern);
  args.push(`${releaseDir}/`, `${destination}/`);
  const result = spawnSync('rsync', args, { encoding: 'utf8' });
  assert(result.status === 0, `fixture rsync failed: ${result.stderr || result.stdout}`);
}

function runPromotedServer(destination) {
  return spawnSync(process.execPath, [path.join(destination, 'api-server', 'dist', 'index.mjs')], {
    encoding: 'utf8',
  });
}

try {
  await createReleaseFixture();

  await mkdir(legacyDir, { recursive: true });
  const legacyExcludes = [...actualExcludes, 'node_modules/', '*/node_modules/'];
  syncRelease(legacyDir, legacyExcludes);
  const legacyRun = runPromotedServer(legacyDir);
  assert(legacyRun.status !== 0, 'legacy node_modules exclusion unexpectedly resolved the runtime package');
  assert(
    `${legacyRun.stderr}\n${legacyRun.stdout}`.includes("Cannot find package 'express'")
      || `${legacyRun.stderr}\n${legacyRun.stdout}`.includes('ERR_MODULE_NOT_FOUND'),
    `legacy reproduction did not fail with the expected missing-package error: ${legacyRun.stderr}`,
  );

  await mkdir(fixedDir, { recursive: true });
  syncRelease(fixedDir, actualExcludes);
  const fixedRun = runPromotedServer(fixedDir);
  assert(fixedRun.status === 0, `promoted runtime could not resolve express: ${fixedRun.stderr}`);
  assert(fixedRun.stdout.trim() === 'runtime-dependency-ok',
    `unexpected promoted runtime output: ${fixedRun.stdout}`);

  console.log('[staging-runtime-dependencies] legacy exclusion reproduces ERR_MODULE_NOT_FOUND; current promotion preserves and resolves runtime dependencies');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
