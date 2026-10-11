// Signal V3-only Korean symbol index augmentation. KRX roster provenance
// is distinct from verified market quotes, licensing or trade eligibility.
// Disabled unless an explicit research-only mode is requested by a QA caller.
export const PUBLIC_KR_PROVISIONAL_ROSTER_VERSION='public-kr-provisional-roster-v1';
export function isKrAlphanumericPublicResearchCode(value){
  return typeof value==='string'&&/^(?=[A-Z0-9]{6}$)(?=.*[A-Z])[A-Z0-9]{6}$/u.test(value);
}
export function includeProvisionalKrAlphanumericRoster(base, mode='NONE'){
 if(!['NONE','PILOT','OBSERVATION_ONLY'].includes(mode))
   throw Error('KR_ALPHA_ROSTER_MODE_INVALID');
 if(!base || !Array.isArray(base.entries))throw Error('KR_ALPHA_ROSTER_INPUT_INVALID');
 if(mode==='NONE')return Object.freeze({...base,provisionalAlphanumericCount:0,
   provisionalReadOnly:true,alphasNotVerifiedForSignals:true});
 if(base.source!=='krx-symbol-master'||base.stale===true
  ||(base.providerErrorCount??0)!==0 ||!Array.isArray(base.explainedExclusions))
   return Object.freeze({...base,provisionalAlphanumericCount:0,
     provisionalReadOnly:true,alphasNotVerifiedForSignals:true,
     rosterProvenanceBlocked:true});
 const existing=new Set(base.entries.map(x=>String(x.ticker??'').trim().toUpperCase()));
 const extra=[];
 for(const row of base.explainedExclusions){
   const code=String(row?.ticker??'').trim().toUpperCase();
   if(!isKrAlphanumericPublicResearchCode(code)
    ||row.reason!=='PUBLIC_PROVIDER_UNSUPPORTED_ALPHANUMERIC_KRX_SYMBOL'
    ||existing.has(code))continue;
   if(mode==='PILOT' && code!=='0193W0')continue;
   existing.add(code);
   extra.push(Object.freeze({
     ticker:code,name:String(row.name||code),
     market:'KR',currency:'KRW',assetType:row.assetType,
     exchange:row.exchange??null,
     // KRX listed symbol directory alone cannot certify a live Naver
     // quote, a trading action or a profitable signal.
     listingStatus:'UNKNOWN',source:'krx-symbol-master',
     publicResearchProvisional:true,
   }));
 }
 const rows=[...base.entries,...extra].sort((a,b)=>{
   const left=String(a.ticker).toUpperCase(),right=String(b.ticker).toUpperCase();
   return left<right?-1:left>right?1:0;
 });
 return Object.freeze({
   ...base,entries:Object.freeze(rows),
   totalCount:rows.length,
   partial:true,
   provisionalAlphanumericCount:extra.length,
   provisionalReadOnly:true,
   alphasNotVerifiedForSignals:true,
   rosterProvenanceBlocked:false,
   researchRosterVersion:PUBLIC_KR_PROVISIONAL_ROSTER_VERSION,
   source:'krx-symbol-master',
 });
}
