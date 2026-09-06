import { Panel, ReasonList } from '@/components/ui-bits';
import { RatingBadge } from '@/components/rating-badge';
import { ScoreRing } from '@/components/score-ring';
import { LoadingState, ErrorState } from '@/components/data-state';
import { useAnalysis } from '@/hooks/use-stock-data';
import { formatPrice } from '@/lib/format';
import { ratingTone } from '@/lib/labels';
import { ApiError, type Currency } from '@/lib/api';

const ANALYSIS_RATINGS = new Set([
  'STRONG_BUY',
  'BUY',
  'HOLD',
  'SELL',
  'STRONG_SELL',
]);

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validReasonList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => validText(item));
}

function validAnalysisPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  const confidence = record.confidence;

  return (
    typeof record.opinion === 'string' &&
    ANALYSIS_RATINGS.has(record.opinion) &&
    validText(record.opinionReason) &&
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 100 &&
    validReasonList(record.buyReasons) &&
    validReasonList(record.sellReasons) &&
    validText(record.shortTerm) &&
    validText(record.midTerm) &&
    validText(record.longTerm) &&
    validText(record.conclusion)
  );
}

function validStrategyLeg(leg: { price: number; reason: string } | null | undefined): boolean {
  return Boolean(
    leg &&
      Number.isFinite(leg.price) &&
      leg.price > 0 &&
      validText(leg.reason),
  );
}

export function AiTab({ ticker, currency, active }: { ticker: string; currency: Currency; active: boolean }) {
  const { data, isLoading, isError, error, refetch } = useAnalysis(ticker, active);
  if (isLoading) return <LoadingState label="AI 분석 생성 중..." />;
  if (isError || !data)
    return <ErrorState code={error instanceof ApiError ? error.code : undefined} onRetry={() => refetch()} />;
  if (!validAnalysisPayload(data))
    return <ErrorState code="AI_ANALYSIS_CONTRACT_INVALID" onRetry={() => refetch()} />;

  const strategy = data.strategy;
  const strategyHasEvidence = Boolean(
    strategy &&
      validStrategyLeg(strategy.entry1) &&
      validStrategyLeg(strategy.entry2) &&
      validStrategyLeg(strategy.target) &&
      validStrategyLeg(strategy.stop),
  );

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
        <p className="mt-2 text-[10px] font-bold leading-4 text-muted-foreground">
          AI 신뢰도는 모델의 확신 표현이며 실제 적중확률·수익확률이 아닙니다.
        </p>
        <p className="mt-3 break-keep rounded-xl bg-muted/40 p-3 text-xs leading-relaxed text-foreground/90">
          {data.opinionReason}
        </p>
      </Panel>

      <Panel title="매매 전략">
        {strategyHasEvidence && strategy ? (
          <div className="space-y-2.5">
            {[
              { label: '1차 진입', leg: strategy.entry1, tone: 'text-foreground' },
              { label: '2차 진입', leg: strategy.entry2, tone: 'text-foreground' },
              { label: '목표주가', leg: strategy.target, tone: 'text-positive' },
              { label: '손절가', leg: strategy.stop, tone: 'text-destructive' },
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
          <div data-testid="ai-strategy-missing-evidence" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-xs font-black">목표가·손절가 근거 미수집</p>
            <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">
              유효한 가격과 근거가 함께 확인되지 않아 목표가·손절가 숫자를 표시하지 않습니다. 없는 숫자를 현재가 기준 임의 퍼센트로 만들지 않습니다.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="매수 근거">
        <ReasonList items={data.buyReasons} tone="positive" />
      </Panel>
      <Panel title="반대 근거 / 매도 근거">
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
