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
test('Staging admin login maps protected email to the actual app login ID without storing a token', () => {
  requireAll(spec, [
    'resolveStagingAdminLoginName',
    'STAGING_SUPABASE_ANON_KEY',
    'user_metadata?.login_name',
    'STAGING_ADMIN_LOGIN_ID_METADATA_MISSING',
    'STAGING_ADMIN_ID_EMAIL_CONTRACT_MISMATCH',
    'await username.fill(loginName)',
  ]);
  assert.ok(!spec.includes("username.fill(required('STAGING_ADMIN_EMAIL'))"));
  assert.ok(workflow.includes('STAGING_SUPABASE_ANON_KEY: ${{ secrets.STAGING_SUPABASE_ANON_KEY }}'));
});
test('Staging auth identity/token are never printed or written into scoped QA receipts', () => {
  assert.ok(!/console\.(?:log|info|warn|error)\(\s*(?:body|loginName|email|password)\b/.test(spec));
  assert.ok(!/writeFileSync\([^,]+,\s*JSON\.stringify\(body\b/.test(spec));
  requireAll(spec, [
    "'STAGING_ADMIN_LOGIN_ID_METADATA_MISSING'",
    "'STAGING_ADMIN_ID_EMAIL_CONTRACT_MISMATCH'",
    "return loginName;",
  ]);
  assert.ok(!verdict.includes('adminEmail'));
  assert.ok(!verdict.includes('accessToken'));
});
test('Hub command is owner-only and staging-only', () => {
  const markers = [
    '  issue_comment:', 'types: [created]',
    'github.event.issue.number == 1102',
    "github.event.comment.user.login == 'seungjae3908-source'",
    "github.event.comment.author_association == 'OWNER'",
    "startsWith(github.event.comment.body, '/run-trading-core-staging ')",
    'STAGING_CORE_HUB_EXACT_COMMAND_REQUIRED',
    'STAGING_CORE_ACTION_INVALID',
    "needs.owner-gate.outputs.action == 'deploy'",
    'action: ${{ steps.target.outputs.action }}',
  ];
  requireAll(workflow, markers);
  assert.ok(workflow.includes('([0-9a-f]{40}) (--preflight|--deploy)$/u.exec(process.env.OWNER_BODY'));
  assert.ok(!workflow.includes('actions: write'));
  assert.ok(!workflow.includes('environment: production'));
});

test('PR validation never requests Staging secrets, deploy, private provider or production authority', () => {
  requireAll(workflow, [
    '  pull_request:', '  issue_comment:', '  workflow_dispatch:', "group: ${{ (github.event_name == 'workflow_dispatch'",
    'stock-app-staging-readiness', "github.event_name == 'workflow_dispatch' ||",
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
    "needs.owner-gate.outputs.action == 'deploy'",
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
    'v?.deployMarkerSha', 'v?.backgroundWorkersEnabled',
  ]);
  assert.ok(workflow.indexOf('Recheck exact main before any Staging mutation')
    < workflow.indexOf('Deploy exact SHA using existing Staging rollback/canary isolation'));
  assert.ok(workflow.indexOf('Destroy Staging SSH deployment authority')
    < workflow.indexOf('  scoped-qa:'));
  assert.ok(workflow.includes('Upload scoped Staging evidence'));
  // A clean GH Actions runner must install node_modules before Playwright.
  assert.ok(workflow.indexOf('pnpm install --frozen-lockfile')
    < workflow.indexOf('pnpm --dir stock-analyzer exec playwright install chromium'));
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
    'health.deployMarkerSha', 'health.identityMatch', 'health.backgroundWorkersEnabled',
    'orderSubmissionPerformedByStatusRequest',
    'financialMutationCount',
    'privateProviderRequests',
    'productionReleaseReady: false',
    "fullStagingReleaseVerdict: 'NOT_EVALUATED'",
    'canaryPaperFillObserved: false',
    'telegramSentReceiptObserved: false',
  ]);
  assert.ok(!spec.includes('/api/paper-journal/unified-ledger'));
  // Supabase password grant resolves the staging login ID; app/trading API
  // actions remain GET-only and may not use private broker or order mutations.
  assert.equal((spec.match(/method: 'POST'/g) ?? []).length, 1,
    'Only the isolated Staging Supabase Auth password grant may POST');
  assert.ok(spec.includes("new URL('/auth/v1/token?grant_type=password', supabase)"));
  assert.ok(!spec.includes('page.request.post('));
  assert.ok(!spec.includes("requestWithBrowserSession(page, endpoint, { method: 'POST' }"));
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
    assert.equal(receipt.operationalReadiness, 'BLOCKED');
    assert.equal(receipt.canaryPaperFillObserved, false);
    write('trading-core-desktop', { stagingWalletReady: true, paperWorkerReady: true, walletCount: 4, walletBlockers: [], workerBlockers: [] });
    write('trading-core-mobile', { stagingWalletReady: true, paperWorkerReady: true, walletCount: 4, walletBlockers: [], workerBlockers: [] });
    result = exec();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'trading-core-scoped-staging-verdict.json'), 'utf8')).operationalReadiness, 'PREREQUISITES_PRESENT');
    write('trading-core-desktop');
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

test('secret-masked publisher digest is generated only inside the protected deploy job', () => {
  const owner = workflow.slice(workflow.indexOf('  owner-gate:'), workflow.indexOf('  stage-deploy:'));
  const staging = workflow.slice(workflow.indexOf('  stage-deploy:'), workflow.indexOf('  scoped-qa:'));
  requireAll(owner, [
    'Require coherent post-merge release provenance',
    'Verify Staging-only administrator password grant without exporting identity',
    'run: node api-server/scripts/verify-staging-admin-auth-preflight.mjs',
  ]);
  assert.ok(!owner.includes('--write-publisher-digest'), 'no secret-like cross-job output');
  assert.ok(!owner.includes('publisher_digest:'), 'owner outputs contain no digest');
  assert.ok(!workflow.includes('needs.owner-gate.outputs.publisher_digest'));
  requireAll(staging, [
    'Reverify Staging admin publisher within protected deploy job',
    'SUPABASE_URL: ${{ secrets.STAGING_SUPABASE_URL }}',
    'SUPABASE_ANON_KEY: ${{ secrets.STAGING_SUPABASE_ANON_KEY }}',
    'ADMIN_EMAIL: ${{ secrets.STAGING_ADMIN_EMAIL }}',
    'ADMIN_PASSWORD: ${{ secrets.STAGING_ADMIN_PASSWORD }}',
    'runStagingAdminAuthPreflight();',
    'appendFileSync(process.env.GITHUB_ENV,',
    'STAGING_PUBLISHER_DIGEST=${binding.publisherDigest}',
    'STAGING_CORE_LOCAL_PUBLISHER_DIGEST_INVALID',
    'STAGING_CORE_LOCAL_PUBLISHER_DIGEST_MISSING',
    'STAGING_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256=%q',
  ]);
  assert.ok(staging.indexOf('Reverify Staging admin publisher within protected deploy job')
    < staging.indexOf('Recheck exact main before any Staging mutation'));
  assert.ok(staging.indexOf('Recheck exact main before any Staging mutation')
    < staging.indexOf('Configure protected Staging-only SSH'));
  assert.ok(staging.indexOf('STAGING_CORE_LOCAL_PUBLISHER_DIGEST_MISSING')
    < staging.indexOf('Deploy exact SHA using existing Staging rollback/canary isolation'));
  assert.ok(!staging.includes('PUBLISHER_DIGEST: ${{ needs.owner-gate.outputs.publisher_digest }}'));
  assert.ok(!staging.includes('::set-output'));
});
