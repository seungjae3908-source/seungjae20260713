import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const requireText = (source, value, code) => {
  if (!source.includes(value)) throw new Error(code);
};
const forbidText = (source, value, code) => {
  if (source.includes(value)) throw new Error(code);
};

const deploy = read('.github/workflows/production-deploy.yml');
const orchestrator = read('.github/workflows/production-postdeploy-qa.yml');
const comprehensive = read('.github/workflows/production-comprehensive-readonly-qa.yml');
const account = read('.github/workflows/production-account-readonly-live-qa.yml');
const credential = read('.github/workflows/production-live-credential-reuse-qa.yml');
const app = read('stock-analyzer/src/App.tsx');
const recommendations = read('stock-analyzer/src/pages/recommendations.tsx');
const stocks = read('stock-analyzer/src/pages/stocks.tsx');
const recommendationService = read('api-server/src/services/recommendation.service.ts');
const recommendationDeadline = read('api-server/src/services/recommendation-deadline.ts');
const productionQaSpec = read('stock-analyzer/e2e/production-comprehensive-readonly-qa.spec.ts');

requireText(deploy, 'environment: production', 'PRODUCTION_DEPLOY_PROTECTION_REMOVED');
for (const workflow of [
  '.github/workflows/production-live-trading-gate.yml',
  '.github/workflows/production-futures-live-trading-gate.yml',
  '.github/workflows/production-automatic-trading-gate.yml',
]) {
  requireText(read(workflow), 'environment: production', `LIVE_ACTIVATION_PROTECTION_REMOVED:${workflow}`);
}

const provision = deploy.split('      - name: Provision isolated approval-free read-only QA credential scope\n')[1]
  ?.split('\n      - name: Configure SSH\n')[0] ?? '';
requireText(provision, 'production-readonly-qa', 'READONLY_QA_ENVIRONMENT_PROVISION_MISSING');
requireText(provision, 'protection_rules | length', 'READONLY_QA_REVIEWER_ASSERTION_MISSING');
requireText(provision, 'PRODUCTION_QA_LOGIN,PRODUCTION_QA_PASSWORD', 'READONLY_QA_SECRET_ALLOWLIST_MISSING');
forbidText(provision, 'PROD_SSH_PRIVATE_KEY', 'READONLY_QA_SSH_SECRET_COPY_FORBIDDEN');
forbidText(provision, 'PROD_DATABASE_URL', 'READONLY_QA_DATABASE_SECRET_COPY_FORBIDDEN');
forbidText(provision, 'BITGET_SECRET_KEY', 'READONLY_QA_PROVIDER_SECRET_COPY_FORBIDDEN');

const liveJobs = {
  comprehensive: comprehensive.split('\n  production-comprehensive-readonly:\n')[1] ?? '',
  account: account.split('\n  production-account-readonly-live-qa:\n')[1] ?? '',
  credential: credential.split('\n  production-qa:\n')[1] ?? '',
};
for (const [name, workflow] of Object.entries({ comprehensive, account, credential })) {
  const liveJob = liveJobs[name];
  requireText(workflow, 'workflow_call:', `${name.toUpperCase()}_REUSABLE_CALL_MISSING`);
  requireText(liveJob, 'environment: production-readonly-qa', `${name.toUpperCase()}_READONLY_ENVIRONMENT_MISSING`);
  forbidText(liveJob, 'environment: production\n', `${name.toUpperCase()}_PROTECTED_PRODUCTION_ENVIRONMENT_FORBIDDEN`);
  forbidText(liveJob, 'PROD_SSH_PRIVATE_KEY', `${name.toUpperCase()}_SSH_AUTHORITY_FORBIDDEN`);
  forbidText(liveJob, 'PROD_DATABASE_URL', `${name.toUpperCase()}_DATABASE_AUTHORITY_FORBIDDEN`);
}

requireText(orchestrator, '/run-production-postdeploy-qa <40-char-sha>', 'POSTDEPLOY_OWNER_COMMAND_MISSING');
requireText(orchestrator, 'uses: ./.github/workflows/production-comprehensive-readonly-qa.yml', 'POSTDEPLOY_COMPREHENSIVE_CHAIN_MISSING');
requireText(orchestrator, 'needs: [validate-command, comprehensive]', 'POSTDEPLOY_ACCOUNT_MUST_WAIT_FOR_COMPREHENSIVE');
requireText(orchestrator, 'needs: [validate-command, account]', 'POSTDEPLOY_CREDENTIAL_MUST_WAIT_FOR_ACCOUNT');
requireText(orchestrator, 'production-postdeploy-activation-ready-', 'POSTDEPLOY_ACTIVATION_READY_ARTIFACT_MISSING');
requireText(orchestrator, 'activeConflictingTradingGates', 'POSTDEPLOY_GATE_CONFLICT_CHECK_MISSING');
requireText(orchestrator, 'orders/cancels/amends/transfers/withdrawals: `0/0/0/0/0`', 'POSTDEPLOY_ZERO_MUTATION_RECEIPT_MISSING');
forbidText(orchestrator, 'secrets: inherit', 'POSTDEPLOY_REPOSITORY_SECRET_INHERITANCE_FORBIDDEN');
for (const command of [
  '/activate-production-live-trading',
  '/activate-production-futures-live-trading',
  '/activate-production-auto-trading',
]) {
  forbidText(orchestrator, command, 'POSTDEPLOY_ACTIVATION_COMMAND_FORBIDDEN');
}

requireText(
  comprehensive,
  'build-production-comprehensive-readonly-receipt.mjs',
  'COMPREHENSIVE_MACHINE_RECEIPT_BUILDER_MISSING',
);
requireText(comprehensive, 'production_deploy_run_id:', 'COMPREHENSIVE_DEPLOY_PROVENANCE_INPUT_MISSING');
requireText(orchestrator, 'providers: bitget,kiwoom,toss,upbit', 'ACCOUNT_ALL_PROVIDER_CALL_CONTRACT_MISSING');
requireText(credential, 'orderRequests: 0', 'CREDENTIAL_REUSE_ZERO_ORDER_CONTRACT_MISSING');

requireText(app, "import RecommendationsPage from '@/pages/recommendations';", 'RECOMMENDATIONS_EAGER_ROUTE_IMPORT_REQUIRED');
forbidText(app, "lazy(() => import('@/pages/recommendations'))", 'RECOMMENDATIONS_LAZY_ROUTE_FALLBACK_FORBIDDEN');
requireText(recommendations, 'queryKey: recommendationQueryKey(market)', 'RECOMMENDATIONS_SHARED_QUERY_KEY_MISSING');
requireText(stocks, 'queryKey: recommendationQueryKey(mode.stockMarket)', 'STOCKS_SHARED_RECOMMENDATION_QUERY_KEY_MISSING');
requireText(recommendationDeadline, 'RECOMMENDATION_ANALYSIS_BUDGET_MS = 3_200', 'RECOMMENDATION_COLD_PROVIDER_BUDGET_MISSING');
requireText(recommendationService, "'provider_timeout'", 'RECOMMENDATION_PROVIDER_TIMEOUT_EVIDENCE_MISSING');
forbidText(recommendationService, 'FinancialService.getFinancials', 'RECOMMENDATION_DUPLICATE_FINANCIAL_FETCH_FORBIDDEN');
requireText(productionQaSpec, "timeout: 5_000", 'PRODUCTION_ROUTE_FALLBACK_BUDGET_WAS_WEAKENED');
requireText(productionQaSpec, "'route fallback exceeded 5s'", 'PRODUCTION_ROUTE_FALLBACK_ASSERTION_MISSING');

console.log(JSON.stringify({
  ok: true,
  productionProtectionPreserved: true,
  liveActivationProtectionPreserved: true,
  readonlyQaEnvironment: 'production-readonly-qa',
  ownerCommand: '/run-production-postdeploy-qa <40-char-sha>',
  recommendationsFallbackBudgetMs: 5000,
}));
