import { ResearchWorkspaceProviders } from './research-workspace-providers';
import { ResearchWorkspaceWorker } from './research-workspace-worker';
import { useEffect, useMemo, useState } from 'react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { filterResearchStrategies, parseResearchWorkspaceResponse, WORKSPACE_MARKETS,
  type WorkspaceGroup, type WorkspaceMarket, type WorkspaceResponse } from '@/lib/research-workspace-response';

const MARKET_LABEL: Record<WorkspaceMarket,string> = { KR_STOCK:'국내 주식',US_STOCK:'미국 주식',CRYPTO_SPOT:'코인 현물',CRYPTO_FUTURES:'코인 선물' };
const STATE_LABEL: Record<string,string> = { BACKTEST_RECORDED:'백테스트 기록',RULES_INCOMPLETE:'규칙 보완 필요',COMPILER_REVIEW_REQUIRED:'컴파일 검토 대기' };
type Load = {status:'loading'} | {status:'error';message:string} | {status:'loaded';data:WorkspaceResponse};
const btn = 'min-h-11 rounded-xl border border-card-border px-3 py-2 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export function ResearchWorkspacePanel() {
  const [load,setLoad] = useState<Load>({status:'loading'});
  const [revision,setRevision] = useState(0);
  const [group,setGroup] = useState<WorkspaceGroup>('ALL');
  const [market,setMarket] = useState<'ALL'|WorkspaceMarket>('ALL');
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoad({status:'loading'});
    const timer = window.setTimeout(() => {
      if (!active) return;
      controller.abort(); setLoad({status:'error',message:'조회 시간이 초과됐습니다. 다시 확인해 주세요.'});
    }, 8000);
    void authorizedFetch('/api/research/video/evidence/workspace', {method:'GET',headers:{Accept:'application/json'},signal:controller.signal})
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'ACCESS_REQUIRED' : 'READ_FAILED');
        return parseResearchWorkspaceResponse(await response.json());
      })
      .then(data => { if (active && !controller.signal.aborted) setLoad({status:'loaded',data}); })
      .catch((error:unknown) => {
        if (!active || controller.signal.aborted) return;
        setLoad({status:'error',message:error instanceof Error && error.message === 'ACCESS_REQUIRED'
          ? '연구 결과를 볼 수 있는 관리자 권한이 필요합니다.' : '결과를 읽거나 검증하지 못했습니다. 기존 결과로 대신 표시하지 않습니다.'});
      }).finally(() => window.clearTimeout(timer));
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [revision]);
  const data = load.status === 'loaded' && load.data.available ? load.data : null;
  const rows = useMemo(() => filterResearchStrategies(data?.strategies ?? [],group,market),[data,group,market]);
  const markets = WORKSPACE_MARKETS.filter(m => group === 'ALL' || (group === 'STOCK' ? m.endsWith('_STOCK') : m.startsWith('CRYPTO_')));
  return <section className="h-full min-h-0 overflow-y-auto bg-background p-3 sm:p-4" data-testid="research-workspace-panel">
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h2 className="text-xl font-black">전략·백테스트</h2><p className="mt-1 text-sm text-muted-foreground">저장된 연구 기록과 근거를 확인합니다. 실거래 성과나 검증 완료 표시는 아닙니다.</p></div>
        <button type="button" className={btn} disabled={load.status === 'loading'} onClick={() => setRevision(n=>n+1)}>다시 확인</button>
      </header>
      <ResearchWorkspaceProviders revision={revision}/>
      <ResearchWorkspaceWorker revision={revision}/>
      <div className="rounded-xl border border-card-border bg-muted/30 p-3 text-xs text-muted-foreground">24시간 작업자: 별도 활성화 · 일 목표: 미검증 · 전략 적용: 비활성</div>
      <div className="flex flex-wrap items-center gap-2" aria-label="연구 시장 필터">
        {(['ALL','STOCK','CRYPTO'] as const).map(g=><button key={g} type="button" aria-pressed={group===g} className={`${btn} ${group===g?'bg-primary text-primary-foreground':'bg-card'}`} onClick={()=>{setGroup(g);setMarket('ALL');}}>{g==='ALL'?'전체':g==='STOCK'?'주식':'코인'}</button>)}
        <label className="sr-only" htmlFor="workspace-market">세부 시장</label>
        <select id="workspace-market" className={`${btn} max-w-full bg-card`} value={market} onChange={e=>setMarket(e.target.value as 'ALL'|WorkspaceMarket)}>
          <option value="ALL">모든 시장</option>{markets.map(m=><option key={m} value={m}>{MARKET_LABEL[m]}</option>)}
        </select>
      </div>
      {load.status === 'loading' ? <p role="status">연구 기록을 확인하고 있습니다.</p> : null}
      {load.status === 'error' ? <p role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm">{load.message}</p> : null}
      {load.status === 'loaded' && (!data || data.sourceState !== 'MEASURED' || data.registryState !== 'READABLE') ?
        <div role="status" className="rounded-xl border border-dashed border-card-border p-5"><h3 className="font-bold">검증 가능한 연구 기록이 아직 연결되지 않았습니다.</h3><p className="mt-2 text-sm text-muted-foreground">자료·접근 정책·결과 파일이 준비된 경우에만 표시합니다. 미수집을 0% 수익으로 표시하지 않습니다.</p></div> : null}
      {data?.registryState === 'READABLE' ? <>
        <p role="status" className="text-sm text-muted-foreground">전략 {rows.length}건 · 영상 메타데이터 {data.sourceCount ?? '미확인'}건 — 경제적 표본 수 아님</p>
        {rows.length === 0 ? <p className="rounded-xl border border-dashed border-card-border p-5">이 분류에는 연결된 전략이 없습니다.</p> : null}
        <div className="grid gap-4 lg:grid-cols-2">{rows.map(s=><article key={s.id} data-testid="workspace-strategy" data-market={s.market} className="min-w-0 rounded-2xl border border-card-border bg-card p-4">
          <h3 className="break-words font-black">{s.strategyId} · {s.version}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{MARKET_LABEL[s.market]} · {s.timeframe} · {STATE_LABEL[s.state]}</p>
          {s.run ? <><dl className="mt-3 grid grid-cols-2 gap-2">{[
            ['모형 순수익',`${(s.run.netReturn*100).toFixed(2)}%`],['모형 최대낙폭',`${(s.run.maxDrawdown*100).toFixed(2)}%`],['거래 수',s.run.tradeCount],['일 목표','미검증'],
          ].map(([k,v])=><div key={k} className="rounded-xl bg-muted/30 p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="break-words font-black">{v}</dd></div>)}</dl>
          <p className="mt-2 text-xs text-muted-foreground">{s.run.startAt.slice(0,10)} ~ {s.run.endAt.slice(0,10)} · 비용 포함 · 독립 검증 아님</p></> : <p className="mt-3 text-sm">백테스트 기록 미연결</p>}
          <details className="mt-3 border-t border-card-border pt-2"><summary className="min-h-11 cursor-pointer py-2 font-bold">근거와 누락 확인</summary>
            {s.rules.map(r=><div key={r.id} className="my-2 rounded-xl bg-muted/30 p-3 text-sm"><p className="font-bold">{r.origin==='SOURCE_RULE'?'출처에서 추출한 규칙':'AI 보완 가정'} · {r.kind}</p><p className="mt-1 whitespace-pre-wrap break-words">{r.text}</p>
              {r.rationale ? <p className="mt-1 break-words text-xs text-muted-foreground">{r.rationale}</p> : null}
              {r.evidence.map((e,i)=><p key={i} className="mt-1 break-words text-xs text-muted-foreground">{e.startSec}~{e.endSec}초: {e.excerpt}</p>)}</div>)}
            {s.missingRules.length ? <p className="text-sm">누락: {s.missingRules.join(', ')}</p> : null}
            {data.sources.filter(x=>x.sourceId===s.sourceId).map(x=><a key={x.sourceId} href={x.url} target="_blank" rel="noopener noreferrer" className="block min-h-11 break-words py-2 text-sm underline">영상 원문: {x.title}</a>)}
            <p className="mt-2 break-all text-xs text-muted-foreground">전략 식별값: {s.strategyDigest}</p>
          </details>
          <div className="mt-3 flex flex-wrap gap-2">{['검색기 적용','모의운용 적용','실거래 적용'].map(t=><button key={t} type="button" disabled className={`${btn} opacity-50`} title="별도 검증과 명시적 승인 연결 필요">{t}</button>)}</div>
        </article>)}</div>
      </> : null}
    </div>
  </section>;
}
