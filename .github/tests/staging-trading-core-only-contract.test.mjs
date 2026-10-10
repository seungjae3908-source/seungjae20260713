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
const adminProbe = readFileSync('api-server/scripts/staging-trading-core-admin-profile.mjs', 'utf8');
const SHA = 'a'.repeat(40);
const requireAll = (text, markers) => {
  for (const marker of markers) assert.ok(text.includes(marker), 'missing contract marker: ' + marker);
};
test('Staging browser restores the real isolated admin password session without inventing login metadata', () => {
  requireAll(spec, [
    'restoreStagingAdminSession',
    "new URL('/auth/v1/token?grant_type=password', supabase)",
    "new URL('/api/auth/profile', origin)",
    'STAGING_ADMIN_PROFILE_IDENTITY_MISMATCH',
    'STAGING_ADMIN_PROFILE_NOT_APPROVED',
    'STAGING_ADMIN_SESSION_CONTRACT_INVALID',
    'window.localStorage.setItem(storageKey, JSON.stringify(session))',
    "await page.reload({ waitUntil: 'domcontentloaded' })",
    'STAGING_PASSWORD_SESSION_RESTORE',
    'interactiveLoginFormTested: false',
  ]);
  assert.ok(!spec.includes('STAGING_ADMIN_LOGIN_ID_METADATA_MISSING'));
  assert.ok(!spec.includes('username.fill('));
  assert.ok(!spec.includes('password.fill('));
  assert.ok(!spec.includes('user_metadata?.login_name'));
});

test('Staging auth identity/token are never printed or written into scoped QA receipts', () => {
  assert.ok(!/console\.(?:log|info|warn|error)\(\s*(?:body|loginName|email|password)\b/.test(spec));
  assert.ok(!/writeFileSync\([^,]+,\s*JSON\.stringify\(body\b/.test(spec));
  requireAll(spec, [
    "'STAGING_ADMIN_PROFILE_IDENTITY_MISMATCH'",
    "'STAGING_ADMIN_PROFILE_NOT_APPROVED'",
    "'STAGING_ADMIN_SESSION_CONTRACT_INVALID'",
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
    'Verify direct owner or exact delegated owner-orchestrator provenance',
    'STAGING_CORE_DELEGATED_PROVENANCE_REQUIRED',
    'STAGING_CORE_DELEGATED_PROVENANCE_REJECTED',
    "parent.path === '.github/workflows/production-postdeploy-qa.yml'",
    "parent.event === 'issue_comment'",
    "parent.actor?.login === context.repo.owner",
    "parent.triggering_actor?.login === context.repo.owner",
    "['queued', 'in_progress'].includes(parent.status)",
    'DISPATCH_AUTHORIZED: ${{ steps.dispatch-authority.outputs.authorized }}',
    'STAGING_CORE_ACTION_INVALID',
    "needs.owner-gate.outputs.action == 'deploy'",
    'action: ${{ steps.target.outputs.action }}',
  ];
  requireAll(workflow, markers);
  assert.ok(workflow.includes('([0-9a-f]{40}) (--preflight|--deploy)$/u.exec(process.env.OWNER_BODY'));
  assert.ok(!workflow.includes('actions: write'));
  assert.ok(!workflow.includes('environment: production'));
  assert.ok(workflow.includes('delegated_by_run_id:'));
  assert.ok(!workflow.includes("context.actor === 'github-actions[bot]' && core.setOutput('authorized', 'true')"));
});

test('Owner preflight proves canonical DB admin capability and owner Paper GET before Staging mutation', () => {
  requireAll(workflow, [
    'api-server/scripts/staging-trading-core-admin-profile.mjs',
    '.github/tests/staging-trading-core-admin-profile.test.mjs',
    'Verify Staging admin DB authorization and owner-scoped Paper GET before deployment',
    'run: node api-server/scripts/staging-trading-core-admin-profile.mjs',
    'node --check api-server/scripts/staging-trading-core-admin-profile.mjs',
    'STAGING_BASE_URL: ${{ env.STAGING_BASE_URL }}',
  ]);
  assert.ok(workflow.indexOf('Verify Staging admin DB authorization and owner-scoped Paper GET before deployment')
    < workflow.indexOf('  stage-deploy:'));
  requireAll(spec, [
    "hasCapability(profile, 'canManageMembers')",
    "hasCapability(profile, 'canAccessJournalSync')",
    "profile?.status !== 'approved'",
    'profile?.is_active !== true',
    "'STAGING_ADMIN_PROFILE_NOT_APPROVED'",
  ]);
  requireAll(adminProbe, [
    'classifyStagingTradingAdminProfile',
    "hasCapability(row, 'canManageMembers')",
    "hasCapability(row, 'canAccessJournalSync')",
    "'STAGING_CORE_ADMIN_PROFILE_UNAPPROVED'",
    "'STAGING_CORE_ADMIN_PROFILE_INACTIVE'",
    "'STAGING_CORE_ADMIN_PROFILE_CAPABILITY_MISSING'",
    "'STAGING_CORE_ADMIN_ISOLATED_PROJECT_REQUIRED'",
    "'STAGING_CORE_ADMIN_PAPER_READ_HTTP_'",
    "'/api/auth/profile'",
    "'/api/paper-journal/admin-four-market/status'",
    "'STAGING_CORE_ADMIN_PAPER_READONLY_PASS'",
  ]);
  assert.ok(!adminProbe.includes('.auth.admin.updateUserById'));
  assert.ok(!adminProbe.includes('.auth.admin.createUser'));
  assert.ok(!adminProbe.includes('service_role'));
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
test('Publisher binding never crosses the GitHub masked job-output boundary', () => {
  requireAll(workflow, [
    'Resolve Staging admin publisher binding inside same protected deploy job',
    'runStagingAdminAuthPreflight();',
    'STAGING_BINDING_FILE=',
    'STAGING_CORE_LOCAL_PUBLISHER_BINDING_INVALID',
    'staging-core-publisher-binding',
    'rm -f -- "$RUNNER_TEMP/staging-core-publisher-binding"',
    'STAGING_ADMIN_EMAIL: ${{ secrets.STAGING_ADMIN_EMAIL }}',
    'STAGING_ADMIN_PASSWORD: ${{ secrets.STAGING_ADMIN_PASSWORD }}',
  ]);
  assert.ok(!workflow.includes('needs.owner-gate.outputs.publisher_digest'));
  assert.ok(!workflow.includes('publisher_digest: ${{ steps.publisher.outputs.publisher_sha256 }}'));
  assert.ok(workflow.indexOf('Resolve Staging admin publisher binding inside same protected deploy job')
    < workflow.indexOf('Deploy exact SHA using existing Staging rollback/canary isolation'));
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
    'Destroy Staging SSH deployment authority and publisher binding',
    'test ! -e "$HOME/.ssh/id_ed25519"',
    'STAGING_TRADING_CORE_EXACT_SHA_VERIFIED',
    'v?.deployMarkerSha', 'v?.backgroundWorkersEnabled',
  ]);
  assert.ok(workflow.indexOf('Recheck exact main before any Staging mutation')
    < workflow.indexOf('Deploy exact SHA using existing Staging rollback/canary isolation'));
  assert.ok(workflow.indexOf('Destroy Staging SSH deployment authority')
    < workflow.indexOf('  scoped-qa:'));
  assert.ok(workflow.includes('Upload exact-SHA Automation/Research/Telegram Staging verdict'));
  // A clean GH Actions runner must install node_modules before Playwright.
  assert.ok(workflow.indexOf('pnpm install --frozen-lockfile')
    < workflow.indexOf('pnpm --dir stock-analyzer exec playwright install chromium'));
});
test('only Auto, Paper, Research Center, Backtester and Telegram Journal decide the scoped verdict', () => {
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
    "'/api/admin/research/overview'",
    "'/api/backtests/run'",
    "'/api/user-integrations'",
    "page.goto('/research-center'",
    "page.goto('/backtests'",
    "getByTestId('trading-mode-paper')",
    "getByTestId('user-broker-telegram-panel')",
    "getByTestId('trading-workspace-journal')",
    'liveExecutionServerEnabled',
    'health.deployMarkerSha', 'health.identityMatch', 'health.backgroundWorkersEnabled',
    'orderSubmissionPerformedByStatusRequest',
    'financialMutationCount',
    'privateProviderRequests',
    'automaticTradingReadinessVerified: true',
    'automaticPaperTradingReadinessVerified:',
    'researchCenterReady: true',
    'backtesterReady: true',
    'telegramTradeJournalReady: true',
    'telegramJournalPreferenceEnabled:',
    "backtestMode: backtest.mode",
    'backtestOrderSubmitted: backtest.orderSubmitted',
    'productionReleaseReady: true',
    "scopedReleaseVerdict: 'AUTOMATION_RESEARCH_ONLY'",
  ]);
  assert.ok(!spec.includes('/api/paper-journal/unified-ledger'));
  // The only POST operations are isolated Staging Auth and computation-only
  // Backtester execution. Neither is a financial mutation.
  assert.equal((spec.match(/method: 'POST'/g) ?? []).length, 2);
  assert.ok(spec.includes("new URL('/auth/v1/token?grant_type=password', supabase)"));
  assert.ok(!spec.includes('page.request.post('));
  assert.ok(!spec.includes("requestWithBrowserSession(page, endpoint, { method: 'POST' }"));
  assert.ok(!spec.includes('admin-four-market/bootstrap'));
  assert.ok(!spec.includes('telegram/test'));
  for (const marker of ["trace: 'off'", "video: 'off'", "screenshot: 'off'", 'workers: 1', 'retries: 0']) {
    assert.ok(config.includes(marker));
  }
  assert.ok(workflow.includes('name: staging-automation-research-verdict-'));
  assert.ok(!workflow.includes('name: staging-verdict-'));
  assert.ok(workflow.includes('Scoped Production release_ready: true'));
  assert.ok(workflow.includes('Unrelated UI/features: NOT_RUN'));
});
test('verdict verifies desktop and mobile immutable evidence, rejects missing or fabricated operational proof', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trading-core-staging-scoped-'));
  const base = (project) => ({
    schemaVersion: 'staging-automation-research-core-v1', targetSha: SHA, project,
    stagingScopedQa: 'PASS', browserAuthMode: 'STAGING_PASSWORD_SESSION_RESTORE',
    interactiveLoginFormTested: false, fourMarketsStructural: true,
    providersValidatedWithoutPrivateCalls: true, walletSeedPerMarketKrw: 1000000,
    stagesChecked: Array.from({ length: 13 }, (_, i) => String(i)),
    walletCount: 4, stagingWalletReady: true, paperWorkerReady: true,
    walletBlockers: [], workerBlockers: [],
    automaticTradingReadinessVerified: true,
    automaticPaperTradingReadinessVerified: true,
    researchCenterReady: true, backtesterReady: true,
    telegramTradeJournalReady: true, telegramJournalPreferenceEnabled: true,
    backtestMode: 'backtest-only', backtestOrderSubmitted: false,
    realOrderAuthorityGranted: false, providerPrivateRequests: 0, tradingMutations: 0,
    productionReleaseReady: true, scopedReleaseVerdict: 'AUTOMATION_RESEARCH_ONLY',
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
    const receipt = JSON.parse(readFileSync(path.join(dir, 'automation-research-staging-verdict.json'), 'utf8'));
    assert.equal(receipt.scopedStagingQa, 'PASS');
    assert.equal(receipt.browserAuthMode, 'STAGING_PASSWORD_SESSION_RESTORE');
    assert.equal(receipt.interactiveLoginFormTested, false);
    assert.equal(receipt.productionReleaseReady, true);
    assert.equal(receipt.release_ready, true);
    assert.equal(receipt.automaticTradingActivated, false);
    assert.equal(receipt.operationalReadiness, 'PREREQUISITES_PRESENT');
    assert.equal(receipt.activationReady, true);
    assert.equal(receipt.features.researchCenter, 'PASS');
    assert.equal(receipt.features.telegramTradeJournal, 'PASS');
    write('trading-core-mobile', { paperWorkerReady: false, workerBlockers: ['WORKER_OFF'] });
    result = exec();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'automation-research-staging-verdict.json'), 'utf8')).operationalReadiness, 'PREACTIVATION_BLOCKERS_RECORDED');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'automation-research-staging-verdict.json'), 'utf8')).activationReady, false);
    write('trading-core-mobile', { paperWorkerReady: true, workerBlockers: [], productionReleaseReady: false });
    result = exec();
    assert.notEqual(result.status, 0);
    write('trading-core-mobile', { productionReleaseReady: true, targetSha: 'b'.repeat(40) });
    result = exec();
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
});
