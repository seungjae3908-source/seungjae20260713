import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  isRetryableGitHubReadFailure,
  readGitHubMetadataWithRetry,
} from '../scripts/browser-adaptive-github-read.mjs';

const workflow=fs.readFileSync('.github/workflows/futures-public-network-smoke.yml','utf8');

test('transient Github 502 and 503 are retried only on a read-only metadata call',async()=>{
  let calls=0;const delays=[];const notices=[];
  const answer=await readGitHubMetadataWithRetry(async()=>{
    calls++;
    if(calls<3)throw Object.assign(new Error('Server Error'),{status:calls===1?502:503});
    return {data:{workflow_runs:[{id:123,conclusion:'success'}]}};
  },{snooze:async ms=>delays.push(ms),onRetry:n=>notices.push(n)});
  assert.equal(calls,3);
  assert.deepEqual(delays,[500,1000]);
  assert.deepEqual(notices,[1,2]);
  assert.equal(answer.data.workflow_runs[0].id,123);
});
test('403, missing artifacts and invalid/empty successful responses fail closed',async()=>{
  let calls=0;const sleepCalls=[];
  await assert.rejects(readGitHubMetadataWithRetry(async()=>{
    calls++;throw Object.assign(new Error('Forbidden'),{status:403});
  },{snooze:async ms=>sleepCalls.push(ms)}),/Forbidden/);
  assert.equal(calls,1);
  assert.deepEqual(sleepCalls,[]);
  await assert.rejects(readGitHubMetadataWithRetry(async()=>({data:null})),/GITHUB_READ_RESPONSE_INVALID/);
  assert.equal(isRetryableGitHubReadFailure({status:400}),false);
  assert.equal(isRetryableGitHubReadFailure({status:429}),false);
  assert.equal(isRetryableGitHubReadFailure({status:504}),true);
});
test('continuous 502 fails after three metadata attempts; it never converts QA to PASS',async()=>{
  let calls=0,notices=0;
  await assert.rejects(readGitHubMetadataWithRetry(async()=>{
    calls++;throw Object.assign(new Error('transient 502'),{status:502});
  },{snooze:async()=>{},onRetry:()=>{notices++;}}),/transient 502/);
  assert.equal(calls,3);
  assert.equal(notices,2);
});
test('canonical Full CI uses the same bounded helper for run-list and artifact-list reads',()=>{
  assert.ok(workflow.includes('browser-adaptive-github-read.mjs'));
  assert.ok(workflow.includes("readGitHubMetadataWithRetry("));
  assert.ok(workflow.includes("() => github.rest.actions.listWorkflowRuns("));
  assert.ok(workflow.includes("() => github.rest.actions.listWorkflowRunArtifacts("));
  assert.ok(workflow.includes("node --test .github/tests/browser-adaptive-github-read.test.mjs"));
  assert.ok(workflow.includes('Run full Playwright adaptive runtime-weighted shard without retry-to-pass'));
});

test('exact-head Fast dispatcher retries only metadata reads and never repeats createWorkflowDispatch',()=>{
  const fast=fs.readFileSync('.github/workflows/application-fast-ci.yml','utf8');
  const begin=fast.indexOf('name: Dispatch exact-head canonical Application CI once');
  const end=fast.indexOf('      - name: Boundary',begin);
  assert.ok(begin>0&&end>begin);
  const dispatch=fast.slice(begin,end);
  for(const required of [
    'const getMetadata = async',
    'GITHUB_READ_ONLY_TRANSIENT_RETRY',
    'attempt === 3',
    '[500,502,503,504]',
    'getMetadata(() => github.rest.pulls.get(',
    'getMetadata(() => github.rest.actions.listWorkflowRuns(',
    "const exactRuns = existing",
    "const reusable = exactRuns",
  ])assert.ok(dispatch.includes(required),required);
  assert.equal((dispatch.match(/github\.rest\.actions\.createWorkflowDispatch\(/g)||[]).length,1);
  assert.ok(!dispatch.includes('getMetadata(() => github.rest.actions.createWorkflowDispatch('));
  assert.ok(fast.includes('node --test .github/tests/browser-adaptive-github-read.test.mjs'));
});
