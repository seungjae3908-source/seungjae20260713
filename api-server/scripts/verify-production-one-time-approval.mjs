import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/production-one-time-approval.yml'), 'utf8');
const approval = JSON.parse(fs.readFileSync(path.join(root, 'ops/production-approval.json'), 'utf8'));
const production = fs.readFileSync(path.join(root, '.github/workflows/production-deploy.yml'), 'utf8');
const staging = fs.readFileSync(path.join(root, '.github/workflows/staging-readiness.yml'), 'utf8');
const verdictVerifier = fs.readFileSync(path.join(root, 'api-server/scripts/verify-staging-verdict.mjs'), 'utf8');

const failures = [];
const requireText = (source, text, label) => {
  if (!source.includes(text)) failures.push(`${label}: missing ${JSON.stringify(text)}`);
};
const forbidText = (source, text, label) => {
  if (source.includes(text)) failures.push(`${label}: forbidden ${JSON.stringify(text)}`);
};

const expectedApproval = {
  approved: true,
  approvedBy: 'seungjae3908-source',
  approvalMessage: '운영배포승인',
  sourceMainSha: 'cd2f92cb084055798a0641876126979445c1e8b9',
  oneTime: true,
  requestedAt: '2026-08-04T04:53:00+09:00',
};
if (JSON.stringify(approval) !== JSON.stringify(expectedApproval)) {
  failures.push('approval record: exact owner approval payload changed');
}

requireText(workflow, 'name: One-Time Production Approval', 'workflow identity');
requireText(workflow, 'push:', 'proven main push trigger');
requireText(workflow, 'branches: [main]', 'main-only push');
requireText(workflow, '- ops/production-approval.json', 'one-time approval path');
requireText(workflow, "if: github.event_name == 'push'", 'production dispatch limited to push');
requireText(workflow, 'group: one-time-production-owner-approval', 'single approval concurrency');
requireText(workflow, 'cancel-in-progress: false', 'no cancellation of active approval');
requireText(workflow, 'Validate immutable one-time owner approval', 'immutable approval validation');
requireText(workflow, "approval.approvedBy !== 'seungjae3908-source'", 'fixed owner gate');
requireText(workflow, "approval.approvalMessage !== '운영배포승인'", 'exact user approval message');
requireText(workflow, 'approval.oneTime !== true', 'one-time gate');
requireText(workflow, "file.filename === 'ops/production-approval.json'", 'approval file changed check');
requireText(workflow, "'application-ci/verified'", 'application CI requirement');
requireText(workflow, "'browser-ui/verified'", 'browser UI requirement');
requireText(workflow, "'database-rls/verified'", 'database RLS requirement');
requireText(workflow, "'security-integration/verified'", 'security requirement');
requireText(workflow, "'ai-privacy/verified'", 'AI privacy requirement');
requireText(workflow, "'futures-public-network-smoke/verified'", 'public network requirement');
requireText(workflow, 'actions.listArtifactsForRepo', 'exact staging artifact lookup');
requireText(workflow, 'actions.getWorkflowRun', 'direct staging source-run verification');
requireText(workflow, "run.path === '.github/workflows/staging-readiness.yml'", 'official staging workflow identity');
requireText(workflow, "run.conclusion === 'success'", 'successful staging run conclusion');
requireText(workflow, 'actions/download-artifact@v4', 'staging verdict download');
requireText(workflow, 'verify-staging-verdict.mjs', 'staging verdict content verification');
requireText(workflow, 'release_ready=true, failed=0, skipped=0', 'zero-failure and zero-skip release gate');
requireText(workflow, "const workflowId = 'production-deploy.yml'", 'official production workflow only');
requireText(workflow, "force_rebuild: 'false'", 'forced rebuild disabled');
requireText(workflow, 'return_run_details: true', 'direct production Run ID');
requireText(workflow, "run.path === '.github/workflows/production-deploy.yml'", 'returned workflow identity');
requireText(workflow, 'Official production deployment was not duplicated.', 'duplicate deployment prevention');
requireText(workflow, 'Record approval gate failure', 'failure audit');
requireText(workflow, 'Production success must not be assumed.', 'failure safety message');
requireText(workflow, 'actions: write', 'official workflow dispatch permission');
requireText(workflow, 'issues: write', 'audit comment permission');
forbidText(workflow, 'secrets.', 'approval gate must not read deployment secrets');
forbidText(workflow, 'ssh -', 'approval gate must not SSH directly');
forbidText(workflow, '/opt/stock-app', 'approval gate must not touch production path');
forbidText(workflow, 'issue_comment:', 'standalone comment production trigger remains retired');

requireText(production, 'workflow_dispatch:', 'official production manual workflow');
requireText(production, 'environment: production', 'GitHub production environment gate');
requireText(production, 'actions.listArtifactsForRepo', 'production independently locates staging artifact');
requireText(production, 'actions/download-artifact@v4', 'production independently downloads staging artifact');
requireText(production, 'verify-staging-verdict.mjs', 'production independently verifies staging verdict');
requireText(production, 'LIVE_DIR=/opt/stock-app', 'official production path');
requireText(production, 'PM2_NAME=stock-app', 'official production PM2');
requireText(production, 'LIVE_PORT=8080', 'official live port');
requireText(production, 'PUBLIC_BASE_URL: https://lsj119.duckdns.org', 'official public URL');
requireText(staging, 'STAGING_RUN_FULL_VALIDATION=true is mandatory', 'full validation required for deploy candidate');
requireText(staging, 'staging-verdict-${{ env.TARGET_SHA }}', 'exact staging artifact identity');
requireText(staging, 'release_ready', 'staging release-ready field');
requireText(verdictVerifier, 'verdict.skipped !== 0', 'skipped tests blocked');
requireText(verdictVerifier, 'verdict.failed !== 0', 'failed tests blocked');
requireText(verdictVerifier, 'verdict.deployed_sha !== targetSha', 'deployed SHA mismatch blocked');

if (failures.length) {
  console.error('One-time production approval contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('One-time production approval contract verified.');
console.log('- Exact owner approval and main-push-only trigger: verified');
console.log('- Required CI 6/6 provenance: verified');
console.log('- Exact-SHA staging artifact with release_ready=true, failed=0, skipped=0: verified');
console.log('- Production workflow independently revalidates the same artifact: verified');
console.log('- Direct SSH, production secrets, forced rebuild, duplicate dispatch, and silent failure: blocked');
