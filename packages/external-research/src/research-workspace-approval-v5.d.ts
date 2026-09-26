export type CurrentWorkspacePrincipal = {actorId:string;admin:true;checkedAt:string};
export function createWorkspaceApprovalFileReader(root:string): (approvalId:string,signal?:AbortSignal)=>Promise<unknown>;
export function createWorkspaceApprovalVerifier(options:{
 root:string; mode?:'REVIEWED_RUNTIME'|'OFFLINE_TEST';
 loadApproval:(id:string,signal?:AbortSignal)=>Promise<unknown>;
 resolvePrincipal:(signal:AbortSignal)=>Promise<CurrentWorkspacePrincipal|null>;
 clock?:()=>string;timeoutMs?:number;
}): (request:unknown,approvalId:unknown)=>Promise<boolean>;
