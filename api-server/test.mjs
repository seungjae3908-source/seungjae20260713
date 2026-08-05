import { build } from 'esbuild';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
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
    path.join(root, 'src/services/backtest-indicators-edge.test.ts'),
    path.join(root, 'src/services/backtest-data.service.test.ts'),
    path.join(root, 'src/services/backtest-performance.test.ts'),
  ],
  phase6: [
    path.join(root, 'src/services/paper-trading-engine.service.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/paper-trading-storage.test.ts'),
  ],
  phase7: [
    path.join(root, 'src/services/paper-journal-sync.service.test.ts'),
    path.join(root, 'src/services/paper-journal-analytics.service.test.ts'),
    path.join(root, 'src/services/paper-journal-migration.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/paper-journal-sync-storage.test.ts'),
  ],
  phase8: [
    path.join(root, 'src/services/member-access-phase8.test.ts'),
    path.join(root, 'src/services/member-administration.service.test.ts'),
    path.join(root, 'src/services/release-candidate-phase8.test.ts'),
    path.join(root, 'src/routes/member-access-phase8.smoke.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/paper-journal-archive-phase8.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/paper-journal-batching-phase8.test.ts'),
  ],
  phase9: [
    path.join(root, 'src/services/trading-ai-review-phase9.test.ts'),
    path.join(root, 'src/routes/paper-journal-ai-preview-privileges.test.ts'),
    path.join(root, 'src/services/ai-chat.service.test.ts'),
    path.join(root, 'src/services/signal-score.test.ts'),
    path.join(root, 'src/services/bounded-scanner.service.test.ts'),
    path.join(root, 'src/services/scanner-request-guard.service.test.ts'),
    path.join(root, 'src/services/scanner-signal-policy.service.test.ts'),
    path.join(root, 'src/services/scanner-signal-lifecycle.service.test.ts'),
    path.join(root, 'src/services/crypto-signal-scanner.service.test.ts'),
    path.join(root, 'src/lib/bounded-work-pool.test.ts'),
    path.join(root, 'src/providers/yahoo-timeframe.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/trading-ai-review-storage.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/analysis-selection.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-analysis.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/scanner-request.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-live-timeline.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-candle-normalizer.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-indicator-engine.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-structure-engine.test.ts'),
  ],
  phase12: [
    path.join(root, 'src/services/trade-automation-integration.test.ts'),
    path.join(root, 'src/routes/trade-automation.smoke.test.ts'),
    path.join(root, 'src/services/trade-signal-lifecycle.service.test.ts'),
    path.join(root, 'src/routes/trade-signal-approval.smoke.test.ts'),
    path.join(root, 'src/services/trade-signal-alert.service.test.ts'),
    path.join(root, 'src/routes/trade-signal-alerts.smoke.test.ts'),
    path.join(root, 'src/services/scanner-approval-plan.service.test.ts'),
    path.join(root, 'src/services/scanner-approval-revalidation.service.test.ts'),
    path.join(root, 'src/routes/scanner-approval.smoke.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/scanner-saved-searches.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/crypto-spot-scanner.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/crypto-futures-scanner.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/profile-request-coordinator.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/e2e/support/safe-api-diagnostic.test.ts'),
  ],
  smoke: [
    path.join(root, 'src/routes/futures-market-data.smoke.test.ts'),
    path.join(root, 'src/routes/trading-risk.smoke.test.ts'),
    path.join(root, 'src/routes/futures-contract-rules.smoke.test.ts'),
    path.join(root, 'src/routes/backtests.smoke.test.ts'),
    path.join(root, 'src/routes/paper-trading.smoke.test.ts'),
    path.join(root, 'src/routes/paper-journal.smoke.test.ts'),
    path.join(root, 'src/routes/paper-journal-query-identity.smoke.test.ts'),
    path.join(root, 'src/routes/bounded-market-scan.smoke.test.ts'),
    path.join(root, 'src/routes/signal-scanner-auth.smoke.test.ts'),
    path.join(root, 'src/routes/kiwoom-rankings-safe.smoke.test.ts'),
  ],
};

groups.unit = [...groups.phase2, ...groups.risk, ...groups.phase4, ...groups.phase5, ...groups.phase6, ...groups.phase7, ...groups.phase8, ...groups.phase9, ...groups.phase12];
const allowedModes = ['all', 'unit', 'phase2', 'risk', 'phase4', 'phase5', 'phase6', 'phase7', 'phase8', 'phase9', 'phase12', 'smoke'];
if (!allowedModes.includes(mode)) throw new Error(`Unknown test mode: ${mode}`);

const entries = mode === 'all' ? [...groups.unit, ...groups.smoke] : groups[mode];
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'application-tests-'));
const outputFiles = [];
const escapeWorkflowCommand = (value) => value
  .replaceAll('%', '%25')
  .replaceAll('\r', '%0D')
  .replaceAll('\n', '%0A');

try {
  for (const [index, entryPoint] of entries.entries()) {
    const outputFile = path.join(temporaryDirectory, `application-${index}.test.cjs`);
    await build({
      entryPoints: [entryPoint], outfile: outputFile, bundle: true, platform: 'node',
      format: 'cjs', target: 'node20', sourcemap: 'inline', logLevel: 'warning',
    });
    outputFiles.push(outputFile);
  }

  if (mode === 'phase12') {
    const failedEntries = [];
    for (const [index, outputFile] of outputFiles.entries()) {
      const entryPoint = entries[index];
      const relativeEntry = path.relative(repositoryRoot, entryPoint).replaceAll('\\', '/');
      console.log(`[phase12] running ${relativeEntry}`);
      const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', outputFile], {
        cwd: repositoryRoot,
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if ((result.status ?? 1) !== 0) {
        failedEntries.push(relativeEntry);
        const annotationPath = escapeWorkflowCommand(relativeEntry);
        process.stdout.write(`::error file=${annotationPath},line=1,title=Phase 12 test failure::Phase 12 test file failed%0A${annotationPath}\n`);
      }
    }
    if (failedEntries.length > 0) {
      const failedList = failedEntries.join(', ');
      if (process.env.GITHUB_STEP_SUMMARY) {
        const summary = [
          '## Phase 12 failed test files',
          '',
          ...failedEntries.map((entry) => `- \`${entry}\``),
          '',
        ].join('\n');
        await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
      }
      process.stdout.write(`::error title=Phase 12 failed files::${escapeWorkflowCommand(failedList)}\n`);
      throw new Error(`Phase 12 failed test files: ${failedList}`);
    }
    process.exitCode = 0;
  } else {
    const testArguments = mode === 'phase9'
      ? ['--test', '--test-concurrency=1', ...outputFiles]
      : ['--test', ...outputFiles];
    const result = spawnSync(process.execPath, testArguments, {
      cwd: repositoryRoot, stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
