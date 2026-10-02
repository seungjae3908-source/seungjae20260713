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
assert(script.includes('live port is already owned by the PM2 stock-app process; no orphan repair is needed'), 'repair must refuse already-healthy PM2 ownership');
assert(script.includes('cmdline_resolves_expected_entry'), 'repair must still inspect the listener command for the canonical direct entrypoint');
assert(script.includes('ORPHAN_ENTRY_MODE=legacy'), 'repair must classify non-canonical legacy listeners explicitly instead of silently weakening the direct-entry check');
assert(script.includes('serving orphan DEPLOY_SHA does not match exact active Production SHA'), 'legacy repair must require exact process DEPLOY_SHA identity');
assert(script.includes('validated legacy orphan listener via exact runtime identity gates'), 'legacy acceptance must occur only behind the explicit exact-identity gate');
assert(script.includes('ORPHAN_START_TICKS'), 'repair must capture process start identity to defend against PID reuse');
assert(script.includes('validated orphan PID was reused or process identity changed before termination'), 'repair must revalidate process identity before termination');
assert(script.includes('live-port listener is managed by a PM2 process; refusing orphan termination'), 'repair must never terminate another PM2-managed process');
assert(script.includes('capture_orphan_runtime "$ORPHAN_PID"'), 'repair must capture the serving runtime in memory before mutation');
assert(script.includes('serving orphan trading authority flags are not fail-closed'), 'repair must verify the serving process has no trading authority');
assert(script.includes('serving orphan executionAuthority is not NONE'), 'repair must verify serving execution authority is NONE');
assert(script.includes('pm2 stop "$PM2_NAME"'), 'repair must stop the broken PM2 restart loop before orphan termination');
assert(script.includes('kill -TERM "$ORPHAN_PID"'), 'repair must try graceful orphan termination first');
assert(script.includes('kill -KILL "$ORPHAN_PID"'), 'repair may hard-stop only the revalidated orphan after a grace period');
assert(script.includes('trap repair_failure_cleanup EXIT'), 'repair must install a post-stop failure recovery trap');
assert(script.includes('repair failed after PM2 stop; preserving exact active service'), 'repair must preserve exact active service on post-stop failure');
assert(script.includes('restore_orphan_runtime'), 'repair must retain an in-memory previous-runtime fallback');
assert(script.includes('pm2 delete "$PM2_NAME"'), 'repair must remove the broken PM2 definition before canonical recreation');
assert(script.includes('pm2 start "$EXPECTED_ENTRY" --name "$PM2_NAME" --cwd "$LIVE_DIR" --interpreter "$(command -v node)"'), 'repair must recreate PM2 directly on the canonical Node entrypoint');
assert(script.includes('env -i'), 'repair must use an explicit environment boundary when recreating PM2');
assert(script.includes('APP_ENV[@]'), 'repair must preserve the serving application environment without printing secret values');
assert(script.includes('LIVE_TRADING=false'), 'repair must force live trading off');
assert(script.includes('AUTO_TRADING=false'), 'repair must force auto trading off');
assert(script.includes('REAL_ORDER_ENABLED=false'), 'repair must force real orders off');
assert(script.includes('PRIVATE_TRADING_API_ALLOWED=false'), 'repair must force private trading API access off');
assert(script.includes('executionAuthority=NONE'), 'repair must force execution authority to NONE');
assert(script.includes('DEPLOY_SHA="$target_sha"'), 'repair must keep the exact active Production SHA');
assert(script.includes('pm2_owns_live_port'), 'repair must prove PM2 owns the live port afterward');
assert(script.includes('probe_health_identity "http://127.0.0.1:$LIVE_PORT" "$ACTIVE_SHA"'), 'repair must prove exact local deployment identity');
assert(script.includes('final PM2 entrypoint is not the canonical Production API entrypoint'), 'repair must verify the final PM2 entrypoint');
assert(script.includes('final PM2 watch mode must be disabled'), 'repair must disable watch mode in the corrected PM2 definition');
assert(script.includes('preserve-never-elevate policy'), 'repair must enforce Telegram preserve-never-elevate semantics');
assert(script.includes('REPAIR_COMPLETE=1'), 'repair must mark completion only after final PM2 save succeeds');
assert(script.includes('pm2 save'), 'repair must persist the corrected PM2 process list');
assert(!script.includes('git checkout'), 'repair must not deploy or replace application source');
assert(!script.includes('rsync '), 'repair must not sync Production application files');
assert(!script.includes('pnpm install'), 'repair must not rebuild or install Production application dependencies');
assert(!script.includes('psql '), 'repair must not mutate or probe the Production database');

assert(workflow.includes("startsWith(github.event.comment.body, '/repair-production-pm2-orphan ')"), 'workflow must require the exact repair command prefix');
assert(workflow.includes('github.event.issue.number == 23'), 'workflow must be bound to Release Control #23');
assert(workflow.includes('Only the repository owner may repair Production PM2 ownership.'), 'workflow must require the repository owner');
assert(workflow.includes('Command author is not the repository owner.'), 'workflow must require OWNER association');
assert(workflow.includes('environment: production'), 'runtime repair must stay behind the protected production environment');
assert(workflow.includes('production-ci-provenance.cjs'), 'workflow must require current-main Required CI provenance');
assert(workflow.includes('ops/repair-production-pm2-orphan.sh'), 'workflow must stream the merged repair implementation');
assert(workflow.includes('https://lsj119.com'), 'workflow must verify the official public Production endpoint');
assert(workflow.includes('Production application deploy executed:'), 'workflow result must explicitly state no application deploy');
assert(workflow.includes('Production database changed:'), 'workflow result must explicitly state no DB mutation');
assert(workflow.includes('New Production SHA deployed:'), 'workflow result must explicitly state no new SHA deployment');

const parsed = JSON.parse(packageJson);
assert(
  parsed.scripts?.['test:phase12']?.includes('verify-production-pm2-orphan-repair-contract.mjs'),
  'phase12 CI must execute the PM2 orphan repair contract verifier',
);

console.log('[production-pm2-orphan-repair-contract] verified');
