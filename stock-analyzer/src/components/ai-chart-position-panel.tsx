import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, RefreshCw, WalletCards } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import type { AnalysisMarket } from '@/lib/analysis-selection';

export type AiChartAccountPosition = {
  market: string;
  symbol: string;
  quantity: number | null;
  availableQuantity: number | null;
  averageEntryPrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  leverage: number | null;
  liquidationPrice: number | null;
  marginMode: string | null;
  side: string | null;
};

export type AiChartPositionOverlay = {
  provider: 'toss' | 'upbit' | 'bitget';
  position: AiChartAccountPosition;
  stale: boolean;
  checkedAt: string | null;
};

type Snapshot = {
  provider: 'toss' | 'upbit' | 'bitget';
  readOnly: true;
  connected: boolean;
  status: string;
  positions: AiChartAccountPosition[];
  checkedAt: string;
  lastGoodAt: string | null;
  stale: boolean;
  errorCode: string | null;
  orderRequests: 0;
  cancelRequests: 0;
  amendRequests: 0;
  transferRequests: 0;
  withdrawalRequests: 0;
  liveTradingEnabled: false;
  autoTradingEnabled: false;
};

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: Snapshot; position: AiChartAccountPosition | null }
  | { kind: 'unavailable'; code: string };

type Props = {
  market: AnalysisMarket;
  symbol: string;
  chartPrice: number | null;
  onOverlayChange: (overlay: AiChartPositionOverlay | null) => void;
};

function providerForMarket(market: AnalysisMarket): Snapshot['provider'] {
  if (market === 'UPBIT') return 'upbit';
  if (market === 'BITGET') return 'bitget';
  return 'toss';
}

function normalizedSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function upbitBaseSymbol(value: string): string {
  const upper = value.trim().toUpperCase();
  if (upper.startsWith('KRW-')) return normalizedSymbol(upper.slice(4));
  if (upper.startsWith('KRW/')) return normalizedSymbol(upper.slice(4));
  return normalizedSymbol(upper);
}

function symbolMatches(market: AnalysisMarket, chartSymbol: string, positionSymbol: string): boolean {
  if (!chartSymbol.trim() || !positionSymbol.trim()) return false;
  if (market === 'UPBIT') return upbitBaseSymbol(chartSymbol) === upbitBaseSymbol(positionSymbol);
  return normalizedSymbol(chartSymbol) === normalizedSymbol(positionSymbol);
}

function activePosition(position: AiChartAccountPosition): boolean {
  return position.quantity != null && Number.isFinite(position.quantity) && Math.abs(position.quantity) > 0;
}

function selectPosition(
  market: AnalysisMarket,
  symbol: string,
  positions: AiChartAccountPosition[],
): { position: AiChartAccountPosition | null; ambiguous: boolean } {
  const matches = positions.filter((position) => activePosition(position) && symbolMatches(market, symbol, position.symbol));
  if (matches.length > 1) return { position: null, ambiguous: true };
  return { position: matches[0] ?? null, ambiguous: false };
}

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function formatPrice(value: number | null | undefined, market: AnalysisMarket): string {
  const parsed = finite(value);
  if (parsed == null) return '미제공';
  if (market === 'US') return `$${parsed.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}`;
  if (market === 'BITGET') return `${parsed.toLocaleString('ko-KR', { maximumFractionDigits: parsed >= 1000 ? 2 : 8 })} USDT`;
  return `${parsed.toLocaleString('ko-KR', { maximumFractionDigits: parsed >= 1000 ? 0 : 8 })}원`;
}

function formatQuantity(value: number | null | undefined): string {
  const parsed = finite(value);
  return parsed == null ? '미제공' : parsed.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
}

function formatPnl(value: number | null | undefined, market: AnalysisMarket): string {
  const parsed = finite(value);
  if (parsed == null) return '미제공';
  const sign = parsed > 0 ? '+' : '';
  if (market === 'US') return `${sign}$${parsed.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`;
  if (market === 'BITGET') return `${sign}${parsed.toLocaleString('ko-KR', { maximumFractionDigits: 4 })} USDT`;
  return `${sign}${parsed.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원`;
}

function formatPercent(value: number | null | undefined): string {
  const parsed = finite(value);
  return parsed == null ? '미제공' : `${parsed > 0 ? '+' : ''}${parsed.toFixed(2)}%`;
}

function priceDistance(position: AiChartAccountPosition, chartPrice: number | null): number | null {
  const average = finite(position.averageEntryPrice);
  const current = finite(position.currentPrice) ?? finite(chartPrice);
  if (average == null || current == null || average <= 0) return null;
  const raw = ((current - average) / average) * 100;
  const side = String(position.side ?? '').toLowerCase();
  return side === 'short' ? -raw : raw;
}

function providerLabel(provider: Snapshot['provider']): string {
  return provider === 'toss' ? 'Toss' : provider === 'upbit' ? 'Upbit' : 'Bitget';
}

function checkedAtLabel(value: string | null | undefined): string {
  if (!value) return '미확인';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '미확인';
  return new Date(timestamp).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function AiChartPositionPanel({ market, symbol, chartPrice, onOverlayChange }: Props) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [linesVisible, setLinesVisible] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    requestSequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ kind: 'idle' });
    setLinesVisible(true);
    onOverlayChange(null);
  }, [market, onOverlayChange, symbol]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const loadPosition = useCallback(async () => {
    const provider = providerForMarket(market);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const sequence = ++requestSequenceRef.current;
    setState({ kind: 'loading' });
    onOverlayChange(null);

    try {
      const response = await authorizedFetch(`/api/accounts/read-only/${provider}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as Snapshot | { errorCode?: string } | null;
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      if (!response.ok) {
        setState({ kind: 'unavailable', code: payload && 'errorCode' in payload && payload.errorCode ? payload.errorCode : `HTTP_${response.status}` });
        return;
      }
      if (!payload || !('readOnly' in payload) || payload.readOnly !== true || !Array.isArray(payload.positions)) {
        setState({ kind: 'unavailable', code: 'ACCOUNT_SNAPSHOT_INVALID' });
        return;
      }
      const snapshot = payload as Snapshot;
      if (
        snapshot.orderRequests !== 0
        || snapshot.cancelRequests !== 0
        || snapshot.amendRequests !== 0
        || snapshot.transferRequests !== 0
        || snapshot.withdrawalRequests !== 0
        || snapshot.liveTradingEnabled !== false
        || snapshot.autoTradingEnabled !== false
      ) {
        setState({ kind: 'unavailable', code: 'ACCOUNT_SNAPSHOT_SAFETY_MISMATCH' });
        return;
      }
      const selected = selectPosition(market, symbol, snapshot.positions);
      if (selected.ambiguous) {
        setState({ kind: 'unavailable', code: 'MULTIPLE_MATCHING_POSITIONS' });
        return;
      }
      setState({ kind: 'ready', snapshot, position: selected.position });
      if (selected.position && linesVisible) {
        onOverlayChange({ provider, position: selected.position, stale: snapshot.stale, checkedAt: snapshot.checkedAt ?? null });
      }
    } catch (error) {
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      setState({ kind: 'unavailable', code: error instanceof Error ? error.name : 'ACCOUNT_READ_FAILED' });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [linesVisible, market, onOverlayChange, symbol]);

  const toggleLines = useCallback(() => {
    if (state.kind !== 'ready' || !state.position) return;
    setLinesVisible((current) => {
      const next = !current;
      onOverlayChange(next ? {
        provider: state.snapshot.provider,
        position: state.position,
        stale: state.snapshot.stale,
        checkedAt: state.snapshot.checkedAt ?? null,
      } : null);
      return next;
    });
  }, [onOverlayChange, state]);

  const provider = providerForMarket(market);
  const position = state.kind === 'ready' ? state.position : null;
  const distance = position ? priceDistance(position, chartPrice) : null;

  return (
    <section data-testid="ai-chart-position-panel" className="rounded-2xl border border-card-border bg-background/85 p-3 text-left shadow-sm">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <WalletCards className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[11px] font-black text-primary">내 포지션 · READ-ONLY</p>
            <p className="truncate text-[10px] font-bold text-muted-foreground">{providerLabel(provider)} · {symbol}</p>
          </div>
        </div>
        {state.kind === 'idle' || state.kind === 'unavailable' ? (
          <button
            type="button"
            data-testid="ai-chart-load-position"
            onClick={() => void loadPosition()}
            className="flex min-h-10 items-center gap-1.5 rounded-xl border border-card-border px-3 py-2 text-[11px] font-black"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            내 포지션 확인
          </button>
        ) : state.kind === 'loading' ? (
          <span role="status" className="flex min-h-10 items-center gap-1.5 rounded-xl bg-secondary px-3 py-2 text-[11px] font-black text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> 확인 중
          </span>
        ) : position ? (
          <button
            type="button"
            data-testid="ai-chart-toggle-position-lines"
            onClick={toggleLines}
            className="flex min-h-10 items-center gap-1.5 rounded-xl border border-card-border px-3 py-2 text-[11px] font-black"
          >
            {linesVisible ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
            {linesVisible ? '평단선 숨기기' : '평단선 표시'}
          </button>
        ) : null}
      </div>

      {state.kind === 'idle' && (
        <p className="mt-2 text-[10px] font-bold leading-4 text-muted-foreground">차트를 열기만 해서는 계좌를 조회하지 않습니다. 버튼을 눌렀을 때 현재 시장의 조회 전용 스냅샷만 확인합니다.</p>
      )}
      {state.kind === 'unavailable' && (
        <p role="alert" className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-[10px] font-bold text-warning">포지션을 표시할 수 없습니다 · {state.code}</p>
      )}
      {state.kind === 'ready' && !position && (
        <div className="mt-2 rounded-xl bg-secondary/60 px-3 py-2">
          <p className="text-[10px] font-black">현재 선택 종목의 보유/포지션 없음</p>
          <p className="mt-1 text-[9px] font-bold text-muted-foreground">조회 시각 {checkedAtLabel(state.snapshot.checkedAt)}{state.snapshot.stale ? ' · 이전 정상값' : ''}</p>
        </div>
      )}
      {state.kind === 'ready' && position && (
        <div className="mt-2">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-6">
            <Metric label="내 평단" value={formatPrice(position.averageEntryPrice, market)} />
            <Metric label="보유수량" value={formatQuantity(position.quantity)} />
            <Metric label="미실현손익" value={formatPnl(position.unrealizedPnl, market)} />
            <Metric label="계좌 수익률" value={formatPercent(position.unrealizedPnlPercent)} />
            <Metric label="평단 대비 가격" value={formatPercent(distance)} />
            {market === 'BITGET' ? <Metric label="청산가" value={formatPrice(position.liquidationPrice, market)} /> : <Metric label="계좌 현재가" value={formatPrice(position.currentPrice, market)} />}
          </div>
          {market === 'BITGET' && (
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[9px] font-black text-muted-foreground">
              <span className="rounded-full bg-secondary px-2 py-1">방향 {position.side ?? '미제공'}</span>
              <span className="rounded-full bg-secondary px-2 py-1">레버리지 {finite(position.leverage) == null ? '미제공' : `${position.leverage}x`}</span>
              <span className="rounded-full bg-secondary px-2 py-1">마진 {position.marginMode ?? '미제공'}</span>
            </div>
          )}
          <p className="mt-2 text-[9px] font-bold text-muted-foreground">
            {providerLabel(state.snapshot.provider)} 조회 {checkedAtLabel(state.snapshot.checkedAt)}
            {state.snapshot.stale ? ' · 오래된 마지막 정상값' : ' · 최신 조회'}
            {' · '}평단 대비 가격은 차트/계좌 가격의 단순 가격거리이며 수수료·레버리지 ROE를 임의 계산하지 않습니다.
          </p>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-secondary/60 px-2.5 py-2">
      <p className="truncate text-[9px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[11px] font-black tabular-nums">{value}</p>
    </div>
  );
}
