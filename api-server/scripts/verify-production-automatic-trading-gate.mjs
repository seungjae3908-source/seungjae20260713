import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const workflow = read('.github/workflows/production-automatic-trading-gate.yml');
const preactivation = read('.github/scripts/production-preactivation-prerequisites.cjs');
const manualSpotGate = read('.github/workflows/production-live-trading-gate.yml');
const manualFuturesGate = read('.github/workflows/production-futures-live-trading-gate.yml');
const tradeService = read('api-server/src/services/trade-automation.service.ts');
const paperWorker = read('api-server/src/services/member-auto-trading-background-worker.service.ts');
const paperWorkerTest = read('api-server/src/services/member-auto-trading-background-worker.service.test.ts');
const telegramWorker = read('api-server/src/features/user-broker-telegram/user-broker-telegram.worker.ts');
const apiIndex = read('api-server/src/index.ts');
const autoTradingPage = read('stock-analyzer/src/pages/auto-trading.tsx');
const autoTradingSettings = read('stock-analyzer/src/components/trade-automation-settings.tsx');
const legacyCryptoRoute = read('api-server/src/routes/crypto-auto.ts');
const deploy = read('ops/deploy-production.sh');
const paperReadiness = read('ops/verify-production-paper-forward-readiness.mjs');

const requireText = (source, token, code) => {
  if (!source.includes(token)) throw new Error(code + ':' + token);
};
const forbid = (source, pattern, code) => {
  if (pattern.test(source)) throw new Error(code + ':' + pattern);
};

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

requireText(workflow, 'providers: kiwoom,toss,upbit', 'AUTO_GATE_SPOT_RECEIPT_SET_MISSING');
requireText(workflow, '[PRODUCTION_FUTURES_LIVE_TRADING_GATE]', 'AUTO_GATE_FUTURES_RECEIPT_MISSING');
requireText(workflow, 'ACTIVATED_FUTURES_LIVE_LIMITED_MANUAL', 'AUTO_GATE_FUTURES_MANUAL_RECEIPT_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_EXACT_SPOT_MANUAL_RECEIPT_REQUIRED', 'AUTO_GATE_SPOT_MANUAL_GATE_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_EXACT_FUTURES_MANUAL_RECEIPT_REQUIRED', 'AUTO_GATE_FUTURES_MANUAL_GATE_MISSING');
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
requireText(workflow, 'reconciliationPassed', 'AUTO_GATE_RECONCILIATION_MISSING');
requireText(workflow, "production-account-readonly-live-qa-v3", 'AUTO_GATE_ACCOUNT_QA_SCHEMA_V3_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_EXACT_PAPER_FORWARD_RUNTIME_REQUIRED', 'AUTO_GATE_PAPER_RUNTIME_RECEIPT_MISSING');
requireText(workflow, 'paper-forward-no-deploy-', 'AUTO_GATE_PAPER_RUNTIME_ARTIFACT_MISSING');
requireText(workflow, '--activation-artifact', 'AUTO_GATE_PAPER_ACTIVATION_VERIFY_MISSING');
requireText(workflow, '--runtime-artifact', 'AUTO_GATE_PAPER_RUNTIME_VERIFY_MISSING');
requireText(workflow, 'validateMemberAutoTradingPaperHandoff', 'AUTO_GATE_CANONICAL_HANDOFF_VALIDATION_MISSING');
requireText(workflow, 'PAPER_FORWARD_LAST_INVOCATION_STALE', 'AUTO_GATE_PAPER_RUNTIME_FRESHNESS_MISSING');
requireText(workflow, "validated.status !== 'READY'", 'AUTO_GATE_PAPER_HANDOFF_READY_MISSING');
requireText(paperReadiness, 'production-paper-forward-runtime-readiness-v1', 'AUTO_GATE_PAPER_READINESS_SCHEMA_MISSING');
requireText(paperReadiness, 'RUNTIME_HANDOFF_CANONICAL_VALIDATION_MISSING', 'AUTO_GATE_PAPER_CANONICAL_EVIDENCE_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_EXACT_TELEGRAM_RELEASE_REQUIRED', 'AUTO_GATE_TELEGRAM_RELEASE_RECEIPT_MISSING');
requireText(workflow, 'telegram-production-runtime-verification-', 'AUTO_GATE_TELEGRAM_RUNTIME_ARTIFACT_MISSING');
requireText(workflow, 'ops/verify-production-telegram-runtime-readiness.mjs', 'AUTO_GATE_TELEGRAM_RUNTIME_VERIFIER_MISSING');
requireText(workflow, 'Require Telegram runtime, AUTO room, and zero-mutation ACTIVE_VERIFIED evidence', 'AUTO_GATE_TELEGRAM_AUTO_ROOM_PROOF_MISSING');
requireText(workflow, "auto-trading-live-entry-arm.json", 'AUTO_GATE_LIVE_ENTRY_ARM_PATH_MISSING');
requireText(workflow, 'disarmLiveEntries();', 'AUTO_GATE_PRE_WARMUP_DISARM_MISSING');
requireText(workflow, 'requireWorkerWarmup(after, { requireCurrentArm: false });', 'AUTO_GATE_WORKER_WARMUP_PROOF_MISSING');
requireText(workflow, 'armLiveEntries();', 'AUTO_GATE_POST_WARMUP_ARM_MISSING');
requireText(workflow, 'requireArmedEntries: true', 'AUTO_GATE_POST_ARM_SECOND_TICK_PROOF_MISSING');
requireText(workflow, 'health?.liveEntriesArmed === true', 'AUTO_GATE_LIVE_ENTRIES_ARMED_HEALTH_PROOF_MISSING');
requireText(workflow, 'Number(health?.liveOrderEligibleMembers ?? 0) > 0', 'AUTO_GATE_LIVE_ORDER_ELIGIBLE_MEMBER_PROOF_MISSING');
requireText(workflow, 'Number(health?.livePolicyReadyMembers ?? 0) > 0', 'AUTO_GATE_LIVE_POLICY_READY_MEMBER_PROOF_MISSING');
requireText(workflow, 'health?.globalEmergencyStopActive === false', 'AUTO_GATE_GLOBAL_STOP_PROOF_MISSING');
requireText(workflow, 'last?.userTelegramDelivery?.tickOk === true', 'AUTO_GATE_TELEGRAM_POST_RESTART_HEALTH_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_TELEGRAM_RUNTIME_NOT_ACTIVE', 'AUTO_GATE_TELEGRAM_PM2_FLAGS_MISSING');
requireText(workflow, 'FIRST_WARMUP_TICK_LIVE_ENTRIES_ARMED: false', 'AUTO_GATE_FIRST_TICK_ENTRY_BLOCK_PROOF_MISSING');
requireText(workflow, 'FIRST_WARMUP_TICK_LIVE_ORDERS: 0', 'AUTO_GATE_FIRST_TICK_ZERO_LIVE_ORDER_PROOF_MISSING');
requireText(workflow, 'LIVE_ENTRY_ARM_WRITTEN: true', 'AUTO_GATE_LIVE_ENTRY_ARM_RECEIPT_MISSING');
requireText(workflow, 'QA_SCOPE: ${{ steps.gate.outputs.qa_scope }}', 'AUTO_GATE_QA_SCOPE_RECEIPT_ENV_MISSING');
requireText(workflow, "'worker_warmup_proven=true'", 'AUTO_GATE_WARMUP_HUB_RECEIPT_MISSING');
requireText(workflow, "'first_warmup_tick_live_entries_armed=false'", 'AUTO_GATE_FIRST_TICK_ARM_HUB_RECEIPT_MISSING');
requireText(workflow, "'first_warmup_tick_live_orders=0'", 'AUTO_GATE_FIRST_TICK_ORDER_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_entry_arm_written=true'", 'AUTO_GATE_ARM_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_entries_armed_proven=true'", 'AUTO_GATE_ARMED_HUB_RECEIPT_MISSING');
requireText(workflow, "'live_order_eligible_member_count=>=1'", 'AUTO_GATE_MEMBER_READY_HUB_RECEIPT_MISSING');
requireText(workflow, "'global_emergency_stop=false'", 'AUTO_GATE_GLOBAL_STOP_HUB_RECEIPT_MISSING');
requireText(workflow, "'telegram_delivery_worker_post_restart=HEALTHY'", 'AUTO_GATE_TELEGRAM_POST_RESTART_HUB_RECEIPT_MISSING');
requireText(workflow, "rmSync(liveEntryArmPath, { force: true });", 'AUTO_GATE_DISABLE_DISARM_MISSING');

requireText(workflow, "AUTO_TRADING: enabled ? 'true' : 'false'", 'AUTO_GATE_AUTO_TRUE_MISSING');
requireText(workflow, "LIVE_AUTOMATIC_TRADING_ENABLED: enabled ? 'true' : 'false'", 'AUTO_GATE_LIVE_AUTO_TRUE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_BACKGROUND_ENABLED: enabled ? 'true' : 'false'", 'AUTO_GATE_PAPER_WORKER_TRUE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: enabled ? 'true' : 'false'", 'AUTO_GATE_LIVE_WORKER_TRUE_MISSING');
requireText(workflow, "AUTO_TRADING: 'false'", 'AUTO_GATE_AUTO_DISABLE_MISSING');
requireText(workflow, "LIVE_AUTOMATIC_TRADING_ENABLED: 'false'", 'AUTO_GATE_LIVE_AUTO_DISABLE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_BACKGROUND_ENABLED: 'false'", 'AUTO_GATE_PAPER_WORKER_DISABLE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: 'false'", 'AUTO_GATE_LIVE_WORKER_DISABLE_MISSING');
requireText(workflow, "CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED: 'false'", 'AUTO_GATE_LEGACY_CRYPTO_ROUTE_NOT_DISABLED');
requireText(workflow, 'AUTOMATIC_TRADING_ACTIVATION_FAILED_ROLLED_BACK', 'AUTO_GATE_ROLLBACK_RECEIPT_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_DISABLED_ALL4_MANUAL_LIVE_PRESERVED', 'AUTO_GATE_DISABLE_RECEIPT_MISSING');
requireText(workflow, 'REAL_ORDER_SUBMITTED=false', 'AUTO_GATE_NO_ORDER_RECEIPT_MISSING');

requireText(workflow, "manual.spotAuthority !== 'SPOT_LIVE_LIMITED'", 'AUTO_GATE_SPOT_AUTHORITY_RECHECK_MISSING');
requireText(workflow, "manual.futuresAuthority !== 'FUTURES_LIVE_LIMITED'", 'AUTO_GATE_FUTURES_AUTHORITY_RECHECK_MISSING');
requireText(workflow, "manual.futuresMarginMode !== 'isolated'", 'AUTO_GATE_ISOLATED_RECHECK_MISSING');
requireText(workflow, "['2', '3', '4', '5', '6', '7'].includes(expectedLeverage)", 'AUTO_GATE_LEVERAGE_BOUND_MISSING');

forbid(workflow, /^\s{2}(workflow_dispatch|schedule):/m, 'AUTO_GATE_UNATTENDED_TRIGGER_FORBIDDEN');
forbid(workflow, /if\s*\(false\)/u, 'AUTO_GATE_DEAD_VALIDATION_BLOCK_FORBIDDEN');
forbid(workflow, /WITHDRAW[^\n]*true/i, 'AUTO_GATE_WITHDRAW_ENABLE_FORBIDDEN');
forbid(workflow, /TRANSFER[^\n]*true/i, 'AUTO_GATE_TRANSFER_ENABLE_FORBIDDEN');

requireText(manualSpotGate, "AUTO_TRADING: 'false'", 'MANUAL_SPOT_GATE_MUST_KEEP_AUTO_FALSE');
requireText(manualSpotGate, "LIVE_AUTOMATIC_TRADING_ENABLED: 'false'", 'MANUAL_SPOT_GATE_MUST_KEEP_LIVE_AUTO_FALSE');
requireText(manualSpotGate, "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: 'false'", 'MANUAL_SPOT_GATE_MUST_KEEP_LIVE_WORKER_FALSE');
requireText(manualSpotGate, "CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED: 'false'", 'MANUAL_SPOT_LEGACY_CRYPTO_ROUTE_NOT_DISABLED');
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
requireText(manualFuturesGate, 'run.name.startsWith(`${name} ${target} `)', 'MANUAL_FUTURES_DYNAMIC_ACCOUNT_QA_RUN_NAME_SUPPORT_MISSING');
requireText(manualFuturesGate, 'merge-multiple: true', 'MANUAL_FUTURES_PREACTIVATION_ARTIFACTS_NOT_MERGED');

const autoFn = tradeService.match(/export function automaticLiveExecutionEnabled[\s\S]*?\r?\n}\r?\n/);
if (!autoFn) throw new Error('AUTOMATIC_LIVE_EXECUTION_FUNCTION_MISSING');
for (const token of [
  "process.env.AUTO_TRADING === 'true'",
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
  "process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED !== 'true'",
  "process.env.MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED === 'true'",
  'buildAutomaticExitPlanInput',
  'readMarketMark',
  'paperExitOrders',
  'liveExitOrders',
  'liveEntryWarmupComplete',
  'liveEntryArmPresent',
  'executionSyncBlocks',
  'executionSyncMissingReferences',
  'if (synced.missingReferences > 0)',
  'newEntriesFailClosed',
  'runtimeRefreshes',
  'overlapSkipped',
  'liveOrderEligibleMembers',
  'livePolicyReadyMembers',
  'globalEmergencyStopActive',
  'automaticPolicyHasRunnableMarket',
  'const refreshRuntime = async () =>',
  'Always re-read canonical exposure at the entry boundary',
  'let entryProjectionHealthy = await syncExecutionProjection();',
  'if (!entryProjectionHealthy) {',
  'await refreshRuntime();',
  'if (liveEntriesArmedThisTick && hasCapability',
  "member-auto-trading-live-entry-arm-v1",
]) {
  requireText(paperWorker, token, 'AUTO_GATE_PAPER_BACKGROUND_CONTRACT_DRIFT');
}
requireText(apiIndex, 'autoTradingBackground: readMemberAutoTradingBackgroundRuntimeHealth()', 'AUTO_GATE_WORKER_HEALTH_ENDPOINT_MISSING');
requireText(apiIndex, 'userTelegramDelivery: readUserTelegramDeliveryWorkerHealth()', 'AUTO_GATE_TELEGRAM_WORKER_HEALTH_ENDPOINT_MISSING');
requireText(telegramWorker, 'export function readUserTelegramDeliveryWorkerHealth()', 'AUTO_GATE_TELEGRAM_WORKER_HEALTH_READER_MISSING');
requireText(telegramWorker, "tickOk: true", 'AUTO_GATE_TELEGRAM_WORKER_SUCCESS_HEALTH_MISSING');
requireText(paperWorkerTest, 'zero-mutation activation rehearsal transitions warmup to exact-SHA arm with no provider request or live order', 'AUTO_GATE_ZERO_MUTATION_ACTIVATION_REHEARSAL_MISSING');
requireText(paperWorkerTest, 'assert.equal(armed.liveEntriesArmed, true);', 'AUTO_GATE_ACTIVATION_REHEARSAL_ARM_PROOF_MISSING');
requireText(paperWorkerTest, 'assert.equal(armed.liveOrders, 0);', 'AUTO_GATE_ACTIVATION_REHEARSAL_ZERO_ORDER_PROOF_MISSING');
requireText(paperWorkerTest, 'assert.equal(armed.privateTradingRequests, 0);', 'AUTO_GATE_ACTIVATION_REHEARSAL_ZERO_PROVIDER_MUTATION_PROOF_MISSING');
requireText(paperWorkerTest, 'live activation warmup stays fail-closed when no member can place real orders', 'AUTO_GATE_NO_LIVE_MEMBER_FAIL_CLOSED_TEST_MISSING');
requireText(paperWorkerTest, 'assert.equal(result.liveOrderEligibleMembers, 0);', 'AUTO_GATE_NO_LIVE_MEMBER_ASSERTION_MISSING');

requireText(autoTradingPage, 'readyForAutomaticOrderEvaluation', 'AUTO_UI_RUNTIME_READINESS_MISSING');
requireText(autoTradingPage, 'automaticServerGateEnabled', 'AUTO_UI_AUTOMATIC_GATE_STATE_MISSING');
forbid(autoTradingPage, /value="서버 Gate 필요"/u, 'AUTO_UI_HARDCODED_SERVER_GATE_FORBIDDEN');
requireText(autoTradingSettings, 'liveAutomaticExecutionServerEnabled', 'AUTO_SETTINGS_LIVE_AUTO_GATE_MISSING');
requireText(autoTradingSettings, 'readyForAutomaticOrderEvaluation', 'AUTO_SETTINGS_RUNTIME_READINESS_MISSING');

requireText(deploy, 'LIVE_TRADING=false AUTO_TRADING=false REAL_ORDER_ENABLED=false PRIVATE_TRADING_API_ALLOWED=false MEMBER_AUTO_TRADING_BACKGROUND_ENABLED=false', 'DEPLOY_AUTO_RESET_MISSING');
requireText(deploy, 'MEMBER_AUTO_TRADING_BACKGROUND_ENABLED=false', 'DEPLOY_PAPER_AUTO_RESET_MISSING');
requireText(deploy, 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED=false', 'DEPLOY_LIVE_WORKER_RESET_MISSING');
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
  paperBackgroundWorkerCoupled: true,
  liveBackgroundWorkerCoupled: true,
  liveEntryTwoPhaseArm: true,
  startupWarmupProofRequired: true,
  sameTickRiskRefreshRequired: true,
  executionProjectionFailClosed: true,
  zeroMutationActivationRehearsal: true,
  postArmSecondTickProofRequired: true,
  liveMemberAndPolicyReadinessRequired: true,
  globalEmergencyStopMustBeClear: true,
  telegramDeliveryHealthRequiredAfterRestart: true,
  runtimeBackedUiGateStatus: true,
  automaticExitClosedLoop: true,
  accountQaSchemaVersion: 'v3',
}));
