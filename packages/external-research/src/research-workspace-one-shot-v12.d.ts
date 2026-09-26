export type ResearchOneShotManifestV12={schemaVersion:'research-one-shot-manifest-v12';pipelineId:string;createdAt:string;market:'KR_STOCK'|'US_STOCK'|'CRYPTO_SPOT'|'CRYPTO_FUTURES';sourceId:string;sourceDigest:string;videoPlanDigest:string;orchestratorPlanDigest:string;providerSequence:['gemini','groq'];requiredStopAfterProviders:'HUMAN_RULE_DIGEST_REVIEW';authority:{executionAuthority:'NONE';automaticActivation:false;automaticAdoption:false;paidFallback:false;maxGeminiCalls:1;maxGroqCalls:1};manifestDigest:string};
export function researchOneShotDigestV12(value:unknown):string;
export function createResearchOneShotManifestV12(input:{pipelineId:string;createdAt:string;market:ResearchOneShotManifestV12['market'];source:unknown;videoSpec:unknown}):ResearchOneShotManifestV12;
export function verifyGroqCallApprovalV12(approval:unknown,manifest:ResearchOneShotManifestV12,now:string):true;
export function buildGroqReviewPromptV12(request:unknown):string;
export function parseGroqReviewResponseV12(raw:string,options:{request:any;model:string}):any;
export function buildProviderReviewPackageV12(input:{manifest:ResearchOneShotManifestV12;geminiReceipt:any;groqReview:any}):any;
