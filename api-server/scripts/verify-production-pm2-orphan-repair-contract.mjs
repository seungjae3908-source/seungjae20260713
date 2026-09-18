import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd(), '..');
const [script, workflow, packageJson] = await Promise.all([
  readFile(path.join(root, 'ops/repair-production-pm2-orphan.sh'), 'utf8'),
  readFile(path.join(root, '.github/workflows/production-pm2-orphan-repair.yml'), 'utf8'),
  readFile(path.join(root, 'api-server/package.json'), 'utf8'),
]);

assert(script.includes('flock -n 9'), 'repair must serialize against Production deployment/repair');
assert(script.includes('active Production marker differs from approved repair target'), 'repair must pin exact active Production SHA');
assert(script.includes('expected exactly one listener on the Production live port'), 'repair must require one unambiguous live-port listener');
assert(script.includes('live port is already owned by the PM2 stock-app process; no orphan repair is needed'), 'repair must refuse healthy PM2 ownership');
assert(script.includes('live-port listener command does not resolve to the canonical Production API entrypoint'), 'repair must validate the listener entrypoint');
assert(script.includes('live-port listener is managed by a PM2 process; refusing orphan termination'), 'repair must never terminate another PM2-managed process');
assert(script.includes('pm2 stop "$PM2_NAME"'), 'repair must stop the restart loop before orphan termination');
assert(script.includes('kill -TERM "$ORPHAN_PID"'), 'repair must try graceful orphan termination first');
assert(script.includes('kill -KILL "$ORPHAN_PID"'), 'repair may hard-stop only the revalidated orphan after a grace period');
assert(script.includes('trap repair_failure_cleanup EXIT'), 'repair must install a failure recovery trap after immutable preflight');
assert(script.includes('repair failed after PM2 stop; attempting safe PM2 recovery'), 'repair must attempt PM2 recovery after any post-stop failure');
assert(script.includes('PM2_STOPPED=1'), 'repair must arm recovery only after PM2 is actually stopped');
assert(script.includes('REPAIR_COMPLETE=1'), 'repair must mark completion only after final PM2 save succeeds');
assert(script.includes('POST_LISTENERS[0]}" == "$NEW_PM2_PID"'), 'repair must prove PM2 owns the live port afterward');
assert(script.includes('probe_health_identity "http://127.0.0.1:$LIVE_PORT" "$ACTIVE_SHA"'), 'repair must prove exact local deployment identity');
assert(script.includes('LIVE_TRADING=false AUTO_TRADING=false REAL_ORDER_ENABLED=false PRIVATE_TRADING_API_ALLOWED=false'), 'repair must force trading/private authority off');
assert(script.includes('executionAuthority=NONE DEPLOY_SHA="$target_sha"'), 'repair must preserve NONE execution authority and exact active SHA');
assert(script.includes('Telegram activation state changed during repair'), 'repair must verify Telegram state preservation');
assert(script.includes('pm2 save'), 'repair must persist the corrected PM2 process list');
assert(!script.includes('git checkout'), 'repair must not deploy or replace application source');
assert(!script.includes('rsync '), 'repair must not sync Production application files');
assert(!script.includes('pnpm install'), 'repair must not rebuild or install Production application dependencies');
assert(!script.includes('psql '), 'repair must not mutate or probe the Production database');

assert(workflow.includes("startsWith(github.event.comment.body, '/repair-production-pm2-orphan ')"), 'workflow must require the exact repair command prefix');
assert(workflow.includes("github.event.issue.number == 23"), 'workflow must be bound to Release Control #23');
assert(workflow.includes('[[ "$COMMENT_AUTHOR" == "seungjae3908-source" ]]'), 'workflow must require the repository owner');
assert(workflow.includes('[[ "$AUTHOR_ASSOCIATION" == "OWNER" ]]'), 'workflow must require OWNER association');
assert(workflow.includes('environment: production'), 'runtime repair must stay behind the protected production environment');
assert(workflow.includes('production-ci-provenance.cjs'), 'workflow must require current-main Required CI provenance');
assert(workflow.includes('ops/repair-production-pm2-orphan.sh'), 'workflow must stream the merged repair implementation');
assert(workflow.includes('https://lsj119.com'), 'workflow must verify the official public Production endpoint');
assert(workflow.includes('Production application deploy executed: `false`'), 'workflow result must explicitly state no application deploy');
assert(workflow.includes('Production database changed: `false`'), 'workflow result must explicitly state no DB mutation');
assert(workflow.includes('New Production SHA deployed: `false`'), 'workflow result must explicitly state no new SHA deployment');

const parsed = JSON.parse(packageJson);
assert(
  parsed.scripts?.['test:phase12']?.includes('verify-production-pm2-orphan-repair-contract.mjs'),
  'phase12 CI must execute the PM2 orphan repair contract verifier',
);

console.log('[production-pm2-orphan-repair-contract] verified');
