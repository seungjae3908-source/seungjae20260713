import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Cloud, CloudOff, Database, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  buildTradingReviewDataset,
  getJournalAnalytics,
  getJournalSnapshot,
  resolveJournalConflict,
  syncJournalRecords,
  type ConflictChoice,
  type JournalAnalytics,
  type JournalConflict,
  type TradingReviewDataset,
} from '@/lib/paper-journal-sync';
import {
  applyConflictResolution,
  applyJournalSnapshot,
  applyJournalSyncResult,
  loadJournalSyncMetadata,
  markJournalSyncFailed,
  markJournalSyncOffline,
  prepareJournalSync,
  type JournalSyncMetadata,
} from '@/lib/paper-journal-sync-storage';
import { loadPaperState, savePaperState, type StorageLike } from '@/lib/paper-trading';
import { TradingAiReviewPanel } from './trading-ai-review-panel';

const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50';
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
const format = (value: number | null | undefined, suffix = '') => value == null ? '-' : `${number.format(value)}${suffix}`;

const STATUS_LABEL: Record<JournalSyncMetadata['status'], string> = {
  'local-only': '로컬 전용', pending: '동기화 대기', syncing: '동기화 중', completed: '동기화 완료',
  offline: '오프라인', conflict: '충돌 있음', failed: '일부 실패',
};

type Props = {
  userId: string;
  rootStorage?: StorageLike;
  paperStorage: StorageLike;
  onLocalStateChanged?: () => void;
  syncApi?: typeof syncJournalRecords;
  snapshotApi?: typeof getJournalSnapshot;
  resolveApi?: typeof resolveJournalConflict;
  analyticsApi?: typeof getJournalAnalytics;
  reviewApi?: typeof buildTradingReviewDataset;
};

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-border/70 bg-background/70 p-3"><div className="text-[11px] text-muted-foreground">{label}</div><div className="mt-1 text-sm font-bold">{value}</div></div>;
}

function certaintyLabel(value: string) {
  if (value === 'confirmed') return '확정';
  if (value === 'candidate') return '후보';
  return '표본 부족';
}

export function PaperJournalSyncAnalyticsPanel({
  userId,
  rootStorage = window.localStorage,
  paperStorage,
  onLocalStateChanged,
  syncApi = syncJournalRecords,
  snapshotApi = getJournalSnapshot,
  resolveApi = resolveJournalConflict,
  analyticsApi = getJournalAnalytics,
  reviewApi = buildTradingReviewDataset,
}: Props) {
  const initial = useMemo(() => loadJournalSyncMetadata(rootStorage, userId).metadata, [rootStorage, userId]);
  const [metadata, setMetadata] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(initial.warning);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [analytics, setAnalytics] = useState<JournalAnalytics | null>(null);
  const [review, setReview] = useState<TradingReviewDataset | null>(null);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  async function synchronize() {
    if (busy) return;
    if (!online) {
      const next = markJournalSyncOffline(rootStorage, userId);
      setMetadata(next);
      setNotice(next.warning);
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const local = loadPaperState(paperStorage).state;
      const prepared = prepareJournalSync(rootStorage, userId, local);
      setMetadata({ ...prepared.metadata, status: 'syncing' });
      const idempotencyKey = `journal-sync:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const result = await syncApi({ idempotencyKey, clientTime: new Date().toISOString(), records: prepared.records });
      let applied = applyJournalSyncResult(rootStorage, userId, local, result);

      let cursor: string | null = null;
      let pages = 0;
      do {
        const snapshot = await snapshotApi(cursor, 100);
        applied = applyJournalSnapshot(rootStorage, userId, applied.state, snapshot);
        cursor = snapshot.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      savePaperState(paperStorage, applied.state);
      setMetadata(applied.metadata);
      setNotice(result.conflicts.length
        ? `충돌 ${result.conflicts.length}건을 확인하세요.`
        : result.failed.length
          ? `일부 실패 ${result.failed.length}건이 남았습니다. 로컬 기록은 유지됩니다.`
          : `업로드 ${result.uploaded.length}건, 다운로드 ${applied.metadata.downloadedCount}건을 동기화했습니다.`);
      onLocalStateChanged?.();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '거래일지를 동기화하지 못했습니다.';
      const next = online
        ? markJournalSyncFailed(rootStorage, userId, message)
        : markJournalSyncOffline(rootStorage, userId);
      setMetadata(next);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function resolve(conflict: JournalConflict, choice: ConflictChoice) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const local = loadPaperState(paperStorage).state;
      const response = await resolveApi(conflict.id, choice);
      const applied = applyConflictResolution(rootStorage, userId, local, response);
      savePaperState(paperStorage, applied.state);
      setMetadata(applied.metadata);
      setNotice('충돌 해결 결과를 로컬 기록에 반영했습니다.');
      onLocalStateChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '충돌을 해결하지 못했습니다.');
    } finally { setBusy(false); }
  }

  async function loadAnalytics() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      setAnalytics(await analyticsApi(periodStart || undefined, periodEnd || undefined));
      setNotice('서버에 동기화된 거래기록으로 분석했습니다.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '거래 분석을 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }

  async function prepareReview() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      setReview(await reviewApi(periodStart || undefined, periodEnd || undefined));
      setNotice('개인정보를 제외한 복기용 구조화 데이터를 준비했습니다. 외부 전송은 없습니다.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '복기 데이터를 준비하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  return <section className="space-y-4" data-testid="journal-sync-analytics">
    {error ? <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
    {notice ? <div role="status" className="rounded-xl border border-border bg-muted p-3 text-sm">{notice}</div> : null}

    <div className="rounded-2xl border border-border bg-card p-4" data-testid="journal-sync-status">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold"><Cloud className="h-4 w-4" />거래일지 동기화</h2>
          <p className="mt-1 text-xs text-muted-foreground">로컬 저장은 오프라인 캐시로 유지되며 서버 성공 전 기록을 삭제하지 않습니다.</p>
        </div>
        <button type="button" className={buttonClass} onClick={() => void synchronize()} disabled={busy} data-testid="journal-sync-button">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}다시 동기화
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="상태" value={online ? STATUS_LABEL[metadata.status] : '오프라인'} />
        <Metric label="마지막 동기화" value={metadata.lastSyncAt ? new Date(metadata.lastSyncAt).toLocaleString('ko-KR') : '-'} />
        <Metric label="업로드 / 다운로드" value={`${metadata.uploadedCount} / ${metadata.downloadedCount}`} />
        <Metric label="실패 / 충돌" value={`${metadata.failedCount} / ${metadata.conflicts.length}`} />
      </div>
      {!online ? <p className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><CloudOff className="h-4 w-4" />오프라인입니다. 모의매매와 로컬 거래일지는 계속 사용할 수 있으며 자동 무한 재시도하지 않습니다.</p> : null}
    </div>

    {metadata.conflicts.length ? <div className="rounded-2xl border border-amber-500/40 bg-card p-4" data-testid="journal-conflicts">
      <h2 className="flex items-center gap-2 font-bold"><AlertTriangle className="h-4 w-4 text-amber-500" />충돌 해결</h2>
      <div className="mt-3 space-y-3">{metadata.conflicts.map((conflict) => <article key={conflict.id} className="rounded-xl border border-border p-3">
        <div className="text-sm font-semibold">{conflict.kind} · {conflict.recordId} · version {conflict.version}</div>
        <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">{conflict.differenceSummary.map((item) => <li key={item}>{item}</li>)}</ul>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <button className={buttonClass} type="button" disabled={busy} onClick={() => void resolve(conflict, 'server')}>서버 버전 유지</button>
          <button className={buttonClass} type="button" disabled={busy} onClick={() => void resolve(conflict, 'device')}>이 기기 버전 유지</button>
          <button className={buttonClass} type="button" disabled={busy} onClick={() => void resolve(conflict, 'preserve_both')}>둘 다 사본으로 보존</button>
        </div>
      </article>)}</div>
    </div> : null}

    <div className="rounded-2xl border border-border bg-card p-4" data-testid="journal-analytics-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="flex items-center gap-2 font-bold"><Database className="h-4 w-4" />거래 분석</h2><p className="mt-1 text-xs text-muted-foreground">사실과 추정 후보를 구분하며 표본이 부족하면 결론을 만들지 않습니다.</p></div>
        <div className="flex flex-wrap gap-2">
          <label className="grid gap-1 text-xs text-muted-foreground">시작일<input className="h-10 rounded-lg border border-border bg-background px-3" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></label>
          <label className="grid gap-1 text-xs text-muted-foreground">종료일<input className="h-10 rounded-lg border border-border bg-background px-3" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={buttonClass} onClick={() => void loadAnalytics()} disabled={busy}>분석 불러오기</button><button type="button" className={buttonClass} onClick={() => void prepareReview()} disabled={busy}>AI 복기 데이터 준비</button></div>

      {analytics ? <div className="mt-4 space-y-3" data-testid="journal-analytics-result">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="총 거래" value={format(analytics.totalTrades, '건')} /><Metric label="순손익" value={format(analytics.netPnl, ' USDT')} /><Metric label="승률" value={format(analytics.winRate, '%')} /><Metric label="기대값" value={format(analytics.expectancy, ' USDT')} /><Metric label="비용 비중" value={format(analytics.costRatioPercent, '%')} /><Metric label="평균 R" value={format(analytics.averageR)} /><Metric label="규칙 위반률" value={format(analytics.ruleViolationRate, '%')} /><Metric label="최대 연속 손실" value={format(analytics.maximumConsecutiveLosses, '회')} /></div>
        {analytics.warnings.length ? <div className="rounded-xl bg-muted p-3 text-sm">{analytics.warnings.join(' ')}</div> : null}
        <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-border p-3"><h3 className="text-sm font-bold">확정 사실</h3><ul className="mt-2 space-y-1 text-xs">{analytics.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul></div><div className="rounded-xl border border-border p-3"><h3 className="text-sm font-bold">반복 행동</h3><ul className="mt-2 space-y-2 text-xs">{analytics.behaviorSignals.map((signal) => <li key={signal.code}><strong>{certaintyLabel(signal.certainty)}</strong> · {signal.message} ({signal.count})</li>)}</ul></div></div>
        <div className="overflow-x-auto"><table className="min-w-full text-left text-xs"><thead><tr className="border-b"><th className="p-2">전략</th><th className="p-2">표본</th><th className="p-2">순손익</th><th className="p-2">판정</th></tr></thead><tbody>{analytics.byStrategy.map((group) => <tr key={group.key} className="border-b"><td className="p-2">{group.key}</td><td className="p-2">{group.sampleSize}</td><td className="p-2">{format(group.netPnl)}</td><td className="p-2">{certaintyLabel(group.certainty)}</td></tr>)}</tbody></table></div>
      </div> : null}
    </div>

    <div className="rounded-2xl border border-border bg-card p-4" data-testid="review-dataset-status">
      <h2 className="flex items-center gap-2 font-bold"><ShieldCheck className="h-4 w-4" />AI 복기 준비 상태</h2>
      <p className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm font-semibold">현재 단계에서는 거래기록을 외부 AI로 전송하지 않습니다.</p>
      <p className="mt-2 text-sm">개인정보를 제외한 구조화된 복기 데이터만 준비합니다.</p>
      {review ? <div className="mt-3 rounded-xl border border-border p-3 text-xs" data-testid="review-dataset-result"><div>표본: {review.sampleSize}건 · 대표 거래: {review.representativeTrades.length}건</div><div className="mt-1 break-words">제외 필드: {review.excludedFields.join(', ')}</div></div> : null}
    </div>
    <TradingAiReviewPanel userId={userId} periodStart={periodStart} periodEnd={periodEnd} />
  </section>;
}
