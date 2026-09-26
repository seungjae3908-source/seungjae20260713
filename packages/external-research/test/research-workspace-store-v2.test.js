import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createResearchWorkspaceStore, createStoredWorkspaceHandler } from '../src/research-workspace-store-v2.js';
import { parseResearchWorkspaceResponse, filterResearchStrategies } from '../../../stock-analyzer/src/lib/research-workspace-response.js';
import { buildResearchWorkspace, strategyDigest, backtestProjectionDigest } from '../src/research-workspace-v1.js';
const load = name => readFile(new URL(`./fixtures/research-workspace-v2/${name}.json`,import.meta.url),'utf8').then(JSON.parse);
const [source,registry,policy] = await Promise.all(['snapshot','registry','policy'].map(load));
const sha = raw => createHash('sha256').update(raw).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'workspace-v2-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=JSON.stringify(registry),digest=sha(bytes);
  const p={schemaVersion:'research-workspace-store-policy-v2',expectedSourceHeadSha:policy.expectedSourceHeadSha,maxAgeMs:policy.maxAgeMs,registrySha256:digest,scope:'ADMIN_RESEARCH_SHARED',executionAuthority:'NONE'};
  await writeFile(join(root,`registry-${digest}.json`),bytes,{mode:0o600});
  await writeFile(join(root,'policy.json'),JSON.stringify(p),{mode:0o600});
  return {root,p,bytes,path:join(root,`registry-${digest}.json`)};
}
function response(){return {headers:{},statusCode:200,body:null,setHeader(k,v){this.headers[k]=v;},status(c){this.statusCode=c;return this;},json(b){this.body=b;return this;}};}
function handler(root,options={}){return createStoredWorkspaceHandler({root,authorize:async req=>req.testAdmin===true,loadSanitizedSnapshot:async()=>structuredClone(source),clock:()=>policy.now,...options});}
const rawView = () => {
  const r = structuredClone(registry), e = r.entries[0];
  e.run = {schemaVersion:'research-linked-backtest-v1',strategyDigest:strategyDigest(e),strategyId:e.strategyId,version:e.version,market:e.market,timeframe:e.timeframe,runId:'TEST_ONLY_RUN',resultDigest:'c'.repeat(64),datasetDigest:'d'.repeat(64),codeSha:'a'.repeat(40),startAt:'2026-09-01T00:00:00.000Z',endAt:'2026-09-24T00:00:00.000Z',completedAt:policy.now,tradeCount:1,netReturn:-.01,maxDrawdown:.02,costsIncluded:true,validationClass:'EXPLORATORY',executionAuthority:'NONE',actualOrders:0,canonicalSampleDelta:0};
  e.run.summaryDigest=backtestProjectionDigest(e.run);
  return structuredClone({available:true,workspace:buildResearchWorkspace({videoEvidence:source,registry:r,policy})});
};

test('store requires absolute server-owned root',()=>assert.throws(()=>createResearchWorkspaceStore('../data'),/ABSOLUTE/));
test('missing store does not create files',async t=>{const f=await fixture(t);const r=response();await handler(join(f.root,'absent'))({method:'GET',testAdmin:true},r);assert.equal(r.body.reason,'TRUST_POLICY_UNAVAILABLE');});
test('pinned registry reads exact bytes',async t=>{const f=await fixture(t),s=await createResearchWorkspaceStore(f.root).openSnapshot();assert.deepEqual(await s.loadRegistry(),registry);assert.equal(s.policy.expectedSourceHeadSha,policy.expectedSourceHeadSha);});
test('read does not change policy or registry',async t=>{const f=await fixture(t),before=await readFile(f.path);await (await createResearchWorkspaceStore(f.root).openSnapshot()).loadRegistry();assert.deepEqual(await readFile(f.path),before);});
test('registry byte modification rejected',async t=>{const f=await fixture(t),s=await createResearchWorkspaceStore(f.root).openSnapshot();await writeFile(f.path,'{}');await assert.rejects(()=>s.loadRegistry(),/REGISTRY_BYTES_MISMATCH/);});
test('policy replacement cannot change a pinned request',async t=>{const f=await fixture(t),s=await createResearchWorkspaceStore(f.root).openSnapshot();await writeFile(join(f.root,'policy.json'),JSON.stringify({...f.p,registrySha256:'f'.repeat(64)}));assert.deepEqual(await s.loadRegistry(),registry);});
test('new request sees replacement policy rather than cached data',async t=>{const f=await fixture(t),store=createResearchWorkspaceStore(f.root);await store.openSnapshot();await writeFile(join(f.root,'policy.json'),JSON.stringify({...f.p,registrySha256:'f'.repeat(64)}));await assert.rejects(() => store.openSnapshot().then(s=>s.loadRegistry()),/ENOENT/);});
for(const [key,value] of [['maxAgeMs',0],['maxAgeMs','3600'],['registrySha256','../../key'],['expectedSourceHeadSha','invalid'],['scope','PUBLIC'],['executionAuthority','LIVE']]) test(`invalid policy ${key}=${value} rejected`,async t=>{const f=await fixture(t);await writeFile(join(f.root,'policy.json'),JSON.stringify({...f.p,[key]:value}));await assert.rejects(()=>createResearchWorkspaceStore(f.root).openSnapshot(),/STORE_POLICY_INVALID/);});
test('policy does not accept unreviewed extra settings',async t=>{const f=await fixture(t);await writeFile(join(f.root,'policy.json'),JSON.stringify({...f.p,autoTrade:true}));await assert.rejects(()=>createResearchWorkspaceStore(f.root).openSnapshot(),/STORE_POLICY_INVALID/);});
test('policy symlink rejected',async t=>{const f=await fixture(t);await rm(join(f.root,'policy.json'));await symlink(f.path,join(f.root,'policy.json'));await assert.rejects(()=>createResearchWorkspaceStore(f.root).openSnapshot());});
test('registry symlink rejected',async t=>{const f=await fixture(t),s=await createResearchWorkspaceStore(f.root).openSnapshot();await rm(f.path);await symlink(join(f.root,'policy.json'),f.path);await assert.rejects(()=>s.loadRegistry());});
test('nonregular registry rejected',async t=>{const f=await fixture(t),s=await createResearchWorkspaceStore(f.root).openSnapshot();await rm(f.path);await symlink(f.root,f.path);await assert.rejects(()=>s.loadRegistry());});
test('group-writable directory rejected',async t=>{const f=await fixture(t);await chmod(f.root,0o770);await assert.rejects(()=>createResearchWorkspaceStore(f.root).openSnapshot(),/UNSAFE_STORE_DIRECTORY/);});
test('world-writable file rejected',async t=>{const f=await fixture(t);await chmod(join(f.root,'policy.json'),0o666);await assert.rejects(()=>createResearchWorkspaceStore(f.root).openSnapshot(),/UNSAFE_STORE_FILE/);});
test('oversized policy rejected',async t=>{const f=await fixture(t);await writeFile(join(f.root,'policy.json'),' '.repeat(8193));await assert.rejects(()=>createResearchWorkspaceStore(f.root).openSnapshot(),/UNSAFE_STORE_FILE/);});
test('oversized registry rejected',async t=>{const f=await fixture(t),s=await createResearchWorkspaceStore(f.root).openSnapshot();await writeFile(f.path,' '.repeat(2*1024*1024+1));await assert.rejects(()=>s.loadRegistry(),/UNSAFE_STORE_FILE/);});
test('unauthorized user cannot read even a valid store',async t=>{const f=await fixture(t),r=response();let reads=0;await handler(f.root,{loadSanitizedSnapshot:async()=>{reads++;return source;}})({method:'GET'},r);assert.equal(r.statusCode,403);assert.equal(reads,0);});
for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])test(`${method} cannot touch store`,async()=>{const r=response();await handler('/missing')({method,testAdmin:true},r);assert.equal(r.statusCode,405);});
test('missing source not relabeled empty successful data',async t=>{const f=await fixture(t),r=response();await handler(f.root,{loadSanitizedSnapshot:async()=>null})({method:'GET',testAdmin:true},r);assert.equal(r.body.workspace.sourceCount,null);assert.equal(r.body.workspace.sourceState,'MISSING');});
test('credential-bearing loader exceptions redacted',async t=>{const f=await fixture(t),r=response();await handler(f.root,{loadSanitizedSnapshot:async()=>{throw new Error('api_key=top-secret');}})({method:'GET',testAdmin:true},r);assert.ok(!JSON.stringify(r.body).includes('top-secret'));});
test('registry corruption reported not replaced with cached success',async t=>{const f=await fixture(t),r=response();await writeFile(f.path,'{}');await handler(f.root)({method:'GET',testAdmin:true},r);assert.equal(r.body.workspace.registryState,'UNAVAILABLE');assert.equal(r.body.workspace.strategies.length,0);});
test('stored admin response accepted by browser contract',async t=>{const f=await fixture(t),r=response();await handler(f.root)({method:'GET',testAdmin:true},r);const parsed=parseResearchWorkspaceResponse(r.body);assert.equal(parsed.available,true);assert.equal(parsed.strategies.length,2);assert.equal(filterResearchStrategies(parsed.strategies,'STOCK','ALL').length,1);assert.equal(filterResearchStrategies(parsed.strategies,'CRYPTO','CRYPTO_SPOT').length,1);});
test('query cannot replace trusted SHA or registry path',async t=>{const f=await fixture(t),r=response();await handler(f.root)({method:'GET',testAdmin:true,query:{expectedSourceHeadSha:'bad',registry:'/etc/passwd'}},r);assert.equal(r.body.workspace.registryState,'READABLE');});
test('concurrent reads use isolated snapshots',async t=>{const f=await fixture(t),h=handler(f.root),a=response(),b=response();await Promise.all([h({method:'GET',testAdmin:true,query:{group:'STOCK'}},a),h({method:'GET',testAdmin:true,query:{group:'CRYPTO'}},b)]);assert.equal(a.body.workspace.strategies[0].market,'US_STOCK');assert.equal(b.body.workspace.strategies[0].market,'CRYPTO_SPOT');});

test('native HTTP exercises real GET, auth and method handling',async t=>{
 const f=await fixture(t),h=handler(f.root);const server=createServer((req,res)=>{
   const u=new URL(req.url,'http://localhost');req.query=Object.fromEntries(u.searchParams);req.testAdmin=req.headers.authorization==='Bearer LOCAL_TEST_ONLY';
   res.status=function(c){this.statusCode=c;return this;};res.json=function(b){this.setHeader('content-type','application/json');this.end(JSON.stringify(b));return this;};void h(req,res);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/research/video/evidence/workspace`;
 const denied=await fetch(url);assert.equal(denied.status,403);
 const ok=await fetch(url+'?group=CRYPTO',{headers:{authorization:'Bearer LOCAL_TEST_ONLY'}});assert.equal(ok.status,200);assert.match(ok.headers.get('cache-control'),/no-store/);assert.equal(parseResearchWorkspaceResponse(await ok.json()).strategies.length,1);
 const post=await fetch(url,{method:'POST',headers:{authorization:'Bearer LOCAL_TEST_ONLY'}});assert.equal(post.status,405);
});

for(const [name,mutate] of [
 ['authority',v=>v.workspace.authority.actualOrders=1],['apply permission',v=>v.workspace.strategies[0].actions.liveApply=true],
 ['source link',v=>v.workspace.sources[0].url='javascript:alert(1)'],['market',v=>v.workspace.strategies[0].market='ALL'],
 ['count',v=>v.workspace.sourceCount=9],['missing versus zero',v=>{v.workspace.sourceState='MISSING';v.workspace.sourceCount=0;}],
 ['bad run',v=>v.workspace.strategies.find(s=>s.run).run.netReturn='15'],['fake daily target',v=>v.workspace.strategies.find(s=>s.run).run.dailyReturn=.03],
 ['duplicate version',v=>v.workspace.strategies.push(v.workspace.strategies[0])],
])test(`browser rejects ${name}`,()=>{const raw=rawView();mutate(raw);assert.throws(()=>parseResearchWorkspaceResponse(raw),/INVALID/);});
test('unavailable provider message is not exposed verbatim',()=>assert.deepEqual(parseResearchWorkspaceResponse({available:false,reason:'/private/path'}),{available:false,reason:'WORKSPACE_UNAVAILABLE'}));
test('UI parser does not mutate API data',()=>{const raw=rawView(),before=JSON.stringify(raw);parseResearchWorkspaceResponse(raw);assert.equal(JSON.stringify(raw),before);});
test('zero selected market is not silently broadened',()=>{const p=parseResearchWorkspaceResponse(rawView());assert.equal(filterResearchStrategies(p.strategies,'CRYPTO','CRYPTO_FUTURES').length,0);});
