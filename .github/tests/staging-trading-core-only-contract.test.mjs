import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const workflow = readFileSync('.github/workflows/staging-trading-core-only.yml', 'utf8');
const config = readFileSync('stock-analyzer/playwright.staging-trading-core-only.config.ts', 'utf8');
const spec = readFileSync('stock-analyzer/e2e/staging-trading-core-only.spec.ts', 'utf8');
const verdictPath = '.github/scripts/build-staging-trading-core-only-verdict.mjs';
const verdict = readFileSync(verdictPath, 'utf8');
const SHA = 'a'.repeat(40);
const requireAll = (text, markers) => {
  for (const marker of markers) assert.ok(text.includes(marker), 'missing contract marker: ' + marker);
};
test('PR validation never requests Staging secrets, deploy, private provider or production authority', () => {
  requireAll(workflow, [
    '  pull_request:', '  workflow_dispatch:', "group: ${{ github.event_name == 'workflow_dispatch'",
    'stock-app-staging-readiness', 'if: github.event_name == \'workflow_dispatch\'',
    'environment: staging', 'STAGING_CORE_OWNER_REQUIRED',
    'STAGING_CORE_CURRENT_MAIN_SHA_MISMATCH',
    'inspectPostMergeStatusEvidence', 'evaluatePostMergeStatusProvenance',
    'STAGING_CORE_PRODUCTION_DATABASE_FORBIDDEN',
    'STAGING_CORE_PRODUCTION_ORIGIN_FORBIDDEN',
    'STAGING_CORE_PINNED_SSH_HOST_REQUIRED',
  ]);
  assert.ok(workflow.includes('      - name: Validate scoped Staging contract'));
  assert.ok(!workflow.includes('environment: production'));
  assert.ok(!workflow.includes('secrets.PROD_'));
  assert.ok(!workflow.includes('production-deploy.yml'));
  assert.ok(!workflow.includes("schedule:"));
  assert.ok(!workflow.includes("issues: write"));
  assert.ok(!workflow.includes("contents: write"));
  assert.ok(!workflow.includes("run_full_validation: 'false'"));
});
test('protected Stage deploy is exact-main, isolated, serialized with official full Staging and cleans SSH credentials', () => {
  requireAll(workflow, [
    "if: github.event_name == 'workflow_dispatch' && inputs.action == 'deploy'",
    'stage-deploy:',
    'STAGING_CORE_MAIN_MOVED_BEFORE_DEPLOY',
    '/srv/seungjae-staging',
    'STAGING_PM2_NAME=seungjae-staging',
    'STAGING_PORT=18083',
    'STAGING_CANARY_PORT=18084',
    'ops/deploy-staging.sh',
    'Destroy Staging SSH deployment authority',
    'test ! -e "$HOME/.ssh/id_ed25519"',
    'STAGING_TRADING_CORE_EXACT_SHA_VERIFIED',
  ]);
  assert.ok(workflow.indexOf('Recheck exact main before any Staging mutation')
    < workflow.indexOf('Deploy exact SHA using existing Staging rollback/canary isolation'));
  assert.ok(workflow.indexOf('Destroy Staging SSH deployment authority')
    < workflow.indexOf('  scoped-qa:'));
  assert.ok(workflow.includes('Upload scoped Staging evidence'));
});
test('only Trading Core browser + own Paper DB reads; no provider-private requests, simulated orders, Telegram sends, full release verdict', () => {
  requireAll(spec, [
    "test.skip(!activated", "STAGING_TRADING_CORE_ONLY_QA",
    'STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD',
    'bawcbkoyovbeajkrnduq.supabase.co',
    "'domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'",
    "'toss', 'kiwoom', 'upbit', 'bitget'",
    'route.abort', "'/api/trade-automation/status'",
    "'/api/trade-automation/paper-runtime-readiness'",
    "'/api/paper-journal/admin-four-market/status'",
    "'/api/paper-journal/snapshot'",
    "'/api/user-integrations'",
    'liveExecutionServerEnabled',
    'orderSubmissionPerformedByStatusRequest',
    'financialMutationCount',
    'privateProviderRequests',
    'productionReleaseReady: false',
    "fullStagingReleaseVerdict: 'NOT_EVALUATED'",
    'canaryPaperFillObserved: false',
    'telegramSentReceiptObserved: false',
  ]);
  assert.ok(!spec.includes('/api/paper-journal/unified-ledger'));
  assert.ok(!spec.includes("method: 'POST'"));
  assert.ok(!spec.includes('admin-four-market/bootstrap'));
  assert.ok(!spec.includes('telegram/test'));
  for (const marker of ["trace: 'off'", "video: 'off'", "screenshot: 'off'", 'workers: 1', 'retries: 0']) {
    assert.ok(config.includes(marker));
  }
  assert.ok(workflow.includes('name: trading-core-scoped-staging-'));
  assert.ok(!workflow.includes('name: staging-verdict-'));
  assert.ok(!workflow.includes('release_ready=true'));
});
test('verdict verifies desktop and mobile immutable evidence, rejects missing or fabricated operational proof', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trading-core-staging-scoped-'));
  const base = (project) => ({
    schemaVersion: 'staging-trading-core-only-v1', targetSha: SHA, project,
    stagingScopedQa: 'PASS', fourMarketsStructural: true,
    providersValidatedWithoutPrivateCalls: true, walletSeedPerMarketKrw: 1000000,
    stagesChecked: Array.from({ length: 8 }, (_, i) => String(i)),
    walletCount: 0, stagingWalletReady: false, paperWorkerReady: false,
    walletBlockers: ['WALLET_MISSING'], workerBlockers: ['WORKER_OFF'],
    canaryPaperFillObserved: false, telegramSentReceiptObserved: false,
    realOrderAuthorityGranted: false, providerPrivateRequests: 0, tradingMutations: 0,
    productionReleaseReady: false, fullStagingReleaseVerdict: 'NOT_EVALUATED',
    automaticTradingActivated: false,
  });
  const write = (project, overrides = {}) => writeFileSync(
    path.join(dir, 'scoped-' + project + '.json'),
    JSON.stringify({ ...base(project), ...overrides }),
  );
  const exec = () => spawnSync(process.execPath, [verdictPath, dir, SHA], { encoding: 'utf8', timeout: 5000 });
  try {
    write('trading-core-desktop');
    write('trading-core-mobile');
    let result = exec();
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(path.join(dir, 'trading-core-scoped-staging-verdict.json'), 'utf8'));
    assert.equal(receipt.scopedStagingQa, 'PASS');
    assert.equal(receipt.productionReleaseReady, false);
    assert.equal(receipt.automaticTradingActivated, false);
    assert.equal(receipt.canaryPaperFillObserved, false);
    write('trading-core-mobile', { productionReleaseReady: true });
    result = exec();
    assert.notEqual(result.status, 0);
    write('trading-core-mobile', { productionReleaseReady: false, telegramSentReceiptObserved: true });
    result = exec();
    assert.notEqual(result.status, 0);
    write('trading-core-mobile', { productionReleaseReady: false, telegramSentReceiptObserved: false, targetSha: 'b'.repeat(40) });
    result = exec();
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
});
