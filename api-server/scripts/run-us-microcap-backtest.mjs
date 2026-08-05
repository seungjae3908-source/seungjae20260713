import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'us-microcap-backtest-'));
const outputFile = path.join(temporaryDirectory, 'run-us-microcap-backtest.mjs');

try {
  await build({
    entryPoints: [path.join(root, 'src/scripts/run-us-microcap-backtest.ts')],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: 'inline',
    logLevel: 'warning',
  });
  const result = spawnSync(process.execPath, [outputFile, ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
