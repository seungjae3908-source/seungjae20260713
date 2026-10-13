import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const command=new URL('../bin/four-market-minute-recheck.mjs',import.meta.url).pathname;
function call(arg,env={}) {
  return spawnSync(process.execPath,[command,arg],{
    encoding:'utf8',timeout:8_000,
    env:{PATH:process.env.PATH,...env},
  });
}
test('no recheck provider GET without explicit operator approval',()=>{
  const dry=call('--dry-run');
  assert.equal(dry.status,0,dry.stderr);
  const value=JSON.parse(dry.stdout);
  assert.equal(value.status,'DISABLED');
  assert.equal(value.providerGETCount,0);
  assert.equal(value.filesWritten,0);
  assert.equal(value.executionAuthority,'NONE');
  for(const mode of ['--inspect','--execute','--locked']){
    const denied=call(mode);
    assert.equal(denied.status,2);
    assert.equal(JSON.parse(denied.stdout).reason,
      'MINUTE_RECHECK_OWNER_APPROVAL_REQUIRED');
  }
});
test('write mode needs separate approval beyond a public-read diagnostic',()=>{
  const denied=call('--execute',{
    RESEARCH_MINUTE_RECHECK_ENABLED:'true',
  });
  assert.equal(denied.status,2);
  assert.equal(JSON.parse(denied.stdout).reason,
    'MINUTE_RECHECK_WRITE_APPROVAL_REQUIRED');
});
test('recheck CLI performs no daemon install or trading provider action',async()=>{
  const source=await readFile(command,'utf8');
  assert.match(source,/RESEARCH_MINUTE_RECHECK_ENABLED/);
  assert.match(source,/RESEARCH_MINUTE_RECHECK_WRITE_ALLOWED/);
  assert.match(source,/RESEARCH_MINUTE_RECHECK_MANIFEST/);
  assert.match(source,/\/usr\/bin\/flock/);
  assert.doesNotMatch(source,/(?:systemctl|pm2|placeOrder|orderCreate|TelegramBot|sendMessage)/);
});
