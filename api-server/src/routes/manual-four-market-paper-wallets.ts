import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { getSupabase,getUserSupabase,hasSupabaseServerKey } from '../lib/supabase';
import { hasCapability } from '../../../packages/member-access/src/index.js';
import type { StoredPaperJournalRecord } from '../services/paper-journal.types';
import {
  MANUAL_FOUR_MARKET_CONFIRMATION,
  buildManualFourMarketWalletSeeds,
  inspectManualFourMarketWallets,
  manualWalletCreationReadiness,
  type ManualWalletRole,
} from '../services/manual-four-market-paper-wallets.service';

type ManualFourMarketDeps = {
  now:()=>Date;
  listSeeds:(request:AuthenticatedRequest,ownerId:string)=>Promise<StoredPaperJournalRecord[]>;
  rlsReady:(request:AuthenticatedRequest)=>Promise<boolean>;
  insertSeeds:(request:AuthenticatedRequest,ownerId:string,role:ManualWalletRole,
    records:ReturnType<typeof buildManualFourMarketWalletSeeds>)=>Promise<StoredPaperJournalRecord[]>;
  bootstrapEnabled:()=>boolean;
};
const READ_ONLY='MANUAL_PAPER_FOUR_MARKET_SEED_ONLY';
const fail=(code:string,message:string,extra:Record<string,unknown>={})=>({
  ok:false, mode:READ_ONLY, code,message,
  executionAuthority:'NONE', orderSubmitted:false,exchangeRequestSent:false,
  privateProviderRequests:0,realOrders:0, ...extra,
});
const harmless=(body:Record<string,unknown>)=>({
  mode:READ_ONLY,executionAuthority:'NONE',orderSubmitted:false,
  exchangeRequestSent:false,privateProviderRequests:0,realOrders:0,
  ...body,
});
function authenticatedOwner(req:AuthenticatedRequest){
  if(!req.member?.id || !req.accessToken)
    return null;
  if(!hasCapability(req.member,'canAccessPaperTrading'))return null;
  return {
    id:req.member.id,
    role:hasCapability(req.member,'canManageMembers')
      ? 'admin' as const : 'member' as const,
  };
}

export function createManualFourMarketWalletRouter(
  deps:Partial<ManualFourMarketDeps>={},
):IRouter{
  const router:IRouter=Router();
  const now=deps.now??(()=>new Date());
  const listSeeds=deps.listSeeds??(async(req,ownerId)=>{
    if(!req.accessToken || ownerId!==req.member?.id) throw new Error('PAPER_MANUAL_SCOPE_REQUIRED');
    // Owner+namespace bounded read. Never use service-role to satisfy an
    // authenticated SELECT; policy/owner failures must remain visible.
    const {data,error}=await getUserSupabase(req.accessToken)
      .from('paper_accounts')
      .select('id,payload,version,deleted_at,created_at,updated_at')
      .eq('user_id',ownerId).like('id','manual-paper-%').range(0,15);
    if(error || !Array.isArray(data) || data.length>8)
      throw new Error('MANUAL_FOUR_MARKET_READBACK_UNAVAILABLE');
    return data.map(row=>({
      kind:'account' as const,id:row.id,payload:row.payload,
      version:row.version,deletedAt:row.deleted_at,updatedAt:row.updated_at,
      createdAt:row.created_at,serverUpdatedAt:row.updated_at,
    }));
  });
  const rlsReady=deps.rlsReady??(async req=>{
    if(!req.accessToken)return false;
    const {data,error}=await getUserSupabase(req.accessToken)
      .rpc('manual_four_market_paper_wallet_rls_guard_ready');
    return !error && data===true;
  });
  const insertSeeds=deps.insertSeeds??(async(req,ownerId,role,records)=>{
    if(!req.member?.id || !req.accessToken || ownerId!==req.member.id
      || !hasCapability(req.member,'canAccessPaperTrading')) {
      throw new Error('MANUAL_FOUR_MARKET_SCOPE_REQUIRED');
    }
    if(records.length!==4
       ||records.some(r=>r.payload.role!==role
         ||r.payload.mode!=='manual'
         ||r.payload.initialBalance!==1_000_000)) {
      throw new Error('MANUAL_FOUR_MARKET_SEED_CONTRACT_INVALID');
    }
    if(!hasSupabaseServerKey())throw new Error('MANUAL_FOUR_MARKET_SERVICE_ROLE_REQUIRED');
    const createdAt=now().toISOString();
    // All four immutable seeds are inserted in ONE atomic statement.
    // Unique user_id/id + DB constraint + immutable trigger enforce once-only.
    const {data,error}=await getSupabase().from('paper_accounts')
      .insert(records.map(row=>({
        user_id:ownerId,id:row.id,payload:row.payload,version:1,
        deleted_at:null,updated_at:createdAt,
      })))
      .select('id,payload,version,deleted_at,created_at,updated_at');
    if(error?.code==='23505')throw new Error('MANUAL_FOUR_MARKET_SEEDS_ALREADY_EXISTS');
    if(error || !Array.isArray(data) || data.length!==4)
      throw new Error('MANUAL_FOUR_MARKET_ATOMIC_INSERT_UNVERIFIED');
    return data.map(row=>({
      kind:'account' as const,id:row.id,payload:row.payload,
      version:row.version,deletedAt:row.deleted_at,updatedAt:row.updated_at,
      createdAt:row.created_at,serverUpdatedAt:row.updated_at,
    }));
  });
  const bootstrapEnabled=deps.bootstrapEnabled??(
    ()=>process.env.MANUAL_FOUR_MARKET_PAPER_SEED_BOOTSTRAP_ENABLED==='true');

  const statusPath='/paper-trading/manual-four-market/status';
  const bootstrapPath='/paper-trading/manual-four-market/bootstrap';
  router.head(statusPath,(_req,res)=>res.status(405).end());
  router.get(statusPath,async(req:AuthenticatedRequest,res)=>{
    res.set('Cache-Control','no-store');
    const scope=authenticatedOwner(req);
    if(!scope)return res.status(403).json(fail('CAPABILITY_REQUIRED','수동모의매매 본인 권한이 필요합니다.'));
    if(Object.keys(req.query).length) return res.status(400).json(
      fail('MANUAL_FOUR_MARKET_QUERY_FORBIDDEN','조회 주소에 계정이나 다른 조건을 지정할 수 없습니다.'));
    try{
      const [records,protectedDb]=await Promise.all([listSeeds(req,scope.id),rlsReady(req)]);
      const checked=inspectManualFourMarketWallets(scope.role,records,now().getTime());
      const creation=manualWalletCreationReadiness(scope.role,records,now().getTime());
      return res.json(harmless({
        ok:true,ownerScope:'SELF',readOnlyProbe:true,role:scope.role,
        ready:protectedDb&&checked.ready,
        rlsGuardReady:protectedDb,manualExecutionReady:false,
        canCreate:protectedDb&&bootstrapEnabled()&&creation.canCreate,
        creationBlockers:[...creation.blockers,...(!protectedDb?['MANUAL_FOUR_MARKET_DATABASE_GUARD_REQUIRED']:[])],
        perMarketInitialKrw:checked.perMarketInitialKrw,
        totalInitialKrw:checked.totalInitialKrw,
        markets:checked.markets,blockers:checked.blockers,
        virtualSeedRowsInserted:0,
      }));
    }catch{
      return res.status(503).json(fail('MANUAL_FOUR_MARKET_STATUS_UNAVAILABLE',
        '서버 모의계좌 읽기 전용 검증에 실패했습니다.'));
    }
  });
  router.post(bootstrapPath,async(req:AuthenticatedRequest,res)=>{
    res.set('Cache-Control','no-store');
    const scope=authenticatedOwner(req);
    if(!scope)return res.status(403).json(fail('CAPABILITY_REQUIRED','수동모의매매 본인 권한이 필요합니다.'));
    if(!bootstrapEnabled())return res.status(409).json(fail(
      'MANUAL_FOUR_MARKET_BOOTSTRAP_OFF','서버 수동모의계좌 생성 기능은 활성화되지 않았습니다.'));
    if(Object.keys(req.query).length || !req.body
      || Array.isArray(req.body) || typeof req.body!=='object'
      || Object.keys(req.body).length!==1
      || req.body.confirmation!==MANUAL_FOUR_MARKET_CONFIRMATION) {
      return res.status(400).json(fail('MANUAL_FOUR_MARKET_CONFIRMATION_REQUIRED',
        '기존 거래내역을 보존하며 4시장 가상계좌를 시작하는 확인이 필요합니다.'));
    }
    try{
      if(await rlsReady(req)!==true){
        return res.status(409).json(fail('MANUAL_FOUR_MARKET_DATABASE_GUARD_REQUIRED',
          '서버 모의계좌 DB 보호가 적용되지 않았습니다.'));
      }
      const prior=await listSeeds(req,scope.id);
      const assessment=manualWalletCreationReadiness(scope.role,prior,now().getTime());
      if(!assessment.canCreate) return res.status(409).json(fail(
        assessment.blockers[0]??'MANUAL_FOUR_MARKET_SEEDS_ALREADY_EXISTS',
        '기존 가상계좌를 다시 충전하거나 덮어쓸 수 없습니다.'));
      const records=buildManualFourMarketWalletSeeds(scope.role,now());
      const inserted=await insertSeeds(req,scope.id,scope.role,records);
      const checked=inspectManualFourMarketWallets(scope.role,inserted,now().getTime());
      if(!checked.ready)throw new Error('MANUAL_FOUR_MARKET_ATOMIC_INSERT_UNVERIFIED');
      return res.status(201).json(harmless({
        ok:true,ownerScope:'SELF',role:scope.role,
        ready:true,rlsGuardReady:true,manualExecutionReady:false,
        markets:checked.markets,perMarketInitialKrw:checked.perMarketInitialKrw,
        totalInitialKrw:checked.totalInitialKrw,virtualSeedRowsInserted:4,
        historicalRecordsDeleted:0,automaticPaperWalletsChanged:0,
        liveAccountsChanged:0,manualTradeExecutionEnabled:false,
      }));
    }catch(error){
      const code=error instanceof Error && error.message==='MANUAL_FOUR_MARKET_SEEDS_ALREADY_EXISTS'
        ? 'MANUAL_FOUR_MARKET_SEEDS_ALREADY_EXISTS':'MANUAL_FOUR_MARKET_ATOMIC_INSERT_UNVERIFIED';
      return res.status(code==='MANUAL_FOUR_MARKET_SEEDS_ALREADY_EXISTS'?409:503)
        .json(fail(code,'4시장 수동모의계좌 생성 안전검증이 완료되지 않았습니다.'));
    }
  });
  return router;
}
