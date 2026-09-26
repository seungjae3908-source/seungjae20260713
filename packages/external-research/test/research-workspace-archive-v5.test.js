import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,readdir,rm,chmod,symlink,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createPrivateReviewedReader,openReviewedWorkspaceArchive,prepareWorkspaceFromReviewedArchive} from '../src/research-workspace-archive-v5.js';
import {createWorkspaceRegistryPublisher} from '../src/research-workspace-publisher-v4.js';
import {createResearchWorkspaceStore,createStoredWorkspaceHandler} from '../src/research-workspace-store-v2.js';
import {createWorkspaceApprovalFileReader,createWorkspaceApprovalVerifier} from '../src/research-workspace-approval-v5.js';
import {parseResearchWorkspaceResponse} from '../../../stock-analyzer/src/lib/research-workspace-response.js';
import {strategyDigest,backtestProjectionDigest} from '../src/research-workspace-v1.js';
const load=async n=>JSON.parse(await readFile(new URL(`./fixtures/research-workspace-v2/${n}.json`,import.meta.url),'utf8'));
const [SOURCE,REGISTRY,POLICY]=await Promise.all(['snapshot','registry','policy'].map(load));
const sha=x=>createHash('sha256').update(x).digest('hex'),bytes=x=>Buffer.from(JSON.stringify(x)+'\n');
const omit=(x,keys)=>Object.fromEntries(Object.entries(x).filter(([k])=>!keys.includes(k)));
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'workspace-archive-v5-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const m={schemaVersion:'research-workspace-archive-v5',createdAt:POLICY.now,producerCodeSha:'a'.repeat(40),reviewId:'TEST_ONLY',artifacts:[]};
 const raw=Buffer.from('SYNTHETIC test input, not a real video or AI response.');
 const record=async(kind,b)=>{const digest=sha(b);await writeFile(join(root,`artifact-${digest}.bin`),b,{mode:0o600});if(!m.artifacts.some(a=>a.kind===kind&&a.digest===digest))m.artifacts.push({kind,digest,byteLength:b.length,dataClass:'SYNTHETIC'});return digest;};
 const registry=structuredClone(REGISTRY);
 for(const e of registry.entries){
   const p=e.contentProof;p.inputDigest=await record('CONTENT_INPUT',raw);
   p.outputDigest=await record('CONTENT_OUTPUT',bytes({schemaVersion:'research-workspace-content-artifact-v1',sourceId:e.sourceId,receiptId:p.receiptId,accessLevel:p.accessLevel,provider:p.provider,model:p.model,completedAt:p.completedAt,inputDigest:p.inputDigest,segments:e.segments.map(s=>omit(s,['contentDigest']))}));
   for(const s of e.segments)s.contentDigest=p.outputDigest;
   e.run={schemaVersion:'research-linked-backtest-v1',strategyDigest:strategyDigest(e),strategyId:e.strategyId,version:e.version,market:e.market,timeframe:e.timeframe,runId:`TEST_${e.market}`,datasetDigest:'d'.repeat(64),codeSha:'a'.repeat(40),startAt:'2026-09-01T00:00:00.000Z',endAt:'2026-09-24T00:00:00.000Z',completedAt:POLICY.now,tradeCount:1,netReturn:-.025,maxDrawdown:.03,costsIncluded:true,validationClass:'EXPLORATORY',executionAuthority:'NONE',actualOrders:0,canonicalSampleDelta:0};
   e.run.resultDigest=await record('RESULT',bytes({schemaVersion:'research-workspace-result-artifact-v1',run:omit(e.run,['resultDigest','summaryDigest'])}));
   e.run.summaryDigest=backtestProjectionDigest(e.run);
 }
 const save=async()=>{const b=bytes(m),h=sha(b);await writeFile(join(root,`manifest-${h}.json`),b,{mode:0o600});return h;};
 const digest=await save();
 return {root,m,registry,save,digest,path:join(root,`manifest-${digest}.json`),raw,open:()=>openReviewedWorkspaceArchive({root,manifestSha256:digest,now:POLICY.now}),args:{archiveRoot:root,manifestSha256:digest,videoEvidence:SOURCE,registry,policy:POLICY}};
}
test('archive opens actual private files without modifying them',async t=>{const f=await fixture(t),before=await readdir(f.root);const a=await f.open();assert.equal(a.artifactCount,f.m.artifacts.length);const got=await a.loadArtifact(f.m.artifacts[0]);assert.equal(got.dataClass,'SYNTHETIC');assert.deepEqual(got.bytes,f.raw);assert.deepEqual(await readdir(f.root),before);});
test('review preparation delegates to existing publisher validator',async t=>{const f=await fixture(t),r=await prepareWorkspaceFromReviewedArchive(f.args);assert.equal(r.plan.strategyCount,2);assert.equal(r.plan.runCount,2);assert.equal(r.plan.dataClass,'SYNTHETIC');assert.equal(r.publicationPerformed,false);assert.equal(r.archiveManifestSha256,f.digest);});
test('missing manifest is unavailable, not an empty observation',async t=>{const f=await fixture(t);await rm(f.path);await assert.rejects(f.open,/REVIEWED_FILE_UNAVAILABLE/);});
test('changing manifest bytes breaks pinned review identity',async t=>{const f=await fixture(t);await writeFile(f.path,'{}');await assert.rejects(f.open,/MANIFEST_HASH_MISMATCH/);});
test('changed artifact bytes cannot retain reviewed hash',async t=>{const f=await fixture(t),a=await f.open(),entry=f.m.artifacts[0];await writeFile(join(f.root,`artifact-${entry.digest}.bin`),Buffer.alloc(entry.byteLength,65));await assert.rejects(()=>a.loadArtifact(entry),/ARTIFACT_HASH_MISMATCH/);});
test('unreviewed digest cannot be read',async t=>{const f=await fixture(t),a=await f.open();await assert.rejects(()=>a.loadArtifact({kind:'CONTENT_INPUT',digest:'f'.repeat(64)}),/NOT_REVIEWED/);});
test('artifact kind is independently allowlisted',async t=>{const f=await fixture(t),a=await f.open();await assert.rejects(()=>a.loadArtifact({...f.m.artifacts[0],kind:'RESULT'}),/NOT_REVIEWED/);});
test('copied bytes cannot mutate later reads',async t=>{const f=await fixture(t),a=await f.open();const x=await a.loadArtifact(f.m.artifacts[0]);x.bytes.fill(0);assert.deepEqual((await a.loadArtifact(f.m.artifacts[0])).bytes,f.raw);});
test('aborted preparation cannot read source content',async t=>{const f=await fixture(t),c=new AbortController();c.abort('secret');await assert.rejects(()=>prepareWorkspaceFromReviewedArchive({...f.args,signal:c.signal}),e=>e.message==='REVIEWED_FILE_CANCELLED');});
test('per-artifact cancellation is respected',async t=>{const f=await fixture(t),a=await f.open(),c=new AbortController();c.abort();await assert.rejects(()=>a.loadArtifact({...f.m.artifacts[0],signal:c.signal}),/CANCELLED/);});
test('original archive cancellation survives subsequent reads',async t=>{const f=await fixture(t),c=new AbortController();const a=await openReviewedWorkspaceArchive({root:f.root,manifestSha256:f.digest,now:POLICY.now,signal:c.signal});c.abort();await assert.rejects(()=>a.loadArtifact(f.m.artifacts[0]),/CANCELLED/);});
for(const [name,fn] of [
 ['future timestamp',m=>m.createdAt='2027-01-01T00:00:00.000Z'],['extra field',m=>m.permitLive=true],
 ['unknown producer',m=>m.producerCodeSha=null],['no review identity',m=>m.reviewId=''],
 ['empty manifest',m=>m.artifacts=[]],['unknown class',m=>m.artifacts[0].dataClass='REAL_PROFIT'],
 ['URL/path',m=>m.artifacts[0].digest='https://example.invalid/private'],['duplicate',m=>m.artifacts.push({...m.artifacts[0]})],
 ['excess size',m=>m.artifacts[0].byteLength=2*1024*1024+1],['unreviewed extra file attribute',m=>m.artifacts[0].path='/etc/passwd'],
])test(`manifest rejects ${name}`,async t=>{const f=await fixture(t);fn(f.m);const d=await f.save();await assert.rejects(()=>openReviewedWorkspaceArchive({root:f.root,manifestSha256:d,now:POLICY.now}),/ARCHIVE_/);});
for(const target of ['manifest','artifact'])test(`${target} symlink rejected`,async t=>{const f=await fixture(t),a=target==='artifact'?await f.open():null;const p=target==='manifest'?f.path:join(f.root,`artifact-${f.m.artifacts[0].digest}.bin`);await rm(p);await symlink('/etc/hostname',p);await assert.rejects(()=>a?a.loadArtifact(f.m.artifacts[0]):f.open(),/REVIEWED_/);});
for(const target of ['manifest','artifact'])test(`${target} FIFO cannot hang`,{timeout:1500},async t=>{const f=await fixture(t),a=target==='artifact'?await f.open():null;const p=target==='manifest'?f.path:join(f.root,`artifact-${f.m.artifacts[0].digest}.bin`);await rm(p);execFileSync('mkfifo',['-m','600',p]);await assert.rejects(()=>a?a.loadArtifact(f.m.artifacts[0]):f.open(),/REVIEWED_FILE_UNSAFE/);});
test('hardlinked manifest rejected',async t=>{const f=await fixture(t);await link(f.path,join(f.root,'linked'));await assert.rejects(f.open,/UNSAFE/);});
test('writable directory rejected',async t=>{const f=await fixture(t);await chmod(f.root,0o777);await assert.rejects(f.open,/DIRECTORY_UNSAFE/);});
test('noncanonical root rejected',()=>assert.throws(()=>createPrivateReviewedReader('/tmp/x/../y'),/PRIVATE_ROOT/));
test('basename traversal rejected',async()=>{await assert.rejects(()=>createPrivateReviewedReader('/tmp')('../etc/passwd',128),/BASENAME/);});
test('same bytes from an unpinned new manifest do not replace current manifest',async t=>{const f=await fixture(t),a=await f.open();f.m.artifacts[0].dataClass='OBSERVED';await f.save();assert.equal((await a.loadArtifact(f.m.artifacts[0])).dataClass,'SYNTHETIC');});

test('disk archive -> exact approval -> publisher -> stored reader -> browser preserves negative result',async t=>{
 const f=await fixture(t),out=await mkdtemp(join(tmpdir(),'workspace-output-v5-')),grants=await mkdtemp(join(tmpdir(),'workspace-grants-v5-'));
 t.after(()=>rm(out,{recursive:true,force:true}));t.after(()=>rm(grants,{recursive:true,force:true}));
 const {plan}=await prepareWorkspaceFromReviewedArchive(f.args);
 const g={schemaVersion:'research-workspace-publication-approval-v5',approvalId:'TEST_GRANT',actorId:'TEST_ADMIN',state:'APPROVED',scope:'ADMIN_RESEARCH_SHARED',action:'PUBLISH_RESEARCH_REGISTRY',root:out,mode:'OFFLINE_TEST',planDigest:plan.planDigest,policySha256:plan.policySha256,expectedPreviousPolicySha256:null,validFrom:'2026-09-25T06:00:00.000Z',expiresAt:'2026-09-25T06:15:00.000Z',executionAuthority:'NONE',actualOrders:0};
 await writeFile(join(grants,'approval-TEST_GRANT.json'),bytes(g),{mode:0o600});let resolutions=0;
 const authorize=createWorkspaceApprovalVerifier({root:out,mode:'OFFLINE_TEST',clock:()=>POLICY.now,loadApproval:createWorkspaceApprovalFileReader(grants),resolvePrincipal:async()=>{resolutions++;return {actorId:'TEST_ADMIN',admin:true,checkedAt:POLICY.now};}});
 const publish=createWorkspaceRegistryPublisher({root:out,mode:'OFFLINE_TEST',clock:()=>POLICY.now,loadSanitizedSnapshot:async()=>SOURCE,authorizePublication:authorize});
 assert.equal((await publish({plan,approval:'TEST_GRANT',expectedPreviousPolicySha256:null})).status,'PUBLISHED');assert.equal(resolutions,2);
 const response={setHeader(){},status(){return this;},json(x){this.body=x;return this;}};
 await createStoredWorkspaceHandler({root:out,authorize:async()=>true,loadSanitizedSnapshot:async()=>SOURCE,clock:()=>POLICY.now})({method:'GET',query:{group:'CRYPTO'}},response);
 const parsed=parseResearchWorkspaceResponse(response.body);assert.equal(parsed.strategies[0].run.netReturn,-.025);assert.equal(response.body.workspace.authority.actualOrders,0);
 // Permission revocation blocks even idempotent publish acknowledgement; disk stays readable.
 g.state='REVOKED';await writeFile(join(grants,'approval-TEST_GRANT.json'),bytes(g),{mode:0o600});
 await assert.rejects(()=>publish({plan,approval:'TEST_GRANT',expectedPreviousPolicySha256:null}),/NOT_AUTHORIZED/);
 assert.equal((await createResearchWorkspaceStore(out).openSnapshot()).policySha256,plan.policySha256);
});

test('same digest cannot acquire conflicting classification via another role',async t=>{const f=await fixture(t);f.m.artifacts.push({...f.m.artifacts[0],kind:'RESULT',dataClass:'OBSERVED'});const d=await f.save();await assert.rejects(()=>openReviewedWorkspaceArchive({root:f.root,manifestSha256:d,now:POLICY.now}),/CLASSIFICATION_CONFLICT/);});
