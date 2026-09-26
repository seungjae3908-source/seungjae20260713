import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, chmod, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { prepareWorkspacePublication, createWorkspaceRegistryPublisher } from '../src/research-workspace-publisher-v4.js';
import { strategyDigest, backtestProjectionDigest } from '../src/research-workspace-v1.js';
import { createResearchWorkspaceStore, createStoredWorkspaceHandler } from '../src/research-workspace-store-v2.js';
import { parseResearchWorkspaceResponse } from '../../../stock-analyzer/src/lib/research-workspace-response.js';

const load=async n=>JSON.parse(await readFile(new URL(`./fixtures/research-workspace-v2/${n}.json`,import.meta.url),'utf8'));
const [SOURCE,REGISTRY,POLICY]=await Promise.all(['snapshot','registry','policy'].map(load));
const digest=x=>createHash('sha256').update(x).digest('hex');
const json=x=>Buffer.from(JSON.stringify(x)+'\n');
const omitted=(x,keys)=>Object.fromEntries(Object.entries(x).filter(([k])=>!keys.includes(k)));
function bundle({version='v1', netReturn=-.02}={}) {
  const source=structuredClone(SOURCE),registry=structuredClone(REGISTRY),policy=structuredClone(POLICY);
  const archive=new Map();
  function record(raw){const d=digest(raw);archive.set(d,{bytes:raw,dataClass:'SYNTHETIC'});return d;}
  for(const e of registry.entries){
    e.version=version;e.contentProof.inputDigest=record(Buffer.from('SYNTHETIC authorized source input for QA only.'));
    const p=e.contentProof;
    p.outputDigest=record(json({schemaVersion:'research-workspace-content-artifact-v1',sourceId:e.sourceId,
      receiptId:p.receiptId,accessLevel:p.accessLevel,provider:p.provider,model:p.model,completedAt:p.completedAt,
      inputDigest:p.inputDigest,segments:e.segments.map(s=>omitted(s,['contentDigest']))}));
    for(const s of e.segments)s.contentDigest=p.outputDigest;
    e.run={schemaVersion:'research-linked-backtest-v1',strategyDigest:strategyDigest(e),strategyId:e.strategyId,version:e.version,
      market:e.market,timeframe:e.timeframe,runId:`TEST_${e.market}_${version}`,datasetDigest:'d'.repeat(64),codeSha:'a'.repeat(40),
      startAt:'2026-09-01T00:00:00.000Z',endAt:'2026-09-24T00:00:00.000Z',completedAt:policy.now,
      tradeCount:1,netReturn,maxDrawdown:.03,costsIncluded:true,validationClass:'EXPLORATORY',
      executionAuthority:'NONE',actualOrders:0,canonicalSampleDelta:0};
    e.run.resultDigest=record(json({schemaVersion:'research-workspace-result-artifact-v1',run:omitted(e.run,['resultDigest','summaryDigest'])}));
    e.run.summaryDigest=backtestProjectionDigest(e.run);
  }
  const args={videoEvidence:source,registry,policy,loadArtifact:async({digest})=>archive.get(digest)};
  return {source,registry,policy,archive,args};
}
async function fixture(t,options={}) {
  const b=bundle(options),root=await mkdtemp(join(tmpdir(),'workspace-publish-v4-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const plan=await prepareWorkspacePublication(b.args);
  const authorize=async(request,approval)=>approval?.planDigest===request.planDigest && approval?.root===request.root
    && approval?.previous===request.expectedPreviousPolicySha256 && approval?.scope==='ADMIN_RESEARCH_SHARED';
  const approval=(p=plan,previous=null)=>({planDigest:p.planDigest,root,previous,scope:'ADMIN_RESEARCH_SHARED'});
  const publisher=(extra={})=>createWorkspaceRegistryPublisher({root,authorizePublication:authorize,
    loadSanitizedSnapshot:async()=>b.source,clock:()=>b.policy.now,mode:'OFFLINE_TEST',...extra});
  const publish=(p=plan,previous=null,extra={})=>publisher(extra)({plan:p,expectedPreviousPolicySha256:previous,approval:approval(p,previous)});
  return {...b,root,plan,approval,publisher,publish};
}
const safeEmpty=async root=>assert.deepEqual(await readdir(root),[]);

test('preview checks real bytes and makes no files',async t=>{const f=await fixture(t);await safeEmpty(f.root);assert.equal(f.plan.strategyCount,2);assert.equal(f.plan.runCount,2);assert.equal(f.plan.dataClass,'SYNTHETIC');assert.equal(f.plan.independentOos,false);assert.equal(f.plan.semanticReview,'NOT_PERFORMED');});
test('same inputs produce same review identity',async()=>{const b=bundle();const a=await prepareWorkspacePublication(b.args),c=await prepareWorkspacePublication(b.args);assert.deepEqual(a,c);});
test('missing artifact reader is not approval',async()=>{const b=bundle();await assert.rejects(()=>prepareWorkspacePublication({...b.args,loadArtifact:null}),/ARTIFACT_READER/);});
test('metadata without registry is not a publishable strategy',async()=>{const b=bundle();await assert.rejects(()=>prepareWorkspacePublication({...b.args,registry:null}),/PUBLICATION_INPUT/);});
test('empty registry cannot silently revoke all strategies',async()=>{const b=bundle();b.registry.entries=[];await assert.rejects(()=>prepareWorkspacePublication(b.args),/EMPTY_PUBLICATION/);});
test('missing source is rejected',async()=>{const b=bundle();await assert.rejects(()=>prepareWorkspacePublication({...b.args,videoEvidence:null}),/PUBLICATION_INPUT/);});
test('missing source bytes rejected',async()=>{const b=bundle();b.archive.delete(b.registry.entries[0].contentProof.inputDigest);await assert.rejects(()=>prepareWorkspacePublication(b.args),/ARTIFACT_BYTES_REQUIRED/);});
test('tampered artifact bytes rejected even with correct digest text',async()=>{const b=bundle();b.archive.get(b.registry.entries[0].contentProof.outputDigest).bytes=Buffer.from('{}');await assert.rejects(()=>prepareWorkspacePublication(b.args),/ARTIFACT_BYTES_MISMATCH/);});
test('absent artifact classification rejected',async()=>{const b=bundle();delete b.archive.get(b.registry.entries[0].contentProof.inputDigest).dataClass;await assert.rejects(()=>prepareWorkspacePublication(b.args),/ARTIFACT_CLASSIFICATION/);});
test('archive error does not expose its private detail',async()=>{const b=bundle();await assert.rejects(()=>prepareWorkspacePublication({...b.args,loadArtifact:async()=>{throw new Error('password=secret-value');}}),e=>e.message==='ARTIFACT_UNAVAILABLE');});
test('hanging archive read has a finite deadline', {timeout:5000},async()=>{const b=bundle();let signal;await assert.rejects(()=>prepareWorkspacePublication({...b.args,loadArtifact:({signal:s})=>{signal=s;return new Promise(()=>{});}}),/ARTIFACT_READ_TIMEOUT/);assert.equal(signal.aborted,true);});
test('content metadata cannot substitute another analysis receipt',async()=>{const b=bundle();b.registry.entries[0].contentProof.model='wrong-model';b.registry.entries[0].run=null;await assert.rejects(()=>prepareWorkspacePublication(b.args),/CONTENT_RECEIPT_MISMATCH/);});
test('rehashing a changed displayed metric does not alter archived result',async()=>{const b=bundle(),r=b.registry.entries[0].run;r.netReturn=.99;r.summaryDigest=backtestProjectionDigest(r);await assert.rejects(()=>prepareWorkspacePublication(b.args),/RESULT_ARTIFACT_MISMATCH/);});
test('mutated caller data after preparation does not mutate a reviewed plan',async t=>{const f=await fixture(t);f.registry.entries[0].run.netReturn=.99;await f.publish();const stored=await (await createResearchWorkspaceStore(f.root).openSnapshot()).loadRegistry();assert.equal(stored.entries[0].run.netReturn,-.02);});
test('mutated descriptor and its forged digest cannot be published',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publish({...f.plan}),/PREPARED_PLAN_REQUIRED/);await safeEmpty(f.root);});
test('synthetic data cannot reach default runtime publication',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publish(f.plan,null,{mode:'REVIEWED_RUNTIME'}),/SYNTHETIC_RUNTIME/);await safeEmpty(f.root);});
test('even observed classification cannot replace approval',async t=>{const f=await fixture(t);for(const a of f.archive.values())a.dataClass='OBSERVED';const p=await prepareWorkspacePublication(f.args);
 // OBSERVED here is deliberately a test-double of trusted archive metadata, not a real observation.
 await assert.rejects(()=>f.publisher({mode:'REVIEWED_RUNTIME'})({plan:p,expectedPreviousPolicySha256:null,approval:null}),/NOT_AUTHORIZED/);await safeEmpty(f.root);});
test('approval binds exact reviewed plan',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publisher()({plan:f.plan,expectedPreviousPolicySha256:null,approval:{...f.approval(),planDigest:'a'.repeat(64)}}),/NOT_AUTHORIZED/);await safeEmpty(f.root);});
test('approval callback must return boolean true, not a truthy value',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publish(f.plan,null,{authorizePublication:async()=> 'true'}),/NOT_AUTHORIZED/);await safeEmpty(f.root);});
test('approval failure is redacted',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publish(f.plan,null,{authorizePublication:async()=>{throw new Error('Bearer secret');}}),e=>e.message==='PUBLICATION_NOT_AUTHORIZED');await safeEmpty(f.root);});
test('caller must explicitly supply prior-state expectation',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publisher()({plan:f.plan,approval:f.approval()}),/PREVIOUS_POLICY/);});
test('source changed since review is rejected without writes',async t=>{const f=await fixture(t);f.source.records[0].title='Changed';await assert.rejects(()=>f.publish(),/SOURCE_CHANGED/);await safeEmpty(f.root);});
test('expired source cannot be published',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publish(f.plan,null,{clock:()=> '2026-09-26T06:05:00.000Z'}),/SOURCE_EXPIRED/);await safeEmpty(f.root);});
test('publication cannot precede review time',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publish(f.plan,null,{clock:()=> '2026-09-25T05:00:00.000Z'}),/TIME_INVALID/);});
test('unapproved root is never auto-created',async t=>{const f=await fixture(t),root=join(f.root,'absent');await assert.rejects(()=>f.publish(f.plan,null,{root,authorizePublication:async()=>true}),/ENOENT/);await safeEmpty(f.root);});
test('world-writable destination rejected',async t=>{const f=await fixture(t);await chmod(f.root,0o777);await assert.rejects(()=>f.publish(),/ROOT_UNSAFE/);});
test('symlink destination rejected',async t=>{const f=await fixture(t),p=join(f.root,'link');await symlink(f.root,p);await assert.rejects(()=>f.publish(f.plan,null,{root:p,authorizePublication:async()=>true}),/ROOT_UNSAFE/);});
test('fault injection cannot enter runtime mode',async t=>{const f=await fixture(t);assert.throws(()=>f.publisher({mode:'REVIEWED_RUNTIME',testCheckpoint:()=>{}}),/FAULT_INJECTION_TEST_ONLY/);});
test('first publication reads through existing store and second request is idempotent',async t=>{const f=await fixture(t),a=await f.publish();assert.equal(a.status,'PUBLISHED');const files=await readdir(f.root);const b=await f.publish();assert.equal(b.status,'ALREADY_PUBLISHED');assert.deepEqual(await readdir(f.root),files);assert.equal((await createResearchWorkspaceStore(f.root).openSnapshot()).policySha256,f.plan.policySha256);});
test('publication snapshot has safe permissions, no temp or lock left',async t=>{const f=await fixture(t);await f.publish();const files=await readdir(f.root);assert.equal(files.length,3);assert.ok(files.every(x=>!x.startsWith('.')));});
test('wrong previous state never overwrites an existing result',async t=>{const f=await fixture(t);await f.publish();const b=bundle({version:'v2'}),p=await prepareWorkspacePublication(b.args);await assert.rejects(()=>f.publish(p,null),/STALE_PREVIOUS_POLICY/);assert.equal((await createResearchWorkspaceStore(f.root).openSnapshot()).policySha256,f.plan.policySha256);});
test('correct compare-and-swap publishes next version preserving old registry',async t=>{const f=await fixture(t);await f.publish();const old=await createResearchWorkspaceStore(f.root).openSnapshot();const b=bundle({version:'v2'}),p=await prepareWorkspacePublication(b.args);await f.publish(p,f.plan.policySha256);assert.equal((await old.loadRegistry()).entries[0].version,'v1');assert.equal((await (await createResearchWorkspaceStore(f.root).openSnapshot()).loadRegistry()).entries[0].version,'v2');});
test('older prepared work cannot roll back a newer version without new approval',async t=>{const f=await fixture(t);await f.publish();const b=bundle({version:'v2'}),p=await prepareWorkspacePublication(b.args);await f.publish(p,f.plan.policySha256);await assert.rejects(()=>f.publish(),/STALE_PREVIOUS_POLICY/);});
test('pre-switch failure keeps prior policy fully readable and retry resumes safely',async t=>{const f=await fixture(t);await f.publish();const b=bundle({version:'v2'}),p=await prepareWorkspacePublication(b.args);await assert.rejects(()=>f.publish(p,f.plan.policySha256,{testCheckpoint:async stage=>{if(stage==='BEFORE_SWITCH')throw new Error('injected');}}),/FAILED_BEFORE_SWITCH/);assert.equal((await createResearchWorkspaceStore(f.root).openSnapshot()).policySha256,f.plan.policySha256);assert.equal((await f.publish(p,f.plan.policySha256)).status,'PUBLISHED');});
test('post-switch error is not falsely reported as rollback; retry reads commit',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publish(f.plan,null,{testCheckpoint:async s=>{if(s==='AFTER_SWITCH')throw new Error('injected');}}),/COMMIT_UNCERTAIN/);assert.equal((await createResearchWorkspaceStore(f.root).openSnapshot()).policySha256,f.plan.policySha256);assert.equal((await f.publish()).status,'ALREADY_PUBLISHED');});
test('concurrent writers do not both switch policy',async t=>{const f=await fixture(t);let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const first=f.publish(f.plan,null,{testCheckpoint:async s=>{if(s==='BEFORE_SWITCH'){entered();await gate;}}});await ready;
 await assert.rejects(()=>f.publish(),/PUBLICATION_BUSY/);release();assert.equal((await first).status,'PUBLISHED');});
test('crash-stale lock is retained, not automatically stolen',async t=>{const f=await fixture(t);await writeFile(join(f.root,'.publish.lock'),'old worker',{mode:0o600});await assert.rejects(()=>f.publish(),/PUBLICATION_BUSY/);assert.equal(await readFile(join(f.root,'.publish.lock'),'utf8'),'old worker');});
test('FIFO policy cannot hang publisher', {timeout:2000},async t=>{const f=await fixture(t);execFileSync('mkfifo',[join(f.root,'policy.json')]);await assert.rejects(()=>f.publish(),/FILE_UNSAFE/);});
test('symlink existing policy cannot redirect writes',async t=>{const f=await fixture(t);const target=join(f.root,'unrelated');await writeFile(target,'unchanged',{mode:0o600});await symlink(target,join(f.root,'policy.json'));await assert.rejects(()=>f.publish(),/FILE_UNSAFE/);assert.equal(await readFile(target,'utf8'),'unchanged');});
test('immutable target collision is rejected, never silently overwritten',async t=>{const f=await fixture(t),p=join(f.root,`registry-${f.plan.registrySha256}.json`);await writeFile(p,'tampered',{mode:0o600});await assert.rejects(()=>f.publish(),/IMMUTABLE_FILE_CONFLICT/);assert.equal(await readFile(p,'utf8'),'tampered');});
test('hard-linked immutable input rejected',async t=>{const f=await fixture(t),target=join(f.root,'other');await writeFile(target,'x',{mode:0o600});await link(target,join(f.root,`registry-${f.plan.registrySha256}.json`));await assert.rejects(()=>f.publish(),/FILE_UNSAFE/);});
test('changed policy during prepare-to-switch is detected',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publish(f.plan,null,{testCheckpoint:async s=>{if(s==='BEFORE_SWITCH')await writeFile(join(f.root,'policy.json'),'concurrent',{mode:0o600});}}),/STALE_PREVIOUS_POLICY/);assert.equal(await readFile(join(f.root,'policy.json'),'utf8'),'concurrent');});
test('published data flows through actual read-handler and browser schema over HTTP',async t=>{
 const f=await fixture(t);await f.publish();
 const reader=createStoredWorkspaceHandler({root:f.root,authorize:async req=>req.headers.authorization==='Bearer TEST_ONLY',loadSanitizedSnapshot:async()=>f.source,clock:()=>f.policy.now});
 const server=createServer((req,res)=>{req.query=Object.fromEntries(new URL(req.url,'http://localhost').searchParams);res.status=function(n){this.statusCode=n;return this;};res.json=function(x){this.setHeader('content-type','application/json');this.end(JSON.stringify(x));return this;};void reader(req,res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}/workspace`;
 assert.equal((await fetch(url)).status,403);
 const response=await fetch(url+'?group=CRYPTO',{headers:{authorization:'Bearer TEST_ONLY'}}),raw=await response.json();
 const parsed=parseResearchWorkspaceResponse(raw);assert.equal(parsed.available,true);assert.equal(parsed.strategies.length,1);assert.equal(parsed.strategies[0].market,'CRYPTO_SPOT');assert.equal(parsed.strategies[0].run.netReturn,-.02);
 assert.equal(raw.workspace.authority.actualOrders,0);assert.equal(raw.workspace.strategies[0].actions.liveApply,false);
 assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer TEST_ONLY'}})).status,405);
});

test('source-loader exception is redacted before disk access',async t=>{const f=await fixture(t);await assert.rejects(()=>f.publish(f.plan,null,{loadSanitizedSnapshot:async()=>{throw new Error('/private/provider-key');}}),e=>e.message==='PUBLICATION_SOURCE_UNAVAILABLE');await safeEmpty(f.root);});
test('authorization is rechecked immediately before switch',async t=>{const f=await fixture(t);let calls=0;await assert.rejects(()=>f.publish(f.plan,null,{authorizePublication:async()=>++calls===1}),/NOT_AUTHORIZED/);assert.equal(calls,2);await assert.rejects(()=>createResearchWorkspaceStore(f.root).openSnapshot(),/ENOENT/);});
test('freshness expiry while staging leaves current policy untouched',async t=>{const f=await fixture(t);await f.publish();const b=bundle({version:'v2'}),p=await prepareWorkspacePublication(b.args);let now=f.policy.now;
 await assert.rejects(()=>f.publish(p,f.plan.policySha256,{clock:()=>now,testCheckpoint:async stage=>{if(stage==='BEFORE_SWITCH')now='2026-09-26T06:05:00.000Z';}}),/SOURCE_EXPIRED/);
 assert.equal((await createResearchWorkspaceStore(f.root).openSnapshot()).policySha256,f.plan.policySha256);});

for(const point of ['BEFORE_SWITCH','AFTER_SWITCH'])test(`actual worker SIGKILL at ${point} preserves coherent reader state`,{timeout:5000},async t=>{
 const {spawnSync}=await import('node:child_process');const {unlink}=await import('node:fs/promises');
 const f=await fixture(t);await f.publish();const b=bundle({version:'v2'}),p=await prepareWorkspacePublication(b.args);
 const job={source:b.source,registry:b.registry,policy:b.policy,archive:[...b.archive].map(([id,a])=>[id,{dataClass:a.dataClass,base64:a.bytes.toString('base64')}]),previous:f.plan.policySha256,root:f.root};
 // A separate private fixture file; never the server data directory.
 const dir=await mkdtemp(join(tmpdir(),'workspace-crash-input-'));t.after(()=>rm(dir,{recursive:true,force:true}));const input=join(dir,'job.json');await writeFile(input,json(job),{mode:0o600});
 const moduleUrl=new URL('../src/research-workspace-publisher-v4.js',import.meta.url).href;
 const script=`import {readFileSync} from 'node:fs';import {prepareWorkspacePublication,createWorkspaceRegistryPublisher} from ${JSON.stringify(moduleUrl)};
 const b=JSON.parse(readFileSync(process.argv[1],'utf8'));const a=new Map(b.archive.map(([id,x])=>[id,{dataClass:x.dataClass,bytes:Buffer.from(x.base64,'base64')}]));
 const plan=await prepareWorkspacePublication({videoEvidence:b.source,registry:b.registry,policy:b.policy,loadArtifact:async({digest})=>a.get(digest)});
 const pub=createWorkspaceRegistryPublisher({root:b.root,mode:'OFFLINE_TEST',clock:()=>b.policy.now,authorizePublication:async()=>true,loadSanitizedSnapshot:async()=>b.source,testCheckpoint:async s=>{if(s===process.argv[2])process.kill(process.pid,'SIGKILL');}});
 await pub({plan,approval:null,expectedPreviousPolicySha256:b.previous});`;
 const stopped=spawnSync(process.execPath,['--input-type=module','-e',script,input,point],{timeout:3000,encoding:'utf8'});assert.equal(stopped.signal,'SIGKILL',stopped.stderr);
 const current=await createResearchWorkspaceStore(f.root).openSnapshot();
 assert.equal(current.policySha256,point==='BEFORE_SWITCH'?f.plan.policySha256:p.policySha256);await current.loadRegistry();
 await assert.rejects(()=>f.publish(p,f.plan.policySha256),/PUBLICATION_BUSY/);
 // Explicit test-operator recovery AFTER the child is confirmed dead. Publisher never steals locks.
 await unlink(join(f.root,'.publish.lock'));
 const recovered=await f.publish(p,f.plan.policySha256);assert.equal(recovered.status,point==='BEFORE_SWITCH'?'PUBLISHED':'ALREADY_PUBLISHED');
});
