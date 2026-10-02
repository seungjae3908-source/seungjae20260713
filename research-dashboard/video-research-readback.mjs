import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SNAPSHOT_FILE='video-research-public-provider-runtime-v3.json';
const SHA=/^[0-9a-f]{40}$/u,DIGEST=/^[0-9a-f]{64}$/u,SAFE_CODE=/^[A-Z0-9_:-]{1,160}$/u;
const FORBIDDEN_KEY=/(?:api.?key|access.?token|refresh.?token|secret|password|private.?key)/iu;
const SAFE_CREDENTIAL_KEYS=new Set(['credentialConfigured','credentialValueExposed','credentialMutation']);
const MAX_READ_BYTES=512*1024;
const TRANSCRIPT=new Set(['AVAILABLE','UNAVAILABLE','NOT_AUTHORIZED','NOT_PROVIDED','UNSUPPORTED','PROVIDER_NOT_CONFIGURED','RATE_LIMITED','QUOTA_EXCEEDED','PARSE_FAILED','UNKNOWN']);
const TRUST=new Set(['TIER_A_OFFICIAL','TIER_B_ACADEMIC','TIER_C_PRIMARY_EXPERT','TIER_D_SECONDARY_EDUCATIONAL','TIER_E_UNVERIFIED_CREATOR','UNKNOWN']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:null;
const iso=value=>{if(typeof value!=='string'||!value.trim())return false;const d=new Date(value);return !Number.isNaN(d.getTime())&&d.toISOString()===value;};
const canonicalUrl=id=>`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
function containsForbiddenKey(value){
 if(Array.isArray(value))return value.some(containsForbiddenKey);
 const row=object(value);if(!row)return false;
 return Object.entries(row).some(([key,nested])=>SAFE_CREDENTIAL_KEYS.has(key)?containsForbiddenKey(nested):FORBIDDEN_KEY.test(key)||containsForbiddenKey(nested));
}
async function optional(path){
 let handle;
 try{
  handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await handle.stat();
  if(!before.isFile()||before.size>MAX_READ_BYTES)throw new Error('VIDEO_RESEARCH_STATE_FILE_UNSAFE');
  const bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const chunk=await handle.read(bytes,offset,bytes.length-offset,offset);if(!chunk.bytesRead)break;offset+=chunk.bytesRead;}
  const after=await handle.stat();
  if(offset!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('VIDEO_RESEARCH_STATE_FILE_CHANGED');
  return JSON.parse(bytes.toString('utf8'));
 }catch(error){if(error?.code==='ENOENT')return null;throw error;}finally{await handle?.close();}
}
function safeSnapshot(row){
 if(!object(row)||containsForbiddenKey(row)||row.runtimeVersion!=='video-research-public-provider-runtime-v3'||row.status!=='SUCCESS'||row.provider!=='YOUTUBE_DATA_API_V3'||row.providerAccess!=='OFFICIAL_PUBLIC_API'||row.requestMode!=='READ_ONLY_GET')return null;
 if(row.credentialConfigured!==true||row.credentialValueExposed!==false||typeof row.query!=='string'||!row.query.trim()||!Number.isSafeInteger(row.pagesUsed)||row.pagesUsed<0||row.pagesUsed>1||typeof row.quotaState!=='string'||!row.quotaState)return null;
 if(!Number.isSafeInteger(row.sourceCount)||row.sourceCount<0||row.sourceCount>5||!Array.isArray(row.records)||row.records.length!==row.sourceCount)return null;
 const safety=object(row.safety);
 if(!safety||safety.researchOnly!==true||safety.economicEvidenceCredit!==0||safety.profitabilityCredit!==0||safety.executionAuthority!=='NONE'||safety.paidProviderEnabled!==false||safety.scheduleActive!==false||safety.automaticDiscoveryEnabled!==false||safety.liveTrading!==false||safety.privateTradingApi!==false||safety.realOrderEnabled!==false||safety.credentialMutation!==false||safety.transcriptDownloadEnabled!==false)return null;
 const p=object(row.snapshotProvenance);
 if(!p||p.schemaVersion!=='video-research-sanitized-snapshot-v1'||!SHA.test(String(p.sourceHeadSha??''))||!iso(p.observedAt)||p.publisherMode!=='LOCAL_ATOMIC_FILE'||p.providerRuntimeVersion!=='video-research-public-provider-runtime-v3'||p.economicEvidenceCredit!==0||p.profitabilityCredit!==0||p.executionAuthority!=='NONE')return null;
 for(const raw of row.records){
  const r=object(raw);if(!r||typeof r.videoId!=='string'||!r.videoId||r.canonicalUrl!==canonicalUrl(r.videoId)||typeof r.title!=='string'||!r.title.trim())return null;
  for(const key of ['channelOrPublisher','publishedAt','discoveredAt','language'])if(r[key]!==null&&typeof r[key]!=='string')return null;
  if(r.durationSec!==null&&(!Number.isFinite(r.durationSec)||r.durationSec<0))return null;
  if(!TRANSCRIPT.has(r.transcriptStatus)||(r.captionsKnownPresent!==null&&typeof r.captionsKnownPresent!=='boolean')||!TRUST.has(r.sourceTrustTier)||r.contentAuthority!=='UNTRUSTED_EXTERNAL_DATA'||r.economicEvidenceCredit!==0||r.profitabilityCredit!==0||r.executionAuthority!=='NONE')return null;
 }
 return row;
}
function safeAutomation(row){
 if(!object(row)||row.schemaVersion!=='research-video-discovery-scan-v1'||!['COMPLETE','BLOCKED','WAITING_CONFIGURATION'].includes(row.status)||!iso(row.observedAt)||!SHA.test(String(row.researchSha??''))||row.provider!=='YOUTUBE_DATA_API_V3')return null;
 const safety=object(row.safety);
 if(!safety||safety.researchOnly!==true||safety.metadataDiscoveryOnly!==true||safety.transcriptDownloadEnabled!==false||safety.automaticGeminiExecution!==false||safety.automaticGroqExecution!==false||safety.automaticAdoption!==false||safety.paidFallback!==false||safety.economicEvidenceCredit!==0||safety.profitabilityCredit!==0||safety.executionAuthority!=='NONE'||safety.liveTrading!==false||safety.privateTradingApiAllowed!==false||safety.realOrderEnabled!==false)return null;
 if(!['MANUAL','SYSTEMD_TIMER'].includes(row.invocationMode)||typeof row.scheduledInvocationObserved!=='boolean'||!Number.isSafeInteger(row.providerNetworkCalls)||row.providerNetworkCalls<0||row.providerNetworkCalls>1)return null;
 if(row.query!==null&&(typeof row.query!=='string'||!row.query.trim()||row.query.length>120))return null;
 if(row.sourceCount!==null&&(!Number.isSafeInteger(row.sourceCount)||row.sourceCount<0||row.sourceCount>5))return null;
 if(row.snapshotDigest!==null&&!DIGEST.test(String(row.snapshotDigest)))return null;
 if(row.reason!==null&&(typeof row.reason!=='string'||!SAFE_CODE.test(row.reason)))return null;
 if(typeof row.nextRequiredStep!=='string'||!SAFE_CODE.test(row.nextRequiredStep))return null;
 return {schemaVersion:row.schemaVersion,status:row.status,observedAt:row.observedAt,researchSha:String(row.researchSha).toLowerCase(),query:row.query,sourceCount:row.sourceCount,snapshotDigest:row.snapshotDigest,providerNetworkCalls:row.providerNetworkCalls,invocationMode:row.invocationMode,scheduledInvocationObserved:row.scheduledInvocationObserved,reason:row.reason,nextRequiredStep:row.nextRequiredStep};
}
export async function readVideoResearchReadback(stateRoot){
 const root=resolve(stateRoot);let snapshot,automation;
 try{[snapshot,automation]=await Promise.all([optional(join(root,'video-research','current',SNAPSHOT_FILE)),optional(join(root,'video-research','latest.json'))]);}
 catch{return {ok:false,available:false,dataState:'UNKNOWN',reason:'VIDEO_RESEARCH_STATE_UNAVAILABLE',economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};}
 const safeAuto=safeAutomation(automation);
 if(!snapshot)return {ok:false,available:false,dataState:'UNKNOWN',reason:'VIDEO_RESEARCH_SNAPSHOT_MISSING',automation:safeAuto,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
 const evidence=safeSnapshot(snapshot);
 if(!evidence)return {ok:false,available:false,dataState:'UNKNOWN',reason:'VIDEO_RESEARCH_SNAPSHOT_INVALID',automation:safeAuto,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
 return {ok:true,available:true,dataState:'MEASURED',...evidence,automation:safeAuto,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
}
