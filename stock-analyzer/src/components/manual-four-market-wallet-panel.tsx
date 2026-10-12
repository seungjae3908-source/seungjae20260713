import {useEffect,useRef,useState} from 'react';
import {authorizedFetch} from '@/lib/auth-fetch';
import {useAuth} from '@/lib/auth';
import {
  MANUAL_FOUR_MARKETS,parseManualFourMarketStatus,
  manualPaperBootstrapAuthorized,parseManualFourMarketResearchHistory,
  parseManualSequentialOrderReadback,parseManualSequentialOrderList,
  type ManualFourMarketStatus,type ManualResearchHistoryReadback,
  type ManualSequentialOrderReadback,type ManualSequentialOrderList,
} from '@/lib/manual-four-market-paper-status';

const API='/api/paper-trading/manual-four-market';
const CONFIRM='START_MANUAL_FOUR_1M_PAPER_WALLETS_PRESERVE_HISTORY';
const money=(value:number)=>value.toLocaleString('ko-KR')+'원';
const SEQ_ORDER_ID=/^manual-paper-seq-order-v1:[a-f0-9]{64}$/u;
const sequenceStatusLabel:Record<ManualSequentialOrderReadback['projection']['status'],string>={
  ENTRY_PENDING:'진입 주문 대기',
  ENTRY_PARTIAL:'일부 진입 가정 체결',
  OPEN:'가상 포지션 유지',
  EXIT_PENDING:'청산 요청 대기',
  PARTIALLY_CLOSED:'일부 청산 가정',
  ENTRY_CANCELLED:'진입 취소 · 가상 체결 없음',
  CLOSED_PROJECTION:'연구용 가정 청산 완료',
};
/** Four-market manual Paper initial SEED readiness, never current cash or an
 * order form. Autonomous strategy selection/execution is intentionally OFF.
 */
export function ManualFourMarketWalletPanel(){
  const auth=useAuth();
  const userId=auth.user?.id??auth.profile?.id??'';
  const authorized=Boolean(userId&&auth.can('canAccessPaperTrading'));
  const [state,setState]=useState<{owner:string;value:ManualFourMarketStatus}|null>(null);
  const [history,setHistory]=useState<{owner:string;value:ManualResearchHistoryReadback}|null>(null);
  const [historyUnavailable,setHistoryUnavailable]=useState(false);
  const [recentOrders,setRecentOrders]=useState<{
    owner:string;value:ManualSequentialOrderList
  }|null>(null);
  const [recentOrdersUnavailable,setRecentOrdersUnavailable]=useState(false);
  const [sequenceId,setSequenceId]=useState('');
  const [sequenceResult,setSequenceResult]=useState<{
    owner:string;orderId:string;value:ManualSequentialOrderReadback
  }|null>(null);
  const [sequenceLoading,setSequenceLoading]=useState(false);
  const [sequenceError,setSequenceError]=useState('');
  const sequenceAbort=useRef<AbortController|null>(null);
  const [revision,setRevision]=useState(0);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [confirmOwner,setConfirmOwner]=useState<string|null>(null);
  const ownerRef=useRef(userId);
  ownerRef.current=userId;
  const [error,setError]=useState('');
  const status=authorized&&state?.owner===userId?state.value:null;
  const ownHistory=authorized&&history?.owner===userId?history.value:null;
  const ownRecentOrders=authorized&&recentOrders?.owner===userId
    ?recentOrders.value:null;
  const ownSequence=authorized&&sequenceResult?.owner===userId
    &&sequenceResult.orderId===sequenceId
      ?sequenceResult.value:null;
  const canConfirm=authorized && manualPaperBootstrapAuthorized(userId,confirmOwner,status);
  useEffect(()=>{
    // A pending seed creation dialog is NOT portable across authenticated
    // identities. A former user's async response cannot clear the next
    // user's errors or signal falsely that their wallet was created.
    setConfirmOwner(null);
    sequenceAbort.current?.abort();
    setRecentOrders(null);
    setRecentOrdersUnavailable(false);
    setSequenceId('');
    setSequenceResult(null);
    setSequenceError('');
    setSequenceLoading(false);
  },[userId,authorized]);
  useEffect(()=>{
    if(!authorized){
      setState(null);setHistory(null);setHistoryUnavailable(false);
      setLoading(false);setError('');return;
    }
    const controller=new AbortController();
    let active=true;
    setState(null);setHistory(null);setHistoryUnavailable(false);
    setRecentOrders(null);setRecentOrdersUnavailable(false);
    sequenceAbort.current?.abort();
    setSequenceResult(null);setSequenceLoading(false);
    setLoading(true);setError('');
    void (async()=>{
      try{
        const response=await authorizedFetch(API+'/status',{signal:controller.signal});
        const raw:unknown=await response.json().catch(()=>null);
        if(!response.ok)throw new Error('수동모의계좌 조회가 차단되었습니다.');
        const checked=parseManualFourMarketStatus(raw);
        if(active)setState({owner:userId,value:checked});
      }catch{
        if(active){setState(null);setError('서버 수동모의계좌를 검증하지 못했습니다.');}
      }finally{if(active)setLoading(false);}
    })();
    // A missing/protected migration means UNKNOWN history, never 0 trades.
    // This read-only request has no wallet/order/Telegram side effects.
    void (async()=>{
      try{
        const response=await authorizedFetch(API+'/research-cycle-history',
          {signal:controller.signal});
        const raw:unknown=await response.json().catch(()=>null);
        if(!response.ok)throw new Error('MANUAL_RESEARCH_HISTORY_NOT_READY');
        const valid=parseManualFourMarketResearchHistory(raw);
        if(active)setHistory({owner:userId,value:valid});
      }catch{
        if(active){setHistory(null);setHistoryUnavailable(true);}
      }
    })();
    // Owner-only listing of immutable OPEN event identities, not positions.
    // If RLS/migration is unavailable, report UNKNOWN instead of zero orders.
    void (async()=>{
      try{
        const response=await authorizedFetch(API+'/sequential-orders',
          {signal:controller.signal});
        const raw:unknown=await response.json().catch(()=>null);
        if(!response.ok)throw new Error('MANUAL_PAPER_SEQ_LIST_NOT_READY');
        const checked=parseManualSequentialOrderList(raw);
        if(active)setRecentOrders({owner:userId,value:checked});
      }catch{
        if(active){setRecentOrders(null);setRecentOrdersUnavailable(true);}
      }
    })();
    return()=>{active=false;controller.abort();};
  },[userId,authorized,revision]);

  const inspectSequentialOrder=async(orderIdOverride?:string)=>{
    if(!authorized||sequenceLoading)return;
    const targetId=orderIdOverride??sequenceId;
    if(!SEQ_ORDER_ID.test(targetId)){
      setSequenceError('모의주문 ID 형식을 확인하세요.');
      setSequenceResult(null);
      return;
    }
    const initiatingOwner=userId,requestedId=targetId;
    setSequenceId(targetId);
    sequenceAbort.current?.abort();
    const controller=new AbortController();
    sequenceAbort.current=controller;
    setSequenceLoading(true);setSequenceError('');setSequenceResult(null);
    try{
      // GET-only, exact owner/RLS readback; browser cannot mint Paper fills.
      const response=await authorizedFetch(
        API+'/sequential-order/'+encodeURIComponent(requestedId),
        {signal:controller.signal});
      const raw:unknown=await response.json().catch(()=>null);
      if(!response.ok)throw new Error('PAPER_SEQ_ORDER_UNAVAILABLE');
      const checked=parseManualSequentialOrderReadback(raw,requestedId);
      if(!controller.signal.aborted&&initiatingOwner===ownerRef.current)
        setSequenceResult({owner:initiatingOwner,orderId:requestedId,value:checked});
    }catch{
      if(!controller.signal.aborted&&initiatingOwner===ownerRef.current){
        setSequenceResult(null);
        setSequenceError('본인 주문 증거를 검증할 수 없습니다. 서버 원장·권한·주문 ID를 확인하세요.');
      }
    }finally{
      if(sequenceAbort.current===controller)sequenceAbort.current=null;
      if(!controller.signal.aborted&&initiatingOwner===ownerRef.current)
        setSequenceLoading(false);
    }
  };

  const createOnce=async()=>{
    if(!canConfirm||saving)return;
    const initiatingOwner=userId;
    setSaving(true);setError('');
    try{
      const response=await authorizedFetch(API+'/bootstrap',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({confirmation:CONFIRM}),
      });
      const raw=await response.json().catch(()=>null);
      // Successful HTTP is only a virtual seed write. Independently GET-read
      // back the member+RLS state before displaying any ready label.
      if(!response.ok||!raw||raw.ok!==true
         ||raw.mode!=='MANUAL_PAPER_FOUR_MARKET_SEED_ONLY'
         ||raw.virtualSeedRowsInserted!==4||raw.manualExecutionReady!==false
         ||raw.realOrders!==0)throw new Error('서버 계좌 생성 검증에 실패했습니다.');
      if(initiatingOwner===ownerRef.current){
        setConfirmOwner(null);
        setRevision(v=>v+1);
      }
    }catch{
      if(initiatingOwner===ownerRef.current){
        setError('서버 계좌 생성 또는 중복·DB 보호 검증에 실패했습니다. 기존 기록은 유지됩니다.');
      }
    }finally{setSaving(false);}
  };
  const title=!authorized?'회원 모의매매 권한 필요':loading?'서버 계좌 확인 중'
    :error?'검증 실패':!status?'연결 확인 필요'
    :!status.rlsGuardReady?'DB 보호 적용 필요'
    :status.ready?'4시장 초기 계좌 등록됨 · 거래 실행 미연결'
    :'4시장 초기 계좌 등록 필요';
  return <section className="shrink-0 border-b border-card-border bg-card px-3 py-2 text-xs"
    data-testid="manual-four-market-server-wallet">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-col gap-0.5">
        <strong>수동모의매매 · 4시장 독립 가상계좌</strong>
        <span className="text-muted-foreground">{title}</span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="rounded-lg border border-card-border px-3 py-1.5"
          disabled={!authorized||loading||saving} onClick={()=>setRevision(v=>v+1)}>
          상태 재확인
        </button>
        <button type="button" className="rounded-lg border border-card-border px-3 py-1.5"
          data-testid="manual-four-market-prepare"
          disabled={!status?.canCreate||loading||saving||!authorized} onClick={()=>setConfirmOwner(userId)}>
          초기 계좌 준비
        </button>
      </div>
    </div>
    <details className="mt-1" data-testid="manual-four-market-wallet-detail">
      <summary className="cursor-pointer py-1 text-muted-foreground">시장별 기준자본·생성 보호 상태</summary>
      {status?<div className="grid grid-cols-2 gap-2 pt-2 sm:grid-cols-4">
        {MANUAL_FOUR_MARKETS.map(({key,label})=>{
          const lane=status.markets[key];
          return <div key={key} className="rounded-lg border border-card-border p-2">
            <strong>{label}</strong>
            <p>초기 배정 기준 {money(lane.initialCapitalKrw)}</p>
            <p>{lane.validated?'가상 초기 계좌 검증됨':'계좌 미준비 또는 보호 미확인'}</p>
            <p>현재 잔액: 정산 데이터 미연결</p>
          </div>;
        })}
      </div>:<p className="pt-2 text-muted-foreground">서버 계좌 상태는 아직 확인되지 않았습니다.</p>}
      {status?.creationBlockers.length?<p className="pt-2 text-amber-700">
        계좌 준비 차단: {status.creationBlockers.join(' · ')}
      </p>:null}
      <p className="pt-2 text-muted-foreground">자동모의·실계좌 자본과 완전히 별개입니다. 100만원은 초기 가상 배정 기준일 뿐 실제 주문가능 잔액이 아닙니다. 종목·전략·4시장 수동체결과 정산은 별도로 연결해야 합니다.</p>
    </details>
    <details className="mt-1" data-testid="manual-paper-research-receipt-history">
      <summary className="cursor-pointer py-1 text-muted-foreground">
        수동모의 연구 거래 기록 · 실제 체결과 구분
      </summary>
      {ownHistory ? <div className="space-y-1 pt-2">
        <p>불변 연구 회차 기록 {ownHistory.receipts.length}건
          {ownHistory.hasMoreThan100?' (최근 100건만 표시)':''}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ownHistory.receipts.slice(0,12).map(entry=><div key={entry.cycleId}
            className="rounded-lg border border-card-border p-2">
            <strong>{MANUAL_FOUR_MARKETS.find(m=>m.key===entry.market)?.label}</strong>
            <p>연구 가정 손익 {entry.hypotheticalNetPnlKrw.toLocaleString('ko-KR')}원</p>
            <p>기록일 {new Date(entry.recordedAt).toLocaleString('ko-KR')}</p>
            <p className="text-muted-foreground">실제 체결 아님 · 자본/예비금에 미반영</p>
          </div>)}
        </div>
        {ownHistory.receipts.length===0?
          <p className="text-muted-foreground">조회가 검증됐지만 아직 저장된 연구 회차는 없습니다.</p>:null}
      </div> : <p className="pt-2 text-muted-foreground">
        {historyUnavailable?'서버 연구 원장 보호 또는 배포가 아직 준비되지 않았습니다.':
          '불변 연구 거래 이력 검증 대기 중입니다.'}
      </p>}
      <p className="pt-2 text-muted-foreground">
        연구용 가상 손익은 실제 모의주문 체결, 현금 잔고, 검증된 순수익 또는 수익성 PASS가 아닙니다.
        계좌·거래 데이터는 이 화면에서 변경하지 않습니다.
      </p>
    </details>
    <details className="mt-1" data-testid="manual-paper-sequential-order-list">
      <summary className="cursor-pointer py-1 text-muted-foreground">
        최근 서버 순차 모의주문 목록 · 본인 주문만
      </summary>
      {ownRecentOrders?<div className="space-y-2 pt-2">
        <p>최근 모의주문 생성 기록 {ownRecentOrders.orders.length}건
          {ownRecentOrders.hasMoreThan25?' · 최대 25건 표시':''}</p>
        {ownRecentOrders.orders.length===0?
          <p className="text-muted-foreground">
            서버 조회는 정상이지만 생성된 모의주문 기록이 없습니다.
          </p>:<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {ownRecentOrders.orders.map(item=><button key={item.orderId}
              type="button" className="rounded-lg border border-card-border p-2 text-left"
              disabled={!authorized||sequenceLoading}
              onClick={()=>void inspectSequentialOrder(item.orderId)}>
              <strong>{MANUAL_FOUR_MARKETS.find(m=>m.key===item.market)?.label}
                {' · '}{item.symbol}</strong>
              <p>{item.side} · 레버리지 {item.leverage}배 ·
                {new Date(item.createdAtMs).toLocaleString('ko-KR')}</p>
              <p className="text-muted-foreground">
                주문 생성 기록만 확인됨 · 현재 상태는 선택해 검증
              </p>
            </button>)}
          </div>}
      </div>:<p className="pt-2 text-muted-foreground">
        {recentOrdersUnavailable
          ?'모의주문 목록의 서버 원장·회원별 권한을 확인할 수 없습니다.'
          :'본인 모의주문 목록 확인 중입니다.'}
      </p>}
      <p className="pt-2 text-muted-foreground">
        목록은 체결, 확정 손익 또는 실제 자본의 증거가 아닙니다.
      </p>
    </details>
    <details className="mt-1" data-testid="manual-paper-sequential-order-inspector">
      <summary className="cursor-pointer py-1 text-muted-foreground">
        순차 모의주문 · 부분체결·청산 이력 조회 전용
      </summary>
      <div className="space-y-2 pt-2">
        <p className="text-muted-foreground">
          서버에서 발급된 주문 ID로 본인의 가상 주문 진행상태를 조회합니다.
          주문을 새로 생성하거나 체결시키지 않습니다.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="manual-paper-seq-order-id">모의주문 ID</label>
          <input id="manual-paper-seq-order-id" type="text" value={sequenceId}
            maxLength={120} autoComplete="off"
            placeholder="manual-paper-seq-order-v1:..."
            aria-label="본인 순차 모의주문 ID"
            disabled={!authorized||sequenceLoading}
            className="min-w-0 flex-1 rounded-lg border border-card-border bg-background px-2 py-1.5"
            onChange={event=>{
              sequenceAbort.current?.abort();
              setSequenceId(event.target.value.trim());
              setSequenceResult(null);
              setSequenceError('');
              setSequenceLoading(false);
            }}/>
          <button type="button" data-testid="manual-paper-seq-readonly-lookup"
            className="rounded-lg border border-card-border px-3 py-1.5"
            disabled={!authorized||sequenceLoading||!SEQ_ORDER_ID.test(sequenceId)}
            onClick={()=>void inspectSequentialOrder()}>
            {sequenceLoading?'확인 중':'주문 이력 조회'}
          </button>
        </div>
        {sequenceError?<p role="alert" className="text-destructive">{sequenceError}</p>:null}
        {ownSequence?<div className="space-y-2 rounded-lg border border-card-border p-2"
          data-testid="manual-paper-seq-owner-history">
          <strong>{MANUAL_FOUR_MARKETS.find(m=>m.key===ownSequence.projection.market)?.label}
            {' · '}{sequenceStatusLabel[ownSequence.projection.status]}</strong>
          <p>가상 진입 수량 {ownSequence.projection.entryQuantity.toLocaleString('ko-KR')}
            {' · '}가상 청산 수량 {ownSequence.projection.exitQuantity.toLocaleString('ko-KR')}
            {' · '}남은 가상 수량 {ownSequence.projection.openQuantity.toLocaleString('ko-KR')}</p>
          <p>서버 이벤트 {ownSequence.eventHistory.length}건 ·
            미체결 진입 잔량 취소 {ownSequence.projection.entryRemainderCancelled?'확인':'아니오'}</p>
          {ownSequence.projection.status==='CLOSED_PROJECTION'
            &&ownSequence.projection.hypotheticalNetPnlKrw!==null
            ?<p>연구 가정 순손익 {money(ownSequence.projection.hypotheticalNetPnlKrw)}
              {' · '}실제 자본·예비금에 반영되지 않음</p>
            :<p>완전 청산 증거 없음 · 확정 손익/예비금 없음</p>}
          <ol className="list-inside list-decimal space-y-1">
            {ownSequence.eventHistory.slice(0,30).map(event=>
              <li key={event.eventId}>
                {event.kind} · {new Date(event.observedAtMs).toLocaleString('ko-KR')}
              </li>)}
          </ol>
          {ownSequence.eventHistory.length>30?
            <p className="text-muted-foreground">첫 30건만 표시. 전체 이벤트 {ownSequence.eventHistory.length}건이 검증되었습니다.</p>:null}
          <p className="text-muted-foreground">
            서버 공개시세를 활용한 모의체결 가정입니다. 실제 거래소 체결·실현수익·수익성 검증이 아닙니다.
          </p>
        </div>:null}
      </div>
    </details>
    {error?<p role="alert" className="pt-2 text-destructive">{error}</p>:null}
    {canConfirm?<div className="mt-2 rounded-lg border border-card-border bg-background p-3" role="dialog"
      aria-label="4시장 수동모의계좌 최초 생성 확인" aria-modal="true">
      <p>국내주식·미국주식·코인현물·코인선물에 각각 100만원의 서버 가상 초기 계좌를 한 번 생성합니다. 기존 거래 기록이나 실자동매매는 변경하지 않습니다. 중복 생성·재충전은 차단됩니다.</p>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="rounded-lg border border-card-border px-3 py-2" onClick={()=>setConfirmOwner(null)}>취소</button>
        <button type="button" className="rounded-lg border border-card-border px-3 py-2"
          disabled={!canConfirm||saving} onClick={()=>void createOnce()}>
          {saving?'검증 중':'최초 생성 확인'}
        </button>
      </div>
    </div>:null}
  </section>;
}
