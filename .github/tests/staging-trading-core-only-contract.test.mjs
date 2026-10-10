import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/staging-trading-core-only-qa.yml', 'utf8');
const config = readFileSync('stock-analyzer/playwright.staging-trading-core.config.ts', 'utf8');
const spec = readFileSync('stock-analyzer/e2e/staging-trading-core-readonly.spec.ts', 'utf8');
const full = readFileSync('.github/workflows/staging-readiness.yml', 'utf8');

test('new Staging Trading Core workflow cannot run a Production deploy or relax full Staging', () => {
  assert.ok(workflow.includes('name: Staging Trading Core Only Read-only QA'));
  assert.ok(workflow.includes('environment: staging'));
  assert.ok(workflow.includes("if: github.event_name == 'workflow_dispatch'"));
  assert.ok(workflow.includes("if: github.event_name == 'pull_request'"));
  for (const forbidden of [
    'environment: production', 'secrets.PROD_', 'production-deploy.yml',
    'ops/deploy-staging.sh', 'createWorkflowDispatch', 'contents: write',
    'permissions: write-all', 'secrets: inherit',
  ]) {
    assert.ok(!workflow.includes(forbidden), forbidden);
  }
  assert.ok(workflow.includes('STAGING_CORE_MARKER_SHA_MISMATCH'));
  assert.ok(workflow.includes('STAGING_CORE_LOCAL_API_SHA_MISMATCH'));
  assert.ok(workflow.includes('STAGING_CORE_EXTERNAL_API_SHA_MISMATCH'));
  assert.ok(workflow.includes('git merge-base --is-ancestor'));
  assert.ok(workflow.includes('Full Staging release_ready: NOT_EVALUATED'));
  assert.ok(full.includes('STAGING_RUN_FULL_VALIDATION=true is mandatory'));
  assert.ok(full.includes('e2e/phase10-staging-readiness.spec.ts'));
});

test('browser use remains strictly GET-only for app, Supabase data and provider operations', () => {
  assert.ok(config.includes("STAGING_TRADING_CORE_QA !== 'true'"));
  assert.ok(config.includes('STAGING_CORE_PRODUCTION_ORIGIN_FORBIDDEN'));
  for (const marker of ["trace: 'off'", "screenshot: 'off'", "video: 'off'", 'staging-trading-core-readonly']) {
    assert.ok(config.includes(marker), marker);
  }
  assert.ok(spec.includes("page.route('**/*'"));
  assert.ok(spec.includes("route.abort('blockedbyclient')"));
  assert.ok(spec.includes("url.pathname.startsWith('/api/')"));
  assert.ok(spec.includes("url.pathname.startsWith('/rest/v1/')"));
  assert.ok(spec.includes("url.pathname.startsWith('/functions/v1/')"));
  assert.ok(spec.includes("!url.pathname.startsWith('/auth/v1/token')"));
  for (const route of [
    '/api/trade-automation/status',
    '/api/trade-automation/paper-runtime-readiness',
    '/api/paper-journal/admin-four-market/status',
    '/api/paper-journal/unified-ledger?range=30D&source=APP_PAPER',
    '/api/user-integrations',
  ]) {
    assert.ok(spec.includes("getAdminApi(page, '" + route + "')"), route);
  }
  assert.ok(spec.includes("page.goto('/auto-trading'"));
  assert.ok(spec.includes("page.goto('/paper-trading'"));
  assert.ok(!spec.includes("requestWithBrowserSession(page, '/api/trade-automation/plans'"));
  assert.ok(!spec.includes("requestWithBrowserSession(page, '/api/user-integrations/telegram/test'"));
});

test('two viewports have immutable redacted receipts, never simulated activation proof', () => {
  assert.ok(workflow.includes("for (const viewport of ['desktop', 'mobile'])"));
  for (const marker of [
    'productionDeployApproved: false', 'activationVerified: false',
    'naturalPaperFillJournalTelegramSentVerified: false',
    "fullStagingReleaseReady: 'NOT_EVALUATED'",
    'realOrders: 0', 'paperOrdersCreated: 0', 'telegramSends: 0',
    'unsafeMutations: 0', 'consoleErrors: 0', 'pageErrors: 0',
    'unexpectedHttpErrors: 0', 'secretsRecorded: false',
  ]) {
    assert.ok(spec.includes(marker), marker);
  }
  assert.ok(workflow.includes('STAGING_CORE_DESKTOP_MOBILE_SCOPED_PASS'));
  assert.ok(workflow.includes('if-no-files-found: warn'));
  assert.ok(workflow.includes('Production deployment/activation authority: NONE'));
});
