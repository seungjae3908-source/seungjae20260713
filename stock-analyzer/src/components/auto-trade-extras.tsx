import { useEffect, useMemo, useState } from 'react';
import { Calculator, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { AppModal } from '@/components/app-modal';
import { formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

export function UsdKrwCalculator({ className }: { className?: string }) {
  const [usd, setUsd] = useState('');
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadRate = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        'https://api.frankfurter.app/latest?from=USD&to=KRW',
        { headers: { Accept: 'application/json' } },
      );
      const payload = await response.json().catch(() => ({}));
      const next = Number(payload?.rates?.KRW);
      if (!response.ok || !Number.isFinite(next) || next <= 0) {
        throw new Error('환율을 불러오지 못했습니다.');
      }
      setRate(next);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '환율을 불러오지 못했습니다.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRate();
  }, []);

  const usdValue = Number(usd.replace(/,/g, ''));
  const krw =
    rate != null && Number.isFinite(usdValue) && usdValue >= 0
      ? usdValue * rate
      : null;

  return (
    <section
      className={cn(
        'rounded-2xl border border-card-border bg-background p-3',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-primary" />
          <h3 className="text-xs font-black">달러 계산기</h3>
        </div>
        <button
          type="button"
          onClick={() => void loadRate()}
          disabled={loading}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-card-border bg-card disabled:opacity-50"
          aria-label="환율 새로고침"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="rounded-xl bg-secondary p-2 text-center">
          <span className="block text-[9px] font-black text-muted-foreground">
            달러 입력
          </span>
          <div className="mt-1 flex items-center justify-center gap-1">
            <input
              value={usd}
              onChange={(event) => setUsd(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              className="min-w-0 flex-1 bg-transparent text-right text-sm font-black outline-none"
            />
            <span className="text-[10px] font-black">달러</span>
          </div>
        </label>
        <div className="rounded-xl bg-secondary p-2 text-center">
          <span className="block text-[9px] font-black text-muted-foreground">
            자동 환산
          </span>
          <p className="mt-1 text-sm font-black">
            {krw == null ? '계산 대기' : `${Math.round(krw).toLocaleString('ko-KR')}원`}
          </p>
        </div>
      </div>

      <p className="mt-2 text-center text-[9px] font-bold text-muted-foreground">
        {rate == null
          ? error || '실시간 환율 확인 중'
          : `적용 환율 1달러 = ${rate.toLocaleString('ko-KR', {
              maximumFractionDigits: 2,
            })}원`}
      </p>
    </section>
  );
}

function stockStatus(entry: AnyObj) {
  if (entry.status === 'TAKE_PROFIT') return '익절';
  if (entry.status === 'STOP_LOSS') return '손절';
  if (entry.status === 'MANUAL_CLOSE') return '수동청산';
  return '보유 중';
}

function JournalRow({ entry, kind }: { entry: AnyObj; kind: 'stock' | 'spot' }) {
  if (kind === 'spot') {
    return (
      <article className="rounded-2xl border border-card-border bg-background p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-black">
              {String(entry.symbol ?? entry.market ?? '코인')}
            </p>
            <p className="mt-1 text-[10px] font-bold text-muted-foreground">
              {entry.createdAt
                ? new Date(entry.createdAt).toLocaleString('ko-KR')
                : '시간 확인 필요'}
            </p>
          </div>
          <span
            className={cn(
              'rounded-full border px-2 py-1 text-[10px] font-black',
              entry.side === 'bid'
                ? 'border-positive/30 bg-positive/10 text-positive'
                : 'border-destructive/30 bg-destructive/10 text-destructive',
            )}
          >
            {entry.sideLabel ?? (entry.side === 'bid' ? '매수' : '매도')}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center">
          <Metric label="평균 체결가" value={formatAppPrice(entry.averagePrice, 'KRW')} />
          <Metric label="체결금액" value={formatAppPrice(entry.executedFunds, 'KRW')} />
          <Metric
            label="체결수량"
            value={
              entry.executedVolume == null
                ? '-'
                : Number(entry.executedVolume).toLocaleString('ko-KR', {
                    maximumFractionDigits: 8,
                  })
            }
          />
          <Metric label="수수료" value={formatAppPrice(entry.paidFee, 'KRW')} />
        </div>
      </article>
    );
  }

  const currency = String(entry.currency ?? 'KRW');
  return (
    <article className="rounded-2xl border border-card-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-black">
            {String(entry.name ?? entry.ticker)} · {String(entry.ticker ?? '')}
          </p>
          <p className="mt-1 text-[10px] font-bold text-muted-foreground">
            {entry.openedAt
              ? new Date(entry.openedAt).toLocaleString('ko-KR')
              : '시간 확인 필요'}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs font-black text-primary">{stockStatus(entry)}</p>
          {entry.profitPercent != null && (
            <p className="mt-1 text-[10px] font-black">
              {Number(entry.profitPercent) > 0 ? '+' : ''}
              {Number(entry.profitPercent).toFixed(2)}%
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Metric label="진입가" value={formatAppPrice(entry.entryPrice, currency)} />
        <Metric label="손절가" value={formatAppPrice(entry.stopPrice, currency)} />
        <Metric label="목표가" value={formatAppPrice(entry.targetPrice, currency)} />
      </div>
      <p className="mt-3 rounded-xl bg-secondary p-2 text-[10px] font-bold leading-4 text-muted-foreground">
        {String(entry.entryAnalysis ?? '진입 분석 기록 없음')}
      </p>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-secondary p-2">
      <p className="text-[9px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 break-all text-[10px] font-black">{value}</p>
    </div>
  );
}

export function AutoTradeJournalModal({
  open,
  onClose,
  entries,
  kind,
  loading,
  error,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  entries: AnyObj[];
  kind: 'stock' | 'spot';
  loading?: boolean;
  error?: boolean;
  onRefresh?: () => void;
}) {
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));

  useEffect(() => {
    if (!open) return;
    setPage(1);
  }, [open]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const rows = useMemo(
    () => entries.slice((page - 1) * pageSize, page * pageSize),
    [entries, page],
  );

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="자동매매 매매일지"
      className="max-h-[88dvh]"
      footer={
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1}
            className="flex h-11 items-center justify-center gap-1 rounded-xl border border-card-border bg-secondary text-xs font-black disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> 이전 10개
          </button>
          <span className="text-[10px] font-black text-muted-foreground">
            {page}/{totalPages}
          </span>
          <button
            type="button"
            onClick={() =>
              setPage((current) => Math.min(totalPages, current + 1))
            }
            disabled={page >= totalPages}
            className="flex h-11 items-center justify-center gap-1 rounded-xl border border-card-border bg-secondary text-xs font-black disabled:opacity-40"
          >
            다음 10개 <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-black">전체 {entries.length}건</p>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-full border border-card-border bg-background px-3 py-1.5 text-[10px] font-black disabled:opacity-50"
          >
            {loading ? '갱신 중' : '새로고침'}
          </button>
        )}
      </div>

      {error ? (
        <p className="mt-3 rounded-2xl bg-destructive/10 p-4 text-center text-xs font-bold text-destructive">
          매매일지를 불러오지 못했습니다.
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-3 rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground">
          아직 기록된 실제 거래가 없습니다.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {rows.map((entry, index) => (
            <JournalRow
              key={String(entry.id ?? entry.uuid ?? `${page}:${index}`)}
              entry={entry}
              kind={kind}
            />
          ))}
        </div>
      )}
    </AppModal>
  );
}
