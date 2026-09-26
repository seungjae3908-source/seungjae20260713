export const CANONICAL_EVALUATION_CONFIG_FILE_V17:'canonical-evaluation-config-v17.json';
export const CANONICAL_EVALUATION_RUNTIME_BINDINGS_V17:Record<string,unknown>;
export function validateCanonicalEvaluationConfigV17(config:any,options:{currentSha:string;review:any;decision:any;now?:string}):{ok:boolean;reasons:string[]};
export function assessCanonicalEvaluationReadinessV17(input:{config:any;currentSha:string;review:any;decision:any;checkedAt?:string}):any;
