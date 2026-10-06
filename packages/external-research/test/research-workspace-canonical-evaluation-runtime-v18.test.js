import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptCrossrefMetadata } from '../src/index.js';
import { createResearchVideoSourceV1,createVideoStrategyHypothesisV1,crossValidateVideoHypothesisV1 } from '../src/video-intelligence.js';
import { adaptVideoStrategyToCanonicalHypothesisV1 } from '../../../market-prediction-lab/src/video-research-canonical-handoff-v1.js';
import { createCanonicalEvaluationRuntimeV18 } from '../src/research-workspace-canonical-evaluation-runtime-v18.js';

const NOW='2026-09-26T08:00:00.000Z',START=Date.UTC(2025,0,2),STEP=15*60*1000;
const parameter=name=>({kind:'PARAMETER',name});
const indicator=(name,input,period)=>({kind:'INDICATOR',name,input,parameters:{period}});
const op=(operator,operands)=>({kind:'OPERATOR',operator,operands});
function paper(){return adaptCrossrefMetadata({status:'ok','message-type':'work','message-version':'1.0.0',message:{DOI:'10.1234/runtime.v18',title:['Runtime'],author:[{given:'Ada',family:'Lovelace'}],published:{'date-parts':[[2025,1,2]]},indexed:{'date-time':'2026-09-20T00:00:00Z',version:'3.51.4'},license:[{URL:'https://creativecommons.org/licenses/by/4.0/','content-version':'vor','delay-in-days':0,start:{'date-parts':[[2025,1,2]]}}]}},{retrievedAt:NOW,retrievedFrom:'https://api.crossref.org/v1/works/10.1234/runtime.v18'});}
function source(){return createResearchVideoSourceV1({provider:'YOUTUBE',sourceType:'YOUTUBE_VIDEO',canonicalUrl:'https://www.youtube.com/watch?v=abcdefghijk',videoId:'abcdefghijk',title:'Reviewed research video',channelOrPublisher:'Research',publishedAt:null,discoveredAt:NOW,language:'en',durationSec:120,transcriptStatus:'AVAILABLE',transcriptSource:'REVIEWED_TEST',transcriptAuthorized:true,contentAccessStatus:'AVAILABLE',timestampProvenance:[]});}
function core(){return {title:'Runtime V18 hypothesis',statement:'Momentum may support bounded continuation research.',rationale:'Research only.',evidenceStrength:{supporting:'STRONG',contradictory:'NONE'},expectedEffect:{observable:'NEXT_WINDOW_EXCESS_RETURN',direction:'INCREASE',minimumMagnitude:null,unit:'DECIMAL_RETURN',evaluationWindow:'15m'},falsificationCriteria:{observable:'NEXT_WINDOW_EXCESS_RETURN',metric:'MEAN_CONDITIONAL_EXCESS_RETURN',operator:'LTE',threshold:0,unit:'DECIMAL_RETURN',evaluationWindow:'15m',minimumObservations:200,rejectionStatement:'Reject when non-positive.'},requiredData:[{dataset:'LICENSED_INTRADAY_EQUITY_BARS',fields:['security_id','open','high','low','close','volume'],frequency:'15m',provenanceRequired:true,licenseRequired:true}],knownLimitations:['Research only.'],createdAt:NOW,generator:{name:'runtime-v18-test',version:'1.0.0'},evidencePolicy:{requireKnownContentLicense:true,requireResolvedCorrections:true}};}
function committee(){return {rationale:'Approved for bounded research only.',decidedAt:NOW,committee:{name:'Research Committee',version:'1.0.0',members:['reviewer-a']}};}
function setup(){
  const s=source(),p=paper();
  const v=createVideoStrategyHypothesisV1({source:s,market:'US_STOCK',assetClass:'EQUITY',symbolScope:['AAPL'],side:'LONG',timeframe:'15m',strategyFamily:'MOMENTUM_RVOL',categories:['MOMENTUM'],entryRules:['positive ROC and RVOL'],exitRules:['ATR stop target time'],stopLossRules:[],takeProfitRules:[],positionSizingRules:[],indicatorRules:['ROC','RVOL','ATR'],regimeConstraints:[],invalidations:[],authorClaims:[],extractedFacts:[],extractedInferences:[],uncertainties:[]});
  const cross=crossValidateVideoHypothesisV1({hypothesis:v,supportingPapers:[p]});
  const adapted=adaptVideoStrategyToCanonicalHypothesisV1({source:s,videoHypothesis:v,crossValidation:cross,papers:[p],canonicalCore:core(),review:committee()});
  assert.equal(adapted.status,'CANONICAL_READY');
  const binding={hypothesisId:adapted.canonicalHypothesis.hypothesisId,hypothesisConfigHash:adapted.canonicalHypothesis.configHash,decisionId:adapted.decision.decisionId,decisionHash:adapted.decision.decisionHash};
  const ps=(name,domain,valueType,min,max,step)=>({name,domain,valueType,min,max,step});
  const template={templateId:'runtime-v18-momentum',hypothesisBinding:binding,strategyFamily:'MOMENTUM_RVOL',market:'US_STOCK',timeframe:'15m',direction:'LONG',
    entryDsl:{action:'LONG',rules:[op('GT',[indicator('ROC','close','rocPeriod'),parameter('rocMin')]),op('GT',[indicator('RVOL','volume','rvolPeriod'),parameter('rvolMin')])]},
    exitDsl:{rules:[{type:'ATR_STOP',atrIndicator:indicator('ATR','ohlc','atrPeriod'),multiplierParameter:'atrStop'},{type:'TARGET',distanceParameter:'targetDistance'},{type:'TIME_EXIT',barsParameter:'timeBars'}]},
    parameterSpace:[ps('atrPeriod','PERIOD','INTEGER',2,2,1),ps('atrStop','POSITIVE_MULTIPLIER','NUMBER',1,1,0.5),ps('rocPeriod','PERIOD','INTEGER',2,2,1),ps('rocMin','NON_NEGATIVE_VALUE','NUMBER',0.01,0.01,0.01),ps('rvolPeriod','PERIOD','INTEGER',2,2,1),ps('rvolMin','NON_NEGATIVE_VALUE','NUMBER',1.2,1.2,0.1),ps('targetDistance','PRICE_FRACTION','NUMBER',0.02,0.02,0.01),ps('timeBars','BAR_COUNT','INTEGER',2,2,1)],limits:{maxAstDepth:6,maxIndicatorCount:8,maxRuleCount:8,maxAstNodes:64}};
  const budget={maxCandidatesPerHypothesis:8,maxCandidatesPerRun:16,maxGenerations:2,maxParameterCombinations:128,maxAstNodes:64,maxRuntimeMs:5000,maxCpuMs:5000,maxMemoryBytes:1048576};
  const datasetIdentity='dataset:train:runtime-v18';
  const policy={compilerId:'safe-hypothesis-formula-compiler',compilerVersion:'1.0.0',costPolicyIdentity:'US_INTRADAY_COST_V1',riskPolicyIdentity:'RESEARCH_RISK_V1',datasetIdentity,datasetRole:'TRAIN',budget};
  const closes=[100,100,100,103,104,105,106,107,108,109],volumes=[100,100,100,300,150,150,150,150,150,150];
  const candles=closes.map((close,i)=>({timestamp:START+i*STEP,open:close,high:close+0.5,low:close-0.5,close,volume:volumes[i]}));
  return {context:{schemaVersion:'research-canonical-evaluation-runtime-context-v18',sourceSha:'a'.repeat(40),
    handoff:{source:s,videoHypothesis:v,crossValidation:cross,papers:[p],canonicalCore:core(),review:committee(),templates:[template],policy},
    generation:{budget,search:{method:'BOUNDED_GRID',seed:7,datasetIdentity,finalHoldoutAccess:false}},
    backtest:{datasetIdentity,backtestInput:{market:'US_STOCK',symbol:'AAPL',timeframe:'15m',side:'long',candles,initialCapital:10000,riskModel:{riskPerTrade:0.01,maximumCapitalFraction:1,leverage:1},costModel:{entryFeeRate:0,exitFeeRate:0,taxRate:0,slippageRate:0,spreadRate:0,latencyBars:0,latencyDriftRate:0}},period:{startTime:candles[0].timestamp,endTime:candles.at(-1).timestamp,includeFinalHoldout:false},liquidityImpactEvidence:{value:0,evidenceId:'fixture:zero'}},
    statisticalFirewall:null},
    config:{market:'US_STOCK',side:'LONG',timeframe:'15m'}};
}
test('Phase18 runtime performs one real #690 backtest then blocks on missing #547 evidence',async()=>{
  const x=setup(),runtime=createCanonicalEvaluationRuntimeV18(x.context,{currentSha:'a'.repeat(40),config:x.config});
  const compiled=await runtime.compileCanonical({});
  assert.equal(compiled.status,'READY');assert.equal(compiled.compiler,'#550');
  const result=await runtime.runBacktest({compiled});
  assert.equal(result.status,'REVIEW_REQUIRED');assert.equal(result.reason,'STATISTICAL_EVIDENCE_MISSING');
  assert.equal(result.backtesterCalls,1);assert.match(result.resultDigest,/^[a-f0-9]{64}$/);
  assert.equal(runtime.authority.executionAuthority,'NONE');assert.equal(runtime.authority.automaticAdoption,false);
});
