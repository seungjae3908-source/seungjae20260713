import { AlertTriangle, ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Panel } from '@/components/ui-bits';
import { LoadingState, ErrorState } from '@/components/data-state';
import { useDisclosures } from '@/hooks/use-stock-data';
import { ApiError, type Sentiment } from '@/lib/api';

const SENTIMENT: Record<Sentiment, { label: string; description: string; className: string; icon: typeof ShieldCheck }> = {
  positive: { label: '긍정', description: '투자 심리에 긍정적으로 작용할 가능성이 있는 공시입니다.', className: 'bg-green-500/15 text-green-400', icon: ShieldCheck },
  negative: { label: '주의', description: '주가 변동성이나 주주가치 훼손 가능성을 확인해야 합니다.', className: 'bg-red-500/15 text-red-400', icon: ShieldAlert },
  neutral: { label: '중립', description: '일반 공시로, 세부 내용과 재무 영향을 함께 확인해야 합니다.', className: 'bg-yellow-500/15 text-yellow-400', icon: AlertTriangle },
};

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
      const relatedCount = item.relatedCount ?? 1;
      return <li key={`${item.date}-${title}-${index}`} className="rounded-xl bg-secondary/40 p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1">
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold leading-relaxed hover:text-primary">{title} {relatedCount > 1 && <span className="text-xs text-primary">관련공시 {relatedCount}건</span>}</a>
        <div className="mt-2 flex flex-wrap gap-2"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${meta.className}`}><Icon className="h-3 w-3" />{meta.label}</span>{item.eventLabels.map((label) => <span key={label} className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">{label}</span>)}</div>
        {'report' in item && <p className="mt-2 text-xs text-muted-foreground">{item.description}</p>}<p className="mt-1 text-xs text-muted-foreground">AI 해석: {meta.description}</p>
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-blue-400"><ExternalLink className="h-3 w-3" />원문 보기</a>
      </div><span className="shrink-0 font-mono text-xs text-muted-foreground">{item.date}</span></div></li>;
    })}</ul>}
  </Panel></div>;
}
