import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createResearchWorkerQueue, researchWorkerJobDigest, runResearchWorkerLoop, runResearchWorkerOnce } from '../src/research-workspace-worker-v9.js';
const base='2026-09-26T04:00:00.000Z';
const clockBox=()=>{let t=Date.parse(base);return {clock:()=>new Date(t).toISOString(),add:ms=>{t+=ms;}}};
const job=(id='JOB1',kind='VIDEO_PREPARE')=>({schemaVersion:'research-worker-job-v9',jobId:id,createdAt:base,notBefore:base,maxAttempts:2,task:{kind,runner:'EXISTING_PROVIDER_VIDEO_V8',networkMode:kind==='VIDEO_PREPARE'?'NONE':'APPROVED_ONE_SHOT',argv:kind==='VIDEO_PREPARE'?['--spec','/private/spec.json','--output-root','/private/out']:['--spec','/private/spec.json','--output-root','/private/out','--execute','--approval','/private/approval.json']}});
const dualJob=(id='DUAL1')=>({schemaVersion:'research-worker-job-v9',jobId:id,createdAt:base,notBefore:base,maxAttempts:1,task:{kind:'VIDEO_DUAL_REVIEW_APPROVED',runner:'RESEARCH_ONE_SHOT_V12',networkMode:'APPROVED_ONE_SHOT',argv:['--source','/private/source.json','--spec','/private/spec.json','--manifest','/private/manifest.json','--video-approval','/private/video-approval.json','--groq-approval','/private/groq-approval.json','--output-root','/private/out']}});
async function q(t,opt={}){const root=await mkdtemp(join(tmpdir(),'worker-v9-'));await rm(root,{recursive:true,force:true});t.after(()=>rm(root,{recursive:true,force:true}));const box=clockBox();return {root,box,queue:createResearchWorkerQueue(root,{clock:box.clock,leaseMs:5000,retryDelayMs:0,...opt})};}
test('missing store is unknown not measured zero',async t=>{const {queue}=await q(t);assert.deepEqual(await queue.status(),{schemaVersion:'research-worker-status-v9',available:false,reason:'WORKER_STORE_NOT_INSTALLED'});});
test('initialize creates inactive empty store without starting worker',async t=>{const {queue}=await q(t);const i=await queue.initialize();assert.equal(i.automaticActivation,false);const s=await queue.status();assert.equal(s.workerState,'NOT_RUNNING');assert.deepEqual(s.counts,{queued:0,running:0,succeeded:0,failed:0,blocked:0});});
test('enqueue is idempotent only for exact job',async t=>{const {queue}=await q(t),j=job();assert.equal((await queue.enqueue(j)).status,'QUEUED');assert.equal((await queue.enqueue(j)).status,'EXISTS');const changed=structuredClone(j);changed.task.argv[1]='/private/other.json';await assert.rejects(()=>queue.enqueue(changed),/WORKER_JOB_ID_CONFLICT/);});
test('job digest changes with task plan',()=>{const a=job(),b=job();b.task.argv[1]='/private/b.json';assert.notEqual(researchWorkerJobDigest(a),researchWorkerJobDigest(b));});
test('prepare job cannot hide execute flag',()=>{const j=job();j.task.argv.push('--execute');assert.throws(()=>researchWorkerJobDigest(j),/WORKER_JOB_INVALID/);});
test('execute job requires explicit approval flag',()=>{const j=job('X','VIDEO_EXECUTE_APPROVED');j.task.argv=j.task.argv.filter(x=>x!=='--approval'&&x!=='/private/approval.json');assert.throws(()=>researchWorkerJobDigest(j),/WORKER_JOB_INVALID/);});
test('queue job cannot select env file or preflight',()=>{for(const flag of ['--existing-env','--preflight']){const j=job();j.task.argv.push(flag);assert.throws(()=>researchWorkerJobDigest(j),/WORKER_JOB_INVALID/);}});
test('atomic claim allows one worker only',async t=>{const {queue}=await q(t);await queue.enqueue(job());const [a,b]=await Promise.all([queue.claimNext('W1'),queue.claimNext('W2')]);assert.equal([a,b].filter(Boolean).length,1);});
test('heartbeat retains running lease before expiry',async t=>{const {queue,box}=await q(t);await queue.enqueue(job());const c=await queue.claimNext('W1');box.add(4000);await queue.heartbeat(c.lease);box.add(2000);assert.deepEqual(await queue.recoverExpired(),{recovered:0,blocked:0,failed:0});assert.equal((await queue.status()).counts.running,1);});
test('expired pre-call lease is requeued',async t=>{const {queue,box}=await q(t);await queue.enqueue(job());await queue.claimNext('W1');box.add(6000);assert.equal((await queue.recoverExpired()).recovered,1);assert.equal((await queue.status()).counts.queued,1);});
test('expired final attempt fails instead of infinite retry',async t=>{const {queue,box}=await q(t);const j=job();j.maxAttempts=1;await queue.enqueue(j);await queue.claimNext('W1');box.add(6000);assert.equal((await queue.recoverExpired()).failed,1);assert.equal((await queue.status()).counts.failed,1);});
test('expired lease after external reservation blocks uncertain',async t=>{const {queue,box}=await q(t);await queue.enqueue(job('X','VIDEO_EXECUTE_APPROVED'));const c=await queue.claimNext('W1');await queue.reserveExternal(c.lease,'a'.repeat(64));box.add(6000);assert.equal((await queue.recoverExpired()).blocked,1);assert.equal((await queue.status()).counts.blocked,1);});
test('duplicate reservation must match exact digest',async t=>{const {queue}=await q(t);await queue.enqueue(job('X','VIDEO_EXECUTE_APPROVED'));const c=await queue.claimNext('W1');await queue.reserveExternal(c.lease,'a'.repeat(64));await queue.reserveExternal(c.lease,'a'.repeat(64));await assert.rejects(()=>queue.reserveExternal(c.lease,'b'.repeat(64)),/WORKER_RESERVATION_CONFLICT/);});
test('technical prepare failure can retry without provider reservation',async t=>{const {queue}=await q(t);await queue.enqueue(job());const c=await queue.claimNext('W1');const r=await queue.fail(c.lease,{code:'WORKER_HANDLER_UNAVAILABLE',retryable:true});assert.equal(r.status,'QUEUED');});
test('negative or insufficient research outcome is completion not retry-to-profit',async t=>{const {queue}=await q(t);await queue.enqueue(job());const r=await runResearchWorkerOnce(queue,{workerId:'W1',handler:async()=>({status:'INSUFFICIENT_EVIDENCE',resultDigest:'b'.repeat(64)})});assert.equal(r.status,'SUCCEEDED');assert.equal(r.outcome,'INSUFFICIENT_EVIDENCE');assert.equal((await queue.status()).counts.succeeded,1);});
test('approved external job reserves before handler error and becomes uncertain',async t=>{const {queue}=await q(t);await queue.enqueue(job('X','VIDEO_EXECUTE_APPROVED'));const r=await runResearchWorkerOnce(queue,{workerId:'W1',handler:async()=>{throw Object.assign(new Error('network'),{code:'PROVIDER_RUNTIME_UNAVAILABLE'});},retryableCodes:['PROVIDER_RUNTIME_UNAVAILABLE']});assert.equal(r.status,'BLOCKED_UNCERTAIN');});
test('successful prepare stores only result digest in terminal state',async t=>{const {queue,root}=await q(t);await queue.enqueue(job());await runResearchWorkerOnce(queue,{workerId:'W1',handler:async()=>({status:'PREPARED_NOT_EXECUTED',resultDigest:'c'.repeat(64)})});const row=JSON.parse(await readFile(join(root,'done','JOB1.json'),'utf8'));assert.equal(row.resultDigest,'c'.repeat(64));assert.equal(JSON.stringify(row).includes('api_key'),false);});
test('worker pulse distinguishes active stale and stopped',async t=>{const {queue,box}=await q(t);await queue.pulse('W1',{state:'IDLE',ttlMs:30000});assert.equal((await queue.status()).workerState,'ACTIVE');box.add(31000);assert.equal((await queue.status()).workerState,'STALE');await queue.pulse('W1',{state:'STOPPED',ttlMs:1000});assert.equal((await queue.status()).workerState,'NOT_RUNNING');});
test('loop processes queued job and stops on abort without schedule installation',async t=>{const {queue}=await q(t);await queue.enqueue(job());const c=new AbortController(),p=runResearchWorkerLoop(queue,{workerId:'W1',handler:async()=>{c.abort();return {status:'PREPARED_NOT_EXECUTED',resultDigest:'d'.repeat(64)};},signal:c.signal,pollMs:250,heartbeatEveryMs:1000});await p;const s=await queue.status();assert.equal(s.counts.succeeded,1);assert.equal(s.workerState,'NOT_RUNNING');});

test('dual review job requires both reviewed Gemini and Groq approval paths',()=>{
  const valid=dualJob();assert.match(researchWorkerJobDigest(valid),/^[a-f0-9]{64}$/);
  const missing=dualJob('DUAL2');missing.task.argv=missing.task.argv.filter((x,i,a)=>x!=='--groq-approval'&&a[i-1]!=='--groq-approval');
  assert.throws(()=>researchWorkerJobDigest(missing),/WORKER_JOB_INVALID/);
  const wrongRunner=dualJob('DUAL3');wrongRunner.task.runner='EXISTING_PROVIDER_VIDEO_V8';
  assert.throws(()=>researchWorkerJobDigest(wrongRunner),/WORKER_JOB_INVALID/);
});
test('dual review reaches durable REVIEW_REQUIRED terminal state without retry-to-profit',async t=>{
  const {queue,root}=await q(t);await queue.enqueue(dualJob());
  const out=await runResearchWorkerOnce(queue,{workerId:'W1',handler:async()=>({status:'REVIEW_REQUIRED',resultDigest:'e'.repeat(64)})});
  assert.equal(out.status,'SUCCEEDED');assert.equal(out.outcome,'REVIEW_REQUIRED');
  const row=JSON.parse(await readFile(join(root,'done','DUAL1.json'),'utf8'));
  assert.equal(row.status,'SUCCEEDED');assert.equal(row.outcome,'REVIEW_REQUIRED');assert.equal(row.attempts,1);
});


test('worker CLI executes through current release symlink instead of silently exiting zero', async t=>{
  const root=await mkdtemp(join(tmpdir(),'worker-v9-symlink-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','..');
  const current=join(root,'current');
  await symlink(repoRoot,current,'dir');
  const stateRoot=join(root,'worker-state');
  const cli=join(current,'packages','external-research','scripts','run-research-worker-v9.mjs');
  const run=spawnSync(process.execPath,[cli,'--root',stateRoot,'--status'],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.notEqual(run.stdout.trim(),'');
  const output=JSON.parse(run.stdout);
  assert.equal(output.schemaVersion,'research-worker-status-v9');
  assert.equal(output.available,false);
  assert.equal(output.reason,'WORKER_STORE_NOT_INSTALLED');
});
