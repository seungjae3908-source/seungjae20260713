import type { ResearchLightweightMarketWatch, ResearchLightweightMarketWatchCadence } from '@/lib/research-center';

const MARKET_NAMES: Record<string, string> = {
  KR_STOCK: '국내주식', US_STOCK: '미국주식',
  CRYPTO_SPOT: '코인현물', CRYPTO_FUTURES: '코인선물',
};
const WATCH_LABEL: Record<ResearchLightweightMarketWatch['status'], string> = {
  MISSING: '상태 기록 없음',
  INVALID: '상태 오류',
  STALE: '최근 수집 중단',
  HOLD: '서버 보호 중지',
  THROTTLED: '서버 보호 감속',
  BLOCKED_DATA: '데이터 연결 대기',
  OBSERVING: '공개시세 관찰 중',
  PARTIAL: '일부 시장만 수집',
};
function number(value: number | null) {
  return value == null ? '미측정' : value.toLocaleString('ko-KR');
}
function statusLabel(value: string, watchStatus?: ResearchLightweightMarketWatch['status']) {
  // Per-market READY is the most recent saved source state, not proof that
  // an aged/paused worker is still collecting new public ticker snapshots.
  if (value.startsWith('BLOCKED_')) return '데이터 미연결';
  if (watchStatus === 'STALE') return '이전 기록 · 수집 중단';
  if (watchStatus === 'HOLD') return '서버 보호 정지';
  if (watchStatus === 'THROTTLED') return '서버 보호 감속';
  if (value === 'READY') return '시세 수집';
  if (value === 'PARTIAL_TICKERS' || value === 'PARTIAL_UNIVERSE') return '일부 수집';
  return '확인 필요';
}
function displayTime(ms: number | null) {
  if (ms == null || !Number.isFinite(ms)) return '기록 없음';
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '기록 없음';
  return date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function ResearchLightweightMarketWatchPanel({
  watch, cadence,
}: {
  watch?: ResearchLightweightMarketWatch | null;
  cadence?: ResearchLightweightMarketWatchCadence | null;
}) {
  const summary = watch ?? null;
  const label = summary ? WATCH_LABEL[summary.status] : WATCH_LABEL.MISSING;
  const fresh = summary?.status === 'OBSERVING' || summary?.status === 'PARTIAL';
  const liveMarkets = summary?.marketCoverageCount ?? null;
  const markets = summary?.markets ?? [];
  const prospective = summary?.prospectiveSampleStudy ?? null;
  return (
    <section
      aria-label="24시간 경량 시장 감시 상태"
      data-testid="research-market-watch"
      className="rounded-2xl border border-border bg-card p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">LIGHTWEIGHT MARKET WATCH</p>
          <h3 className="mt-1 text-sm font-black">4시장 자동 감시</h3>
        </div>
        <strong
          data-testid="research-market-watch-status"
          className={'rounded-full border px-2.5 py-1 text-xs ' + (
            fresh
              ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
              : summary?.status === 'INVALID' || summary?.status === 'STALE'
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-border bg-muted/50 text-muted-foreground'
          )}
        >
          {label}
        </strong>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4" aria-label="감시 요약">
        <div><span className="text-muted-foreground">전체 준비된 시세</span><p className="font-bold">{liveMarkets == null ? '미측정' : liveMarkets + '/4시장'}</p></div>
        <div><span className="text-muted-foreground">당일 관찰 횟수</span><p className="font-bold">{number(summary?.cyclesToday ?? null)}</p></div>
        <div><span className="text-muted-foreground">당일 발견 후보</span><p className="font-bold">{number(summary?.candidatesToday ?? null)}건</p></div>
        <div><span className="text-muted-foreground">최근 시세 관찰</span><p className="font-bold">{displayTime(summary?.observedAt ?? null)}</p></div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(markets.length ? markets : Object.keys(MARKET_NAMES).map((market) => ({
          market, status: 'BLOCKED_DATA', observedCount: 0, listedCount: 0, newCandidates: 0, source: 'NONE',
        }))).map((row) => (
          <div key={row.market} className="rounded-xl border border-border bg-muted/20 px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <strong>{MARKET_NAMES[row.market] ?? '미확인 시장'}</strong>
              <span className="text-muted-foreground">{markets.length ? statusLabel(row.status, summary?.status) : '기록 없음'}</span>
            </div>
            <p className="mt-1 text-muted-foreground">
              시세 {markets.length ? number(row.observedCount) + '/' + number(row.listedCount) : '미측정'} · 신규 후보 {markets.length ? number(row.newCandidates) : '미측정'}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-xl border border-border bg-muted/20 px-3 py-2 text-xs"
        data-testid="research-market-watch-prospective">
        <strong>20분 후속 공개시세 관찰 (UTC 당일 기준)</strong>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <p>추적 중 {number(prospective?.pendingCount ?? null)}건</p>
          <p>시세 관찰 완료 {number(prospective?.observedCoarseToday ?? null)}건</p>
          <p>자료 부족·차단 {number(prospective?.blockedToday ?? null)}건</p>
          <p>이번 주기 미추적 {number(prospective?.untrackedThisCycle ?? null)}건</p>
        </div>
        <p className="mt-1 text-muted-foreground">
          완료는 20분 공개시세 표본 조건 충족만 의미하며 체결·실현수익·수익성 증거가 아닙니다.
          거래비용·OOS·Paper 검증 표본은 0건으로 별도 관리합니다.
        </p>
      </div>
      <div className="mt-3 rounded-xl border border-border bg-muted/20 px-3 py-2 text-xs"
        data-testid="research-market-watch-cadence">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>최근 24시간 공개시세 수집주기 · 자체 기록</strong>
          <span className="text-muted-foreground" data-testid="research-market-watch-cadence-status">
            {cadence?.status === 'PUBLIC_CADENCE_OBSERVED' ? '자체 기록 충족'
              : cadence?.status === 'INCOMPLETE_OR_INTERRUPTED' ? '주기 누락 또는 중단'
                : cadence?.status === 'INVALID' ? '진단 자료 오류' : '진단 자료 없음'}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <p>유효 주기 {number(cadence?.sampleCount ?? null)}회</p>
          <p>최대 수집 공백 {cadence?.maxGapMs == null ? '미측정' : (cadence.maxGapMs / 60_000).toFixed(1) + '분'}</p>
          <p>서버 보호 정지·감속 {cadence?.hostHoldCycles == null || cadence.hostThrottledCycles == null
            ? '미측정' : number(cadence.hostHoldCycles + cadence.hostThrottledCycles) + '회'}</p>
          <p>4시장 전체 시세 수집 주기 {number(cadence?.allFourMarketReadyCycles ?? null)}회</p>
        </div>
        <p className="mt-1 text-muted-foreground" data-testid="research-market-watch-cadence-warning">
          내부 파일의 연속 수집 기록만 진단합니다. 서버·서비스의 실제 24시간 가동과 4시장 전체 데이터는 독립 검증되지 않았습니다.
          신호 PASS·실거래·Paper 체결·수익성 증거로 인정하지 않습니다.
        </p>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground" data-testid="research-market-watch-boundary">
        시세 감시 후보는 매수·매도 신호가 아닙니다. 24시간 연속 가동,
        AI·수식 PASS, OOS·거래비용 수익성 검증과 Paper 체결은 별도 증거가 필요합니다.
        실주문 권한은 없습니다.
      </p>
    </section>
  );
}
