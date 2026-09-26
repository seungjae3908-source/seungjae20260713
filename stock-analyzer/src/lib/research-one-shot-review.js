const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0&&x<=1000000000;
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const text=(x,max=800)=>typeof x==='string'&&x.trim().length>0&&x.length<=max
  &&!/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|api[_ -]?key\s*[:=]|private[_ -]?key\s*[:=]|계좌번호|비밀번호)/i.test(x);
const KINDS=new Set(['ENTRY','EXIT','STOP_LOSS','POSITION_SIZING','EXECUTION_ASSUMPTION','CONTEXT']);
const VERDICTS=new Set(['ACCEPT_AS_CLAIM','CHALLENGE','AMBIGUOUS']);
function authority(x){
 return object(x)&&Object.keys(x).length===8&&x.readOnly===true&&x.providerCallsFromRead===0&&x.automaticBinding===false
  &&x.automaticCompiler===false&&x.automaticBacktest===false&&x.automaticAdoption===false&&x.profitabilityProven===false&&x.executionAuthority==='NONE';
}
export function parseResearchOneShotReview(raw){
 if(!object(raw)||raw.schemaVersion!=='research-one-shot-review-v15')throw new Error('INVALID_ONE_SHOT_REVIEW');
 if(raw.available===false)return {available:false,reason:'ONE_SHOT_REVIEW_UNAVAILABLE'};
 if(raw.available!==true||!iso(raw.checkedAt)||!['HUMAN_RULE_DIGEST_REVIEW','SOURCE_EVIDENCE_REVIEW_NO_RETRY'].includes(raw.status)
   ||!text(raw.reason,96)||!digest(raw.manifestDigest)||!object(raw.providerCalls)
   ||!integer(raw.providerCalls.gemini)||raw.providerCalls.gemini>1||!integer(raw.providerCalls.groq)||raw.providerCalls.groq>1
   ||raw.sourceTruthVerified!==false||raw.entireVideoVerified!==false||!Array.isArray(raw.observations)||raw.observations.length>12
   ||!Array.isArray(raw.limitations)||raw.limitations.length>8||raw.limitations.some(x=>!text(x,400))
   ||!Array.isArray(raw.missingRuleKinds)||raw.missingRuleKinds.some(x=>typeof x!=='string'||!KINDS.has(x))
   ||!authority(raw.authority))throw new Error('INVALID_ONE_SHOT_REVIEW');
 if(raw.status==='SOURCE_EVIDENCE_REVIEW_NO_RETRY'){
   if(raw.reason!=='GEMINI_INSUFFICIENT_EVIDENCE'||raw.packageDigest!==null||raw.reviewedRuleDigestCandidate!==null
     ||raw.providerCalls.gemini!==1||raw.providerCalls.groq!==0||raw.observations.length!==0||raw.groq!==null)
     throw new Error('INVALID_ONE_SHOT_REVIEW');
   return {available:true,checkedAt:raw.checkedAt,status:raw.status,reason:raw.reason,manifestDigest:raw.manifestDigest,
     packageDigest:null,reviewedRuleDigestCandidate:null,providerCalls:{gemini:1,groq:0},observations:[],
     limitations:[...raw.limitations],groq:null,missingRuleKinds:[],sourceTruthVerified:false,entireVideoVerified:false};
 }
 if(raw.reason!=='HUMAN_RULE_DIGEST_REVIEW_REQUIRED'||!digest(raw.packageDigest)||!digest(raw.reviewedRuleDigestCandidate)
   ||raw.providerCalls.gemini!==1||raw.providerCalls.groq!==1||raw.observations.length===0||!object(raw.groq)
   ||!text(raw.groq.summary,800)||!['CONTINUE','REVIEW_REQUIRED','BLOCKED'].includes(raw.groq.disposition))
   throw new Error('INVALID_ONE_SHOT_REVIEW');
 const observations=raw.observations.map((row,index)=>{
   if(!object(row)||Object.keys(row).length!==6||row.observationIndex!==index||!finite(row.atSec)||!KINDS.has(row.kind)
     ||!text(row.description,600)||!VERDICTS.has(row.verdict)||!text(row.reason,500))throw new Error('INVALID_ONE_SHOT_REVIEW');
   return {observationIndex:index,atSec:row.atSec,kind:row.kind,description:row.description,verdict:row.verdict,reason:row.reason};
 });
 return {available:true,checkedAt:raw.checkedAt,status:raw.status,reason:raw.reason,manifestDigest:raw.manifestDigest,
   packageDigest:raw.packageDigest,reviewedRuleDigestCandidate:raw.reviewedRuleDigestCandidate,
   providerCalls:{gemini:1,groq:1},observations,limitations:[...raw.limitations],
   groq:{summary:raw.groq.summary,disposition:raw.groq.disposition},missingRuleKinds:[...raw.missingRuleKinds],
   sourceTruthVerified:false,entireVideoVerified:false};
}
