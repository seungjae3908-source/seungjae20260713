import { useState } from 'react';
import { Gauge, ShieldAlert, Target, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;
type Asset = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';

type Explanation = {
  title: string;
  value: string;
  summary: string;
  reasons: string[];
  caution: string;
};

function formatPrice(value: unknown, asset: Asset): string {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) return '계산 중';
  if (asset === 'stockUS') {
    return `$${price.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (asset === 'coinSpot' || asset === 'coinFutures') {
    return price.toLocaleString(undefined, {
      maximumFractionDigits: price >= 100 ? 0 : 4,
    });
  }
  return `${Math.round(price).toLocaleString()}원`;
}

function percentFrom(base: unknown, target: unknown): string {
  const baseValue = Number(base);
  const targetValue = Number(target);
  if (
    !Number.isFinite(baseValue) ||
    !Number.isFinite(targetValue) ||
    baseValue <= 0 ||
    targetValue <= 0
  ) {
    return '계산 중';
  }
  const value = ((targetValue - baseValue) / baseValue) * 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function ExplanationModal({
  explanation,
  onClose,
}: {
  explanation: Explanation;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[125] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <section
        className="relative max-h-[86vh] w-full max-w-md overflow-y-auto rounded-3xl border border-card-border bg-background p-5 text-center shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
        >
          <X className="h-4 w-4" />
        </button>
        <p className="text-[10px] font-black text-primary">산출 근거</p>
        <h3 className="mt-1 text-lg font-black">{explanation.title}</h3>
        <p className="mt-2 text-xl font-black">{explanation.value}</p>
        <p className="mt-4 rounded-2xl bg-secondary px-4 py-3 text-xs font-bold leading-5">
          {explanation.summary}
        </p>
        <div className="mt-4 space-y-2 text-left">
          {explanation.reasons.slice(0, 8).map((reason, index) => (
            <div
              key={`${index}:${reason}`}
              className="rounded-2xl border border-card-border bg-card px-3 py-2.5 text-[11px] font-bold leading-5"
            >
              {index + 1}. {reason}
            </div>
          ))}
        </div>
        <div className="mt-4 flex gap-2 rounded-2xl border border-warning/40 bg-warning/10 p-3 text-left text-[10px] font-bold leading-4 text-warning">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{explanation.caution}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-5 h-11 w-full rounded-2xl bg-primary text-sm font-black text-primary-foreground"
        >
          닫기
        </button>
      </section>
    </div>
  );
}

function StrategyCell({
  label,
  value,
  currentPrice,
  asset,
  tone,
  onClick,
}: {
  label: string;
  value: unknown;
  currentPrice: unknown;
  asset: Asset;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} 산출 근거 보기`}
      className="w-full rounded-2xl border border-card-border bg-background px-3 py-3 text-center transition active:scale-[0.98]"
    >
      <span className="block text-[10px] font-black text-muted-foreground">{label}</span>
      <span className={cn('mt-1 block text-sm font-black', tone)}>
        {formatPrice(value, asset)}
      </span>
      <span className="mt-1 block text-[9px] font-bold text-muted-foreground">
        현재가 대비 {percentFrom(currentPrice, value)}
      </span>
    </button>
  );
}

export function ChartRelayStrategyPanel({
  plan,
  asset,
  settings,
}: {
  plan: AnyObj | null;
  asset: Asset;
  settings: AnyObj;
}) {
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const currentPrice = plan?.currentPrice ?? null;
  const basis = Array.isArray(plan?.basis) ? plan.basis.map(String) : [];
  const invalidation = Array.isArray(plan?.invalidation)
    ? plan.invalidation.map(String)
    : [];
  const risks = Array.isArray(plan?.risks) ? plan.risks.map(String) : [];

  const openExplanation = (
    title: string,
    value: unknown,
    summary: string,
    caution: string,
    reasons = basis,
  ) => {
    setExplanation({
      title,
      value: formatPrice(value, asset),
      summary,
      reasons,
      caution,
    });
  };

  const buyRows = [0, 1, 2].filter(
    (index) =>
      settings.buyLevels !== false &&
      settings[`buyLevel${index + 1}`] !== false,
  );
  const sellRows = [0, 1, 2].filter(
    (index) =>
      settings.sellLevels !== false &&
      settings[`sellLevel${index + 1}`] !== false,
  );

  return (
    <>
      <section className="mt-3 rounded-3xl border border-card-border bg-card p-4">
        <div className="text-center">
          <Target className="mx-auto h-5 w-5 text-primary" />
          <h2 className="mt-2 text-base font-black">상세 전략</h2>
          <p className="mt-1 text-[10px] font-bold text-muted-foreground">
            매수가·매도가·목표가·손절가를 실시간 차트 가격으로 계산합니다.
          </p>
        </div>

        {!plan ? (
          <div className="mt-4 rounded-2xl bg-secondary px-3 py-5 text-center text-[11px] font-bold text-muted-foreground">
            차트 데이터를 확인한 뒤 가격을 계산하고 있습니다.
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-2xl border border-card-border bg-background p-3 text-center">
              <Gauge className="mx-auto h-4 w-4 text-primary" />
              <p className="mt-2 text-[10px] font-black text-muted-foreground">현재가</p>
              <p className="mt-1 text-base font-black">{formatPrice(currentPrice, asset)}</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-secondary p-2">
                  <p className="text-[9px] font-black text-muted-foreground">현재 판단</p>
                  <p className="mt-1 text-xs font-black">{String(plan.view ?? '중립')}</p>
                </div>
                <div className="rounded-xl bg-secondary p-2">
                  <p className="text-[9px] font-black text-muted-foreground">산출 방식</p>
                  <p className="mt-1 text-[10px] font-black">
                    {plan.calculationSource === 'server'
                      ? '서버 AI + 차트 보완'
                      : '실시간 차트 계산'}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <div className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs font-black text-red-500">
                  매수가
                </div>
                {buyRows.map((index) => (
                  <StrategyCell
                    key={`buy-${index}`}
                    label={`${index + 1}차`}
                    value={plan.buyLevels?.[index]}
                    currentPrice={currentPrice}
                    asset={asset}
                    tone="text-red-500"
                    onClick={() =>
                      openExplanation(
                        `${index + 1}차 분할매수`,
                        plan.buyLevels?.[index],
                        '한 가격에 전부 진입하지 않고 지지 구간과 변동폭을 기준으로 나눈 매수 가격입니다.',
                        '손절 기준이 무너지면 다음 단계 매수는 중단해야 합니다.',
                      )
                    }
                  />
                ))}
                {settings.target !== false && (
                  <StrategyCell
                    label="목표가"
                    value={plan.target}
                    currentPrice={currentPrice}
                    asset={asset}
                    tone="text-orange-500"
                    onClick={() =>
                      openExplanation(
                        '목표가',
                        plan.target,
                        '현재 추세가 유지될 때 우선 확인하는 예상 도달 가격입니다.',
                        '목표가는 확정 수익 가격이 아니며 추세가 바뀌면 다시 계산됩니다.',
                      )
                    }
                  />
                )}
              </div>

              <div className="space-y-2">
                <div className="rounded-2xl bg-blue-500/10 px-3 py-2 text-center text-xs font-black text-blue-500">
                  매도가
                </div>
                {sellRows.map((index) => (
                  <StrategyCell
                    key={`sell-${index}`}
                    label={`${index + 1}차`}
                    value={plan.sellLevels?.[index]}
                    currentPrice={currentPrice}
                    asset={asset}
                    tone="text-blue-500"
                    onClick={() =>
                      openExplanation(
                        `${index + 1}차 분할매도`,
                        plan.sellLevels?.[index],
                        '저항 구간과 변동폭을 기준으로 수익 실현을 나눈 매도 가격입니다.',
                        '분할매도 가격은 고정된 최고점 예측이 아닙니다.',
                      )
                    }
                  />
                ))}
                {settings.stop !== false && (
                  <StrategyCell
                    label="손절가"
                    value={plan.stop}
                    currentPrice={currentPrice}
                    asset={asset}
                    tone="text-cyan-500"
                    onClick={() =>
                      openExplanation(
                        '손절가',
                        plan.stop,
                        '현재 분석 시나리오가 무효화됐다고 판단하는 위험관리 가격입니다.',
                        '급격한 변동이나 갭에서는 실제 체결 가격이 달라질 수 있습니다.',
                        [...invalidation, ...risks, ...basis],
                      )
                    }
                  />
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {explanation && (
        <ExplanationModal
          explanation={explanation}
          onClose={() => setExplanation(null)}
        />
      )}
    </>
  );
}
