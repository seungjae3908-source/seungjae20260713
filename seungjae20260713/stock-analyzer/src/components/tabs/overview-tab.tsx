import { Panel, Stat, ReasonList } from '@/components/ui-bits';
import { RatingBadge } from '@/components/rating-badge';
import { ScoreRing } from '@/components/score-ring';
import { formatPrice, formatPercent, formatCompact, formatVolume } from '@/lib/format';
import { changeTone, ratingTone, riskTone, RISK_KO, toneBadge, toneText } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { Overview } from '@/lib/api';

export function OverviewTab({ data }: { data: Overview }) {
  const { profile, quote, rating, buyReasons, riskFactors, summary } = data;
  const currency = profile.currency;
  const ctone = changeTone(quote.changePercent);

  // #2a: 시가총액은 항상 렌더링한다. 값이 없거나 0·비정상이면 "시총 확인 필요".
  const marketCapValue =
    typeof quote.marketCap === 'number' &&
    Number.isFinite(quote.marketCap) &&
    quote.marketCap > 0
      ? formatCompact(quote.marketCap, currency)
      : '시총 확인 필요';

  return (
    <div className="space-y-3">
      {/* B. Company description */}
      <Panel title="기업 개요">
        <p className="break-keep text-sm leading-relaxed text-foreground/90">{profile.description}</p>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Stat label="업종" value={profile.industry} />
          <Stat label="섹터" value={profile.sector} />
          <Stat label="국가" value={profile.country} />
        </div>
        <div className="mt-4">
          <span className="text-xs text-muted-foreground">주요 사업</span>
          <p className="mt-0.5 break-keep text-sm leading-relaxed">{profile.mainBusiness}</p>
        </div>
        <div className="mt-4">
          <span className="text-xs text-muted-foreground">경쟁사</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {profile.competitors.map((c) => (
              <span key={c} className="rounded-md border border-border bg-secondary px-2 py-0.5 text-xs">
                {c}
              </span>
            ))}
          </div>
        </div>
      </Panel>

      {/* C. Current market information */}
      <Panel title="시세 정보">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="현재가" value={formatPrice(quote.price, currency)} />
          <Stat label="등락률" value={formatPercent(quote.changePercent)} tone={ctone} />
          <Stat label="거래량" value={formatVolume(quote.volume)} />
          <Stat label="시가총액" value={marketCapValue} />
          <Stat label="52주 최고" value={formatPrice(quote.week52High, currency)} />
          <Stat label="52주 최저" value={formatPrice(quote.week52Low, currency)} />
        </div>
      </Panel>

      {/* D. Investment rating */}
      <Panel title="투자 등급">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <RatingBadge rating={rating.rating} size="md" />
            <div className="text-xs text-muted-foreground">
              신뢰도 <span className={cn('font-semibold', toneText(ratingTone(rating.rating)))}>{rating.confidence}%</span>
            </div>
          </div>
          <ScoreRing score={rating.score} tone={ratingTone(rating.rating)} label="종합점수" />
        </div>
      </Panel>

      {/* E. Buy reasons */}
      <Panel title="매수 근거 TOP 3">
        <ReasonList items={buyReasons} tone="positive" />
      </Panel>

      {/* F. Risk factors */}
      <Panel title="리스크 요인 TOP 3">
        <ul className="space-y-3">
          {riskFactors.map((r) => (
            <li key={r.label} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="break-keep text-sm font-medium leading-relaxed">{r.label}</div>
                <div className="mt-0.5 break-keep text-xs leading-relaxed text-muted-foreground">{r.detail}</div>
              </div>
              <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium', toneBadge(riskTone(r.level)))}>
                {RISK_KO[r.level]}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      {/* G. One-line summary */}
      <Panel title="한 줄 요약">
        <p className="break-keep text-sm leading-relaxed text-foreground/90">{summary}</p>
      </Panel>
    </div>
  );
}
