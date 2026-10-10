import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(file, 'utf8');
const requireAll = (file, markers) => {
  const source = read(file);
  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(`AUTOMATION_RESEARCH_PREFLIGHT_MARKER_MISSING:${file}:${marker}`);
    }
  }
  return source;
};

const types = requireAll('api-server/src/services/trade-automation.types.ts', [
  'PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW = 500_000',
  'PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW = 1_000_000',
  'PRODUCTION_MEMBER_DISCOVERY_MAX_SINGLE_ENTRY_KRW = 100_000',
  'PRODUCTION_ADMIN_DISCOVERY_MAX_SINGLE_ENTRY_KRW = 500_000',
  'PRODUCTION_MEMBER_MAX_BITGET_LEVERAGE = 3',
  'PRODUCTION_ADMIN_MAX_BITGET_LEVERAGE = 7',
  'dailyLossLimitPercent: 3',
  'maxDailyOrders: 0',
]);
const catalog = requireAll('api-server/src/services/evidence-backed-auto-strategy-catalog.service.ts', [
  "mode: 'PAPER_MIRROR_AUTOMATIC_LIVE_DISCOVERY'",
  'profitCompoundShare: 0.5',
  'dailyLossStopPercent: 3',
  'maxDailyLiveEntries: null',
  'liveOrderRequiresExplicitConfirmation: false',
  'automaticLiveExecutionAllowed: true',
]);
requireAll('api-server/src/services/trade-rule-pack-pilot-capital.service.ts', [
  'rulePackPilotDiscoveryEntryCap',
  'discoveryEntryCapRequired',
  'PRODUCTION_ADMIN_DISCOVERY_MAX_SINGLE_ENTRY_KRW',
  'PRODUCTION_MEMBER_DISCOVERY_MAX_SINGLE_ENTRY_KRW',
  'BACKGROUND_PILOT_DAILY_LOSS_PERCENT_LIMIT',
]);
requireAll('api-server/src/services/member-auto-trading-background-worker.service.ts', [
  "AUTOMATIC_PAPER_ACCOUNT_ID = 'automatic-paper-account-v2-1m'",
  "'automatic-paper-account-v1'",
  'AUTOMATIC_PAPER_INITIAL_KRW = 1_000_000 as const',
  'paperInput.estimatedKrw, nowMs, false',
  'paperInput.estimatedKrw, nowMs,',
  'deriveRulePackPilotExecutionPolicy(',
]);
requireAll('api-server/src/services/trade-automation-risk.service.ts', [
  'Number(input.maxDailyOrders) === 0',
  'policy.maxDailyOrders > 0',
  "plan.marginMode !== 'isolated'",
  "'BITGET_ISOLATED_MARGIN_REQUIRED'",
]);
requireAll('api-server/src/routes/trade-automation.ts', [
  'discoveryMaxOrderKrw: discoveryMaximumSingleEntryKrw(req)',
  'PRODUCTION_ORDER_LIMIT_CHANGE_REQUIRES_ALL_LIVE_GATES_OFF',
]);
requireAll('api-server/src/routes/paper-journal.ts', [
  'START_NEW_1M_PAPER_EPOCH_PRESERVE_HISTORY',
  'AUTOMATIC_PAPER_LEGACY_WALLET_IMMUTABLE',
]);
requireAll('stock-analyzer/src/components/trade-automation-settings.tsx', [
  'discoveryMaxOrderKrw',
  '일일 주문 수 (0=기회 기반)',
  '주문별 수동 승인 없이',
]);
requireAll('api-server/src/routes/user-broker-telegram.ts', [
  "orderAuthority: 'NONE' as const",
  'ordersSubmitted: 0',
  'ordersCancelled: 0',
]);
const productionDeploy = requireAll('.github/workflows/production-deploy.yml', [
  'Install exact-SHA QA dependencies before Production mutation',
  'Pre-deploy external readiness — providers, Paper, Telegram and zero authority',
  'playwright.production-automation-research-predeploy.config.ts',
  'production-automation-research-predeploy-${{ env.TARGET_SHA }}',
]);
requireAll('stock-analyzer/e2e/production-automation-research-predeploy-readiness.spec.ts', [
  'PRODUCTION_RUNTIME_IDENTITY_DRIFT',
  'TELEGRAM_DESTINATION_FORBIDDEN_RECONNECT_REQUIRED',
  'TELEGRAM_ZERO_TRADING_AUTHORITY_VIOLATION',
  'sshConfigured: false',
  'databaseMutations: 0',
  'deploymentExecuted: false',
  'policyMutations: 0',
  'telegramMessagesSent: 0',
]);
requireAll('.github/scripts/build-production-postdeploy-context.mjs', [
  'revalidateProductionTradingGateConflicts',
  'POSTDEPLOY_CONTEXT_ACTIVE_TRADING_GATE_CONFLICT',
]);
requireAll('api-server/src/index.ts', [
  "res.setHeader('Cache-Control', 'no-store, max-age=0')",
]);

if (catalog.includes('PAPER_MIRROR_MANUAL_LIVE_CONFIRM')
  || catalog.includes('liveOrderRequiresExplicitConfirmation: true')
  || catalog.includes('automaticLiveExecutionAllowed: false')) {
  throw new Error('AUTOMATION_RESEARCH_PREFLIGHT_STALE_MANUAL_LIVE_POLICY');
}
if (!types.includes('maxAssetPercent: 30')) {
  throw new Error('AUTOMATION_RESEARCH_PREFLIGHT_SINGLE_ASSET_BASELINE_MISSING');
}
const productionPreflight = productionDeploy.indexOf(
  'Pre-deploy external readiness — providers, Paper, Telegram and zero authority',
);
const productionSsh = productionDeploy.indexOf('- name: Configure SSH');
const productionDatabase = productionDeploy.indexOf(
  'Require canonical Production trade schema and journal privileges before application mutation',
);
const productionMutation = productionDeploy.indexOf('- name: Deploy exact approved revision');
if (!(productionPreflight > 0
  && productionSsh > productionPreflight
  && productionDatabase > productionSsh
  && productionMutation > productionDatabase)) {
  throw new Error('AUTOMATION_RESEARCH_PREFLIGHT_PRODUCTION_MUTATION_ORDER_INVALID');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  preflight: 'AUTOMATION_RESEARCH_RELEASE',
  liveDiscoveryOrderCapsKrw: { administrator: 500_000, member: 100_000 },
  liveRoleCeilingsKrw: { administrator: 1_000_000, member: 500_000 },
  automaticPaperInitialPerMarketKrw: 1_000_000,
  dailyLossLimitPercent: 3,
  ordinaryDailyEntryQuota: null,
  formulaAiPerOrderConfirmationRequired: false,
  telegramOrderAuthority: 'NONE',
  productionExternalReadinessBeforeMutation: true,
})}\n`);
