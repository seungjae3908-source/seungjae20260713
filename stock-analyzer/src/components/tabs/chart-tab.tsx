import { useState } from 'react';
import { CanonicalMarketChart } from '@/components/canonical-market-chart';
import { Panel } from '@/components/ui-bits';
import { SignalModal } from '@/components/signal-modal';
import type { AiSignal } from '@/lib/api';
import { cn } from '@/lib/utils';

const SIGNAL_TONE_CLS = {
  positive: 'border-positive/30 bg-positive/10 text-positive',
  negative: 'border-destructive/30 bg-destructive/10 text-destructive',
  neutral: 'border-warning/30 bg-warning/10 text-warning',
} as const;

export function ChartTab({
  ticker,
  active,
  signals,
}: {
  ticker: string;
  active: boolean;
  signals?: AiSignal[];
}) {
  const [openSignal, setOpenSignal] = useState<AiSignal | null>(null);
  const detected = (signals ?? []).filter((signal) => signal.active);
  const market = /^\d{6}$/.test(ticker.trim()) ? 'KR' : 'US';

  return (
    <div className="min-w-0 space-y-3" data-testid="stock-detail-canonical-chart-tab">
      <Panel title="신호 감지">
        {detected.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {detected.map((signal) => (
              <button
                key={signal.key}
                type="button"
                onClick={() => setOpenSignal(signal)}
                className={cn(
                  'min-h-11 max-w-full break-words rounded-xl border px-3 py-2 text-left text-xs font-medium leading-relaxed transition-colors',
                  SIGNAL_TONE_CLS[signal.tone],
                )}
              >
                <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-ai/15 text-[9px] font-bold text-ai">
                  AI
                </span>
                {signal.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="break-keep text-xs leading-relaxed text-muted-foreground">
            감지된 신호 없음 · 데이터 부족
          </p>
        )}
      </Panel>

      {active ? (
        <CanonicalMarketChart
          assetType="stock"
          market={market}
          symbol={ticker}
          displayName={ticker}
          timeframe="1D"
        />
      ) : null}

      <Panel title="차트 표준">
        <p className="break-keep text-xs leading-5 text-muted-foreground">
          이 화면은 앱의 AI Chart 2.0과 동일한 시장·시간봉·지표·패턴 분석 엔진을 사용합니다.
          별도의 PriceChart, RSI, MACD 차트를 따로 유지하지 않습니다.
        </p>
      </Panel>

      {openSignal && (
        <SignalModal signal={openSignal} onClose={() => setOpenSignal(null)} />
      )}
    </div>
  );
}
