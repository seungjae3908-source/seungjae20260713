import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { assertResearchQaAuthorization, buildResearchQaReceipt, PROJECTS, VIEWS, PREFLIGHT_IDS } = require('../scripts/research-production-readonly-contract.cjs');
const researchSha = 'a'.repeat(40), appSha = 'b'.repeat(40);
function authorized() {
  const ciRun = { id: 10, name: 'Application CI', path: '.github/workflows/futures-public-network-smoke.yml',
    head_sha: researchSha, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  return { researchSha, appSha, currentMain: researchSha, workflowSha: researchSha, deployRunId: '5', stagingRunId: '6', ciRun,
    statuses: ['application-ci/verified', 'browser-ui/verified', 'database-rls/verified', 'security-integration/verified',
      'ai-privacy/verified', 'futures-public-network-smoke/verified'].map((context,id) => ({context,id,state:'success',target_url:'https://github.com/example/actions/runs/10'})),
    deployRun: { id:5, name:'Production Deploy', path:'.github/workflows/production-deploy.yml', event:'workflow_dispatch',
      head_branch:'main',head_sha:appSha,status:'completed',conclusion:'success' },
    stagingRun: { id:6,path:'.github/workflows/staging-trading-core-only.yml',event:'workflow_dispatch',head_branch:'main',
      head_sha:researchSha,status:'completed',conclusion:'success' }, runs: [ciRun] };
}
function receiptInput() {
  return { identity: assertResearchQaAuthorization(authorized()),
    report: { stats:{expected:10,unexpected:0,skipped:0,flaky:0} },
    coverage: PROJECTS.map(project => ({schemaVersion:'research-production-browser-coverage-v1',appSha,researchSha,project,
      actualResearchAccess:true,views:VIEWS,horizontalOverflowPx:0,scrollReachedBottom:true,blockedMutationCount:0,
      runtimeFailureCount:0,criticalHttpFailureCount:0,providerPrivateRequests:0,rawScreenshotsRetained:false})),
    preflight: {schemaVersion:'research-activation-preflight-v1',appSha,researchSha,
      checks:PREFLIGHT_IDS.map(id=>({id,phase:'prerequisite',status:'PASS'})),observedAt:new Date().toISOString(),
      prerequisitesReady:true,prerequisiteBlockers:[],remainingChecks:[],
      fullyFunctional:false,closedLoopProven:false,profitabilityProven:false,credentialsExposed:false,executionAuthority:'NONE',
      serverFilesWritten:0,processRestarts:0,databaseMutations:0,policyMutations:0,providerCalls:0,providerPrivateRequests:0,orders:0},
    healthBefore:{ok:true,deploySha:appSha,identityMatch:true},healthAfter:{ok:true,deploySha:appSha,identityMatch:true} };
}
test('authorization preserves explicit different app/Research identities and all exact provenances', () => {
  assert.equal(assertResearchQaAuthorization(authorized()).appSha, appSha);
  for (const field of ['currentMain','workflowSha']) assert.throws(()=>assertResearchQaAuthorization({...authorized(),[field]:appSha}),/MAIN_IDENTITY/);
  const input=authorized();input.statuses[1].state='failure';assert.throws(()=>assertResearchQaAuthorization(input),/CI_6_REQUIRED/);
  const moved=authorized();moved.stagingRun.head_sha=appSha;assert.throws(()=>assertResearchQaAuthorization(moved),/STAGING_PROVENANCE/);
});
test('newer CI or any active shared/research mutation blocks the read-only lane', () => {
  const input=authorized();input.runs.push({...input.ciRun,id:11,status:'in_progress',conclusion:null});
  assert.throws(()=>assertResearchQaAuthorization(input),/NEWER_CI/);
  const conflict=authorized();conflict.runs.push({path:'.github/workflows/production-futures-live-trading-gate.yml',status:'waiting'});
  assert.throws(()=>assertResearchQaAuthorization(conflict),/MUTATION_RUN_CONFLICT/);
});
test('receipt proves only scoped preactivation readiness, never replaces global failure or performance evidence', () => {
  const result=buildResearchQaReceipt(receiptInput());
  assert.equal(result.fullComprehensiveQaVerdict,'NOT_REPLACED');
  assert.equal(result.automaticTradingQaVerdict,'NOT_EVALUATED');
  assert.equal(result.closedLoopProven,false);assert.equal(result.fullyFunctional,false);
});
test('denial, skipped width, duplicate width, hidden failures, privacy leak and app drift are rejected', () => {
  for (const mutate of [
    input=>{input.coverage[0].actualResearchAccess=false;},
    input=>{input.report.stats.skipped=1;},
    input=>{input.coverage[1].project=input.coverage[0].project;},
    input=>{input.coverage[0].criticalHttpFailureCount=1;},
    input=>{input.coverage[0].rawScreenshotsRetained=true;},
    input=>{input.healthAfter.deploySha=researchSha;},
    input=>{input.preflight.checks[0].status='BLOCKED';},
    input=>{input.preflight.orders=1;},
    input=>{input.preflight.fullyFunctional=true;},
  ]) { const input=receiptInput();mutate(input);assert.throws(()=>buildResearchQaReceipt(input)); }
});
test('all server-reaching research paths are protected; host probe is stdin-only and browser has no SSH or DB authority', () => {
  const read=file=>readFileSync(new URL('../../'+file,import.meta.url),'utf8').replaceAll('\r\n','\n');
  const workflow=read('.github/workflows/research-production-readonly-qa.yml');
  const browser=workflow.split('\n  browser:\n')[1].split('\n  host-preflight:\n')[0];
  assert.match(browser,/environment: production/u);
  assert.doesNotMatch(browser,/PROD_SSH_|PROD_DATABASE_URL|deploy-production|prepare_admin/u);
  assert.match(workflow,/StrictHostKeyChecking=yes/u);
  assert.match(workflow,/collectResearchActivationPreflight/u);
  assert.match(workflow,/verify-staging-automation-research-verdict/u);
  for (const [file,job] of [
    ['research-dashboard-activation.yml','activate'],['research-production-natural-paper-observability.yml','observe-current-cycle'],
    ['research-market-watch-runtime-audit.yml','audit'],
  ]) {
    const source=read('.github/workflows/'+file);
    assert.match(source.split('\n  '+job+':\n')[1],/environment: production/u);
    assert.doesNotMatch(source,/ssh-keyscan/u);
  }
  assert.doesNotMatch(read('stock-analyzer/e2e/production-comprehensive-readonly-qa.spec.ts'),/\bpage\.screenshot\s*\(/u);
  const spec=read('stock-analyzer/e2e/production-research-center-readonly-qa.spec.ts');
  assert.match(spec,/expect\(strictResearchQa/u);
  assert.match(spec,/pendingResearchReads.size/u);
  assert.match(spec,/criticalHttpFailures/u);
  assert.match(read('stock-analyzer/playwright.production-research.config.ts'),/\.\.\.comprehensive/u);
});
