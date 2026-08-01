import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import {
  getFuturesMarketSnapshot,
  getFuturesMarketStatus,
  type DataStatus,
} from '@/lib/futures-market-data';
import { formatFundingRatePercent } from '@/lib/futures-market-format';
import { TradingRiskPreviewPanel } from '@/components/trading-risk-preview-panel';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<DataStatus, string> = {
  live: '실시간',
  delayed: '지연',
  cached: '캐시',
  disconnected: '연결 끊김',
  error: '오류',
  insufficient: '데이터 부족',
};

function statusClass(status: DataStatus) {
  if (status === 'live') return 'border-positive/30 bg-positive/10 text-positive';
  if (status === 'cached' || status === 'delayed' || status === 'insufficient') {
    return 'border-warning/30 bg-warning/10 text-warning';
  }
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

function numberText(value: number | null, suffix = '') {
  if (value == null || !Number.isFinite(value)) return '데이터 없음';
  const digits = Math.abs(value) >= 1000 ? 2 : Math.abs(value) >= 1 ? 4 : 8;
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: digits })}${suffix}`;
}

function percentText(value: number | null, digits = 4) {
  if (value == null || !Number.isFinite(value)) return '확인 불가';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function dateText(value: string | null | undefined) {
  if (!value) return '확인 불가';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '확인 불가';
  return date.toLocaleString('ko-KR');
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-card-border bg-background p-3">
      <p className="text-[9px] font-black text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-[11px] font-black">{value}</p>
    </div>
  );
}

export function FuturesMarketStatusPanel({ symbol }: { symbol: string }) {
  const statusQuery = useQuery({
    queryKey: ['futures-public-status'],
    queryFn: getFuturesMarketStatus,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    retry: 1,
  });
  const snapshotQuery = useQuery({
    queryKey: ['futures-public-snapshot', symbol],
    queryFn: () => getFuturesMarketSnapshot(symbol),
    enabled: Boolean(symbol),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    retry: 1,
  });

  const snapshot = snapshotQuery.data;
  const status: DataStatus = snapshotQuery.isError || statusQuery.isError
    ? 'error'
    : snapshot?.status ?? statusQuery.data?.status ?? 'insufficient';
  const warnings = useMemo(
    () => [...new Set([
      ...(statusQuery.data?.warnings ?? []),
      ...(snapshot?.warnings ?? []),
      ...(snapshotQuery.isError ? ['선물 시장 스냅샷을 불러오지 못했습니다.'] : []),
      ...(statusQuery.isError ? ['Bitget 공개 데이터 연결 상태를 확인하지 못했습니다.'] : []),
    ])],
    [snapshot?.warnings, snapshotQuery.isError, statusQuery.data?.warnings, statusQuery.isError],
  );

  const refresh = async () => {
    await Promise.allSettled([statusQuery.refetch(), snapshotQuery.refetch()]);
  };

  return (
    <div className="space-y-4">
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <p className="text-[10px] font-black text-primary">선물 공개 시장 데이터</p>
            </div>
            <h2 className="mt-1 text-sm font-black">{symbol} · Bitget</h2>
            <p className="mt-1 text-[9px] font-bold text-muted-foreground">
              공개 시세 전용 · 주문 기능 없음
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn('rounded-full border px-2.5 py-1 text-[9px] font-black', statusClass(status))}>
              {STATUS_LABEL[status]}
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-background"
              aria-label="선물 공개 데이터 새로고침"
            >
              <RefreshCw className={cn('h-4 w-4', (statusQuery.isFetching || snapshotQuery.isFetching) && 'animate-spin')} />
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Metric label="마크가격" value={numberText(snapshot?.markPrice ?? null, ' USDT')} />
          <Metric label="인덱스가격" value={numberText(snapshot?.indexPrice ?? null, ' USDT')} />
          <Metric label="미결제약정 OI" value={numberText(snapshot?.openInterest ?? null)} />
          <Metric label="OI 변화율 · 서버 관측" value={percentText(snapshot?.openInterestChangePercent ?? null, 3)} />
          <Metric label="펀딩비" value={formatFundingRatePercent(snapshot?.fundingRate)} />
          <Metric label="다음 펀딩" value={dateText(snapshot?.nextFundingAt)} />
          <Metric label="베이시스" value={percentText(snapshot?.basisPercent ?? null, 4)} />
          <Metric label="호가 스프레드" value={percentText(snapshot?.spreadPercent ?? null, 4)} />
        </div>

        <p className="mt-2 text-[9px] font-bold leading-relaxed text-muted-foreground">
          OI 변화율은 서버가 수집한 이전 OI 표본과 비교한 값입니다. 서버 재시작 후에는 표본이 다시 쌓여야 합니다.
        </p>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[9px] font-bold text-muted-foreground">
          <span>출처 · {snapshot?.source ?? statusQuery.data?.provider ?? '확인 불가'}</span>
          <span>마지막 갱신 · {dateText(snapshot?.updatedAt ?? statusQuery.data?.updatedAt)}</span>
        </div>

        {warnings.length > 0 && (
          <div className="mt-3 rounded-2xl border border-warning/20 bg-warning/10 p-3">
            <p className="text-[10px] font-black text-warning">데이터 안내</p>
            <div className="mt-1 space-y-1">
              {warnings.map((warning) => (
                <p key={warning} className="text-[9px] font-bold leading-relaxed text-warning">
                  · {warning}
                </p>
              ))}
            </div>
          </div>
        )}
      </section>

      <TradingRiskPreviewPanel
        symbol={symbol}
        snapshot={snapshot}
        snapshotLoading={snapshotQuery.isLoading || snapshotQuery.isFetching}
      />
    </div>
  );
}
