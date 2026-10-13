import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAnalysisSelection, selectionQuery, type AnalysisMarket, type AnalysisSelection } from '@/lib/analysis-selection';
import { resolveAssetDetailPath } from '@/lib/asset-navigation';

export type TradingHolding = {
  id: string; provider: string; market: string; symbol: string; displayName: string;
  ownership: 'AUTO' | 'MANUAL' | 'UNRESOLVED'; quantity: number | null;
  averageEntryPrice: number | null; currentPrice: number | null; marketValue: number | null;
  unrealizedPnl: number | null; unrealizedPnlPercent: number | null; currency: string;
  side: string | null; leverage: number | null; marginMode: string | null;
  entryEvidence: null | {
    planId: string; strategyId: string; signalId: string; observedAt: string | null; filledAt: string | null;
    entryPrice: number | null; targetPrices: number[]; stopPrice: number | null;
    protectionStatus: string; reasons: string[];
  };
};

type HoldingsResponse = {
  ok: true; readOnly: true; accountMode: string; checkedAt: string; stale: boolean;
  ownershipVerified: boolean; blocker: string | null; items: TradingHolding[];
};

function number(value: number | null | undefined, digits = 4) {
  return value == null || !Number.isFinite(value) ? '미확인'
    : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: digits }).format(value);
}
function price(value: number | null | undefined, currency: string) {
  return value == null ? '미설정 / 미확인' : number(value) + ' ' + currency;
}
function rate(value: number | null) { return value == null ? '미확인' : number(value) + '%'; }
const ownershipLabel = (row: TradingHolding, paper: boolean) => row.ownership === 'AUTO'
  ? paper ? '자동모의' : 'AUTO 운용' : row.ownership === 'MANUAL'
    ? paper ? '수동모의' : '기존 보유' : '소유 구분 미확인';

async function loadHoldings(query: URLSearchParams, signal: AbortSignal): Promise<HoldingsResponse> {
  const response = await authorizedFetch('/api/trade-automation/holdings?' + query.toString(), { signal, cache: 'no-store' });
  const body = await response.json();
  if (!response.ok || body?.ok !== true || body.schemaVersion !== 'trading-holdings-readonly-v1'
    || body.readOnly !== true || body.accountMode !== query.get('accountMode') || !Array.isArray(body.items)
    || !Number.isFinite(Date.parse(body.checkedAt)) || typeof body.stale !== 'boolean'
    || typeof body.ownershipVerified !== 'boolean'
    || body.credentialsReturned !== false || body.liveTradingAuthorityGranted !== false
    || body.autoTradingAuthorityGranted !== false
    || ['orderRequests', 'cancelRequests', 'amendRequests', 'transferRequests', 'withdrawalRequests']
      .some(key => body[key] !== 0)
    || body.items.some((row: TradingHolding) => !row.id || !row.symbol
      || !['AUTO', 'MANUAL', 'UNRESOLVED'].includes(row.ownership)
      || row.entryEvidence != null && (!Array.isArray(row.entryEvidence.reasons)
        || !Array.isArray(row.entryEvidence.targetPrices)))) {
    throw new Error('보유정보 검증 실패');
  }
  return body;
}

export function TradingHoldingsPanel({ market, providers, accountMode, origin, userId, enabled,
  fixture, canChart }: {
  market: AnalysisMarket; providers: readonly string[]; accountMode: 'live' | 'paper';
  origin: 'automatic' | 'manual'; userId: string; enabled: boolean;
  fixture?: readonly TradingHolding[]; canChart: boolean;
}) {
  const [, navigate] = useLocation();
  const { select } = useAnalysisSelection();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const providerKey = providers.join(',');
  const query = useQuery({
    queryKey: ['trading-holdings', userId, accountMode, origin, providerKey],
    enabled: enabled && fixture == null && Boolean(userId) && (accountMode === 'paper' || Boolean(providerKey)),
    staleTime: 15_000, refetchInterval: 30_000, retry: false,
    queryFn: async ({ signal }) => {
      const sources = accountMode === 'paper' ? ['paper'] : providerKey.split(',');
      const results = await Promise.allSettled(sources.map(provider => loadHoldings(new URLSearchParams({
        accountMode, origin, ...(accountMode === 'live' ? { provider } : {}),
      }), signal)));
      const snapshots = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (!snapshots.length) throw new Error('보유정보 조회 실패');
      return { snapshots, failedProviders: sources.filter((_, index) => results[index]!.status === 'rejected') };
    },
  });
  // Query cache may still hold previous results after evidence is revoked.
  // Never render stale automatic Paper holdings when the explicit gate closes.
  const snapshots = enabled ? query.data?.snapshots : undefined;
  const partialFailure = enabled && Boolean(query.data?.failedProviders.length);
  const items = (fixture ?? snapshots?.flatMap(result => result.items) ?? []).filter(row => row.market === market);
  const selected = items.find(row => row.id === selectedId) ?? null;
  const hasUnverified = snapshots?.some(result => !result.ownershipVerified || result.stale) ?? false;
  useEffect(() => { setSelectedId(null); }, [market, userId, accountMode, origin]);
  useEffect(() => {
    if (selected && !dialog.current?.open) dialog.current?.showModal();
    if (!selected && dialog.current?.open) dialog.current.close();
  }, [selected]);

  function navigateAsset(row: TradingHolding, chart: boolean) {
    if (!['KR', 'US', 'UPBIT', 'BITGET'].includes(row.market)) return;
    const assetType = row.market === 'UPBIT' ? 'coin_spot' : row.market === 'BITGET' ? 'coin_futures' : 'stock';
    const ticker = row.market === 'UPBIT' ? row.symbol.replace(/^KRW-/u, '') : row.symbol;
    const selection: AnalysisSelection = {
      assetType, market: row.market as AnalysisMarket, symbol: ticker, ticker, displayName: row.displayName,
      timeframe: '1D', selectedAt: new Date().toISOString(),
      // Observed entry evidence is not a new actionable scanner signal or order approval.
    };
    select(selection);
    setSelectedId(null);
    if (chart) navigate('/ai-chart?' + selectionQuery(selection));
    else {
      try {
        navigate(resolveAssetDetailPath({
          assetClass: assetType === 'stock' ? row.market === 'KR' ? 'KR_STOCK' : 'US_STOCK'
            : assetType === 'coin_spot' ? 'CRYPTO_SPOT' : 'CRYPTO_FUTURES',
          market: row.market as AnalysisMarket, symbol: row.symbol, canonicalSymbol: ticker,
          backPath: window.location.pathname + window.location.search,
        }));
      } catch { /* Unsupported identity stays fail closed; do not navigate to a default asset. */ }
    }
  }
  const pending = enabled && fixture == null && query.isLoading;
  const unavailable = fixture == null && (!enabled || accountMode === 'live' && !providerKey);
  return (
    <section className="min-w-0 rounded-2xl border border-card-border bg-card p-3 sm:p-4" data-testid="trading-holdings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">보유종목</h2>
        <span className="text-xs text-muted-foreground">{accountMode === 'live' ? '실계좌 · 읽기 전용' : '모의계좌'}</span>
      </div>
      {enabled && query.isError ? <p role="alert" className="mt-3 text-xs text-amber-600">보유정보 조회 실패 · 마지막 표시값은 최신 상태가 아닙니다.</p> : null}
      {partialFailure ? <p role="alert" className="mt-3 text-xs text-amber-600">일부 계좌 조회 실패 · 확인된 계좌만 표시합니다.</p> : null}
      {hasUnverified ? <p role="alert" className="mt-3 text-xs text-amber-600">소유 수량 대조 필요 · AUTO 자산으로 임의 분류하지 않습니다.</p> : null}
      {pending ? <p role="status" className="mt-3 text-sm text-muted-foreground">보유정보 확인 중</p> : null}
      {unavailable ? <p className="mt-3 text-sm text-muted-foreground">연결된 계좌 또는 조회 권한이 필요합니다.</p> : null}
      {!pending && !unavailable && !query.isError && !partialFailure && items.length === 0
        ? <p className="mt-3 text-sm text-muted-foreground">선택 시장의 보유종목이 없습니다.</p> : null}
      <div className="mt-3 hidden overflow-x-auto md:block">
        {items.length ? <table className="w-full text-left text-xs" aria-label="보유종목 목록">
          <thead className="text-muted-foreground"><tr>
            {['종목 / 구분', '보유수량', '평균매수가', '현재가', '평가금액', '평가손익 / 수익률'].map(label =>
              <th key={label} className="whitespace-nowrap px-2 py-2 font-medium">{label}</th>)}
          </tr></thead>
          <tbody>{items.map(row => <tr key={row.id} className="border-t border-card-border">
            <td className="px-2 py-3"><button type="button" className="min-h-11 text-left font-semibold text-primary underline-offset-4 hover:underline"
              onClick={() => setSelectedId(row.id)}>{row.displayName}<span className="block text-xs font-normal text-muted-foreground">
                {row.symbol} · {row.provider} · {ownershipLabel(row, accountMode === 'paper')}</span></button></td>
            <td className="px-2 py-3 tabular-nums">{number(row.quantity, 8)}</td>
            <td className="px-2 py-3 tabular-nums">{price(row.averageEntryPrice, row.currency)}</td>
            <td className="px-2 py-3 tabular-nums">{price(row.currentPrice, row.currency)}</td>
            <td className="px-2 py-3 tabular-nums">{price(row.marketValue, row.currency)}</td>
            <td className="px-2 py-3 tabular-nums">{price(row.unrealizedPnl, row.currency)} / {rate(row.unrealizedPnlPercent)}</td>
          </tr>)}</tbody>
        </table> : null}
      </div>
      <div className="mt-3 space-y-2 md:hidden">
        {items.map(row => <button key={row.id} type="button" className="w-full rounded-xl border border-card-border p-3 text-left"
          onClick={() => setSelectedId(row.id)}>
          <div className="flex flex-wrap justify-between gap-1 text-sm font-semibold">
            <span className="break-all">{row.displayName}</span><span className="text-xs text-muted-foreground">{ownershipLabel(row, accountMode === 'paper')}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{row.symbol} · {row.provider}</p>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <Metric label="보유수량" value={number(row.quantity, 8)} /><Metric label="평균매수가" value={price(row.averageEntryPrice, row.currency)} />
            <Metric label="현재가" value={price(row.currentPrice, row.currency)} /><Metric label="평가금액" value={price(row.marketValue, row.currency)} />
            <Metric label="평가손익" value={price(row.unrealizedPnl, row.currency)} /><Metric label="수익률" value={rate(row.unrealizedPnlPercent)} />
          </dl>
        </button>)}
      </div>
      {snapshots?.[0]?.checkedAt ? <p className="mt-3 text-xs text-muted-foreground">
        조회 {new Date(snapshots[0].checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p> : null}
      <dialog ref={dialog} aria-labelledby="holding-title" aria-describedby="holding-scope"
        onCancel={() => setSelectedId(null)} onClose={() => setSelectedId(null)}
        onClick={event => { if (event.target === event.currentTarget) setSelectedId(null); }}
        style={{ backgroundColor: 'hsl(var(--card))' }}
        className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border border-card-border p-0 text-foreground shadow-2xl backdrop:bg-black/60 sm:inset-0 sm:m-auto sm:max-w-xl sm:rounded-2xl"
        data-testid="holding-detail-dialog">
        {selected ? <div className="space-y-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
          {enabled && query.isError ? <p role="alert" className="text-xs text-amber-600">마지막 조회값 · 현재 상태는 미확인입니다.</p> : null}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><h2 id="holding-title" className="break-all text-lg font-bold">{selected.displayName}</h2>
              <p id="holding-scope" className="mt-1 text-xs text-muted-foreground">{selected.symbol} · {selected.provider} · {ownershipLabel(selected, accountMode === 'paper')}</p></div>
            <button type="button" aria-label="보유종목 상세 닫기" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-card-border"
              onClick={() => setSelectedId(null)}><X className="h-4 w-4" /></button>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Metric label={selected.entryEvidence ? '진입가 · 실제 체결' : '평균매수가'} value={price(selected.entryEvidence
              ? selected.entryEvidence.entryPrice : selected.averageEntryPrice, selected.currency)} />
            <Metric label="현재가" value={price(selected.currentPrice, selected.currency)} />
            <Metric label="목표가 · 저장된 계획" value={selected.entryEvidence?.targetPrices.length
              ? selected.entryEvidence.targetPrices.map(value => price(value, selected.currency)).join(' / ') : '미설정'} />
            <Metric label="손절가 · 저장된 계획" value={selected.entryEvidence?.stopPrice != null ? price(selected.entryEvidence.stopPrice, selected.currency) : '미설정'} />
            {selected.leverage != null ? <Metric label="선물 방향 / 레버리지" value={(selected.side ?? '미확인') + ' / ' + selected.leverage + 'x'} /> : null}
            {selected.entryEvidence ? <Metric label="보호주문 등록 상태" value={selected.entryEvidence.protectionStatus === 'UNKNOWN'
              ? '등록 미확인' : selected.entryEvidence.protectionStatus} /> : null}
          </dl>
          <section className="rounded-xl border border-card-border p-3" data-testid="holding-entry-evidence">
            <h3 className="text-sm font-semibold">진입사유</h3>
            <p className="mt-2 break-words text-sm">{selected.entryEvidence
              ? selected.entryEvidence.reasons[0] ?? '저장된 진입사유 없음'
              : selected.ownership === 'MANUAL' ? '기존 보유 — AUTO 진입 기록 없음' : '소유 구분 미확인 — 진입근거를 연결하지 않습니다.'}</p>
            {selected.entryEvidence ? <details className="mt-3">
              <summary className="min-h-10 cursor-pointer text-xs font-semibold">근거 더 보기</summary>
              <ul className="list-disc space-y-1 pl-4 text-xs">{selected.entryEvidence.reasons.slice(1).map((reason, index) =>
                <li key={index} className="break-words">{reason}</li>)}</ul>
              <dl className="mt-3 grid gap-2 break-all text-xs">
                <Metric label="전략" value={selected.entryEvidence.strategyId} /><Metric label="신호" value={selected.entryEvidence.signalId} />
                <Metric label="진입근거 관측 시각" value={selected.entryEvidence.observedAt ?? '미확인'} />
                <Metric label="체결 기록 시각" value={selected.entryEvidence.filledAt ?? '미확인'} />
              </dl>
            </details> : null}
          </section>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="min-h-11 rounded-xl border border-card-border px-3 text-sm font-semibold"
              onClick={() => navigateAsset(selected, false)}>종목상세</button>
            <button type="button" disabled={!canChart} className="min-h-11 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-40"
              onClick={() => navigateAsset(selected, true)}>AI차트</button>
          </div>
        </div> : null}
      </dialog>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1 break-words font-medium tabular-nums">{value}</dd></div>;
}
