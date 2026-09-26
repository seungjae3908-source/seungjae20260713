export const CANONICAL_EVALUATION_REQUEST_FILE_V18:'canonical-evaluation-request-v18.json';
export const CANONICAL_EVALUATION_EXECUTION_AUTHORITY_V18:Record<string,unknown>;
export const CANONICAL_EVALUATION_RUNTIME_DEPENDENCIES_V18:Record<string,unknown>;
export function canonicalEvaluationRequestDigestV18(value:any):string;
export function validateCanonicalEvaluationExecutionRequestV18(request:any,options:{currentSha:string;review:any;decision:any;config:any;preflight:any;runtimeProof:any;now?:string}):{ok:boolean;reasons:string[]};
export function assessCanonicalEvaluationExecutionContractV18(input:{request:any;currentSha:string;review:any;decision:any;config:any;preflight:any;runtimeProof:any;checkedAt?:string}):any;
