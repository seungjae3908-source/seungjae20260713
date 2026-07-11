import {
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { Panel } from '@/components/ui-bits';
import { LoadingState, ErrorState } from '@/components/data-state';
import { useDisclosures } from '@/hooks/use-stock-data';
import { ApiError, type Sentiment } from '@/lib/api';
import { cn } from '@/lib/utils';

const SENTIMENT = {
  negative: {
    label: '악재',
    desc: '희석·재무·상장 리스크 가능성이 있어 주의가 필요합니다.',
    className: 'bg-red-500/15 text-red-400',
    icon: <ShieldAlert className="h-3 w-3" />,
  },
  positive: {
    label: '호재',
    desc: '투자심리와 수급에 긍정적으로 작용할 수 있습니다.',
    className: 'bg-green-500/15 text-green-400',
    icon: <ShieldCheck className="h-3 w-3" />,
  },
  neutral: {
    label: '보통',
    desc: '일반 공시로 보이며 세부 내용 확인이 필요합니다.',
    className: 'bg-yellow-500/15 text-yellow-400',
    icon: <AlertTriangle className="h-3 w-3" />,
  },
} satisfies Record<Sentiment, unknown>;

// 화면 표기 규칙: ATM/offering/오퍼링 -> 희석, 상장폐지 -> 주의/유력, 중립 -> 보통
const DISCLOSURE_REPLACERS: { pattern: RegExp; replace: string }[] = [
  { pattern: /상장\s*폐지\s*유력/gi, replace: '상장폐지 유력' },
  { pattern: /상장\s*폐지\s*(가능성)?/gi, replace: '상장폐지 주의' },
  { pattern: /delisting/gi, replace: '상장폐지 주의' },
  { pattern: /\bATM\b/gi, replace: '희석 리스크' },
  { pattern: /offering/gi, replace: '희석' },
  { pattern: /오퍼링/g, replace: '희석' },
  { pattern: /중립/g, replace: '보통' },
];

function softenText(text: string): string {
  let out = text;

  DISCLOSURE_REPLACERS.forEach((item) => {
    out = out.replace(item.pattern, item.replace);
  });

  return out;
}

function openFiling(url: string) {
  if (!url || !url.startsWith('http')) return;

  window.open(url, '_blank', 'noopener,noreferrer');
}

export function DisclosureTab({
  ticker,
  active,
}: {
  ticker: string;
  active: boolean;
}) {
  const { data, isLoading, isError, error, refetch } = useDisclosures(
    ticker,
    active,
  );

  if (isLoading) return <LoadingState />;

  if (isError || !data) {
    return (
      <ErrorState
        code={error instanceof ApiError ? error.code : undefined}
        onRetry={() => refetch()}
      />
    );
  }

  const list = data.market === 'US' ? data.filings : data.disclosures;

  return (
    <div className="space-y-3">
      <Panel
        title={data.market === 'US' ? '최근 SEC 공시' : '최근 DART 공시'}
      >
        {list.length === 0 ? (
          <p className="break-keep text-sm leading-relaxed text-muted-foreground">
            최근 공시가 없습니다.
          </p>
        ) : (
          <ul className="space-y-2">
            {list.map((f, i) => {
              // Backend supplies readable names: KR = DART report name (f.report),
              // US = form code + Korean description ("form · description").
              const title =
                'form' in f
                  ? `${f.form} · ${softenText(f.description)}`
                  : softenText(f.report);
              const ai = SENTIMENT[f.sentiment];

              return (
                <li
                  key={i}
                  onClick={() => f.url && openFiling(f.url)}
                  className={cn(
                    'rounded-xl bg-secondary/40 p-3',
                    f.url && 'cursor-pointer transition-colors hover:bg-secondary/70',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-keep text-sm font-semibold leading-relaxed">
                        {title}
                      </p>

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${ai.className}`}
                        >
                          {ai.icon}
                          {ai.label}
                        </span>

                        {f.eventLabels.map((label) => (
                          <span
                            key={label}
                            className="break-keep rounded-full border border-border px-2 py-0.5 text-xs leading-relaxed text-muted-foreground"
                          >
                            {softenText(label)}
                          </span>
                        ))}
                      </div>

                      {'form' in f ? null : (
                        <p className="mt-2 break-keep text-sm leading-relaxed">
                          {softenText(f.description)}
                        </p>
                      )}

                      <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
                        AI 분석: {ai.desc}
                      </p>
                    </div>

                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {f.date}
                    </span>
                  </div>

                  {f.url ? (
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="mt-2 inline-flex items-center gap-1 text-xs text-blue-400"
                    >
                      <ExternalLink className="h-3 w-3" />
                      원문 보기
                    </a>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      원문 링크 없음
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
