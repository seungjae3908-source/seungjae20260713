import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const workflow = read('.github/workflows/production-automatic-trading-gate.yml');
const preactivation = read('.github/scripts/production-preactivation-prerequisites.cjs');
const manualSpotGate = read('.github/workflows/production-live-trading-gate.yml');
const manualFuturesGate = read('.github/workflows/production-futures-live-trading-gate.yml');
const tradeService = read('api-server/src/services/trade-automation.service.ts');
const paperWorker = read('api-server/src/services/member-auto-trading-background-worker.service.ts');
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
requireText(workflow, 'telegram-production-active-verification-', 'AUTO_GATE_TELEGRAM_ACTIVE_ARTIFACT_MISSING');
requireText(workflow, 'ops/verify-production-telegram-active-readiness.mjs', 'AUTO_GATE_MEMBER_TELEGRAM_VERIFIER_MISSING');

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
]) {
  requireText(paperWorker, token, 'AUTO_GATE_PAPER_BACKGROUND_CONTRACT_DRIFT');
}

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
  automaticExitClosedLoop: true,
  accountQaSchemaVersion: 'v3',
}));
