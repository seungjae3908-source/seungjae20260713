import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const workflow = read('.github/workflows/production-automatic-trading-gate.yml');
const manualSpotGate = read('.github/workflows/production-live-trading-gate.yml');
const manualFuturesGate = read('.github/workflows/production-futures-live-trading-gate.yml');
const tradeService = read('api-server/src/services/trade-automation.service.ts');
const paperWorker = read('api-server/src/services/member-auto-trading-background-worker.service.ts');
const deploy = read('ops/deploy-production.sh');

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
requireText(workflow, 'AUTOMATIC_TRADING_EXACT_PRODUCTION_DEPLOY_REQUIRED', 'AUTO_GATE_DEPLOY_PROVENANCE_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_EXACT_COMPREHENSIVE_QA_REQUIRED', 'AUTO_GATE_COMPREHENSIVE_QA_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_EXACT_ACCOUNT_QA_REQUIRED', 'AUTO_GATE_ACCOUNT_QA_MISSING');
requireText(workflow, 'production-account-readonly-live-', 'AUTO_GATE_ACCOUNT_ARTIFACT_MISSING');
requireText(workflow, "name.startsWith(workflowName + ' ' + target + ' ')", 'AUTO_GATE_DYNAMIC_ACCOUNT_QA_RUN_NAME_SUPPORT_MISSING');
requireText(workflow, 'reconciliationPassed', 'AUTO_GATE_RECONCILIATION_MISSING');
requireText(workflow, "production-account-readonly-live-qa-v2", 'AUTO_GATE_ACCOUNT_QA_SCHEMA_V2_MISSING');

requireText(workflow, "AUTO_TRADING: enabled ? 'true' : 'false'", 'AUTO_GATE_AUTO_TRUE_MISSING');
requireText(workflow, "LIVE_AUTOMATIC_TRADING_ENABLED: enabled ? 'true' : 'false'", 'AUTO_GATE_LIVE_AUTO_TRUE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_BACKGROUND_ENABLED: enabled ? 'true' : 'false'", 'AUTO_GATE_PAPER_WORKER_TRUE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: enabled ? 'true' : 'false'", 'AUTO_GATE_LIVE_WORKER_TRUE_MISSING');
requireText(workflow, "AUTO_TRADING: 'false'", 'AUTO_GATE_AUTO_DISABLE_MISSING');
requireText(workflow, "LIVE_AUTOMATIC_TRADING_ENABLED: 'false'", 'AUTO_GATE_LIVE_AUTO_DISABLE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_BACKGROUND_ENABLED: 'false'", 'AUTO_GATE_PAPER_WORKER_DISABLE_MISSING');
requireText(workflow, "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: 'false'", 'AUTO_GATE_LIVE_WORKER_DISABLE_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_ACTIVATION_FAILED_ROLLED_BACK', 'AUTO_GATE_ROLLBACK_RECEIPT_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_DISABLED_ALL4_MANUAL_LIVE_PRESERVED', 'AUTO_GATE_DISABLE_RECEIPT_MISSING');
requireText(workflow, 'REAL_ORDER_SUBMITTED=false', 'AUTO_GATE_NO_ORDER_RECEIPT_MISSING');

requireText(workflow, "manual.spotAuthority !== 'SPOT_LIVE_LIMITED'", 'AUTO_GATE_SPOT_AUTHORITY_RECHECK_MISSING');
requireText(workflow, "manual.futuresAuthority !== 'FUTURES_LIVE_LIMITED'", 'AUTO_GATE_FUTURES_AUTHORITY_RECHECK_MISSING');
requireText(workflow, "manual.futuresMarginMode !== 'isolated'", 'AUTO_GATE_ISOLATED_RECHECK_MISSING');
requireText(workflow, "expectedLeverage !== '3'", 'AUTO_GATE_3X_BOUND_MISSING');
requireText(workflow, 'AUTOMATIC_TRADING_ACCOUNT_READ_PROVIDERS_NOT_READY', 'AUTO_GATE_ACCOUNT_READ_RECHECK_MISSING');
for (const flag of [
  'TOSS_ACCOUNT_READ_ENABLED',
  'KIWOOM_ACCOUNT_READ_ENABLED',
  'UPBIT_ACCOUNT_READ_ENABLED',
  'BITGET_ACCOUNT_READ_ENABLED',
]) {
  requireText(workflow, flag, 'AUTO_GATE_ACCOUNT_READ_FLAG_MISSING');
}

forbid(workflow, /^\s{2}(workflow_dispatch|schedule):/m, 'AUTO_GATE_UNATTENDED_TRIGGER_FORBIDDEN');
forbid(workflow, /WITHDRAW[^\n]*true/i, 'AUTO_GATE_WITHDRAW_ENABLE_FORBIDDEN');
forbid(workflow, /TRANSFER[^\n]*true/i, 'AUTO_GATE_TRANSFER_ENABLE_FORBIDDEN');

requireText(manualSpotGate, "AUTO_TRADING: 'false'", 'MANUAL_SPOT_GATE_MUST_KEEP_AUTO_FALSE');
requireText(manualSpotGate, "LIVE_AUTOMATIC_TRADING_ENABLED: 'false'", 'MANUAL_SPOT_GATE_MUST_KEEP_LIVE_AUTO_FALSE');
requireText(manualSpotGate, "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: 'false'", 'MANUAL_SPOT_GATE_MUST_KEEP_LIVE_WORKER_FALSE');
requireText(manualSpotGate, "const allowed = new Set(['toss', 'kiwoom', 'upbit']);", 'MANUAL_SPOT_THREE_PROVIDER_SET_DRIFT');
requireText(manualSpotGate, 'name.startsWith(`${workflowName} ${target} `)', 'MANUAL_SPOT_DYNAMIC_ACCOUNT_QA_RUN_NAME_SUPPORT_MISSING');

requireText(manualFuturesGate, "FUTURES_LIVE_EXECUTION_AUTHORITY: 'FUTURES_LIVE_LIMITED'", 'MANUAL_FUTURES_AUTHORITY_MISSING');
requireText(manualFuturesGate, "FUTURES_LIVE_MARKET_ALLOWLIST: 'CRYPTO_FUTURES'", 'MANUAL_FUTURES_MARKET_MISSING');
requireText(manualFuturesGate, "FUTURES_LIVE_MARGIN_MODE: 'isolated'", 'MANUAL_FUTURES_ISOLATED_MISSING');
requireText(manualFuturesGate, 'AUTO_TRADING=false', 'MANUAL_FUTURES_GATE_MUST_KEEP_AUTO_FALSE');
requireText(manualFuturesGate, 'LIVE_AUTOMATIC_TRADING_ENABLED=false', 'MANUAL_FUTURES_GATE_MUST_KEEP_LIVE_AUTO_FALSE');
requireText(manualFuturesGate, 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED=false', 'MANUAL_FUTURES_GATE_MUST_KEEP_LIVE_WORKER_FALSE');
requireText(manualFuturesGate, 'run.name.startsWith(`${name} ${target} `)', 'MANUAL_FUTURES_DYNAMIC_ACCOUNT_QA_RUN_NAME_SUPPORT_MISSING');

const autoFn = tradeService.match(/export function automaticLiveExecutionEnabled[\s\S]*?\n}\n/);
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
  'liveBackgroundEnabled() && !deterministicGate.recognized',
]) {
  requireText(paperWorker, token, 'AUTO_GATE_PAPER_BACKGROUND_CONTRACT_DRIFT');
}

requireText(deploy, 'LIVE_TRADING=false AUTO_TRADING=false REAL_ORDER_ENABLED=false PRIVATE_TRADING_API_ALLOWED=false MEMBER_AUTO_TRADING_BACKGROUND_ENABLED=false', 'DEPLOY_AUTO_RESET_MISSING');
requireText(deploy, 'MEMBER_AUTO_TRADING_BACKGROUND_ENABLED=false', 'DEPLOY_PAPER_AUTO_RESET_MISSING');
requireText(deploy, 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED=false', 'DEPLOY_LIVE_WORKER_RESET_MISSING');
requireText(deploy, 'LIVE_AUTOMATIC_TRADING_ENABLED=false', 'DEPLOY_LIVE_AUTO_RESET_MISSING');
requireText(deploy, 'FUTURES_LIVE_EXECUTION_AUTHORITY=NONE', 'DEPLOY_FUTURES_RESET_MISSING');

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
  accountQaSchemaVersion: 'v2',
}));
