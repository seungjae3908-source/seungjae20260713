import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const repositoryRoot = path.resolve(root, '..');
const mode = process.argv[2] ?? 'all';
const groups = {
  phase2: [
    path.join(root, 'src/services/futures-market-data.service.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/futures-market-format.test.ts'),
  ],
  risk: [path.join(root, 'src/services/trading-risk-engine.service.test.ts')],
  phase4: [
    path.join(root, 'src/services/futures-contract-rules.service.test.ts'),
    path.join(root, 'src/services/trading-risk-contract-rules.test.ts'),
  ],
  phase5: [
    path.join(root, 'src/services/backtest-engine.service.test.ts'),
    path.join(root, 'src/services/backtest-performance.test.ts'),
  ],
  smoke: [
    path.join(root, 'src/routes/futures-market-data.smoke.test.ts'),
    path.join(root, 'src/routes/trading-risk.smoke.test.ts'),
    path.join(root, 'src/routes/futures-contract-rules.smoke.test.ts'),
    path.join(root, 'src/routes/backtests.smoke.test.ts'),
  ],
};

groups.unit = [...groups.phase2, ...groups.risk, ...groups.phase4, ...groups.phase5];
const allowedModes = ['all', 'unit', 'phase2', 'risk', 'phase4', 'phase5', 'smoke'];
if (!allowedModes.includes(mode)) throw new Error(`Unknown test mode: ${mode}`);

const entries = mode === 'all' ? [...groups.unit, ...groups.smoke] : groups[mode];
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'application-tests-'));
const outputFiles = [];

try {
  for (const [index, entryPoint] of entries.entries()) {
    const outputFile = path.join(temporaryDirectory, `application-${index}.test.cjs`);
    await build({
      entryPoints: [entryPoint],
      outfile: outputFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
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
