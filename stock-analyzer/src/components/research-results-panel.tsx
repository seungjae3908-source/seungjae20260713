import { memo, useMemo } from 'react';
import type {
  CombinationLaneSummary,
  ExploratoryRuleSummary,
  ResearchResultHeader,
  ResearchResultsReadback,
} from '@/lib/research-center';

const LANE_NAMES: Record<string, string> = {
  KR_STOCK_LONG: '국내주식 매수',
  US_STOCK_LONG: '미국주식 매수',
  CRYPTO_SPOT_LONG: '코인현물 매수',
  CRYPTO_FUTURES_LONG: '코인선물 롱',
  CRYPTO_FUTURES_SHORT: '코인선물 숏',
};
const TRIAL_STATUS: Record<string, string> = { SURVIVOR: '합격', WATCH: '관찰', REJECT: '탈락' };
const LANE_STATUS: Record<string, string> = {
  SEARCHING: '탐색 중',
  WAITING_FOR_DATA: '데이터 대기',
  COMPLETE: '완료',
  PENDING_NEXT_TICK: '다음 계산 대기',
};
const EXIT_NAMES: Record<string, string> = {
  X1: '손절 ATR×1.5 · 목표 2배',
  X2: '손절 ATR×2.5 · 목표 1.5배',
  X3: '추적 손절 · 목표 없음',
  X4: '절반 익절 후 추적',
};
const ENTRY_KO: Record<string, string> = { SINGLE: '한 번에 진입', PYRAMID: '위로 추가매수' };
const EXIT_VARIANT_KO: Record<string, string> = {
  FIXED_FULL: '고정 전량', FIXED_SCALED: '고정 분할', TRAIL_FULL: '추적 전량', TRAIL_SCALED: '추적 분할',
};
const LIFECYCLE: Record<string, string> = { ACTIVE: '관찰 중', DEMOTED: '강등', RETIRED: '종료' };

function laneName(id: string | null) {
  return id ? LANE_NAMES[id] ?? id : '알 수 없음';
}

function count(value: number | null) {
  return value == null ? '—' : value.toLocaleString('ko-KR');
}

/** Combination returns are fractions per trade (0.0069 → +0.69%). */
function percent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '—';
  const scaled = value * 100;
  return `${scaled >= 0 ? '+' : ''}${scaled.toFixed(2)}%`;
}

function rMultiple(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;
}

function variantLabel(id: string | null) {
  if (!id) return '—';
  const [entry, exit] = id.split('+');
  return `${ENTRY_KO[entry] ?? entry} + ${EXIT_VARIANT_KO[exit] ?? exit ?? ''}`;
}

function observedLabel(header: ResearchResultHeader) {
  if (header.status === 'INVALID') return '결과 파일 오류';
  if (!header.present) return '아직 결과 없음';
  if (!header.observedAt) return '시각 미상';
  const date = new Date(header.observedAt);
  if (!Number.isFinite(date.getTime())) return '시각 미상';
  return `${date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 기준`;
}

const CombinationLane = memo(function CombinationLane({ lane }: { lane: CombinationLaneSummary }) {
  const waiting = lane.status === 'WAITING_FOR_DATA';
  return (
    <article className="rounded-xl border border-card-border bg-background p-3" data-testid="research-combination-lane">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-bold">{laneName(lane.laneId)}</h4>
        <span className="text-xs text-muted-foreground">{LANE_STATUS[lane.status] ?? '확인 필요'}</span>
      </div>
      {waiting ? (
        <p className="mt-2 text-xs text-muted-foreground">과거 데이터를 내려받는 중이라 다음 계산에서 탐색합니다.</p>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">
            <div><dt className="text-muted-foreground">누적 시험</dt><dd className="font-semibold tabular-nums">{count(lane.cumulativeTrials)}</dd></div>
            <div><dt className="text-muted-foreground">합격</dt><dd className="font-semibold tabular-nums">{count(lane.survivors)}</dd></div>
            <div><dt className="text-muted-foreground">관찰</dt><dd className="font-semibold tabular-nums">{count(lane.watch)}</dd></div>
            <div><dt className="text-muted-foreground">탈락</dt><dd className="font-semibold tabular-nums">{count(lane.rejected)}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">
            2026 최종 검증 사용 {count(lane.holdoutUsed)} / {count(lane.holdoutBudget)}회 · 최종 검증 통과 {lane.paperCandidates.length}개
          </p>
          {lane.top.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {lane.top.map((row, index) => (
                <li key={row.trialId ?? index} className="rounded-lg bg-card p-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-semibold">{row.labels.join(' + ') || '조건 이름 없음'}</span>
                    <span className={row.finalStatus === 'SURVIVOR' ? 'font-bold text-emerald-600' : 'text-muted-foreground'}>
                      {TRIAL_STATUS[row.finalStatus ?? ''] ?? '확인 필요'}
                      {row.holdoutChecked ? (row.holdoutPass ? ' · 최종 검증 통과' : ' · 최종 검증 탈락') : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    청산 {EXIT_NAMES[row.exitId ?? ''] ?? row.exitId ?? '—'} · 검증 {count(row.validationTrades)}회 · 거래당 {percent(row.validationMeanReturn)} · 승률 {row.validationWinRate == null ? '—' : `${Math.round(row.validationWinRate * 100)}%`}
                    {row.beatsBaseline ? ' · 기준선보다 좋음' : ''}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </article>
  );
});

const ExploratoryRule = memo(function ExploratoryRule({ rule }: { rule: ExploratoryRuleSummary }) {
  return (
    <li className="rounded-lg bg-background p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="font-semibold">{laneName(rule.laneId)} · {rule.labels.join(' + ') || '조건 이름 없음'}</span>
        <span className={rule.promotionEligible ? 'font-bold text-emerald-600' : 'text-muted-foreground'}>
          {rule.promotionEligible ? '승격 기준 충족 · 사람 검토 필요' : LIFECYCLE[rule.lifecycle ?? ''] ?? '확인 필요'}
        </span>
      </div>
      <p className="mt-1 text-muted-foreground">
        엄격 표본 {count(rule.strictTrades)}건 · 평균 {rMultiple(rule.strictMeanR)} · 95% 하한 {rMultiple(rule.strictLower95)} · 보유 중 {count(rule.open)}건
        {!rule.promotionEligible && rule.tradesNeeded != null ? ` · 승격까지 ${count(rule.tradesNeeded)}건 더 필요` : ''}
      </p>
    </li>
  );
});

export const ResearchResultsPanel = memo(function ResearchResultsPanel({ results }: { results?: ResearchResultsReadback | null }) {
  const lanes = useMemo(() => {
    const rows = results?.combination.lanes ?? [];
    // Lanes with survivors first so the user sees what passed.
    return [...rows].sort((a, b) => (b.survivors ?? 0) - (a.survivors ?? 0));
  }, [results?.combination.lanes]);
  const exitWinners = useMemo(
    () => (results?.exitComparison.lanes ?? []).flatMap((lane) => lane.winners.map((winner) => ({ lane: lane.laneId, ...winner }))),
    [results?.exitComparison.lanes],
  );
  if (!results) {
    return (
      <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="research-results-panel">
        <h3 className="text-base font-black">연구 결과</h3>
        <p className="mt-2 text-xs text-muted-foreground">연구 서버가 아직 결과를 보내지 않았습니다. 연구 화면 서버를 최신 버전으로 반영하면 표시됩니다.</p>
      </section>
    );
  }
  const totals = results.exploratory.totals;
  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card p-4" data-testid="research-results-panel" aria-labelledby="research-results-title">
      <div>
        <h3 id="research-results-title" className="text-base font-black">연구 결과</h3>
        <p className="mt-1 text-xs text-muted-foreground">탐색용 결과입니다. 실주문 근거가 아니며, 자동매매는 S급 신호와 별도 관문만 사용합니다.</p>
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-bold">조합 탐색</h4>
          <span className="text-xs text-muted-foreground">{observedLabel(results.combination)}</span>
        </div>
        {lanes.length > 0 ? (
          <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
            {lanes.map((lane) => <CombinationLane key={lane.laneId} lane={lane} />)}
          </div>
        ) : <p className="mt-2 text-xs text-muted-foreground">표시할 시장 결과가 없습니다.</p>}
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-bold">청산 방식 비교</h4>
          <span className="text-xs text-muted-foreground">{observedLabel(results.exitComparison)}</span>
        </div>
        {exitWinners.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs">
            {exitWinners.map((row) => (
              <li key={`${row.lane}:${row.signalSetId}`} className="rounded-lg bg-background p-2">
                {laneName(row.lane)} · {row.label ?? '진입 신호'} → <span className="font-semibold">{variantLabel(row.variantId)}</span> (검증 평균 {rMultiple(row.validationMeanR)})
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {results.exitComparison.present ? '아직 채택 기준을 넘은 청산 방식이 없습니다.' : '아직 결과가 없습니다.'}
          </p>
        )}
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-bold">탐색용 모의 장부</h4>
          <span className="text-xs text-muted-foreground">{observedLabel(results.exploratory)}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          거래 {count(totals.trades)}건 (종료 {count(totals.closed)} · 보유 {count(totals.open)}) · 승격 기준 충족 {count(totals.promotionEligibleRules)}개 · 강등 {count(totals.demotedRules)}개
        </p>
        {results.exploratory.rules.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {results.exploratory.rules.map((rule, index) => <ExploratoryRule key={rule.ruleId ?? index} rule={rule} />)}
          </ul>
        ) : null}
      </div>
    </section>
  );
});
