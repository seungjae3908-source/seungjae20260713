import { AlertTriangle, ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Panel } from '@/components/ui-bits';
import { LoadingState, ErrorState } from '@/components/data-state';
import { useDisclosures } from '@/hooks/use-stock-data';
import { ApiError, type Sentiment } from '@/lib/api';

const SENTIMENT: Record<Sentiment, { label: string; description: string; className: string; icon: typeof ShieldCheck }> = {
  positive: { label: '긍정', description: '긍정 범주로 분류된 공시입니다. 실제 주가 영향은 원문과 재무 내용을 함께 확인하세요.', className: 'bg-green-500/15 text-green-400', icon: ShieldCheck },
  negative: { label: '주의', description: '주의 범주로 분류된 공시입니다. 실제 주가 영향은 원문과 재무 내용을 함께 확인하세요.', className: 'bg-red-500/15 text-red-400', icon: ShieldAlert },
  neutral: { label: '중립', description: '중립 또는 분류 근거가 부족한 공시입니다. 실제 주가 영향은 원문과 재무 내용을 함께 확인하세요.', className: 'bg-yellow-500/15 text-yellow-400', icon: AlertTriangle },
};

type DisclosureEvidence = {
  sourceLabel?: string;
  sourceProvenance?: string;
  publishedAt?: string | null;
  publishedAtPrecision?: 'DATE_ONLY';
  collectedAt?: string;
  collectionProvenance?: string;
  revisionStatus?: 'ORIGINAL' | 'CORRECTION' | 'CANCELLATION' | 'AMENDMENT';
  relationProvenance?: string;
  materialEventLabels?: string[];
  importance?: 'CRITICAL' | 'IMPORTANT' | 'INFO';
  importanceProvenance?: string;
  importanceReasons?: string[];
  classificationProvenance?: string;
  marketImpactStatus?: 'UNVERIFIED';
  relatedItems?: Array<{ date: string; url: string; label: string }>;
};

function safeHttpUrl(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function importanceLabel(value?: DisclosureEvidence['importance']) {
  if (value === 'CRITICAL') return '긴급 확인';
  if (value === 'IMPORTANT') return '중요';
  if (value === 'INFO') return '일반';
  return '미확인';
}

function revisionLabel(value?: DisclosureEvidence['revisionStatus']) {
  if (value === 'CORRECTION') return '정정공시';
  if (value === 'CANCELLATION') return '취소/철회공시';
  if (value === 'AMENDMENT') return '수정공시';
  if (value === 'ORIGINAL') return '원공시';
  return '관계 미확인';
}

export function DisclosureTab({ ticker, active }: { ticker: string; active: boolean }) {
  const { data, isLoading, isError, error, refetch } = useDisclosures(ticker, active);
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState code={error instanceof ApiError ? error.code : undefined} onRetry={() => refetch()} />;
  const list = data.market === 'US' ? data.filings : data.disclosures;

  return <div className="space-y-3"><Panel title={data.market === 'US' ? '최근 SEC 공시' : '최근 DART 공시'}>
    {list.length === 0 ? <p className="text-sm text-muted-foreground">확인된 공시가 없습니다.</p> : <ul className="space-y-2">{list.map((item, index) => {
      const title = 'form' in item ? `${item.form} · ${item.description}` : item.report;
      const meta = SENTIMENT[item.sentiment];
      const Icon = meta.icon;
      const evidence = item as typeof item & DisclosureEvidence;
      const relatedCount = item.relatedCount ?? 1;
      const itemUrl = safeHttpUrl(item.url);
      const relatedItems = evidence.relatedItems ?? [];
      return <li key={`${item.date}-${title}-${index}`} className="rounded-xl bg-secondary/40 p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1">
        {itemUrl ? <a href={itemUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold leading-relaxed hover:text-primary">{title} {relatedCount > 1 && <span className="text-xs text-primary">관련공시 {relatedCount}건</span>}</a> : <div className="text-sm font-semibold leading-relaxed">{title} {relatedCount > 1 && <span className="text-xs text-primary">관련공시 {relatedCount}건</span>}</div>}
        <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2" data-testid="disclosure-provenance">
          <span>원출처: {evidence.sourceLabel ?? '미제공'}</span>
          <span>공시 발표: {evidence.publishedAt ?? '미제공'}{evidence.publishedAtPrecision === 'DATE_ONLY' ? ' · 날짜 기준' : ''}</span>
          <span>앱 수집: {evidence.collectedAt ?? '미제공'}{evidence.collectionProvenance === 'SERVICE_ASSEMBLY_TIME' ? ' · 서비스 조립시각' : ''}</span>
          <span>관계: {revisionLabel(evidence.revisionStatus)}{evidence.relationProvenance === 'TITLE_OR_FORM_RULE' ? ' · 제목/양식 규칙' : ''}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${meta.className}`}><Icon className="h-3 w-3" />{meta.label}</span>{item.eventLabels.map((label) => <span key={label} className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">{label}</span>)}{(evidence.materialEventLabels ?? []).map((label) => <span key={`material-${label}`} className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">{label}</span>)}</div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-1">중요도: {importanceLabel(evidence.importance)}</span>
          <span className="rounded-full bg-muted px-2 py-1">중요도 근거: {(evidence.importanceReasons ?? ['미제공']).join(', ')}</span>
          <span className="rounded-full bg-muted px-2 py-1">주가 영향 미검증</span>
        </div>
        {'report' in item && <p className="mt-2 text-xs text-muted-foreground">{item.description}</p>}<p className="mt-1 text-xs text-muted-foreground" data-testid="disclosure-sentiment-guidance">분류 안내: {meta.description}</p>
        <div className="mt-2 flex flex-wrap gap-3 text-xs">{itemUrl ? <a href={itemUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-400"><ExternalLink className="h-3 w-3" />원문 보기</a> : <span className="text-muted-foreground">원문 링크 미제공</span>}{relatedItems.map((related, relatedIndex) => { const relatedUrl = safeHttpUrl(related.url); return relatedUrl ? <a key={`${related.date}-${relatedIndex}`} href={relatedUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400">이전/관련 공시 {relatedIndex + 1}</a> : null; })}</div>
      </div><span className="shrink-0 font-mono text-xs text-muted-foreground">{item.date}</span></div></li>;
    })}</ul>}
  </Panel></div>;
}
