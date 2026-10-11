// Public-only research index continuity. A changing listing set can retain
// the same count; no eligible-index round is valid across such a mutation.
const DIGEST=/^[a-f0-9]{64}$/u;
export function decidePublicRosterContinuity({previousDigest,observedDigest,stale,providerErrors}) {
  const valid=typeof observedDigest==='string' && DIGEST.test(observedDigest);
  if (stale===true || !Number.isSafeInteger(providerErrors) || providerErrors!==0 || !valid)
    return Object.freeze({trusted:false,changed:false,nextDigest:previousDigest??null,reason:'ROSTER_IDENTITY_UNVERIFIED'});
  if (typeof previousDigest==='string' && DIGEST.test(previousDigest) && previousDigest!==observedDigest)
    return Object.freeze({trusted:false,changed:true,nextDigest:observedDigest,reason:'ROSTER_DIGEST_CHANGED_RESET'});
  return Object.freeze({trusted:true,changed:false,nextDigest:observedDigest,reason:'ROSTER_IDENTITY_STABLE'});
}
export function hashPublicStockSourceRoster(market,source,entries,createHash) {
  if (!['KR_STOCK','US_STOCK'].includes(market) || !Array.isArray(entries)||!entries.length
    || typeof createHash!=='function') return null;
  const ids=entries.map(x=>String(x?.ticker??'').trim().toUpperCase());
  if (ids.some(x=>!x) || new Set(ids).size!==ids.length) return null;
  ids.sort((a,b)=>a<b?-1:a>b?1:0);
  return createHash('sha256').update(JSON.stringify([market,source??'',...ids])).digest('hex');
}
