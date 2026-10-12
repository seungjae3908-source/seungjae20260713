import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptCanonicalScannerCard } from '../src/canonical-adapter.mjs';
import {V3_ECONOMIC_BRIDGE_SCHEMA,v3SignedResearchPayload,
  inspectV3SignedResearchBundle,loadV3SignedResearchBundle,
  attachV3SignedResearchEvidence} from '../src/public-v3-certified-profit-bridge.mjs';
const SHA='a'.repeat(40), DIGEST='b'.repeat(64);
const NOW=Date.parse('2026-10-12T06:00:00.000Z'),LANE={market:'US_STOCK',timeframe:'1D'};
function fixture(){
 const identity={signalId:'scanner:AAPL:one',strategyId:'US_ORB_V1',
  strategyVersion:'v1',parameterHash:'params-immutable-v1',researchCodeSha:SHA,
  market:'US_STOCK',symbol:'AAPL',timeframe:'1D',direction:'BUY',
  horizon:5,costPolicyVersion:'cost-v1',executionAuthority:'NONE'};
 const lineage={signalId:identity.signalId,strategyId:identity.strategyId,
  strategyVersion:identity.strategyVersion,parameterHash:identity.parameterHash,
  researchCodeSha:SHA,costPolicyId:'cost-v1',market:'US_STOCK',symbol:'AAPL',
  timeframe:'1D',direction:'BUY'};
 const entry={
  cardBinding:{market:'US_STOCK',symbol:'AAPL',timeframe:'1D',
   direction:'BUY',scannerSignalId:identity.signalId},
  paperIdentity:identity,
  profitEvidence:{status:'READY',market:'US_STOCK',timeframe:'1D',
   direction:'BUY',strategyVersion:'v1',costPolicyId:'cost-v1',
   executionAuthority:'NONE',expectedNetEdge:1,expectedNetReturn:1.2,
   riskRewardRatio:2,sampleSize:100},
  costPolicy:{id:'cost-v1',market:'US_STOCK',source:'EXPLICIT_RUNTIME_POLICY',
   commissionPercent:0.1,taxPercent:0.1,spreadPercent:0.05,
   slippagePercent:0.05,fundingPercent:0,latencyPercent:0.05,
   liquidityImpactPercent:0.05,partialFillImpactPercent:0.05},
  backtestQuality:{status:'verified',oos:true,walkForward:true,costsIncluded:true,
   slippageIncluded:true,lookaheadGuarded:true,survivorshipGuarded:true,
   tradeCount:100,minimumTradeCount:50,oosTradeCount:40,
   walkForwardTradeCount:40,netReturnPercent:2,expectancyPercent:1,
   profitFactor:1.5,canonicalLineage:lineage},
  independentAudit:{evidenceClass:'INDEPENDENT_CANONICAL_EVALUATION',
   pointInTimeRosterComplete:true,originalMinuteCoverageComplete:true,
   heldOutOosPass:true,walkForwardPass:true,fullCostReady:true,
   fillAndSlippageAudited:true,finalHoldoutRetuned:false,fixture:false,
   synthetic:false,replay:false,backfill:false,manual:false,
   executionAuthority:'NONE',datasetDigest:DIGEST,rosterDigest:DIGEST,
   oosReportDigest:DIGEST,walkForwardDigest:DIGEST,fillsDigest:DIGEST,
   fullCostDigest:DIGEST,independenceAuditDigest:DIGEST},
 };
 const bundle={schemaVersion:V3_ECONOMIC_BRIDGE_SCHEMA,
  issuer:'INDEPENDENT_CANONICAL_RESEARCH_EVALUATOR',
  researchCodeSha:SHA,issuedAt:new Date(NOW-5_000).toISOString(),
  expiresAt:new Date(NOW+60_000).toISOString(),
  entries:[entry],executionAuthority:'NONE'};
 const card={signalId:identity.signalId,assetClass:'stock',market:'US',
  symbol:'AAPL',action:'BUY',direction:'LONG',strategyMode:'swing',
  price:100,strongSignalEligible:true,signalGrade:'A',riskLevel:'LOW',
  dataState:'complete',dataQuality:{state:'TRUSTED',strongSignalAllowed:true},
  observedAt:new Date(NOW-5000).toISOString(),
  expiresAt:new Date(NOW+30_000).toISOString(),dataSources:['yahoo-public'],
  pricePlan:{entryZone:{from:99,to:101},stopLoss:95,targets:[110]},
  candidateRanking:{hardFilterPassed:true}};
 return {bundle,card};
}
function keys(){
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 return {privateKey,pem:publicKey.export({type:'spki',format:'pem'}).toString()};
}
function seal(bundle,privateKey){
 return {...bundle,signature:sign(null,v3SignedResearchPayload(bundle),privateKey)
  .toString('base64')};
}
test('OFF proof link means zero reads, zero authority and no optimistic PASS',async()=>{
 const link=await loadV3SignedResearchBundle({enabled:false,root:'/bad',
   fileName:'missing',publicKeyPem:'bad'});
 assert.equal(link.status,'DISABLED');
 assert.equal(link.diagnostic.linkedRecords,0);
 const {card}=fixture();
 const input=attachV3SignedResearchEvidence(card,{lane:LANE,bridge:link});
 assert.deepEqual(input,{card,timeframe:'1D'});
 assert.equal(adaptCanonicalScannerCard(input,{nowMs:NOW}).profitEligible,false);
});
test('signed structurally complete test input joins only exact scanner identity',()=>{
 const {privateKey,pem}=keys(),{bundle,card}=fixture();
 const verified=inspectV3SignedResearchBundle(seal(bundle,privateKey),
   {enabled:true,publicKeyPem:pem,expectedResearchSha:SHA,nowMs:NOW});
 assert.equal(verified.status,'SIGNED_EVIDENCE_AVAILABLE');
 const joined=attachV3SignedResearchEvidence(card,{lane:LANE,bridge:verified});
 assert.equal(joined.paperIdentity.signalId,card.signalId);
 // This test-generated signer is NOT an actual independent OOS/profit receipt.
 assert.equal(adaptCanonicalScannerCard(joined,{nowMs:NOW}).profitEligible,true);
 assert.equal(attachV3SignedResearchEvidence({...card,symbol:'MSFT'},
  {lane:LANE,bridge:verified}).profitEvidence,undefined);
 assert.equal(attachV3SignedResearchEvidence(card,
  {lane:{...LANE,market:'KR_STOCK'},bridge:verified}).profitEvidence,undefined);
 assert.equal(inspectV3SignedResearchBundle(
  {...seal(bundle,privateKey),signature:'a'.repeat(86)+'=='},
  {enabled:true,publicKeyPem:pem,expectedResearchSha:SHA,nowMs:NOW})
  .status,'SIGNATURE_INVALID');
});
test('TRAIN-only, partial costs, retuned holdout and synthetic signed metadata all fail',()=>{
 const {privateKey,pem}=keys(),{bundle}=fixture();
 for(const change of [
  x=>{x.entries[0].independentAudit.heldOutOosPass=false;},
  x=>{x.entries[0].independentAudit.originalMinuteCoverageComplete=false;},
  x=>{x.entries[0].independentAudit.finalHoldoutRetuned=true;},
  x=>{x.entries[0].independentAudit.synthetic=true;},
  x=>{x.entries[0].backtestQuality.oosTradeCount=0;},
  x=>{x.entries[0].costPolicy.slippagePercent=null;},
  x=>{x.entries[0].paperIdentity.researchCodeSha='c'.repeat(40);},
 ]){
  const modified=structuredClone(bundle);change(modified);
  const result=inspectV3SignedResearchBundle(seal(modified,privateKey),
   {enabled:true,publicKeyPem:pem,expectedResearchSha:SHA,nowMs:NOW});
  assert.equal(result.status,'INDEPENDENT_EVIDENCE_INVALID');
  assert.equal(result.records.size,0);
 }
 const dup=structuredClone(bundle);dup.entries.push(structuredClone(dup.entries[0]));
 assert.equal(inspectV3SignedResearchBundle(seal(dup,privateKey),
  {enabled:true,publicKeyPem:pem,expectedResearchSha:SHA,nowMs:NOW})
  .status,'DUPLICATE_RESEARCH_IDENTITY');
});
test('read-only archive refuses unsafe source permissions, symlink and tampered receipts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'v3-proof-'));await chmod(dir,0o700);
 const {privateKey,pem}=keys(),{bundle}=fixture(),signed=seal(bundle,privateKey);
 const file=join(dir,'signed.json');
 const req={enabled:true,root:dir,fileName:'signed.json',
   publicKeyPem:pem,expectedResearchSha:SHA,nowMs:NOW};
 try{
  assert.equal((await loadV3SignedResearchBundle(req)).status,'SOURCE_UNAVAILABLE');
  await writeFile(file,JSON.stringify(signed),{mode:0o600});
  assert.equal((await loadV3SignedResearchBundle(req)).status,'SIGNED_EVIDENCE_AVAILABLE');
  await chmod(file,0o644);
  assert.equal((await loadV3SignedResearchBundle(req)).status,'UNSAFE_PRIVATE_SOURCE');
  await chmod(file,0o600);
  const changed={...signed,entries:[{...signed.entries[0],
   profitEvidence:{...signed.entries[0].profitEvidence,expectedNetReturn:999}}]};
  await writeFile(file,JSON.stringify(changed),{mode:0o600});
  assert.equal((await loadV3SignedResearchBundle(req)).status,'SIGNATURE_INVALID');
  await writeFile(file,JSON.stringify(signed),{mode:0o600});
  await symlink(file,join(dir,'linked.json'));
  assert.equal((await loadV3SignedResearchBundle({...req,fileName:'linked.json'}))
    .status,'UNSAFE_PRIVATE_SOURCE');
  assert.equal((await loadV3SignedResearchBundle({...req,fileName:'../signed.json'}))
    .status,'NOT_CONFIGURED');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('signed profit admission is not writable or spoofable after verification',()=>{
 const {privateKey,pem}=keys(),{bundle,card}=fixture();
 const signed=seal(bundle,privateKey);
 const linked=inspectV3SignedResearchBundle(signed,
  {enabled:true,publicKeyPem:pem,expectedResearchSha:SHA,nowMs:NOW});
 assert.equal(linked.status,'SIGNED_EVIDENCE_AVAILABLE');
 const proofKey=['US_STOCK','AAPL','1D','BUY','scanner:AAPL:one'].join('|');
 assert.equal(typeof linked.records.set,'undefined');
 const accepted=attachV3SignedResearchEvidence(card,{lane:LANE,bridge:linked});
 assert.equal(accepted.profitEvidence.expectedNetEdge,1);
 signed.entries[0].profitEvidence.expectedNetEdge=999;
 assert.equal(linked.records.get(proofKey).profitEvidence.expectedNetEdge,1,
   'an original in-memory object changed post-signature cannot alter verified evidence');
 assert.throws(()=>{linked.records.get(proofKey).profitEvidence.expectedNetEdge=111;},
   TypeError);
 const forged={status:'SIGNED_EVIDENCE_AVAILABLE',
   records:new Map([[proofKey,signed.entries[0]]])};
 assert.equal(attachV3SignedResearchEvidence(card,
   {lane:LANE,bridge:forged}).profitEvidence,undefined,
   'a forged bridge object must not promote a scanner candidate');
});
