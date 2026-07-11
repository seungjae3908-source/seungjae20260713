import { Link } from 'wouter';
import { Sparkles } from 'lucide-react';
import { useBriefing } from '@/hooks/use-stock-data';
import { formatPercent } from '@/lib/format';
import { RATING_KO } from '@/lib/labels';
import { cn } from '@/lib/utils';

const MOOD = {
  positive: { label: '강세', cls: 'text-positive border-positive/30 bg-positive/10' },
  negative: { label: '약세', cls: 'text-destructive border-destructive/30 bg-destructive/10' },
  neutral: { label: '혼조', cls: 'text-warning border-warning/30 bg-warning/10' },
} as const;

function NameChip({ ticker, name, right, tone }: { ticker: string; name: string; right: string; tone: string }) {
  return (
    <Link
      href={`/stock/${ticker}`}
      className="flex items-center justify-between gap-2 rounded-lg border border-card-border bg-background/40 px-2.5 py-1.5"
    >
      <span className="min-w-0 break-keep text-xs font-medium leading-relaxed">{name}</span>
      <span className={cn('shrink-0 font-mono text-[11px] tabular-nums', tone)}>{right}</span>
    </Link>
  );
}

function NewsLink({ name, title, url, kind }: { name: string; title: string; url: string; kind: '호재' | '악재' }) {
  const tone = kind === '호재' ? 'text-positive border-positive/30 bg-positive/10' : 'text-destructive border-destructive/30 bg-destructive/10';
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg border border-card-border bg-background/40 px-2.5 py-1.5"
    >
      <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold', tone)}>{kind}</span>
      <span className="min-w-0 flex-1 break-keep text-xs leading-relaxed">
        <span className="text-muted-foreground">{name}</span> · {title}
      </span>
    </a>
  );
}

export function AiBriefing() {
  const { data, isLoading } = useBriefing();

  return (
    <section className="rounded-2xl border border-ai/25 bg-card p-4 glass">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ai/15">
          <Sparkles className="h-4 w-4 text-ai" />
        </span>
        <h2 className="text-sm font-bold">오늘의 브리핑</h2>
        {data && (
          <span className={cn('ml-auto rounded-full border px-2 py-0.5 text-[11px] font-semibold', MOOD[data.mood].cls)}>
            {MOOD[data.mood].label}
          </span>
        )}
      </div>
      {isLoading && <div className="h-24 animate-pulse rounded-lg bg-muted/40" />}
      {data && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-ai">{data.headline}</p>
          <ul className="space-y-1">
            {data.lines.map((l, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                · {l}
              </li>
            ))}
          </ul>

          {(data.strongSectors.length > 0 || data.weakSectors.length > 0) && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="mb-1 text-[11px] font-semibold text-positive">강세 섹터</div>
                <div className="flex flex-wrap gap-1.5">
                  {data.strongSectors.length > 0 ? (
                    data.strongSectors.map((s) => (
                      <span key={s.sector} className="rounded-full border border-positive/25 bg-positive/10 px-2 py-0.5 text-[11px] font-medium text-positive">
                        {s.sector} {formatPercent(s.changePercent)}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11px] text-muted-foreground">—</span>
                  )}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-semibold text-destructive">약세 섹터</div>
                <div className="flex flex-wrap gap-1.5">
                  {data.weakSectors.length > 0 ? (
                    data.weakSectors.map((s) => (
                      <span key={s.sector} className="rounded-full border border-destructive/25 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                        {s.sector} {formatPercent(s.changePercent)}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11px] text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {(data.positiveNews.length > 0 || data.negativeNews.length > 0) && (
            <div>
              <div className="mb-1 text-[11px] font-semibold text-muted-foreground">주요 뉴스</div>
              <div className="space-y-1.5">
                {data.positiveNews.map((n, i) => (
                  <NewsLink key={`p${i}`} name={n.name} title={n.title} url={n.url} kind="호재" />
                ))}
                {data.negativeNews.map((n, i) => (
                  <NewsLink key={`n${i}`} name={n.name} title={n.title} url={n.url} kind="악재" />
                ))}
              </div>
            </div>
          )}

          {data.disclosureRisks.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold text-warning">공시 위험</div>
              <div className="flex flex-wrap gap-1.5">
                {data.disclosureRisks.map((r) => (
                  <Link
                    key={r.ticker}
                    href={`/stock/${r.ticker}`}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                      r.level === 'HIGH'
                        ? 'border-risk/30 bg-risk/10 text-risk'
                        : 'border-warning/30 bg-warning/10 text-warning',
                    )}
                  >
                    {r.name} · {r.label}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {data.picks.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold text-muted-foreground">AI 추천 종목</div>
              <div className="grid grid-cols-1 gap-1.5">
                {data.picks.map((p) => (
                  <NameChip
                    key={p.ticker}
                    ticker={p.ticker}
                    name={p.name}
                    right={`${RATING_KO[p.rating]} · ${p.score}점`}
                    tone="text-ai"
                  />
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-[11px] font-semibold text-positive">강세 종목</div>
              <div className="space-y-1.5">
                {data.gainers.map((g) => (
                  <NameChip key={g.ticker} ticker={g.ticker} name={g.name} right={formatPercent(g.changePercent)} tone="text-positive" />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold text-destructive">약세 종목</div>
              <div className="space-y-1.5">
                {data.losers.map((g) => (
                  <NameChip key={g.ticker} ticker={g.ticker} name={g.name} right={formatPercent(g.changePercent)} tone="text-destructive" />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
