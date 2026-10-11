import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { getSupabase,getUserSupabase,hasSupabaseServerKey } from '../lib/supabase';
import { hasCapability } from '../../../packages/member-access/src/index.js';
import type { StoredPaperJournalRecord } from '../services/paper-journal.types';
import {
  evaluateManualFourMarketPaperClosedCycle,
  type ManualPaperFourMarketCycleInput,
} from '../services/manual-four-market-paper-cycle.service';
import {
  MANUAL_FOUR_MARKET_CONFIRMATION,
  buildManualFourMarketWalletSeeds,
  inspectManualFourMarketWallets,
  manualWalletCreationReadiness,
  type ManualWalletRole,
} from '../services/manual-four-market-paper-wallets.service';

type ManualPaperPreviewSelection = Readonly<{
  market:'domestic_stock'|'us_stock'|'crypto_spot'|'crypto_futures';
  symbol:string;
  strategyId:string;
  candidateId:string;
  side:'BUY'|'LONG'|'SHORT';
  leverage:number;
  requestedNotionalKrw:number;
}>;
type ManualFourMarketDeps = {
  // Trusted owner service must return the *complete* server-readback quote,
  // strategy/receipt and cost/FX evidence, never a client body or mock PASS.
  readResearchCycleEvidence:(owner:{id:string;role:ManualWalletRole},
    selected:ManualPaperPreviewSelection,nowMs:number)
    =>Promise<ManualPaperFourMarketCycleInput|null>;
  researchPreviewEnabled:()=>boolean;
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
  const researchPreviewEnabled=deps.researchPreviewEnabled??(
    ()=>process.env.MANUAL_FOUR_MARKET_PAPER_RESEARCH_PREVIEW_ENABLED==='true');
  // Fail closed in the product runtime until an independently certified
  // public provider+backtest/OOS+cost source is actually wired.
  const researchReader=deps.readResearchCycleEvidence??(async()=>null);

  // Owner-scoped pure research preview, never a trade execution endpoint.
  // All economic numbers come from injected SERVER evidence. No client-supplied
  // quote/FX/cost/RLS/receipt/settlement or self-asserted PASS is accepted.
  router.post('/paper-trading/manual-four-market/research-cycle-preview',
    async(req:AuthenticatedRequest,res)=>{
    res.set('Cache-Control','no-store');
    const scope=authenticatedOwner(req);
    if(!scope)return res.status(403).json(fail('CAPABILITY_REQUIRED',
      '수동모의 연구 미리보기 회원 권한이 없습니다.'));
    if(!researchPreviewEnabled())return res.status(409).json(fail(
      'MANUAL_PAPER_RESEARCH_PREVIEW_OFF','연구용 모의거래 미리보기는 현재 비활성화입니다.'));
    const raw=req.body;
    const allowed=['market','symbol','strategyId','candidateId','side','leverage','requestedNotionalKrw'];
    if(Object.keys(req.query).length || !raw || typeof raw!=='object'
      || Array.isArray(raw) || Object.keys(raw).length!==allowed.length
      || !Object.keys(raw).every(k=>allowed.includes(k))
      || Buffer.byteLength(JSON.stringify(raw),'utf8')>2048
      || !['domestic_stock','us_stock','crypto_spot','crypto_futures'].includes(raw.market)
      || typeof raw.symbol!=='string'|| !/^[A-Z0-9._-]{2,35}$/u.test(raw.symbol)
      || typeof raw.strategyId!=='string'|| !/^[A-Za-z0-9:._-]{1,120}$/u.test(raw.strategyId)
      || typeof raw.candidateId!=='string'|| !/^[A-Za-z0-9:._-]{1,120}$/u.test(raw.candidateId)
      || !['BUY','LONG','SHORT'].includes(raw.side)
      || !Number.isInteger(raw.leverage) || raw.leverage<1 || raw.leverage>125
      || !Number.isFinite(raw.requestedNotionalKrw)
      || raw.requestedNotionalKrw<=0||raw.requestedNotionalKrw>125_000_000) {
      return res.status(400).json(fail('MANUAL_PAPER_RESEARCH_SELECTION_INVALID',
        '시장·종목·수식·방향·레버리지·가상금액을 다시 확인하세요.'));
    }
    // Approved members with PaperTrading access may study *simulated*
    // futures and spot without gaining the separate LIVE futures trading
    // capability. This Paper-only route never calls a private provider API.
    if(raw.market!=='crypto_futures'&&(raw.side!=='BUY'||raw.leverage!==1)){
      return res.status(400).json(fail('MANUAL_PAPER_NONFUTURES_LONG_ONLY',
        '주식·코인현물은 레버리지 없이 매수만 허용됩니다.'));
    }
    if(raw.market==='crypto_futures'&&!['LONG','SHORT'].includes(raw.side)){
      return res.status(400).json(fail('MANUAL_PAPER_FUTURES_DIRECTION_INVALID',
        '모의선물은 LONG 또는 SHORT를 선택해야 합니다.'));
    }
    const picked:ManualPaperPreviewSelection={
      market:raw.market,symbol:raw.symbol,strategyId:raw.strategyId,
      candidateId:raw.candidateId,side:raw.side,leverage:raw.leverage,
      requestedNotionalKrw:raw.requestedNotionalKrw,
    };
    const at=now().getTime();
    if(!Number.isSafeInteger(at))return res.status(503).json(fail(
      'MANUAL_PAPER_SERVER_CLOCK_INVALID','모의거래 시각을 확인할 수 없습니다.'));
    try{
      const e=await researchReader(scope,picked,at);
      if(!e)return res.status(409).json(fail(
        'MANUAL_PAPER_CERTIFIED_RESEARCH_DATA_REQUIRED',
        '같은 시점의 서버 시세·전략·수수료·환율 증거가 아직 준비되지 않았습니다.'));
      const selected=e.selected;
      const own=selected.ownerId===scope.id&&selected.role===scope.role
        &&selected.mode==='manual'
        &&e.nowMs===at
        &&allowed.every(k=>selected[k as keyof ManualPaperPreviewSelection]
          ===picked[k as keyof ManualPaperPreviewSelection]);
      if(!own)return res.status(409).json(fail(
        'MANUAL_PAPER_EVIDENCE_OWNER_OR_SELECTION_MISMATCH',
        '현재 회원·종목·수식과 인증된 데이터가 일치하지 않습니다.'));
      const evaluated=evaluateManualFourMarketPaperClosedCycle(e);
      if(evaluated.status!=='RESEARCH_SIMULATED_CLOSED'){
        return res.status(409).json(fail(
          'MANUAL_PAPER_EVIDENCE_BLOCKED',
          '모의 연구 거래가 안전성 검사를 통과하지 못했습니다.',
          {blockers:evaluated.blockers}));
      }
      return res.status(200).json(harmless({
        ok:true,ownerScope:'SELF',result:evaluated,
        previewOnly:true,realPaperOrderCreated:false,
        paperLedgerWritten:false,entryOrderSubmitted:false,
        oosProfitabilityProven:false,
      }));
    }catch{
      return res.status(503).json(fail(
        'MANUAL_PAPER_EVIDENCE_SOURCE_UNAVAILABLE',
        '인증된 수동모의매매 근거를 읽지 못했습니다.'));
    }
  });

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
