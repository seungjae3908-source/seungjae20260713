import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const workflow = read('.github/workflows/production-automatic-trading-gate.yml');
const preactivation = read('.github/scripts/production-preactivation-prerequisites.cjs');
const manualSpotGate = read('.github/workflows/production-live-trading-gate.yml');
const manualFuturesGate = read('.github/workflows/production-futures-live-trading-gate.yml');
const tradeService = read('api-server/src/services/trade-automation.service.ts');
const tradeAutomationRoute = read('api-server/src/routes/trade-automation.ts');
const paperWorker = read('api-server/src/services/member-auto-trading-background-worker.service.ts');
const paperWorkerTest = read('api-server/src/services/member-auto-trading-background-worker.service.test.ts');
const telegramWorker = read('api-server/src/features/user-broker-telegram/user-broker-telegram.worker.ts');
const apiIndex = read('api-server/src/index.ts');
const autoTradingPage = read('stock-analyzer/src/pages/auto-trading.tsx');
const autoTradingSettings = read('stock-analyzer/src/components/trade-automation-settings.tsx');
const tradeAutomationPolicyGuard = read('api-server/src/services/trade-automation-policy-guard.service.ts');
const tradeAutomationSmoke = read('api-server/src/routes/trade-automation.smoke.test.ts');
const tradeTypes = read('api-server/src/services/trade-automation.types.ts');
const tradeRisk = read('api-server/src/services/trade-automation-risk.service.ts');
const tradeOptimization = read('api-server/src/services/trade-automation-optimization.service.ts');
const formulaAiExceptionTest = read('api-server/src/services/formula-ai-live-exception.service.test.ts');
const formulaAiException = read('api-server/src/services/formula-ai-live-exception.service.ts');
const pilotCapitalTest = read('api-server/src/services/trade-rule-pack-pilot-capital.service.test.ts');
const pilotCapital = read('api-server/src/services/trade-rule-pack-pilot-capital.service.ts');
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
requireText(workflow, 'last?.userTelegramDelivery?.tickOk === true', 'AUTO_GATE_TELEGRAM_POST_RESTART_HEALTH_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_TELEGRAM_RUNTIME_NOT_ACTIVE', 'AUTO_GATE_TELEGRAM_PM2_FLAGS_MISSING');
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
requireText(workflow, "'telegram_delivery_worker_post_restart=HEALTHY'", 'AUTO_GATE_TELEGRAM_POST_RESTART_HUB_RECEIPT_MISSING');
requireText(workflow, "rmSync(liveEntryArmPath, { force: true });", 'AUTO_GATE_DISABLE_DISARM_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_DISABLE_OPEN_LIVE_POSITIONS', 'AUTO_GATE_DISABLE_OPEN_POSITION_BLOCK_MISSING');
requireText(workflow, 'autoHealth?.liveTrackedPositions', 'AUTO_GATE_DISABLE_POSITION_HEALTH_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_DISABLE_HEALTH_STALE_OR_INVALID', 'AUTO_GATE_DISABLE_HEALTH_FRESHNESS_MISSING');

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

forbid(paperWorker, /signalReasons\.filter\(\(reason\) => reason !== 'CANONICAL_PAPER_HANDOFF'\)/u, 'AUTO_GATE_PAPER_LINEAGE_REMOVAL_FORBIDDEN');
forbid(workflow, /^\s{2}(workflow_dispatch|schedule):/m, 'AUTO_GATE_UNATTENDED_TRIGGER_FORBIDDEN');
forbid(workflow, /if\s*\(false\)/u, 'AUTO_GATE_DEAD_VALIDATION_BLOCK_FORBIDDEN');
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
  "input.paperInput.signalReasons",
  "'CANONICAL_LIVE_AUTO_HANDOFF'",
  'readMarketMark',
  'paperExitOrders',
  'liveExitOrders',
  'liveTrackedPositions',
  'liveEntryWarmupComplete',
  'liveEntryArmPresent',
  'liveExitsSuppressedByWarmupOrArm',
  "if (!liveEntriesArmedThisTick || !hasCapability(member.profile, 'canPlaceOrders'))",
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
  ".contains('payload', { mode: 'automatic', automaticEnabled: true })",
  'private memberBatchCursor: string | null = null;',
  ".order('user_id', { ascending: true })",
  '.limit(MAX_MEMBERS_PER_TICK + 1)',
  "query = query.gt('user_id', this.memberBatchCursor)",
  'const hasMore = fetched.length > MAX_MEMBERS_PER_TICK;',
  'this.memberBatchCursor = hasMore && lastUserId ? lastUserId : null;',
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
requireText(paperWorker, 'activateNotBeforeMs >= armedAtMs', 'AUTO_GATE_WORKER_ARM_TIMESTAMP_ORDER_MISSING');
requireText(paperWorker, 'nowMs >= activateNotBeforeMs', 'AUTO_GATE_WORKER_ARM_NOT_BEFORE_ENFORCEMENT_MISSING');
requireText(paperWorker, '&& this.liveCycleAllFourPolicyReadySeen;', 'AUTO_GATE_WORKER_ALL4_WARMUP_FORMULA_MISSING');
requireText(apiIndex, 'autoTradingBackground: readMemberAutoTradingBackgroundRuntimeHealth()', 'AUTO_GATE_WORKER_HEALTH_ENDPOINT_MISSING');
requireText(apiIndex, 'userTelegramDelivery: readUserTelegramDeliveryWorkerHealth()', 'AUTO_GATE_TELEGRAM_WORKER_HEALTH_ENDPOINT_MISSING');
requireText(telegramWorker, 'export function readUserTelegramDeliveryWorkerHealth()', 'AUTO_GATE_TELEGRAM_WORKER_HEALTH_READER_MISSING');
requireText(telegramWorker, "tickOk: true", 'AUTO_GATE_TELEGRAM_WORKER_SUCCESS_HEALTH_MISSING');
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
requireText(tradeAutomationRoute, 'enforceMemberTradingPolicy(candidate, current)', 'AUTO_ROUTE_MEMBER_POLICY_GUARD_MISSING');
requireText(tradeAutomationRoute, 'MEMBER_TRADING_RESUME_REQUIRED', 'AUTO_ROUTE_MEMBER_STOP_BYPASS_BLOCK_MISSING');
requireText(tradeAutomationRoute, "router.post('/resume'", 'AUTO_ROUTE_MEMBER_RESUME_ENDPOINT_MISSING');
requireText(tradeAutomationRoute, "req.body?.confirmation !== 'RESUME_MEMBER_TRADING'", 'AUTO_ROUTE_MEMBER_RESUME_CONFIRMATION_MISSING');
requireText(tradeAutomationRoute, 'resumeMemberTradingPolicy(current)', 'AUTO_ROUTE_MEMBER_RESUME_POLICY_MISSING');
requireText(tradeAutomationPolicyGuard, 'Emergency/new-entry stops are sticky', 'AUTO_POLICY_STICKY_STOP_CONTRACT_MISSING');
requireText(tradeAutomationPolicyGuard, 'newEntriesStopped: false', 'AUTO_POLICY_CONFIRMED_RESUME_CLEAR_MISSING');
requireText(tradeAutomationSmoke, 'member emergency stop is sticky and only exact confirmed resume clears it without enabling automatic trading', 'AUTO_ROUTE_MEMBER_RESUME_SMOKE_MISSING');
requireText(tradeTypes, "'formula-ai-exception'", 'AUTO_FORMULA_AI_PILOT_STAGE_TYPE_MISSING');
requireText(tradeRisk, "input.pilotStage === 'formula-ai-exception'", 'AUTO_FORMULA_AI_PILOT_NORMALIZATION_MISSING');
requireText(tradeOptimization, "'PILOT_FORMULA_AI_EXCEPTION_REQUIRED'", 'AUTO_FORMULA_AI_PILOT_RISK_BINDING_MISSING');
requireText(tradeAutomationRoute, "router.post('/admin/pilot-stage'", 'AUTO_FORMULA_AI_PILOT_ROUTE_MISSING');
requireText(tradeAutomationRoute, "'ENABLE_FORMULA_AI_AUTOMATIC_LIVE_PILOT'", 'AUTO_FORMULA_AI_PILOT_CONFIRMATION_MISSING');
requireText(tradeAutomationRoute, "'FORMULA_AI_PILOT_CHANGE_REQUIRES_AUTO_OFF'", 'AUTO_FORMULA_AI_PILOT_AUTO_OFF_GUARD_MISSING');
requireText(tradeAutomationSmoke, 'formula-ai pilot stage requires admin, exact confirmation, and AUTO off without enabling trading', 'AUTO_FORMULA_AI_PILOT_SMOKE_MISSING');
requireText(formulaAiException, "'AI_REVIEW_DECISION:PASS'", 'AUTO_FORMULA_AI_PASS_EVIDENCE_MISSING');
requireText(formulaAiException, "'CANONICAL_PAPER_HANDOFF'", 'AUTO_FORMULA_AI_CANONICAL_HANDOFF_REQUIRED');
requireText(formulaAiExceptionTest, 'dedicated formula-ai pilot stage allows only a valid formula+AI live exception', 'AUTO_FORMULA_AI_PILOT_TEST_MISSING');
requireText(paperWorker, 'readRulePackPilotCapitalState', 'AUTO_PILOT_CAPITAL_WORKER_BINDING_MISSING');
requireText(paperWorker, 'evaluateRulePackPilotEntryGuard', 'AUTO_PILOT_ENTRY_GUARD_WORKER_MISSING');
requireText(pilotCapital, 'evaluateRulePackPilotEntryGuard', 'AUTO_PILOT_ENTRY_GUARD_MISSING');
for (const token of [
  'BACKGROUND_PILOT_ENTRY_LIMIT',
  'BACKGROUND_PILOT_DAILY_LOSS_COUNT_LIMIT',
  'BACKGROUND_PILOT_DAILY_LOSS_KRW_LIMIT',
  'BACKGROUND_PILOT_CONSECUTIVE_LOSS_LIMIT',
  'BACKGROUND_PILOT_CONCURRENT_POSITION_LIMIT',
  'BACKGROUND_PILOT_FRESH_SIGNAL_REQUIRED',
  'BACKGROUND_PILOT_LOSS_COOLDOWN_ACTIVE',
]) {
  requireText(pilotCapital, token, 'AUTO_PILOT_CAPITAL_BLOCKER_MISSING');
}
requireText(pilotCapitalTest, 'pilot capital starts at 500k and compounds only half of new high-water profit', 'AUTO_PILOT_50_50_TEST_MISSING');
requireText(pilotCapitalTest, "dailyLosingTrades: 5", 'AUTO_PILOT_DAILY_LOSS_COUNT_TEST_MISSING');
requireText(pilotCapitalTest, "dailyRealizedPnlKrw: -25_000", 'AUTO_PILOT_DAILY_LOSS_KRW_TEST_MISSING');
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
  telegramDeliveryHealthRequiredAfterRestart: true,
  manualGatesPreservePersonalTelegramDelivery: true,
  liveEntryArmWorkerUidReadable: true,
  runtimeBackedUiGateStatus: true,
  stickyStopDashboardTruth: true,
  marketScopedAutomaticReadiness: true,
  stickyMemberStopRequiresConfirmedResume: true,
  externalEmergencyStopReflectedInSettings: true,
  automaticExitClosedLoop: true,
  accountQaSchemaVersion: 'v3',
}));
