import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/production-one-time-approval.yml'), 'utf8');
const production = fs.readFileSync(path.join(root, '.github/workflows/production-deploy.yml'), 'utf8');
const staging = fs.readFileSync(path.join(root, '.github/workflows/staging-readiness.yml'), 'utf8');
const postgresGate = fs.readFileSync(path.join(root, '.github/workflows/staging-postgres-auth-gate.yml'), 'utf8');
const verdictVerifier = fs.readFileSync(path.join(root, 'api-server/scripts/verify-staging-verdict.mjs'), 'utf8');
const legacyApprovalFixture = JSON.parse(fs.readFileSync(path.join(root, 'ops/production-approval.json'), 'utf8'));
const require = createRequire(import.meta.url);
const {
  evaluateProductionApprovalTarget,
  evaluateProductionDispatchTarget,
  normalizeExactSha,
} = require('./production-approval-target.cjs');

const failures = [];
const requireText = (source, text, label) => {
  if (!source.includes(text)) failures.push(`${label}: missing ${JSON.stringify(text)}`);
};
const forbidText = (source, text, label) => {
  if (source.includes(text)) failures.push(`${label}: forbidden ${JSON.stringify(text)}`);
};
const expectReason = (result, reason, label) => {
  if (result.ok || result.reason !== reason) {
    failures.push(`${label}: expected ${reason}, received ${JSON.stringify(result)}`);
  }
};

const mainSha = '7a70db40447924509059ac1ac546aa2e6b0bf8e8';
const exactContext = {
  currentMainSha: mainSha,
  repository: 'seungjae3908-source/seungjae20260713',
  actor: 'seungjae3908-source',
  ref: 'refs/heads/main',
};

const successLower = evaluateProductionApprovalTarget({ targetSha: mainSha, ...exactContext });
if (!successLower.ok || successLower.targetSha !== mainSha) failures.push('target contract: exact lowercase current main must pass');
const successUpper = evaluateProductionApprovalTarget({ targetSha: mainSha.toUpperCase(), ...exactContext });
if (!successUpper.ok || successUpper.targetSha !== mainSha) failures.push('target contract: exact uppercase current main must normalize and pass');
if (normalizeExactSha(mainSha) !== mainSha) failures.push('target contract: exact lowercase normalization failed');

expectReason(evaluateProductionApprovalTarget({ targetSha: '', ...exactContext }), 'target_sha_not_exact_40_hex', 'missing target SHA');
expectReason(evaluateProductionApprovalTarget({ targetSha: mainSha.slice(0, 39), ...exactContext }), 'target_sha_not_exact_40_hex', '39-character target SHA');
expectReason(evaluateProductionApprovalTarget({ targetSha: `${mainSha}0`, ...exactContext }), 'target_sha_not_exact_40_hex', '41-character target SHA');
expectReason(evaluateProductionApprovalTarget({ targetSha: 'main', ...exactContext }), 'target_sha_not_exact_40_hex', 'branch-name target');
expectReason(evaluateProductionApprovalTarget({ targetSha: 'a'.repeat(40), ...exactContext }), 'target_sha_not_exact_current_main', 'stale main SHA');
expectReason(evaluateProductionApprovalTarget({ targetSha: 'b'.repeat(40), ...exactContext }), 'target_sha_not_exact_current_main', 'other branch SHA');
expectReason(evaluateProductionApprovalTarget({ targetSha: 'c'.repeat(40), ...exactContext }), 'target_sha_not_exact_current_main', 'PR synthetic merge SHA');
expectReason(evaluateProductionApprovalTarget({ targetSha: mainSha, ...exactContext, currentMainSha: 'd'.repeat(40) }), 'target_sha_not_exact_current_main', 'current main mismatch');
expectReason(evaluateProductionApprovalTarget({ targetSha: mainSha, ...exactContext, repository: 'other/repo' }), 'repository_mismatch', 'repository mismatch');
expectReason(evaluateProductionApprovalTarget({ targetSha: mainSha, ...exactContext, actor: 'other-user' }), 'approval_actor_mismatch', 'approval actor mismatch');
expectReason(evaluateProductionApprovalTarget({ targetSha: mainSha, ...exactContext, ref: 'refs/heads/feature' }), 'approval_workflow_ref_not_main', 'non-main approval ref');

const matchingDispatch = evaluateProductionDispatchTarget({ approvalTargetSha: mainSha, productionTargetSha: mainSha.toUpperCase() });
if (!matchingDispatch.ok || matchingDispatch.targetSha !== mainSha) failures.push('dispatch contract: identical exact SHA must pass');
expectReason(
  evaluateProductionDispatchTarget({ approvalTargetSha: mainSha, productionTargetSha: 'e'.repeat(40) }),
  'production_target_differs_from_approval_target',
  'approval/deploy SHA mismatch regression',
);

if (!legacyApprovalFixture || typeof legacyApprovalFixture !== 'object' || Array.isArray(legacyApprovalFixture)) {
  failures.push('legacy approval fixture: ops/production-approval.json must remain a static JSON object while retired from runtime');
}

requireText(workflow, 'name: One-Time Production Approval', 'workflow identity');
requireText(workflow, 'workflow_dispatch:', 'non-mutating approval entrypoint');
requireText(workflow, 'target_sha:', 'required exact target input');
requireText(workflow, 'required: true', 'required target input');
requireText(workflow, "if: github.event_name == 'workflow_dispatch'", 'production dispatch limited to explicit approval dispatch');
requireText(workflow, 'group: one-time-production-owner-approval', 'single approval concurrency');
requireText(workflow, 'cancel-in-progress: false', 'no cancellation of active approval');
requireText(workflow, 'RAW_TARGET_SHA: ${{ inputs.target_sha }}', 'target SHA sourced from explicit workflow input');
requireText(workflow, 'production-approval-target.cjs', 'shared immutable target contract');
requireText(workflow, 'APPROVAL_REPOSITORY: ${{ github.repository }}', 'repository identity evidence');
requireText(workflow, 'APPROVAL_ACTOR: ${{ github.actor }}', 'approval actor evidence');
requireText(workflow, 'APPROVAL_REF: ${{ github.ref }}', 'approval ref evidence');
requireText(workflow, "'seungjae3908-source/seungjae20260713'", 'fixed repository gate');
requireText(workflow, "'seungjae3908-source'", 'fixed owner actor gate');
requireText(workflow, "'refs/heads/main'", 'main workflow ref gate');
requireText(workflow, 'getBranch', 'current main lookup');
requireText(workflow, 'currentMainSha: mainResponse.data.commit.sha', 'exact current main comparison');
requireText(workflow, 'ref: evaluated.targetSha', 'exact target commit resolution');
requireText(workflow, "core.setOutput('sha', evaluated.targetSha)", 'normalized immutable target output');

forbidText(workflow, '\n  push:', 'main push must not trigger approval');
forbidText(workflow, 'ops/production-approval.json', 'legacy approval JSON must not participate in runtime approval');
forbidText(workflow, '${{ github.sha }}', 'approval workflow SHA must never become production target');
forbidText(workflow, 'github.event.before', 'approval must not depend on a repository mutation');
forbidText(workflow, 'compareCommits', 'approval must not require approval-file commit comparison');
forbidText(workflow, 'contents: write', 'approval workflow must not mutate repository contents');
forbidText(workflow, 'git push', 'approval workflow must not push commits');
forbidText(workflow, 'createOrUpdateFileContents', 'approval workflow must not write repository files');
forbidText(workflow, 'deleteFile', 'approval workflow must not delete repository files');
forbidText(workflow, 'secrets.', 'approval gate must not read deployment secrets');
forbidText(workflow, 'ssh -', 'approval gate must not SSH directly');
forbidText(workflow, '/opt/stock-app', 'approval gate must not touch production path');
forbidText(workflow, 'issue_comment:', 'comment-triggered production approval remains retired');

requireText(workflow, "'application-ci/verified'", 'application CI requirement');
requireText(workflow, "'browser-ui/verified'", 'browser UI requirement');
requireText(workflow, "'database-rls/verified'", 'database RLS requirement');
requireText(workflow, "'security-integration/verified'", 'security requirement');
requireText(workflow, "'ai-privacy/verified'", 'AI privacy requirement');
requireText(workflow, "'futures-public-network-smoke/verified'", 'public network requirement');
requireText(workflow, 'production-ci-provenance.cjs', 'shared exact CI provenance contract');
requireText(workflow, 'inspectRequiredStatusEvidence', 'same-run required status evidence');
requireText(workflow, 'evaluateProductionCiProvenance', 'official Application CI provenance evaluation');
requireText(workflow, "core.setOutput('run_id', String(verified.runId))", 'Application CI Run ID audit output');

requireText(workflow, 'Require successful exact-SHA PostgreSQL Auth Gate', 'PostgreSQL gate');
requireText(workflow, "run.name === 'Staging PostgreSQL Auth Gate'", 'PostgreSQL gate workflow identity');
requireText(workflow, "run.path === '.github/workflows/staging-postgres-auth-gate.yml'", 'PostgreSQL gate workflow path');
requireText(workflow, "run.head_sha === targetSha", 'PostgreSQL gate exact target SHA');
requireText(workflow, "run.conclusion === 'success'", 'PostgreSQL gate success');
requireText(workflow, 'staging-postgres-auth-${targetSha}', 'PostgreSQL gate exact artifact');
requireText(workflow, 'candidate.expired !== true', 'PostgreSQL gate artifact freshness');
requireText(postgresGate, 'Require exact current main SHA', 'PostgreSQL source gate exact current main check');
requireText(postgresGate, 'staging-postgres-auth-${{ steps.command.outputs.sha }}', 'PostgreSQL source gate exact artifact identity');

requireText(workflow, 'actions.listArtifactsForRepo', 'exact staging artifact lookup');
requireText(workflow, 'actions.getWorkflowRun', 'direct staging source-run verification');
requireText(workflow, "run.path === '.github/workflows/staging-readiness.yml'", 'official staging workflow identity');
requireText(workflow, "run.head_sha === targetSha", 'staging exact target SHA');
requireText(workflow, "run.status === 'completed'", 'staging completed state');
requireText(workflow, "run.conclusion === 'success'", 'staging success conclusion');
requireText(workflow, '!artifact.expired', 'staging artifact freshness');
requireText(workflow, 'actions/download-artifact@v4', 'staging verdict download');
requireText(workflow, 'staging-verdict-${{ steps.target.outputs.sha }}', 'exact target staging artifact name');
requireText(workflow, 'verify-staging-verdict.mjs', 'staging verdict content verification');

requireText(verdictVerifier, 'verdict.release_ready !== true', 'release-ready gate');
requireText(verdictVerifier, 'verdict.skipped !== 0', 'skipped checks blocked');
requireText(verdictVerifier, 'verdict.failed !== 0', 'failed checks blocked');
requireText(verdictVerifier, 'verdict.deployed_sha !== targetSha', 'deployed SHA mismatch blocked');
requireText(verdictVerifier, 'runtime: internal health check', 'internal health required');
requireText(verdictVerifier, 'runtime: external health check', 'external health required');
requireText(verdictVerifier, 'browser: desktop: login, refresh session retention', 'Desktop browser validation required');
requireText(verdictVerifier, 'browser: mobile: login, refresh session retention', 'Mobile browser validation required');
requireText(verdictVerifier, 'database migration and rollback assessment', 'database validation required');
requireText(verdictVerifier, 'verdict.ephemeral_accounts_deleted !== verdict.ephemeral_accounts_created', 'temporary account cleanup required');
requireText(verdictVerifier, 'verdict.ephemeral_profiles_remaining !== 0', 'temporary profile cleanup required');
requireText(verdictVerifier, 'verdict.console_errors !== 0', 'console error zero gate');
requireText(verdictVerifier, 'verdict.page_errors !== 0', 'page error zero gate');
requireText(verdictVerifier, 'verdict.unhandled_rejections !== 0', 'unhandled rejection zero gate');
requireText(verdictVerifier, 'verdict.unexpected_http_errors !== 0', 'unexpected HTTP zero gate');

requireText(workflow, "const workflowId = 'production-deploy.yml'", 'official production workflow only');
requireText(workflow, 'evaluateProductionDispatchTarget', 'approval/deploy SHA equality contract');
requireText(workflow, 'approvalTargetSha: targetSha', 'approved SHA forwarded to dispatch contract');
requireText(workflow, 'productionTargetSha: targetSha', 'production SHA sourced only from approved SHA');
requireText(workflow, 'mainResponse.data.commit.sha !== dispatchContract.targetSha', 'current main revalidated immediately before dispatch');
requireText(workflow, 'sha: dispatchContract.targetSha', 'Production Deploy receives exact approved SHA');
requireText(workflow, "force_rebuild: 'false'", 'forced rebuild disabled');
requireText(workflow, "data_probe_path: '/api/healthz/data-plane'", 'dedicated production data-plane probe');
requireText(workflow, 'return_run_details: true', 'direct production Run ID');
requireText(workflow, 'run.head_sha === dispatchContract.targetSha', 'returned Production run exact SHA');
requireText(workflow, "run.path === '.github/workflows/production-deploy.yml'", 'returned Production workflow identity');
requireText(workflow, 'Production deployment not duplicated', 'duplicate deployment prevention');
requireText(workflow, 'actions: write', 'official workflow dispatch permission');
requireText(workflow, 'issues: write', 'audit comment permission');

requireText(workflow, 'Write sanitized approval audit evidence', 'sanitized audit evidence generation');
requireText(workflow, 'approvalRunId', 'approval Run ID audit field');
requireText(workflow, 'applicationCiRunId', 'Application CI Run ID audit field');
requireText(workflow, 'postgresGateRunId', 'PostgreSQL Gate Run ID audit field');
requireText(workflow, 'stagingRunId', 'Staging Run ID audit field');
requireText(workflow, 'stagingArtifactId', 'Staging artifact ID audit field');
requireText(workflow, 'productionDeployRunId', 'Production Run ID audit field');
requireText(workflow, 'validationTimestamp', 'validation timestamp audit field');
requireText(workflow, 'repositoryMutationUsedForApproval: false', 'non-mutating audit evidence');
requireText(workflow, 'actions/upload-artifact@v4', 'sanitized approval audit artifact');
requireText(workflow, 'Record approval gate failure', 'failure audit');
requireText(workflow, 'Production success must not be assumed.', 'failure safety message');
forbidText(workflow, '/api/quotes?tickers=005930', 'approval gate must not dispatch protected quote API as readiness probe');

requireText(production, 'workflow_dispatch:', 'official Production deployment manual workflow');
requireText(production, 'sha:', 'official Production exact SHA input');
requireText(production, 'Exact 40-character commit SHA from main to deploy', 'Production exact SHA input description');
requireText(production, 'TARGET_SHA: ${{ inputs.sha }}', 'Production target comes from explicit workflow input');
requireText(production, 'TARGET_SHA="${TARGET_SHA,,}"', 'Production SHA normalization');
requireText(production, '[[ "$TARGET_SHA" == "$MAIN_SHA" ]]', 'Production exact current main equality');
requireText(production, 'environment: production', 'GitHub Production environment gate');
requireText(production, 'default: /api/healthz/data-plane', 'official Production data-plane default');
requireText(production, 'actions.listArtifactsForRepo', 'Production independently locates staging artifact');
requireText(production, 'actions/download-artifact@v4', 'Production independently downloads staging artifact');
requireText(production, 'verify-staging-verdict.mjs', 'Production independently verifies staging verdict');
requireText(production, 'LIVE_DIR=/opt/stock-app', 'official Production path');
requireText(production, 'PM2_NAME=stock-app', 'official Production PM2');
requireText(production, 'PUBLIC_BASE_URL: https://lsj119.duckdns.org', 'official Production URL');
forbidText(production, '/api/quotes?tickers=005930', 'official Production workflow must not use protected quote API as readiness probe');

requireText(staging, 'STAGING_RUN_FULL_VALIDATION=true is mandatory', 'full validation required for deploy candidate');
requireText(staging, 'staging-verdict-${{ env.TARGET_SHA }}', 'exact staging artifact identity');
requireText(staging, 'release_ready', 'staging release-ready field');

if (failures.length) {
  console.error('One-time production approval contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('One-time production approval contract verified.');
console.log('- workflow_dispatch target_sha is explicit, exact, current-main-equal, and non-mutating');
console.log('- Missing/39/41/branch/stale/other-branch/PR-synthetic/current-main mismatch targets are blocked');
console.log('- Required CI 6/6 same-run exact Application CI provenance is preserved');
console.log('- Exact-SHA PostgreSQL Auth Gate and unexpired artifact are required');
console.log('- Exact-SHA Staging release_ready, health, Desktop/Mobile, DB, cleanup, zero-error evidence is required');
console.log('- Production Deploy receives exactly the approved target SHA and revalidates current main');
console.log('- GitHub production Environment, /api/healthz/data-plane, and rollback contracts remain intact');
console.log('- ops/production-approval.json remains only a legacy/static fixture and cannot trigger Production');
console.log('- Repository mutation, github.sha target substitution, direct SSH/secrets, and silent failure are blocked');
