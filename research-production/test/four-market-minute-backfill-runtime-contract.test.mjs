import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const url=relative=>new URL(relative,import.meta.url);

test('server archive systemd template cannot trade or control production app',async()=>{
  const service=await readFile(url('../deploy/research-production-minute-backfill.service'),'utf8');
  const timer=await readFile(url('../deploy/research-production-minute-backfill.timer'),'utf8');
  assert.match(service,/^Type=oneshot$/m);
  assert.match(service,/^User=investment-research$/m);
  assert.match(service,/^ReadWritePaths=\/var\/lib\/investment-research-production$/m);
  assert.match(service,/^ProtectSystem=strict$/m);
  assert.match(service,/^NoNewPrivileges=true$/m);
  assert.match(service,/^CapabilityBoundingSet=$/m);
  assert.match(service,/^CPUQuota=25%$/m);
  assert.match(service,/^MemoryMax=256M$/m);
  assert.match(service,/^UMask=0077$/m);
  assert.match(service,/^ExecStart=\/usr\/bin\/env node .*four-market-minute-backfill.mjs --execute$/m);
  assert.doesNotMatch(service,/^\s*(?:Environment|EnvironmentFile)=.*(?:ORDER|SECRET|TRADING|REPLIT)/m);
  assert.match(timer,/^OnCalendar=\*-\*-\* \*:0\/5:00 UTC$/m);
  assert.match(timer,/^Unit=research-production-minute-backfill.service$/m);
  assert.match(timer,/^Persistent=true$/m);
  assert.doesNotMatch(timer,/enable|systemctl\s+start|PM2/i);
});

test('backfill CLI is safe by default and cannot enter worker without approval',async()=>{
  const path=url('../bin/four-market-minute-backfill.mjs');
  const dry=spawnSync(process.execPath,[path.pathname,'--dry-run'],{
    encoding:'utf8',timeout:8000,env:{PATH:process.env.PATH},
  });
  assert.equal(dry.status,0,dry.stderr);
  assert.equal(JSON.parse(dry.stdout).status,'DISABLED');
  const bare=spawnSync(process.execPath,[path.pathname,'--locked'],{
    encoding:'utf8',timeout:8000,env:{PATH:process.env.PATH},
  });
  assert.equal(bare.status,2);
  assert.equal(JSON.parse(bare.stdout).reason,'MINUTE_OWNER_ACTIVATION_REQUIRED');
});
