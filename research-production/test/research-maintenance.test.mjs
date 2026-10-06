import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runResearchMaintenance } from '../bin/research-maintenance.mjs';

const exists=async path=>{try{await access(path);return true;}catch{return false;}};

test('maintenance deletes only expired task workspaces and provider staging',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-maintenance-'));
  const now=Date.parse('2026-10-06T12:00:00Z');
  try{
    const oldTask=join(root,'runs','old-cycle','task-a');
    const freshTask=join(root,'runs','fresh-cycle','task-b');
    await mkdir(join(oldTask,'workspace'),{recursive:true});
    await mkdir(join(freshTask,'workspace'),{recursive:true});
    await writeFile(join(oldTask,'workspace','keep-no.json'),'ephemeral\n');
    await writeFile(join(freshTask,'workspace','recent.json'),'recent\n');
    await writeFile(join(oldTask,'result.json'),JSON.stringify({endedAt:now-20*24*3600000})+'\n');
    await writeFile(join(freshTask,'result.json'),JSON.stringify({endedAt:now-2*24*3600000})+'\n');
    const staleStage=join(root,'video-research','provider-staging','stale');
    await mkdir(staleStage,{recursive:true});
    await writeFile(join(staleStage,'tmp'),'x');
    const old=new Date(now-2*24*3600000);
    await utimes(staleStage,old,old);
    const result=await runResearchMaintenance({stateRoot:root,retentionHours:336,stagingRetentionHours:24,now:()=>now});
    assert.equal(result.status,'COMPLETE');
    assert.equal(result.workspacesRemoved,1);
    assert.equal(result.stagingRemoved,1);
    assert.equal(result.evidenceFilesDeleted,0);
    assert.equal(await exists(join(oldTask,'workspace')),false);
    assert.equal(await exists(join(freshTask,'workspace')),true);
    assert.equal(await exists(join(root,'runs','old-cycle')),true);
    assert.equal(result.executionAuthority,'NONE');
  }finally{await rm(root,{recursive:true,force:true});}
});
