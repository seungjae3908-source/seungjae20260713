export type ResearchOneShotReviewV15 =
 | {schemaVersion:'research-one-shot-review-v15';available:false;reason:string}
 | {schemaVersion:'research-one-shot-review-v15';available:true;checkedAt:string;status:'HUMAN_RULE_DIGEST_REVIEW'|'SOURCE_EVIDENCE_REVIEW_NO_RETRY';
    reason:string;manifestDigest:string;packageDigest:string|null;reviewedRuleDigestCandidate:string|null;
    providerCalls:{gemini:number;groq:number};sourceTruthVerified:false;entireVideoVerified:false;
    observations:Array<{observationIndex:number;atSec:number;kind:string;description:string;verdict?:string;reason?:string}>;
    limitations:string[];groq:{summary:string;disposition:string}|null;missingRuleKinds:string[];
    authority:{readOnly:true;providerCallsFromRead:0;automaticBinding:false;automaticCompiler:false;automaticBacktest:false;
      automaticAdoption:false;profitabilityProven:false;executionAuthority:'NONE'}};
export function readResearchOneShotReviewV15(root:string,options?:{checkedAt?:string}):Promise<ResearchOneShotReviewV15>;
