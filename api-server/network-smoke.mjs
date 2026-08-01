import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'futures-network-smoke-'));
const outputFile = path.join(temporaryDirectory, 'futures-network-smoke.mjs');

try {
  await build({
    entryPoints: [path.join(root, 'src/routes/futures-market-data.network-smoke.ts')],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: 'inline',
    logLevel: 'warning',
  });

  const result = spawnSync(process.execPath, [outputFile], {
    cwd: root,
    stdio: 'inherit',
    timeout: 90_000,
  });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
