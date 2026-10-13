export type ResearchProviderStatus = {
  schemaVersion:'research-provider-readiness-v8'; checkedAt:string;
  source:'API_PROCESS'|'INHERITED_PROCESS'|'EXPLICIT_ENV_FILE';scope:'SELECTED_RUNTIME_ONLY';
  providers:Array<{provider:'youtube'|'gemini'|'groq';credentialState:string;modelState:string;callVerified:false;quotaState:'NOT_CHECKED';billingState:'NOT_CHECKED'}>;
  unmappedGenericCredential:boolean;
  authority:{executionAuthority:'NONE';providerCalls:0;environmentMutated:false;automaticActivation:false};
};
export function inspectExistingResearchProviders(env:unknown,options?:{now?:string;source?:ResearchProviderStatus['source']}):ResearchProviderStatus;
export function runExistingEnvironmentVideo(argv:string[],options?:{env?:unknown;invokeVideo:(argv:string[],options:{env:Record<string,string>})=>Promise<unknown>}):Promise<unknown>;
export function runExistingEnvironmentGroqReview(request:unknown,options?:{env?:unknown;invokeGroq:(request:unknown,options:{apiKey:string;model:string})=>Promise<unknown>}):Promise<unknown>;
type ResponseLike={setHeader:(key:string,value:string)=>unknown;status:(code:number)=>ResponseLike;json:(value:unknown)=>unknown};
export function createProviderReadinessHandler<Request>(options:{authorize:(req:Request)=>Promise<boolean>;readEnvironment?:()=>unknown;clock?:()=>string}):
  (req:Request,res:ResponseLike)=>Promise<unknown>;
