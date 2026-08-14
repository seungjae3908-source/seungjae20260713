import {
  capitalBucketLabel,
  capitalEvidenceLabel,
  decisionQualityStatus,
  formatKrw,
  formatPercent,
  orderCapitalHeatmapCells,
  strategyHealthLabel,
  validateDecisionQualityDashboard,
  type DecisionQualityDashboardView,
  type StrategyHealthStatus,
} from '@/lib/decision-quality-view';

function healthTone(status: StrategyHealthStatus): string {
  if (status === 'HEALTHY') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'WATCH') return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (status === 'DEGRADED' || status === 'CRITICAL') return 'border-destructive/30 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

function MetricCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="text-xs font-semibold text-muted-foreground">{label}</div>
      <div className="mt-2 text-xl font-black tracking-tight text-foreground">{value}</div>
      {note ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{note}</div> : null}
    </div>
  );
}

export function DecisionQualityDashboard({ data }: { data: DecisionQualityDashboardView }) {
  const errors = validateDecisionQualityDashboard(data);
  if (errors.length) {
    return (
      <section data-testid="decision-quality-invalid" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4">
        <h2 className="font-black text-destructive">의사결정 품질 데이터를 표시할 수 없습니다.</h2>
        <p className="mt-2 text-sm text-muted-foreground">{errors.join(', ')}</p>
      </section>
    );
  }

  const health = data.health;
  const counter = data.counterfactual;
  const heatmap = data.heatmap;
  const orderedCells = orderCapitalHeatmapCells(heatmap.cells);
  const measured = decisionQualityStatus(counter) === 'MEASURED';

  return (
    <section data-testid="decision-quality-dashboard" className="space-y-5">
      <header className="flex flex-col gap-3 rounded-3xl border border-border bg-card p-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Decision Quality Observatory</p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-foreground">전략 건강도 · 놓친 기회 · 100만원 배분</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            실제 해결된 결과만 집계합니다. 표본이 부족하면 승률이나 의사결정 품질을 임의로 채우지 않습니다.
          </p>
        </div>
        <div className={`w-fit rounded-full border px-3 py-1.5 text-sm font-black ${healthTone(health.status)}`}>
          {strategyHealthLabel(health.status)}
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="전략 표본"
          value={`${health.sampleSize.toLocaleString()} / ${health.minimumSampleSize.toLocaleString()}`}
          note={`정책 ${health.policyVersion}`}
        />
        <MetricCard
          label="의사결정 품질"
          value={measured ? formatPercent(counter.decisionQualityRatePercent) : 'INSUFFICIENT_DATA'}
          note={`판정 가능 ${counter.decisiveSampleSize.toLocaleString()}건`}
        />
        <MetricCard
          label="피한 나쁜 거래"
          value={`${counter.badTradeAvoidedCount.toLocaleString()}건`}
          note={`관측 손실 회피 합계 ${formatPercent(counter.observedLossAvoidedPercentSum)}`}
        />
        <MetricCard
          label="놓친 좋은 거래"
          value={`${counter.goodTradeMissedCount.toLocaleString()}건`}
          note={`관측 상승 놓침 합계 ${formatPercent(counter.observedUpsideMissedPercentSum)}`}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <article className="rounded-3xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-black text-foreground">전략 건강도</h3>
              <p className="mt-1 text-sm text-muted-foreground">{health.strategyId} · {health.strategyVersion}</p>
            </div>
            {health.alertEligible ? (
              <span className="rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs font-bold text-destructive">
                Drift Telegram 대상
              </span>
            ) : null}
          </div>

          <dl className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-muted/50 p-3">
              <dt className="text-xs font-semibold text-muted-foreground">Backtest 대비 최악 Hit-rate gap</dt>
              <dd className="mt-1 font-black text-foreground">{formatPercent(health.worstObservedHitRateGap)}</dd>
            </div>
            <div className="rounded-2xl bg-muted/50 p-3">
              <dt className="text-xs font-semibold text-muted-foreground">알림 조건</dt>
              <dd className="mt-1 font-black text-foreground">{health.alertEligible ? 'DEGRADED / CRITICAL' : '알림 없음'}</dd>
            </div>
          </dl>

          <div className="mt-4">
            <p className="text-xs font-semibold text-muted-foreground">판정 근거</p>
            {health.reasons.length ? (
              <ul className="mt-2 space-y-1 text-sm text-foreground">
                {health.reasons.map((reason) => <li key={reason}>• {reason}</li>)}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">현재 정책상 경고 근거 없음</p>
            )}
          </div>
        </article>

        <article className="rounded-3xl border border-border bg-card p-5" data-testid="capital-allocation-heatmap">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-lg font-black text-foreground">100만원 자본 배분 Heatmap</h3>
              <p className="mt-1 text-sm text-muted-foreground">현금도 하나의 정식 선택지로 표시합니다.</p>
            </div>
            <div className="text-sm font-bold text-foreground">총 {formatKrw(heatmap.initialCapitalKrw)}</div>
          </div>

          <div className="mt-5 space-y-4">
            {orderedCells.map((cell) => (
              <div key={cell.bucket} className="space-y-2" data-testid={`heatmap-${cell.bucket.toLowerCase()}`}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <span className="font-black text-foreground">{capitalBucketLabel(cell.bucket)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{capitalEvidenceLabel(cell.evidenceStatus)}</span>
                  </div>
                  <div className="shrink-0 text-right font-bold text-foreground">
                    {formatKrw(cell.allocationKrw)} · {cell.allocationPercent.toFixed(1)}%
                  </div>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-muted" aria-label={`${capitalBucketLabel(cell.bucket)} ${cell.allocationPercent.toFixed(1)}%`}>
                  <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.min(100, Math.max(0, cell.allocationPercent))}%` }} />
                </div>
                {cell.warnings.length ? <p className="text-xs text-muted-foreground">{cell.warnings.join(' · ')}</p> : null}
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-muted px-2.5 py-1 font-semibold text-muted-foreground">Evidence: {heatmap.evidenceStatus}</span>
            <span className={`rounded-full px-2.5 py-1 font-semibold ${heatmap.invariantPassed ? 'bg-muted text-muted-foreground' : 'bg-destructive/10 text-destructive'}`}>
              100만원 합계 {heatmap.invariantPassed ? '일치' : '불일치'}
            </span>
          </div>
        </article>
      </div>

      <article className="rounded-3xl border border-border bg-card p-5">
        <h3 className="text-lg font-black text-foreground">거래 의사결정 결과</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <MetricCard label="좋은 거래 실행" value={`${counter.goodTradeTakenCount}건`} />
          <MetricCard label="나쁜 거래 실행" value={`${counter.badTradeTakenCount}건`} />
          <MetricCard label="나쁜 거래 회피" value={`${counter.badTradeAvoidedCount}건`} />
          <MetricCard label="좋은 거래 놓침" value={`${counter.goodTradeMissedCount}건`} />
          <MetricCard label="미해결/중립" value={`${counter.neutralOrUnresolvedCount}건`} />
        </div>
      </article>
    </section>
  );
}

export default DecisionQualityDashboard;
