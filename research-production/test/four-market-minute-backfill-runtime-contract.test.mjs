import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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


test('capacity-only CLI reads protected scope and performs zero provider calls/writes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'minute-capacity-audit-'));
  try {
    const path=join(root,'manifest.json');
    const startMs=Date.parse('2026-10-10T12:00:00.000Z');
    const ranges=Array.from({length:400},(_,i)=>({
      market:'CRYPTO_FUTURES',symbol:'S'+String(i).padStart(4,'0')+'USDT',
      mode:'CONTINUOUS',startMs,
    }));
    await writeFile(path,JSON.stringify({
      schemaVersion:'research-minute-backfill-scope/v1',ranges,
    }),{mode:0o600});
    const r=spawnSync(process.execPath,[
      url('../bin/four-market-minute-backfill.mjs').pathname,'--capacity',
    ],{
      encoding:'utf8',timeout:8000,env:{
        PATH:process.env.PATH,
        RESEARCH_MINUTE_QUEUE_MANIFEST:path,
      },
    });
    assert.equal(r.status,0,r.stderr);
    const payload=JSON.parse(r.stdout);
    assert.equal(payload.status,'CAPACITY_AUDIT_ONLY');
    assert.equal(payload.capacity.status,'CAPACITY_MODEL_INSUFFICIENT');
    assert.equal(payload.capacity.minActionsPerCycleNoHeadroom,17);
    assert.equal(payload.pacingPreflight.status,'OPERATOR_REVIEW_REQUIRED');
    assert.equal(payload.pacingPreflight.maxSequentialActionsWithReserve,23);
    assert.equal(payload.pacingPreflight.actualRuntimeMaximumActionsPerCycle,16);
    assert.equal(payload.pacingPreflight.alternatePage200Scenario.dailyRequiredPages,3200);
    assert.equal(payload.pacingPreflight.alternatePage200Scenario.minActionsPerCycleWithHeadroom,14);
    assert.equal(payload.pacingPreflight.alternatePage200Scenario.status,
      'HYPOTHETICAL_NOT_EXECUTABLE');
    assert.equal(payload.pacingPreflight.alternatePage200Scenario.enabled,false);
    assert.equal(payload.pacingPreflight.declaredBackfillRanges,0);
    assert.equal(payload.pacingPreflight.actionable,false);
    assert.equal(payload.pacingPreflight.providerRateBudgetVerified,false);
    assert.equal(payload.providerCalls,0);
    assert.equal(payload.storageEstimate.projectedPageFiles,400*12*365);
    assert.equal(payload.storageEstimate.hostDiskSpaceRead,false);
    assert.equal(payload.filesWritten,0);
    assert.equal(payload.executionAuthority,'NONE');
    assert.equal((await readFile(path,'utf8')).length>0,true);
  }finally{await rm(root,{recursive:true,force:true});}
});
