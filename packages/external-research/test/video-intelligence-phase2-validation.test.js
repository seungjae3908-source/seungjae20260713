import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptCrossrefMetadata } from '../src/index.js';
import { createResearchVideoSourceV1 } from '../src/video-intelligence.js';
import {
  assessVideoStrategyTestabilityV2,
  bindAuthorizedTranscriptToSourceV2,
  classifyVideoSourceAuthorityV2,
  clusterVideoStrategiesV2,
  createChapterIntelligenceV2,
  createVideoResearchPhase2RuntimeStateV2,
  crossValidateVideoClaimsV2,
  detectStrategyContradictionsV2,
  detectVideoSourceRelationshipV2,
  extractStrategyRulesV2,
  extractTranscriptClaimsV2,
  normalizeAuthorizedTranscriptV2,
} from '../src/video-intelligence-phase2.js';

const NOW='2026-09-12T09:35:00.000Z';
function source(id='fixture-a',publisher='Research Channel',title='VWAP lecture'){return createResearchVideoSourceV1({provider:'YOUTUBE',sourceType:'YOUTUBE_VIDEO',canonicalUrl:`https://www.youtube.com/watch?v=${id}`,videoId:id,title,channelOrPublisher:publisher,publishedAt:'2026-09-11T00:00:00Z',discoveredAt:NOW,language:'en',durationSec:600,transcriptStatus:'NOT_AUTHORIZED',transcriptSource:null,transcriptAuthorized:false,contentAccessStatus:'AVAILABLE',timestampProvenance:[]});}
function transcript(s,textA='US stock 15 minute VWAP reclaim long setup.',textB='Exit below VWAP.'){return normalizeAuthorizedTranscriptV2({source:s,status:'AVAILABLE',transcriptSource:'AUTHORIZED_FIXTURE',authorized:true,language:'en',segments:[{startSec:10,endSec:20,text:textA,source:'AUTHORIZED_FIXTURE'},{startSec:21,endSec:30,text:textB,source:'AUTHORIZED_FIXTURE'}]});}
async function minedRecord(s,t,{opposing=false,missingTimeframe=false}={}){const bound=bindAuthorizedTranscriptToSourceV2({source:s,transcript:t});const claims=await extractTranscriptClaimsV2({transcript:t,extractor:({segments})=>[{segmentId:segments[0].segmentId,claimType:'STRATEGY_RULE',text:'VWAP entry',uncertainty:'RULE_EXPLICIT'},{segmentId:segments[1].segmentId,claimType:'STRATEGY_RULE',text:'VWAP exit',uncertainty:'RULE_EXPLICIT'}]});const extracted=await extractStrategyRulesV2({source:bound,transcript:t,claimResult:claims,extractor:({claims:rows})=>({market:'US_STOCK',assetClass:'EQUITY',symbolScope:['US_STOCK'],side:'LONG',timeframe:missingTimeframe?null:'15m',strategyFamily:'VWAP_RECLAIM',categories:['TECHNICAL_ANALYSIS'],holdingPeriod:null,executionAssumptions:[],fieldProvenance:{market:rows[0].claimId,assetClass:rows[0].claimId,symbolScope:rows[0].claimId,side:rows[0].claimId,...(!missingTimeframe?{timeframe:rows[0].claimId}:{}),strategyFamily:rows[0].claimId,categories:rows[0].claimId},rules:[{claimId:rows[0].claimId,ruleType:'ENTRY',normalizedRule:opposing?'avoid VWAP reclaim':'use VWAP reclaim',semanticKey:'VWAP_RECLAIM',polarity:opposing?'AVOID':'REQUIRE'},{claimId:rows[1].claimId,ruleType:'EXIT',normalizedRule:'exit below VWAP',semanticKey:'VWAP_LOSS',polarity:'REQUIRE'}]})});return{source:bound,transcript:t,claims,extracted,hypothesis:extracted.hypothesis,rules:extracted.rules};}
function paper(){return adaptCrossrefMetadata({status:'ok','message-type':'work','message-version':'1.0.0',message:{DOI:'10.1234/video.phase2.validation',title:['Validation evidence'],author:[{given:'Ada',family:'Lovelace'}],published:{'date-parts':[[2025,1,2]]},indexed:{'date-time':'2026-09-11T00:00:00Z',version:'3.51.4'},license:[{URL:'https://creativecommons.org/licenses/by/4.0/','content-version':'vor','delay-in-days':0,start:{'date-parts':[[2025,1,2]]}}]}},{retrievedAt:NOW,retrievedFrom:'https://api.crossref.org/v1/works/10.1234/video.phase2.validation'});}

test('unavailable transcript cannot carry content',()=>{const s=source();const missing=normalizeAuthorizedTranscriptV2({source:s,status:'NOT_PROVIDED',authorized:false,segments:[]});assert.equal(missing.status,'NOT_PROVIDED');assert.deepEqual(missing.segments,[]);assert.throws(()=>normalizeAuthorizedTranscriptV2({source:s,status:'UNAVAILABLE',authorized:false,segments:[{startSec:0,endSec:1,text:'content'}]}),/TRANSCRIPT_CONTENT_FORBIDDEN_FOR_UNAVAILABLE_STATUS/u);});

test('creator chapters and inferred sections remain distinguishable',()=>{const t=transcript(source());const result=createChapterIntelligenceV2({transcript:t,chapters:[{startSec:0,endSec:20,title:'Creator section',origin:'CREATOR_CHAPTER',provenance:{source:'fixture'}}],inferredSections:[{startSec:21,endSec:30,title:'Inferred section'}]});assert.equal(result.sections[0].origin,'CREATOR_CHAPTER');assert.equal(result.sections[0].inference,false);assert.equal(result.sections[1].origin,'AI_INFERRED_SECTION');assert.equal(result.sections[1].inference,true);});

test('missing timeframe is not invented and blocks canonical eligibility',async()=>{const s=source(),t=transcript(s),record=await minedRecord(s,t,{missingTimeframe:true});const state=assessVideoStrategyTestabilityV2({hypothesis:record.hypothesis,rules:record.rules});assert.equal(record.hypothesis.timeframe,null);assert.equal(state.status,'MISSING_TIMEFRAME');assert.equal(state.compilerEligible,false);assert.equal(state.inventedRuleCount,0);});

test('same identity is SAME_SOURCE with zero economic evidence',()=>{const s=source(),t=transcript(s),state=detectVideoSourceRelationshipV2({leftSource:s,rightSource:s,leftTranscript:t,rightTranscript:t});assert.equal(state.status,'SAME_SOURCE');assert.equal(state.economicEvidenceN,0);});

test('high transcript similarity is likely derived',()=>{const a=source('a','Channel A'),b=source('b','Channel B'),ta=transcript(a),tb=transcript(b);const state=detectVideoSourceRelationshipV2({leftSource:a,rightSource:b,leftTranscript:ta,rightTranscript:tb});assert.equal(state.status,'LIKELY_DERIVED');assert.equal(state.economicEvidenceN,0);});

test('distinct publisher and transcript can be independent research sources',()=>{const a=source('a','Channel A'),b=source('b','Channel B','Execution lecture'),ta=transcript(a),tb=transcript(b,'Order book queue priority changes execution quality.','Spread and latency are execution costs.');const state=detectVideoSourceRelationshipV2({leftSource:a,rightSource:b,leftTranscript:ta,rightTranscript:tb});assert.equal(state.status,'INDEPENDENT_SOURCE');assert.equal(state.economicEvidenceN,0);});

test('opposite rule polarity creates explicit contradiction',async()=>{const a=await minedRecord(source('a','A'),transcript(source('a','A'))),b=await minedRecord(source('b','B'),transcript(source('b','B')),{opposing:true});const result=detectStrategyContradictionsV2([a,b]);assert.equal(result.contradictions.length,1);assert.equal(result.economicEvidenceCredit,0);});

test('cluster counts videos and independent sources separately from economic N',async()=>{const sa=source('a','A'),sb=source('b','B'),a=await minedRecord(sa,transcript(sa)),b=await minedRecord(sb,transcript(sb),{opposing:true});const result=clusterVideoStrategiesV2([a,b]);assert.equal(result.clusters.length,1);assert.equal(result.clusters[0].videoCount,2);assert.equal(result.clusters[0].economicEvidenceN,0);assert.equal(result.clusters[0].consensusStatus,'CONFLICTING');});

test('academic plus official support affects research validation only',async()=>{const s=source(),t=transcript(s),record=await minedRecord(s,t),claim=record.claims.claims[0],p=paper();const result=crossValidateVideoClaimsV2({claims:record.claims.claims,paperEvidence:[{claimId:claim.claimId,paper:p,role:'SUPPORTING'}],officialEvidence:[{claimId:claim.claimId,sourceId:'official:fixture',canonicalUrl:'https://www.sec.gov/education',role:'SUPPORTING'}]});assert.equal(result.results[0].status,'SUPPORTED');assert.equal(result.economicEvidenceCredit,0);assert.equal(result.profitabilityCredit,0);assert.equal(result.executionAuthority,'NONE');});

test('source trust is explicit evidence only',()=>{assert.equal(classifyVideoSourceAuthorityV2({}),'UNKNOWN');assert.equal(classifyVideoSourceAuthorityV2({authorityEvidence:{type:'ACADEMIC',provenance:{source:'fixture'}}}),'TIER_B_ACADEMIC');assert.throws(()=>classifyVideoSourceAuthorityV2({authorityEvidence:{type:'OFFICIAL'}}),/VIDEO_SOURCE_AUTHORITY_PROVENANCE_REQUIRED/u);});

test('Phase 2 runtime remains inert',()=>{assert.deepEqual(createVideoResearchPhase2RuntimeStateV2(),{paidProviderEnabled:false,automaticDiscoveryEnabled:false,scheduleActive:false,providerCredentialMutation:false,executionAuthority:'NONE',economicEvidenceCredit:0,profitabilityCredit:0});});
