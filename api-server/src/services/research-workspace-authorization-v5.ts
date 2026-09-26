import type {Response, NextFunction} from 'express';
import {requireAuthenticated,requireAdmin,type AuthenticatedRequest} from '../middleware/auth';
import {createWorkspaceApprovalVerifier,createWorkspaceApprovalFileReader,type CurrentWorkspacePrincipal} from '../../../packages/external-research/src/research-workspace-approval-v5.js';

type AuthGate = (req:AuthenticatedRequest,res:Response,next:NextFunction)=>unknown;
type Options = {
  accessToken:string;
  authenticate?:AuthGate;
  adminGuard?:AuthGate;
  clock?:()=>string;
};
/** Deliberately create a NEW request for every recheck: auth.ts's cached req.member path is never used. */
export function createCurrentWorkspaceAdminResolver({accessToken,authenticate=requireAuthenticated,adminGuard=requireAdmin,
  clock=()=>new Date().toISOString()}:Options) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 16384 || /[\r\n\s]/.test(accessToken)) throw new Error('WORKSPACE_SESSION_REQUIRED');
  return async function resolvePrincipal(signal:AbortSignal):Promise<CurrentWorkspacePrincipal|null> {
    if (signal.aborted) return null;
    let rejected=false,authenticated=false,admin=false;
    const req={header:(name:string)=>name.toLowerCase()==='authorization'?`Bearer ${accessToken}`:undefined} as AuthenticatedRequest;
    // Error bodies and profile/token objects never leave this adapter.
    const res={status:()=>{rejected=true;return res;},json:()=>{rejected=true;return res;},setHeader:()=>res} as unknown as Response;
    try {
      await authenticate(req,res,((err?:unknown)=>{if(err)rejected=true;else authenticated=true;}) as NextFunction);
      if (signal.aborted || rejected || !authenticated || !req.member || req.accessToken !== accessToken) return null;
      await adminGuard(req,res,((err?:unknown)=>{if(err)rejected=true;else admin=true;}) as NextFunction);
      if (signal.aborted || rejected || !admin) return null;
      return {actorId:req.member.id,admin:true,checkedAt:clock()};
    } catch { return null; }
  };
}
/** Not mounted as a write endpoint. A trusted server caller supplies roots and separately granted ID. */
export function createCanonicalWorkspacePublicationAuthorizer({accessToken,publicationRoot,approvalRoot}:{accessToken:string;publicationRoot:string;approvalRoot:string}) {
  return createWorkspaceApprovalVerifier({root:publicationRoot,
    loadApproval:createWorkspaceApprovalFileReader(approvalRoot),
    resolvePrincipal:createCurrentWorkspaceAdminResolver({accessToken}),
  });
}
