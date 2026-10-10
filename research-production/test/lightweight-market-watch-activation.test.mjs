import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const script = new URL('../deploy/activate-lightweight-market-watch.sh', import.meta.url);
const workflow = new URL('../../.github/workflows/research-market-watch-activation.yml',import.meta.url);
const unit = new URL('../deploy/research-production-market-watch.service',import.meta.url);
const SHA='a'.repeat(40);

test('exact isolated activation bash and systemd unit pass syntax gates on Linux', { skip:process.platform!=='linux' }, async()=>{
  const b=spawnSync('bash',['-n',script.pathname],{encoding:'utf8'});
  assert.equal(b.status,0,b.stderr||b.stdout);
  const u=spawnSync('systemd-analyze',['verify',unit.pathname],{encoding:'utf8'});
  assert.equal(u.status,0,u.stderr||u.stdout);
});
test('invalid target SHA fails before any systemd or host write',()=>{
  const run=spawnSync('bash',[script.pathname,'activate'],{
    env:{PATH:process.env.PATH, TARGET_SHA:'INVALID', HOME:'/nonexistent'},encoding:'utf8',
  });
  assert.equal(run.status,64,run.stdout||run.stderr);
  assert.doesNotMatch(run.stdout,/WATCH_SERVICE_ACTIVE=true/);
});
test('watcher isolated unit must retain minimum resource limits and no live authority',async()=>{
  const s=await readFile(unit,'utf8');
  for(const part of ['User=investment-research','CPUQuota=40%','MemoryHigh=384M',
    'MemoryMax=512M','NoNewPrivileges=true','ProtectSystem=strict',
    'ReadWritePaths=/var/lib/investment-research-production'])
    assert.ok(s.includes(part),part);
  assert.doesNotMatch(s,/ExecStart=.*(broker|live.trade|place.order)/i);
});
test('SSH activation uses exact checkout and never touches existing app, orders or Research timers',async()=>{
  const s=await readFile(script,'utf8');
  for(const part of [
    'EXPECTED_RELEASE="$ROOT/releases/$TARGET_SHA"',
    'RESEARCH_CODE_SHA=$TARGET_SHA',
    'LIVE_TRADING=false','PRIVATE_API_ENABLED=false','ORDER_AUTHORITY=false',
    'systemctl enable --now "$UNIT"',
    'WATCH_ACTIVATION_ROLLED_BACK=true',
    'WATCH_24H_UPTIME_PROVEN=false','WATCH_FOUR_MARKET_FULL_FEED_PROVEN=false',
    'WATCH_EXECUTION_AUTHORITY=NONE'])
    assert.ok(s.includes(part),part);
  assert.doesNotMatch(s,/systemctl (?:enable|restart|start|stop|disable).*research-production-(?:forward|maintenance|fast-historical|long-history)/i);
  assert.doesNotMatch(s,/(?:pm2|caddy|psql|supabase|placeOrder|LIVE_TRADING=true|ORDER_AUTHORITY=true)/);
});
test('owner, exact main, both source PRs and same-run 6/6 are required before SSH',async()=>{
  const y=await readFile(workflow,'utf8');
  for(const part of [
    "github.event.comment.user.login == github.repository_owner",
    "github.event.comment.author_association == 'OWNER'",
    "github.event.issue.number == 1102",
    "startsWith(github.event.comment.body, '/activate-market-watch ')",
    "for (const n of [1743,1764])",
    "'application-ci/verified'",
    "'browser-ui/verified'",
    "'database-rls/verified'",
    "'security-integration/verified'",
    "'ai-privacy/verified'",
    "'futures-public-network-smoke/verified'",
    'needs.authorize.result',
    'ssh -i ~/.ssh/id_ed25519',
    'WATCH_EXECUTION_AUTHORITY=NONE',
    "WATCH_24H_UPTIME_PROVEN=false",
  ]) assert.ok(y.includes(part),part);
  assert.doesNotMatch(y,/ssh-keyscan|StrictHostKeyChecking=no|cancel-in-progress: true/);
});
test('no generated business or research AI/paper execution is in isolated activation',async()=>{
  const y=await readFile(workflow,'utf8');
  assert.ok(y.includes('target_sha'));
  assert.ok(y.includes('replit_used: false'));
  assert.ok(y.includes('paper_orders: 0'));
  assert.ok(y.includes('real_orders: 0'));
  assert.ok(y.includes('24_hour_uptime_proven: false'));
  assert.doesNotMatch(y,/workflow_dispatch:.*activate-real-orders/);
});

test('Vultr CPU-load check runs under GNU awk without reserved identifier collision',async()=>{
  const s=await readFile(script,'utf8');
  assert.ok(s.includes("awk -v current_load=\"$load_one\" 'BEGIN {exit !(current_load>=0 && current_load<1.5)}' || return 71"));
  assert.doesNotMatch(s,/awk -v load=/u);
  const safe=spawnSync('awk',['-v','current_load=0.3',
    'BEGIN {exit !(current_load>=0 && current_load<1.5)}'],{encoding:'utf8'});
  assert.equal(safe.status,0,safe.stderr||safe.stdout);
  const saturated=spawnSync('awk',['-v','current_load=1.7',
    'BEGIN {exit !(current_load>=0 && current_load<1.5)}'],{encoding:'utf8'});
  assert.equal(saturated.status,1,saturated.stderr||saturated.stdout);
});
