export type ResearchOneShotReviewUi =
 | {available:false;reason:string}
 | {available:true;checkedAt:string;status:'HUMAN_RULE_DIGEST_REVIEW'|'SOURCE_EVIDENCE_REVIEW_NO_RETRY';reason:string;
    manifestDigest:string;packageDigest:string|null;reviewedRuleDigestCandidate:string|null;providerCalls:{gemini:number;groq:number};
    observations:Array<{observationIndex:number;atSec:number;kind:string;description:string;verdict:string;reason:string}>;
    limitations:string[];groq:{summary:string;disposition:string}|null;missingRuleKinds:string[];
    sourceTruthVerified:false;entireVideoVerified:false};
export function parseResearchOneShotReview(raw:unknown):ResearchOneShotReviewUi;
