import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, BookOpenCheck, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  getUnifiedTradeJournal,
  type UnifiedJournalFilters,
  type UnifiedTradeCycle,
  type UnifiedTradeJournal,
} from '@/lib/paper-journal-sync';

type Props = {
  loadApi?: typeof getUnifiedTradeJournal;
};

const controlClass = 'min-h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm';
const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold disabled:opacity-50';
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

function metric(value: number | null, suffix = '') {
  return value == null ? 'N/A' : `${number.format(value)}${suffix}`;
}

function money(value: number, currency: string) {
  return `${number.format(value)} ${currency}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl border border-border/70 bg-background/70 p-3">
    <div className="text-[11px] text-muted-foreground">{label}</div>
    <div className="mt-1 break-words text-sm font-bold">{value}</div>
  </div>;
}

function Grade({ trade }: { trade: UnifiedTradeCycle }) {
  const tone = trade.review.grade === 'A' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700'
    : trade.review.grade === 'B' ? 'border-blue-500/50 bg-blue-500/10 text-blue-700'
      : trade.review.grade === 'C' ? 'border-amber-500/50 bg-amber-500/10 text-amber-700'
        : 'border-destructive/50 bg-destructive/10 text-destructive';
  return <span className={`rounded-full border px-2 py-1 text-xs font-extrabold ${tone}`}>{trade.review.grade} · 품질 {trade.review.qualityScore}</span>;
}

function TradeDetail({ trade }: { trade: UnifiedTradeCycle }) {
  const snapshot = trade.technicalSnapshot;
  return <article className="min-w-0 space-y-4 rounded-2xl border border-border bg-card p-4" data-testid="unified-journal-detail">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{trade.source} · {trade.market} · {trade.positionSide}</div>
        <h3 className="mt-1 break-words text-lg font-extrabold">{trade.symbol}</h3>
      </div>
      <Grade trade={trade} />
    </div>

    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Metric label="진입 평균가" value={money(trade.entryPrice, trade.currency)} />
      <Metric label="청산 평균가" value={trade.exitPrice == null ? '진행 중' : money(trade.exitPrice, trade.currency)} />
      <Metric label="순손익" value={money(trade.netPnl, trade.currency)} />
      <Metric label="순수익률" value={metric(trade.netReturnPercent, '%')} />
      <Metric label="비용" value={money(trade.fees + trade.tax, trade.currency)} />
      <Metric label="성과 점수" value={String(trade.review.performanceScore)} />
      <Metric label="매매 품질" value={`${trade.review.qualityScore} / 100`} />
      <Metric label="보유 시간" value={trade.holdingTimeMs == null ? '진행 중' : `${number.format(trade.holdingTimeMs / 60_000)}분`} />
    </div>

    <div className="grid min-w-0 gap-3 lg:grid-cols-3">
      <section className="min-w-0 rounded-xl border border-border p-3">
        <h4 className="text-sm font-bold text-emerald-700">잘한 점</h4>
        {trade.review.good.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{trade.review.good.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">확정할 근거가 부족합니다.</p>}
      </section>
      <section className="min-w-0 rounded-xl border border-border p-3">
        <h4 className="text-sm font-bold text-destructive">아쉬운 점</h4>
        {trade.review.bad.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{trade.review.bad.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">기록된 문제점이 없습니다.</p>}
      </section>
      <section className="min-w-0 rounded-xl border border-border p-3">
        <h4 className="text-sm font-bold text-blue-700">다음 개선</h4>
        {trade.review.improvements.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{trade.review.improvements.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">현재 규칙을 유지하세요.</p>}
      </section>
    </div>

    <section className="min-w-0 rounded-xl border border-border p-3" data-testid="unified-journal-snapshot">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold">진입 시점 분석 스냅샷</h4>
        <span className="break-all text-[11px] font-semibold text-muted-foreground">{snapshot.contextSource}</span>
      </div>
      {snapshot.contextSource === 'NO_PRE_TRADE_CONTEXT'
        ? <p className="mt-2 text-xs text-muted-foreground">진입 전 저장된 분석 정보가 없습니다. 현재 데이터로 과거 지표를 꾸며내지 않았습니다.</p>
        : <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="시간봉" value={snapshot.timeframe ?? 'N/A'} />
          <Metric label="RSI" value={metric(snapshot.rsi)} />
          <Metric label="신호 점수" value={metric(snapshot.signalScore)} />
          <Metric label="시장 국면" value={snapshot.marketRegime ?? 'N/A'} />
          <Metric label="지지" value={metric(snapshot.support)} />
          <Metric label="저항" value={metric(snapshot.resistance)} />
          <Metric label="거래량 비율" value={metric(snapshot.volumeRatio)} />
          <Metric label="변동성" value={metric(snapshot.volatilityPercent, '%')} />
        </div>}
    </section>

    <section className="min-w-0 rounded-xl border border-border p-3">
      <h4 className="text-sm font-bold">체결 흐름</h4>
      <div className="mt-2 space-y-1 break-words text-xs">
        <p>최초 진입 {trade.initialEntry.quantity}주/단위 · {money(trade.initialEntry.price, trade.currency)}</p>
        <p>추가 진입 {trade.additions.length}회 · 부분 청산 {trade.partialExits.length}회</p>
        <p>최종 청산 {trade.finalExit ? `${trade.finalExit.quantity}주/단위 · ${money(trade.finalExit.price, trade.currency)}` : '아직 없음'}</p>
      </div>
    </section>
  </article>;
}

export function UnifiedTradeJournalPanel({ loadApi = getUnifiedTradeJournal }: Props) {
  const [filters, setFilters] = useState<UnifiedJournalFilters>({ range: '30D', market: 'ALL', source: 'ALL', broker: 'ALL', grade: 'ALL' });
  const [data, setData] = useState<UnifiedTradeJournal | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestKey = JSON.stringify(filters);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void loadApi(filters, controller.signal).then((result) => {
      setData(result);
      setSelectedId((current) => result.trades.some((trade) => trade.id === current) ? current : result.trades[0]?.id ?? '');
    }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : '통합 매매일지를 불러오지 못했습니다.');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [loadApi, requestKey, refreshVersion]);

  const selected = useMemo(() => data?.trades.find((trade) => trade.id === selectedId) ?? data?.trades[0] ?? null, [data, selectedId]);
  const accountOptions = useMemo(() => [...new Set(data?.trades.map((trade) => trade.accountIdMasked) ?? [])].sort(), [data]);

  function change(name: keyof UnifiedJournalFilters, value: string) {
    setFilters((current) => ({ ...current, [name]: value, ...(name === 'broker' ? { account: '' } : {}) }));
  }

  return <section className="min-w-0 space-y-4" data-testid="unified-trade-journal">
    <div className="min-w-0 rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-extrabold"><BookOpenCheck className="h-4 w-4" />통합 매매일지·매매 품질 복기</h2>
          <p className="mt-1 text-xs text-muted-foreground">수익 성과와 매매 과정의 품질을 분리해 결정론적으로 평가합니다.</p>
        </div>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setRefreshVersion((value) => value + 1)} data-testid="unified-journal-refresh">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}새로고침
        </button>
      </div>

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 font-semibold" data-testid="toss-free-status">
          <AlertTriangle className="mr-2 inline h-4 w-4" />브로커 일지: {data?.toss.liveReadIntegration ?? '확인 중'} · 읽기 {data?.brokerImport?.privateReadRequests ?? 0}건 · 가져온 체결 {data?.brokerImport?.importedRecords ?? 0}건
        </p>
        <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 font-semibold" data-testid="journal-zero-cost-status">
          <ShieldCheck className="mr-2 inline h-4 w-4" />외부 AI 비활성 · 신규 비용 {data?.safety.finalCostDelta ?? '0_KRW'} · 주문/취소/정정 0건
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="grid min-w-0 gap-1 text-xs">기간<select className={controlClass} value={filters.range} onChange={(event) => change('range', event.target.value)}><option value="TODAY">오늘</option><option value="7D">7일</option><option value="30D">30일</option><option value="90D">90일</option><option value="1Y">1년</option><option value="ALL">전체</option></select></label>
        <label className="grid min-w-0 gap-1 text-xs">시장<select className={controlClass} value={filters.market} onChange={(event) => change('market', event.target.value)}><option value="ALL">전체 시장</option><option value="KR_STOCK">국내주식</option><option value="US_STOCK">미국주식</option><option value="CRYPTO_SPOT">코인 현물</option><option value="CRYPTO_FUTURES">코인 선물</option></select></label>
        <label className="grid min-w-0 gap-1 text-xs">출처<select className={controlClass} value={filters.source} onChange={(event) => change('source', event.target.value)}><option value="ALL">전체</option><option value="TOSS_MANUAL">Toss 수동</option><option value="TOSS_API">Toss API</option><option value="KIWOOM_API">Kiwoom API</option><option value="UPBIT_API">Upbit API</option><option value="BITGET_API">Bitget API</option><option value="APP_PAPER">Paper</option><option value="APP_SHADOW">Shadow</option><option value="APP_AUTO">자동매매</option></select></label>
        <label className="grid min-w-0 gap-1 text-xs">품질 등급<select className={controlClass} value={filters.grade} onChange={(event) => change('grade', event.target.value)}><option value="ALL">전체 등급</option><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option></select></label>
        <label className="grid min-w-0 gap-1 text-xs">공급자<select className={controlClass} value={filters.broker} onChange={(event) => change('broker', event.target.value)}><option value="ALL">전체 공급자</option><option value="TOSS">Toss</option><option value="KIWOOM">Kiwoom</option><option value="UPBIT">Upbit</option><option value="BITGET">Bitget</option><option value="APP">앱 Paper/Shadow/Auto</option><option value="MANUAL">기타 수동</option></select></label>
        <label className="grid min-w-0 gap-1 text-xs">계좌 별칭<select className={controlClass} value={filters.account ?? ''} onChange={(event) => change('account', event.target.value)}><option value="">전체 계좌</option>{accountOptions.map((account) => <option key={account} value={account}>{account}</option>)}</select></label>
      </div>
    </div>

    {error ? <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
    {busy && !data ? <div className="grid min-h-40 place-items-center rounded-2xl border border-border bg-card"><Loader2 className="h-6 w-6 animate-spin" aria-label="매매일지 불러오는 중" /></div> : null}

    {data ? <>
      <div className="rounded-2xl border border-border bg-card p-4" data-testid="unified-journal-analytics">
        <h3 className="flex items-center gap-2 text-sm font-extrabold"><BarChart3 className="h-4 w-4" />성과 요약</h3>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="종료 거래" value={String(data.analytics.closedTrades)} />
          <Metric label="승률" value={metric(data.analytics.winRate, '%')} />
          <Metric label="Profit Factor" value={metric(data.analytics.profitFactor)} />
          <Metric label="평균 수익률" value={metric(data.analytics.averageReturnPercent, '%')} />
          <Metric label="진행 중" value={String(data.analytics.openTrades)} />
          <Metric label="최대 연속 손실" value={String(data.analytics.maximumConsecutiveLosses)} />
          <Metric label="순손익" value={data.analytics.netPnlByCurrency.map((item) => money(item.value, item.currency)).join(' · ') || 'N/A'} />
          <Metric label="총비용" value={data.analytics.totalCostsByCurrency.map((item) => money(item.value, item.currency)).join(' · ') || 'N/A'} />
        </div>
        {data.analytics.warnings.length ? <p className="mt-3 rounded-xl bg-muted p-3 text-xs">{data.analytics.warnings.join(' ')}</p> : null}
      </div>

      {data.integrityIssues.length ? <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs" data-testid="unified-journal-integrity">
        <h3 className="font-bold">정합성 확인 필요 {data.integrityIssues.length}건</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">{data.integrityIssues.slice(0, 10).map((issue, index) => <li key={`${issue.code}:${issue.orderId}:${index}`}>{issue.code} · {issue.message}</li>)}</ul>
      </div> : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,0.7fr)_minmax(0,1.3fr)]">
        <div className="min-w-0 space-y-2 rounded-2xl border border-border bg-card p-3" data-testid="unified-journal-list">
          <h3 className="px-1 text-sm font-bold">거래 목록 {data.trades.length}건</h3>
          {data.trades.length === 0 ? <p className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">선택한 조건에 해당하는 거래가 없습니다.</p> : data.trades.map((trade) => <button
            type="button"
            key={trade.id}
            className={`w-full min-w-0 rounded-xl border p-3 text-left ${selected?.id === trade.id ? 'border-primary bg-primary/5' : 'border-border'}`}
            onClick={() => setSelectedId(trade.id)}
          >
            <div className="flex min-w-0 items-start justify-between gap-2"><span className="min-w-0 break-words text-sm font-bold">{trade.symbol}</span><Grade trade={trade} /></div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{trade.source} · {trade.status}</span><span>{money(trade.netPnl, trade.currency)}</span></div>
          </button>)}
        </div>
        {selected ? <TradeDetail trade={selected} /> : <div className="grid min-h-40 place-items-center rounded-2xl border border-border bg-card text-sm text-muted-foreground">거래를 선택하세요.</div>}
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 text-xs" data-testid="unified-journal-monthly">
        <h3 className="text-sm font-bold">월간 리포트</h3>
        {data.analytics.monthlyReport.length ? <div className="mt-3 space-y-2">{data.analytics.monthlyReport.map((month) => <div key={month.month} className="grid grid-cols-2 gap-2 rounded-xl border border-border p-3 sm:grid-cols-4"><span className="font-bold">{month.month}</span><span>{month.sampleSize}건</span><span>승률 {metric(month.winRate, '%')}</span><span>{month.netPnlByCurrency.map((item) => money(item.value, item.currency)).join(' · ') || 'N/A'}</span></div>)}</div> : <p className="mt-2 text-muted-foreground">표시할 월간 데이터가 없습니다.</p>}
      </div>
    </> : null}
  </section>;
}
