import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const testDir = path.resolve(root, 'test');
const outDir = path.resolve(root, '.test-dist');
const entryPoints = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(testDir, name));

if (entryPoints.length === 0) {
  console.error('[test] no test files found');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });

try {
  await build({
    entryPoints,
    outdir: outDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: 'inline',
    packages: 'external',
    logLevel: 'warning',
  });

  const tests = fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join(outDir, name));
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
