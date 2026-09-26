import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, BookOpenCheck, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { JournalPaperLinkageSummary } from '@/components/journal-paper-linkage-summary';
import {
  getUnifiedTradeJournal,
  type UnifiedJournalFilters,
  type UnifiedTradeCycle,
  type UnifiedTradeJournal,
} from '@/lib/paper-journal-sync';
import {
  USER_CONTEXT_SOURCE_KO,
  USER_DIRECTION_KO,
  USER_MARKET_KO,
  USER_METRIC_KO,
  USER_STATUS_KO,
  USER_TRADE_SOURCE_KO,
  userFacingCodeLabel,
} from '@/lib/labels';

type Props = {
  loadApi?: typeof getUnifiedTradeJournal;
  forcedMarket?: UnifiedJournalFilters['market'];
  forcedSource?: UnifiedJournalFilters['source'];
  title?: string;
  description?: string;
};

const controlClass = 'min-h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm';
const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold disabled:opacity-50';
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

function metric(value: number | null, suffix = '') {
  return value == null ? 'N/A' : `${number.format(value)}${suffix}`;
}

function money(value: number | null | undefined, currency: string) {
  return value == null ? 'N/A' : `${number.format(value)} ${currency}`;
}

function costMoney(trade: Pick<UnifiedTradeCycle, 'fees' | 'tax' | 'costEvidence' | 'currency'>) {
  if (trade.costEvidence?.status !== 'READY' || trade.fees == null || trade.tax == null) return 'N/A';
  const totalCost = trade.fees + trade.tax;
  return money(totalCost, trade.currency);
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
        <div className="text-xs text-muted-foreground">
          {userFacingCodeLabel(trade.source, USER_TRADE_SOURCE_KO)} · {userFacingCodeLabel(trade.market, USER_MARKET_KO)} · {userFacingCodeLabel(trade.positionSide, USER_DIRECTION_KO)}
        </div>
        <h3 className="mt-1 break-words text-lg font-extrabold">{trade.symbol}</h3>
      </div>
      <Grade trade={trade} />
    </div>

    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Metric label="진입 평균가" value={money(trade.entryPrice, trade.currency)} />
      <Metric label="청산 평균가" value={trade.exitPrice == null ? '진행 중' : money(trade.exitPrice, trade.currency)} />
      <Metric label="순손익" value={money(trade.netPnl, trade.currency)} />
      <Metric label="순수익률" value={metric(trade.netReturnPercent, '%')} />
      <Metric label="비용" value={costMoney(trade)} />
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

    {trade.source === 'APP_PAPER' ? (
      <section className="min-w-0 rounded-xl border border-border p-3" data-testid="unified-journal-research-binding">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-bold">Research lineage</h4>
            <p className="mt-1 text-[10px] text-muted-foreground">authenticated Paper state와 검증된 candidate binding만 표시합니다.</p>
          </div>
          <span className={`rounded-full border px-2 py-1 text-[10px] font-extrabold ${
            trade.canonicalResearchBinding?.status === 'VERIFIED'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700'
              : trade.canonicalResearchBinding?.status === 'MISMATCH'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-border bg-muted text-muted-foreground'
          }`}>
            {trade.canonicalResearchBinding?.status ?? 'NOT_AVAILABLE'}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Metric label="candidateId" value={trade.canonicalResearchBinding?.candidateId ?? 'N/A'} />
          <Metric label="strategyId" value={trade.canonicalResearchBinding?.strategyId ?? 'N/A'} />
          <Metric label="Research SHA" value={trade.canonicalResearchBinding?.researchCodeSha ?? 'N/A'} />
          <Metric
            label="Settlement binding"
            value={trade.canonicalResearchBinding?.settlementBindingVerified ? '검증됨' : '미검증'}
          />
          <Metric
            label="Trigger binding"
            value={trade.canonicalResearchBinding?.triggerBindingVerified ? '검증됨' : '미검증'}
          />
          <Metric
            label="exitTriggerId"
            value={trade.canonicalResearchBinding?.triggerBindingVerified
              ? trade.canonicalResearchBinding.exitTriggerId ?? 'N/A'
              : 'N/A'}
          />
        </div>
        <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
          reason · {trade.canonicalResearchBinding?.reason ?? 'AUTHENTICATED_BINDING_NOT_AVAILABLE'}
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          이 연결은 후보 identity용입니다. Journal fees/tax나 Research 8개 Full Cost 수익성 검증을 대신하지 않습니다.
        </p>
      </section>
    ) : null}

    <section className="min-w-0 rounded-xl border border-border p-3" data-testid="unified-journal-snapshot">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold">진입 시점 분석 스냅샷</h4>
        <span className="break-all text-[11px] font-semibold text-muted-foreground">{userFacingCodeLabel(snapshot.contextSource, USER_CONTEXT_SOURCE_KO)}</span>
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

export function UnifiedTradeJournalPanel({
  loadApi = getUnifiedTradeJournal,
  forcedMarket,
  forcedSource,
  title = '통합 매매일지·매매 품질 복기',
  description = '수익 성과와 매매 과정의 품질을 분리해 결정론적으로 평가합니다.',
}: Props) {
  const [filters, setFilters] = useState<UnifiedJournalFilters>({
    range: '30D',
    market: forcedMarket ?? 'ALL',
    source: forcedSource ?? 'ALL',
    grade: 'ALL',
  });
  const [bindingFilter, setBindingFilter] = useState<'ALL'|'VERIFIED'|'MISMATCH'|'NOT_AVAILABLE'>('ALL');
  const [triggerFilter, setTriggerFilter] = useState<'ALL'|'VERIFIED'|'UNVERIFIED'>('ALL');
  const [searchText, setSearchText] = useState('');
  const [data, setData] = useState<UnifiedTradeJournal | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const effectiveFilters = useMemo<UnifiedJournalFilters>(() => ({
    ...filters,
    market: forcedMarket ?? filters.market,
    source: forcedSource ?? filters.source,
  }), [filters, forcedMarket, forcedSource]);
  const requestKey = JSON.stringify(effectiveFilters);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void loadApi(effectiveFilters, controller.signal).then((result) => {
      setData(result);
      setSelectedId((current) => result.trades.some((trade) => trade.id === current) ? current : result.trades[0]?.id ?? '');
    }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : '통합 매매일지를 불러오지 못했습니다.');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [loadApi, requestKey, refreshVersion]);

  const visibleTrades = useMemo(() => {
    if (!data) return [];
    const query = searchText.trim().toLowerCase();
    return data.trades.filter((trade) => {
      const bindingStatus = trade.canonicalResearchBinding?.status ?? 'NOT_AVAILABLE';
      if (bindingFilter !== 'ALL') {
        if (trade.source !== 'APP_PAPER') return false;
        if (bindingStatus !== bindingFilter) return false;
      }
      const triggerVerified = trade.canonicalResearchBinding?.triggerBindingVerified === true;
      if (triggerFilter !== 'ALL' && trade.source !== 'APP_PAPER') return false;
      if (triggerFilter === 'VERIFIED' && !triggerVerified) return false;
      if (triggerFilter === 'UNVERIFIED' && triggerVerified) return false;
      if (!query) return true;
      const searchable = [
        trade.symbol,
        trade.strategy ?? '',
        trade.canonicalResearchBinding?.candidateId ?? '',
        trade.canonicalResearchBinding?.strategyId ?? '',
        trade.canonicalResearchBinding?.researchCodeSha ?? '',
        trade.canonicalResearchBinding?.naturalPositionId ?? '',
        trade.canonicalResearchBinding?.paperSampleId ?? '',
        trade.canonicalResearchBinding?.settlementId ?? '',
        trade.canonicalResearchBinding?.exitTriggerId ?? '',
        trade.canonicalResearchBinding?.exitExecutionId ?? '',
        trade.canonicalResearchBinding?.reason ?? '',
      ].join(' ').toLowerCase();
      return searchable.includes(query);
    });
  }, [bindingFilter, data, searchText, triggerFilter]);
  const bindingIssues = useMemo(() => {
    if (!data) return [];
    const groups = new Map<string, {
      status: 'MISMATCH'|'NOT_AVAILABLE';
      reason: string;
      count: number;
    }>();
    for (const trade of data.trades) {
      if (trade.source !== 'APP_PAPER') continue;
      const status = trade.canonicalResearchBinding?.status;
      if (status !== 'MISMATCH' && status !== 'NOT_AVAILABLE') continue;
      const reason = trade.canonicalResearchBinding?.reason ?? 'AUTHENTICATED_BINDING_NOT_AVAILABLE';
      const key = `${status}:${reason}`;
      const current = groups.get(key);
      groups.set(key, { status, reason, count: (current?.count ?? 0) + 1 });
    }
    return [...groups.values()].sort((left, right) => (
      left.status === right.status
        ? right.count - left.count || left.reason.localeCompare(right.reason)
        : left.status === 'MISMATCH' ? -1 : 1
    ));
  }, [data]);
  const selected = useMemo(
    () => visibleTrades.find((trade) => trade.id === selectedId) ?? visibleTrades[0] ?? null,
    [selectedId, visibleTrades],
  );

  function change(name: keyof UnifiedJournalFilters, value: string) {
    if (name === 'market' && forcedMarket) return;
    if (name === 'source' && forcedSource) return;
    setFilters((current) => ({ ...current, [name]: value }));
  }

  return <section className="min-w-0 space-y-4" data-testid="unified-trade-journal">
    <div className="min-w-0 rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-extrabold"><BookOpenCheck className="h-4 w-4" />{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setRefreshVersion((value) => value + 1)} data-testid="unified-journal-refresh">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}새로고침
        </button>
      </div>

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 font-semibold" data-testid="toss-free-status">
          <AlertTriangle className="mr-2 inline h-4 w-4" />Toss 실조회: {data?.toss.liveReadIntegration ?? '확인 중'} · 비용 상태 미확인으로 실 API 호출 0건
        </p>
        <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 font-semibold" data-testid="journal-zero-cost-status">
          <ShieldCheck className="mr-2 inline h-4 w-4" />외부 AI 비활성 · 신규 비용 {data?.safety.finalCostDelta ?? '0_KRW'} · 주문/취소/정정 0건
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="grid min-w-0 gap-1 text-xs">기간<select className={controlClass} value={filters.range} onChange={(event) => change('range', event.target.value)}><option value="TODAY">오늘</option><option value="7D">7일</option><option value="30D">30일</option><option value="90D">90일</option><option value="1Y">1년</option><option value="ALL">전체</option></select></label>
        <label className="grid min-w-0 gap-1 text-xs">시장<select className={controlClass} value={effectiveFilters.market} disabled={Boolean(forcedMarket)} onChange={(event) => change('market', event.target.value)}><option value="ALL">전체 시장</option><option value="KR_STOCK">{USER_MARKET_KO.KR_STOCK}</option><option value="US_STOCK">{USER_MARKET_KO.US_STOCK}</option><option value="CRYPTO_SPOT">{USER_MARKET_KO.CRYPTO_SPOT}</option><option value="CRYPTO_FUTURES">{USER_MARKET_KO.CRYPTO_FUTURES}</option></select></label>
        <label className="grid min-w-0 gap-1 text-xs">출처<select className={controlClass} value={effectiveFilters.source} disabled={Boolean(forcedSource)} onChange={(event) => change('source', event.target.value)}><option value="ALL">전체</option><option value="TOSS_MANUAL">{USER_TRADE_SOURCE_KO.TOSS_MANUAL}</option><option value="TOSS_API">{USER_TRADE_SOURCE_KO.TOSS_API}</option><option value="APP_PAPER">{USER_TRADE_SOURCE_KO.APP_PAPER}</option><option value="APP_SHADOW">{USER_TRADE_SOURCE_KO.APP_SHADOW}</option><option value="APP_AUTO">{USER_TRADE_SOURCE_KO.APP_AUTO}</option></select></label>
        <label className="grid min-w-0 gap-1 text-xs">품질 등급<select className={controlClass} value={filters.grade} onChange={(event) => change('grade', event.target.value)}><option value="ALL">전체 등급</option><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option></select></label>
      </div>

      <div className="mt-3 rounded-xl border border-border bg-muted/20 p-3" data-testid="unified-journal-binding-filters">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-black">검증 연결 목록 필터</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">아래 필터는 거래 목록에만 적용됩니다. 위 성과 요약은 서버 조회 전체 기준입니다.</p>
          </div>
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setBindingFilter('ALL');
              setTriggerFilter('ALL');
              setSearchText('');
            }}
            data-testid="unified-journal-binding-filter-reset"
          >
            목록 필터 초기화
          </button>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="grid min-w-0 gap-1 text-xs">
            Research binding
            <select
              aria-label="Research binding"
              className={controlClass}
              value={bindingFilter}
              onChange={(event) => setBindingFilter(event.target.value as typeof bindingFilter)}
            >
              <option value="ALL">전체</option>
              <option value="VERIFIED">검증됨</option>
              <option value="MISMATCH">불일치</option>
              <option value="NOT_AVAILABLE">미확인</option>
            </select>
          </label>
          <label className="grid min-w-0 gap-1 text-xs">
            Trigger binding
            <select
              aria-label="Trigger binding filter"
              className={controlClass}
              value={triggerFilter}
              onChange={(event) => setTriggerFilter(event.target.value as typeof triggerFilter)}
            >
              <option value="ALL">전체</option>
              <option value="VERIFIED">Trigger 검증됨</option>
              <option value="UNVERIFIED">Trigger 미검증</option>
            </select>
          </label>
          <label className="grid min-w-0 gap-1 text-xs">
            목록 검색
            <input
              aria-label="거래 목록 검색"
              className={controlClass}
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="종목 · 전략 · candidateId · Trigger ID"
              inputMode="search"
            />
          </label>
        </div>
      </div>
    </div>

    {error ? <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
    {busy && !data ? <div className="grid min-h-40 place-items-center rounded-2xl border border-border bg-card"><Loader2 className="h-6 w-6 animate-spin" aria-label="매매일지 불러오는 중" /></div> : null}

    {data ? <>
      <JournalPaperLinkageSummary data={data} />

      {bindingIssues.length ? (
        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4" data-testid="unified-journal-binding-issues">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-extrabold">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Research 연결 문제 빠른 진단
              </h3>
              <p className="mt-1 text-[10px] text-muted-foreground">
                서버가 반환한 canonical binding reason을 그대로 묶습니다. 원인을 클릭하면 거래 목록만 좁혀지고 성과 요약은 바뀌지 않습니다.
              </p>
            </div>
            <span className="rounded-full border border-amber-500/30 bg-background px-2 py-1 text-[10px] font-black">
              원인 {bindingIssues.length}종
            </span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {bindingIssues.map((issue) => (
              <button
                key={`${issue.status}:${issue.reason}`}
                type="button"
                className="min-w-0 rounded-xl border border-border bg-background p-3 text-left hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => {
                  setBindingFilter(issue.status);
                  setTriggerFilter('ALL');
                  setSearchText(issue.reason);
                }}
                data-testid={`unified-journal-binding-issue-${issue.status.toLowerCase()}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[9px] font-black ${
                    issue.status === 'MISMATCH'
                      ? 'border-destructive/40 bg-destructive/10 text-destructive'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-700'
                  }`}>
                    {issue.status === 'MISMATCH' ? '불일치' : '미확인'}
                  </span>
                  <span className="text-xs font-black tabular-nums">{issue.count}건</span>
                </div>
                <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">{issue.reason}</p>
                <p className="mt-2 text-[10px] font-bold text-primary">눌러서 해당 거래만 보기</p>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="rounded-2xl border border-border bg-card p-4" data-testid="unified-journal-analytics">
        <h3 className="flex items-center gap-2 text-sm font-extrabold"><BarChart3 className="h-4 w-4" />성과 요약</h3>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="종료 거래" value={String(data.analytics.closedTrades)} />
          <Metric label={USER_METRIC_KO.WIN_RATE} value={metric(data.analytics.winRate, '%')} />
          <Metric label={USER_METRIC_KO.PROFIT_FACTOR} value={metric(data.analytics.profitFactor)} />
          <Metric label="평균 수익률" value={metric(data.analytics.averageReturnPercent, '%')} />
          <Metric label="진행 중" value={String(data.analytics.openTrades)} />
          <Metric label="최대 연속 손실" value={metric(data.analytics.maximumConsecutiveLosses)} />
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
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <h3 className="text-sm font-bold">거래 목록 {visibleTrades.length} / {data.trades.length}건</h3>
            <span className="text-[10px] text-muted-foreground">목록 필터 적용</span>
          </div>
          {visibleTrades.length === 0 ? (
            <div className="rounded-xl bg-muted p-3 text-xs text-muted-foreground" data-testid="unified-journal-empty-filter-result">
              <p>선택한 검증 연결 조건 또는 검색어에 해당하는 거래가 없습니다.</p>
              <p className="mt-1 break-all font-mono text-[10px]">
                Research={bindingFilter} · Trigger={triggerFilter} · Search={searchText.trim() || 'EMPTY'}
              </p>
              <button
                type="button"
                className="mt-2 min-h-9 rounded-lg border border-border bg-background px-3 text-xs font-bold text-foreground"
                onClick={() => {
                  setBindingFilter('ALL');
                  setTriggerFilter('ALL');
                  setSearchText('');
                }}
                data-testid="unified-journal-empty-filter-reset"
              >
                필터 초기화
              </button>
            </div>
          ) : visibleTrades.map((trade) => <button
            type="button"
            key={trade.id}
            className={`w-full min-w-0 rounded-xl border p-3 text-left ${selected?.id === trade.id ? 'border-primary bg-primary/5' : 'border-border'}`}
            onClick={() => setSelectedId(trade.id)}
          >
            <div className="flex min-w-0 items-start justify-between gap-2"><span className="min-w-0 break-words text-sm font-bold">{trade.symbol}</span><Grade trade={trade} /></div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{userFacingCodeLabel(trade.source, USER_TRADE_SOURCE_KO)} · {userFacingCodeLabel(trade.status, USER_STATUS_KO)}</span><span>{money(trade.netPnl, trade.currency)}</span></div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] font-extrabold">
              {trade.source === 'APP_PAPER' ? (
                <>
                  <span className="rounded-full border border-border bg-background px-2 py-0.5">
                    Research {trade.canonicalResearchBinding?.status === 'VERIFIED'
                      ? '검증'
                      : trade.canonicalResearchBinding?.status === 'MISMATCH'
                        ? '불일치'
                        : '미확인'}
                  </span>
                  <span className="rounded-full border border-border bg-background px-2 py-0.5">
                    Trigger {trade.canonicalResearchBinding?.triggerBindingVerified ? '검증' : '미검증'}
                  </span>
                </>
              ) : (
                <span className="rounded-full border border-border bg-background px-2 py-0.5">Research 해당없음</span>
              )}
            </div>
          </button>)}
        </div>
        {selected ? <TradeDetail trade={selected} /> : <div className="grid min-h-40 place-items-center rounded-2xl border border-border bg-card text-sm text-muted-foreground">거래를 선택하세요.</div>}
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 text-xs" data-testid="unified-journal-monthly">
        <h3 className="text-sm font-bold">월간 리포트</h3>
        {data.analytics.monthlyReport.length ? <div className="mt-3 space-y-2">{data.analytics.monthlyReport.map((month) => <div key={month.month} className="grid grid-cols-2 gap-2 rounded-xl border border-border p-3 sm:grid-cols-4"><span className="font-bold">{month.month}</span><span>{month.sampleSize}건</span><span>{USER_METRIC_KO.WIN_RATE} {metric(month.winRate, '%')}</span><span>{month.netPnlByCurrency.map((item) => money(item.value, item.currency)).join(' · ') || 'N/A'}</span></div>)}</div> : <p className="mt-2 text-muted-foreground">표시할 월간 데이터가 없습니다.</p>}
      </div>
    </> : null}
  </section>;
}
