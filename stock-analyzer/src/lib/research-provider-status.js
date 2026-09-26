/** Strict non-secret readiness projection; configuration never proves provider connectivity. */
export function parseResearchProviderStatus(raw) {
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
  const check=x=>{if(!x)throw new Error('PROVIDER_STATUS_INVALID');};
  check(exact(raw,['schemaVersion','checkedAt','source','scope','providers','unmappedGenericCredential','authority']));
  check(raw.schemaVersion==='research-provider-readiness-v8'&&raw.source==='API_PROCESS'&&raw.scope==='SELECTED_RUNTIME_ONLY');
  check(typeof raw.checkedAt==='string'&&Number.isFinite(Date.parse(raw.checkedAt))&&new Date(raw.checkedAt).toISOString()===raw.checkedAt);
  check(typeof raw.unmappedGenericCredential==='boolean'&&Array.isArray(raw.providers)&&raw.providers.length===3);
  const a=raw.authority;
  check(exact(a,['executionAuthority','providerCalls','environmentMutated','automaticActivation'])&&a.executionAuthority==='NONE'&&a.providerCalls===0&&a.environmentMutated===false&&a.automaticActivation===false);
  const providers=raw.providers.map((p,i)=>{
    check(exact(p,['provider','credentialState','modelState','callVerified','quotaState','billingState']));
    check(p.provider===['youtube','gemini','groq'][i]&&['PRESENT','MISSING_IN_SELECTED_RUNTIME','INVALID','CONFLICT'].includes(p.credentialState));
    check(['NOT_APPLICABLE','DEFAULT_NOT_RESOLVED','EXPLICIT','INVALID','CONFLICT'].includes(p.modelState));
    check(p.callVerified===false&&p.quotaState==='NOT_CHECKED'&&p.billingState==='NOT_CHECKED');
    return {provider:p.provider,credentialState:p.credentialState,modelState:p.modelState};
  });
  return {checkedAt:raw.checkedAt,unmappedGenericCredential:raw.unmappedGenericCredential,providers};
}
