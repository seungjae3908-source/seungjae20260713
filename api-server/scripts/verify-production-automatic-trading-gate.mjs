import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const workflow = read('.github/workflows/production-automatic-trading-gate.yml');
const manualReceipts = read('.github/scripts/production-manual-live-receipts.cjs');
const preactivation = read('.github/scripts/production-preactivation-prerequisites.cjs');
const preactivationEvidence = read('.github/scripts/verify-production-preactivation-evidence.cjs');
const postdeployEvidence = read('.github/scripts/production-postdeploy-qa-evidence.cjs');
const manualSpotGate = read('.github/workflows/production-live-trading-gate.yml');
const manualFuturesGate = read('.github/workflows/production-futures-live-trading-gate.yml');
const tradeService = read('api-server/src/services/trade-automation.service.ts');
const tradeIntegrationTest = read('api-server/src/services/trade-automation-integration.test.ts');
const tradeAutomationRoute = read('api-server/src/routes/trade-automation.ts');
const paperJournalRoute = read('api-server/src/routes/paper-journal.ts');
const paperJournalRepo = read('api-server/src/services/paper-journal-supabase.repository.ts');
const paperJournalSmoke = read('api-server/src/routes/paper-journal.smoke.test.ts');
const paperWorker = read('api-server/src/services/member-auto-trading-background-worker.service.ts');
const paperWorkerTest = read('api-server/src/services/member-auto-trading-background-worker.service.test.ts');
const exitPlan = read('api-server/src/services/member-auto-trading-exit-plan.service.ts');
const exitPlanTest = read('api-server/src/services/member-auto-trading-exit-plan.service.test.ts');
const automaticLiveBudgetTest = read('api-server/src/services/automatic-live-budget.service.test.ts');
const handoffContract = read('api-server/src/services/member-auto-trading-ai-review-evidence.service.ts');
const liveEntryArm = read('api-server/src/services/member-auto-trading-live-arm.service.ts');
const telegramWorker = read('api-server/src/features/user-broker-telegram/user-broker-telegram.worker.ts');
const telegramWorkerTest = read('api-server/src/features/user-broker-telegram/user-broker-telegram.service.test.ts');
const liveConnectionVerification = read('api-server/src/services/live-connection-verification.service.ts');
const liveExecution = read('api-server/src/services/trade-execution.service.ts');
const positionIsolation = read('api-server/src/services/automatic-live-position-isolation.service.ts');
const apiIndex = read('api-server/src/index.ts');
const autoTradingPage = read('stock-analyzer/src/pages/auto-trading.tsx');
const holdingsPanel = read('stock-analyzer/src/components/trading-holdings-panel.tsx');
const autoTradingSettings = read('stock-analyzer/src/components/trade-automation-settings.tsx');
const tradeAutomationPolicyGuard = read('api-server/src/services/trade-automation-policy-guard.service.ts');
const tradeAutomationPolicyGuardTest = read('api-server/src/services/trade-automation-policy-guard.service.test.ts');
const tradeAutomationSmoke = read('api-server/src/routes/trade-automation.smoke.test.ts');
const tradeTypes = read('api-server/src/services/trade-automation.types.ts');
const tradeRisk = read('api-server/src/services/trade-automation-risk.service.ts');
const tradeOptimization = read('api-server/src/services/trade-automation-optimization.service.ts');
const formulaAiExceptionTest = read('api-server/src/services/formula-ai-live-exception.service.test.ts');
const formulaAiException = read('api-server/src/services/formula-ai-live-exception.service.ts');
const strategyCatalog = read('api-server/src/services/evidence-backed-auto-strategy-catalog.service.ts');
const pilotCapitalTest = read('api-server/src/services/trade-rule-pack-pilot-capital.service.test.ts');
const pilotCapital = read('api-server/src/services/trade-rule-pack-pilot-capital.service.ts');
const dailyProfitTarget = read('api-server/src/services/daily-profit-target.service.ts');
const dailyProfitTargetTest = read('api-server/src/services/daily-profit-target.service.test.ts');
const capitalAllocation = read('api-server/src/services/auto-trading-capital-allocation.service.ts');
const capitalAllocationTest = read('api-server/src/services/auto-trading-capital-allocation.service.test.ts');
const externalPilotStatistics = read('api-server/src/services/external-strategy-pilot-statistics.service.ts');
const externalPilotStatisticsTest = read('api-server/src/services/external-strategy-pilot-statistics.service.test.ts');
const upbitExternalPilotQa = read('signal-intelligence-v3/scripts/run-upbit-external-pilot-qa.ts');
const fourMarketPaperCapital = read('api-server/src/services/admin-four-market-paper-capital.service.ts');
const memberPaperMigration = read('api-server/supabase/migrations/2026101001_member_four_market_paper_wallet_guard.sql');
const legacyCryptoRoute = read('api-server/src/routes/crypto-auto.ts');
const deploy = read('ops/deploy-production.sh');
const budgetMigration = read('api-server/supabase/migrations/20261012010706_automatic_live_atomic_budget.sql');
const signalIdentity = read('ops/production-auto-live-signal-identity.cjs');

const requireText = (source, token, code) => {
  if (!source.includes(token)) throw new Error(code + ':' + token);
};
const forbid = (source, pattern, code) => {
  if (pattern.test(source)) throw new Error(code + ':' + pattern);
};

// Staged exits are part of the Production order-authority boundary. A restart
// must rebuild target progress from durable fills, a partial child order may
// never exceed the provider position, and same-symbol re-entry is allowed only
// after a confirmed full canonical exit. Keep these checks in the protected
// activation gate rather than relying on an unowned Research test path.
for (const token of [
  'automaticExitDecision',
  'completedTargetIndexes?: readonly number[]',
  "'TRAILING_TAKE_PROFIT'",
  'A fill at a later rung also proves every earlier price rung was crossed.',
  'quantity: input.remainingQuantity',
]) requireText(exitPlan, token, 'AUTO_GATE_STAGED_EXIT_DECISION_CONTRACT_MISSING');
for (const token of [
  'completedTargetIndexes: [...new Set(exits.flatMap((row) => {',
  'const initialDecision = decide(mark.price);',
  "throw new Error('BACKGROUND_EXIT_QUANTITY_EXCEEDS_PROVIDER_POSITION')",
  'confirmedDecision.targetIndex !== initialDecision.targetIndex',
]) requireText(paperWorker, token, 'AUTO_GATE_STAGED_EXIT_WORKER_CONTRACT_MISSING');
for (const token of [
  'multiple targets take a venue-valid partial profit and leave the final target for the remainder',
  'completed target progress ratchets a restart-safe trailing exit for long and short remainders',
  'a persisted later target cumulatively completes earlier rungs after restart',
  'target stage is persisted in exit identity and rejects malformed stage metadata',
  'four-market reducing exits preserve broker, market, and LONG/SHORT direction without an order transport',
]) requireText(exitPlanTest, token, 'AUTO_GATE_STAGED_EXIT_DECISION_REGRESSION_MISSING');
requireText(paperWorkerTest,
  'Paper target progress survives worker restarts, avoids duplicate exits, and trails the remainder',
  'AUTO_GATE_STAGED_EXIT_RESTART_REGRESSION_MISSING');
requireText(automaticLiveBudgetTest,
  'a fresh signal may re-enter the same instrument only after a confirmed full canonical exit',
  'AUTO_GATE_CONFIRMED_EXIT_REENTRY_REGRESSION_MISSING');

// A desired return is display/admission policy, never profit authority. Only
// full-cost settled PnL reaches it; high inputs cannot expand size, leverage or
// loss limits, and stop mode applies to new entries while exit supervision is
// kept on the independent reducing path above.
for (const token of ["'STOP_NEW_ENTRIES'", "'PROFIT_PROTECTION'", "'NOTIFY_ONLY'"]) {
  requireText(tradeTypes, token, 'AUTO_GATE_DAILY_PROFIT_TARGET_ACTION_MISSING');
}
for (const token of [
  "domestic_stock: 'Asia/Seoul'", "us_stock: 'America/New_York'",
  "crypto_futures: 'UTC'", 'compoundProfitShare: 0.5', 'reserveProfitShare: 0.5',
  'targetIsGuarantee: false', 'riskLimitsExpanded: false',
  'DAILY_PROFIT_TARGET_SETTLEMENT_EVIDENCE_REQUIRED',
  'DAILY_PROFIT_TARGET_STRENGTHENED_SIGNAL_REQUIRED',
  'DAILY_PROFIT_TARGET_PROTECTION_RISK_BUDGET_EXCEEDED',
]) requireText(dailyProfitTarget, token, 'AUTO_GATE_DAILY_PROFIT_TARGET_CONTRACT_MISSING');
for (const token of [
  '3% target is decided from settled net profit',
  '100% desired target never expands risk',
  'profit protection requires a strengthened signal',
  'market day keys are isolated across Seoul, New York and UTC',
  'policy normalization preserves decimal 3% and 100% targets independently across four markets',
  'short-lived target evidence is exact-market, exact-day and tamper evident',
]) requireText(dailyProfitTargetTest, token, 'AUTO_GATE_DAILY_PROFIT_TARGET_REGRESSION_MISSING');
for (const token of [
  'evaluateDailyProfitTarget({', 'dailyProfitTargetEvidenceReason({',
  'rememberDailyProfitTargetRuntime(', 'notifyDailyProfitTarget',
  'Observe settlement-backed targets even on a quiet market tick.',
]) requireText(paperWorker, token, 'AUTO_GATE_DAILY_PROFIT_TARGET_WORKER_WIRING_MISSING');
for (const token of [
  'parseDailyProfitTargetEvidenceReason(plan.signalReasons',
  'DAILY_PROFIT_TARGET_SETTLEMENT_EVIDENCE_DRIFT',
]) requireText(pilotCapital, token, 'AUTO_GATE_DAILY_PROFIT_TARGET_SIGNED_BOUNDARY_MISSING');
for (const token of [
  '시장별 일일 희망 수익률·수익 보호', '수익 보호 모드 (추천)',
  '복리 50% / 적립 50%', '기존 포지션의 보호주문·손절·익절·청산은 계속 관리합니다.',
]) requireText(autoTradingSettings, token, 'AUTO_GATE_DAILY_PROFIT_TARGET_UI_MISSING');
requireText(tradeAutomationSmoke,
  'daily profit targets preserve decimal per-market choices without expanding role risk limits',
  'AUTO_GATE_DAILY_PROFIT_TARGET_API_REGRESSION_MISSING');

// User-entered capital is a server-audited cash/margin ceiling, independent
// from the per-order limit. It must never become browser-authored balance
// evidence or allow compounding to silently raise the selected allocation.
for (const token of [
  "USER_MARKET_CAPITAL_POLICY_VERSION = 'user-market-capital-v1'",
  'compoundAboveAllocation: false', 'capitalAllocationByMarket', 'capitalAllocationAuditTrail',
]) requireText(tradeTypes, token, 'AUTO_GATE_USER_CAPITAL_POLICY_MISSING');
for (const token of [
  'buildCapitalAllocationReadiness', 'serverAuthoredCapitalAllocation',
  "'ACCOUNT_READBACK_REQUIRED'", "'CAPITAL_ALLOCATION_AVAILABLE_BALANCE_EXCEEDED'",
  'tradingCapitalChargeKrw', 'accountScopeId',
]) requireText(capitalAllocation, token, 'AUTO_GATE_USER_CAPITAL_READBACK_CONTRACT_MISSING');
for (const token of [
  'OPERATING_CAPITAL_ALLOCATION_LIMIT', 'allocationNotionalLimit',
  'assetClassCapitalCommittedKrw',
]) requireText(tradeRisk, token, 'AUTO_GATE_USER_CAPITAL_RISK_WIRING_MISSING');
for (const token of [
  'member can configure exact 100k, 250k, and 500k allocations',
  'administrator role ceiling allows 1m',
  'two stock lanes sharing one provider cannot allocate the same cash twice',
  'futures risk uses allocation as isolated margin and keeps leveraged notional separate',
  'reducing exit remains eligible',
]) requireText(capitalAllocationTest, token, 'AUTO_GATE_USER_CAPITAL_REGRESSION_MISSING');
for (const token of [
  "router.get('/capital-allocation-readiness'", 'serverAuthoredCapitalAllocation(',
  'roleMaximumFourMarketKrw', 'candidate.capitalAllocationAuditTrail = [',
  'userScopeDigest', 'orderSubmitted: false',
]) requireText(tradeAutomationRoute, token, 'AUTO_GATE_USER_CAPITAL_API_MISSING');
for (const token of [
  '시장별 자동매매 운용금액', '현재 설정 가능 최대', '1회 최대 주문금액',
  '사용자 설정은 절대 투입 상한입니다.', '잔고 확인 필요',
]) requireText(autoTradingSettings, token, 'AUTO_GATE_USER_CAPITAL_UI_MISSING');

// Natural public observations are not interchangeable with fixtures or
// replay. Missing history stays N/A, while worker/trade counts come only from
// the member's durable Plan/Order ledger.
for (const token of [
  "naturalObservationSource: 'LIVE_PUBLIC_PRODUCER_HISTORY'",
  "userAdmissionSource: 'DURABLE_PLAN_ORDER_LEDGER'", 'replayAndFixtureExcluded: true',
  "report.observationKind !== 'LIVE_PUBLIC_MARKET'", 'naturalSignals: available ? sum',
]) requireText(externalPilotStatistics, token, 'AUTO_GATE_EXTERNAL_PILOT_STATISTICS_CONTRACT_MISSING');
for (const token of [
  'only genuine live public observations enter the 30-day signal history',
  'distinguish missing observations from a measured zero',
]) requireText(externalPilotStatisticsTest, token, 'AUTO_GATE_EXTERNAL_PILOT_STATISTICS_REGRESSION_MISSING');
requireText(upbitExternalPilotQa, 'appendPublicQaCycle(previousHistory, report)',
  'AUTO_GATE_EXTERNAL_PILOT_STATISTICS_PRODUCER_WIRING_MISSING');
for (const token of [
  'EXTERNAL_PILOT_STATISTICS_HISTORY_PATH',
  'external-strategy-pilot-statistics-history-v1',
  'public-signal-history-v1.json',
]) requireText(read('.github/workflows/signal-intelligence-v3-validation.yml'), token,
  'AUTO_GATE_EXTERNAL_PILOT_STATISTICS_WORKFLOW_MISSING');
requireText(autoTradingSettings, '테스트·Fixture·과거 재생은 제외',
  'AUTO_GATE_EXTERNAL_PILOT_STATISTICS_UI_MISSING');

// A migration proof must install under hosted non-superuser privileges without
// replacing definition-drift verification with a caller-controlled parameter.
requireText(budgetMigration, 'automatic_live_budget_expected_schema_fingerprint()', 'AUTO_GATE_OWNER_BOUND_BUDGET_PROOF_MISSING');
requireText(budgetMigration, "substring(p.prosrc from '^select ''([0-9a-f]{32})''::text;$')", 'AUTO_GATE_SEALED_BUDGET_LITERAL_CHECK_MISSING');
requireText(budgetMigration, "not pg_has_role('service_role',p.proowner,'MEMBER')", 'AUTO_GATE_RUNTIME_BUDGET_PROOF_OWNERSHIP_FORBIDDEN');
forbid(budgetMigration, /automatic_live_guard\.expected_schema_fingerprint/u, 'AUTO_GATE_CUSTOM_PARAMETER_AUTHORITY_FORBIDDEN');
requireText(workflow, 'node --test .github/tests/production-auto-live-budget-contract.test.mjs', 'AUTO_GATE_BUDGET_PROOF_REGRESSION_WIRING_MISSING');

// Account connectivity uses read-only vault keys; execution reuse has a distinct
// Kiwoom key name. The shared worker/pre-submit/holdings reader must bridge it
// only after decryption, without writing the vault or accepting conflicting keys.
for (const token of [
  'automaticExecutionReadonlyCredentials(provider, decryptTradingCredentials(envelope))',
  "if (provider !== 'kiwoom') return raw",
  "if (appSecret && secretKey && appSecret !== secretKey) throw new Error('CREDENTIALS_UNAVAILABLE')",
  'appSecret: appSecret || secretKey',
  "async save() { throw new Error('READONLY_REQUEST_REJECTED'); }",
  "async remove() { throw new Error('READONLY_REQUEST_REJECTED'); }",
]) requireText(positionIsolation, token, 'AUTO_GATE_EXECUTION_READONLY_CREDENTIAL_CONTRACT_MISSING');
for (const token of [
  'execution read-only credential adaptation preserves other providers and rejects ambiguous Kiwoom keys',
  'Kiwoom execution-vault keys drive only authenticated read-only snapshots for isolation and holdings',
  'encryptTradingCredentials(source)',
  "'/live-position-isolation/kiwoom', '/holdings?accountMode=live&provider=kiwoom'",
  'assert.equal(calls, 0)',
]) requireText(tradeAutomationSmoke, token, 'AUTO_GATE_ENCRYPTED_READONLY_CREDENTIAL_REGRESSION_MISSING');
requireText(workflow, 'execution/read-only encrypted credential contracts', 'AUTO_GATE_ENCRYPTED_CREDENTIAL_CHECK_WIRING_MISSING');

requireText(tradeTypes, 'PRODUCTION_MEMBER_MAX_BITGET_LEVERAGE = 3', 'AUTO_GATE_MEMBER_LEVERAGE_LIMIT_MISSING');
requireText(tradeTypes, 'PRODUCTION_ADMIN_MAX_BITGET_LEVERAGE = 7', 'AUTO_GATE_ADMIN_LEVERAGE_LIMIT_MISSING');
requireText(tradeTypes, 'PRODUCTION_MEMBER_FOUR_MARKET_INITIAL_KRW', 'AUTO_GATE_MEMBER_FOUR_MARKET_LIVE_TOTAL_MISSING');
requireText(tradeTypes, 'PRODUCTION_ADMIN_FOUR_MARKET_INITIAL_KRW', 'AUTO_GATE_ADMIN_FOUR_MARKET_LIVE_TOTAL_MISSING');
requireText(tradeRisk, 'Math.min(leverage, maximumBitgetLeverage)', 'AUTO_GATE_ROLE_LEVERAGE_NORMALIZATION_MISSING');
requireText(tradeAutomationRoute, "error: 'BITGET_LEVERAGE_ROLE_LIMIT'", 'AUTO_GATE_ROLE_LEVERAGE_SAVE_GUARD_MISSING');
requireText(paperWorker, 'member.policy.bitgetLeverage > maximumLeverage', 'AUTO_GATE_WORKER_ROLE_LEVERAGE_GUARD_MISSING');
requireText(autoTradingSettings, '.filter((leverage) => leverage <= maximumBitgetLeverage)', 'AUTO_GATE_ROLE_LEVERAGE_UI_MISSING');

// A previously unverified 4-market Paper wallet can raise HTTP 400 on the
// holdings GET. The UI must refuse the request until the SAME authenticated
// account's wallet epoch and RLS guard are both proven. The strict backend
// rejection stays unchanged; manual Paper and manual LIVE are unaffected.
for (const [input, token, code] of [
  [autoTradingPage, 'const automaticPaperHoldingsReadable = canPaper && canAuto && canJournalSync', 'AUTO_PAPER_HOLDINGS_MEMBER_AUTH_REQUIRED'],
  [autoTradingPage, 'autoPaperRuntimeReadiness?.paperWalletReady === true', 'AUTO_PAPER_HOLDINGS_WALLET_PROOF_REQUIRED'],
  [autoTradingPage, 'autoPaperRuntimeReadiness?.fourMarketDatabaseGuardReady === true', 'AUTO_PAPER_HOLDINGS_DB_PROOF_REQUIRED'],
  [autoTradingPage, "paperOrigin === 'manual' ? canPaper : automaticPaperHoldingsReadable", 'AUTO_PAPER_HOLDINGS_MANUAL_SEPARATION_REQUIRED'],
  [autoTradingPage, "enabled={mode === 'auto' ? canPlaceOrders && !runtimeLoading : paperHoldingsReadAllowed}", 'AUTO_PAPER_HOLDINGS_READ_GATE_REQUIRED'],
  [holdingsPanel, 'const snapshots = enabled ? query.data?.snapshots : undefined;', 'AUTO_PAPER_HOLDINGS_CACHED_SCOPE_GUARD_REQUIRED'],
  [holdingsPanel, 'enabled: enabled && fixture == null', 'AUTO_PAPER_HOLDINGS_QUERY_DISABLED_REQUIRED'],
  [workflow, 'stock-analyzer/src/components/trading-holdings-panel.tsx', 'AUTO_PAPER_HOLDINGS_CI_SCOPE_REQUIRED'],
]) requireText(input, token, code);

// A fresh 1M automatic Paper wallet is a separate virtual ledger. Existing
// automatic Paper fills, manual wallets and incomplete history must never be
// replaced or interpreted as proof of an empty account.
for (const [input, token, code] of [
  [paperWorker, "AUTOMATIC_PAPER_ACCOUNT_ID = 'automatic-paper-account-v2-1m'", 'AUTO_PAPER_WALLET_ID_MISSING'],
  [paperWorker, "'automatic-paper-account-v1'", 'AUTO_PAPER_LEGACY_WALLET_ID_MISSING'],
  [paperWorker, 'AUTOMATIC_PAPER_INITIAL_KRW = 1_000_000 as const', 'AUTO_PAPER_1M_BASELINE_MISSING'],
  [paperWorker, 'selectAutomaticPaperAccountEquity(records)', 'AUTO_PAPER_DEDICATED_EQUITY_MISSING'],
  [paperWorker, 'inspectAdminFourMarketPaperWallets(records, nowMs)', 'ADMIN_FOUR_MARKET_PAPER_WALLET_INTEGRITY_MISSING'],
  [paperWorker, 'adminMarketPaperRiskBudget(marketBudgetInput)', 'ADMIN_FOUR_MARKET_PAPER_MARKET_BUDGET_MISSING'],
  [paperWorker, 'memberMarketPaperRiskBudget(marketBudgetInput)', 'MEMBER_FOUR_MARKET_PAPER_MARKET_BUDGET_MISSING'],
  [paperWorker, 'marketWallets.marketWallets[market].equityKrw', 'ADMIN_MARKET_EQUITY_SEPARATION_MISSING'],
  [paperWorker, "if (accounts.length !== 1 || accounts[0]!.deletedAt != null) return null;", 'AUTO_PAPER_INVALID_WALLET_BLOCK_MISSING'],
  [tradeAutomationRoute, 'automaticPaperWalletBootstrap: automaticPaperWalletBootstrapReadiness(orders, plans)', 'AUTO_PAPER_READONLY_BOOTSTRAP_MISSING'],
  [paperWorker, 'AUTOMATIC_PAPER_HISTORY_RECONCILIATION_REQUIRED', 'AUTO_PAPER_HISTORY_BLOCK_MISSING'],
  [paperWorker, 'AUTOMATIC_PAPER_HISTORY_TRUNCATED', 'AUTO_PAPER_HISTORY_PAGE_BOUND_MISSING'],
  [paperWorker, 'AUTOMATIC_PAPER_FILLED_QUANTITY_EVIDENCE_MISSING', 'AUTO_PAPER_FILL_QUANTITY_RECONCILIATION_GUARD_MISSING'],
  [paperWorker, 'AUTOMATIC_PAPER_FEE_EVIDENCE_MISSING', 'AUTO_PAPER_MISSING_FEE_RECONCILIATION_GUARD_MISSING'],
  [tradeAutomationSmoke, 'automaticPaperWalletBootstrap.safeToInitialize, false', 'AUTO_PAPER_HISTORY_SMOKE_MISSING'],
  [autoTradingPage, 'data-testid="automatic-paper-wallet-readiness"', 'AUTO_PAPER_READY_UI_MISSING'],
  [autoTradingPage, 'body.automaticPaperWalletBootstrap?.safeToInitialize === true', 'AUTO_PAPER_SERVER_EVIDENCE_MISSING'],
  [autoTradingPage, 'result.orderSubmitted !== false || result.exchangeRequestSent !== false', 'AUTO_PAPER_ZERO_BROKER_IO_MISSING'],
]) requireText(input, token, code);

for (const [input, token, code] of [
  [fourMarketPaperCapital, 'MEMBER_MARKET_INITIAL_KRW = 1_000_000', 'MEMBER_PAPER_MARKET_1M_BASELINE_MISSING'],
  [fourMarketPaperCapital, 'compoundShare: 0.5, reserveShare: 0.5', 'FOUR_MARKET_PAPER_COMPOUND_SPLIT_MISSING'],
  [fourMarketPaperCapital, 'reserveWithdrawalAutomatic: false', 'FOUR_MARKET_PAPER_WITHDRAWAL_GUARD_MISSING'],
  [pilotCapital, 'portfolioInitialCapitalKrw', 'LIVE_FOUR_MARKET_PORTFOLIO_PROJECTION_MISSING'],
  [pilotCapital, 'rulePackPilotMarketForPlan(plan)', 'LIVE_MARKET_LOCAL_COMPOUND_READBACK_MISSING'],
  [memberPaperMigration, 'member_four_market_paper_seed_contract', 'MEMBER_PAPER_DATABASE_SEED_GUARD_MISSING'],
  [memberPaperMigration, 'four_market_paper_wallet_rls_guard_ready()', 'MEMBER_PAPER_DATABASE_READINESS_GUARD_MISSING'],
]) requireText(input, token, code);

for (const [input, token, code] of [
  [paperJournalRoute, "walletRecords.length !== 1 || submitted.length !== 1", 'AUTO_PAPER_SERVER_SINGLE_INITIALIZATION_REQUIRED'],
  [paperJournalRoute, 'AUTOMATIC_PAPER_WALLET_HISTORY_RECONCILIATION_REQUIRED', 'AUTO_PAPER_SERVER_HISTORY_BLOCK_MISSING'],
  [paperJournalRoute, 'repository.listSnapshot(userId)', 'AUTO_PAPER_EXISTING_JOURNAL_CHECK_MISSING'],
  [paperJournalRoute, 'automaticPaperWalletBootstrapReadiness(', 'AUTO_PAPER_SERVER_CANONICAL_CHECK_MISSING'],
  [paperJournalSmoke, 'historical FILLED automatic Paper orders cannot be overwritten', 'AUTO_PAPER_BROKER_HISTORY_REGRESSION_MISSING'],
  [paperJournalSmoke, 'manual synced Paper history prevents automatic Paper wallet refilling', 'AUTO_PAPER_MANUAL_HISTORY_REGRESSION_MISSING'],
]) requireText(input, token, code);

requireText(paperWorker, 'automaticPaperLegacyEpochIsolationReadiness(', 'AUTO_GATE_LEGACY_EPOCH_AUDIT_MISSING');
requireText(paperWorker, 'automaticPaperOrderWithinWalletEpoch(', 'AUTO_GATE_ISOLATED_ORDER_SCOPE_MISSING');
requireText(paperWorker, 'BACKGROUND_PAPER_LEGACY_RETRY_AFTER_NEW_EPOCH', 'AUTO_GATE_LEGACY_RETRY_FAIL_CLOSED_MISSING');
requireText(paperWorker, 'automaticLiveStrategyAllowlisted(member.policy, entry.identity.strategyId)', 'AUTO_GATE_LIVE_STRATEGY_ALLOWLIST_REQUIRED');
requireText(paperWorkerTest, 'blank live strategy allowlist is never wildcard authorization', 'AUTO_GATE_EMPTY_STRATEGY_REGRESSION_MISSING');
requireText(paperJournalRoute, "legacyEpochConfirmation ===", 'AUTO_GATE_EXPLICIT_EPOCH_CONFIRMATION_MISSING');
requireText(paperJournalRepo, "AUTOMATIC_PAPER_WALLET_ALREADY_EXISTS", 'AUTO_GATE_WALLET_INSERT_ONCE_REQUIRED');

requireText(tradeService, 'TRADE_FILLED_EXECUTION_EVIDENCE_REQUIRED', 'AUTO_GATE_FILLED_QTY_PRICE_EVIDENCE_REQUIRED');
requireText(tradeIntegrationTest, 'FILLED state transition rejects missing execution evidence', 'AUTO_GATE_FALSE_FILLED_REGRESSION_MISSING');

// Canonical automatic Paper risk must be independent from member-imported
// manual journals. Missing costs and close-time FX block new exposure.
for (const [scope, proof, code] of [
  [paperWorker, 'automaticPaperRiskEvidenceFromCanonicalLedger(', 'AUTO_GATE_PAPER_CANONICAL_RISK_MISSING'],
  [paperWorker, 'tradeAutomationJournalPayloadsFromSnapshot(userId, automatic, scopedPlans)', 'AUTO_GATE_PAPER_CANONICAL_ORDER_LEDGER_MISSING'],
  [paperWorker, 'paperFinancialRiskReady: paperAccountReady && risk.ready', 'AUTO_GATE_PAPER_RISK_READINESS_MISSING'],
  [paperWorker, 'BACKGROUND_PAPER_SETTLEMENT_FULL_COST_REQUIRED', 'AUTO_GATE_PAPER_FULL_COST_FAIL_CLOSED_MISSING'],
  [paperWorker, 'BACKGROUND_PAPER_CLOSE_TIME_FX_REQUIRED', 'AUTO_GATE_PAPER_FX_FAIL_CLOSED_MISSING'],
  [paperWorkerTest, 'automatic Paper risk excludes user-imported manual loss journals', 'AUTO_GATE_PAPER_MANUAL_JOURNAL_ISOLATION_TEST_MISSING'],
]) requireText(scope, proof, code);

requireText(workflow, 'name: Production Automatic Trading Gate', 'AUTO_GATE_NAME_MISSING');
requireText(workflow, '/activate-production-auto-trading ', 'AUTO_GATE_ACTIVATE_COMMAND_MISSING');
requireText(workflow, '/disable-production-auto-trading ', 'AUTO_GATE_DISABLE_COMMAND_MISSING');
requireText(workflow, 'all4', 'AUTO_GATE_ALL4_SCOPE_MISSING');
requireText(workflow, 'environment: production', 'AUTO_GATE_PROTECTED_ENV_MISSING');
requireText(workflow, 'merge-multiple: true', 'AUTO_GATE_PREACTIVATION_ARTIFACTS_NOT_MERGED');

for (const provider of ['toss', 'kiwoom', 'upbit', 'bitget']) {
  requireText(workflow, provider, 'AUTO_GATE_PROVIDER_MISSING');
}
for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']) {
  requireText(workflow, market, 'AUTO_GATE_MARKET_MISSING');
}

requireText(workflow, 'await inspectManualLiveReceipts({', 'AUTO_GATE_MANUAL_RECEIPT_VERIFIER_WIRING_MISSING');
requireText(manualReceipts, "field(body, 'providers') !== 'kiwoom,toss,upbit'", 'AUTO_GATE_SPOT_RECEIPT_SET_MISSING');
requireText(manualReceipts, '[PRODUCTION_FUTURES_LIVE_TRADING_GATE]', 'AUTO_GATE_FUTURES_RECEIPT_MISSING');
requireText(manualReceipts, 'ACTIVATED_FUTURES_LIVE_LIMITED_MANUAL', 'AUTO_GATE_FUTURES_MANUAL_RECEIPT_MISSING');
requireText(manualReceipts, 'AUTOMATIC_TRADING_EXACT_${kind.toUpperCase()}_MANUAL_RECEIPT_REQUIRED', 'AUTO_GATE_BOTH_MANUAL_RECEIPTS_REQUIRED');
for (const proof of ["comment?.user?.login !== 'github-actions[bot]'", 'at < deploymentAt',
  "field(body, 'target_sha') !== targetSha", '/^[2-7]$/u', 'run.head_sha === targetSha',
  "run.status === 'completed' && run.conclusion === 'success'", 'run.path === expectedPath']) {
  requireText(manualReceipts, proof, 'AUTO_GATE_MANUAL_RECEIPT_PROVENANCE_MISSING');
}
requireText(workflow, 'const ciRunId = release.requiredCiRunId;', 'AUTO_GATE_REQUIRED_CI_HELPER_WIRING_MISSING');
requireText(workflow, 'Date.parse(release.productionDeployCompletedAt)', 'AUTO_GATE_DEPLOYMENT_BOUNDARY_HELPER_WIRING_MISSING');
requireText(preactivation, 'PREACTIVATION_REQUIRED_CI_NOT_6_OF_6', 'AUTO_GATE_REQUIRED_CI_6_OF_6_HELPER_MISSING');
requireText(preactivation, 'PREACTIVATION_REQUIRED_CI_NOT_COHERENT', 'AUTO_GATE_REQUIRED_CI_COHERENCE_HELPER_MISSING');
requireText(preactivation, "requiredCiRun.path !== '.github/workflows/futures-public-network-smoke.yml'", 'AUTO_GATE_REQUIRED_CI_WORKFLOW_IDENTITY_MISSING');
requireText(preactivation, "workflow_id: 'production-deploy.yml'", 'AUTO_GATE_DEPLOY_PROVENANCE_MISSING');
requireText(preactivation, "event: 'workflow_dispatch'", 'AUTO_GATE_DEPLOY_EVENT_FILTER_MISSING');
requireText(preactivation, "run.event === 'workflow_dispatch'", 'AUTO_GATE_DEPLOY_EVENT_RECHECK_MISSING');
requireText(preactivation, 'production-live-credential-reuse-', 'AUTO_GATE_CREDENTIAL_REUSE_ARTIFACT_MISSING');
requireText(preactivation, 'production-account-readonly-live-', 'AUTO_GATE_ACCOUNT_ARTIFACT_MISSING');
requireText(workflow, 'node .github/scripts/verify-production-preactivation-evidence.cjs', 'AUTO_GATE_PREACTIVATION_EVIDENCE_VERIFIER_MISSING');
requireText(preactivationEvidence, 'assertAccountReceipt(account, context);', 'AUTO_GATE_ACCOUNT_RECEIPT_VERIFICATION_MISSING');
requireText(preactivationEvidence, 'assertCredentialReceipt(credential, context);', 'AUTO_GATE_CREDENTIAL_RECEIPT_VERIFICATION_MISSING');
requireText(preactivationEvidence, "activation?.credentialReuse !== '4/4 PASS'", 'AUTO_GATE_CREDENTIAL_4_OF_4_PROOF_MISSING');
requireText(preactivationEvidence, 'PREACTIVATION_PROVIDER_NOT_READY:', 'AUTO_GATE_PROVIDER_READINESS_PROOF_MISSING');
requireText(postdeployEvidence, 'reconciliationPassed', 'AUTO_GATE_RECONCILIATION_MISSING');
requireText(postdeployEvidence, "production-account-readonly-live-qa-v3", 'AUTO_GATE_ACCOUNT_QA_SCHEMA_V3_MISSING');
requireText(postdeployEvidence, 'assertAccountReceipt(account, { targetSha: sha, productionDeployRunId: deployRunId });', 'AUTO_GATE_POSTDEPLOY_ACCOUNT_RECEIPT_REQUIRED');
forbid(workflow, /AUTOMATIC_TRADING_EXACT_(?:PAPER_FORWARD|TELEGRAM)_/u,
  'AUTO_GATE_OPTIONAL_FEATURE_COUPLING_FORBIDDEN');
requireText(workflow, "auto-trading-live-entry-arm.json", 'AUTO_GATE_LIVE_ENTRY_ARM_PATH_MISSING');
requireText(workflow, 'disarmLiveEntries();', 'AUTO_GATE_PRE_WARMUP_DISARM_MISSING');
requireText(workflow, 'await requireFreshPublishedHandoff(before);', 'AUTO_GATE_PREARM_HANDOFF_GUARD_UNWIRED');
requireText(workflow, 'const automaticLiveHandoffPath =', 'AUTO_GATE_ISOLATED_SOURCE_CONSTANT_MISSING');
requireText(workflow, '/opt/stock-app-data/auto-live-signal-v1/runtime-state/handoff/member-auto-trading-latest.json',
  'AUTO_GATE_ISOLATED_SOURCE_PATH_MISSING');
requireText(workflow, 'const handoffPath = automaticLiveHandoffPath;', 'AUTO_GATE_PREARM_ISOLATED_PATH_NOT_USED');
requireText(workflow, 'published.default?.readProductionAutoLiveSignalHandoff', 'AUTO_GATE_NOFOLLOW_READER_MISSING');
requireText(workflow, 'h = readTrustedHandoff(handoffPath);', 'AUTO_GATE_HANDOFF_READER_NOT_CALLED');
requireText(workflow, 'MEMBER_AUTO_TRADING_HANDOFF_PATH: enabled ? automaticLiveHandoffPath',
  'AUTO_GATE_PM2_ISOLATED_BINDING_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_INDEPENDENT_HANDOFF_BINDING_INVALID',
  'AUTO_GATE_ACTIVE_PM2_SOURCE_RECHECK_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_HANDOFF_PATH: String(before.MEMBER_AUTO_TRADING_HANDOFF_PATH ?? '')",
  'AUTO_GATE_DISABLE_SOURCE_PRESERVATION_MISSING');
forbid(workflow, /\/opt\/stock-app-data\/paper-forward-v1\/runtime-state\/handoff\/member-auto-trading-latest\.json/u,
  'AUTO_GATE_PAPER_SIGNAL_FALLBACK_FORBIDDEN');
requireText(workflow, 'ops/production-auto-live-signal-identity.cjs', 'AUTO_GATE_PREARM_CANONICAL_SOURCE_NOT_IMPORTED');
requireText(workflow, 'verifyProductionAutoLivePrearmHandoff', 'AUTO_GATE_PREARM_CANONICAL_CHECK_NOT_CALLED');
requireText(workflow, 'AUTOMATIC_TRADING_PREARM_VALIDATOR_UNAVAILABLE', 'AUTO_GATE_PREARM_MODULE_MISSING_BLOCK');
requireText(workflow, "signal.producerInvocationVerified !== false", 'AUTO_GATE_PREARM_NO_FAKE_ISSUER_MISSING');
requireText(workflow, 'node --test .github/scripts/production-auto-live-signal-identity.test.cjs', 'AUTO_GATE_PREARM_TEST_WIRING_MISSING');
requireText(signalIdentity, 'validateMemberAutoTradingPaperHandoff(value, nowMs)', 'AUTO_GATE_PREARM_CANONICAL_DIGEST_VALIDATION_MISSING');
requireText(signalIdentity, 'sourceTransportOnly', 'AUTO_GATE_PREARM_TRANSPORT_ONLY_PROOF_MISSING');
requireText(signalIdentity, 'AUTOMATIC_TRADING_PREARM_HANDOFF_CONTRACT_INVALID', 'AUTO_GATE_PREARM_DIGEST_FAILURE_NOT_BLOCKED');
requireText(workflow, 'AUTOMATIC_TRADING_PREARM_HANDOFF_MISSING_OR_INVALID', 'AUTO_GATE_PREARM_HANDOFF_MISSING_BLOCK');
requireText(signalIdentity, 'AUTOMATIC_TRADING_PREARM_HANDOFF_BLOCKED_OR_STALE', 'AUTO_GATE_PREARM_HANDOFF_FRESHNESS_BLOCK');
requireText(signalIdentity, 'AUTOMATIC_TRADING_PREARM_HANDOFF_SHA_MISMATCH', 'AUTO_GATE_PREARM_HANDOFF_SHA_BLOCK');
const preArmCall = workflow.indexOf('requireFreshPublishedHandoff(before);');
const pm2Enable = workflow.indexOf('restartAutomatic(true, before);', preArmCall);
if (preArmCall < 0 || pm2Enable < 0 || preArmCall >= pm2Enable) {
  throw new Error('AUTO_GATE_PREARM_GUARD_MUST_PRECEDE_ANY_MUTATION');
}
requireText(workflow, 'requireWorkerWarmup(after, { requireCurrentArm: false });', 'AUTO_GATE_WORKER_WARMUP_PROOF_MISSING');
requireText(workflow, 'armLiveEntries();', 'AUTO_GATE_POST_WARMUP_ARM_MISSING');
requireText(workflow, 'LIVE_ENTRY_ARM_READBACK_PROVEN: true', 'AUTO_GATE_LIVE_ENTRY_ARM_READBACK_PROOF_MISSING');
requireText(workflow, 'liveEntryArmActivationDelayMs = 120_000', 'AUTO_GATE_ARM_DELAY_MISSING');
requireText(workflow, 'activateNotBeforeAt', 'AUTO_GATE_ARM_NOT_BEFORE_MISSING');
requireText(workflow, 'LIVE_ENTRY_ARM_ACTIVATION_DELAY_MS: liveEntryArmActivationDelayMs', 'AUTO_GATE_ARM_DELAY_RECEIPT_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_LIVE_ENTRY_ARM_WORKER_READABILITY_INVALID', 'AUTO_GATE_ARM_WORKER_READABILITY_CHECK_MISSING');
requireText(workflow, "statSync('/proc/' + Number(matches[0].pid)).uid", 'AUTO_GATE_ARM_WORKER_UID_CHECK_MISSING');
requireText(workflow, "(stat.mode & 0o077) !== 0", 'AUTO_GATE_ARM_FILE_PERMISSION_CHECK_MISSING');
requireText(workflow, 'stat.uid !== productionWorkerUid()', 'AUTO_GATE_ARM_OWNER_CHECK_MISSING');
requireText(workflow, 'verifyLiveEntryArmReadable();', 'AUTO_GATE_ARM_READABILITY_CALL_MISSING');
requireText(workflow, 'NEXT_TICK_ARM_TRANSITION_PROVEN_BY_ZERO_MUTATION_REHEARSAL: true', 'AUTO_GATE_NEXT_TICK_ZERO_MUTATION_PROOF_MISSING');
requireText(workflow, 'health?.liveReadinessCycleComplete === true', 'AUTO_GATE_LIVE_READINESS_CYCLE_COMPLETE_MISSING');
requireText(workflow, 'health?.liveCycleOrderEligible === true', 'AUTO_GATE_LIVE_CYCLE_ORDER_ELIGIBLE_MISSING');
requireText(workflow, 'health?.liveCyclePolicyReady === true', 'AUTO_GATE_LIVE_CYCLE_POLICY_READY_MISSING');
requireText(workflow, 'health?.liveCycleAllFourPolicyReady === true', 'AUTO_GATE_LIVE_CYCLE_ALL4_POLICY_READY_MISSING');
requireText(workflow, 'attempt < 360', 'AUTO_GATE_ROTATING_MEMBER_POLL_WINDOW_MISSING');
requireText(workflow, 'health?.globalEmergencyStopActive === false', 'AUTO_GATE_GLOBAL_STOP_PROOF_MISSING');
requireText(workflow, "const autoLastTickMs = Date.parse(String(health?.lastTickAt || ''))", 'AUTO_GATE_AUTO_HEALTH_TIMESTAMP_MISSING');
requireText(workflow, 'nowMs - autoLastTickMs <= 360_000', 'AUTO_GATE_AUTO_HEALTH_FRESHNESS_MISSING');
requireText(workflow, 'FIRST_WARMUP_TICK_LIVE_ENTRIES_ARMED: false', 'AUTO_GATE_FIRST_TICK_ENTRY_BLOCK_PROOF_MISSING');
requireText(workflow, 'FIRST_WARMUP_TICK_LIVE_ORDERS: 0', 'AUTO_GATE_FIRST_TICK_ZERO_LIVE_ORDER_PROOF_MISSING');
requireText(workflow, 'FIRST_WARMUP_TICK_LIVE_EXIT_ORDERS: 0', 'AUTO_GATE_FIRST_TICK_ZERO_LIVE_EXIT_PROOF_MISSING');
requireText(workflow, 'LIVE_ENTRY_ARM_WRITTEN: true', 'AUTO_GATE_LIVE_ENTRY_ARM_RECEIPT_MISSING');
requireText(workflow, 'QA_SCOPE: ${{ steps.gate.outputs.qa_scope }}', 'AUTO_GATE_QA_SCOPE_RECEIPT_ENV_MISSING');
requireText(workflow, "'worker_warmup_proven=true'", 'AUTO_GATE_WARMUP_HUB_RECEIPT_MISSING');
requireText(workflow, "'first_warmup_tick_live_entries_armed=false'", 'AUTO_GATE_FIRST_TICK_ARM_HUB_RECEIPT_MISSING');
requireText(workflow, "'first_warmup_tick_live_orders=0'", 'AUTO_GATE_FIRST_TICK_ORDER_HUB_RECEIPT_MISSING');
requireText(workflow, "'first_warmup_tick_live_exit_orders=0'", 'AUTO_GATE_FIRST_TICK_EXIT_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_entry_arm_written=true'", 'AUTO_GATE_ARM_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_entry_arm_readback_proven=true'", 'AUTO_GATE_ARM_READBACK_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_entry_arm_activation_delay_ms=120000'", 'AUTO_GATE_ARM_DELAY_HUB_RECEIPT_MISSING');
requireText(workflow, "'next_tick_arm_transition_proven_by_zero_mutation_rehearsal=true'", 'AUTO_GATE_NEXT_TICK_REHEARSAL_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_readiness_cycle_complete=true'", 'AUTO_GATE_CYCLE_COMPLETE_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_cycle_order_eligible=true'", 'AUTO_GATE_CYCLE_ORDER_ELIGIBLE_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_cycle_policy_ready=true'", 'AUTO_GATE_CYCLE_POLICY_READY_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_cycle_all_four_policy_ready=true'", 'AUTO_GATE_CYCLE_ALL4_READY_HUB_RECEIPT_MISSING');
requireText(workflow, "'global_emergency_stop=false'", 'AUTO_GATE_GLOBAL_STOP_HUB_RECEIPT_MISSING');
requireText(workflow, "'optional_telegram_state_preserved=true'", 'AUTO_GATE_OPTIONAL_TELEGRAM_PRESERVATION_RECEIPT_MISSING');
requireText(workflow, "rmSync(liveEntryArmPath, { force: true });", 'AUTO_GATE_DISABLE_DISARM_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_DISABLE_OPEN_LIVE_POSITIONS', 'AUTO_GATE_DISABLE_OPEN_POSITION_BLOCK_MISSING');
requireText(workflow, 'autoHealth?.liveTrackedPositions', 'AUTO_GATE_DISABLE_POSITION_HEALTH_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_DISABLE_HEALTH_STALE_OR_INVALID', 'AUTO_GATE_DISABLE_HEALTH_FRESHNESS_MISSING');

requireText(workflow, "AUTO_TRADING: enabled ? 'true' : 'false'", 'AUTO_GATE_AUTO_TRUE_MISSING');
requireText(workflow, "LIVE_AUTOMATIC_TRADING_ENABLED: enabled ? 'true' : 'false'", 'AUTO_GATE_LIVE_AUTO_TRUE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_BACKGROUND_ENABLED: enabled ? 'true' : 'false'", 'AUTO_GATE_PAPER_WORKER_TRUE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: enabled ? 'true' : 'false'", 'AUTO_GATE_LIVE_WORKER_TRUE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED: 'false'", 'AUTO_GATE_PAPER_ONLY_OVERRIDE_MUST_BE_OFF');
requireText(workflow, "AUTO_TRADING: 'false'", 'AUTO_GATE_AUTO_DISABLE_MISSING');
requireText(workflow, "LIVE_AUTOMATIC_TRADING_ENABLED: 'false'", 'AUTO_GATE_LIVE_AUTO_DISABLE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_BACKGROUND_ENABLED: 'false'", 'AUTO_GATE_PAPER_WORKER_DISABLE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: 'false'", 'AUTO_GATE_LIVE_WORKER_DISABLE_MISSING');
requireText(workflow, "CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED: 'false'", 'AUTO_GATE_LEGACY_CRYPTO_ROUTE_NOT_DISABLED');
requireText(workflow, 'AUTOMATIC_TRADING_ACTIVATION_FAILED_ROLLED_BACK', 'AUTO_GATE_ROLLBACK_RECEIPT_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_DISABLED_ALL4_MANUAL_LIVE_PRESERVED', 'AUTO_GATE_DISABLE_RECEIPT_MISSING');
requireText(workflow, 'REAL_ORDER_SUBMITTED=false', 'AUTO_GATE_NO_ORDER_RECEIPT_MISSING');
requireText(workflow, 'REAL_ORDER_SUBMITTED_BY_GATE: false', 'AUTO_GATE_IDEMPOTENT_GATE_ORDER_RECEIPT_MISSING');
const idempotentActivation = workflow.match(/status: 'ALREADY_ACTIVATED_ALL4'[\s\S]*?process\.exit\(0\);/u)?.[0] ?? '';
requireText(idempotentActivation, 'REAL_ORDER_SUBMITTED_BY_GATE: false', 'AUTO_GATE_IDEMPOTENT_GATE_ORDER_RECEIPT_DRIFT');
forbid(idempotentActivation, /REAL_ORDER_SUBMITTED:\s*false/u, 'AUTO_GATE_IDEMPOTENT_GLOBAL_ORDER_CLAIM_FORBIDDEN');
requireText(workflow, 'const preservedManualRuntimeEnv = (env) => ({', 'AUTO_GATE_RESTART_PRESERVED_MANUAL_ENV_MISSING');
requireText(workflow, '...preservedManualRuntimeEnv(baselineEnv)', 'AUTO_GATE_RESTART_PRESERVED_MANUAL_ENV_NOT_APPLIED');
requireText(workflow, 'restartAutomatic(true, before);', 'AUTO_GATE_ENABLE_RESTART_BASELINE_MISSING');
requireText(workflow, 'restartAutomatic(false, before);', 'AUTO_GATE_ROLLBACK_RESTART_BASELINE_MISSING');
requireText(workflow, 'const preservedDisableRuntimeEnv = (env) => ({', 'AUTO_GATE_DISABLE_PRESERVED_MANUAL_ENV_MISSING');
requireText(workflow, '...preservedDisableRuntimeEnv(before)', 'AUTO_GATE_DISABLE_PRESERVED_MANUAL_ENV_NOT_APPLIED');

requireText(workflow, "manual.spotAuthority !== 'SPOT_LIVE_LIMITED'", 'AUTO_GATE_SPOT_AUTHORITY_RECHECK_MISSING');
requireText(workflow, "manual.futuresAuthority !== 'FUTURES_LIVE_LIMITED'", 'AUTO_GATE_FUTURES_AUTHORITY_RECHECK_MISSING');
requireText(workflow, "manual.futuresMarginMode !== 'isolated'", 'AUTO_GATE_ISOLATED_RECHECK_MISSING');
requireText(workflow, "['2', '3', '4', '5', '6', '7'].includes(expectedLeverage)", 'AUTO_GATE_LEVERAGE_BOUND_MISSING');

forbid(paperWorker, /signalReasons\.filter\(\(reason\) => reason !== 'CANONICAL_PAPER_HANDOFF'\)/u, 'AUTO_GATE_PAPER_LINEAGE_REMOVAL_FORBIDDEN');

const installJobStart = workflow.indexOf('  install-public-signal:');
if (installJobStart < 0) throw new Error('AUTO_PUBLIC_COLLECTOR_SEPARATE_OWNER_INSTALL_JOB_MISSING');
const sourceOnlyJob = workflow.slice(installJobStart);
for (const part of [
  "startsWith(github.event.comment.body, '/install-auto-live-public-signal ')",
  "environment: production",
  "ref: main",
  "AUTO_LIVE_PUBLIC_INSTALL_REQUIRES_EXACT_CURRENT_MAIN",
  "AUTO_LIVE_PUBLIC_INSTALL_EXACT_MAIN_FULL_CI_REQUIRED",
  "run.event === 'workflow_dispatch'",
  "AUTO_LIVE_PUBLIC_INSTALL_ACTIVE_OPERATION_CONFLICT",
  "AUTO_LIVE_PUBLIC_INSTALL_DEPLOYED_SHA_MISMATCH",
  "AUTO_LIVE_PUBLIC_INSTALL_SOURCE_CONTENT_SHA_MISMATCH",
  "AUTO_LIVE_PUBLIC_INSTALL_CRON_READBACK_UNAVAILABLE",
  "AUTO_LIVE_PUBLIC_INSTALL_SCHEDULE_READBACK_INVALID",
  "status:'CONFIGURATION_VERIFIED_ONLY'",
  "inspectManagedPaperForwardSchedule(",
  "AUTO_LIVE_INDEPENDENT_SOURCE_PREFLIGHT=true",
  "AUTO_LIVE_INDEPENDENT_SOURCE_INSTALL=true",
  "AUTO_LIVE_INDEPENDENT_SIGNAL_INSTALL_APPROVED=true",
  "ops/production-auto-live-signal-identity.cjs",
  "AUTO_LIVE_PUBLIC_INSTALL_SANITIZED_RECEIPT_INVALID",
  "private_provider_calls: 0",
  "live_auto_authority_granted: false",
  "24_hour_uninterrupted_collection_verified: false",
]) requireText(sourceOnlyJob, part, 'AUTO_PUBLIC_COLLECTOR_SOURCE_ONLY_CONTRACT_DRIFT');
requireText(workflow, "|| startsWith(github.event.comment.body, '/install-auto-live-public-signal ')",
  'AUTO_PUBLIC_COLLECTOR_CONCURRENCY_MISSING');
forbid(sourceOnlyJob, /\bpm2\s+(?:start|restart|delete|save|set)\b/ui,
  'AUTO_PUBLIC_COLLECTOR_MUST_NOT_MUTATE_PM2');
forbid(sourceOnlyJob, /ops\/(?:disable|install)-paper-forward-schedule\.sh/u,
  'AUTO_PUBLIC_COLLECTOR_MUST_NOT_TOUCH_PAPER_SCHEDULE');
forbid(sourceOnlyJob, /(?:psql|supabase)\s+(?:db|migration|run|sql|execute)/ui,
  'AUTO_PUBLIC_COLLECTOR_MUST_NOT_MUTATE_DB');
forbid(sourceOnlyJob, /AUTO_TRADING[ \t]*[:=][ \t]*['"]?true|LIVE_TRADING[ \t]*[:=][ \t]*['"]?true/u,
  'AUTO_PUBLIC_COLLECTOR_MUST_NOT_ARM_LIVE');

forbid(workflow, /^\s{2}(workflow_dispatch|schedule):/m, 'AUTO_GATE_UNATTENDED_TRIGGER_FORBIDDEN');
forbid(workflow, /if\s*\(false\)/u, 'AUTO_GATE_DEAD_VALIDATION_BLOCK_FORBIDDEN');
forbid(workflow, /if:\s*\$\{\{\s*false\s*\}\}/u, 'AUTO_GATE_YAML_DEAD_VALIDATION_BLOCK_FORBIDDEN');
forbid(workflow, /WITHDRAW[^\n]*true/i, 'AUTO_GATE_WITHDRAW_ENABLE_FORBIDDEN');
forbid(workflow, /TRANSFER[^\n]*true/i, 'AUTO_GATE_TRANSFER_ENABLE_FORBIDDEN');

requireText(manualSpotGate, "AUTO_TRADING: 'false'", 'MANUAL_SPOT_GATE_MUST_KEEP_AUTO_FALSE');
requireText(manualSpotGate, "LIVE_AUTOMATIC_TRADING_ENABLED: 'false'", 'MANUAL_SPOT_GATE_MUST_KEEP_LIVE_AUTO_FALSE');
requireText(manualSpotGate, "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: 'false'", 'MANUAL_SPOT_GATE_MUST_KEEP_LIVE_WORKER_FALSE');
requireText(manualSpotGate, "CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED: 'false'", 'MANUAL_SPOT_LEGACY_CRYPTO_ROUTE_NOT_DISABLED');
requireText(manualSpotGate, "personalTelegramWorker: bool('PERSONAL_TELEGRAM_WORKER_ENABLED')", 'MANUAL_SPOT_PERSONAL_TELEGRAM_STATE_MISSING');
requireText(manualSpotGate, "PERSONAL_TELEGRAM_WORKER_ENABLED: String(pre.personalTelegramWorker)", 'MANUAL_SPOT_PERSONAL_TELEGRAM_PRESERVATION_MISSING');
requireText(manualSpotGate, "post.personalTelegramWorker !== pre.personalTelegramWorker", 'MANUAL_SPOT_PERSONAL_TELEGRAM_POSTCHECK_MISSING');
requireText(manualSpotGate, "const allowed = new Set(['toss', 'kiwoom', 'upbit']);", 'MANUAL_SPOT_THREE_PROVIDER_SET_DRIFT');
requireText(manualSpotGate, 'name.startsWith(`${workflowName} ${target} `)', 'MANUAL_SPOT_DYNAMIC_ACCOUNT_QA_RUN_NAME_SUPPORT_MISSING');
requireText(manualSpotGate, 'merge-multiple: true', 'MANUAL_SPOT_PREACTIVATION_ARTIFACTS_NOT_MERGED');

requireText(manualFuturesGate, "FUTURES_LIVE_EXECUTION_AUTHORITY: 'FUTURES_LIVE_LIMITED'", 'MANUAL_FUTURES_AUTHORITY_MISSING');
requireText(manualFuturesGate, "FUTURES_LIVE_MARKET_ALLOWLIST: 'CRYPTO_FUTURES'", 'MANUAL_FUTURES_MARKET_MISSING');
requireText(manualFuturesGate, "FUTURES_LIVE_MARGIN_MODE: 'isolated'", 'MANUAL_FUTURES_ISOLATED_MISSING');
requireText(manualFuturesGate, 'AUTO_TRADING=false', 'MANUAL_FUTURES_GATE_MUST_KEEP_AUTO_FALSE');
requireText(manualFuturesGate, 'LIVE_AUTOMATIC_TRADING_ENABLED=false', 'MANUAL_FUTURES_GATE_MUST_KEEP_LIVE_AUTO_FALSE');
requireText(manualFuturesGate, 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED=false', 'MANUAL_FUTURES_GATE_MUST_KEEP_LIVE_WORKER_FALSE');
requireText(manualFuturesGate, "CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED: 'false'", 'MANUAL_FUTURES_LEGACY_CRYPTO_ROUTE_NOT_DISABLED');
requireText(manualFuturesGate, "telegramDeliveryWorker: bool('PERSONAL_TELEGRAM_WORKER_ENABLED')", 'MANUAL_FUTURES_PERSONAL_TELEGRAM_STATE_MISSING');
requireText(manualFuturesGate, "PERSONAL_TELEGRAM_WORKER_ENABLED: String(pre.telegramDeliveryWorker)", 'MANUAL_FUTURES_PERSONAL_TELEGRAM_PRESERVATION_MISSING');
requireText(manualFuturesGate, "post.telegramDeliveryWorker !== pre.telegramDeliveryWorker", 'MANUAL_FUTURES_PERSONAL_TELEGRAM_POSTCHECK_MISSING');
requireText(manualFuturesGate, 'run.name.startsWith(`${name} ${target} `)', 'MANUAL_FUTURES_DYNAMIC_ACCOUNT_QA_RUN_NAME_SUPPORT_MISSING');
requireText(manualFuturesGate, 'merge-multiple: true', 'MANUAL_FUTURES_PREACTIVATION_ARTIFACTS_NOT_MERGED');

const autoFn = tradeService.match(/export function automaticLiveExecutionEnabled[\s\S]*?\r?\n}\r?\n/);
if (!autoFn) throw new Error('AUTOMATIC_LIVE_EXECUTION_FUNCTION_MISSING');
for (const token of [
  "process.env.AUTO_TRADING === 'true'",
  "process.env.MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED === undefined",
  "process.env.MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED === 'false'",
  "process.env.LIVE_AUTOMATIC_TRADING_ENABLED === 'true'",
  'liveExecutionEnabled(exchange)',
  "'SPOT_LIVE_LIMITED'",
  "'FUTURES_LIVE_LIMITED'",
]) {
  requireText(autoFn[0], token, 'AUTOMATIC_LIVE_EXECUTION_CONTRACT_DRIFT');
}

for (const token of [
  "accountMode: 'paper'",
  'persistMemberAutoTradingPaperPositionBridge',
  'export function memberAutoTradingWorkerMode(',
  "if (paperOnly === 'true') return 'PAPER_ONLY'",
  "if (paperOnly !== undefined && paperOnly !== 'false') return 'DISABLED';",
  "return (paperOnly === undefined || paperOnly === 'false')",
  "const mode = memberAutoTradingWorkerMode();",
  "if (mode === 'DISABLED')",
  "process.env.MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED === 'true'",
  'buildAutomaticExitPlanInput',
  "input.paperInput.signalReasons",
  "'CANONICAL_LIVE_AUTO_HANDOFF'",
  'readMarketMark',
  'paperExitOrders',
  'liveExitOrders',
  'liveTrackedPositions',
  'liveEntryWarmupComplete',
  'liveEntryArmPresent',
  'liveExitsSuppressedByWarmupOrArm',
  "if (!liveExitsArmedThisTick || !hasCapability(member.profile, 'canPlaceOrders'))",
  "const liveEntriesArmedThisTick = liveExitsArmedThisTick",
  "&& !this.liveCycleHardWarmupBlocked;",
  'liveAllFourConnectionVerificationReady',
  "const required: readonly TradingExchange[] = ['toss', 'kiwoom', 'upbit', 'bitget'];",
  'liveAllFourConnectionVerificationReady(policy, connections, nowMs)',
  'liveProviderSnapshotReadyForAutomaticWarmup',
  'assertAutomaticLiveSnapshotIsolation(snapshot, owned, maximumLeverage)',
  "this.readLiveAccountSnapshot(userId, provider)",
  '&& liveSnapshotsReady',
  'paperReadEnabled = true',
  'hasCapability(member.profile, \'canManageMembers\'), !liveModeRequested)',
  'executionSyncBlocks',
  'executionSyncMissingReferences',
  'if (synced.missingReferences > 0)',
  'newEntriesFailClosed',
  'runtimeRefreshes',
  'overlapSkipped',
  'liveOrderEligibleMembers',
  'livePolicyReadyMembers',
  'liveAllFourPolicyReadyMembers',
  'liveReadinessCycleComplete',
  'liveCycleOrderEligible',
  'liveCyclePolicyReady',
  'liveCycleAllFourPolicyReady',
  'memberBatchCycleCompleted',
  'this.liveCycleOrderEligibleSeen = false',
  'this.liveCyclePolicyReadySeen = false',
  'this.liveCycleAllFourPolicyReadySeen = false',
  'globalEmergencyStopActive',
  'automaticPolicyHasRunnableMarket',
  'automaticPolicyHasAllFourMarkets',
  "const memberCanRunAutomation = hasCapability(member.profile, 'canAccessAutoTrading');",
  "const memberAutoExecutionEnabled = memberCanRunAutomation",
  "this.liveCycleHardWarmupBlocked ||= hardWarmupBlock;",
  "if (this.liveCycleHardWarmupBlocked) {",
  "if (cycleComplete) this.liveCycleHardWarmupBlocked = false;",
  "throw new Error('BACKGROUND_MEMBER_ACCESS_PROFILE_MISSING');",
  "if (!memberAutoExecutionEnabled) {",
  "result.liveExitsSuppressedByPolicy += livePositions.length;",
  "payload: (row.payload ?? {}) as Partial<TradingPolicy>",
  'policy: normalizeTradingPolicy(row.payload, maximumSingleEntryKrw)',
  'maximumSingleEntryKrwForProfile(profile)',
  'private memberBatchCursor: string | null = null;',
  ".order('user_id', { ascending: true })",
  '.limit(MAX_MEMBERS_PER_TICK + 1)',
  "query = query.gt('user_id', this.memberBatchCursor)",
  'const hasMore = fetched.length > MAX_MEMBERS_PER_TICK;',
  'this.memberBatchCursor = hasMore && lastUserId ? lastUserId : null;',
  'const refreshRuntime = async () =>',
  'Always re-read canonical exposure at the entry boundary',
  'let entryProjectionHealthy = liveModeRequested',
  '? true',
  'if (!entryProjectionHealthy) {',
  'await refreshRuntime();',
  'if (liveEntriesArmedThisTick && hasCapability',
]) {
  requireText(paperWorker, token, 'AUTO_GATE_PAPER_BACKGROUND_CONTRACT_DRIFT');
}
requireText(paperWorkerTest, 'expired automatic member retains read-only Live fill visibility and has zero order authority', 'AUTO_GATE_EXPIRED_LIVE_FILL_REGRESSION_MISSING');
requireText(paperWorkerTest, 'blocked member evidence survives paginated warmup and cannot be erased by a ready later batch', 'AUTO_GATE_PAGINATED_WARMUP_BLOCKER_REGRESSION_MISSING');
requireText(liveEntryArm, 'activateNotBeforeMs >= armedAtMs', 'AUTO_GATE_WORKER_ARM_TIMESTAMP_ORDER_MISSING');
requireText(liveEntryArm, 'nowMs >= activateNotBeforeMs', 'AUTO_GATE_WORKER_ARM_NOT_BEFORE_ENFORCEMENT_MISSING');
requireText(liveEntryArm, 'member-auto-trading-live-entry-arm-v1', 'AUTO_GATE_WORKER_ARM_SCHEMA_MISSING');
requireText(paperWorker, 'if (!await liveEntryArmPresent())', 'AUTO_GATE_WORKER_REARM_MISSING');
requireText(paperWorker, "liveExitsSuppressedByPolicy", 'AUTO_GATE_STOPPED_LIVE_POSITION_VISIBILITY_MISSING');
requireText(paperWorker, 'canonicalAutomaticLivePositions(runtime.plans, runtime.orders)', 'AUTO_GATE_CANONICAL_POSITION_OWNERSHIP_MISSING');
requireText(positionIsolation, "'BACKGROUND_LIVE_MANUAL_ASSET_PROTECTED'", 'AUTO_GATE_MANUAL_ASSET_PROTECTION_MISSING');
requireText(positionIsolation, "'BACKGROUND_LIVE_POSITION_QUANTITY_DRIFT'", 'AUTO_GATE_MIXED_POSITION_BLOCK_MISSING');
requireText(positionIsolation, "'BACKGROUND_LIVE_CANONICAL_EXIT_OWNERSHIP_REQUIRED'", 'AUTO_GATE_CANONICAL_EXIT_PROOF_MISSING');
for (const token of ["snapshot.openOrders.length !== 0", "snapshot.positionMode !== 'one_way_mode'",
  "position.marginMode !== 'isolated'", 'position.leverage! < 2 || position.leverage! > maximumLeverage']) {
  requireText(positionIsolation, token, 'AUTO_GATE_ISOLATION_PROVIDER_SAFETY_MISSING');
}
requireText(liveExecution, 'await this.assertAutomaticLivePositionIsolation(userId, plan);', 'AUTO_GATE_SUBMISSION_POSITION_RECHECK_MISSING');
requireText(workflow, '--require-automatic-position-isolation', 'AUTO_GATE_POSITION_ISOLATION_RECEIPT_MISSING');
requireText(preactivationEvidence, 'assertAutomaticPositionIsolationReceipt(account)', 'AUTO_GATE_POSITION_ISOLATION_VERIFIER_MISSING');
requireText(liveExecution, "throw new Error('AUTOMATIC_LIVE_ENTRY_ARM_NOT_READY')", 'AUTO_GATE_PROVIDER_ARM_MISSING');
requireText(liveExecution, 'await this.assertAutomaticLiveEntryAuthorized(userId, risk.plan);', 'AUTO_GATE_BITGET_MUTATION_ARM_GUARD_MISSING');
requireText(liveExecution, "'AUTOMATIC_ENTRY_POLICY_REVOKED'", 'AUTO_GATE_AUTO_ORIGIN_POLICY_REVOCATION_GUARD_MISSING');
requireText(liveExecution, "const automaticLive = currentPolicy.mode === 'automatic' && currentPolicy.automaticEnabled;", 'AUTO_GATE_STRICT_CURRENT_AUTO_AUTHORITY_MISSING');
requireText(paperWorker, "result.handoffStatus = 'BLOCKED_DATA';", 'AUTO_GATE_BAD_HANDOFF_QUARANTINE_MISSING');
requireText(paperWorker, 'selectRotatingHandoffEntries(', 'AUTO_GATE_FAIR_ENTRY_PAGING_MISSING');
requireText(paperWorker, "buildPlanInput(member, entry, runtime, fx, nowMs, 'live')", 'AUTO_GATE_LIVE_CANDIDATE_INDEPENDENCE_MISSING');
requireText(paperWorker, 'if (!paperLaneReady && !liveModeRequested)', 'AUTO_GATE_PAPER_LANE_INDEPENDENCE_MISSING');
forbid(paperWorker, /liveEntriesArmedThisTick[^;]+telegramDeliveryHealthy/us,
  'AUTO_GATE_TELEGRAM_ENTRY_COUPLING_FORBIDDEN');
requireText(paperWorker, 'formulaAiReviewReasonsForLive(input.entry, input.nowMs)', 'AUTO_GATE_FORMULA_AI_PROOF_FORWARDING_MISSING');
requireText(paperWorker, "if (code === 'BACKGROUND_FORMULA_AI_REVIEW_PROOF_REQUIRED')", 'AUTO_GATE_FORMULA_AI_BLOCKED_RUNTIME_STATUS_MISSING');
requireText(paperWorker, "throw new Error('BACKGROUND_FORMULA_AI_REVIEW_PROOF_REQUIRED')", 'AUTO_GATE_FORMULA_AI_MISSING_PROOF_BLOCK_MISSING');
requireText(handoffContract, 'canonicalAiReviewEvidenceValid(', 'AUTO_GATE_CANONICAL_AI_REVIEW_VALIDATION_MISSING');
const { createHash } = await import('node:crypto');
const { AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS } = await import(
  '../../.github/scripts/paper-forward-reviewed-paths.mjs'
);
const signalHandoffBridge = read('signal-intelligence-v3/src/auto-trading-handoff-bridge.mjs');
const signalHandoffBridgeTest = read('signal-intelligence-v3/tests/auto-trading-handoff-bridge.test.mjs');
const signalPublicRunner = read('signal-intelligence-v3/scripts/run-public-scanner-cycle.ts');
const signalCanonicalAdapter = read('signal-intelligence-v3/src/canonical-adapter.mjs');
const signalCanonicalAdapterTest = read('signal-intelligence-v3/tests/canonical-adapter.test.mjs');
const signalPublicProgress = read('signal-intelligence-v3/src/public-cycle-progress-v2.mjs');
const publicProviderDiagnostics = read('signal-intelligence-v3/src/public-provider-diagnostics.mjs');
const publicProviderDiagnosticsTest = read('signal-intelligence-v3/tests/public-provider-diagnostics.test.mjs');
const stockSignalScanner = read('api-server/src/services/stock-signal-scanner.service.ts');
const telegramV3CurrentSource = read('api-server/src/services/telegram-v3-current-source.service.ts');
const scannerCandidateRanking = read('api-server/src/services/scanner-candidate-ranking.service.ts');
const scannerCandidateRankingTest = read('api-server/src/services/scanner-candidate-ranking.service.test.ts');
const scannerQualityConsumer = read('api-server/src/services/forward-observer-scanner-quality-consumer.service.ts');
const scannerQualityConsumerTest = read('api-server/src/services/forward-observer-scanner-quality-consumer.service.test.ts');
const forwardCanonicalMetadata = read('api-server/src/services/forward-observer-canonical-metadata.service.ts');
const forwardRuntime = read('api-server/src/services/forward-recommendation-observer-runtime.service.ts');
const forwardRuntimeTest = read('api-server/src/services/forward-recommendation-observer-runtime.service.test.ts');
const forwardCycleRunner = read('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
const fourMarketLiveQa = read('signal-intelligence-v3/scripts/run-four-market-live-qa.ts');
const scannerIndicators = read('api-server/src/services/scanner-indicator-library.service.ts');
const scannerQuantTest = read('api-server/src/services/scanner-quant-strategy.service.test.ts');
const scannerScope = read('.github/scripts/scanner-readonly-repair-scope.mjs');
const workspaceScope = read('.github/scripts/verify-research-workspace-sync-v3.mjs');
const paperScopeWorkflow = read('.github/workflows/paper-forward-schedule-validation.yml');
if (AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS.length !== 72
  || new Set(AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS).size !== 72
  || JSON.stringify(AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS)
    !== JSON.stringify([...AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS].sort())
  || createHash('sha256').update(AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS.join('\n')).digest('hex')
    !== '80766729b0003a8d4e84fc0fb2413fdf59f2d36067b186563a6d29ed8750eb7e') {
  throw new Error('AUTO_GATE_SIGNAL_PIPELINE_SCOPE_DRIFT');
}
for (const path of AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS) {
  requireText(workflow, `      - ${path}`, 'AUTO_GATE_SIGNAL_PIPELINE_TRIGGER_MISSING');
}
requireText(scannerScope, '!fullAutomaticReview.has(path)', 'AUTO_GATE_SIGNAL_PIPELINE_SCANNER_PRECEDENCE_MISSING');
requireText(workspaceScope, '...AUTOMATIC_SIGNAL_PIPELINE_REVIEWED_PATHS', 'AUTO_GATE_SIGNAL_PIPELINE_WORKSPACE_SCOPE_MISSING');
requireText(paperScopeWorkflow, '--list-auto-signal-pipeline', 'AUTO_GATE_SIGNAL_PIPELINE_PAPER_SCOPE_MISSING');
for (const token of [
  'selectSignalAdmittedHandoffEntries',
  "snapshot?.publicDataOnly !== true || snapshot?.rosterBindingVersion !== 1",
  "snapshot?.safety?.executionAuthority !== 'NONE'",
  "snapshot?.serviceSha !== expectedServiceSha",
  "row?.state === 'CANDIDATE'",
  'identity?.signalId === entry?.identity?.signalId',
  'identity.parameterHash === entry.identity.parameterHash',
]) requireText(signalHandoffBridge, token, 'AUTO_GATE_SIGNAL_V3_HANDOFF_CONTRACT_MISSING');
for (const token of [
  'four-market candidates are admitted only when Signal V3 keeps the exact canonical identity',
  'no-order E2E publishes four-market scanner candidates and gates the same handoff for the worker',
  'stale snapshots and identity mutations fail closed',
  'assert.equal(published.safety.realOrderAllowed, false)',
]) requireText(signalHandoffBridgeTest, token, 'AUTO_GATE_SIGNAL_V3_HANDOFF_REGRESSION_MISSING');
for (const token of [
  'enforceVetoOnlyHandoffSelection(',
  "throw new Error('BACKGROUND_SIGNAL_SELECTION_NOT_VETO_ONLY')",
  'MEMBER_AUTO_TRADING_SIGNAL_INTELLIGENCE_PATH',
  'MEMBER_AUTO_TRADING_SIGNAL_INTELLIGENCE_SHA',
  'expectedServiceSha: this.signalIntelligenceSha',
  'signalOccurrenceId: `${entry.identity.signalId}@${String(entry.signal.timestampMs ?? entry.evaluatedAtMs)}`',
]) requireText(paperWorker, token, 'AUTO_GATE_SIGNAL_V3_WORKER_ADMISSION_MISSING');
for (const token of [
  'SIGNAL_INTELLIGENCE_CANONICAL_HANDOFF_FILE',
  'SIGNAL_INTELLIGENCE_SCANNER_QUALITY_ROOT',
  'validateMemberAutoTradingPaperHandoff(value, nowMs)',
  'readForwardObserverScannerQualityArtifact',
  "const STOCK_MEMBER_ID = 'signal-intelligence-forward-observer-public-only'",
  "const CRYPTO_MEMBER_ID = 'forward-observer-public-only'",
  "input.paperIdentity && input.card?.signalGrade === 'S'",
  'FORWARD_OBSERVER_LANES.map((lane)',
  'entry.identity.strategyHorizon === lane.strategyHorizon',
  'selectSignalAdmittedHandoffEntries({',
  'canonicalWorkerHandoff',
  'handoffState = await canonicalHandoff(laneNowMs)',
  'handoffState = await canonicalHandoff(publicationNowMs)',
  'rosterBindingVersion: 1',
  'publicDataOnly: true',
]) requireText(signalPublicRunner, token, 'AUTO_GATE_SIGNAL_V3_PUBLIC_RUNNER_BINDING_MISSING');
requireText(signalCanonicalAdapter, "return grade === 'S';", 'AUTO_GATE_SIGNAL_V3_EXACT_S_GRADE_MISSING');
requireText(signalCanonicalAdapterTest,
  'only an explicit S grade can cross the automatic-trading quant gate',
  'AUTO_GATE_SIGNAL_V3_EXACT_S_GRADE_REGRESSION_MISSING');
requireText(stockSignalScanner, 'backtests: request.backtests', 'AUTO_GATE_SCANNER_QUALITY_BINDING_MISSING');
requireText(scannerCandidateRanking,
  'input.backtests?.[`${card.symbol}|${direction}`] ?? input.backtests?.[card.symbol]',
  'AUTO_GATE_DIRECTIONAL_SCANNER_QUALITY_LOOKUP_MISSING');
requireText(scannerCandidateRankingTest,
  'futures quality is selected by symbol and direction without cross-credit',
  'AUTO_GATE_DIRECTIONAL_SCANNER_QUALITY_RANKING_REGRESSION_MISSING');
requireText(scannerQualityConsumer, "input.lane.market === 'CRYPTO_FUTURES' ? rankingKey : symbol",
  'AUTO_GATE_DIRECTIONAL_SCANNER_QUALITY_SELECTION_MISSING');
requireText(scannerQualityConsumerTest,
  'same-symbol mixed LONG and SHORT keep direction-isolated quality keys',
  'AUTO_GATE_DIRECTIONAL_SCANNER_QUALITY_SELECTION_REGRESSION_MISSING');
for (const token of ['KR_SCALPING_5M', 'SPOT_SCALPING_15M', 'SPOT_MID_LONG_4H', 'FUTURES_MID_LONG_4H']) {
  requireText(signalPublicProgress, token, 'AUTO_GATE_TWELVE_LANE_PUBLIC_CYCLE_MISSING');
  requireText(telegramV3CurrentSource, token, 'AUTO_GATE_TWELVE_LANE_TELEGRAM_MISSING');
}
for (const token of [
  "strategyHorizon: 'SCALP'", "strategyHorizon: 'SWING'", "strategyHorizon: 'POSITION'",
  'migrateForwardObserverRuntimeState(', "strategies: ['SCALPING', 'SWING', 'MID_LONG']",
]) requireText(forwardRuntime, token, 'AUTO_GATE_TWELVE_LANE_FORWARD_RUNTIME_MISSING');
requireText(forwardRuntimeTest,
  'legacy four-lane restart state migrates without losing SWING cursors or observations',
  'AUTO_GATE_TWELVE_LANE_RESTART_REGRESSION_MISSING');
for (const token of [
  'input.lane.strategyHorizon', 'input.lane.strategyMode', 'style: input.lane.style',
]) requireText(forwardCanonicalMetadata, token, 'AUTO_GATE_TWELVE_LANE_CANONICAL_METADATA_MISSING');
for (const token of [
  "strategyMode: lane.strategyMode", "strategy: lane.strategyMode",
  "SIGNAL_INTELLIGENCE_YAHOO_USAGE_CONFIRMED !== 'true'",
  "{ '5m': '5m', '60m': '1H', '4H': '4H' }",
]) requireText(forwardCycleRunner, token, 'AUTO_GATE_TWELVE_LANE_FORWARD_RUNNER_MISSING');
requireText(scannerQualityConsumer, 'identity.strategyHorizon === input.lane.strategyHorizon',
  'AUTO_GATE_TWELVE_LANE_QUALITY_BINDING_MISSING');
requireText(scannerQualityConsumerTest,
  'all twelve market and horizon lanes select only an exact independent quality identity',
  'AUTO_GATE_TWELVE_LANE_QUALITY_REGRESSION_MISSING');
requireText(scannerCandidateRanking, 'Math.max(40, summary.minimumTradeCount ?? 40)',
  'AUTO_GATE_SCANNER_QUALITY_SAMPLE_FLOOR_MISSING');
for (const token of [
  '/api/v2/mix/market/current-fund-rate', '/api/v2/mix/market/open-interest',
  '/api/v2/mix/market/merge-depth', 'BITGET_DEPTH_INVALID',
]) requireText(fourMarketLiveQa, token, 'AUTO_GATE_BITGET_PUBLIC_QUALITY_QA_MISSING');
for (const token of [
  'data.krx.co.kr', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'www.nasdaqtrader.com',
  'api.upbit.com', 'api.bitget.com', 'MANAGED_PROXY_CONNECT_403', 'PROVIDER_HTTP_403',
]) requireText(publicProviderDiagnostics, token, 'AUTO_GATE_PUBLIC_PROVIDER_DIAGNOSTIC_MISSING');
requireText(publicProviderDiagnosticsTest,
  'CONNECT 403 is distinguished from a provider HTTP 403 response',
  'AUTO_GATE_PUBLIC_PROVIDER_CLASSIFICATION_REGRESSION_MISSING');
for (const token of [
  'index < candles.length - rightBars',
  "ScannerWaveStructure = 'BULLISH' | 'BEARISH' | 'MIXED' | 'INSUFFICIENT'",
]) requireText(scannerIndicators, token, 'AUTO_GATE_CONFIRMED_WAVE_CONTRACT_MISSING');
requireText(scannerQuantTest,
  'wave structure uses confirmed pivots and ignores an unconfirmed final-bar spike',
  'AUTO_GATE_CONFIRMED_WAVE_REGRESSION_MISSING');
requireText(tradeTypes, 'maxDailyOrders: 0', 'AUTO_GATE_UNLIMITED_DAILY_OPPORTUNITY_POLICY_MISSING');
requireText(tradeTypes, 'signalOccurrenceId?: string | null', 'AUTO_GATE_SIGNAL_OCCURRENCE_ID_MISSING');
requireText(tradeService, 'input.signalOccurrenceId.trim()', 'AUTO_GATE_SIGNAL_OCCURRENCE_IDEMPOTENCY_MISSING');
requireText(tradeIntegrationTest,
  'validated signal occurrences are idempotent within one event and allow a later repeat opportunity',
  'AUTO_GATE_REPEAT_OPPORTUNITY_REGRESSION_MISSING');
for (const token of [
  'this.liveCycleAllFourPolicyReadySeen || this.liveCycleMarketScopedPolicyReadySeen',
  "member.policy.pilotStage === 'formula-ai-exception'",
  'automaticPolicyHasAllFourMarkets(member.policy)',
]) requireText(paperWorker, token, 'AUTO_GATE_WORKER_SCOPED_OR_ALL4_WARMUP_FORMULA_MISSING');
requireText(apiIndex, 'autoTradingBackground: readMemberAutoTradingBackgroundRuntimeHealth()', 'AUTO_GATE_WORKER_HEALTH_ENDPOINT_MISSING');
requireText(paperWorkerTest, 'Live readiness and entry do not require Paper wallet or Telegram binding', 'AUTO_GATE_LIVE_INDEPENDENCE_REGRESSION_MISSING');
requireText(liveConnectionVerification, "LIVE_CONNECTION_VERIFICATION_MAX_AGE_MS", 'AUTO_GATE_CREDENTIAL_AGE_POLICY_MISSING');
requireText(liveExecution, "liveConnectionVerificationFresh(connection)", 'AUTO_GATE_ORDER_TIME_CREDENTIAL_RECHECK_MISSING');
requireText(liveExecution, "isRiskReducingExitPlan(plan)", 'AUTO_GATE_RISK_REDUCING_EXIT_EXCEPTION_MISSING');
requireText(liveExecution, "isRiskReducingExitPlan(input)", 'AUTO_GATE_RISK_REDUCING_PREVIEW_EXCEPTION_MISSING');
requireText(liveExecution, "liveConnectionVerificationAllowsReducingExit(connection)", 'AUTO_GATE_RISK_REDUCING_EXIT_GUARD_MISSING');
requireText(liveConnectionVerification, "export function liveConnectionVerificationAllowsReducingExit(", 'AUTO_GATE_EXIT_VERIFICATION_HELPER_MISSING');
requireText(liveConnectionVerification, "export function isRiskReducingExitPlan(", 'AUTO_GATE_REDUCING_SIDE_DEFINITION_MISSING');
requireText(tradeAutomationRoute, "liveConnectionVerificationAllowsReducingExit(connection)", 'AUTO_GATE_MANUAL_EXIT_READINESS_FRESHNESS_MISSING');
requireText(tradeAutomationRoute, "providerVerified: liveConnectionVerificationFresh(connection)", 'AUTO_GATE_PROVIDER_FRESHNESS_STATUS_MISSING');
requireText(paperWorkerTest, 'zero-mutation activation rehearsal transitions warmup to exact-SHA arm with no provider request or live order', 'AUTO_GATE_ZERO_MUTATION_ACTIVATION_REHEARSAL_MISSING');
requireText(paperWorkerTest, 'activateNotBeforeAt: new Date(nowMs + 1_500).toISOString()', 'AUTO_GATE_DELAYED_ARM_REHEARSAL_MISSING');
requireText(paperWorkerTest, 'assert.equal(quarantined.liveEntriesArmed, false);', 'AUTO_GATE_PRE_NOT_BEFORE_BLOCK_PROOF_MISSING');
requireText(paperWorkerTest, 'assert.equal(armed.liveEntriesArmed, true);', 'AUTO_GATE_ACTIVATION_REHEARSAL_ARM_PROOF_MISSING');
requireText(paperWorkerTest, 'assert.equal(armed.liveOrders, 0);', 'AUTO_GATE_ACTIVATION_REHEARSAL_ZERO_ORDER_PROOF_MISSING');
requireText(paperWorkerTest, 'assert.equal(armed.privateTradingRequests, 0);', 'AUTO_GATE_ACTIVATION_REHEARSAL_ZERO_PROVIDER_MUTATION_PROOF_MISSING');
requireText(paperWorkerTest, 'live activation warmup stays fail-closed when no member can place real orders', 'AUTO_GATE_NO_LIVE_MEMBER_FAIL_CLOSED_TEST_MISSING');
requireText(paperWorkerTest, 'live warmup survives an empty intermediate member batch and drops only after a full empty rotation cycle', 'AUTO_GATE_ROTATION_CYCLE_READINESS_TEST_MISSING');
requireText(paperWorkerTest, 'worker failure clears partial rotation readiness before the recovery cycle', 'AUTO_GATE_ROTATION_FAILURE_RESET_TEST_MISSING');
requireText(paperWorkerTest, 'assert.equal(recovered.liveCycleOrderEligible, false);', 'AUTO_GATE_ROTATION_FAILURE_RESET_ASSERTION_MISSING');
requireText(paperWorkerTest, 'assert.equal(middle.liveEntryWarmupComplete, true);', 'AUTO_GATE_ROTATION_INTERMEDIATE_WARMUP_ASSERTION_MISSING');
requireText(paperWorkerTest, 'assert.equal(end.liveEntryWarmupComplete, false);', 'AUTO_GATE_ROTATION_COMPLETE_DROP_ASSERTION_MISSING');
requireText(paperWorker, 'liveReadinessCycleComplete: true', 'AUTO_GATE_ROTATION_HEALTH_RESET_MISSING');
requireText(paperWorkerTest, 'first live warmup suppresses automatic exits for existing live positions before exact-SHA arm', 'AUTO_GATE_LIVE_EXIT_WARMUP_TEST_MISSING');
requireText(paperWorkerTest, 'all-four activation readiness requires one order-capable futures member with all four markets enabled', 'AUTO_GATE_ALL4_POLICY_READINESS_TEST_MISSING');
requireText(paperWorkerTest, 'partial-market automatic policy cannot complete live warmup even with order capability', 'AUTO_GATE_PARTIAL_MARKET_WARMUP_BLOCK_TEST_MISSING');
requireText(paperWorkerTest, 'assert.equal(result.liveAllFourPolicyReadyMembers, 0);', 'AUTO_GATE_PARTIAL_MARKET_WARMUP_ASSERTION_MISSING');
requireText(paperWorkerTest, 'assert.equal(result.liveAllFourPolicyReadyMembers, 1);', 'AUTO_GATE_ALL4_POLICY_READINESS_ASSERTION_MISSING');
requireText(paperWorkerTest, 'assert.equal(result.liveExitsSuppressedByWarmupOrArm, 1);', 'AUTO_GATE_LIVE_EXIT_WARMUP_ASSERTION_MISSING');
requireText(paperWorkerTest, 'assert.equal(health.liveTrackedPositions, 0);', 'AUTO_GATE_DISABLED_HEALTH_TRACKED_POSITION_RESET_MISSING');
requireText(paperWorkerTest, 'assert.equal(health.liveAllFourPolicyReadyMembers, 0);', 'AUTO_GATE_DISABLED_HEALTH_ALL4_RESET_MISSING');
requireText(paperWorkerTest, 'assert.equal(result.liveOrderEligibleMembers, 0);', 'AUTO_GATE_NO_LIVE_MEMBER_ASSERTION_MISSING');

requireText(autoTradingPage, 'readyForAutomaticOrderEvaluation', 'AUTO_UI_RUNTIME_READINESS_MISSING');
requireText(autoTradingPage, 'runtimeStatus?.autoTradingBackground', 'AUTO_UI_WORKER_RUNTIME_HEALTH_MISSING');
requireText(autoTradingPage, 'autoWorker.liveEntriesArmed === true', 'AUTO_UI_ARMED_STATE_MISSING');
requireText(autoTradingPage, '안전대기 · Arm 준비 중', 'AUTO_UI_ARM_WAIT_LABEL_MISSING');
requireText(autoTradingPage, '자동 실거래 작동 준비됨', 'AUTO_UI_RUNTIME_READY_LABEL_MISSING');
requireText(autoTradingPage, 'runtimeHealthFresh', 'AUTO_UI_RUNTIME_HEALTH_FRESHNESS_HELPER_MISSING');
requireText(autoTradingPage, 'nowMs - tickMs <= 360_000', 'AUTO_UI_RUNTIME_HEALTH_FRESHNESS_BOUND_MISSING');
requireText(autoTradingPage, '자동 워커 상태 지연', 'AUTO_UI_STALE_WORKER_LABEL_MISSING');
requireText(autoTradingPage, 'runtimeRefreshInFlight', 'AUTO_UI_STATUS_POLLING_DEDUP_MISSING');
requireText(autoTradingPage, 'setRuntimeClockMs(Date.now())', 'AUTO_UI_STATUS_FRESHNESS_CLOCK_MISSING');
requireText(autoTradingPage, 'setRuntimeReadError(true)', 'AUTO_UI_STATUS_READ_FAILURE_STATE_MISSING');
requireText(autoTradingPage, '상태 조회 실패', 'AUTO_UI_STATUS_READ_FAILURE_LABEL_MISSING');
requireText(autoTradingPage, "tone={providerVerified ? 'ok' : 'warn'}", 'AUTO_UI_PROVIDER_STATUS_TONE_MISSING');
requireText(autoTradingPage, "tone={effectiveEntryStopped ? 'warn' : 'ok'}", 'AUTO_UI_STOP_STATUS_TONE_MISSING');
requireText(autoTradingPage, "tone={!runtimeReadError && liveReadiness?.readyForAutomaticOrderEvaluation === true && automaticRuntimeReady ? 'ok' : 'warn'}", 'AUTO_UI_AUTHORITY_STATUS_TONE_MISSING');
requireText(autoTradingPage, 'AlertTriangle', 'AUTO_UI_WARNING_ICON_MISSING');
requireText(autoTradingPage, 'liveAutomaticReadinessByMarket?.[market]', 'AUTO_UI_MARKET_RUNTIME_READINESS_MISSING');
requireText(autoTradingPage, 'automaticServerGateEnabled', 'AUTO_UI_AUTOMATIC_GATE_STATE_MISSING');
requireText(autoTradingPage, "const newEntriesStopped = policy?.newEntriesStopped === true", 'AUTO_UI_NEW_ENTRY_STOP_STATE_MISSING');
requireText(autoTradingPage, 'const effectiveEntryStopped = emergencyStopped || newEntriesStopped', 'AUTO_UI_EFFECTIVE_ENTRY_STOP_MISSING');
requireText(autoTradingPage, '신규진입 차단', 'AUTO_UI_NEW_ENTRY_STOP_LABEL_MISSING');
requireText(autoTradingPage, "auth.can('canPlaceOrders')", 'AUTO_UI_MEMBER_ORDER_CAPABILITY_MISSING');
requireText(autoTradingPage, '계정 주문 권한 없음', 'AUTO_UI_MEMBER_ORDER_CAPABILITY_LABEL_MISSING');
forbid(autoTradingPage, /value="서버 Gate 필요"/u, 'AUTO_UI_HARDCODED_SERVER_GATE_FORBIDDEN');
requireText(autoTradingSettings, 'liveAutomaticExecutionServerEnabled', 'AUTO_SETTINGS_LIVE_AUTO_GATE_MISSING');
requireText(autoTradingSettings, 'readyForAutomaticOrderEvaluation', 'AUTO_SETTINGS_RUNTIME_READINESS_MISSING');
requireText(autoTradingSettings, 'live-position-stop-warning', 'AUTO_SETTINGS_LIVE_POSITION_STOP_WARNING_MISSING');
requireText(autoTradingSettings, '기존 Live 자동포지션의 후속 자동청산 감시도 중단될 수 있습니다.', 'AUTO_SETTINGS_LIVE_POSITION_WARNING_TEXT_MISSING');
requireText(autoTradingSettings, 'liveAutomaticReadinessByMarket', 'AUTO_SETTINGS_MARKET_RUNTIME_READINESS_MISSING');
requireText(autoTradingSettings, "load({ syncDraft: false })", 'AUTO_SETTINGS_RUNTIME_REFRESH_MISSING');
requireText(autoTradingSettings, 'refreshInFlight', 'AUTO_SETTINGS_REFRESH_DEDUP_MISSING');
requireText(autoTradingSettings, 'if (syncDraft) {', 'AUTO_SETTINGS_DRAFT_PRESERVATION_MISSING');
requireText(autoTradingSettings, 'newEntriesStopped', 'AUTO_SETTINGS_MEMBER_STOP_STATE_MISSING');
requireText(autoTradingSettings, "confirmation: 'RESUME_MEMBER_TRADING'", 'AUTO_SETTINGS_MEMBER_RESUME_CONFIRMATION_MISSING');
requireText(autoTradingSettings, 'data-testid="member-trading-resume"', 'AUTO_SETTINGS_MEMBER_RESUME_BUTTON_MISSING');
requireText(autoTradingSettings, 'disabled={effectiveStopped}', 'AUTO_SETTINGS_STOP_BYPASS_UI_BLOCK_MISSING');
requireText(autoTradingSettings, 'data-testid="global-trading-stop"', 'AUTO_SETTINGS_GLOBAL_STOP_UI_MISSING');
requireText(autoTradingSettings, '서버 전체 비상정지 · 관리자 해제 필요', 'AUTO_SETTINGS_GLOBAL_STOP_LABEL_MISSING');
forbid(autoTradingSettings, /window\.setInterval\(\(\) => \{ void load\(\); \}, 15_000\)/u, 'AUTO_SETTINGS_DESTRUCTIVE_REFRESH_FORBIDDEN');
requireText(tradeAutomationRoute, 'function sanitizedAutomaticRuntimeHealth()', 'AUTO_ROUTE_WORKER_HEALTH_SANITIZER_MISSING');
requireText(tradeAutomationRoute, "const mayInspectLiveRuntime = Boolean(req.member && hasCapability(req.member, 'canPlaceOrders'))", 'AUTO_ROUTE_RUNTIME_HEALTH_CAPABILITY_GATE_MISSING');
requireText(tradeAutomationRoute, 'autoTradingBackground: mayInspectLiveRuntime ? sanitizedAutomaticRuntimeHealth() : null', 'AUTO_ROUTE_WORKER_HEALTH_STATUS_MISSING');
requireText(tradeAutomationRoute, 'userTelegramDelivery: mayInspectLiveRuntime ? sanitizedTelegramDeliveryRuntimeHealth() : null', 'AUTO_ROUTE_TELEGRAM_HEALTH_STATUS_MISSING');
forbid(tradeAutomationRoute, /autoTradingBackground:\s*readMemberAutoTradingBackgroundRuntimeHealth\(\)/u, 'AUTO_ROUTE_RAW_GLOBAL_WORKER_HEALTH_FORBIDDEN');
requireText(tradeAutomationRoute, 'enforceMemberTradingPolicy(candidate, current)', 'AUTO_ROUTE_MEMBER_POLICY_GUARD_MISSING');
requireText(tradeAutomationRoute, 'MEMBER_TRADING_RESUME_REQUIRED', 'AUTO_ROUTE_MEMBER_STOP_BYPASS_BLOCK_MISSING');
requireText(tradeAutomationRoute, "router.post('/resume'", 'AUTO_ROUTE_MEMBER_RESUME_ENDPOINT_MISSING');
requireText(tradeAutomationRoute, "req.body?.confirmation !== 'RESUME_MEMBER_TRADING'", 'AUTO_ROUTE_MEMBER_RESUME_CONFIRMATION_MISSING');
requireText(tradeAutomationRoute, 'resumeMemberTradingPolicy(current)', 'AUTO_ROUTE_MEMBER_RESUME_POLICY_MISSING');
requireText(tradeAutomationPolicyGuard, 'Emergency/new-entry stops are sticky', 'AUTO_POLICY_STICKY_STOP_CONTRACT_MISSING');
requireText(tradeAutomationPolicyGuard, 'newEntriesStopped: false', 'AUTO_POLICY_CONFIRMED_RESUME_CLEAR_MISSING');
requireText(tradeAutomationPolicyGuard, 'current.weeklyLossLimitPercent', 'AUTO_POLICY_CURRENT_WEEKLY_LOSS_FLOOR_MISSING');
requireText(tradeAutomationPolicyGuard, 'current.riskPerTradePercent.bitget', 'AUTO_POLICY_CURRENT_RISK_PER_TRADE_FLOOR_MISSING');
requireText(tradeAutomationPolicyGuard, 'current.minExpectedValueR', 'AUTO_POLICY_CURRENT_EXPECTED_VALUE_FLOOR_MISSING');
requireText(tradeAutomationPolicyGuard, 'current.minStrategySampleSize', 'AUTO_POLICY_CURRENT_SAMPLE_SIZE_FLOOR_MISSING');
requireText(tradeAutomationPolicyGuard, 'current.minProfitFactor', 'AUTO_POLICY_CURRENT_PROFIT_FACTOR_FLOOR_MISSING');
requireText(tradeAutomationPolicyGuard, 'current.maxEstimatedSlippagePercent', 'AUTO_POLICY_CURRENT_SLIPPAGE_CEILING_MISSING');
requireText(tradeAutomationPolicyGuardTest, 'member policy save never relaxes stricter hidden safety limits', 'AUTO_POLICY_HIDDEN_SAFETY_REGRESSION_TEST_MISSING');
requireText(tradeAutomationPolicyGuardTest, 'member policy save may tighten hidden safety limits further', 'AUTO_POLICY_HIDDEN_SAFETY_TIGHTENING_TEST_MISSING');
requireText(tradeAutomationSmoke, 'member emergency stop is sticky and only exact confirmed resume clears it without enabling automatic trading', 'AUTO_ROUTE_MEMBER_RESUME_SMOKE_MISSING');
requireText(tradeTypes, "'formula-ai-exception'", 'AUTO_FORMULA_AI_PILOT_STAGE_TYPE_MISSING');
requireText(tradeRisk, "input.pilotStage === 'formula-ai-exception'", 'AUTO_FORMULA_AI_PILOT_NORMALIZATION_MISSING');
requireText(tradeOptimization, "'PILOT_FORMULA_AI_EXCEPTION_REQUIRED'", 'AUTO_FORMULA_AI_PILOT_RISK_BINDING_MISSING');
requireText(tradeOptimization, "'EXTERNAL_STRATEGY_PILOT_V1:RESEARCH_GENUINE_S_NOT_CLAIMED'", 'AUTO_EXTERNAL_PILOT_RESEARCH_DISCLAIMER_MISSING');
requireText(tradeAutomationRoute, "router.post('/admin/pilot-stage'", 'AUTO_FORMULA_AI_PILOT_ROUTE_MISSING');
requireText(tradeAutomationRoute, "'ENABLE_FORMULA_AI_AUTOMATIC_LIVE_PILOT'", 'AUTO_FORMULA_AI_PILOT_CONFIRMATION_MISSING');
requireText(tradeAutomationRoute, "'FORMULA_AI_PILOT_CHANGE_REQUIRES_AUTO_OFF'", 'AUTO_FORMULA_AI_PILOT_AUTO_OFF_GUARD_MISSING');
for (const token of [
  'admissionPath: EXTERNAL_STRATEGY_PILOT_ADMISSION_PATH',
  'admissionPolicyVersion: EXTERNAL_STRATEGY_PILOT_POLICY_VERSION',
  'researchGenuineSClaimed: false',
]) requireText(tradeAutomationRoute, token, 'AUTO_EXTERNAL_PILOT_PREPARATION_RESPONSE_MISSING');
requireText(tradeAutomationSmoke, 'formula-ai pilot stage requires admin, exact confirmation, and AUTO off without enabling trading', 'AUTO_FORMULA_AI_PILOT_SMOKE_MISSING');
requireText(formulaAiException, "'AI_REVIEW_DECISION:PASS'", 'AUTO_FORMULA_AI_PASS_EVIDENCE_MISSING');
requireText(formulaAiException, "'CANONICAL_PAPER_HANDOFF'", 'AUTO_FORMULA_AI_CANONICAL_HANDOFF_REQUIRED');
for (const token of [
  "EXTERNAL_STRATEGY_PILOT_ADMISSION_PATH = 'EXTERNAL_STRATEGY_PILOT'",
  "'EXTERNAL_STRATEGY_PILOT_SOURCE_SET_MISMATCH'",
  'researchGenuineSClaimed: false',
]) requireText(formulaAiException, token, 'AUTO_EXTERNAL_PILOT_ADMISSION_SEPARATION_MISSING');
for (const token of [
  'externalStrategyPilotAllowed: true',
  'EXTERNAL_STRATEGY_SOURCE_SET_DIGEST',
  'reportedReturn: null',
  '현재 스냅샷만으로 과거 CVD·Taker·ML 증거를 만들 수 없다.',
  '현재 OI 한 점은 OI 증가 추세가 아니며 체결 CVD/Taker flow를 대체하지 않는다.',
]) requireText(strategyCatalog, token, 'AUTO_EXTERNAL_PILOT_SOURCE_CONTRACT_MISSING');
for (const token of [
  'evaluateStrategyRulePackDeterministicGate(gateInput)',
  'strategyRulePackAiEvidenceDigest(gateInput)',
  "'BACKGROUND_EXTERNAL_STRATEGY_RULE_PROOF_REQUIRED'",
  "'BACKGROUND_EXTERNAL_STRATEGY_AI_EVIDENCE_MISMATCH'",
  "liveEntryArmPresent(Date.now(), 'EXTERNAL_STRATEGY_PILOT')",
  'liveEnabledMarketConnectionVerificationReady(',
  'revalidateLiveEnabledMarketReadiness',
  'MEMBER_AUTO_TRADING_EXTERNAL_PILOT_HANDOFF_PATH',
  'validateExternalStrategyPilotHandoffEnvelope(',
  "if (this.externalPilotHandoffPath) return handoff.entries",
]) requireText(paperWorker, token, 'AUTO_EXTERNAL_PILOT_WORKER_BINDING_MISSING');
for (const token of [
  'external Pilot catalog is an explicit sourced allowlist and adopts no public performance claim',
  'external Pilot readiness is market-scoped and a blocked stock provider cannot poison Upbit',
  'ADMISSION_PATH:EXTERNAL_STRATEGY_PILOT',
]) requireText(formulaAiExceptionTest + paperWorkerTest, token, 'AUTO_EXTERNAL_PILOT_REGRESSION_MISSING');
requireText(liveEntryArm, 'requiredAdmissionPath?: LiveAutomaticAdmissionPath', 'AUTO_EXTERNAL_PILOT_SCOPED_ARM_MISSING');
requireText(liveExecution, "'ADMISSION_PATH:EXTERNAL_STRATEGY_PILOT'", 'AUTO_EXTERNAL_PILOT_PRESUBMIT_ARM_MISSING');
requireText(workflow, "admissionPaths: ['RESEARCH_GENUINE_S']", 'AUTO_RESEARCH_ARM_PATH_SCOPE_MISSING');
requireText(formulaAiExceptionTest, 'dedicated formula-ai pilot stage allows only a valid formula+AI live exception', 'AUTO_FORMULA_AI_PILOT_TEST_MISSING');
requireText(paperWorker, 'readRulePackPilotCapitalState', 'AUTO_PILOT_CAPITAL_WORKER_BINDING_MISSING');
requireText(paperWorker, 'evaluateRulePackPilotEntryGuard', 'AUTO_PILOT_ENTRY_GUARD_WORKER_MISSING');
requireText(pilotCapital, 'evaluateRulePackPilotEntryGuard', 'AUTO_PILOT_ENTRY_GUARD_MISSING');
for (const token of [
  'BACKGROUND_PILOT_ENTRY_LIMIT',
  'BACKGROUND_PILOT_DAILY_LOSS_COUNT_LIMIT',
  'BACKGROUND_PILOT_DAILY_LOSS_PERCENT_LIMIT',
  'BACKGROUND_PILOT_CONSECUTIVE_LOSS_LIMIT',
  'BACKGROUND_PILOT_CONCURRENT_POSITION_LIMIT',
  'BACKGROUND_PILOT_FRESH_SIGNAL_REQUIRED',
  'BACKGROUND_PILOT_LOSS_COOLDOWN_ACTIVE',
]) {
  requireText(pilotCapital, token, 'AUTO_PILOT_CAPITAL_BLOCKER_MISSING');
}
requireText(pilotCapitalTest, 'pilot capital starts at 500k and compounds only half of new high-water profit', 'AUTO_PILOT_50_50_TEST_MISSING');
requireText(pilotCapitalTest, 'administrator pilot starts at 1M and verified 50% compounding raises the next cap to 1.025M', 'AUTO_ADMIN_PILOT_1M_50_50_TEST_MISSING');
requireText(pilotCapitalTest, "dailyLosingTrades: 5", 'AUTO_PILOT_DAILY_LOSS_COUNT_TEST_MISSING');
requireText(pilotCapitalTest, "dailyRealizedPnlKrw: -15_000", 'AUTO_PILOT_DAILY_LOSS_PERCENT_TEST_MISSING');
requireText(pilotCapitalTest, "consecutiveLosses: 3", 'AUTO_PILOT_CONSECUTIVE_LOSS_TEST_MISSING');
requireText(pilotCapitalTest, "openLivePositions: 2", 'AUTO_PILOT_CONCURRENT_POSITION_TEST_MISSING');
requireText(autoTradingPage, "auth.can('canManageMembers')", 'AUTO_FORMULA_AI_PILOT_ADMIN_UI_CAPABILITY_MISSING');
requireText(autoTradingSettings, 'data-testid="formula-ai-pilot-control"', 'AUTO_FORMULA_AI_PILOT_UI_MISSING');
requireText(autoTradingSettings, "confirmation: 'ENABLE_FORMULA_AI_AUTOMATIC_LIVE_PILOT'", 'AUTO_FORMULA_AI_PILOT_UI_CONFIRMATION_MISSING');

requireText(tradeAutomationRoute, 'liveAutomaticReadinessByMarket', 'AUTO_STATUS_MARKET_READINESS_MISSING');
requireText(tradeAutomationRoute, "'MEMBER_ORDER_CAPABILITY_REQUIRED'", 'AUTO_STATUS_MEMBER_CAPABILITY_BLOCKER_MISSING');
requireText(tradeAutomationRoute, "'AUTOMATIC_POLICY_OFF'", 'AUTO_STATUS_POLICY_OFF_BLOCKER_MISSING');
requireText(tradeAutomationRoute, "'MEMBER_POLICY_STOPPED'", 'AUTO_STATUS_MEMBER_STOP_BLOCKER_MISSING');
requireText(tradeAutomationRoute, "'GLOBAL_EMERGENCY_STOP_ACTIVE'", 'AUTO_STATUS_GLOBAL_STOP_BLOCKER_MISSING');
requireText(tradeAutomationRoute, "'MARKET_AUTOMATIC_DISABLED'", 'AUTO_STATUS_MARKET_DISABLED_BLOCKER_MISSING');

requireText(deploy, 'LIVE_TRADING=false AUTO_TRADING=false REAL_ORDER_ENABLED=false PRIVATE_TRADING_API_ALLOWED=false MEMBER_AUTO_TRADING_BACKGROUND_ENABLED=false', 'DEPLOY_AUTO_RESET_MISSING');
requireText(deploy, 'MEMBER_AUTO_TRADING_BACKGROUND_ENABLED=false', 'DEPLOY_PAPER_AUTO_RESET_MISSING');
requireText(deploy, 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED=false', 'DEPLOY_LIVE_WORKER_RESET_MISSING');
requireText(deploy, 'MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED=false', 'DEPLOY_PAPER_ONLY_RESET_MISSING');
requireText(deploy, 'LIVE_AUTOMATIC_TRADING_ENABLED=false', 'DEPLOY_LIVE_AUTO_RESET_MISSING');
requireText(deploy, 'FUTURES_LIVE_EXECUTION_AUTHORITY=NONE', 'DEPLOY_FUTURES_RESET_MISSING');
requireText(deploy, 'CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED=false', 'DEPLOY_LEGACY_CRYPTO_RESET_MISSING');

for (const token of [
  "'CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED'",
  "'LIVE_TRADING'",
  "'AUTO_TRADING'",
  "'LIVE_AUTOMATIC_TRADING_ENABLED'",
  "'FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED'",
  "'BITGET_FUTURES_LIVE_ORDER_ENABLED'",
  "'MEMBER_AUTO_TRADING_BACKGROUND_ENABLED'",
  "'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED'",
  "String(process.env.FUTURES_LIVE_MARGIN_MODE ?? '') === 'isolated'",
  'requestedLeverage < 2 || requestedLeverage > 7',
  'const leverage = requestedLeverage',
  'const leverage = plan.leverage',
]) {
  requireText(legacyCryptoRoute, token, 'LEGACY_CRYPTO_FAIL_CLOSED_CONTRACT_DRIFT');
}
forbid(legacyCryptoRoute, /type PositionMode =[^\n]*hedge_mode/, 'LEGACY_CRYPTO_HEDGE_MODE_FORBIDDEN');
forbid(legacyCryptoRoute, /type MarginMode =[^\n]*crossed/, 'LEGACY_CRYPTO_CROSSED_MARGIN_FORBIDDEN');

console.log(JSON.stringify({
  ok: true,
  scope: 'ALL4',
  markets: ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'],
  providers: ['toss', 'kiwoom', 'upbit', 'bitget'],
  activationSubmitsOrder: false,
  oneAutomaticGate: true,
  accountQaRunsRequiredPerRelease: 1,
  disablePreservesSpotAndFuturesManualAuthority: true,
  paperBackgroundWorkerCoupled: false,
  liveBackgroundWorkerCoupled: true,
  liveEntryTwoPhaseArm: true,
  startupWarmupProofRequired: true,
  sameTickRiskRefreshRequired: true,
  manualAssetIsolationRequired: true,
  executionProjectionFailClosed: true,
  zeroMutationActivationRehearsal: true,
  postArmExactShaReadbackRequired: true,
  productionActivationStaysZeroOrder: true,
  delayedLiveArmActivation: true,
  controlledDisableRequiresZeroLivePositions: true,
  liveExitOrdersArmGuarded: true,
  liveMemberAndPolicyReadinessRequired: true,
  allFourMemberPolicyReadinessRequired: true,
  automaticMemberBatchFiltersBeforeLimit: true,
  boundedMemberBatchRotation: true,
  stableKeysetMemberRotation: true,
  rotationCycleReadinessPreserved: true,
  rotationFailureClearsPartialReadiness: true,
  activationWaitsForCompletedMemberReadinessCycle: true,
  globalEmergencyStopMustBeClear: true,
  telegramDeliveryHealthRequiredAfterRestart: false,
  optionalTelegramStatePreserved: true,
  liveEntryIndependentFromPaperWallet: true,
  activationWorkerHealthFreshnessRequired: true,
  manualGatesPreservePersonalTelegramDelivery: true,
  automaticRestartPreservesManualRuntime: true,
  automaticDisablePreservesManualRuntime: true,
  liveEntryArmWorkerUidReadable: true,
  runtimeBackedUiGateStatus: true,
  workerBackedUiLiveTruth: true,
  truthfulRuntimeStatusTones: true,
  uiRuntimeHealthFreshnessRequired: true,
  uiRuntimePollingFailsClosed: true,
  memberStatusSanitizesGlobalWorkerCounters: true,
  memberRuntimeHealthCapabilityGated: true,
  stickyStopDashboardTruth: true,
  marketScopedAutomaticReadiness: true,
  stickyMemberStopRequiresConfirmedResume: true,
  externalEmergencyStopReflectedInSettings: true,
  automaticExitClosedLoop: true,
  dailyProfitTargetUsesSettledNetProfit: true,
  dailyProfitTargetDoesNotExpandRisk: true,
  dailyProfitTargetStopsNewEntriesOnly: true,
  dailyProfitTargetMarketDayIsolated: true,
  dailyProfitTargetCompoundReserveSplit: '50/50',
  accountQaSchemaVersion: 'v3',
}));
