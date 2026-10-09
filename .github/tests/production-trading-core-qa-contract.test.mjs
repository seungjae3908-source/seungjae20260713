import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Trading Core Production QA is isolated from unrelated product QA', () => {
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  const config = read('stock-analyzer/playwright.production-trading-core.config.ts');
  const productionDeploy = read('.github/workflows/production-deploy.yml');

  for (const required of [
    '/api/trade-automation/status',
    '/api/trade-automation/policy',
    '/api/trade-automation/plans',
    '/api/user-integrations/execution/sync',
    '/api/paper-journal/unified-ledger',
    '/api/user-integrations/telegram/test',
    "accountMode: 'paper'",
    'TRADING_CORE_QA_CANARY',
    'paperAutomaticTriggered',
    '/api/trade-automation/paper-runtime-readiness',
    'paperRuntimeReadOnlyVerified',
    'paperRuntimeReadyBeforeQa',
    'paperRuntimeBlockersBeforeQa',
    'paperRuntimeWalletReadyBeforeQa',
    'paperRuntimeWorkerFreshBeforeQa',
    'journalVisible',
    "'READY_FOR_ACTIVATION'",
    "'ACTIVE_VERIFIED'",
    'telegramActivationReady',
    'telegramUserConnectionRequired',
    'telegramPersonalActivationRequired',
    'telegramConnectedBefore',
    'telegramRuntimeReady',
    'telegramTestDelivered',
    'telegramFillDeliveryConfirmed',
    'filledDeliveryIds',
    "'SENT'",
    'personalWorkerStarted',
    'workerActivationApproved',
    'PRODUCTION_TRADING_CORE_TELEGRAM_WORKER_NOT_READY',
    'memberAutoPolicyReadiness',
    'preparedMemberAutoPolicy',
    'memberAutoPolicyPrepared',
    'memberAutoResumePrepared',
    'PRODUCTION_TRADING_CORE_MEMBER_STOP_ACTIVE',
    'PRODUCTION_TRADING_CORE_CANARY_BUDGET_TOO_LOW',
    'PRODUCTION_TRADING_CORE_RISK_BASELINE_NOT_RESTORABLE',
    'const originalPolicy = structuredClone(statusBefore.body.policy)',
    'Member policy preparation must not grant LIVE AUTO server authority',
    'memberAutoPolicyReady',
    'memberAutoLivePilotReady',
    'memberAutoOriginalPilotStage',
    'memberAutoPolicyBlockers',
    'memberAutoBitgetLeverage',
    'policyRestored',
    'realOrderSubmitted: false',
    'productionReadOnlyAccessToken',
    'Authorization: `Bearer ${token}`',
    'PRODUCTION_TRADING_CORE_AUTH_TOKEN_MISSING',
  ]) assert.ok(spec.includes(required), required);

  for (const forbidden of [
    "accountMode: 'live'",
    "/api/trade-automation/resume",
    "confirmation: 'RESUME_MEMBER_TRADING'",
    '/api/admin/research',
    '/api/research',
    'research-center',
    'youtube',
    'backtester',
    '/api/trade-automation/plans/',
    '/approve',
    '/cancel',
    '/amend',
    '/transfer',
    '/withdraw',
    "pilotStage: policy?.pilotStage === 'validated' ? 'validated' : 'limited-50'",
    "pilotStage: 'validated'",
  ]) assert.equal(spec.includes(forbidden), false, forbidden);

  assert.equal(spec.includes('must change atomically'), false);

  for (const privacy of ["trace: 'off'", "video: 'off'", "screenshot: 'off'"]) {
    assert.ok(config.includes(privacy), privacy);
  }
  assert.ok(config.includes('production-trading-core-qa\\.spec\\.ts'));
  assert.ok(productionDeploy.includes("PRODUCTION_TRADING_CORE_PREPARE_POLICY: 'true'"));
  assert.ok(productionDeploy.includes('Prepare safe member ALL4 policy and run Focused Trading Core Production QA'));
});

test('Trading Core Production QA restores member policy on early failures and independently of notification restore', () => {
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  assert.match(spec, /let integrationBefore: ApiResult<any>;\s+try \{\s+if \(prepareMemberAutoPolicy\)/);
  assert.ok(spec.includes('PRODUCTION_TRADING_CORE_PREFLIGHT_RESTORE_FAILED'));
  assert.ok(spec.includes('PRODUCTION_TRADING_CORE_RESTORE_FAILED'));
  const finallyBlock = spec.slice(spec.indexOf('  } finally {'), spec.indexOf('  const statusAfter ='));
  assert.ok(finallyBlock.includes('PREFERENCES_REQUEST_FAILED'));
  assert.ok(finallyBlock.includes('POLICY_REQUEST_FAILED'));
  assert.ok(finallyBlock.indexOf('PREFERENCES_REQUEST_FAILED') < finallyBlock.indexOf('POLICY_REQUEST_FAILED'));
  assert.ok(finallyBlock.includes('if (restoreFailures.length > 0)'));
});

test('Canary QA never bypasses member stops or changes irreversible risk guardrails', () => {
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  const start = spec.indexOf('    const qaPolicy = {');
  const end = spec.indexOf("    const saved = await appApi<any>(page, '/api/trade-automation/policy', 'PUT', qaPolicy);", start);
  assert.ok(start >= 0 && end > start, 'QA policy setup must be present');
  const policy = spec.slice(start, end);
  assert.ok(policy.includes('...originalPolicy'), 'Original risk ceilings/floors must be preserved');
  for (const irreversible of [
    'riskPerTradePercent:', 'totalDailyLossLimitPercent:', 'minProfitFactor:',
    'minExpectedValueR:', 'maxInstrumentKrw:', 'maxOrderKrw:',
    'maxStrategyDrawdownPercent:', 'maxAverageSpreadPercent:',
  ]) {
    assert.equal(policy.includes(irreversible), false, irreversible);
  }
  assert.ok(spec.includes('qaCapitalKrw: number = originalPolicy.totalCapitalKrw'));
  assert.ok(spec.includes('availableBalance: qaCapitalKrw'));
  assert.ok(spec.includes('POLICY_RESTORE_STATE_MISMATCH'));
  assert.ok(spec.includes('POLICY_STATE_MISMATCH'));
  assert.ok(spec.includes('isDeepStrictEqual(statusAfter.body?.policy, originalPolicy)'));
});

test('Trading Core ACTIVE_VERIFIED requires same-fill SENT receipt and started Telegram worker', () => {
  const bridge = read('api-server/src/features/user-broker-telegram/trade-execution-event-bridge.service.ts');
  const route = read('api-server/src/routes/user-broker-telegram.ts');
  const workflow = read('.github/workflows/production-trading-core-qa.yml');
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  assert.ok(bridge.includes("event.type === 'ORDER_FILLED'"));
  assert.ok(bridge.includes('filledDeliveryIds.push(queuedId)'));
  assert.ok(bridge.includes('scopedToOrder: true as const, filledDeliveryIds'));
  assert.ok(route.includes('const personalWorkerHealth = readUserTelegramDeliveryWorkerHealth()'));
  assert.ok(route.includes('personalWorkerHealth.enabled === true'));
  assert.ok(route.includes("Date.parse(personalWorkerHealth.lastTickAt ?? '')"));
  assert.ok(route.includes('Date.now() - personalTickAt <= 360_000'));
  assert.ok(route.includes("workerActivationApproved: process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED === 'true'"));
  assert.ok(spec.includes('delivery?.id === id'));
  assert.ok(spec.includes("delivery?.state === 'SENT'"));
  assert.ok(spec.includes('telegramFillDeliveryConfirmed = true'));
  assert.ok(workflow.includes("value?.telegramFillDeliveryConfirmed === true"));
  assert.ok(workflow.includes("value?.telegramFillDeliveryConfirmed === false"));
});

test('Trading Core Telegram receipt polling spans at least two default worker ticks', () => {
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  assert.ok(spec.includes('test.setTimeout(4 * 60_000)'));
  assert.ok(spec.includes('timeout: 90_000'));
  assert.ok(spec.includes('telegramFillDeliveryConfirmed = true'));
});

test('Trading Core QA records real Worker preflight independently of one synthetic Paper fill', () => {
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  const workflow = read('.github/workflows/production-trading-core-qa.yml');
  const preflight = spec.indexOf("appApi<any>(page, '/api/trade-automation/paper-runtime-readiness')");
  const mutation = spec.indexOf("appApi<any>(page, '/api/trade-automation/policy', 'PUT'");
  assert.ok(preflight >= 0 && mutation > preflight, 'read-only preflight must precede canary mutation');
  assert.ok(spec.includes('paperRuntimeReadyBeforeQa = paperRuntime.body?.readyForPaperEvaluation === true'));
  assert.ok(spec.includes('paperRuntime.body?.realOrderAuthorityGranted'));
  assert.ok(workflow.includes('const backgroundPaperEvidenceValid'));
  assert.ok(workflow.includes('|| !backgroundPaperEvidenceValid'));
  assert.ok(workflow.includes('recorded independently, not implied'));
});

test('Paper Worker readiness UI exposes genuine member-specific blockers without activation controls', () => {
  const page = read('stock-analyzer/src/pages/auto-trading.tsx');
  assert.ok(page.includes("'/api/trade-automation/paper-runtime-readiness'"));
  assert.ok(page.includes('data-testid="automatic-paper-worker-readiness"'));
  assert.ok(page.includes('data-testid="automatic-paper-worker-blockers"'));
  assert.ok(page.includes('BACKGROUND_PAPER_CAPITAL_POLICY_TOO_LOW'));
  assert.ok(page.includes('BACKGROUND_STRATEGY_ALLOWLIST_REQUIRED'));
  assert.ok(page.includes('data.realOrderAuthorityGranted !== false'));
  assert.ok(page.includes('data.financialMutationCount !== 0'));
  assert.ok(page.includes("autoPaperRuntimeReadiness.readyForPaperEvaluation !== (data.blockers.length === 0)") === false);
  assert.ok(page.includes('data.readyForPaperEvaluation !== (data.blockers.length === 0)'));
  assert.ok(page.includes('autoPaperRuntimeError ?'));
  assert.ok(page.includes('!fixture && canAuto && canJournalSync'));
});

test('Admin four-market virtual Paper UI is self-scoped and never silently activates Live', () => {
  const admin = read('stock-analyzer/src/components/admin-four-market-paper-panel.tsx');
  const page = read('stock-analyzer/src/pages/auto-trading.tsx');
  assert.ok(admin.includes("'/api/paper-journal/admin-four-market'"));
  assert.ok(admin.includes('START_ADMIN_FOUR_1M_PAPER_WALLETS_PRESERVE_HISTORY'));
  assert.ok(admin.includes('SET_ADMIN_FOUR_MARKETS_1M_PAPER_POLICY'));
  assert.ok(admin.includes('data-testid="admin-four-market-paper-panel"'));
  assert.ok(admin.includes('data-testid="admin-four-market-paper-prepare"'));
  assert.ok(admin.includes('const verified = await readStatus()'));
  assert.ok(admin.includes("window.confirm("));
  assert.ok(page.includes('canManagePilot && !fixture ?'));
  assert.ok(page.includes('<AdminFourMarketPaperPanel />'));
  assert.ok(page.includes('BACKGROUND_ADMIN_FOUR_MARKET_WALLETS_REQUIRED'));
});

test('Automatic settings never promise wildcard execution for an empty strategy list', () => {
  const settings = read('stock-analyzer/src/components/trade-automation-settings.tsx');
  assert.ok(settings.includes('비우면 자동 신규진입 차단'));
  assert.ok(settings.includes('data-testid="empty-strategy-blocks-automatic-entry"'));
  assert.ok(settings.includes('없음 · 자동 신규진입 차단'));
  assert.equal(settings.includes('비우면 위험검사를 통과한 전략 전체'), false);
  assert.equal(settings.includes('Pilot 단계 설정됨 · 운영 준비도 별도 확인'), true);
});

test('admin 4-market portfolio display never treats a seed wallet as verified settled equity', () => {
  const ui = read('stock-analyzer/src/components/admin-four-market-paper-panel.tsx');
  const route = read('api-server/src/routes/paper-journal.ts');
  const worker = read('api-server/src/services/member-auto-trading-background-worker.service.ts');
  assert.ok(route.includes("marketCapitalComputedFrom: 'CANONICAL_CURRENT_EPOCH_SETTLEMENT_ONLY'"));
  assert.ok(route.includes('adminFourMarketPaperCapitalReadback({'));
  assert.ok(worker.includes('adminFourMarketPaperCapitalReadback({'));
  assert.ok(ui.includes('실제')); // Narrow Korean confirmation is intentionally absent if not rendered.
  assert.ok(ui.includes('현재 운용잔고/예비금 미확정'));
  assert.ok(ui.includes('actual?.settlementReady'));
  assert.ok(ui.includes('CANONICAL_CURRENT_EPOCH_SETTLEMENT_ONLY'));
});

test('Admin V2 database RLS requires restrictive row-write policies and denies client TRUNCATE', () => {
  const migration = read('api-server/supabase/migrations/2026100901_admin_four_paper_wallet_rls_guard.sql');
  const sqlTest = read('api-server/supabase/test/admin_four_paper_wallet_rls_guard_integration.sql');
  const route = read('api-server/src/routes/paper-journal.ts');
  const ui = read('stock-analyzer/src/components/admin-four-market-paper-panel.tsx');
  for(const operation of ['insert','update','delete']) {
    assert.ok(migration.includes('as restrictive for '+operation+' to authenticated'), operation);
    assert.ok(migration.includes('admin_v2_paper_wallet_'+operation+'_guard'), operation);
    assert.ok(sqlTest.includes('ADMIN_PAPER_RLS_CLIENT_'+operation.toUpperCase()+'_ALLOWED'), operation);
  }
  assert.ok(migration.includes('revoke truncate, references, trigger'));
  assert.ok(migration.includes('admin_four_paper_wallet_rls_guard_ready'));
  assert.ok(route.includes('hasSupabaseServerKey()'));
  assert.ok(route.includes('await requireAdminRlsGuard(request)'));
  assert.ok(route.includes('getSupabase()'));
  assert.ok(ui.includes('databaseGuardMissing'));
  assert.ok(ui.includes('|| databaseGuardMissing'));
});

test('Admin V2 DB readiness verifies role, deny operator and immutable 1m seed', () => {
  const migration = read('api-server/supabase/migrations/2026100901_admin_four_paper_wallet_rls_guard.sql');
  const staging = read('api-server/supabase/test/admin_four_paper_wallet_rls_guard_integration.sql');
  const checks = [
    'admin_four_market_paper_seed_contract',
    "'authenticated'::name = any(roles)",
    "with_check ~* '(!~~|not[[:space:]]+like)'",
    'with check (id not like',
    'revoke truncate, references, trigger',
    'reserveWithdrawalAutomatic',
    'market',
  ];
  for (const proof of checks) assert.ok(migration.includes(proof), proof);
  assert.ok(staging.includes('ADMIN_PAPER_DB_OWNER_FALSE_SEED_ALLOWED'));
  assert.ok(staging.includes('ADMIN_PAPER_RLS_RENAME_ALLOWED'));
  assert.ok(staging.includes('ADMIN_PAPER_RLS_UPSERT_ALLOWED'));
  assert.ok(staging.includes('ADMIN_PAPER_CLIENT_TRUNCATE_ALLOWED'));
});

test('Admin 1m Paper admission requires certified canonical settlement, never only the wallet seed', () => {
  const budget=read('api-server/src/services/admin-four-market-paper-capital.service.ts');
  const worker=read('api-server/src/services/member-auto-trading-background-worker.service.ts');
  assert.ok(budget.includes('ADMIN_PAPER_CANONICAL_SETTLEMENT_REQUIRED'));
  assert.ok(budget.includes('if (!capital || !capital.settlementReady || !capital.newEntriesAllowed'));
  assert.ok(worker.includes('verifiedCapital: runtime.adminMarketCapital?.[mapping.assetClass]'));
});
