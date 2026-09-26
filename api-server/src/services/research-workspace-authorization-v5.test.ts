import assert from 'node:assert/strict';
import test from 'node:test';
import {requireAuthenticated,type MemberProfile} from '../middleware/auth';
import {createCurrentWorkspaceAdminResolver} from './research-workspace-authorization-v5';
import {createWorkspaceApprovalVerifier} from '../../../packages/external-research/src/research-workspace-approval-v5.js';
const NOW='2026-09-26T01:30:00.000Z',TOKEN='TEST_ONLY_TOKEN';
type Dependencies = NonNullable<Parameters<typeof requireAuthenticated>[3]>;
function fixture(){
 const state:{profile:MemberProfile;configured:boolean;userId:string;authError:unknown;profileError:unknown;userCalls:number;profileCalls:number;freshChecks:number;tokens:string[];ids:string[]}={
  profile:{id:'TEST_ADMIN',login_name:'test',display_name:'TEST ONLY',role:'admin',status:'approved',membership_level:'admin',is_active:true},configured:true,userId:'TEST_ADMIN',authError:null,profileError:null,userCalls:0,profileCalls:0,freshChecks:0,tokens:[],ids:[],
 };
 const dependencies={isSupabaseConfigured:()=>state.configured,
  getSupabase:()=>({auth:{getUser:async(token:string)=>{state.userCalls++;state.tokens.push(token);return {data:{user:{id:state.userId,user_metadata:{role:'admin'}}},error:state.authError};}}}),
  getUserSupabase:(token:string)=>{
    assert.equal(token,TOKEN);
    return {
      from:(table:string)=>{
        assert.equal(table,'profiles');
        return {
          select:()=>({
            eq:(_key:string,userId:string)=>{
              state.ids.push(userId);
              return {
                single:async()=>{
                  state.profileCalls++;
                  return {data:{...state.profile},error:state.profileError};
                },
              };
            },
          }),
        };
      },
    };
  },
 } as unknown as Dependencies;
 const resolver=createCurrentWorkspaceAdminResolver({accessToken:TOKEN,clock:()=>NOW,authenticate:(req,res,next)=>{
  assert.equal(req.member,undefined);assert.equal(req.accessToken,undefined);state.freshChecks++;
  return requireAuthenticated(req,res,next,dependencies);
 }});
 return {state,resolver,resolve:()=>resolver(new AbortController().signal)};
}
test('real canonical auth and admin guard accept verified current profile',async()=>{const f=fixture();assert.deepEqual(await f.resolve(),{actorId:'TEST_ADMIN',admin:true,checkedAt:NOW});assert.equal(f.state.userCalls,1);assert.equal(f.state.profileCalls,1);assert.deepEqual(f.state.ids,['TEST_ADMIN']);});
test('current role is refreshed on every check, no cached request member bypass',async()=>{const f=fixture();assert.ok(await f.resolve());f.state.profile.role='member';f.state.profile.membership_level='regular';assert.equal(await f.resolve(),null);assert.equal(f.state.userCalls,2);assert.equal(f.state.profileCalls,2);assert.equal(f.state.freshChecks,2);});
for(const status of ['pending','suspended','revoked','withdrawn','disabled','inactive'] as const)test(`canonical ${status} member denied`,async()=>{const f=fixture();f.state.profile.status=status;assert.equal(await f.resolve(),null);});
test('inactive administrator denied',async()=>{const f=fixture();f.state.profile.is_active=false;assert.equal(await f.resolve(),null);});
test('JWT user_metadata admin claim does not override regular database profile',async()=>{const f=fixture();f.state.profile.role='member';f.state.profile.membership_level='regular';assert.equal(await f.resolve(),null);});
test('verified subject and profile ID must match',async()=>{const f=fixture();f.state.profile.id='OTHER';assert.equal(await f.resolve(),null);});
test('unconfigured auth is not a fallback approval',async()=>{const f=fixture();f.state.configured=false;assert.equal(await f.resolve(),null);assert.equal(f.state.userCalls,0);});
test('rejected session never uses the profile as identity',async()=>{const f=fixture();f.state.authError={message:'PRIVATE_SESSION_DETAIL'};assert.equal(await f.resolve(),null);assert.equal(f.state.profileCalls,0);});
test('profile database failure is redacted',async()=>{const f=fixture();f.state.profileError={message:'PRIVATE_DATABASE_DETAIL'};assert.equal(await f.resolve(),null);});
test('already aborted resolver does not call auth',async()=>{const f=fixture(),c=new AbortController();c.abort();assert.equal(await f.resolver(c.signal),null);assert.equal(f.state.userCalls,0);});
test('session token never appears in resolver output',async()=>{const f=fixture();const result=await f.resolve();assert.equal(Object.keys(result!).length,3);assert.ok(!JSON.stringify(result).includes(TOKEN));});
for(const accessToken of ['', 'Bearer token', 'x\r\ny', 'x'.repeat(16385)])test('malformed token rejected at trusted adapter construction',()=>assert.throws(()=>createCurrentWorkspaceAdminResolver({accessToken}),/SESSION_REQUIRED/));
test('canonical resolver composes with exact approval and notices mid-flow downgrade',async()=>{
 const f=fixture();const request={root:'/private/research',mode:'REVIEWED_RUNTIME',scope:'ADMIN_RESEARCH_SHARED',action:'PUBLISH_RESEARCH_REGISTRY',planDigest:'a'.repeat(64),policySha256:'b'.repeat(64),expectedPreviousPolicySha256:null,now:NOW,executionAuthority:'NONE',actualOrders:0};
 const grant={...request,schemaVersion:'research-workspace-publication-approval-v5',approvalId:'TEST_GRANT',actorId:'TEST_ADMIN',state:'APPROVED',validFrom:'2026-09-26T01:29:00.000Z',expiresAt:'2026-09-26T01:40:00.000Z'};
 delete (grant as {now?:string}).now;
 const authorize=createWorkspaceApprovalVerifier({root:request.root,clock:()=>NOW,resolvePrincipal:f.resolver,loadApproval:async()=>grant});
 assert.equal(await authorize(request,'TEST_GRANT'),true);f.state.profile.status='revoked';assert.equal(await authorize(request,'TEST_GRANT'),false);assert.equal(f.state.userCalls,2);
});
