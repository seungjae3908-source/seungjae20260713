import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const requireText = (source, value, code) => {
  if (!source.includes(value)) throw new Error(code);
};
const forbidText = (source, value, code) => {
  if (source.includes(value)) throw new Error(code);
};
const requireOrder = (source, values, code) => {
  let offset = -1;
  for (const value of values) {
    const next = source.indexOf(value, offset + 1);
    if (next < 0 || next <= offset) throw new Error(`${code}:${value}`);
    offset = next;
  }
};

const deploy = read('.github/workflows/production-deploy.yml');
const command = read('.github/workflows/production-postdeploy-qa.yml');
const comprehensive = read('.github/workflows/production-comprehensive-readonly-qa.yml');
const account = read('.github/workflows/production-account-readonly-live-qa.yml');
const credential = read('.github/workflows/production-live-credential-reuse-qa.yml');
const runner = read('.github/scripts/run-production-readonly-qa.sh');
const contextBuilder = read('.github/scripts/build-production-postdeploy-context.mjs');
const evidenceBuilder = read('.github/scripts/production-postdeploy-qa-evidence.cjs');
const releaseOrchestrator = read('.github/scripts/production-release-orchestrator.cjs');
const app = read('stock-analyzer/src/App.tsx');
const recommendations = read('stock-analyzer/src/pages/recommendations.tsx');
const stocks = read('stock-analyzer/src/pages/stocks.tsx');
const recommendationService = read('api-server/src/services/recommendation.service.ts');
const recommendationDeadline = read('api-server/src/services/recommendation-deadline.ts');
const productionQaSpec = read('stock-analyzer/e2e/production-comprehensive-readonly-qa.spec.ts');
const deployScript = read('ops/deploy-production.sh');

requireText(deploy, 'environment: production', 'PRODUCTION_DEPLOY_PROTECTION_REMOVED');
for (const workflow of [
  '.github/workflows/production-live-trading-gate.yml',
  '.github/workflows/production-futures-live-trading-gate.yml',
  '.github/workflows/production-automatic-trading-gate.yml',
]) {
  requireText(read(workflow), 'environment: production', `LIVE_ACTIVATION_PROTECTION_REMOVED:${workflow}`);
}

forbidText(deploy, 'AGENT_HUB_GITHUB_TOKEN', 'PRODUCTION_DEPLOY_ADMIN_TOKEN_FORBIDDEN');
forbidText(deploy, 'gh api --method PUT', 'PRODUCTION_DEPLOY_ENVIRONMENT_MUTATION_FORBIDDEN');
forbidText(deploy, 'gh secret set', 'PRODUCTION_DEPLOY_SECRET_MUTATION_FORBIDDEN');
forbidText(deploy, 'environment: production-readonly-qa', 'RUNTIME_QA_ENVIRONMENT_PROVISION_FORBIDDEN');
const deployJob = deploy.split('\n  deploy:\n')[1] ?? '';
const deployJobHeader = deployJob.split('\n    steps:\n')[0] ?? '';
for (const value of ['PROD_SSH_', 'PROD_DATABASE_URL', 'SSH_PRIVATE_KEY']) {
  forbidText(deployJobHeader, value, `DEPLOY_AUTHORITY_MUST_NOT_BE_JOB_GLOBAL:${value}`);
}
requireOrder(deploy, [
  '- name: Deploy exact approved revision',
  '- name: Destroy deployment authority before read-only QA',
  '- name: Pre-QA identity, authority, and gate-conflict check',
  '- name: 1 · Comprehensive Production read-only QA',
  '- name: 2 · Four-provider Account Production read-only QA',
  '- name: 3 · Production Credential Reuse QA',
  '- name: Final exact-SHA identity, safety, and gate-conflict check',
  '- name: Assemble exact-run post-deploy evidence',
  '- name: Upload immutable ACTIVATION_READY evidence',
], 'PRODUCTION_INLINE_QA_ORDER_INVALID');
requireText(deploy, 'timeout-minutes: 150', 'PRODUCTION_INLINE_QA_TIMEOUT_NOT_EXTENDED');
requireText(deploy, 'postdeploy-evidence/production-postdeploy-context.json', 'PRODUCTION_INLINE_CONTEXT_MISSING');
requireText(deploy, 'production-postdeploy-activation-ready-', 'PRODUCTION_ACTIVATION_READY_ARTIFACT_MISSING');

const qaTail = deployJob.split('- name: Destroy deployment authority before read-only QA')[1] ?? '';
for (const value of ['PROD_SSH_', 'PROD_DATABASE_URL', 'AGENT_HUB_GITHUB_TOKEN']) {
  forbidText(qaTail, value, `INLINE_QA_DEPLOY_AUTHORITY_FORBIDDEN:${value}`);
}
for (const mode of ['comprehensive', 'account', 'credential']) {
  requireText(qaTail, `run-production-readonly-qa.sh ${mode}`, `INLINE_QA_SHARED_RUNNER_MISSING:${mode}`);
}

const liveJobs = {
  comprehensive: comprehensive.split('\n  production-comprehensive-readonly:\n')[1] ?? '',
  account: account.split('\n  production-account-readonly-live-qa:\n')[1] ?? '',
  credential: credential.split('\n  production-qa:\n')[1] ?? '',
};
for (const [name, workflow] of Object.entries({ comprehensive, account, credential })) {
  const liveJob = liveJobs[name];
  requireText(workflow, 'workflow_call:', `${name.toUpperCase()}_REUSABLE_CALL_MISSING`);
  requireText(liveJob, 'environment: production', `${name.toUpperCase()}_PROTECTED_STANDALONE_CREDENTIAL_SOURCE_MISSING`);
  requireText(liveJob, `run-production-readonly-qa.sh ${name}`, `${name.toUpperCase()}_SHARED_RUNNER_MISSING`);
  forbidText(liveJob, 'PROD_SSH_PRIVATE_KEY', `${name.toUpperCase()}_SSH_AUTHORITY_FORBIDDEN`);
  forbidText(liveJob, 'PROD_DATABASE_URL', `${name.toUpperCase()}_DATABASE_AUTHORITY_FORBIDDEN`);
}

requireText(command, '/run-production-postdeploy-qa <40-char-sha>', 'POSTDEPLOY_OWNER_COMMAND_MISSING');
requireText(command, '/run-production-trading-core-release <40-char-sha>', 'TRADING_CORE_OWNER_COMMAND_MISSING');
requireText(command, '/run-staging-trading-core <40-char-sha>', 'TRADING_CORE_STAGING_COMMAND_MISSING');
requireText(command, "workflow_id: 'staging-readiness.yml'", 'TRADING_CORE_STAGING_DISPATCH_MISSING');
requireText(command, "run_full_validation: 'true'", 'TRADING_CORE_STAGING_FULL_VALIDATION_MISSING');
requireText(command, 'cancel-in-progress: false', 'ONE_COMMAND_RELEASE_MUST_NOT_BE_CANCELLED');
requireText(command, 'selectReusableExactStagingRun', 'ONE_COMMAND_RELEASE_STAGING_REUSE_MISSING');
requireText(command, 'await waitForRun(stagingRun.id', 'ONE_COMMAND_RELEASE_STAGING_WAIT_MISSING');
requireText(command, 'STAGING_RELEASE_FAILED:', 'ONE_COMMAND_RELEASE_STAGING_FAILURE_MISSING');
requireText(releaseOrchestrator, 'async function retryGithubRead', 'ONE_COMMAND_RELEASE_READ_RETRY_MISSING');
requireText(releaseOrchestrator, 'GITHUB_READ_RETRY_EXHAUSTED:', 'ONE_COMMAND_RELEASE_READ_RETRY_DIAGNOSTIC_MISSING');
requireText(command, 'retryGithubRead,', 'ONE_COMMAND_RELEASE_READ_RETRY_NOT_IMPORTED');
for (const label of [
  'current-main-initial',
  'current-main-recheck',
  'list-staging-runs',
  'list-staging-artifacts',
  'get-workflow-run',
  'list-production-runs',
]) {
  requireText(command, `readOptions('${label}')`, `ONE_COMMAND_RELEASE_READ_RETRY_CALL_MISSING:${label}`);
}
requireText(command, 'MUTATING_GITHUB_CALLS_ARE_NEVER_RETRIED', 'ONE_COMMAND_RELEASE_MUTATION_RETRY_BOUNDARY_MISSING');
requireOrder(command, [
  "workflow_id: 'staging-readiness.yml'",
  'await requireStagingArtifact(stagingRun)',
  "workflow_id: 'production-deploy.yml'",
], 'ONE_COMMAND_RELEASE_SEQUENCE_INVALID');
requireText(releaseOrchestrator, 'artifact.name === expectedName', 'ONE_COMMAND_RELEASE_EXACT_ARTIFACT_MISSING');
requireText(releaseOrchestrator, "run.head_branch === 'main'", 'ONE_COMMAND_RELEASE_MAIN_BRANCH_MISSING');
requireText(command, "qa_scope: qaScope", 'TRADING_CORE_OWNER_COMMAND_SCOPE_MISSING');
requireText(deploy, 'qa_scope:', 'PRODUCTION_QA_SCOPE_INPUT_MISSING');
requireText(deploy, "inputs.qa_scope == 'trading_core'", 'TRADING_CORE_INLINE_QA_CONDITION_MISSING');
requireText(deploy, '1T · Prepare safe member ALL4 policy and run Focused Trading Core Production QA', 'TRADING_CORE_INLINE_QA_STEP_MISSING');
requireText(deploy, "PRODUCTION_TRADING_CORE_PREPARE_POLICY: 'true'", 'TRADING_CORE_MEMBER_POLICY_PREPARATION_MISSING');
requireOrder(deploy, [
  '- name: 2 · Four-provider Account Production read-only QA',
  '- name: 3 · Production Credential Reuse QA',
  '- name: 1T · Prepare safe member ALL4 policy and run Focused Trading Core Production QA',
  '- name: Final exact-SHA identity, safety, and gate-conflict check',
], 'TRADING_CORE_PROVIDER_FIRST_QA_ORDER_INVALID');
requireText(command, "workflow_id: 'production-deploy.yml'", 'POSTDEPLOY_COMMAND_MUST_DISPATCH_PRODUCTION_CHAIN');
requireText(command, 'createWorkflowDispatch', 'POSTDEPLOY_COMMAND_DISPATCH_MISSING');
forbidText(command, 'uses: ./.github/workflows/production-comprehensive-readonly-qa.yml', 'POSTDEPLOY_COMMAND_SEPARATE_QA_JOB_FORBIDDEN');
forbidText(command, 'secrets: inherit', 'POSTDEPLOY_REPOSITORY_SECRET_INHERITANCE_FORBIDDEN');

for (const authority of [
  'PROD_DATABASE_URL', 'PROD_SSH_PRIVATE_KEY', 'TOSS_CLIENT_SECRET', 'UPBIT_SECRET_KEY', 'BITGET_SECRET_KEY', 'KIWOOM_APP_SECRET',
]) {
  requireText(runner, authority, `SHARED_RUNNER_AUTHORITY_GUARD_MISSING:${authority}`);
}
for (const flag of [
  'AUTO_TRADING', 'LIVE_AUTOMATIC_TRADING_ENABLED',
  'MEMBER_AUTO_TRADING_BACKGROUND_ENABLED', 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
]) {
  requireText(runner, flag, `SHARED_RUNNER_LIVE_FLAG_GUARD_MISSING:${flag}`);
}
requireText(contextBuilder, 'activeConflictingTradingGates: conflicts', 'POSTDEPLOY_GATE_CONFLICT_CONTEXT_MISSING');
requireText(contextBuilder, "mode === 'inline'", 'INLINE_DEPLOY_CONTEXT_MODE_MISSING');
requireText(evidenceBuilder, "deploymentVerificationMode === 'inline-approved-job'", 'INLINE_DEPLOY_EVIDENCE_MODE_MISSING');
requireText(evidenceBuilder, 'requireZeroAuthority', 'POSTDEPLOY_ZERO_AUTHORITY_EVIDENCE_MISSING');
for (const flag of [
  'MEMBER_AUTO_TRADING_BACKGROUND_ENABLED',
  'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
  'FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED',
  'BITGET_FUTURES_LIVE_ORDER_ENABLED',
]) {
  requireText(deployScript, `bool("${flag}")`, `PRODUCTION_PM2_POST_RESTART_FLAG_ASSERTION_MISSING:${flag}`);
}

requireText(app, "import RecommendationsPage from '@/pages/recommendations';", 'RECOMMENDATIONS_EAGER_ROUTE_IMPORT_REQUIRED');
forbidText(app, "lazy(() => import('@/pages/recommendations'))", 'RECOMMENDATIONS_LAZY_ROUTE_FALLBACK_FORBIDDEN');
requireText(recommendations, 'queryKey: recommendationQueryKey(market)', 'RECOMMENDATIONS_SHARED_QUERY_KEY_MISSING');
requireText(stocks, 'queryKey: recommendationQueryKey(mode.stockMarket)', 'STOCKS_SHARED_RECOMMENDATION_QUERY_KEY_MISSING');
requireText(recommendationDeadline, 'RECOMMENDATION_ANALYSIS_BUDGET_MS = 3_200', 'RECOMMENDATION_COLD_PROVIDER_BUDGET_MISSING');
requireText(recommendationService, "'provider_timeout'", 'RECOMMENDATION_PROVIDER_TIMEOUT_EVIDENCE_MISSING');
forbidText(recommendationService, 'FinancialService.getFinancials', 'RECOMMENDATION_DUPLICATE_FINANCIAL_FETCH_FORBIDDEN');
requireText(productionQaSpec, 'timeout: 5_000', 'PRODUCTION_ROUTE_FALLBACK_BUDGET_WAS_WEAKENED');
requireText(productionQaSpec, "'route fallback exceeded 5s'", 'PRODUCTION_ROUTE_FALLBACK_ASSERTION_MISSING');

console.log(JSON.stringify({
  ok: true,
  productionProtectionPreserved: true,
  liveActivationProtectionPreserved: true,
  inlinePostdeployQaInApprovedJob: true,
  runtimeEnvironmentAndSecretMutationRemoved: true,
  ownerCommand: '/run-production-postdeploy-qa <40-char-sha>',
  tradingCoreOwnerCommand: '/run-production-trading-core-release <40-char-sha>',
  tradingCoreStagingCommand: '/run-staging-trading-core <40-char-sha>',
  recommendationsFallbackBudgetMs: 5000,
}));
