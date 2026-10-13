import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const cmd=new URL('../bin/four-market-minute-roster-capacity.mjs',import.meta.url).pathname;
test('current roster capacity CLI defaults to 0-provider-calls and has no activation',()=>{
  const r=spawnSync(process.execPath,[cmd,'--dry-run'],{
    encoding:'utf8',timeout:8000,env:{PATH:process.env.PATH},
  });
  assert.equal(r.status,0,r.stderr);
  const v=JSON.parse(r.stdout);
  assert.equal(v.status,'DISABLED');
  assert.equal(v.publicProviderCalls,0);
  assert.equal(v.dataStored,false);
  assert.equal(v.executionAuthority,'NONE');
});
test('public current roster probe refuses HTTP without separate opt-in',async()=>{
  const r=spawnSync(process.execPath,[cmd,'--public-probe'],{
    encoding:'utf8',timeout:8000,env:{PATH:process.env.PATH},
  });
  assert.equal(r.status,2);
  const v=JSON.parse(r.stdout);
  assert.equal(v.status,'BLOCKED');
  assert.equal(v.reason,'MINUTE_ROSTER_OWNER_PROBE_APPROVAL_REQUIRED');
  assert.equal(v.dataStored,false);
  const src=await readFile(cmd,'utf8');
  assert.match(src,/--public-probe/);
  assert.match(src,/RESEARCH_MINUTE_PUBLIC_ROSTER_PROBE_ENABLED/);
  assert.doesNotMatch(src,/systemctl|pm2|ORDER_EXECUTION_REQUEST/);
});
