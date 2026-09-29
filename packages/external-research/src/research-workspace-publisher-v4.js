/** Review-first publication library. No HTTP write route, provider, scheduler or trading client. */
import { constants } from 'node:fs';
import { lstat, open, realpath, link, rename, unlink } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildResearchWorkspace, evidenceDigest } from './research-workspace-v1.js';
import { createResearchWorkspaceStore } from './research-workspace-store-v2.js';

const digest = x => createHash('sha256').update(x).digest('hex');
const bytes = x => Buffer.from(JSON.stringify(x) + '\n');
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const iso = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const check = (yes, code) => { if (!yes) fail(code); };
const prepared = new WeakMap();
const LIMIT = 2 * 1024 * 1024;
const copy = x => JSON.parse(JSON.stringify(x));
const without = (x, keys) => Object.fromEntries(Object.entries(x).filter(([k]) => !keys.includes(k)));

/** Validates actual artifact bytes, not just caller-supplied digest strings.
 * loadArtifact is a trusted bounded archive reader; never resolve a URL from a video or HTTP body.
 * Archive classification and publication approval are distinct trust inputs, not inferred by AI.
 */
export async function prepareWorkspacePublication({ videoEvidence, registry, policy, loadArtifact }) {
  check(typeof loadArtifact === 'function', 'ARTIFACT_READER_REQUIRED');
  const first = buildResearchWorkspace({ videoEvidence, registry, policy });
  check(first.sourceState === 'MEASURED' && first.registryState === 'READABLE', 'PUBLICATION_INPUT_INVALID');
  const source = copy(videoEvidence), data = copy(registry), trust = copy(policy);
  const registryBytes = bytes(data);
  check(registryBytes.length <= LIMIT && bytes(source).length <= LIMIT, 'PUBLICATION_TOO_LARGE');
  check(data.entries.length > 0, 'EMPTY_PUBLICATION_REQUIRES_SEPARATE_REVOCATION');
  const verified = new Map();
  async function artifact(kind, expectedDigest) {
    check(hash(expectedDigest), 'ARTIFACT_DIGEST_INVALID');
    if (verified.has(expectedDigest)) return verified.get(expectedDigest);
    check(verified.size < 256, 'ARTIFACT_COUNT_EXCEEDED');
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(Object.assign(new Error('ARTIFACT_READ_TIMEOUT'), { code: 'ARTIFACT_READ_TIMEOUT' }));
    }, 3000); });
    let result;
    try { result = await Promise.race([Promise.resolve().then(() => loadArtifact({kind, digest:expectedDigest, signal:controller.signal})), timeout]); }
    catch (e) { if (e?.code === 'ARTIFACT_READ_TIMEOUT') throw e; fail('ARTIFACT_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
    check(result && (Buffer.isBuffer(result.bytes) || result.bytes instanceof Uint8Array), 'ARTIFACT_BYTES_REQUIRED');
    const raw = Buffer.from(result.bytes);
    check(raw.length > 0 && raw.length <= LIMIT && digest(raw) === expectedDigest, 'ARTIFACT_BYTES_MISMATCH');
    check(['OBSERVED','SYNTHETIC'].includes(result.dataClass), 'ARTIFACT_CLASSIFICATION_REQUIRED');
    const item = { raw, dataClass:result.dataClass }; verified.set(expectedDigest, item); return item;
  }
  function json(raw) { try { return JSON.parse(raw.toString('utf8')); } catch { fail('ARTIFACT_JSON_INVALID'); } }
  for (const e of data.entries) {
    const p = e.contentProof;
    await artifact('CONTENT_INPUT', p.inputDigest);
    const output = json((await artifact('CONTENT_OUTPUT', p.outputDigest)).raw);
    const expected = { schemaVersion:'research-workspace-content-artifact-v1', sourceId:e.sourceId,
      receiptId:p.receiptId, accessLevel:p.accessLevel, provider:p.provider, model:p.model,
      completedAt:p.completedAt, inputDigest:p.inputDigest,
      segments:e.segments.map(s => without(s, ['contentDigest'])) };
    check(evidenceDigest(output) === evidenceDigest(expected), 'CONTENT_RECEIPT_MISMATCH');
    if (e.run !== null && e.run !== undefined) {
      const result = json((await artifact('RESULT', e.run.resultDigest)).raw);
      check(evidenceDigest(result) === evidenceDigest({ schemaVersion:'research-workspace-result-artifact-v1',
        run:without(e.run, ['resultDigest','summaryDigest']) }), 'RESULT_ARTIFACT_MISMATCH');
    }
  }
  const storePolicy = {schemaVersion:'research-workspace-store-policy-v2',expectedSourceHeadSha:trust.expectedSourceHeadSha,
    maxAgeMs:trust.maxAgeMs,registrySha256:digest(registryBytes),scope:'ADMIN_RESEARCH_SHARED',executionAuthority:'NONE'};
  const policyBytes = bytes(storePolicy);
  const artifactDigests = [...verified.keys()].sort();
  const dataClass = [...verified.values()].some(x => x.dataClass === 'SYNTHETIC') ? 'SYNTHETIC' : 'OBSERVED';
  const descriptor = {schemaVersion:'research-workspace-publication-plan-v4',sourceDigest:evidenceDigest(source),
    sourceSnapshotDigest:first.sourceSnapshotDigest,registrySha256:storePolicy.registrySha256,
    policySha256:digest(policyBytes),expectedSourceHeadSha:trust.expectedSourceHeadSha,maxAgeMs:trust.maxAgeMs,
    preparedAt:trust.now,sourceObservedAt:source.snapshotProvenance.observedAt,dataClass,
    strategyCount:first.strategies.length,runCount:first.strategies.filter(x=>x.run).length,artifactDigests,
    semanticReview:'NOT_PERFORMED',independentOos:false,executionAuthority:'NONE',actualOrders:0,canonicalSampleDelta:0};
  const plan = Object.freeze({...descriptor,artifactDigests:Object.freeze(artifactDigests),planDigest:evidenceDigest(descriptor)});
  prepared.set(plan, {source,data,trust,registryBytes,policyBytes});
  return plan;
}

const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
async function readBounded(path, limit, missing = false) {
  let file;
  try { file = await open(path, READ); } catch (e) { if (missing && e.code === 'ENOENT') return null; fail('PUBLICATION_FILE_UNSAFE'); }
  try {
    const a = await file.stat();
    check(a.isFile() && a.nlink === 1 && !(a.mode & 0o022) && a.uid === process.geteuid() && a.size <= limit, 'PUBLICATION_FILE_UNSAFE');
    const buffer = Buffer.alloc(limit+1); let n=0;
    while (n < buffer.length) { const r=await file.read(buffer,n,buffer.length-n,n); if (!r.bytesRead) break; n+=r.bytesRead; }
    const b=await file.stat();
    check(n<=limit && n===a.size && a.size===b.size && a.ctimeMs===b.ctimeMs && a.mtimeMs===b.mtimeMs, 'PUBLICATION_FILE_CHANGED');
    return buffer.subarray(0,n);
  } finally { await file.close(); }
}
async function newFile(path, raw) {
  const h=await open(path,NEW,0o600);
  try { await h.writeFile(raw); await h.sync(); } finally { await h.close(); }
}

/** Only a trusted server-side caller may supply authorization. No default approval, no CLI apply.
 * POSIX local filesystem, private parent directory, same-UID writers trusted and cooperative.
 * Process crashes leave the exclusive lock in place. No unsafe timed lock stealing.
 */
export function createWorkspaceRegistryPublisher({ root, authorizePublication, loadSanitizedSnapshot,
  clock=()=>new Date().toISOString(), mode='REVIEWED_RUNTIME', testCheckpoint }) {
  check(process.platform === 'linux' && typeof process.geteuid === 'function', 'LINUX_LOCAL_STORE_REQUIRED');
  check(typeof root==='string' && isAbsolute(root) && root===resolve(root), 'ABSOLUTE_CANONICAL_ROOT_REQUIRED');
  check(typeof authorizePublication==='function' && typeof loadSanitizedSnapshot==='function' && typeof clock==='function', 'PUBLISHER_DEPENDENCIES_REQUIRED');
  check(['REVIEWED_RUNTIME','OFFLINE_TEST'].includes(mode), 'PUBLICATION_MODE_INVALID');
  check(testCheckpoint===undefined || mode==='OFFLINE_TEST' && typeof testCheckpoint==='function', 'FAULT_INJECTION_TEST_ONLY');
  return async function publish({plan, approval, expectedPreviousPolicySha256}) {
    const secret=prepared.get(plan); check(secret, 'PREPARED_PLAN_REQUIRED');
    check(expectedPreviousPolicySha256===null || hash(expectedPreviousPolicySha256), 'PREVIOUS_POLICY_REQUIRED');
    check(mode==='OFFLINE_TEST' || plan.dataClass==='OBSERVED', 'SYNTHETIC_RUNTIME_PUBLICATION_FORBIDDEN');
    const now=clock(); check(iso(now) && now>=plan.preparedAt, 'PUBLICATION_TIME_INVALID');
    const request=Object.freeze({scope:'ADMIN_RESEARCH_SHARED',action:'PUBLISH_RESEARCH_REGISTRY',root,mode,
      planDigest:plan.planDigest,policySha256:plan.policySha256,expectedPreviousPolicySha256,now,
      executionAuthority:'NONE',actualOrders:0});
    let permitted=false;
    try { permitted=await authorizePublication(request,approval)===true; } catch { /* No exception or credential leakage. */ }
    check(permitted,'PUBLICATION_NOT_AUTHORIZED');
    let currentSource;
    try { currentSource=await loadSanitizedSnapshot(); } catch { fail('PUBLICATION_SOURCE_UNAVAILABLE'); }
    check(evidenceDigest(currentSource)===plan.sourceDigest,'PUBLICATION_SOURCE_CHANGED');
    const latest=buildResearchWorkspace({videoEvidence:currentSource,registry:secret.data,policy:{...secret.trust,now}});
    check(latest.sourceState==='MEASURED' && latest.registryState==='READABLE','PUBLICATION_SOURCE_EXPIRED');
    const dir=await lstat(root);
    check(dir.isDirectory() && !dir.isSymbolicLink() && !(dir.mode & 0o022) && dir.uid===process.geteuid()
      && await realpath(root)===root,'PUBLICATION_ROOT_UNSAFE');
    const directory=await open(root,READ | constants.O_DIRECTORY);
    let lock=null,lockStat=null,committed=false;
    const temporary=new Set(),lockPath=join(root,'.publish.lock');
    async function sameRoot() {
      const a=await directory.stat(),b=await lstat(root);
      check(!b.isSymbolicLink() && a.dev===b.dev && a.ino===b.ino && !(b.mode & 0o022),'PUBLICATION_ROOT_CHANGED');
    }
    async function stage(raw) {
      await sameRoot();const path=join(root,`.stage-${randomUUID()}`);temporary.add(path);await newFile(path,raw);return path;
    }
    async function immutable(name,raw) {
      const dst=join(root,name),old=await readBounded(dst,LIMIT,true);
      if(old!==null){check(old.equals(raw),'IMMUTABLE_FILE_CONFLICT');return;}
      const tmp=await stage(raw);await sameRoot();
      try { await link(tmp,dst); } catch(e) {
        if(e.code!=='EEXIST')throw e;
        const existing=await readBounded(dst,LIMIT);check(existing.equals(raw),'IMMUTABLE_FILE_CONFLICT');
      }
      await unlink(tmp);temporary.delete(tmp);
      check((await readBounded(dst,LIMIT)).equals(raw),'IMMUTABLE_READBACK_FAILED');
    }
    const policyPath=join(root,'policy.json');
    const previous=async()=>{const r=await readBounded(policyPath,8192,true);return r===null?null:digest(r);};
    const publicationId=evidenceDigest({root,planDigest:plan.planDigest,expectedPreviousPolicySha256,mode});
    const receipt=bytes({schemaVersion:'research-workspace-publication-receipt-v4',publicationId,planDigest:plan.planDigest,
      policySha256:plan.policySha256,registrySha256:plan.registrySha256,expectedPreviousPolicySha256,
      sourceDigest:plan.sourceDigest,artifactDigests:plan.artifactDigests,dataClass:plan.dataClass,
      state:'PREPARED_CHECK_POLICY_FOR_COMMIT',mode,executionAuthority:'NONE',actualOrders:0,canonicalSampleDelta:0});
    const receiptName=`publication-${publicationId}.json`;
    try {
      try { lock=await open(lockPath,NEW,0o600); } catch(e) { if(e.code==='EEXIST')fail('PUBLICATION_BUSY'); throw e; }
      lockStat=await lock.stat();await lock.writeFile(bytes({publicationId,pid:process.pid,createdAt:now}));await lock.sync();
      await directory.sync();
      const current=await previous();
      if(current===plan.policySha256){
        const old=await readBounded(join(root,receiptName),64*1024,true);
        check(old!==null && old.equals(receipt),'UNRECOGNIZED_EXISTING_PUBLICATION');
        const session=await createResearchWorkspaceStore(root).openSnapshot();await session.loadRegistry();
        return {status:'ALREADY_PUBLISHED',publicationId,policySha256:plan.policySha256,registrySha256:plan.registrySha256};
      }
      check(current===expectedPreviousPolicySha256,'STALE_PREVIOUS_POLICY');
      if(current!==null)await (await createResearchWorkspaceStore(root).openSnapshot()).loadRegistry();
      await immutable(`registry-${plan.registrySha256}.json`,secret.registryBytes);
      await immutable(receiptName,receipt);await directory.sync();
      if(testCheckpoint)await testCheckpoint('BEFORE_SWITCH');
      const stagedPolicy=await stage(secret.policyBytes);
      check(await previous()===expectedPreviousPolicySha256,'STALE_PREVIOUS_POLICY');
      // Approval and freshness may expire while artifacts are staged. Recheck before the commit.
      const commitTime=clock();
      check(iso(commitTime) && commitTime>=now,'PUBLICATION_TIME_INVALID');
      const stillFresh=buildResearchWorkspace({videoEvidence:currentSource,registry:secret.data,policy:{...secret.trust,now:commitTime}});
      check(stillFresh.sourceState==='MEASURED','PUBLICATION_SOURCE_EXPIRED');
      let stillAllowed=false;
      try { stillAllowed=await authorizePublication(Object.freeze({...request,now:commitTime}),approval)===true; } catch {}
      check(stillAllowed,'PUBLICATION_NOT_AUTHORIZED');
      await sameRoot();await rename(stagedPolicy,policyPath);temporary.delete(stagedPolicy);committed=true;
      await directory.sync();
      if(testCheckpoint)await testCheckpoint('AFTER_SWITCH');
      const session=await createResearchWorkspaceStore(root).openSnapshot();
      check(session.policySha256===plan.policySha256,'POLICY_READBACK_FAILED');
      check(evidenceDigest(await session.loadRegistry())===evidenceDigest(secret.data),'REGISTRY_READBACK_FAILED');
      return {status:'PUBLISHED',publicationId,policySha256:plan.policySha256,registrySha256:plan.registrySha256,
        sourceState:latest.sourceState,strategyCount:latest.strategies.length,actualOrders:0,canonicalSampleDelta:0};
    } catch(e) {
      if(committed)fail('PUBLICATION_COMMIT_UNCERTAIN_READBACK_REQUIRED');
      if(e?.code && /^[A-Z_]+$/.test(e.code))throw e;
      fail('PUBLICATION_FAILED_BEFORE_SWITCH');
    } finally {
      // Never delete another writer's lock; never automatically steal a crash-stale lock.
      for(const tmp of temporary)await unlink(tmp).catch(()=>{});
      if(lock){await lock.close();const s=await lstat(lockPath).catch(()=>null);
        if(s && lockStat && s.dev===lockStat.dev && s.ino===lockStat.ino)await unlink(lockPath);}
      await directory.close();
    }
  };
}
