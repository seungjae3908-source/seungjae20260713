import { execFileSync } from 'node:child_process';

// This is an immutable scope classification for the user's Draft scanner repair,
// not trading approval. Every shared byte must match the verified source commit.
// Further edits restore the full gate; no prefix, rename or wildcard exemption.
export const SCANNER_REPAIR_SOURCE_SHA = '0d3f42a9b9639a902c0ce2ef713c8d75dc69b1be';
// Keep the pre-policy workflow baseline immutable even when a later source-only
// regression fixture is pinned. A repin must not bless removal of safety steps.
export const SCANNER_REPAIR_WORKFLOW_BASE_SHA = '6139042aaef5e7fec6bcc39648ccdddb949121e6';
export const SCANNER_REPAIR_PINNED_PATHS = Object.freeze([
  "api-server/scripts/verify-production-us-chart-candle-priority-contract.mjs",
  "api-server/src/kiwoom-chart-window.test.ts",
  "api-server/src/providers/krx-source-pair.test.ts",
  "api-server/src/providers/krx.ts",
  "api-server/src/providers/nasdaq-trader.test.ts",
  "api-server/src/providers/nasdaq-trader.ts",
  "api-server/src/providers/us-universe.ts",
  "api-server/src/providers/yahoo-timeframe.test.ts",
  "api-server/src/providers/yahoo.ts",
  "api-server/src/routes/bounded-market-scan.ts",
  "api-server/src/routes/crypto-signal-scan.ts",
  "api-server/src/routes/scanner-ai-evidence-review.smoke.test.ts",
  "api-server/src/services/bounded-scanner.service.test.ts",
  "api-server/src/services/bounded-scanner.service.ts",
  "api-server/src/services/crypto-signal-scanner.service.test.ts",
  "api-server/src/services/crypto-signal-scanner.service.ts",
  "api-server/src/services/market-data.service.ts",
  "api-server/src/services/market-intelligence-ai-analysis.service.test.ts",
  "api-server/src/services/market-intelligence-ai-analysis.service.ts",
  "api-server/src/services/scanner-ai-evidence-review.service.test.ts",
  "api-server/src/services/scanner-ai-evidence-review.service.ts",
  "api-server/src/services/scanner-ai-provider.service.test.ts",
  "api-server/src/services/scanner-ai-provider.service.ts",
  "api-server/src/services/scanner-crypto-price-precision.service.test.ts",
  "api-server/src/services/scanner-data-quality.service.test.ts",
  "api-server/src/services/scanner-data-quality.service.ts",
  "api-server/src/services/scanner-indicator-library.service.ts",
  "api-server/src/services/scanner-market-profile-overlay.service.ts",
  "api-server/src/services/scanner-outcome.test.ts",
  "api-server/src/services/scanner-provider-health.service.ts",
  "api-server/src/services/scanner-quant-hardening.service.test.ts",
  "api-server/src/services/scanner-quant-hardening.service.ts",
  "api-server/src/services/scanner-quant-strategy.service.test.ts",
  "api-server/src/services/scanner-quant-strategy.service.ts",
  "api-server/src/services/scanner-signal-lifecycle.service.test.ts",
  "api-server/src/services/scanner-signal-lifecycle.service.ts",
  "api-server/src/services/scanner-signal.types.ts",
  "api-server/src/services/scanner-universe.service.ts",
  "api-server/src/services/stock-signal-scanner-aggregation.test.ts",
  "api-server/src/services/stock-signal-scanner.service.ts",
  "api-server/src/services/unified-asset-search-fallback.test.ts",
  "api-server/src/services/unified-asset-search.service.ts",
  "api-server/test.mjs",
  "market-prediction-lab/runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.manifest.json",
  "market-prediction-lab/runtime/authoritative-paper-runtime-v1/authoritative-paper-runtime-v1.mjs",
  "signal-intelligence-v3/README.md",
  "signal-intelligence-v3/scripts/run-public-scanner-cycle.ts",
  "signal-intelligence-v3/src/public-cycle-progress-v2.mjs",
  "signal-intelligence-v3/src/public-stock-provider-adapter.mjs",
  "signal-intelligence-v3/src/server.mjs",
  "signal-intelligence-v3/tests/public-cycle-progress-v2.test.mjs",
  "signal-intelligence-v3/tests/public-stock-provider-adapter.test.mjs",
  "signal-intelligence-v3/tests/server.test.mjs",
  "stock-analyzer/e2e/expanded-gap-closure.spec.ts",
  "stock-analyzer/e2e/final-expanded-targeted-evidence.spec.ts",
  "stock-analyzer/e2e/phase11-ai-workspace.spec.ts",
  "stock-analyzer/e2e/scanner-direction-badges.spec.ts",
  "stock-analyzer/e2e/scanner-mobile-collision.spec.ts",
  "stock-analyzer/e2e/scanner-mobile-detail-tabs.spec.ts",
  "stock-analyzer/e2e/signal-scanner-mobile-ranking-direction.spec.ts",
  "stock-analyzer/e2e/signal-scanner-quality-panel.spec.ts",
  "stock-analyzer/e2e/signal-scanner.spec.ts",
  "stock-analyzer/src/lib/scanner-request.test.ts",
  "stock-analyzer/src/lib/signal-scanner.ts",
  "stock-analyzer/src/pages/signal-scanner.tsx"
]);
export const SCANNER_REPAIR_CI_PATHS = Object.freeze([
  '.github/scripts/scanner-readonly-repair-scope.mjs',
  '.github/tests/scanner-readonly-repair-scope.test.mjs',
  '.github/scripts/verify-research-workspace-sync-v3.mjs',
  '.github/workflows/paper-forward-schedule-validation.yml',
  '.github/workflows/research-workspace-integration-v1.yml',
]);
export const SCANNER_REPAIR_PATHS = Object.freeze([...SCANNER_REPAIR_PINNED_PATHS, ...SCANNER_REPAIR_CI_PATHS]);
export const SCANNER_PROTECTED_AUTHORITY_PATHS = Object.freeze([
  '.github/workflows/production-automatic-trading-gate.yml',
  'api-server/scripts/verify-production-automatic-trading-gate.mjs',
  '.github/workflows/production-deploy.yml',
  'ops',
  'market-prediction-lab/config',
  'research-production',
  'packages/member-access',
  'api-server/src/middleware',
  'api-server/src/features',
  'api-server/src/routes/index.ts',
  'pnpm-lock.yaml',
]);
const pinned = new Set(SCANNER_REPAIR_PINNED_PATHS);
export function verifyPinnedScannerScope(changed, base, readBlob) {
  const scanner = changed.filter(path => pinned.has(path));
  if (!scanner.length) return [];
  if (!/^[0-9a-f]{40}$/u.test(base ?? '')) throw new Error('SCANNER_SCOPE_BASE_REQUIRED');
  for (const path of scanner) {
    const expected = readBlob(SCANNER_REPAIR_SOURCE_SHA, path);
    const actual = readBlob('HEAD', path);
    if (!/^[0-9a-f]{40}$/u.test(expected ?? '') || actual !== expected) throw new Error('SCANNER_SCOPE_BLOB_DRIFT:' + path);
  }
  for (const path of SCANNER_PROTECTED_AUTHORITY_PATHS) {
    const expected = readBlob(base, path);
    if (!/^[0-9a-f]{40}$/u.test(expected ?? '') || readBlob('HEAD', path) !== expected) throw new Error('SCANNER_AUTHORITY_PATH_CHANGED:' + path);
  }
  return scanner;
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export function createScannerBlobReader(changed, base) {
  if (!/^[0-9a-f]{40}$/u.test(base ?? '')) throw new Error('SCANNER_SCOPE_BASE_REQUIRED');
  const active = changed.filter(path => pinned.has(path));
  const refs = active.length ? [
    ...active.flatMap(path => [SCANNER_REPAIR_SOURCE_SHA + ':' + path, 'HEAD:' + path]),
    ...SCANNER_PROTECTED_AUTHORITY_PATHS.flatMap(path => [base + ':' + path, 'HEAD:' + path]),
  ] : [];
  const blobs = new Map();
  // Bounded batches avoid one process per file and stay below Windows command
  // length limits. rev-parse reads object identities, not provider/private data.
  for (let index = 0; index < refs.length; index += 24) {
    const batch = refs.slice(index, index + 24);
    const identities = git('rev-parse', ...batch).split('\n');
    if (identities.length !== batch.length || identities.some(value => !/^[0-9a-f]{40}$/u.test(value))) {
      throw new Error('SCANNER_SCOPE_BLOB_LOOKUP_INVALID');
    }
    batch.forEach((ref, item) => blobs.set(ref, identities[item]));
  }
  return (ref, path) => {
    const key = ref + ':' + path;
    if (!blobs.has(key)) throw new Error('SCANNER_SCOPE_UNREQUESTED_BLOB');
    return blobs.get(key);
  };
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scanner-readonly-repair-scope.mjs')) {
  if (process.argv[2] === '--list-paths') console.log(SCANNER_REPAIR_PATHS.join('\n'));
  else if (process.argv[2] === '--verify') {
    const base = process.argv[3];
    if (!/^[0-9a-f]{40}$/u.test(base ?? '')) throw new Error('SCANNER_SCOPE_BASE_REQUIRED');
    const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
    const verified = verifyPinnedScannerScope(changed, base, createScannerBlobReader(changed, base));
    if (verified.length) git('merge-base', '--is-ancestor', SCANNER_REPAIR_SOURCE_SHA, 'HEAD');
    console.log(JSON.stringify({ classification: 'PINNED_SCANNER_REPAIR_ONLY', pinnedPathCount: verified.length,
      executionAuthority: 'NONE', tradingApprovalGranted: false, deploymentAllowed: false, scheduleActivationAllowed: false }));
  } else throw new Error('SCANNER_SCOPE_READ_ONLY_COMMAND_REQUIRED');
}
