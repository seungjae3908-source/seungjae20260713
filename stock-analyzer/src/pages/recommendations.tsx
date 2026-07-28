// AI 추천 화면 — 규칙 기반 엔진(LLM 미연결)이 실데이터로 선별한 후보를 보여준다.
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BottomNav } from "@/components/bottom-nav";
import {
  displayStockName,
  formatAppPercent,
  formatAppPrice,
} from "@/lib/stock-display";

type Category = "undervalued" | "accumulation" | "bottom" | "breakout";

const CATEGORY_TABS: Array<{ key: Category; label: string }> = [
  { key: "undervalued", label: "저평가" },
  { key: "accumulation", label: "매집" },
  { key: "bottom", label: "바닥권" },
  { key: "breakout", label: "추세돌파" },
];

const CATEGORY_CRITERIA: Record<Category, string> = {
  undervalued:
    "선정 기준: 실제 재무 데이터 확보 + 밸류에이션 지표 2개 이상 충족 (참고용 분석)",
  accumulation:
    "선정 기준: 횡보 구간에서 거래량 유입·매도 압력 감소·지지선 유지 (관찰 필요)",
  bottom:
    "선정 기준: 장기 저점 근접 + 과매도(RSI) + 하락 둔화·저점 상승 (관찰 필요)",
  breakout:
    "선정 기준: 박스권 돌파 5일 이내 + 거래량 1.5배 이상 + 과열 아님 (분석 후보)",
};

const PAGE_SIZE = 20;
const MAX_ROWS = 100;

function categoryFromPath(path: string): Category {
  const seg = path.split("?")[0].split("/")[2];
  return (CATEGORY_TABS.find((t) => t.key === seg)?.key ?? "undervalued") as Category;
}

interface RecoRow {
  ticker: string;
  name: string;
  market: "KR" | "US";
  currency: "KRW" | "USD";
  category: Category;
  categoryLabel: string;
  price: number;
  changePercent: number;
  reasons: string[];
  usedData: string[];
  missingData: string[];
  risks: string[];
  overheated: boolean;
  financialStability: string;
  newsRisk: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  shortTermOutlook: string;
  midTermOutlook: string;
  opinion: string;
  targetPrice: number | null;
  targetBasis: string;
  stopLoss: number | null;
  stopBasis: string;
  score: number;
  generatedAt: string;
  dataUpdatedAt: string;
  providers: string[];
  dataQuality: string;
  previousGeneratedAt?: string;
  changeSincePrevious?: number;
}

interface RecoResponse {
  ok: boolean;
  provider: string;
  analysisMode: string;
  aiConfigured: boolean;
  analysisDescription: string;
  market: "KR" | "US";
  generatedAt: string;
  rows: RecoRow[];
  excludedCount: number;
  excludedBreakdown: Record<string, number>;
  dataQualityNote: string;
  error?: string;
  message?: string;
}

const QUALITY_LABEL: Record<string, string> = {
  sufficient: "데이터 충분",
  partial: "데이터 일부 부족",
  insufficient: "데이터 부족",
  stale: "데이터 오래됨",
};

export default function RecommendationsPage() {
  const [location, navigate] = useLocation();
  const [market, setMarket] = useState<"KR" | "US">("KR");
  const category = categoryFromPath(location);
  const [page, setPage] = useState(1);

  const setCategory = (next: Category) => {
    setPage(1);
    navigate(`/recommendations/${next}`);
  };

  const query = useQuery({
    queryKey: ["recommendations", market],
    queryFn: () =>
      apiGet<RecoResponse>(`/market/recommendations?market=${market}`),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const data = query.data;
  const allRows = (data?.rows ?? [])
    .filter((row) => row.category === category)
    .slice(0, MAX_ROWS);
  const totalPages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const rows = allRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <div className="px-4 pb-28 pt-4">
        <header className="mb-3 grid grid-cols-[40px_1fr_40px] items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/home")}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-center text-xl font-extrabold">AI 추천</h1>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <RefreshCw
              className={cn("h-4 w-4", query.isFetching && "animate-spin")}
            />
          </button>
        </header>

        <div className="mb-2 grid grid-cols-2 gap-2">
          {(["KR", "US"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMarket(m)}
              className={cn(
                "rounded-xl border px-3 py-2 text-sm font-extrabold",
                market === m
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-card-border bg-card text-muted-foreground",
              )}
            >
              {m === "KR" ? "국내주식" : "해외주식"}
            </button>
          ))}
        </div>
        <div className="mb-3 grid grid-cols-4 gap-2">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setCategory(tab.key)}
              className={cn(
                "flex items-center justify-center rounded-xl border px-1 py-2 text-xs font-extrabold",
                category === tab.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-card-border bg-card text-muted-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <p className="mb-3 rounded-2xl border border-card-border bg-card p-3 text-center text-[11px] font-bold leading-relaxed text-muted-foreground">
          {CATEGORY_CRITERIA[category]}
        </p>

        {data && (
          <section className="mb-3 rounded-2xl border border-card-border bg-card p-3">
            <p className="text-[11px] font-bold leading-relaxed text-muted-foreground">
              {data.analysisDescription}
            </p>
            <p className="mt-1 text-[10px] font-bold text-muted-foreground">
              생성 {new Date(data.generatedAt).toLocaleString("ko-KR")} · 제외{" "}
              {data.excludedCount}종목(과열·유동성·데이터 부족 등) ·{" "}
              {data.dataQualityNote}
            </p>
          </section>
        )}

        {query.isLoading && (
          <StateBox>
            실데이터를 수집해 추천을 계산하는 중입니다. 최초 1~2분 걸릴 수
            있습니다.
          </StateBox>
        )}
        {query.isError && (
          <StateBox error>
            추천 산출 실패 — 데이터 공급자 오류입니다. 잠시 후 다시 시도해
            주세요.
          </StateBox>
        )}
        {!query.isLoading && !query.isError && allRows.length === 0 && (
          <StateBox>
            현재 조건에 해당하는 종목이 없습니다. (조건 미달 종목으로 채우지
            않습니다)
          </StateBox>
        )}

        <div className="space-y-3">
          {rows.map((row) => (
            <RecoCard
              key={`${row.market}:${row.ticker}`}
              row={row}
              onOpen={() =>
                navigate(`/stock/${encodeURIComponent(row.ticker)}`)
              }
            />
          ))}
        </div>

        {allRows.length > PAGE_SIZE && (
          <div className="mt-4 flex items-center justify-center gap-1.5">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPage(p)}
                className={cn(
                  "h-9 w-9 rounded-xl border text-sm font-extrabold",
                  safePage === p
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-card-border bg-card text-muted-foreground",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
      <BottomNav />
    </div>
  );
}

function StateBox({
  children,
  error,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 text-center text-xs font-bold",
        error
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-card-border bg-card text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function RecoCard({ row, onOpen }: { row: RecoRow; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-black">
            {displayStockName(row.ticker, row.name, row.market)}
          </p>
          <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
            {row.ticker} · {row.market === "KR" ? "국내" : "해외"} ·{" "}
            {row.categoryLabel}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-black">
            {formatAppPrice(row.price, row.currency)}
          </p>
          <p
            className={cn(
              "text-[10px] font-black",
              row.changePercent >= 0 ? "text-positive" : "text-destructive",
            )}
          >
            {formatAppPercent(row.changePercent)}
          </p>
        </div>
      </button>

      <div className="mt-2 flex flex-wrap gap-1">
        <Badge tone={row.score >= 70 ? "positive" : "muted"}>
          상승 가능성 {row.score}점
        </Badge>
        <Badge tone={row.opinion === "매수" ? "positive" : "muted"}>
          {row.opinion}
        </Badge>
        <Badge
          tone={
            row.riskLevel === "HIGH"
              ? "negative"
              : row.riskLevel === "MEDIUM"
                ? "warn"
                : "muted"
          }
        >
          위험 {row.riskLevel}
        </Badge>
        <Badge tone={row.dataQuality === "sufficient" ? "positive" : "warn"}>
          {QUALITY_LABEL[row.dataQuality] ?? row.dataQuality}
        </Badge>
      </div>

      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] font-bold text-foreground/90">
        {row.reasons.slice(0, open ? undefined : 3).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      {open && (
        <div className="mt-2 space-y-2 text-[11px] font-bold">
          {row.risks.length > 0 && (
            <div className="rounded-xl bg-destructive/10 p-2 text-destructive">
              {row.risks.map((risk) => (
                <p key={risk}>⚠ {risk}</p>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Info
              label="목표가"
              value={
                row.targetPrice != null
                  ? formatAppPrice(row.targetPrice, row.currency)
                  : "산출 불가"
              }
              sub={row.targetBasis}
            />
            <Info
              label="손절 기준"
              value={
                row.stopLoss != null
                  ? formatAppPrice(row.stopLoss, row.currency)
                  : "산출 불가"
              }
              sub={row.stopBasis}
            />
            <Info label="재무 안정성" value={row.financialStability} />
            <Info label="뉴스 리스크" value={row.newsRisk} />
          </div>
          <p className="text-muted-foreground">단기: {row.shortTermOutlook}</p>
          <p className="text-muted-foreground">중기: {row.midTermOutlook}</p>
          <p className="text-muted-foreground">
            사용 데이터: {row.usedData.join(", ")}
            {row.missingData.length
              ? ` · 미반영: ${row.missingData.join(", ")}`
              : ""}
          </p>
          <p className="text-[10px] text-muted-foreground">
            데이터 기준 {new Date(row.dataUpdatedAt).toLocaleString("ko-KR")} ·
            공급자 {row.providers.join(", ")}
            {row.previousGeneratedAt
              ? ` · 직전 추천 ${new Date(row.previousGeneratedAt).toLocaleDateString("ko-KR")}${row.changeSincePrevious != null ? ` 이후 ${row.changeSincePrevious >= 0 ? "+" : ""}${row.changeSincePrevious}%` : ""}`
              : ""}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2 w-full rounded-xl border border-card-border bg-secondary/60 py-1.5 text-[11px] font-black text-muted-foreground"
      >
        {open ? "접기" : "근거·위험·목표가 자세히"}
      </button>
    </article>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "positive" | "negative" | "warn" | "muted";
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-black",
        tone === "positive" && "bg-positive/10 text-positive",
        tone === "negative" && "bg-destructive/10 text-destructive",
        tone === "warn" && "bg-amber-500/10 text-amber-500",
        tone === "muted" && "bg-secondary text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Info({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl bg-secondary/60 p-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs font-black">{value}</p>
      {sub && (
        <p className="mt-0.5 text-[9px] font-bold text-muted-foreground">
          {sub}
        </p>
      )}
    </div>
  );
}
