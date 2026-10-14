// Exact paths for the requested Research Center batch, not a prefix exemption.
// Shared execution changes are accepted only byte-for-byte from the integrated
// Paper repair snapshot; any later edit restores the automatic-trading gate.
// This merge preserves the original Paper snapshot and current-main manual
// holdings isolation. Both source ancestors remain required, not just a new pin.
export const PAPER_INTEGRATION_SHA = 'eba73478039c4d32a611b3139e8519442234c331';
export const PAPER_INTEGRATION_SOURCE_SHAS = Object.freeze([
  '09854c1895b1a41f0dfedc9cf1240734c88ac5e3',
  'af24fe44e286073de29cf31aa1f17fc13a309b28',
]);
export const RESEARCH_CENTER_BATCH_PATHS = Object.freeze([
  "market-prediction-lab/config/paper-risk-policy/natural-paper-btcusdt-v2.json",
  "market-prediction-lab/tests/paper-risk-policy-human-approval-v2.test.js",
  "stock-analyzer/e2e/professional-command-bar.spec.ts",
  "docs/screenshots/research-center-v2/after-desktop-ai-lab.png",
  "docs/screenshots/research-center-v2/after-desktop-paper.png",
  "docs/screenshots/research-center-v2/after-desktop-research-status.png",
  "docs/screenshots/research-center-v2/after-desktop-validation-report.png",
  "docs/screenshots/research-center-v2/after-mobile-390-paper.png",
  "docs/screenshots/research-center-v2/after-mobile-430-paper.png",
  "research-production/src/research-owner-criteria.d.mts",
  ".github/tests/pr-exact-head-paper-repair-checkout.test.mjs",
  "market-prediction-lab/tests/paper-forward-flat-snapshot-republish-contract-v1.test.js",
  ".github/scripts/paper-forward-reviewed-paths.mjs",
  ".github/scripts/research-ai-activation-result.cjs",
  ".github/scripts/research-center-batch-scope.mjs",
  ".github/scripts/verify-research-workspace-sync-v3.mjs",
  ".github/tests/production-admin-four-paper-rls.test.mjs",
  ".github/tests/research-center-batch-scope.test.mjs",
  ".github/tests/trading-ops-consolidated-preflight.test.mjs",
  ".github/workflows/paper-forward-schedule-validation.yml",
  ".github/workflows/production-comprehensive-readonly-qa.yml",
  ".github/workflows/production-deploy.yml",
  ".github/workflows/research-ai-production-activation.yml",
  ".github/workflows/research-center-predeploy-validation.yml",
  ".github/workflows/research-market-watch-activation.yml",
  ".github/workflows/research-production-activation.yml",
  ".github/workflows/research-production-validation.yml",
  ".github/workflows/research-workspace-integration-v1.yml",
  "api-server/scripts/verify-research-center-predeploy-contract.mjs",
  "api-server/src/routes/index.ts",
  "api-server/src/routes/paper-journal.ts",
  "api-server/src/routes/research-overview.test.ts",
  "api-server/src/routes/research-overview.ts",
  "api-server/src/services/admin-four-market-paper-readback.service.test.ts",
  "api-server/src/services/admin-four-market-paper-readback.service.ts",
  "api-server/src/services/automatic-paper-journal-mirror.service.test.ts",
  "api-server/src/services/automatic-paper-journal-mirror.service.ts",
  "api-server/src/services/member-auto-trading-background-worker.service.test.ts",
  "api-server/src/services/member-auto-trading-background-worker.service.ts",
  "api-server/src/services/member-auto-trading-exit-plan.service.test.ts",
  "api-server/src/services/member-auto-trading-exit-plan.service.ts",
  "api-server/src/services/paper-futures-funding-certificate.service.test.ts",
  "api-server/src/services/paper-futures-funding-certificate.service.ts",
  "api-server/src/services/research-copilot.service.test.ts",
  "api-server/src/services/research-copilot.service.ts",
  "api-server/src/services/research-dual-free-ai.service.ts",
  "api-server/src/services/trade-automation-unified-journal-adapter.ts",
  "api-server/src/services/trade-automation.repository.ts",
  "api-server/src/services/trade-automation.service.ts",
  "api-server/src/services/trade-automation.types.ts",
  "api-server/src/services/trade-execution-pre-submission.test.ts",
  "api-server/src/services/trade-execution.service.ts",
  "api-server/src/services/unified-trade-journal.service.test.ts",
  "docs/research-center-criteria-draft-ko.md",
  "docs/research-center-criteria-draft.json",
  "market-prediction-lab/src/evidence-backed-formula-entry-evaluator-v1.js",
  "market-prediction-lab/src/formula-auto-backtest-queue-v1.js",
  "market-prediction-lab/src/registered-formula-prospective-watch-v1.js",
  "market-prediction-lab/tests/evidence-backed-formula-entry-evaluator-v1.test.js",
  "market-prediction-lab/tests/formula-auto-backtest-queue-v1.test.js",
  "market-prediction-lab/tests/registered-formula-prospective-watch-v1.test.js",
  "ops/apply-production-admin-four-paper-rls.mjs",
  "ops/verify-production-admin-four-paper-rls.mjs",
  "research-production/README-market-watch.md",
  "research-production/bin/autonomous-research-closed-loop.mjs",
  "research-production/bin/confirm-research-free-policy.mjs",
  "research-production/bin/lightweight-market-watch-preflight.mjs",
  "research-production/bin/lightweight-market-watch.mjs",
  "research-production/bin/stock-source-preflight.mjs",
  "research-production/deploy/activate-ai-research.sh",
  "research-production/deploy/research-production-ai-review.service",
  "research-production/src/autonomous-research-closed-loop-v1.mjs",
  "research-production/src/lightweight-market-watch-capacity.mjs",
  "research-production/src/lightweight-market-watch-readback.mjs",
  "research-production/src/lightweight-market-watch-storage.mjs",
  "research-production/src/lightweight-market-watch.mjs",
  "research-production/src/research-ai-review-worker.d.mts",
  "research-production/src/research-ai-review-worker.mjs",
  "research-production/src/research-free-policy-confirmation.d.mts",
  "research-production/src/research-free-policy-confirmation.mjs",
  "research-production/src/research-owner-criteria.mjs",
  "research-production/test/lightweight-market-watch-capacity-readback.test.mjs",
  "research-production/test/lightweight-market-watch-capacity.test.mjs",
  "research-production/test/lightweight-market-watch-preflight.test.mjs",
  "research-production/test/lightweight-market-watch-readback.test.mjs",
  "research-production/test/lightweight-market-watch-storage.test.mjs",
  "research-production/test/lightweight-market-watch.test.mjs",
  "research-production/test/autonomous-research-closed-loop-v1.test.mjs",
  "research-production/test/research-ai-units-install-contract.test.mjs",
  "research-production/test/research-ai-activation-contract.test.mjs",
  "research-production/test/research-ai-activation-lifecycle.test.mjs",
  "research-production/test/research-ai-activation-result.test.mjs",
  "research-production/test/research-ai-review-worker.test.mjs",
  "research-production/test/research-free-policy-confirmation.test.mjs",
  "research-production/test/research-owner-criteria.test.mjs",
  "research-production/test/research-production-activation-workflow.test.mjs",
  "research-production/test/stock-source-preflight.test.mjs",
  "stock-analyzer/e2e/full-product-browser-flow.spec.ts",
  "stock-analyzer/e2e/production-research-center-readonly-qa.spec.ts",
  "stock-analyzer/e2e/research-center-professional-hierarchy.spec.ts",
  "stock-analyzer/e2e/research-center-simple-ko-ai-debate.spec.ts",
  "stock-analyzer/e2e/research-copilot.spec.ts",
  "stock-analyzer/e2e/research-evidence-maturity.spec.ts",
  "stock-analyzer/e2e/research-paper-closed-loop-observer.spec.ts",
  "stock-analyzer/e2e/research-video-intelligence.spec.ts",
  "stock-analyzer/e2e/support/start-vite-e2e-server.mjs",
  "stock-analyzer/playwright.config.ts",
  "stock-analyzer/playwright.research-workspace.config.ts",
  "stock-analyzer/src/App.tsx",
  "stock-analyzer/src/components/paper-closed-loop-observer.tsx",
  "stock-analyzer/src/components/professional-command-bar-content.tsx",
  "stock-analyzer/src/components/research-center-general.tsx",
  "stock-analyzer/src/components/research-copilot-panel.tsx",
  "stock-analyzer/src/components/research-detail-dialog.tsx",
  "stock-analyzer/src/components/research-lightweight-market-watch-panel.tsx",
  "stock-analyzer/src/components/research-video-panel.tsx",
  "stock-analyzer/src/components/research-video-source-panel.tsx",
  "stock-analyzer/src/lib/app-navigation.ts",
  "stock-analyzer/src/lib/research-center-product.ts",
  "stock-analyzer/src/lib/research-center.ts",
  "stock-analyzer/src/pages/research-center-workspace.tsx",
  "stock-analyzer/src/pages/research-center.tsx",
  "trade-execution-gateway/src/capital-managed-paper-gateway.mjs",
  "trade-execution-gateway/src/paper-capital-manager.mjs",
  "trade-execution-gateway/tests/capital-managed-paper-gateway-v08.test.mjs",
  "trade-execution-gateway/tests/paper-capital-manager-v08.test.mjs"
]);
const pinnedPaperPaths = new Set([
  ".github/tests/trading-ops-consolidated-preflight.test.mjs",
  "api-server/src/routes/paper-journal.ts",
  "api-server/src/services/admin-four-market-paper-readback.service.test.ts",
  "api-server/src/services/admin-four-market-paper-readback.service.ts",
  "api-server/src/services/member-auto-trading-background-worker.service.test.ts",
  "api-server/src/services/member-auto-trading-background-worker.service.ts",
  "api-server/src/services/trade-automation-unified-journal-adapter.ts",
  "api-server/src/services/trade-automation.service.ts",
  "api-server/src/services/trade-automation.types.ts",
  "api-server/src/services/trade-execution-pre-submission.test.ts",
  "api-server/src/services/trade-execution.service.ts"
]);
const uiPaths = new Set(RESEARCH_CENTER_BATCH_PATHS.filter((file) => file.startsWith('stock-analyzer/')));
export function isResearchCenterBatchUi(file) { return uiPaths.has(file); }
/** Only these exact research-navigation substitutions may coexist with the
 * main-owned Trading UI review. Any additional edit restores its full gate. */
export function isResearchOnlyNavigationDiff(file, diff) {
  const pairs = file === 'stock-analyzer/src/lib/app-navigation.ts' ? [
    ["      { id: 'research-center', href: APP_ROUTES.researchCenter, label: '연구센터', icon: 'chart', capability: 'canManageMembers' },",
     "      { id: 'research-center', href: APP_ROUTES.researchCenter, label: '연구센터', icon: 'chart', capability: 'canAccessBasicInfo' },"],
  ] : file === 'stock-analyzer/e2e/full-product-browser-flow.spec.ts' ? [
    ["  await expect(page.getByTestId('research-workspace-selection')).toContainText('현재 · 요약');", "  await expect(page.getByTestId('research-workspace-tabs').getByRole('button')).toHaveCount(6);"],
    ["  await page.getByRole('button', { name: '상세', exact: true }).click();", "  await page.getByRole('button', { name: '연구', exact: true }).click();"],
    ["  await expect(page.getByRole('button', { name: '상세', exact: true })).toHaveAttribute('aria-pressed', 'true');", "  await expect(page.getByRole('button', { name: '연구', exact: true })).toHaveAttribute('aria-pressed', 'true');"],
    ["  await expect(page.getByRole('tablist', { name: '연구센터 핵심 화면' })).toBeVisible();", "  await expect(page.getByRole('tablist', { name: '연구센터 핵심 화면' })).toHaveCount(0);"],
  ] : null;
  if (!pairs || typeof diff !== 'string') return false;
  const edits = diff.split(/\r?\n/u).filter(line => /^[+-]/u.test(line) && !/^(?:\+\+\+|---)/u.test(line));
  const expected = pairs.flatMap(([before, after]) => ['-' + before, '+' + after]);
  return JSON.stringify(edits.sort()) === JSON.stringify(expected.sort());
}
export function isPreservedPaperIntegrationPath(file, readBlob) {
  if (!pinnedPaperPaths.has(file)) return false;
  try {
    const expected = readBlob(PAPER_INTEGRATION_SHA, file);
    const actual = readBlob('HEAD', file);
    return /^[0-9a-f]{40}$/u.test(expected ?? '') && actual === expected;
  } catch { return false; }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/research-center-batch-scope.mjs')) {
  if (process.argv[2] !== '--list-paths') throw new Error('READ_ONLY_SCOPE_LIST_ONLY');
  console.log(RESEARCH_CENTER_BATCH_PATHS.join('\n'));
}
