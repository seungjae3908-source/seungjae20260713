import { Panel, Stat, ReasonList } from '@/components/ui-bits';
import { RatingBadge } from '@/components/rating-badge';
import { ScoreRing } from '@/components/score-ring';
import { LoadingState, ErrorState } from '@/components/data-state';
import { useAnalysis } from '@/hooks/use-stock-data';
import { formatPrice } from '@/lib/format';
import { ratingTone } from '@/lib/labels';
import { ApiError, type Currency } from '@/lib/api';

export function AiTab({ ticker, currency, active }: { ticker: string; currency: Currency; active: boolean }) {
  const { data, isLoading, isError, error, refetch } = useAnalysis(ticker, active);
  if (isLoading) return <LoadingState label="AI 분석 생성 중..." />;
  if (isError || !data)
    return <ErrorState code={error instanceof ApiError ? error.code : undefined} onRetry={() => refetch()} />;

  return (
    <div className="space-y-3">
      <Panel title="AI 투자 의견">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <RatingBadge rating={data.opinion} size="md" />
            <div className="text-xs text-muted-foreground">AI 신뢰도 {data.confidence}%</div>
          </div>
          <ScoreRing score={data.confidence} tone={ratingTone(data.opinion)} label="신뢰도" />
        </div>
        {data.opinionReason && (
          <p className="mt-3 break-keep rounded-xl bg-muted/40 p-3 text-xs leading-relaxed text-foreground/90">
            {data.opinionReason}
          </p>
        )}
      </Panel>

      <Panel title="매매 전략">
        {data.strategy ? (
          <div className="space-y-2.5">
            {[
              { label: '1차 진입', leg: data.strategy.entry1, tone: 'text-foreground' },
              { label: '2차 진입', leg: data.strategy.entry2, tone: 'text-foreground' },
              { label: '목표주가', leg: data.strategy.target, tone: 'text-positive' },
              { label: '손절가', leg: data.strategy.stop, tone: 'text-destructive' },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-card-border bg-card/50 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-bold text-muted-foreground">{item.label}</span>
                  <span className={`font-mono text-base font-semibold ${item.tone}`}>
                    {formatPrice(item.leg.price, currency)}
                  </span>
                </div>
                <p className="mt-1 break-keep text-[11px] leading-relaxed text-muted-foreground">
                  {item.leg.reason}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              실시간 차트 데이터가 부족하여 모델 추정값으로 표시합니다.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">목표주가 (모델 추정)</p>
                <span className="font-mono text-lg font-semibold text-positive">{formatPrice(data.targetPrice, currency)}</span>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">손절가 (모델 추정)</p>
                <span className="font-mono text-lg font-semibold text-destructive">{formatPrice(data.stopLossPrice, currency)}</span>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="매수 근거">
        <ReasonList items={data.buyReasons} tone="positive" />
      </Panel>
      <Panel title="매도 근거">
        <ReasonList items={data.sellReasons} tone="destructive" />
      </Panel>

      <Panel title="기간별 전망">
        <div className="space-y-3">
          <Outlook label="단기" text={data.shortTerm} />
          <Outlook label="중기" text={data.midTerm} />
          <Outlook label="장기" text={data.longTerm} />
        </div>
      </Panel>

      <Panel title="종합 결론">
        <p className="break-keep text-sm leading-relaxed text-foreground/90">{data.conclusion}</p>
      </Panel>
    </div>
  );
}

function Outlook({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 shrink-0 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium">{label}</span>
      <p className="break-keep text-sm leading-relaxed text-foreground/90">{text}</p>
    </div>
  );
}
