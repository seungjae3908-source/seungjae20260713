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
    path.join(root, 'src/services/unified-trade-journal.service.test.ts'),
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
    path.join(root, 'src/services/ai-chat-public-crypto-context.service.test.ts'),
    path.join(root, 'src/services/ai-chat-hardening.service.test.ts'),
    path.join(root, 'src/services/signal-score.test.ts'),
    path.join(root, 'src/services/bounded-scanner.service.test.ts'),
    path.join(root, 'src/services/scanner-request-guard.service.test.ts'),
    path.join(root, 'src/services/scanner-signal-policy.service.test.ts'),
    path.join(root, 'src/services/scanner-price-precision.service.test.ts'),
    path.join(root, 'src/services/scanner-signal-lifecycle.service.test.ts'),
    path.join(root, 'src/services/scanner-market-action.service.test.ts'),
    path.join(root, 'src/services/scanner-access-control.service.test.ts'),
    path.join(root, 'src/services/scanner-data-quality.service.test.ts'),
    path.join(root, 'src/services/scanner-quant-strategy.service.test.ts'),
    path.join(root, 'src/services/scanner-quant-hardening.service.test.ts'),
    path.join(root, 'src/services/scanner-ai-provider.service.test.ts'),
    path.join(root, 'src/services/scanner-backtest-metrics.service.test.ts'),
    path.join(root, 'src/services/scanner-candidate-ranking.service.test.ts'),
    path.join(root, 'src/services/stock-signal-scanner-aggregation.test.ts'),
    path.join(root, 'src/services/crypto-signal-scanner.service.test.ts'),
    path.join(root, 'src/services/scanner-crypto-price-precision.service.test.ts'),
    path.join(root, 'src/lib/bounded-work-pool.test.ts'),
    path.join(root, 'src/lib/cache.test.ts'),
    path.join(root, 'src/providers/yahoo-timeframe.test.ts'),
    path.join(root, 'src/providers/toss.test.ts'),
    path.join(root, 'src/services/telegram-notification.service.test.ts'),
    path.join(root, 'src/modules/portfolio/portfolio-core.test.ts'),
    path.join(root, 'src/modules/portfolio/canonical-journal-adapter.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/trading-ai-review-storage.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/analysis-selection.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/asset-navigation.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-analysis.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/scanner-request.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-live-timeline.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-candle-normalizer.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-indicator-engine.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/chart-structure-engine.test.ts'),
  ],
  phase12: [
    path.join(root, 'src/services/trade-approval-paper-guard.service.test.ts'),
    path.join(root, 'src/services/trade-automation-integration.test.ts'),
    path.join(root, 'src/services/trade-automation-repository-compatibility.test.ts'),
    path.join(root, 'src/services/trade-kill-switch.test.ts'),
    path.join(root, 'src/services/trade-order-recovery.test.ts'),
    path.join(root, 'src/services/trade-cancel-reconciliation.test.ts'),
    path.join(root, 'src/services/trade-recovery-worker.test.ts'),
    path.join(root, 'src/services/trade-pre-submission-risk.test.ts'),
    path.join(root, 'src/services/trade-execution-pre-submission.test.ts'),
    path.join(root, 'src/services/trade-risk-envelope.test.ts'),
    path.join(root, 'src/services/trade-split-order-planner.test.ts'),
    path.join(root, 'src/services/trade-split-order-materializer.test.ts'),
    path.join(root, 'src/services/trade-split-order-execution.test.ts'),
    path.join(root, 'src/services/auto-trading-v2.service.test.ts'),
    path.join(root, 'src/routes/trade-automation.smoke.test.ts'),
    path.join(root, 'src/routes/trade-automation-split.smoke.test.ts'),
    path.join(root, 'src/routes/trade-automation-recovery.smoke.test.ts'),
    path.join(root, 'src/routes/trade-automation-cancel-race.smoke.test.ts'),
    path.join(root, 'src/routes/account-connections.contract.test.ts'),
    path.join(root, 'src/routes/stock-orderbook.test.ts'),
    path.join(root, 'src/services/market-information.service.test.ts'),
    path.join(root, 'src/services/public-market-http.test.ts'),
    path.join(root, 'src/lib/deployment-identity.test.ts'),
    path.join(root, 'src/features/user-broker-telegram/user-broker-telegram.service.test.ts'),
    path.join(root, 'src/features/user-broker-telegram/trade-execution-event-bridge.service.test.ts'),
    path.join(root, 'src/features/user-broker-telegram/user-broker-telegram.runtime.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/market-information.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/profile-request-coordinator.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/auth-bootstrap.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/backup-sync-lifecycle.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/e2e/support/safe-api-diagnostic.test.ts'),
  ],
  search: [
    path.join(root, 'src/services/unified-asset-search.service.test.ts'),
    path.join(root, 'src/services/unified-asset-search-fallback.test.ts'),
    path.join(repositoryRoot, 'stock-analyzer/src/lib/unified-asset-search.test.ts'),
    path.join(root, 'src/routes/unified-search.smoke.test.ts'),
  ],
  smoke: [
    path.join(root, 'src/routes/futures-market-data.smoke.test.ts'),
    path.join(root, 'src/routes/trading-risk.smoke.test.ts'),
    path.join(root, 'src/routes/futures-contract-rules.smoke.test.ts'),
    path.join(root, 'src/routes/backtests.smoke.test.ts'),
    path.join(root, 'src/routes/paper-trading.smoke.test.ts'),
    path.join(root, 'src/routes/paper-journal.smoke.test.ts'),
    path.join(root, 'src/routes/paper-journal-query-identity.smoke.test.ts'),
    path.join(root, 'src/routes/unified-trade-journal.route.test.ts'),
    path.join(root, 'src/routes/portfolio-advisor-canonical.route.test.ts'),
    path.join(root, 'src/routes/bounded-market-scan.smoke.test.ts'),
    path.join(root, 'src/routes/signal-scanner-auth.smoke.test.ts'),
    path.join(root, 'src/routes/kiwoom-rankings-safe.smoke.test.ts'),
    path.join(root, 'src/routes/market-information.smoke.test.ts'),
    path.join(root, 'src/routes/unified-search.smoke.test.ts'),
    path.join(root, 'src/routes/stock-orderbook.smoke.test.ts'),
  ],
};

groups.unit = [
  ...groups.phase2,
  ...groups.risk,
  ...groups.phase4,
  ...groups.phase5,
  ...groups.phase6,
  ...groups.phase7,
  ...groups.phase8,
  ...groups.phase9,
  ...groups.phase12,
  groups.search[0],
  groups.search[1],
  groups.search[2],
];
const allowedModes = ['all', 'unit', 'phase2', 'risk', 'phase4', 'phase5', 'phase6', 'phase7', 'phase8', 'phase9', 'phase12', 'search', 'smoke'];
if (!allowedModes.includes(mode)) throw new Error(`Unknown test mode: ${mode}`);

const entries = mode === 'all' ? [...groups.unit, ...groups.smoke] : groups[mode];
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'application-tests-'));
const outputFiles = [];

try {
  for (const [index, entryPoint] of entries.entries()) {
    const outputFile = path.join(temporaryDirectory, `application-${index}.test.cjs`);
    await build({
      entryPoints: [entryPoint], outfile: outputFile, bundle: true, platform: 'node',
      format: 'cjs', target: 'node20', sourcemap: 'inline', logLevel: 'warning',
      define: { 'import.meta.env': '{}' },
    });
    outputFiles.push(outputFile);
  }

  // Phase 9 includes real deadline/concurrency contracts. Run its bundled test files
  // serially so host-level event-loop contention cannot consume a scanner deadline
  // before the test body starts. Test coverage and every assertion remain unchanged.
  const testArguments = mode === 'phase9'
    ? ['--test', '--test-concurrency=1', ...outputFiles]
    : ['--test', ...outputFiles];
  const result = spawnSync(process.execPath, testArguments, {
    cwd: repositoryRoot, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}