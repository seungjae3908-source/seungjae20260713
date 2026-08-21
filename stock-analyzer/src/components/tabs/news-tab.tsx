import { ChevronRight, ExternalLink } from "lucide-react";
import { Panel } from "@/components/ui-bits";
import { SourceLogo } from "@/components/source-logo";
import { LoadingState, ErrorState } from "@/components/data-state";
import { useNews } from "@/hooks/use-stock-data";
import { toneText, type Tone } from "@/lib/labels";
import { newsEvidenceDisplay } from "@/lib/news-evidence-display";
import { cn } from "@/lib/utils";
import { ApiError, type NewsItem } from "@/lib/api";

type ExtendedNewsItem = NewsItem & {
  reliability?: number;
  summary?: string;
  impact?: string;
};

function sentimentTone(score: number): Tone {
  if (score > 15) return "positive";
  if (score < -15) return "destructive";
  return "warning";
}

function usableNewsUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function openNews(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function NewsList({ items }: { items: ExtendedNewsItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">관련 뉴스가 없습니다.</p>;
  }

  return (
    <ul className="space-y-2">
      {items.map((n, i) => {
        const evidence = newsEvidenceDisplay(n);
        const newsUrl = usableNewsUrl(n.url);

        return (
          <li key={i}>
            <button
              type="button"
              onClick={() => newsUrl && openNews(newsUrl)}
              disabled={!newsUrl}
              className="w-full rounded-xl bg-secondary/40 p-3 text-left transition-colors hover:bg-secondary/70 disabled:cursor-default disabled:hover:bg-secondary/40"
            >
              <div className="flex items-start gap-3">
                <SourceLogo domain={n.sourceDomain} name={n.source} />

                <div className="min-w-0 flex-1">
                  <div className="break-keep text-sm font-semibold leading-relaxed">
                    {n.title}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>출처: {n.source}</span>
                    <span>·</span>
                    <span className="font-mono">{n.date}</span>
                  </div>

                  <div className="mt-2 break-keep text-xs leading-relaxed text-muted-foreground">
                    {evidence.summary ? `제공 요약: ${evidence.summary}` : "요약: 제공처 근거 없음"}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {evidence.reliabilityScore == null ? (
                      <span className="rounded-full bg-muted px-2 py-1 text-muted-foreground">
                        신뢰도 미제공
                      </span>
                    ) : (
                      <>
                        <span className="rounded-full bg-primary/15 px-2 py-1 text-primary">
                          제공 신뢰도 {evidence.reliabilityScore}%
                        </span>
                        <span className="rounded-full bg-muted px-2 py-1 text-muted-foreground">
                          신뢰도 {evidence.reliabilityLabel}
                        </span>
                      </>
                    )}

                    <span className="rounded-full bg-blue-500/15 px-2 py-1 text-blue-400">
                      <ExternalLink className="mr-1 inline h-3 w-3" />
                      {newsUrl ? "원문 보기" : "원문 링크 미제공"}
                    </span>
                  </div>

                  <div className="mt-2 text-xs font-medium text-muted-foreground">
                    {evidence.impact ? `제공 영향: ${evidence.impact}` : "주가 영향 근거 미제공"}
                  </div>
                </div>

                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function NewsTab({
  ticker,
  companyName,
  active,
}: {
  ticker: string;
  companyName: string;
  active: boolean;
}) {
  const { data, isLoading, isError, error, refetch } = useNews(ticker, active);

  if (isLoading) return <LoadingState />;

  if (isError || !data) {
    return (
      <ErrorState
        code={error instanceof ApiError ? error.code : undefined}
        onRetry={() => refetch()}
      />
    );
  }

  const tone = sentimentTone(data.sentimentScore);

  return (
    <div className="space-y-3">
      <Panel title="뉴스 감성 점수">
        <div className="flex items-center gap-4">
          <span className={cn("font-mono text-3xl font-bold", toneText(tone))}>
            {data.sentimentScore > 0 ? "+" : ""}
            {data.sentimentScore}
          </span>

          <div className="flex-1">
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
              <div
                className={cn(
                  "absolute inset-y-0",
                  tone === "positive"
                    ? "bg-positive"
                    : tone === "destructive"
                      ? "bg-destructive"
                      : "bg-warning"
                )}
                style={
                  data.sentimentScore >= 0
                    ? {
                        left: "50%",
                        width: `${(data.sentimentScore / 100) * 50}%`,
                      }
                    : {
                        right: "50%",
                        width: `${(Math.abs(data.sentimentScore) / 100) * 50}%`,
                      }
                }
              />
            </div>

            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>부정</span>
              <span>중립</span>
              <span>긍정</span>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title={`호재 뉴스 (${data.positive.length})`}>
        <NewsList items={data.positive as ExtendedNewsItem[]} />
      </Panel>

      <Panel title={`악재 뉴스 (${data.negative.length})`}>
        <NewsList items={data.negative as ExtendedNewsItem[]} />
      </Panel>
    </div>
  );
}
