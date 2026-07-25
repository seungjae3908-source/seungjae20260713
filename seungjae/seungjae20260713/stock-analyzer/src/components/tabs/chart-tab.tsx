import { useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';
import {
  PriceChart,
  RsiChart,
  MacdChart,
  MA_CONFIG,
  type MaPeriod,
} from '@/components/charts';
import { RatingBadge } from '@/components/rating-badge';
import { Panel } from '@/components/ui-bits';
import { LoadingState, ErrorState } from '@/components/data-state';
import { SignalModal } from '@/components/signal-modal';
import { useChart } from '@/hooks/use-stock-data';
import { ApiError, type AiSignal, type Timeframe } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CHART_TIMEFRAMES, loadVisibleChartTimeframes, saveVisibleChartTimeframes } from '@/lib/chart-preferences';

const SIGNAL_TONE_CLS = {
  positive: 'border-positive/30 bg-positive/10 text-positive',
  negative: 'border-destructive/30 bg-destructive/10 text-destructive',
  neutral: 'border-warning/30 bg-warning/10 text-warning',
} as const;

const TIMEFRAMES: { tf: Timeframe; label: string }[] = CHART_TIMEFRAMES.map((item) => ({ tf: item.key, label: item.label }));

function loadVisible(): Timeframe[] {
  return loadVisibleChartTimeframes();
}

function saveVisible(frames: Timeframe[]) {
  saveVisibleChartTimeframes(frames.filter((frame) => CHART_TIMEFRAMES.some((item) => item.key === frame)) as Array<(typeof CHART_TIMEFRAMES)[number]['key']>);
}

const MA_KEY = 'sa-chart-ma-v1';

const DEFAULT_MAS: MaPeriod[] = [5, 20, 60, 120];

function loadMas(): MaPeriod[] {
  if (typeof window === 'undefined') return DEFAULT_MAS;

  try {
    const raw = window.localStorage.getItem(MA_KEY);
    if (!raw) return DEFAULT_MAS;

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_MAS;

    const valid = parsed.filter((item): item is MaPeriod =>
      MA_CONFIG.some((m) => m.period === item),
    );

    return valid;
  } catch {
    return DEFAULT_MAS;
  }
}

function saveMas(mas: MaPeriod[]) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(MA_KEY, JSON.stringify(mas));
  } catch {
    // ignore
  }
}

export function ChartTab({
  ticker,
  active,
  signals,
}: {
  ticker: string;
  active: boolean;
  signals?: AiSignal[];
}) {
  const [visible, setVisible] = useState<Timeframe[]>(() => loadVisible());
  const [tf, setTf] = useState<Timeframe>(() => loadVisible()[0] ?? '1D');
  const [menuOpen, setMenuOpen] = useState(false);
  const [visibleMas, setVisibleMas] = useState<MaPeriod[]>(() => loadMas());
  const [openSignal, setOpenSignal] = useState<AiSignal | null>(null);
  const { data, isLoading, isError, error, refetch } = useChart(ticker, tf, active);

  // #2b: 실제 감지된(active) 신호만 노출한다. 절대 조작하지 않는다.
  const detected = (signals ?? []).filter((sig) => sig.active);

  const toggleMa = (period: MaPeriod) => {
    setVisibleMas((prev) => {
      const has = prev.includes(period);
      const next = has ? prev.filter((item) => item !== period) : [...prev, period];

      const ordered = MA_CONFIG.filter((m) => next.includes(m.period)).map(
        (m) => m.period,
      );

      saveMas(ordered);

      return ordered;
    });
  };

  useEffect(() => {
    if (!visible.includes(tf) && visible.length) {
      setTf(visible[0]);
    }
  }, [visible, tf]);

  const toggleFrame = (frame: Timeframe) => {
    setVisible((prev) => {
      const has = prev.includes(frame);
      const next = has ? prev.filter((item) => item !== frame) : [...prev, frame];

      const ordered = TIMEFRAMES.filter((item) => next.includes(item.tf)).map(
        (item) => item.tf,
      );

      const final = ordered.length ? ordered : [frame];

      saveVisible(final);

      return final;
    });
  };

  const shown = TIMEFRAMES.filter((item) => visible.includes(item.tf));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {shown.length ? (
          <div className="no-scrollbar flex flex-1 gap-1.5 overflow-x-auto">
            {shown.map(({ tf: t, label }) => (
              <button
                key={t}
                onClick={() => setTf(t)}
                className={cn(
                  'shrink-0 rounded-lg px-3 py-1 text-xs font-medium transition-colors',
                  tf === t
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <p className="flex-1 text-xs text-muted-foreground">
            설정에서 표시할 봉 종류를 선택해 주세요.
          </p>
        )}

        <div className="relative shrink-0">
          <button
            type="button"
            aria-label="봉 종류 설정"
            onClick={() => setMenuOpen((open) => !open)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg border',
              menuOpen
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-secondary text-muted-foreground',
            )}
          >
            <Settings2 className="h-4 w-4" />
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-9 z-40 w-40 rounded-2xl border border-card-border bg-card p-2 shadow-lg">
                <p className="px-2 py-1 text-[11px] font-bold text-muted-foreground">
                  표시할 봉 선택
                </p>
                <div className="max-h-64 overflow-y-auto">
                  {TIMEFRAMES.map((item) => (
                    <label
                      key={item.tf}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-secondary/70"
                    >
                      <input
                        type="checkbox"
                        checked={visible.includes(item.tf)}
                        onChange={() => toggleFrame(item.tf)}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      {item.label}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <Panel title="신호 감지">
        {detected.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {detected.map((sig) => (
              <button
                key={sig.key}
                type="button"
                onClick={() => setOpenSignal(sig)}
                className={cn(
                  'flex items-center gap-1.5 break-keep rounded-lg border px-2.5 py-1 text-xs font-medium leading-relaxed transition-colors',
                  SIGNAL_TONE_CLS[sig.tone],
                )}
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-ai/15 text-[9px] font-bold text-ai">
                  AI
                </span>
                {sig.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="break-keep text-xs leading-relaxed text-muted-foreground">
            감지된 신호 없음 · 데이터 부족
          </p>
        )}
      </Panel>

      {isLoading && <LoadingState />}
      {isError && (
        <ErrorState
          code={error instanceof ApiError ? error.code : undefined}
          onRetry={() => refetch()}
        />
      )}

      {data && (
        <>
          <Panel
            title="가격 · 거래량"
            right={
              <RatingBadge
                rating={data.rating.rating}
                confidence={data.rating.confidence}
              />
            }
          >
            <PriceChart candles={data.candles} visibleMas={visibleMas} />
            <div className="mt-3 flex flex-wrap gap-1.5">
              {MA_CONFIG.map((m) => {
                const on = visibleMas.includes(m.period);
                return (
                  <button
                    key={m.period}
                    type="button"
                    onClick={() => toggleMa(m.period)}
                    aria-pressed={on}
                    className={cn(
                      'flex items-center gap-1.5 break-keep rounded-lg border px-2.5 py-1 text-[11px] font-medium leading-relaxed transition-colors',
                      on
                        ? 'border-border bg-secondary text-foreground'
                        : 'border-border/60 bg-transparent text-muted-foreground/60',
                    )}
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: on ? m.color : 'currentColor' }}
                    />
                    {m.label} 이동평균
                  </button>
                );
              })}
            </div>
            <p className="mt-2 break-keep text-[11px] leading-relaxed text-muted-foreground">
              이동평균선은 실제 체결 캔들의 종가로 계산합니다. 봉 수가 기간보다
              적으면 해당 이동평균선은 더 짧게 표시됩니다.
            </p>
          </Panel>

          <Panel title="RSI (14)">
            <RsiChart candles={data.candles} rsi={data.indicators.rsi} />
          </Panel>

          <Panel title="MACD (12, 26, 9)">
            <MacdChart candles={data.candles} macd={data.indicators.macd} />
          </Panel>
        </>
      )}

      {openSignal && (
        <SignalModal signal={openSignal} onClose={() => setOpenSignal(null)} />
      )}
    </div>
  );
}

