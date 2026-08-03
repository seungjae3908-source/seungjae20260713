import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '../..');
const bridgePath = path.join(root, '.github/workflows/production-dispatch-bridge.yml');
const productionPath = path.join(root, '.github/workflows/production-deploy.yml');
const stagingPath = path.join(root, '.github/workflows/staging-readiness.yml');

const bridge = fs.readFileSync(bridgePath, 'utf8');
const production = fs.readFileSync(productionPath, 'utf8');
const staging = fs.readFileSync(stagingPath, 'utf8');

const failures = [];
const requireText = (source, text, label) => {
  if (!source.includes(text)) failures.push(`${label}: missing ${JSON.stringify(text)}`);
};
const forbidText = (source, text, label) => {
  if (source.includes(text)) failures.push(`${label}: forbidden ${JSON.stringify(text)}`);
};

requireText(bridge, 'name: Production Dispatch Bridge', 'bridge identity');
requireText(bridge, 'issue_comment:', 'owner approval trigger');
requireText(bridge, "github.event.issue.number == 23", 'fixed control issue');
requireText(bridge, "github.event.issue.title == 'Staging Readiness Control'", 'fixed control issue title');
requireText(bridge, "github.event.comment.user.login == 'seungjae3908-source'", 'fixed repository owner');
requireText(bridge, "github.event.comment.author_association == 'OWNER'", 'owner association');
requireText(bridge, "startsWith(github.event.comment.body, '/run-production ')", 'production command gate');
requireText(bridge, 'const match = /^\\/run-production ([0-9a-fA-F]{40})$/', 'exact command parser');
requireText(bridge, 'Production dispatch requires the exact current main SHA', 'exact current main gate');
requireText(bridge, "'application-ci/verified'", 'application CI requirement');
requireText(bridge, "'browser-ui/verified'", 'browser UI requirement');
requireText(bridge, "'database-rls/verified'", 'database RLS requirement');
requireText(bridge, "'security-integration/verified'", 'security requirement');
requireText(bridge, "'ai-privacy/verified'", 'AI privacy requirement');
requireText(bridge, "'futures-public-network-smoke/verified'", 'public network requirement');
requireText(bridge, "run.name === 'Application CI'", 'successful main push CI requirement');
requireText(bridge, "workflow_id: 'staging-readiness.yml'", 'staging workflow provenance');
requireText(bridge, "job.name === 'Preflight all isolated staging configuration'", 'staging preflight evidence');
requireText(bridge, "job.name === 'Non-destructive isolated staging deployment'", 'staging deployment evidence');
requireText(bridge, "workflowId = 'production-deploy.yml'", 'official production workflow target');
requireText(bridge, 'existingActiveRun ?? existingSuccessfulRun', 'production duplicate prevention');
requireText(bridge, "force_rebuild: 'false'", 'forced rebuild prohibition');
requireText(bridge, 'return_run_details: true', 'direct run ID confirmation');
requireText(bridge, "'X-GitHub-Api-Version': apiVersion", 'pinned current API');
requireText(bridge, "dispatchedRun.path === '.github/workflows/production-deploy.yml'", 'returned workflow identity check');
requireText(bridge, "dispatchedRun.head_sha === process.env.TARGET_SHA", 'returned SHA check');
requireText(bridge, "dispatchedRun.head_branch === 'main'", 'returned branch check');
requireText(bridge, "dispatchedRun.event === 'workflow_dispatch'", 'returned event check');
requireText(bridge, 'actions: write', 'dispatch permission');
requireText(bridge, 'contents: read', 'read-only repository permission');
requireText(bridge, 'issues: write', 'audit comment permission');
forbidText(bridge, 'secrets.', 'bridge must not read deployment secrets');
forbidText(bridge, 'ssh -', 'bridge must not SSH directly');
forbidText(bridge, '/opt/stock-app', 'bridge must not touch production path');
forbidText(bridge, 'ops/deploy-production.sh" "$TARGET_SHA"', 'bridge must not invoke deploy script');

requireText(production, 'workflow_dispatch:', 'official workflow manual trigger');
requireText(production, 'environment: production', 'GitHub production environment gate');
requireText(production, 'Validate immutable main revision and verified CI provenance', 'official approval gate');
requireText(production, 'Approved canary, production deploy, verify, and rollback', 'official deployment job');
requireText(production, 'LIVE_DIR=/opt/stock-app', 'official production path');
requireText(production, 'PM2_NAME=stock-app', 'official production PM2');
requireText(production, 'LIVE_PORT=8080', 'official live port');
requireText(production, 'CANARY_PORT=18081', 'official canary port');
requireText(production, 'PUBLIC_BASE_URL: https://lsj119.duckdns.org', 'official public URL');
requireText(production, "'application-ci/verified'", 'official workflow application CI gate');
requireText(production, "'browser-ui/verified'", 'official workflow browser gate');
requireText(production, "'database-rls/verified'", 'official workflow DB gate');
requireText(production, "'security-integration/verified'", 'official workflow security gate');
requireText(production, "'ai-privacy/verified'", 'official workflow AI privacy gate');
requireText(production, "'futures-public-network-smoke/verified'", 'official workflow network gate');
requireText(staging, 'Non-destructive isolated staging deployment', 'staging evidence job remains present');

if (failures.length) {
  console.error('Production dispatch bridge contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Production dispatch bridge contract verified.');
console.log('- Owner-only exact command gate: verified');
console.log('- Exact latest main and six required statuses: verified');
console.log('- Successful non-destructive staging deployment provenance: verified');
console.log('- Official environment-protected production workflow only: verified');
console.log('- Direct SSH, secrets, forced rebuild, and duplicate dispatch: blocked');
