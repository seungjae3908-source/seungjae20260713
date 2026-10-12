'use strict';
const { assertProductionDeployProvenance } = require('./production-deploy-provenance.cjs');
const REQUIRED = ['application-ci/verified', 'browser-ui/verified', 'database-rls/verified',
  'security-integration/verified', 'ai-privacy/verified', 'futures-public-network-smoke/verified'];
const PROJECTS = ['prod-desktop-1920', 'prod-desktop-1440', 'prod-desktop-1024', 'prod-fold-768',
  'prod-tablet-800', 'prod-mobile-320', 'prod-mobile-360', 'prod-mobile-390', 'prod-mobile-412', 'prod-mobile-430'];
const VIEWS = ['요약', '연구', '검증', '모의매매', 'AI', '영상'];
const PREFLIGHT_IDS = ['NODE_ENV_PARSER','TOOL_GIT','TOOL_SYSTEMCTL','TOOL_SYSTEMD_ANALYZE','TOOL_RUNUSER',
  'APP_DEPLOY_SHA','CORE_DISK_AND_INODES','WATCH_RESOURCE_BUDGET','RESEARCH_STATE_DIRECTORY','RESEARCH_STATE_OWNER',
  'WATCH_INSTALLED_UNIT_COMPATIBLE','RESEARCH_SAFE_ENV','CORE_CURRENT_RELEASE','PROVIDER_ONLY_ENV_SCOPE',
  'PROVIDER_YOUTUBE','PROVIDER_GEMINI','PROVIDER_GROQ','FREE_AI_POLICY','VIDEO_POLICY',
  'SHARED_APP_AI_CONSENT_IDENTITY','DASHBOARD_PYTHON_RUNTIME','DASHBOARD_CURRENT_RELEASE','APP_RESEARCH_BUNDLE_STORE_CONFIGURATION',
  'RESEARCH_ADAPTIVE_POLICY_RECORD_PATH','RESEARCH_DATA_FACTORY_EVIDENCE_PATH','RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_PATH',
  'RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH','RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH','PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH',
  'STOCK_INPUT_KR_STOCK','STOCK_INPUT_US_STOCK','CURRENT_CYCLE_FORWARD','CURRENT_CYCLE_FAST_HISTORICAL','CURRENT_CYCLE_LONG_HISTORY',
  'FACTORY_FUNCTIONAL_EVIDENCE','AI_REVIEW_FUNCTIONAL_EVIDENCE','VIDEO_DISCOVERY_FUNCTIONAL_EVIDENCE','PAPER_LOOP_FUNCTIONAL_EVIDENCE',
  ...['FAST_HISTORICAL_TIMER','LONG_HISTORY_TIMER','FORWARD_TIMER','TEMPORAL_EVIDENCE_TIMER','FACTORY_STATUS_TIMER','MAINTENANCE_TIMER',
    'AI_REVIEW_TIMER','VIDEO_DISCOVERY_TIMER','APPROVED_JOB_INTAKE_TIMER','WORKSPACE_WORKER_SERVICE','MARKET_WATCH_SERVICE'].map(x=>'UNIT_'+x)];
const MUTATING_WORKFLOWS = ['production-deploy.yml', 'production-live-trading-gate.yml',
  'production-futures-live-trading-gate.yml', 'production-automatic-trading-gate.yml',
  'production-automatic-paper-only-gate.yml', 'telegram-production-code-only-deploy.yml',
  'research-production-activation.yml', 'research-ai-production-activation.yml',
  'research-market-watch-activation.yml', 'research-dashboard-activation.yml'];

function assertResearchQaAuthorization({ researchSha, currentMain, appSha, workflowSha,
  deployRunId, deployRun, statuses, ciRun, runs, stagingRun, stagingRunId }) {
  if (![researchSha, appSha].every(value => /^[a-f0-9]{40}$/u.test(value ?? ''))
    || currentMain !== researchSha || workflowSha !== researchSha) throw new Error('RESEARCH_QA_MAIN_IDENTITY_INVALID');
  assertProductionDeployProvenance(deployRun, { targetSha: appSha, productionDeployRunId: deployRunId });
  const latest = new Map();
  for (const status of [...statuses].sort((a, b) => b.id - a.id)) {
    if (!latest.has(status.context)) latest.set(status.context, status);
  }
  if (!REQUIRED.every(name => latest.get(name)?.state === 'success'
    && /\/actions\/runs\/(\d+)$/u.exec(latest.get(name)?.target_url ?? '')?.[1] === String(ciRun?.id))) {
    throw new Error('RESEARCH_QA_EXACT_MAIN_CI_6_REQUIRED');
  }
  if (ciRun?.name !== 'Application CI' || ciRun.path !== '.github/workflows/futures-public-network-smoke.yml'
    || ciRun.head_sha !== researchSha || ciRun.head_branch !== 'main'
    || !['push', 'workflow_dispatch'].includes(ciRun.event) || ciRun.status !== 'completed' || ciRun.conclusion !== 'success') {
    throw new Error('RESEARCH_QA_CI_PROVENANCE_INVALID');
  }
  if (runs.some(run => run.path === ciRun.path && run.head_sha === researchSha
    && ['push', 'workflow_dispatch'].includes(run.event) && Number(run.id) > Number(ciRun.id))) {
    throw new Error('RESEARCH_QA_NEWER_CI_REQUIRES_REVALIDATION');
  }
  if (runs.some(run => run.status !== 'completed'
    && MUTATING_WORKFLOWS.some(file => run.path === '.github/workflows/' + file))) {
    throw new Error('RESEARCH_QA_ACTIVE_MUTATION_RUN_CONFLICT');
  }
  if (!/^[1-9][0-9]*$/u.test(String(stagingRunId)) || String(stagingRun?.id) !== String(stagingRunId)
    || stagingRun.path !== '.github/workflows/staging-trading-core-only.yml'
    || stagingRun.event !== 'workflow_dispatch' || stagingRun.head_branch !== 'main'
    || stagingRun.head_sha !== researchSha || stagingRun.status !== 'completed' || stagingRun.conclusion !== 'success') {
    throw new Error('RESEARCH_QA_STAGING_PROVENANCE_INVALID');
  }
  return { researchSha, appSha, requiredCiRunId: ciRun.id, stagingRunId: Number(stagingRunId),
    productionDeployRunId: Number(deployRunId) };
}

function buildResearchQaReceipt({ identity, coverage, report, preflight, healthBefore, healthAfter, nowMs = Date.now() }) {
  if (report?.stats?.expected !== 10 || report.stats.unexpected !== 0 || report.stats.skipped !== 0
    || report.stats.flaky !== 0 || !Array.isArray(coverage) || coverage.length !== 10) {
    throw new Error('RESEARCH_QA_ACTUAL_10_PROJECT_COVERAGE_REQUIRED');
  }
  if (new Set(coverage.map(row => row.project)).size !== 10 || !PROJECTS.every(project => coverage.some(row => row.project === project))) {
    throw new Error('RESEARCH_QA_PROJECT_IDENTITY_INVALID');
  }
  for (const row of coverage) {
    if (row.schemaVersion !== 'research-production-browser-coverage-v1' || row.appSha !== identity.appSha
      || row.researchSha !== identity.researchSha || row.actualResearchAccess !== true
      || JSON.stringify(row.views) !== JSON.stringify(VIEWS) || row.scrollReachedBottom !== true
      || !Number.isFinite(row.horizontalOverflowPx) || row.horizontalOverflowPx < 0 || row.horizontalOverflowPx > 2
      || row.blockedMutationCount !== 0 || row.runtimeFailureCount !== 0 || row.criticalHttpFailureCount !== 0
      || row.providerPrivateRequests !== 0 || row.rawScreenshotsRetained !== false) throw new Error('RESEARCH_QA_COVERAGE_INVALID');
  }
  for (const health of [healthBefore, healthAfter]) {
    if (health?.ok !== true || health.deploySha !== identity.appSha || health.identityMatch !== true) {
      throw new Error('RESEARCH_QA_SHARED_APP_IDENTITY_DRIFT');
    }
  }
  if (preflight?.schemaVersion !== 'research-activation-preflight-v1' || preflight.appSha !== identity.appSha
    || preflight.researchSha !== identity.researchSha || !Array.isArray(preflight.checks)
    || !PREFLIGHT_IDS.every(id=>preflight.checks.some(row=>row.id===id))
    || new Set(preflight.checks.map(row => row.id)).size !== preflight.checks.length
    || !Number.isFinite(Date.parse(preflight.observedAt)) || Date.parse(preflight.observedAt) > nowMs + 5000
    || nowMs - Date.parse(preflight.observedAt) > 30 * 60000
    || preflight.checks.some(row => !['prerequisite','postactivation','functionality'].includes(row.phase)
      || !['PASS','BLOCKED','MISSING','INVALID','PENDING','UNKNOWN'].includes(row.status))
    || JSON.stringify(preflight.remainingChecks) !== JSON.stringify(preflight.checks.filter(row=>row.phase!=='prerequisite'&&row.status!=='PASS').map(row=>row.id))
    || preflight.prerequisitesReady !== true || preflight.prerequisiteBlockers?.length !== 0
    || preflight.checks.some(row => row.phase === 'prerequisite' && row.status !== 'PASS')
    || preflight.executionAuthority !== 'NONE' || preflight.credentialsExposed !== false
    || preflight.fullyFunctional !== false || preflight.closedLoopProven !== false || preflight.profitabilityProven !== false
    || ['serverFilesWritten', 'processRestarts', 'databaseMutations', 'policyMutations', 'providerCalls',
      'providerPrivateRequests', 'orders'].some(key => preflight[key] !== 0)) throw new Error('RESEARCH_QA_PREFLIGHT_NOT_READY');
  return { schemaVersion: 'research-production-readonly-qa-v1', ...identity,
    researchBrowserQa: 'PASS', evaluatedProjects: PROJECTS, evaluatedViews: VIEWS,
    activationPrerequisitesReady: true, remainingChecks: preflight.remainingChecks,
    sharedAppRedeployed: false, sharedAppIdentityUnchanged: true,
    fullComprehensiveQaVerdict: 'NOT_REPLACED', automaticTradingQaVerdict: 'NOT_EVALUATED',
    fullyFunctional: false, closedLoopProven: false, profitabilityProven: false,
    policyMutations: 0, databaseMutations: 0, providerPrivateRequests: 0, realOrders: 0,
    executionAuthority: 'NONE', secretsRecorded: false, rawScreenshotsRetained: false };
}
module.exports = { assertResearchQaAuthorization, buildResearchQaReceipt, PROJECTS, VIEWS, PREFLIGHT_IDS };
