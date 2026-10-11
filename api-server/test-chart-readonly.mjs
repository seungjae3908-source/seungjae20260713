import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Separate additive QA entry point: never rewrites the shared trading/research
// test groups or skips their existing assertions. All provider calls are mocked.
const root = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(root, '..');
const entries = [
  path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-live-feed.test.ts'),
  path.join(root, 'src/providers/yahoo-historical-cursor.test.ts'),
  path.join(root, 'src/routes/chart-historical-public.smoke.test.ts'),
  path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-analysis.test.ts'),
  path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-live-timeline.test.ts'),
];
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'chart-readonly-tests-'));
if (path.dirname(temporaryDirectory) !== path.resolve(tmpdir())) throw new Error('CHART_TEST_TEMP_ROOT_INVALID');
try {
  const outputs = [];
  for (const [index, entryPoint] of entries.entries()) {
    const outfile = path.join(temporaryDirectory, `chart-${index}.test.cjs`);
    await build({ entryPoints: [entryPoint], outfile, bundle: true, platform: 'node',
      format: 'cjs', target: 'node20', sourcemap: 'inline', logLevel: 'warning',
      define: { 'import.meta.env': '{}' } });
    outputs.push(outfile);
  }
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...outputs],
    { cwd: repositoryRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
