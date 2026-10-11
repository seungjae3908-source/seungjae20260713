import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {v3PublicCycleLockCommand,V3_PUBLIC_CYCLE_CONFLICT_EXIT}
  from '../src/public-cycle-singleflight.mjs';
function run(command,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'ignore'});
    child.once('error',reject);
    child.once('exit',code=>resolve(code));
  });
}
test('timer and manual rescan resolve to the same immutable kernel advisory lock',()=>{
  const lock=v3PublicCycleLockCommand('/tmp/signal-v3/latest.json',
    '/opt/investment-signal-intelligence/current/producer.mjs');
  assert.deepEqual(lock.args.slice(0,3),['-n','-E','75']);
  assert.equal(lock.lockPath,'/tmp/signal-v3');
  assert.equal(lock.conflictExitCode,V3_PUBLIC_CYCLE_CONFLICT_EXIT);
  assert.equal(lock.executionAuthority,'NONE');
  for(const input of ['relative.json',''])
    assert.throws(()=>v3PublicCycleLockCommand(input,'/tmp/producer.mjs'),/CONFIG_INVALID/);
});
test('a timer-held flock prevents concurrent manual rescan and releases after exit',async t=>{
  if(process.platform!=='linux'){t.skip('systemd Linux only');return;}
  const dir=await mkdtemp(join(tmpdir(),'v3-singleflight-'));
  const file=join(dir,'latest-snapshot.json');
  const p=join(dir,'producer.mjs');
  const cmd=v3PublicCycleLockCommand(file,p);
  let holder;
  try{
    const hold=[
      process.execPath,'-e',
      'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))',
    ];
    holder=spawn(cmd.command,[...cmd.args.slice(0,4),...hold],{
      stdio:['pipe','ignore','ignore'],
    });
    const exit=new Promise((resolve,reject)=>{
      holder.once('error',reject);
      holder.once('exit',resolve);
    });
    let conflict=null;
    for(let i=0;i<60;i++){
      conflict=await run(cmd.command,['-n','-E','75',cmd.lockPath,
        process.execPath,'-e','process.exit(0)']);
      if(conflict===75)break;
      await new Promise(done=>setTimeout(done,15));
    }
    assert.equal(conflict,75,'concurrent writer must not start');
    assert.equal(await run(cmd.command,['-n','-E','75',cmd.lockPath,
      process.execPath,'-e','process.exit(0)']),75);
    holder.stdin.end();
    const first=await exit;
    assert.equal(first,0);
    holder=null;
    assert.equal(await run(cmd.command,['-n','-E','75',cmd.lockPath,
      process.execPath,'-e','process.exit(0)']),0,
      'kernel lock is released, no stale owner');
  }finally{
    if(holder){holder.stdin?.end();holder.kill('SIGTERM');}
    await rm(dir,{recursive:true,force:true});
  }
});
