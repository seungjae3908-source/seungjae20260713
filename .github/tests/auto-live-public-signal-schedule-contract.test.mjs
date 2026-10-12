import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
test('dedicated 15-minute public publisher is isolated from Paper and cannot grant Live authority', () => {
  const script=readFileSync('ops/install-auto-live-public-signal-schedule.sh','utf8');
  const parse=spawnSync('bash',['-n','ops/install-auto-live-public-signal-schedule.sh'],{encoding:'utf8'});
  assert.equal(parse.status,0,parse.stderr);
  for(const token of [
    "ROOT='/opt/stock-app-data/auto-live-signal-v1'",
    "AUTO_LIVE_PUBLIC_SIGNAL_INSTALL_APPROVED",
    '"$APP/.deploy/current-sha"',
    "PAPER_FORWARD_ROOT='$ROOT/runtime-state'",
    "PAPER_FORWARD_RESEARCH_SHA='$SHA'",
    "AUTO_LIVE_PUBLIC_SIGNAL_REFRESH_ENABLED='true'",
    "PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED='false'",
    "RESEARCH_PRODUCTION='false'",
    "LIVE_TRADING='false'",
    "REAL_ORDER_ENABLED='false'",
    "PRIVATE_TRADING_API_ALLOWED='false'",
    "PRIVATE_ACCOUNT_ACCESS='false'",
    "PRIVATE_API_ENABLED='false'",
    "PRIVATE_TRADING_API_ALLOWED='false'",
    "sourceTransportOnly:true", "issuerVerified:false",
    "paperRootMutated:false", "paperCronReplaced:false",
    'mv -T "$STAGED" "$ROOT"',
    '[[ "$CURRENT" == "$OLD_CRON"',
    'COMMITTED_ROOT=1',
  ]) assert.ok(script.includes(token),'protected installer contract missing: '+token);
  assert.doesNotMatch(script,/disable-paper-forward-schedule\.sh|install-paper-forward-schedule\.sh/u);
  assert.doesNotMatch(script,/PAPER_FORWARD_ROOT=['"]?\/opt\/stock-app-data\/paper-forward-v1/u);
  assert.doesNotMatch(script,/\b(?:pm2|psql|supabase)\b/iu);
});
test('independent source cannot install without protected operator approval', () => {
  const r=spawnSync('bash',['ops/install-auto-live-public-signal-schedule.sh','a'.repeat(40)],{
    encoding:'utf8',timeout:4000,env:{PATH:process.env.PATH,HOME:process.env.HOME,
      AUTO_LIVE_PUBLIC_SIGNAL_INSTALL_APPROVED:'false'},
  });
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/owner approval required/u);
  assert.doesNotMatch(r.stdout,/WAITING_FOR_GENUINE_PUBLIC_CYCLE/u);
});
