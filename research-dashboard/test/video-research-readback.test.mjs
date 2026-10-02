import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readVideoResearchReadback } from '../video-research-readback.mjs';

const SHA='a'.repeat(40), DIGEST='b'.repeat(64);
function snapshot() {
  return {
    runtimeVersion:'video-research-public-provider-runtime-v3',status:'SUCCESS',provider:'YOUTUBE_DATA_API_V3',
    providerAccess:'OFFICIAL_PUBLIC_API',requestMode:'READ_ONLY_GET',query:'public strategy research',pagesUsed:1,
    quotaState:'UNKNOWN',credentialConfigured:true,credentialValueExposed:false,sourceCount:1,
    records:[{videoId:'abcdefghijk',canonicalUrl:'https://www.youtube.com/watch?v=abcdefghijk',title:'Public video',
      channelOrPublisher:'Channel',publishedAt:null,discoveredAt:'2026-10-02T03:00:00.000Z',language:null,durationSec:null,
      transcriptStatus:'NOT_PROVIDED',captionsKnownPresent:null,sourceTrustTier:'UNKNOWN',contentAuthority:'UNTRUSTED_EXTERNAL_DATA',
      economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'}],
    safety:{researchOnly:true,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE',paidProviderEnabled:false,
      scheduleActive:false,automaticDiscoveryEnabled:false,liveTrading:false,privateTradingApi:false,realOrderEnabled:false,
      credentialMutation:false,transcriptDownloadEnabled:false},
    snapshotProvenance:{schemaVersion:'video-research-sanitized-snapshot-v1',sourceHeadSha:SHA,observedAt:'2026-10-02T03:00:00.000Z',
      publisherMode:'LOCAL_ATOMIC_FILE',providerRuntimeVersion:'video-research-public-provider-runtime-v3',
      economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'},
  };
}
function automation() {
  return {schemaVersion:'research-video-discovery-scan-v1',status:'COMPLETE',observedAt:'2026-10-02T03:00:00.000Z',
    researchSha:SHA,provider:'YOUTUBE_DATA_API_V3',query:'public strategy research',queryIndex:0,queryCount:4,nextQueryIndex:1,
    sourceCount:1,snapshotDigest:DIGEST,providerNetworkCalls:1,invocationMode:'SYSTEMD_TIMER',scheduledInvocationObserved:true,
    reason:null,nextRequiredStep:'SOURCE_REVIEW_THEN_EXISTING_GEMINI_GROQ_ORCHESTRATOR',
    safety:{researchOnly:true,metadataDiscoveryOnly:true,transcriptDownloadEnabled:false,automaticGeminiExecution:false,
      automaticGroqExecution:false,automaticAdoption:false,paidFallback:false,economicEvidenceCredit:0,profitabilityCredit:0,
      executionAuthority:'NONE',liveTrading:false,privateTradingApiAllowed:false,realOrderEnabled:false}};
}

test('missing snapshot stays unknown and never becomes measured zero', async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-video-readback-'));
  try{
    const result=await readVideoResearchReadback(root);
    assert.equal(result.available,false);assert.equal(result.dataState,'UNKNOWN');assert.equal(result.executionAuthority,'NONE');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('sanitized snapshot and timer-mode evidence are exposed without credentials or authority', async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-video-readback-'));
  try{
    await mkdir(join(root,'video-research','current'),{recursive:true});
    await writeFile(join(root,'video-research','current','video-research-public-provider-runtime-v3.json'),JSON.stringify(snapshot()));
    await writeFile(join(root,'video-research','latest.json'),JSON.stringify(automation()));
    const result=await readVideoResearchReadback(root);
    assert.equal(result.available,true);assert.equal(result.sourceCount,1);
    assert.equal(result.automation?.scheduledInvocationObserved,true);
    assert.equal(result.automation?.invocationMode,'SYSTEMD_TIMER');
    assert.equal(result.economicEvidenceCredit,0);assert.equal(result.profitabilityCredit,0);assert.equal(result.executionAuthority,'NONE');
    assert.equal(JSON.stringify(result).includes('YOUTUBE_DATA_API_KEY'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('secret-bearing or malformed snapshot fails closed', async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-video-readback-'));
  try{
    await mkdir(join(root,'video-research','current'),{recursive:true});
    const bad={...snapshot(),apiKey:'should-never-appear'};
    await writeFile(join(root,'video-research','current','video-research-public-provider-runtime-v3.json'),JSON.stringify(bad));
    const result=await readVideoResearchReadback(root);
    assert.equal(result.available,false);assert.equal(result.reason,'VIDEO_RESEARCH_SNAPSHOT_INVALID');
  }finally{await rm(root,{recursive:true,force:true});}
});
