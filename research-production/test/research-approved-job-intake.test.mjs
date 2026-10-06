import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { intakeApprovedResearchJobs } from '../bin/research-approved-job-intake.mjs';
import { createResearchWorkerQueue } from '../../packages/external-research/src/research-workspace-worker-v9.js';

test('approved intake enqueues only a pre-reviewed durable worker job without provider calls',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-approved-intake-'));
  try{
    const inbox=join(root,'video-research','approved-jobs');
    await mkdir(inbox,{recursive:true,mode:0o700});
    await chmod(join(root,'video-research'),0o700);
    const job={
      schemaVersion:'research-worker-job-v9',jobId:'approved-video-1',
      createdAt:'2026-10-06T00:00:00.000Z',notBefore:'2026-10-06T00:00:00.000Z',maxAttempts:1,
      task:{kind:'VIDEO_PREPARE',runner:'EXISTING_PROVIDER_VIDEO_V8',networkMode:'NONE',
        argv:['--spec','/private/spec.json','--output-root','/private/output']},
    };
    await writeFile(join(inbox,'job.json'),JSON.stringify(job)+'\n',{mode:0o600});
    const result=await intakeApprovedResearchJobs({stateRoot:root});
    assert.equal(result.status,'COMPLETE');
    assert.equal(result.queued,1);
    assert.equal(result.providerCalls,0);
    assert.equal(result.automaticApproval,false);
    const status=await createResearchWorkerQueue(join(root,'workspace-worker')).status();
    assert.equal(status.counts.queued,1);
    assert.equal(status.counts.running,0);
    assert.equal(status.authority.executionAuthority,'NONE');
  }finally{await rm(root,{recursive:true,force:true});}
});
