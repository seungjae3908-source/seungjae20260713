/** Current exact-plan approval checks. No approval minting, HTTP routes or implicit grants. */
import { isAbsolute, resolve } from 'node:path';
import { createPrivateReviewedReader } from './research-workspace-archive-v5.js';
import { evidenceDigest } from './research-workspace-v1.js';
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const iso = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(x);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x,keys) => plain(x) && Object.keys(x).length === keys.length && keys.every(k=>Object.hasOwn(x,k));
const time = x => Date.parse(x);
const copy = x => structuredClone(x);
const fields = ['schemaVersion','approvalId','actorId','state','scope','action','root','mode','planDigest','policySha256',
  'expectedPreviousPolicySha256','validFrom','expiresAt','executionAuthority','actualOrders'];

/** Each invocation rereads a fixed grant file. Only a separately authorized writer may create/revoke it. */
export function createWorkspaceApprovalFileReader(root) {
  const read = createPrivateReviewedReader(root);
  return async function loadApproval(approvalId,signal) {
    if (!id(approvalId)) throw new Error('APPROVAL_ID_INVALID');
    const raw = await read(`approval-${approvalId}.json`,8192,signal);
    try { return JSON.parse(raw.toString('utf8')); } catch { throw new Error('APPROVAL_RECORD_INVALID'); }
  };
}

/** resolvePrincipal reauthenticates against canonical current profile on EVERY invocation.
 * Client only supplies an opaque ID; binding/role/expiry are never taken from client metadata.
 */
export function createWorkspaceApprovalVerifier({root,mode='REVIEWED_RUNTIME',loadApproval,resolvePrincipal,
  clock=()=>new Date().toISOString(),timeoutMs=3000}) {
  if (typeof root !== 'string' || !isAbsolute(root) || root !== resolve(root)
    || !['REVIEWED_RUNTIME','OFFLINE_TEST'].includes(mode) || typeof loadApproval !== 'function'
    || typeof resolvePrincipal !== 'function' || typeof clock !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new Error('APPROVAL_TRUST_DEPENDENCIES_REQUIRED');
  function valid(grant,request,approvalId,now) {
    if (!exact(grant,fields) || grant.schemaVersion !== 'research-workspace-publication-approval-v5'
      || grant.approvalId !== approvalId || !id(grant.actorId) || grant.state !== 'APPROVED'
      || grant.scope !== 'ADMIN_RESEARCH_SHARED' || grant.action !== 'PUBLISH_RESEARCH_REGISTRY'
      || grant.root !== root || grant.mode !== mode || !hash(grant.planDigest) || !hash(grant.policySha256)
      || !(grant.expectedPreviousPolicySha256 === null || hash(grant.expectedPreviousPolicySha256))
      || grant.executionAuthority !== 'NONE' || grant.actualOrders !== 0
      || !iso(grant.validFrom) || !iso(grant.expiresAt) || grant.validFrom > now || grant.expiresAt <= now
      || time(grant.expiresAt)-time(grant.validFrom) > 3600000) return false;
    return ['scope','action','root','mode','planDigest','policySha256','expectedPreviousPolicySha256','executionAuthority','actualOrders']
      .every(k=>grant[k]===request[k]);
  }
  return async function authorize(request,approvalId) {
    let timer; const controller = new AbortController();
    try {
      if (!id(approvalId) || !plain(request)) return false;
      const req = copy(request), started = clock();
      if (!iso(started) || !iso(req.now) || req.now > started || time(started)-time(req.now) > 30000) return false;
      const timeout = new Promise(resolve => {timer=setTimeout(()=>{controller.abort();resolve(false);},timeoutMs);});
      return await Promise.race([timeout,(async()=>{
        const first=copy(await loadApproval(approvalId,controller.signal));
        if (controller.signal.aborted || !valid(first,req,approvalId,started)) return false;
        const principal=copy(await resolvePrincipal(controller.signal));
        if (controller.signal.aborted || !plain(principal) || principal.actorId !== first.actorId
          || principal.admin !== true || !iso(principal.checkedAt) || principal.checkedAt < started) return false;
        // A revocation during remote authentication must not keep the earlier grant alive.
        const second=copy(await loadApproval(approvalId,controller.signal)), ended=clock();
        return !controller.signal.aborted && iso(ended) && ended >= started && principal.checkedAt <= ended
          && valid(second,req,approvalId,ended) && evidenceDigest(first) === evidenceDigest(second);
      })()]);
    } catch { return false; } finally { clearTimeout(timer);controller.abort(); }
  };
}
