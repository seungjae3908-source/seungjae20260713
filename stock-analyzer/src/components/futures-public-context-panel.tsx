import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Database } from 'lucide-react';
import type { AnalysisSelection } from '@/lib/analysis-selection';
import { resolveEvidenceDisplay } from '@/lib/evidence-display';
import { normalizeUnifiedSymbol } from '@/lib/unified-chart-data';

type FuturesPublicStatus = 'live' | 'delayed' | 'cached' | 'disconnected' | 'error' | 'insufficient';

type FuturesPublicContext = {
  symbol: string;
  markPrice: number | null;
  fundingRate: number | null;
  nextFundingAt: string | null;
  openInterest: number | null;
  openInterestChangePercent: number | null;
  status: FuturesPublicStatus;
  updatedAt: string | null;
  warnings: string[];
};

type Props = {
  selection: AnalysisSelection;
};

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeStatus(value: unknown): FuturesPublicStatus {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'live' || normalized === 'delayed' || normalized === 'cached' || normalized === 'disconnected' || normalized === 'error' || normalized === 'insufficient') {
    return normalized;
  }
  return 'insufficient';
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim())
    .slice(0, 8);
}

async function fetchFuturesPublicContext(symbol: string, signal: AbortSignal): Promise<FuturesPublicContext> {
  const normalizedSymbol = normalizeUnifiedSymbol('BITGET', symbol);
  if (!normalizedSymbol) throw new Error('INVALID_FUTURES_SYMBOL');
  const response = await fetch(`/api/crypto/futures/${encodeURIComponent(normalizedSymbol)}/snapshot`, {
    method: 'GET',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload || payload.ok !== true || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new Error('FUTURES_PUBLIC_CONTEXT_UNAVAILABLE');
  }
  const data = payload.data as Record<string, unknown>;
  return {
    symbol: nullableText(data.symbol) ?? normalizedSymbol,
    markPrice: finite(data.markPrice),
    fundingRate: finite(data.fundingRate),
    nextFundingAt: nullableText(data.nextFundingAt),
    openInterest: finite(data.openInterest),
    openInterestChangePercent: finite(data.openInterestChangePercent),
    status: normalizeStatus(data.status),
    updatedAt: nullableText(data.updatedAt),
    warnings: normalizeWarnings(data.warnings),
  };
}

function formatNumber(value: number | null, maximumFractionDigits = 2): string {
  return resolveEvidenceDisplay({
    value,
    formatter: (observed) => typeof observed === 'number'
      ? observed.toLocaleString('ko-KR', { maximumFractionDigits })
      : String(observed),
  }).display;
}

function formatFunding(value: number | null): string {
  return resolveEvidenceDisplay({
    value,
    formatter: (observed) => typeof observed === 'number'
      ? `${(observed * 100).toFixed(4)}%`
      : String(observed),
  }).display;
}

function formatPercent(value: number | null): string {
  return resolveEvidenceDisplay({
    value,
    formatter: (observed) => typeof observed === 'number'
      ? `${observed >= 0 ? '+' : ''}${observed.toFixed(2)}%`
      : String(observed),
  }).display;
}

function formatDate(value: string | null): string {
  if (!value) return resolveEvidenceDisplay({ value: null, collected: false }).display;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return resolveEvidenceDisplay({ value: Number.NaN }).display;
  return new Date(timestamp).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusText(status: FuturesPublicStatus): string {
  if (status === 'live') return 'LIVE';
  if (status === 'delayed') return 'DELAYED';
  if (status === 'cached') return 'CACHED';
  if (status === 'disconnected') return 'UNAVAILABLE';
  if (status === 'error') return 'UNAVAILABLE';
  return 'PARTIAL';
}

export function FuturesPublicContextPanel({ selection }: Props) {
  const symbol = normalizeUnifiedSymbol('BITGET', selection.ticker || selection.symbol);
  const query = useQuery({
    queryKey: ['ai-chart-futures-public-context', symbol],
    queryFn: ({ signal }) => fetchFuturesPublicContext(symbol, signal),
    enabled: selection.market === 'BITGET' && Boolean(symbol),
    staleTime: 5_000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  if (selection.market !== 'BITGET') return null;

  const data = query.data;
  const missingEvidence = resolveEvidenceDisplay({ value: null, collected: false }).display;
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="futures-public-context">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Database className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[11px] font-extrabold text-primary">CRYPTO FUTURES PUBLIC CONTEXT</p>
            <h2 className="truncate text-sm font-black">{symbol || selection.ticker} · Bitget 공개 데이터</h2>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-card-border bg-background px-2 py-1 text-[9px] font-black">
          {query.isError ? 'UNAVAILABLE' : data ? statusText(data.status) : 'LOADING'}
        </span>
      </div>

      {query.isError ? (
        <div className="mt-3 flex gap-2 rounded-2xl border border-warning/30 bg-warning/5 p-3" role="status">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-[10px] font-bold leading-4 text-muted-foreground">
            공개 선물 스냅샷을 확인할 수 없습니다. 값이나 확률을 임의 생성하지 않습니다.
          </p>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5 lg:grid-cols-2 xl:grid-cols-5">
          <Metric label="Mark Price" value={data ? `${formatNumber(data.markPrice, 8)}${data.markPrice == null ? '' : ' USDT'}` : missingEvidence} />
          <Metric label="Funding" value={data ? formatFunding(data.fundingRate) : missingEvidence} />
          <Metric label="Next Funding" value={data ? formatDate(data.nextFundingAt) : missingEvidence} />
          <Metric label="Open Interest" value={data ? formatNumber(data.openInterest, 4) : missingEvidence} />
          <Metric label="OI Change" value={data ? formatPercent(data.openInterestChangePercent) : missingEvidence} />
        </div>
      )}

      {data?.warnings.length ? (
        <ul className="mt-3 space-y-1 rounded-2xl border border-warning/20 bg-warning/5 p-3 text-[10px] font-bold text-muted-foreground">
          {data.warnings.map((warning) => <li key={warning}>• {warning}</li>)}
        </ul>
      ) : null}

      <p className="mt-3 text-[10px] font-black text-muted-foreground">
        Bitget public market data · read-only context · NOT A TRADE SIGNAL
      </p>
      {data?.updatedAt ? (
        <p className="mt-1 text-[9px] font-semibold text-muted-foreground">Last update · {formatDate(data.updatedAt)}</p>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-card-border bg-background p-2.5 text-center">
      <p className="truncate text-[9px] font-bold text-muted-foreground">{label}</p>
      <strong className="mt-1 block break-all text-[10px]">{value}</strong>
    </div>
  );
}
