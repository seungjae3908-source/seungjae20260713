export type ResearchWorkerTaskKind='VIDEO_PREPARE'|'VIDEO_EXECUTE_APPROVED';
export type ResearchWorkerJob={schemaVersion:'research-worker-job-v9';jobId:string;createdAt:string;notBefore:string;maxAttempts:number;task:{kind:ResearchWorkerTaskKind;runner:'EXISTING_PROVIDER_VIDEO_V8';networkMode:'NONE'|'APPROVED_ONE_SHOT';argv:string[]}};
export type ResearchWorkerStatus={schemaVersion:'research-worker-status-v9';available:boolean;reason?:string;checkedAt?:string;workerState?:'ACTIVE'|'STALE'|'NOT_RUNNING'|'UNKNOWN';lastHeartbeatAt?:string|null;currentTaskKind?:ResearchWorkerTaskKind|null;counts?:{queued:number;running:number;succeeded:number;failed:number;blocked:number};authority?:{executionAuthority:'NONE';automaticActivation:false;providerCallsFromStatus:0}};
export function createResearchWorkerQueue(root:string,options?:{clock?:()=>string;leaseMs?:number;retryDelayMs?:number}):any;
export function runResearchWorkerOnce(queue:any,options:any):Promise<any>;
export function runResearchWorkerLoop(queue:any,options:any):Promise<void>;
export function researchWorkerJobDigest(job:ResearchWorkerJob):string;
