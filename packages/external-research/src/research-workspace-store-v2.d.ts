export type WorkspaceStorePolicy = { expectedSourceHeadSha:string;maxAgeMs:number };
export type WorkspaceStoreSession = {policy:WorkspaceStorePolicy;policySha256:string;loadRegistry:()=>Promise<unknown>};
export function createResearchWorkspaceStore(root:string): {openSnapshot:()=>Promise<WorkspaceStoreSession>};
export type WorkspaceHttpResponse = {setHeader:(key:string,value:string)=>unknown;status:(code:number)=>WorkspaceHttpResponse;json:(data:unknown)=>unknown};
export function createStoredWorkspaceHandler<Request>(options:{
  root:string;authorize:(request:Request)=>Promise<boolean>;
  loadSanitizedSnapshot:()=>Promise<unknown>;clock?:()=>string;
}): (request:Request,response:WorkspaceHttpResponse)=>Promise<void>;
