export type ResearchVideoPlanV7={schemaVersion:'research-video-plan-v7';videoId:string;planDigest:string;requestSha256:string;spec:any;authority:any};
export function prepareVideoResearch(spec:any):ResearchVideoPlanV7;
export function videoRequestBody(plan:ResearchVideoPlanV7):string;
export function verifyVideoCallApproval(approval:any,plan:ResearchVideoPlanV7,now:string):true;
export function executeVideoResearch(input:any):Promise<any>;
