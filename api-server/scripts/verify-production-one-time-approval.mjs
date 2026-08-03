import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '../..');
const workflowPath = path.join(root, '.github/workflows/production-one-time-approval.yml');
const approvalPath = path.join(root, 'ops/production-approval.json');
const productionPath = path.join(root, '.github/workflows/production-deploy.yml');
const stagingPath = path.join(root, '.github/workflows/staging-readiness.yml');
const retiredWorkflowPath = path.join(root, '.github/workflows/production-dispatch-bridge.yml');
const retiredVerifierPath = path.join(root, 'api-server/scripts/verify-production-dispatch-bridge.mjs');

const workflow = fs.readFileSync(workflowPath, 'utf8');
const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
const production = fs.readFileSync(productionPath, 'utf8');
const staging = fs.readFileSync(stagingPath, 'utf8');

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
requireText(workflow, 'Unapproved files changed after the user\'s approval', 'post-approval diff restriction');
requireText(workflow, "'application-ci/verified'", 'application CI requirement');
requireText(workflow, "'browser-ui/verified'", 'browser UI requirement');
requireText(workflow, "'database-rls/verified'", 'database RLS requirement');
requireText(workflow, "'security-integration/verified'", 'security requirement');
requireText(workflow, "'ai-privacy/verified'", 'AI privacy requirement');
requireText(workflow, "'futures-public-network-smoke/verified'", 'public network requirement');
requireText(workflow, "run.name === 'Application CI'", 'successful main push CI provenance');
requireText(workflow, "workflow_id: 'staging-readiness.yml'", 'exact staging workflow');
requireText(workflow, "job.name === 'Preflight all isolated staging configuration'", 'staging preflight job evidence');
requireText(workflow, "job.name === 'Non-destructive isolated staging deployment'", 'staging deploy job evidence');
requireText(workflow, "const workflowId = 'production-deploy.yml'", 'official production workflow only');
requireText(workflow, "force_rebuild: 'false'", 'forced rebuild disabled');
requireText(workflow, 'return_run_details: true', 'direct production Run ID');
requireText(workflow, "'X-GitHub-Api-Version': apiVersion", 'pinned current API');
requireText(workflow, "run.path === '.github/workflows/production-deploy.yml'", 'returned workflow identity');
requireText(workflow, "run.event === 'workflow_dispatch'", 'returned event identity');
requireText(workflow, "run.head_branch === 'main'", 'returned branch identity');
requireText(workflow, 'run.head_sha === process.env.TARGET_SHA', 'returned SHA identity');
requireText(workflow, 'Official production deployment was not duplicated.', 'duplicate deployment prevention');
requireText(workflow, 'Record approval gate failure', 'failure audit');
requireText(workflow, 'Production success must not be assumed.', 'failure safety message');
requireText(workflow, 'actions: write', 'official workflow dispatch permission');
requireText(workflow, 'issues: write', 'audit comment permission');
requireText(workflow, 'contents: read', 'read-only repository permission');
forbidText(workflow, 'secrets.', 'approval gate must not read deployment secrets');
forbidText(workflow, 'ssh -', 'approval gate must not SSH directly');
forbidText(workflow, '/opt/stock-app', 'approval gate must not touch production path');
forbidText(workflow, 'issue_comment:', 'unreliable standalone comment trigger retired');

if (fs.existsSync(retiredWorkflowPath)) failures.push('retired issue-comment production bridge still exists');
if (fs.existsSync(retiredVerifierPath)) failures.push('retired issue-comment bridge verifier still exists');

requireText(production, 'workflow_dispatch:', 'official production manual workflow');
requireText(production, 'environment: production', 'GitHub production environment gate');
requireText(production, 'Validate immutable main revision and verified CI provenance', 'official immutable approval gate');
requireText(production, 'Approved canary, production deploy, verify, and rollback', 'official deploy and rollback job');
requireText(production, 'LIVE_DIR=/opt/stock-app', 'official production path');
requireText(production, 'PM2_NAME=stock-app', 'official production PM2');
requireText(production, 'LIVE_PORT=8080', 'official live port');
requireText(production, 'CANARY_PORT=18081', 'official canary port');
requireText(production, 'PUBLIC_BASE_URL: https://lsj119.duckdns.org', 'official public URL');
requireText(staging, 'Non-destructive isolated staging deployment', 'staging deployment evidence remains present');

if (failures.length) {
  console.error('One-time production approval contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('One-time production approval contract verified.');
console.log('- Exact owner approval record and main-push-only trigger: verified');
console.log('- Post-approval diff restriction and CI 6/6 gate: verified');
console.log('- Exact-SHA non-destructive staging success gate: verified');
console.log('- Official environment-protected production workflow only: verified');
console.log('- Direct SSH, secrets, forced rebuild, duplicate dispatch, and silent failure: blocked');
