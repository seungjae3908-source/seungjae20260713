import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { getSupabase,getUserSupabase,hasSupabaseServerKey } from '../lib/supabase';
import { hasCapability } from '../../../packages/member-access/src/index.js';
import type { StoredPaperJournalRecord } from '../services/paper-journal.types';
import {
  evaluateManualFourMarketPaperClosedCycle,
  evaluateManualFourMarketPaperOrderPath,
  buildManualPaperResearchReceipt,
  sameManualPaperResearchReceipt,
  type ManualPaperFourMarketCycleInput,
  type ManualPaperOrderPathInput,
  type ManualPaperResearchReceiptRow,
  manualPaperSequentialRow,
  sameManualPaperSequentialRow,
  projectManualPaperSequentialEvents,
  type ManualPaperSequentialEvent,
  type ManualPaperSequentialEventRow,
  type ManualPaperSequentialKind,
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
  orderPathPreviewEnabled:()=>boolean;
  readOrderPathEvidence:(owner:{id:string;role:ManualWalletRole},
    selected:ManualPaperPreviewSelection,nowMs:number)
    =>Promise<ManualPaperOrderPathInput|null>;
  now:()=>Date;
  listSeeds:(request:AuthenticatedRequest,ownerId:string)=>Promise<StoredPaperJournalRecord[]>;
  rlsReady:(request:AuthenticatedRequest)=>Promise<boolean>;
  insertSeeds:(request:AuthenticatedRequest,ownerId:string,role:ManualWalletRole,
    records:ReturnType<typeof buildManualFourMarketWalletSeeds>)=>Promise<StoredPaperJournalRecord[]>;
  bootstrapEnabled:()=>boolean;
  researchReceiptWriteEnabled:()=>boolean;
  researchReceiptRlsReady:(request:AuthenticatedRequest)=>Promise<boolean>;
  appendResearchReceipt:(request:AuthenticatedRequest,receipt:ManualPaperResearchReceiptRow)
    =>Promise<'INSERTED'|'DUPLICATE'>;
  listResearchReceipts:(request:AuthenticatedRequest,ownerId:string)
    =>Promise<Array<{cycle_id:string;market:string;receipt_sha256:string;
      receipt:Record<string,unknown>;created_at:string}>>;
  sequentialWriteEnabled:()=>boolean;
  sequentialRlsReady:(request:AuthenticatedRequest)=>Promise<boolean>;
  /** Real server-owned market exposure/atomic reservation proof; default OFF. */
  sequentialMarketAdmissionReady:(owner:{id:string;role:ManualWalletRole},
    selected:ManualPaperPreviewSelection,nowMs:number)=>Promise<boolean>;
  listSequentialRows:(request:AuthenticatedRequest,ownerId:string,orderId:string)
    =>Promise<ManualPaperSequentialEventRow[]>;
  appendSequentialRow:(request:AuthenticatedRequest,row:ManualPaperSequentialEventRow)
    =>Promise<'INSERTED'|'DUPLICATE'>;
  issueSequentialEvent:(input:Readonly<{
    owner:{id:string;role:ManualWalletRole};
    action:ManualPaperSequentialKind;
    orderId:string|null;
    selection:ManualPaperPreviewSelection|null;
    requestKey:string;
    existing:readonly ManualPaperSequentialEvent[];
    nowMs:number;
  }>)=>Promise<ManualPaperSequentialEvent|null>;
};
const READ_ONLY='MANUAL_PAPER_FOUR_MARKET_SEED_ONLY';
const RESEARCH_LEDGER_TABLE='paper_manual_four_market_research_receipts' as const;
const SEQUENTIAL_LEDGER_TABLE='paper_manual_four_market_order_events' as const;
const sequentialKinds=['OPEN_ORDER','ENTRY_MATCH','CANCEL_ENTRY',
  'REQUEST_EXIT','EXIT_MATCH','CANCEL_EXIT'] as const;
export const MANUAL_RESEARCH_RECEIPT_CONFIRMATION =
  'RECORD_MANUAL_PAPER_RESEARCH_ONLY_PRESERVE_LOSSES' as const;
const selectionKeys=['market','symbol','strategyId','candidateId','side',
  'leverage','requestedNotionalKrw'] as const;
function validSelection(raw:unknown):raw is ManualPaperPreviewSelection {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
  const p=raw as Record<string,unknown>,keys=Object.keys(p);
  return keys.length===selectionKeys.length
    &&keys.every(key=>selectionKeys.includes(key as typeof selectionKeys[number]))
    &&['domestic_stock','us_stock','crypto_spot','crypto_futures'].includes(String(p.market))
    &&typeof p.symbol==='string'&&/^[A-Z0-9._-]{2,35}$/u.test(p.symbol)
    &&typeof p.strategyId==='string'&&/^[A-Za-z0-9:._-]{1,120}$/u.test(p.strategyId)
    &&typeof p.candidateId==='string'&&/^[A-Za-z0-9:._-]{1,120}$/u.test(p.candidateId)
    &&['BUY','LONG','SHORT'].includes(String(p.side))
    &&typeof p.leverage==='number'&&Number.isInteger(p.leverage)&&p.leverage>=1&&p.leverage<=125
    &&typeof p.requestedNotionalKrw==='number'
    &&Number.isFinite(p.requestedNotionalKrw)
    &&p.requestedNotionalKrw>0&&p.requestedNotionalKrw<=125_000_000;
}
function validModeSelection(p:ManualPaperPreviewSelection):boolean {
  return p.market==='crypto_futures'
    ?(p.side==='LONG'||p.side==='SHORT')
    :(p.side==='BUY'&&p.leverage===1);
}
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
  const orderPathPreviewEnabled=deps.orderPathPreviewEnabled??(
    ()=>process.env.MANUAL_FOUR_MARKET_PAPER_ORDER_PATH_PREVIEW_ENABLED==='true');
  // Product runtime is intentionally unavailable until a certified server
  // public quote + sizing + model source is independently implemented.
  const orderPathReader=deps.readOrderPathEvidence??(async()=>null);
  // Fail closed in the product runtime until an independently certified
  // public provider+backtest/OOS+cost source is actually wired.
  const researchReader=deps.readResearchCycleEvidence??(async()=>null);
  const researchReceiptWriteEnabled=deps.researchReceiptWriteEnabled??(
    ()=>process.env.MANUAL_FOUR_MARKET_PAPER_RESEARCH_RECEIPT_WRITE_ENABLED==='true');
  const researchReceiptRlsReady=deps.researchReceiptRlsReady??(async req=>{
    if(!req.accessToken)return false;
    const {data,error}=await getUserSupabase(req.accessToken)
      .rpc('manual_four_market_paper_receipt_rls_guard_ready');
    return !error&&data===true;
  });
  const appendResearchReceipt=deps.appendResearchReceipt??(async(req,receipt)=>{
    if(!req.accessToken||req.member?.id!==receipt.user_id
      ||!hasSupabaseServerKey())throw new Error('PAPER_RESEARCH_RECEIPT_OWNER_OR_SERVER_KEY_REQUIRED');
    const client=getSupabase();
    const {data,error}=await client.from(RESEARCH_LEDGER_TABLE)
      .insert(receipt).select('user_id,cycle_id,wallet_id,owner_role,market,epoch_id,round_number,receipt_sha256,receipt')
      .maybeSingle();
    if(error?.code==='23505'){
      // Unique collision is idempotent ONLY when the persisted owner, epoch,
      // exact receipt digest and non-execution claims all match.
      const read=await client.from(RESEARCH_LEDGER_TABLE)
        .select('user_id,cycle_id,wallet_id,owner_role,market,epoch_id,round_number,receipt_sha256,receipt')
        .eq('user_id',receipt.user_id).eq('cycle_id',receipt.cycle_id).maybeSingle();
      if(read.error || !read.data || !sameManualPaperResearchReceipt(receipt,read.data))
        throw new Error('PAPER_RESEARCH_RECEIPT_DUPLICATE_EVIDENCE_CONFLICT');
      return 'DUPLICATE' as const;
    }
    if(error||!data||!sameManualPaperResearchReceipt(receipt,data))
      throw new Error('PAPER_RESEARCH_RECEIPT_DB_READBACK_UNVERIFIED');
    return 'INSERTED' as const;
  });
  const listResearchReceipts=deps.listResearchReceipts??(async(req,ownerId)=>{
    if(req.member?.id!==ownerId||!req.accessToken)
      throw new Error('PAPER_RESEARCH_RECEIPT_OWNER_SCOPE_REQUIRED');
    const {data,error}=await getUserSupabase(req.accessToken)
      .from(RESEARCH_LEDGER_TABLE)
      .select('cycle_id,market,receipt_sha256,receipt,created_at')
      .eq('user_id',ownerId)
      .order('created_at',{ascending:false}).limit(100);
    if(error||!Array.isArray(data))throw new Error('PAPER_RESEARCH_RECEIPT_READ_UNAVAILABLE');
    return data;
  });


  const sequentialWriteEnabled=deps.sequentialWriteEnabled??(
    ()=>process.env.MANUAL_FOUR_MARKET_PAPER_SEQ_EVENT_WRITE_ENABLED==='true');
  const sequentialMarketAdmissionReady=
    deps.sequentialMarketAdmissionReady??(async()=>false);
  const sequentialRlsReady=deps.sequentialRlsReady??(async req=>{
    if(!req.accessToken)return false;
    const {data,error}=await getUserSupabase(req.accessToken)
      .rpc('manual_four_market_paper_sequential_guard_ready');
    return !error&&data===true;
  });
  const listSequentialRows=deps.listSequentialRows??(async(req,ownerId,orderId)=>{
    if(!req.accessToken||req.member?.id!==ownerId)
      throw new Error('MANUAL_PAPER_SEQ_READ_OWNER_REQUIRED');
    const {data,error}=await getUserSupabase(req.accessToken)
      .from(SEQUENTIAL_LEDGER_TABLE)
      .select('user_id,wallet_id,order_id,event_id,request_key,sequence_number,market,owner_role,event_sha256,event')
      .eq('user_id',ownerId).eq('order_id',orderId)
      .order('sequence_number',{ascending:true}).range(0,1000);
    if(error||!Array.isArray(data)||data.length>1000)
      throw new Error('MANUAL_PAPER_SEQ_READ_INCOMPLETE');
    return data as ManualPaperSequentialEventRow[];
  });
  const appendSequentialRow=deps.appendSequentialRow??(async(req,row)=>{
    if(!req.accessToken||req.member?.id!==row.user_id
      ||!hasSupabaseServerKey())throw new Error('MANUAL_PAPER_SEQ_SERVER_OWNER_REQUIRED');
    const client=getSupabase();
    const columns='user_id,wallet_id,order_id,event_id,request_key,sequence_number,market,owner_role,event_sha256,event';
    const {data,error}=await client.from(SEQUENTIAL_LEDGER_TABLE)
      .insert(row).select(columns).maybeSingle();
    if(error?.code==='23505'){
      // Both sequence and request-key collisions are expected under races.
      // Retry is idempotent only with exact immutable economic content.
      const old=await client.from(SEQUENTIAL_LEDGER_TABLE)
        .select(columns).eq('user_id',row.user_id)
        .eq('order_id',row.order_id)
        .eq('request_key',row.request_key).maybeSingle();
      if(old.error||!old.data||!sameManualPaperSequentialRow(row,old.data))
        throw new Error('MANUAL_PAPER_SEQ_CONCURRENT_OR_DIGEST_CONFLICT');
      return 'DUPLICATE' as const;
    }
    if(error||!data||!sameManualPaperSequentialRow(row,data))
      throw new Error('MANUAL_PAPER_SEQ_APPEND_READBACK_UNVERIFIED');
    return 'INSERTED' as const;
  });
  // No public/product HTTP request can create quote fills. Until certified
  // prospective signal, public market, full-cost and funding sources are wired,
  // every financial event generation path remains unavailable.
  const issueSequentialEvent=deps.issueSequentialEvent??(async()=>null);
  const verifiedSequentialHistory=(
    rows:ManualPaperSequentialEventRow[],ownerId:string,orderId:string,
    atMs:number,
  )=>{
    if(rows.length>1000)throw new Error('MANUAL_PAPER_SEQ_HISTORY_TOO_LONG');
    const events:ManualPaperSequentialEvent[]=rows.map(row=>{
      if(row.user_id!==ownerId||row.order_id!==orderId
        ||!row.event||typeof row.event!=='object'
        ||row.event.ownerId!==ownerId||row.event.orderId!==orderId)
        throw new Error('MANUAL_PAPER_SEQ_FOREIGN_EVENT');
      const canonical=manualPaperSequentialRow(row.event);
      if(!sameManualPaperSequentialRow(canonical,row))
        throw new Error('MANUAL_PAPER_SEQ_DURABLE_HASH_MISMATCH');
      return row.event;
    });
    const projected=projectManualPaperSequentialEvents(events,atMs);
    if(projected.status==='BLOCKED')throw new Error('MANUAL_PAPER_SEQ_REPLAY_INVALID');
    return {events,projected};
  };

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


  // Research-only durable receipt: never an actual Paper fill, wallet credit,
  // 50/50 reserve settlement, or real provider order. Both server guard and
  // independent feature flag default OFF until separate approved deployment.
  router.post('/paper-trading/manual-four-market/research-cycle-record',
    async(req:AuthenticatedRequest,res)=>{
      res.set('Cache-Control','no-store');
      const owner=authenticatedOwner(req);
      if(!owner)return res.status(403).json(fail('CAPABILITY_REQUIRED',
        '수동모의 연구 회차 기록 권한이 없습니다.'));
      if(!researchPreviewEnabled()||!researchReceiptWriteEnabled())
        return res.status(409).json(fail('MANUAL_PAPER_RESEARCH_RECEIPT_WRITE_OFF',
          '모의연구 회차 기록은 아직 활성화되지 않았습니다.'));
      const body=req.body;
      if(Object.keys(req.query).length || !body || typeof body!=='object'
        || Array.isArray(body)||Object.keys(body).length!==2
        || body.confirmation!==MANUAL_RESEARCH_RECEIPT_CONFIRMATION
        || !validSelection(body.selection)
        || Buffer.byteLength(JSON.stringify(body),'utf8')>2300
        || !validModeSelection(body.selection)) {
        return res.status(400).json(fail('MANUAL_PAPER_RESEARCH_RECEIPT_SELECTION_INVALID',
          '모의연구 확인문구·종목·수식·레버리지를 다시 확인하세요.'));
      }
      const selected=body.selection as ManualPaperPreviewSelection;
      const currentMs=now().getTime();
      if(!Number.isSafeInteger(currentMs)||currentMs<=0)
        return res.status(503).json(fail('MANUAL_PAPER_RESEARCH_SERVER_CLOCK_INVALID',
          '서버 시각 증거가 유효하지 않습니다.'));
      try {
        const [walletGuard,receiptGuard,seeds]=await Promise.all([
          rlsReady(req),researchReceiptRlsReady(req),listSeeds(req,owner.id),
        ]);
        const wallet=inspectManualFourMarketWallets(owner.role,seeds,currentMs);
        if(!walletGuard || !receiptGuard || !wallet.ready){
          return res.status(409).json(fail('MANUAL_PAPER_RESEARCH_LEDGER_OR_WALLET_NOT_READY',
            '본인 4시장 모의계좌 및 불변 연구 원장 보호가 확인되지 않았습니다.'));
        }
        const evidence=await researchReader(owner,selected,currentMs);
        if(!evidence)return res.status(409).json(fail('MANUAL_PAPER_CERTIFIED_RESEARCH_DATA_REQUIRED',
          '독립적으로 검증된 서버 전략·시세·비용·환율 자료가 없습니다.'));
        const s=evidence.selected;
        if(evidence.nowMs!==currentMs||s?.ownerId!==owner.id
          ||s.role!==owner.role||s.mode!=='manual'
          ||!selectionKeys.every(k=>s[k]===selected[k])){
          return res.status(409).json(fail('MANUAL_PAPER_EVIDENCE_OWNER_OR_SELECTION_MISMATCH',
            '현재 회원의 서버 연구 증거와 선택 조건이 일치하지 않습니다.'));
        }
        const calculation=evaluateManualFourMarketPaperClosedCycle(evidence);
        if(calculation.status!=='RESEARCH_SIMULATED_CLOSED'){
          return res.status(409).json(fail('MANUAL_PAPER_EVIDENCE_BLOCKED',
            '모의연구의 안전·시간·원가 증거 검증에 실패했습니다.',
            {blockers:calculation.blockers}));
        }
        const receipt=buildManualPaperResearchReceipt(evidence,calculation);
        if(receipt.user_id!==owner.id||receipt.owner_role!==owner.role)
          throw new Error('PAPER_RESEARCH_RECEIPT_SCOPE_MISMATCH');
        const outcome=await appendResearchReceipt(req,receipt);
        if(outcome!=='INSERTED'&&outcome!=='DUPLICATE')
          throw new Error('PAPER_RESEARCH_RECEIPT_WRITE_UNVERIFIED');
        return res.status(outcome==='INSERTED'?201:200).json(harmless({
          ok:true,mode:'MANUAL_PAPER_RESEARCH_RECEIPT_ONLY',ownerScope:'SELF',
          researchReceiptRecorded:true,duplicateResearchReceipt:outcome==='DUPLICATE',
          cycleId:receipt.cycle_id,receiptSha256:receipt.receipt_sha256,
          researchReceiptInsertionsByThisRequest:outcome==='INSERTED'?1:0,
          actualPaperLedgerWritten:false,realPaperOrderCreated:false,
          hypotheticalOnly:true,profitabilityProven:false,
          financialMutationCount:0,automaticWithdrawalEnabled:false,
        }));
      }catch{
        // Do not disclose service-role, schema, private data, or a conflicting
        // historical receipt. A conflict is NEVER an authorization to rewrite.
        return res.status(409).json(fail('MANUAL_PAPER_RESEARCH_RECEIPT_NOT_RECORDED',
          '중복·원장 무결성·서버 증거를 확인할 수 없어 연구 회차를 기록하지 않았습니다.'));
      }
    });

  // Owner-only, bounded archive. A missing migration is an error, not a
  // fabricated empty history; receipt payload never authorizes live trading.
  router.get('/paper-trading/manual-four-market/research-cycle-history',
    async(req:AuthenticatedRequest,res)=>{
      res.set('Cache-Control','no-store');
      const owner=authenticatedOwner(req);
      if(!owner)return res.status(403).json(fail('CAPABILITY_REQUIRED',
        '본인 수동모의 연구 이력 권한이 없습니다.'));
      if(Object.keys(req.query).length)
        return res.status(400).json(fail('MANUAL_PAPER_RESEARCH_QUERY_FORBIDDEN',
          '다른 회원 또는 임의 조회 조건을 지정할 수 없습니다.'));
      try{
        if(!await researchReceiptRlsReady(req))
          return res.status(409).json(fail('MANUAL_PAPER_RESEARCH_LEDGER_NOT_READY',
            '연구 원장 DB 읽기 권한 및 불변 보호를 확인할 수 없습니다.'));
        const rows=await listResearchReceipts(req,owner.id);
        if(!Array.isArray(rows)||rows.length>100)
          throw new Error('PAPER_RESEARCH_ARCHIVE_TOO_LARGE');
        const records=rows.map(row=>{
          const v=row.receipt;
          if(!v||typeof v!=='object'
            ||v.ownerId!==owner.id||v.role!==owner.role
            ||v.cycleId!==row.cycle_id||v.market!==row.market
            ||v.executionAuthority!=='NONE'
            ||v.actualPaperLedgerWritten!==false
            ||v.realOrderSubmitted!==false||v.profitabilityProven!==false
            ||typeof v.hypotheticalNetPnlKrw!=='number'
            ||!Number.isFinite(v.hypotheticalNetPnlKrw)
            ||typeof row.receipt_sha256!=='string'
            ||!/^[a-f0-9]{64}$/u.test(row.receipt_sha256))
            throw new Error('PAPER_RESEARCH_ARCHIVE_EVIDENCE_INVALID');
          return {
            cycleId:row.cycle_id,market:row.market,receiptSha256:row.receipt_sha256,
            recordedAt:row.created_at,status:'RESEARCH_SIMULATED_CLOSED',
            hypotheticalNetPnlKrw:v.hypotheticalNetPnlKrw,
            actualPaperLedgerWritten:false,profitabilityProven:false,
          };
        });
        return res.json(harmless({ok:true,
          mode:'MANUAL_PAPER_RESEARCH_RECEIPT_READ_ONLY',ownerScope:'SELF',
          readOnlyProbe:true,receipts:records,hasMoreThan100:rows.length===100,
          financialMutationCount:0,actualPaperLedgerWritten:false,
          profitabilityProven:false}));
      }catch{
        return res.status(503).json(fail('MANUAL_PAPER_RESEARCH_ARCHIVE_UNAVAILABLE',
          '현재 회원의 검증된 연구 기록을 조회할 수 없습니다.'));
      }
    });


  /**
   * Server-only four-market simulated order lifecycle diagnostic:
   * entry matches -> partial-fill preview -> reducing exits -> hypothetical
   * KRW PnL. No provider, actual Paper order, account debit, wallet settlement
   * or durable fill. OFF by default. Browser may send SELECTED SYMBOL/STRATEGY
   * only; never fills, OHLC price, costs, funding or timestamps.
   */
  router.post('/paper-trading/manual-four-market/order-cycle-preview',
    async(req:AuthenticatedRequest,res)=>{
      res.set('Cache-Control','no-store');
      const scope=authenticatedOwner(req);
      if(!scope)return res.status(403).json(fail('CAPABILITY_REQUIRED',
        '수동모의 주문 흐름 미리보기 권한이 없습니다.'));
      if(!orderPathPreviewEnabled())
        return res.status(409).json(fail('MANUAL_PAPER_ORDER_PATH_PREVIEW_OFF',
          '모의주문 체결 흐름 미리보기는 현재 비활성화입니다.'));
      const selected:unknown=req.body;
      if(Object.keys(req.query).length||!validSelection(selected)
        ||!validModeSelection(selected)
        ||Buffer.byteLength(JSON.stringify(selected),'utf8')>2048) {
        return res.status(400).json(fail('MANUAL_PAPER_ORDER_PATH_SELECTION_INVALID',
          '시장·종목·전략·방향·레버리지 조건을 다시 확인하세요.'));
      }
      const nowMs=now().getTime();
      if(!Number.isSafeInteger(nowMs)||nowMs<=0)
        return res.status(503).json(fail('MANUAL_PAPER_ORDER_PATH_CLOCK_INVALID',
          '서버 시각을 확인하지 못했습니다.'));
      try{
        const [rls,records]=await Promise.all([
          rlsReady(req),listSeeds(req,scope.id),
        ]);
        const wallet=inspectManualFourMarketWallets(scope.role,records,nowMs);
        if(!rls||!wallet.ready)
          return res.status(409).json(fail('MANUAL_PAPER_ORDER_PATH_WALLET_OR_RLS_REQUIRED',
            '본인 수동모의계좌와 DB 보호가 검증되지 않았습니다.'));
        const evidence=await orderPathReader(scope,selected,nowMs);
        if(!evidence)
          return res.status(409).json(fail('MANUAL_PAPER_ORDER_PATH_SERVER_SOURCE_REQUIRED',
            '서버 검증 시세와 모의 체결 모델 증거가 준비되지 않았습니다.'));
        const owner=evidence.cycle?.selected;
        if(!owner||owner.ownerId!==scope.id
          ||owner.role!==scope.role||owner.mode!=='manual'
          ||evidence.cycle.nowMs!==nowMs
          ||!selectionKeys.every(k=>owner[k]===selected[k])) {
          return res.status(409).json(fail('MANUAL_PAPER_ORDER_PATH_OWNER_OR_SELECTION_MISMATCH',
            '본인 전략과 서버 모의주문 증거가 일치하지 않습니다.'));
        }
        const evaluation=evaluateManualFourMarketPaperOrderPath(evidence);
        if(evaluation.status==='BLOCKED')
          return res.status(409).json(fail('MANUAL_PAPER_ORDER_PATH_EVIDENCE_BLOCKED',
            '모의 주문·부분체결·청산 증거가 검사를 통과하지 못했습니다.',
            {blockers:evaluation.blockers}));
        return res.status(200).json(harmless({
          ok:true,ownerScope:'SELF',previewOnly:true,
          simulatedOrderPath:evaluation,
          actualPaperOrderCreated:false,actualPaperFillsRecorded:false,
          actualPaperLedgerWritten:false,realPaperOrderCreated:false,
          financialMutationCount:0,profitabilityProven:false,
          transferAuthority:false,withdrawalAuthority:false,
        }));
      }catch{
        return res.status(503).json(fail('MANUAL_PAPER_ORDER_PATH_SOURCE_UNAVAILABLE',
          '모의주문 흐름 검증에 필요한 서버 증거를 조회하지 못했습니다.'));
      }
    });


  /** Financially isolated Paper simulation ledger: progressive server events,
   * not a real-provider or canonical financial journal execution endpoint.
   * No client quote, fill quantity, fee/tax/FX/funding, seed, or account input.
   */
  router.post('/paper-trading/manual-four-market/sequential-order/step',
    async(req:AuthenticatedRequest,res)=>{
      res.set('Cache-Control','no-store');
      const owner=authenticatedOwner(req);
      if(!owner)return res.status(403).json(fail('CAPABILITY_REQUIRED',
        '본인 수동모의 주문 이벤트 권한이 없습니다.'));
      if(!sequentialWriteEnabled())
        return res.status(409).json(fail('MANUAL_PAPER_SEQ_WRITE_OFF',
          '서버 모의주문 이벤트 기록이 비활성화 상태입니다.'));
      const p=req.body;
      if(Object.keys(req.query).length||!p||typeof p!=='object'
        ||Array.isArray(p)||!sequentialKinds.includes(p.action)
        ||typeof p.requestKey!=='string'
        ||!/^[A-Za-z0-9:._-]{1,150}$/u.test(p.requestKey)
        ||Buffer.byteLength(JSON.stringify(p),'utf8')>2300
        ||(p.action==='OPEN_ORDER'
          ?(Object.keys(p).length!==3 ||p.orderId!==undefined
            ||!validSelection(p.selection)||!validModeSelection(p.selection))
          :(Object.keys(p).length!==3||typeof p.orderId!=='string'
            ||!/^manual-paper-seq-order-v1:[a-f0-9]{64}$/u.test(p.orderId)
            ||p.selection!==undefined))) {
        return res.status(400).json(fail('MANUAL_PAPER_SEQ_REQUEST_INVALID',
          '주문 동작·본인 종목/전략 선택·재시도 식별자를 확인하세요.'));
      }
      const nowMs=now().getTime();
      if(!Number.isSafeInteger(nowMs)||nowMs<=0)
        return res.status(503).json(fail('MANUAL_PAPER_SEQ_CLOCK_INVALID',
          '서버 시각을 확인할 수 없습니다.'));
      try{
        const [walletGuard,eventGuard,seeds]=await Promise.all([
          rlsReady(req),sequentialRlsReady(req),listSeeds(req,owner.id),
        ]);
        if(!walletGuard||!eventGuard
          ||!inspectManualFourMarketWallets(owner.role,seeds,nowMs).ready)
          return res.status(409).json(fail('MANUAL_PAPER_SEQ_WALLET_OR_DB_NOT_READY',
            '본인 4시장 모의계좌·불변 원장 보호가 준비되지 않았습니다.'));
        const action=p.action as ManualPaperSequentialKind;
        const selected=action==='OPEN_ORDER'
          ?p.selection as ManualPaperPreviewSelection:null;
        const orderId=action==='OPEN_ORDER'?null:p.orderId as string;
        // The per-order event CAS does NOT guard the owner's market-wide
        // collateral. Until a true backend atomic market-slot reservation
        // is proven, never allow two Paper orders to spend the same 1m seed.
        if(selected && !await sequentialMarketAdmissionReady(owner,selected,nowMs))
          return res.status(409).json(fail('MANUAL_PAPER_SEQ_MARKET_RESERVATION_REQUIRED',
            '동시 모의주문 자본 중복사용 방지가 아직 검증되지 않았습니다.'));
        const history=orderId
          ?verifiedSequentialHistory(await listSequentialRows(req,owner.id,orderId),
            owner.id,orderId,nowMs)
          :{events:[] as ManualPaperSequentialEvent[],projected:null};
        const replay=history.events.find(event=>event.requestKey===p.requestKey);
        if(replay){
          if(replay.kind!==action)return res.status(409).json(fail(
            'MANUAL_PAPER_SEQ_IDEMPOTENCY_CONFLICT',
            '같은 요청 ID가 다른 주문 작업에 사용되었습니다.'));
          return res.json(harmless({
            ok:true,ownerScope:'SELF',mode:'PAPER_SEQUENTIAL_SIMULATION_ONLY',
            duplicate:true,orderId:replay.orderId,
            recordedEventId:replay.eventId,recordedSequence:replay.sequence,
            eventInsertionsByThisRequest:0,
            actualBrokerFill:false,actualPaperLedgerWritten:false,
            actualWalletMutation:false,financialMutationCount:0,
            profitabilityProven:false,
          }));
        }
        const generated=await issueSequentialEvent({
          owner,action,orderId,selection:selected,
          requestKey:p.requestKey,existing:history.events,nowMs,
        });
        if(!generated)
          return res.status(409).json(fail('MANUAL_PAPER_SEQ_CERTIFIED_SOURCE_REQUIRED',
            '검증된 시장·전략·모의 체결 증거 공급원이 아직 연결되지 않았습니다.'));
        const effectiveOrderId=orderId??generated.orderId;
        if(generated.ownerId!==owner.id||generated.role!==owner.role
          ||generated.orderId!==effectiveOrderId||generated.kind!==action
          ||generated.requestKey!==p.requestKey
          ||(orderId!==null&&generated.orderId!==orderId))
          return res.status(409).json(fail('MANUAL_PAPER_SEQ_OWNER_OR_SOURCE_MISMATCH',
            '본인 모의주문·소스 증거 식별자가 일치하지 않습니다.'));
        if(selected && (!generated.session
          ||generated.session.ownerId!==owner.id
          ||generated.session.role!==owner.role
          ||Object.entries(selected).some(([key,value])=>
            (generated.session as unknown as Record<string,unknown>)[key]!==value)))
          return res.status(409).json(fail('MANUAL_PAPER_SEQ_STRATEGY_MISMATCH',
            '선택한 종목·전략과 서버 주문 증거가 다릅니다.'));
        const state=orderId===null
          ?verifiedSequentialHistory(
            await listSequentialRows(req,owner.id,effectiveOrderId),
            owner.id,effectiveOrderId,nowMs)
          :history;
        // ONCE a requestId is seen, the stored value is authoritative.
        const already=state.events.find(event=>event.requestKey===p.requestKey);
        const event=generated;
        const proposal=manualPaperSequentialRow(event);
        if(already){
          const prevRow=manualPaperSequentialRow(already);
          if(!sameManualPaperSequentialRow(proposal,prevRow))
            return res.status(409).json(fail('MANUAL_PAPER_SEQ_EVIDENCE_CONFLICT',
              '중복 요청에 다른 경제·체결 증거가 제공되었습니다.'));
          return res.json(harmless({
            ok:true,ownerScope:'SELF',mode:'PAPER_SEQUENTIAL_SIMULATION_ONLY',
            duplicate:true,orderId:already.orderId,
            recordedEventId:already.eventId,recordedSequence:already.sequence,
            eventInsertionsByThisRequest:0,
            actualBrokerFill:false,actualPaperLedgerWritten:false,
            actualWalletMutation:false,financialMutationCount:0,
            profitabilityProven:false,
          }));
        }
        if(event.sequence!==state.events.length+1)
          return res.status(409).json(fail('MANUAL_PAPER_SEQ_STALE_SEQUENCE',
            '동시 모의주문 상태가 변경되어 재조회가 필요합니다.'));
        const candidate=projectManualPaperSequentialEvents(
          [...state.events,event],nowMs);
        if(candidate.status==='BLOCKED')
          return res.status(409).json(fail('MANUAL_PAPER_SEQ_PROJECTION_BLOCKED',
            '중복·부분체결·정산·증거금·시각 안전검사를 통과하지 못했습니다.',
            {blockers:candidate.blockers}));
        const outcome=await appendSequentialRow(req,proposal);
        if(outcome!=='INSERTED'&&outcome!=='DUPLICATE')
          throw new Error('MANUAL_PAPER_SEQ_APPEND_UNVERIFIED');
        return res.status(outcome==='INSERTED'?201:200).json(harmless({
          ok:true,ownerScope:'SELF',mode:'PAPER_SEQUENTIAL_SIMULATION_ONLY',
          duplicate:outcome==='DUPLICATE',
          orderId:event.orderId,recordedEventId:event.eventId,
          recordedSequence:event.sequence,
          eventInsertionsByThisRequest:outcome==='INSERTED'?1:0,
          projection:candidate,
          actualBrokerFill:false,actualPaperLedgerWritten:false,
          actualWalletMutation:false,financialMutationCount:0,
          profitabilityProven:false,
        }));
      }catch{
        return res.status(409).json(fail('MANUAL_PAPER_SEQ_NOT_RECORDED',
          '주문 이벤트 중복·원장 무결성 또는 서버 증거를 확인할 수 없습니다.'));
      }
    });

  router.get('/paper-trading/manual-four-market/sequential-order/:orderId',
    async(req:AuthenticatedRequest,res)=>{
      res.set('Cache-Control','no-store');
      const owner=authenticatedOwner(req);
      if(!owner)return res.status(403).json(fail('CAPABILITY_REQUIRED',
        '본인 수동모의 주문 조회 권한이 없습니다.'));
      const orderId=req.params.orderId;
      if(Object.keys(req.query).length||typeof orderId!=='string'
        ||!/^manual-paper-seq-order-v1:[a-f0-9]{64}$/u.test(orderId))
        return res.status(400).json(fail('MANUAL_PAPER_SEQ_READ_REQUEST_INVALID',
          '올바른 모의주문 ID만 조회할 수 있습니다.'));
      try{
        if(!await sequentialRlsReady(req))
          return res.status(409).json(fail('MANUAL_PAPER_SEQ_DB_NOT_READY',
            '모의주문 이벤트 DB 보호가 확인되지 않았습니다.'));
        const history=verifiedSequentialHistory(
          await listSequentialRows(req,owner.id,orderId),
          owner.id,orderId,now().getTime());
        if(history.events.length===0)
          return res.status(404).json(fail('MANUAL_PAPER_SEQ_ORDER_NOT_FOUND',
            '본인에게 해당하는 모의주문 기록이 없습니다.'));
        const projection=history.projected;
        return res.json(harmless({
          ok:true,ownerScope:'SELF',mode:'PAPER_SEQUENTIAL_SIMULATION_READ_ONLY',
          readOnlyProbe:true,projection,
          eventHistory:history.events.map(e=>({
            eventId:e.eventId,sequence:e.sequence,kind:e.kind,
            observedAtMs:e.observedAtMs,
          })),
          actualBrokerFill:false,actualPaperLedgerWritten:false,
          actualWalletMutation:false,financialMutationCount:0,
          profitabilityProven:false,
        }));
      }catch{
        return res.status(503).json(fail('MANUAL_PAPER_SEQ_HISTORY_UNVERIFIED',
          '현재 회원의 모의주문 이력을 안전하게 조회하지 못했습니다.'));
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
