import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Globe2,
} from "lucide-react";
import { api } from "@/lib/api";
import { BottomNav } from "@/components/bottom-nav";
import { cn } from "@/lib/utils";

type AnyObj = Record<string, any>;
type MarketTab = "KR" | "US";
type ToneTab = "positive" | "negative";
type DetailTab = "news" | "disclosure" | "chart";

const DETAIL_TABS: Record<
  ToneTab,
  {
    key: DetailTab;
    label: string;
    keywords: string[];
  }[]
> = {
  positive: [
    {
      key: "news",
      label: "뉴스",
      keywords: [
        "계약",
        "성공",
        "수주",
        "FDA",
        "승인",
        "투자",
        "기술",
        "임상",
        "흑자",
        "개선",
      ],
    },
    {
      key: "disclosure",
      label: "공시",
      keywords: [
        "공시",
        "이익 증가",
        "매출 증가",
        "공급계약",
        "자사주",
        "배당",
        "흑자전환",
      ],
    },
    {
      key: "chart",
      label: "차트",
      keywords: [
        "이평선",
        "거래량",
        "신고가",
        "골든크로스",
        "추세",
        "돌파",
        "차트",
      ],
    },
  ],
  negative: [
    {
      key: "news",
      label: "뉴스",
      keywords: ["실패", "취소", "규제", "소송", "악화", "부진", "감소"],
    },
    {
      key: "disclosure",
      label: "공시",
      keywords: [
        "공시",
        "유상증자",
        "전환사채",
        "감자",
        "상장폐지",
        "감사의견",
        "적자",
        "CB",
        "BW",
        "ATM",
      ],
    },
    {
      key: "chart",
      label: "차트",
      keywords: [
        "이평선 이탈",
        "데드크로스",
        "신저가",
        "지지선",
        "하락",
        "차트",
        "거래량 동반",
      ],
    },
  ],
};

function importanceClass(importance: string) {
  if (importance === "high") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }

  if (importance === "medium") {
    return "border-warning/30 bg-warning/10 text-warning";
  }

  return "border-card-border bg-secondary text-muted-foreground";
}

function relTime(iso: string) {
  const t = Date.parse(iso);

  if (Number.isNaN(t)) return iso || "—";

  const min = Math.floor((Date.now() - t) / 60000);

  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;

  const hour = Math.floor(min / 60);

  if (hour < 24) return `${hour}시간 전`;

  return `${Math.floor(hour / 24)}일 전`;
}

function classifyAlert(alert: AnyObj, tab: DetailTab, tone: ToneTab) {
  const text = `${alert.category} ${alert.title}`.toLowerCase();
  const selected = DETAIL_TABS[tone].find((item) => item.key === tab);

  if (!selected) return true;

  if (selected.key === "news") {
    const disclosureWords = [
      "공시",
      "form",
      "filing",
      "8-k",
      "6-k",
      "10-k",
      "분기보고서",
      "사업보고서",
    ];

    const chartWords = [
      "차트",
      "이평선",
      "골든크로스",
      "데드크로스",
      "신고가",
      "신저가",
      "지지선",
    ];

    if (disclosureWords.some((word) => text.includes(word.toLowerCase()))) {
      return false;
    }

    if (chartWords.some((word) => text.includes(word.toLowerCase()))) {
      return false;
    }

    return true;
  }

  return selected.keywords.some((word) => text.includes(word.toLowerCase()));
}

function eventLabel(alert: AnyObj) {
  const text = `${alert.category} ${alert.title}`;

  if (alert.kind === "positive") {
    if (/계약|수주|공급/i.test(text)) return "계약건";
    if (/임상|성공|승인|FDA/i.test(text)) return "성공건";
    if (/실적|매출|이익|흑자/i.test(text)) return "실적 개선";
    if (/이평선|돌파|거래량|골든크로스/i.test(text)) return "차트 호재";

    return "호재";
  }

  if (/증자|전환사채|CB|BW|ATM/i.test(text)) return "자금조달 악재";
  if (/상장폐지|감사|감자/i.test(text)) return "상장 리스크";
  if (/실패|취소|소송|규제/i.test(text)) return "뉴스 악재";
  if (/이탈|데드크로스|신저가|하락/i.test(text)) return "차트 악재";

  return "악재";
}

export default function StockInfoPage() {
  const [market, setMarket] = useState<MarketTab>("KR");
  const [tone, setTone] = useState<ToneTab>("positive");
  const [detail, setDetail] = useState<DetailTab>("news");

  const feed = useQuery({
    queryKey: ["alert-feed", "ALL"],
    queryFn: () => api.alertFeed("ALL" as any),
    staleTime: 0,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const list = useMemo(() => {
    const data = feed.data as AnyObj | undefined;

    const source =
      tone === "positive" ? (data?.positive ?? []) : (data?.negative ?? []);

    const marketItems = source.filter((alert: AnyObj) => {
      const inferredMarket =
        alert.market ??
        (/^\d{6}$/.test(String(alert.ticker ?? "")) ? "KR" : "US");
      return inferredMarket === market;
    });
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const detailItems = marketItems.filter((alert: AnyObj) => {
      if (!classifyAlert(alert, detail, tone)) return false;
      const time = Date.parse(String(alert.time ?? alert.date ?? alert.publishedAt ?? ""));
      return Number.isNaN(time) || time >= sevenDaysAgo;
    });
    const unique: AnyObj[] = [...new Map<string, AnyObj>(detailItems.map((alert: AnyObj) => {
      const normalizedTitle = String(alert.title ?? "").toLowerCase().replace(/[^가-힣a-z0-9]/g, "").slice(0, 60);
      return [`${alert.ticker ?? ""}:${normalizedTitle}`, alert];
    })).values()];
    return unique.sort((a: AnyObj, b: AnyObj) => {
      const ia =
        a.importance === "high" ? 3 : a.importance === "medium" ? 2 : 1;

      const ib =
        b.importance === "high" ? 3 : b.importance === "medium" ? 2 : 1;

      if (ia !== ib) return ib - ia;

      return Date.parse(String(b.time ?? b.date ?? "")) - Date.parse(String(a.time ?? a.date ?? ""));
    }).slice(0, 1);
  }, [feed.data, market, tone, detail]);

  const changeTone = (next: ToneTab) => {
    setTone(next);
    setDetail("news");
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background">
      <header className="relative z-20 border-b border-card-border bg-background/90 px-4 pb-3 pt-4 glass">
        <div className="mb-3 text-center">
          <h1 className="text-xl font-extrabold">주식정보</h1>

          <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
            최근 7일 뉴스·공시·차트 신호를 중복 없이 각 1건씩 보여줍니다.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button active={market === "KR"} onClick={() => setMarket("KR")}>
            국내주식
          </Button>

          <Button active={market === "US"} onClick={() => setMarket("US")}>
            해외주식
          </Button>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            active={tone === "positive"}
            onClick={() => changeTone("positive")}
            tone="positive"
          >
            호재
          </Button>

          <Button
            active={tone === "negative"}
            onClick={() => changeTone("negative")}
            tone="negative"
          >
            악재
          </Button>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-2">
          {DETAIL_TABS[tone].map((item) => (
            <Button
              key={item.key}
              active={detail === item.key}
              onClick={() => setDetail(item.key)}
              tone={tone}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </header>

      <main className="flex-none p-3 pb-24">
        <div className="mb-3 flex items-center justify-between rounded-2xl border border-card-border bg-card px-4 py-3">
          <div>
            <p className="text-xs font-bold text-muted-foreground">
              {market === "KR" ? "국내주식" : "해외주식"}
            </p>
            <h2
              className={cn(
                "mt-0.5 text-base font-extrabold",
                tone === "positive" ? "text-positive" : "text-destructive",
              )}
            >
              {tone === "positive" ? "호재" : "악재"} ·{" "}
              {DETAIL_TABS[tone].find((item) => item.key === detail)?.label}
            </h2>
          </div>
          <span className="rounded-full bg-secondary px-3 py-1 text-xs font-extrabold">
            {list.length}건
          </span>
        </div>
        {feed.isLoading && (
          <div className="rounded-3xl border border-card-border bg-card p-8 text-center text-sm font-bold">
            주식정보 수집 중...
          </div>
        )}

        {feed.isError && (
          <div className="rounded-3xl border border-card-border bg-card p-8 text-center">
            <p className="break-keep text-sm font-bold leading-relaxed text-destructive">
              주식정보를 불러오지 못했습니다.
            </p>

            <button
              type="button"
              onClick={() => void feed.refetch()}
              className="mt-3 rounded-full bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
            >
              다시 시도
            </button>
          </div>
        )}

        {feed.data && list.length === 0 && (
          <div className="rounded-3xl border border-card-border bg-card p-8 text-center">
            <p className="break-keep text-sm font-bold leading-relaxed">
              표시할 이슈가 없습니다.
            </p>

            <p className="mt-2 break-keep text-xs leading-relaxed text-muted-foreground">
              다른 탭을 선택하거나 잠시 후 다시 확인하세요.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {list.map((alert: AnyObj) => (
            <InfoCard
              key={alert.id ?? `${alert.ticker}:${alert.title}`}
              alert={alert}
            />
          ))}
        </div>
      </main>

      <BottomNav />
    </div>
  );
}

function Button({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: ToneTab;
  children: ReactNode;
}) {
  const activeClass =
    tone === "positive"
      ? "border-positive bg-positive/10 text-positive"
      : tone === "negative"
        ? "border-destructive bg-destructive/10 text-destructive"
        : "border-primary bg-primary text-primary-foreground";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-bold transition-colors",
        active
          ? activeClass
          : "border-card-border bg-card text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function InfoCard({ alert }: { alert: AnyObj }) {
  const positive = alert.kind === "positive";
  const Icon = positive ? CheckCircle2 : AlertTriangle;

  const inner = (
    <article className="rounded-3xl border border-card-border bg-card p-4 shadow-sm transition active:scale-[0.99]">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="break-keep text-sm font-extrabold leading-relaxed">
              {alert.name}
            </h3>

            {alert.market === "US" && (
              <Globe2 className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </div>

          <p className="mt-1 text-xs text-muted-foreground">
            {relTime(alert.time)}
          </p>
        </div>

        {alert.url ? (
          <ExternalLink className="h-4 w-4 text-primary" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold",
            positive
              ? "border-positive/30 bg-positive/10 text-positive"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          <Icon className="h-3 w-3" />
          {eventLabel(alert)}
        </span>

        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px] font-bold",
            importanceClass(alert.importance),
          )}
        >
          {alert.importance === "high"
            ? "중요"
            : alert.importance === "medium"
              ? "보통"
              : "참고"}
        </span>

        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {alert.category || "뉴스/공시"}
        </span>
      </div>

      <p className="break-keep text-sm font-semibold leading-relaxed">
        {alert.title}
      </p>
    </article>
  );

  if (alert.url) {
    return (
      <a href={alert.url} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }

  return <Link href={`/stock/${alert.ticker}`}>{inner}</Link>;
}
