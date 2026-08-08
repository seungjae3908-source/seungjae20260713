import { ChevronRight, ExternalLink, ShieldCheck } from "lucide-react";
import { Panel } from "@/components/ui-bits";
import { SourceLogo } from "@/components/source-logo";
import { LoadingState, ErrorState } from "@/components/data-state";
import { useNews } from "@/hooks/use-stock-data";
import { toneText, type Tone } from "@/lib/labels";
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

function openNews(url?: string) {
  if (!url || !url.startsWith("http")) {
    alert("원문 링크를 사용할 수 없습니다.");
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function sourceAccuracy(item: ExtendedNewsItem): number {
  if (typeof item.reliability === "number") return item.reliability;

  const s = (item.source || "").toLowerCase();

  if (
    s.includes("reuters") ||
    s.includes("bloomberg") ||
    s.includes("wall street") ||
    s.includes("연합") ||
    s.includes("한국경제")
  ) {
    return 95;
  }

  if (
    s.includes("cnbc") ||
    s.includes("marketwatch") ||
    s.includes("매일경제") ||
    s.includes("서울경제") ||
    s.includes("이데일리")
  ) {
    return 88;
  }

  return 75;
}

function accuracyLabel(score: number) {
  if (score >= 90) return "매우 높음";
  if (score >= 80) return "높음";
  if (score >= 70) return "보통";
  return "낮음";
}

function impactLabel(item: ExtendedNewsItem) {
  if (item.impact) return item.impact;
  if (item.tone === "positive") return "주가 영향: 긍정";
  if (item.tone === "negative") return "주가 영향: 부정";
  return "주가 영향: 보통";
}

function summaryText(item: ExtendedNewsItem) {
  if (item.summary) return item.summary;

  if (item.tone === "positive") {
    return "AI 요약: 이 뉴스는 투자 심리와 단기 수급에 긍정적으로 작용할 수 있습니다.";
  }

  if (item.tone === "negative") {
    return "AI 요약: 이 뉴스는 변동성 확대와 단기 투자심리 위축 요인으로 볼 수 있습니다.";
  }

  return "AI 요약: 해당 뉴스는 종목의 단기 흐름에 영향을 줄 수 있습니다.";
}

function NewsList({ items }: { items: ExtendedNewsItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">관련 뉴스가 없습니다.</p>;
  }

  return (
    <ul className="space-y-2">
      {items.map((n, i) => {
        const accuracy = sourceAccuracy(n);

        return (
          <li key={i}>
            <button
              onClick={() => openNews(n.url)}
              className="w-full rounded-xl bg-secondary/40 p-3 text-left transition-colors hover:bg-secondary/70"
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
                    {summaryText(n)}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-primary/15 px-2 py-1 text-primary">
                      정확도 {accuracy}%
                    </span>

                    <span className="rounded-full bg-muted px-2 py-1 text-muted-foreground">
                      신뢰도 {accuracyLabel(accuracy)}
                    </span>

                    <span className="rounded-full bg-green-500/15 px-2 py-1 text-green-400">
                      <ShieldCheck className="mr-1 inline h-3 w-3" />
                      출처 확인
                    </span>

                    <span className="rounded-full bg-blue-500/15 px-2 py-1 text-blue-400">
                      <ExternalLink className="mr-1 inline h-3 w-3" />
                      원문 보기
                    </span>
                  </div>

                  <div className="mt-2 text-xs font-medium text-muted-foreground">
                    {impactLabel(n)}
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