import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const repositoryRoot = path.resolve(root, '..');
const mode = process.argv[2] ?? 'all';
const groups = {
  unit: [
    path.join(root, 'src/services/futures-market-data.service.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/futures-market-format.test.ts'),
  ],
  smoke: [
    path.join(root, 'src/routes/futures-market-data.smoke.test.ts'),
  ],
};

if (!['all', 'unit', 'smoke'].includes(mode)) {
  throw new Error(`Unknown test mode: ${mode}`);
}

const entries = mode === 'all' ? [...groups.unit, ...groups.smoke] : groups[mode];
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'futures-market-tests-'));
const outputFiles = [];

try {
  for (const [index, entryPoint] of entries.entries()) {
    const outputFile = path.join(temporaryDirectory, `futures-market-${index}.test.mjs`);
    await build({
      entryPoints: [entryPoint],
      outfile: outputFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      sourcemap: 'inline',
      logLevel: 'warning',
    });
    outputFiles.push(outputFile);
  }

  const result = spawnSync(process.execPath, ['--test', ...outputFiles], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
