import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SNAPSHOT_FILE = 'video-research-public-provider-runtime-v3.json';
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SAFE_CODE = /^[A-Z0-9_:-]{1,160}$/u;
const FORBIDDEN_KEY = /(?:api.?key|access.?token|refresh.?token|secret|password|private.?key)/iu;
const SAFE_CREDENTIAL_KEYS = new Set(['credentialConfigured','credentialValueExposed','credentialMutation']);
const TRANSCRIPT = new Set(['AVAILABLE','UNAVAILABLE','NOT_AUTHORIZED','NOT_PROVIDED','UNSUPPORTED','PROVIDER_NOT_CONFIGURED','RATE_LIMITED','QUOTA_EXCEEDED','PARSE_FAILED','UNKNOWN']);
const TRUST = new Set(['TIER_A_OFFICIAL','TIER_B_ACADEMIC','TIER_C_PRIMARY_EXPERT','TIER_D_SECONDARY_EDUCATIONAL','TIER_E_UNVERIFIED_CREATOR','UNKNOWN']);

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function iso(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
function containsForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  const row = object(value); if (!row) return false;
  return Object.entries(row).some(([key,nested]) => SAFE_CREDENTIAL_KEYS.has(key) ? containsForbiddenKey(nested) : FORBIDDEN_KEY.test(key) || containsForbiddenKey(nested));
}
async function optional(path) {
  try { return JSON.parse(await readFile(path,'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
function canonicalUrl(id) { return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`; }

function safeSnapshot(value) {
  const row=object(value); if(!row || containsForbiddenKey(row)) return null;
  if(row.runtimeVersion!=='video-research-public-provider-runtime-v3'||row.status!=='SUCCESS'||row.provider!=='YOUTUBE_DATA_API_V3'||row.providerAccess!=='OFFICIAL_PUBLIC_API'||row.requestMode!=='READ_ONLY_GET') return null;
  if(row.credentialConfigured!==true||row.credentialValueExposed!==false||typeof row.query!=='string'||!row.query.trim()||!Number.isSafeInteger(row.pagesUsed)||row.pagesUsed<0||row.pagesUsed>1||typeof row.quotaState!=='string'||!row.quotaState) return null;
  if(!Number.isSafeInteger(row.sourceCount)||row.sourceCount<0||row.sourceCount>5||!Array.isArray(row.records)||row.records.length!==row.sourceCount) return null;
  const safety=object(row.safety);
  if(!safety||safety.researchOnly!==true||safety.economicEvidenceCredit!==0||safety.profitabilityCredit!==0||safety.executionAuthority!=='NONE'||safety.paidProviderEnabled!==false||safety.scheduleActive!==false||safety.automaticDiscoveryEnabled!==false||safety.liveTrading!==false||safety.privateTradingApi!==false||safety.realOrderEnabled!==false||safety.credentialMutation!==false||safety.transcriptDownloadEnabled!==false) return null;
  const provenance=object(row.snapshotProvenance);
  if(!provenance||provenance.schemaVersion!=='video-research-sanitized-snapshot-v1'||!SHA.test(String(provenance.sourceHeadSha??''))||!iso(provenance.observedAt)||provenance.publisherMode!=='LOCAL_ATOMIC_FILE'||provenance.providerRuntimeVersion!=='video-research-public-provider-runtime-v3'||provenance.economicEvidenceCredit!==0||provenance.profitabilityCredit!==0||provenance.executionAuthority!=='NONE') return null;
  for(const raw of row.records){
    const record=object(raw);
    if(!record||typeof record.videoId!=='string'||!record.videoId||record.canonicalUrl!==canonicalUrl(record.videoId)||typeof record.title!=='string'||!record.title.trim()) return null;
    for(const key of ['channelOrPublisher','publishedAt','discoveredAt','language']) if(record[key]!==null&&typeof record[key]!=='string') return null;
    if(record.durationSec!==null&&(!Number.isFinite(record.durationSec)||record.durationSec<0)) return null;
    if(!TRANSCRIPT.has(record.transcriptStatus)||record.captionsKnownPresent!==null&&typeof record.captionsKnownPresent!=='boolean'||!TRUST.has(record.sourceTrustTier)||record.contentAuthority!=='UNTRUSTED_EXTERNAL_DATA'||record.economicEvidenceCredit!==0||record.profitabilityCredit!==0||record.executionAuthority!=='NONE') return null;
  }
  return row;
}

function safeAutomation(value) {
  const row=object(value); if(!row||row.schemaVersion!=='research-video-discovery-scan-v1'||!['COMPLETE','BLOCKED','WAITING_CONFIGURATION'].includes(row.status)||!iso(row.observedAt)||!SHA.test(String(row.researchSha??''))||row.provider!=='YOUTUBE_DATA_API_V3') return null;
  if(!['MANUAL','SYSTEMD_TIMER'].includes(row.invocationMode)||typeof row.scheduledInvocationObserved!=='boolean'||!Number.isSafeInteger(row.providerNetworkCalls)||row.providerNetworkCalls<0||row.providerNetworkCalls>1) return null;
  if(row.snapshotDigest!==null&&(!DIGEST.test(String(row.snapshotDigest)))) return null;
  if(row.sourceCount!==null&&(!Number.isSafeInteger(row.sourceCount)||row.sourceCount<0||row.sourceCount>5)) return null;
  if(row.query!==null&&(typeof row.query!=='string'||!row.query.trim()||row.query.length>120)) return null;
  if(row.reason!==null&&(typeof row.reason!=='string'||!SAFE_CODE.test(row.reason))) return null;
  if(typeof row.nextRequiredStep!=='string'||!SAFE_CODE.test(row.nextRequiredStep)) return null;
  const safety=object(row.safety);
  if(!safety||safety.researchOnly!==true||safety.metadataDiscoveryOnly!==true||safety.transcriptDownloadEnabled!==false||safety.automaticGeminiExecution!==false||safety.automaticGroqExecution!==false||safety.automaticAdoption!==false||safety.paidFallback!==false||safety.economicEvidenceCredit!==0||safety.profitabilityCredit!==0||safety.executionAuthority!=='NONE'||safety.liveTrading!==false||safety.privateTradingApiAllowed!==false||safety.realOrderEnabled!==false) return null;
  return {
    schemaVersion:row.schemaVersion,status:row.status,observedAt:row.observedAt,researchSha:String(row.researchSha).toLowerCase(),
    query:row.query,sourceCount:row.sourceCount,snapshotDigest:row.snapshotDigest,providerNetworkCalls:row.providerNetworkCalls,
    invocationMode:row.invocationMode,scheduledInvocationObserved:row.scheduledInvocationObserved,reason:row.reason,nextRequiredStep:row.nextRequiredStep,
  };
}

export async function readVideoResearchReadback(stateRoot) {
  const root=resolve(stateRoot);
  let snapshot,automation;
  try {
    [snapshot,automation]=await Promise.all([
      optional(join(root,'video-research','current',SNAPSHOT_FILE)),
      optional(join(root,'video-research','latest.json')),
    ]);
  } catch {
    return {ok:false,available:false,dataState:'UNKNOWN',reason:'VIDEO_RESEARCH_STATE_UNAVAILABLE',economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
  }
  if(!snapshot) return {ok:false,available:false,dataState:'UNKNOWN',reason:'VIDEO_RESEARCH_SNAPSHOT_MISSING',automation:safeAutomation(automation),economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
  const evidence=safeSnapshot(snapshot);
  if(!evidence) return {ok:false,available:false,dataState:'UNKNOWN',reason:'VIDEO_RESEARCH_SNAPSHOT_INVALID',automation:safeAutomation(automation),economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
  return {ok:true,available:true,dataState:'MEASURED',...evidence,automation:safeAutomation(automation),economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
}
