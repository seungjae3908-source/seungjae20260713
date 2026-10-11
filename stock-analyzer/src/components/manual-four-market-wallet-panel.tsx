import {useEffect,useState} from 'react';
import {authorizedFetch} from '@/lib/auth-fetch';
import {useAuth} from '@/lib/auth';
import {
  MANUAL_FOUR_MARKETS,parseManualFourMarketStatus,
  type ManualFourMarketStatus,
} from '@/lib/manual-four-market-paper-status';

const API='/api/paper-trading/manual-four-market';
const CONFIRM='START_MANUAL_FOUR_1M_PAPER_WALLETS_PRESERVE_HISTORY';
const money=(value:number)=>value.toLocaleString('ko-KR')+'원';
/** Four-market manual Paper initial SEED readiness, never current cash or an
 * order form. Autonomous strategy selection/execution is intentionally OFF.
 */
export function ManualFourMarketWalletPanel(){
  const auth=useAuth();
  const userId=auth.user?.id??auth.profile?.id??'';
  const authorized=Boolean(userId&&auth.can('canAccessPaperTrading'));
  const [state,setState]=useState<{owner:string;value:ManualFourMarketStatus}|null>(null);
  const [revision,setRevision]=useState(0);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [confirm,setConfirm]=useState(false);
  const [error,setError]=useState('');
  const status=authorized&&state?.owner===userId?state.value:null;
  useEffect(()=>{
    if(!authorized){setState(null);setLoading(false);setError('');return;}
    const controller=new AbortController();
    let active=true;
    setState(null);setLoading(true);setError('');
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
    return()=>{active=false;controller.abort();};
  },[userId,authorized,revision]);

  const createOnce=async()=>{
    if(!authorized||!status?.canCreate||saving)return;
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
      setConfirm(false);
      setRevision(v=>v+1);
    }catch{
      setError('서버 계좌 생성 또는 중복·DB 보호 검증에 실패했습니다. 기존 기록은 유지됩니다.');
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
          disabled={!status?.canCreate||loading||saving} onClick={()=>setConfirm(true)}>
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
    {error?<p role="alert" className="pt-2 text-destructive">{error}</p>:null}
    {confirm?<div className="mt-2 rounded-lg border border-card-border bg-background p-3" role="dialog"
      aria-label="4시장 수동모의계좌 최초 생성 확인" aria-modal="true">
      <p>국내주식·미국주식·코인현물·코인선물에 각각 100만원의 서버 가상 초기 계좌를 한 번 생성합니다. 기존 거래 기록이나 실자동매매는 변경하지 않습니다. 중복 생성·재충전은 차단됩니다.</p>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="rounded-lg border border-card-border px-3 py-2" onClick={()=>setConfirm(false)}>취소</button>
        <button type="button" className="rounded-lg border border-card-border px-3 py-2"
          disabled={!status?.canCreate||saving} onClick={()=>void createOnce()}>
          {saving?'검증 중':'최초 생성 확인'}
        </button>
      </div>
    </div>:null}
  </section>;
}
