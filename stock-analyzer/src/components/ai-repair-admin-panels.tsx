import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  DollarSign,
  RefreshCcw,
  Settings2,
} from "lucide-react";
import { authorizedFetch } from "@/lib/auth-fetch";

type FeatureSettings = {
  freeDiagnosisEnabled: boolean;
  paidDiagnosisEnabled: boolean;
  improvementEnabled: boolean;
  updatedAt: string;
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type CostSummary = {
  month: string;
  estimatedCostUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

type CostHistoryItem = {
  jobId: string;
  title: string;
  kind: "diagnosis" | "improvement";
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  recordedAt: string;
};

async function apiJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await authorizedFetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
  } & T;

  if (!response.ok) {
    throw new Error(
      body.message || `요청 실패 (${response.status})`,
    );
  }

  return body;
}

function formatUsd(value: number): string {
  if (!value) return "$0.00";
  return `$${value < 0.1 ? value.toFixed(4) : value.toFixed(2)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AiRepairAdminPanels() {
  const [settings, setSettings] =
    useState<FeatureSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [costPage, setCostPage] = useState(1);
  const [summary, setSummary] =
    useState<CostSummary | null>(null);
  const [history, setHistory] =
    useState<CostHistoryItem[]>([]);
  const [pagination, setPagination] =
    useState<Pagination>({
      page: 1,
      pageSize: 10,
      total: 0,
      totalPages: 1,
    });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const loadSettings = useCallback(async () => {
    const body = await apiJson<{
      ok: true;
      settings: FeatureSettings;
    }>("/api/admin/ai-repair/settings");

    setSettings(body.settings);
  }, []);

  const loadCosts = useCallback(async () => {
    const body = await apiJson<{
      ok: true;
      summary: CostSummary;
      history: CostHistoryItem[];
      pagination: Pagination;
    }>(
      `/api/admin/ai-repair/costs?page=${costPage}&pageSize=10`,
    );

    setSummary(body.summary);
    setHistory(body.history);
    setPagination(body.pagination);
  }, [costPage]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (costOpen) {
      void loadCosts();
    }
  }, [costOpen, loadCosts]);

  const updateSetting = async (
    name:
      | "freeDiagnosisEnabled"
      | "paidDiagnosisEnabled"
      | "improvementEnabled",
    value: boolean,
  ) => {
    if (!settings) return;

    setBusy(true);

    const previous = settings;

    setSettings({
      ...settings,
      [name]: value,
    });

    try {
      const body = await apiJson<{
        ok: true;
        settings: FeatureSettings;
      }>("/api/admin/ai-repair/settings", {
        method: "PATCH",
        body: JSON.stringify({ [name]: value }),
      });

      setSettings(body.settings);
      setNotice("환경설정이 저장되었습니다.");
    } catch (error) {
      setSettings(previous);
      setNotice(
        error instanceof Error
          ? error.message
          : "환경설정 저장 실패",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-3">
      <section className="rounded-2xl border border-card-border bg-background p-3">
        <button
          type="button"
          onClick={() => setSettingsOpen((current) => !current)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="flex items-center gap-2 text-xs font-extrabold">
            <Settings2 className="h-4 w-4 text-primary" />
            AI 진단 환경설정
          </span>

          <span className="text-[10px] font-bold text-primary">
            {settingsOpen ? "접기" : "열기"}
          </span>
        </button>

        {settingsOpen && settings && (
          <div className="mt-3 space-y-2 border-t border-card-border pt-3">
            {[
              {
                key: "freeDiagnosisEnabled" as const,
                title: " 진단 버튼",
                description:
                  "OpenAI 호출 없이 TypeScript·빌드·격리 서버만 검사",
              },
              {
                key: "paidDiagnosisEnabled" as const,
                title: " 진단·자동 복구 버튼",
                description:
                  "오류 발견 시  승인 후 AI 수정과 재검사 진행",
              },
              {
                key: "improvementEnabled" as const,
                title: " 개선 작업 버튼",
                description:
                  "입력한 개선 요청 기준으로 예상  확인 후 실행",
              },
            ].map((item) => (
              <label
                key={item.key}
                className="flex cursor-pointer items-center gap-3 rounded-xl bg-card p-3"
              >
                <input
                  type="checkbox"
                  checked={settings[item.key]}
                  disabled={busy}
                  onChange={(event) =>
                    void updateSetting(
                      item.key,
                      event.target.checked,
                    )
                  }
                  className="h-4 w-4 accent-primary"
                />

                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-extrabold">
                    {item.title}
                  </span>

                  <span className="mt-0.5 block break-keep text-[10px] leading-relaxed text-muted-foreground">
                    {item.description}
                  </span>
                </span>

                <span className="text-[10px] font-extrabold">
                  {settings[item.key] ? "표시" : "숨김"}
                </span>
              </label>
            ))}

            {notice && (
              <p className="text-[10px] font-bold text-muted-foreground">
                {notice}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-card-border bg-background p-3">
        <button
          type="button"
          onClick={() => setCostOpen((current) => !current)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="flex items-center gap-2 text-xs font-extrabold">
            <DollarSign className="h-4 w-4 text-primary" />
            발생  지난내역
          </span>

          <span className="text-xs font-extrabold text-primary">
            {summary
              ? formatUsd(summary.estimatedCostUsd)
              : "월 누적 확인"}
          </span>
        </button>

        {costOpen && (
          <div className="mt-3 space-y-3 border-t border-card-border pt-3">
            {summary && (
              <div className="rounded-xl bg-card p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-muted-foreground">
                    {summary.month} 월 누적 예상금액
                  </span>

                  <span className="text-lg font-black text-primary">
                    {formatUsd(summary.estimatedCostUsd)}
                  </span>
                </div>

                <p className="mt-1 text-[10px] text-muted-foreground">
                  OpenAI 호출 {summary.calls.toLocaleString()}회 ·
                  입력 {summary.inputTokens.toLocaleString()} ·
                  출력 {summary.outputTokens.toLocaleString()} 토큰
                </p>
              </div>
            )}

            {history.length === 0 ? (
              <div className="rounded-xl border border-dashed border-card-border p-5 text-center text-xs text-muted-foreground">
                아직 발생한  AI 이 없습니다.
              </div>
            ) : (
              <div className="space-y-2">
                {history.map((item) => (
                  <article
                    key={item.jobId}
                    className="rounded-xl border border-card-border bg-card p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-extrabold">
                          {item.title}
                        </p>

                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {item.kind === "diagnosis"
                            ? " 진단·복구"
                            : "개선 작업"}
                          {" · "}
                          {formatDate(item.recordedAt)}
                        </p>
                      </div>

                      <span className="shrink-0 text-sm font-black text-primary">
                        {formatUsd(item.estimatedCostUsd)}
                      </span>
                    </div>

                    <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[9px]">
                      <div className="rounded-lg bg-background p-2">
                        <p className="text-muted-foreground">호출</p>
                        <p className="mt-1 font-extrabold">
                          {item.calls}회
                        </p>
                      </div>

                      <div className="rounded-lg bg-background p-2">
                        <p className="text-muted-foreground">입력</p>
                        <p className="mt-1 font-extrabold">
                          {item.inputTokens.toLocaleString()}
                        </p>
                      </div>

                      <div className="rounded-lg bg-background p-2">
                        <p className="text-muted-foreground">출력</p>
                        <p className="mt-1 font-extrabold">
                          {item.outputTokens.toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={pagination.page <= 1}
                onClick={() =>
                  setCostPage((page) => Math.max(1, page - 1))
                }
                className="inline-flex items-center gap-1 rounded-lg border border-card-border px-3 py-2 text-[10px] font-extrabold disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                이전
              </button>

              <span className="text-[10px] font-extrabold text-muted-foreground">
                {pagination.page} / {pagination.totalPages} 페이지 ·
                총 {pagination.total}건
              </span>

              <button
                type="button"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() =>
                  setCostPage((page) =>
                    Math.min(
                      pagination.totalPages,
                      page + 1,
                    ),
                  )
                }
                className="inline-flex items-center gap-1 rounded-lg border border-card-border px-3 py-2 text-[10px] font-extrabold disabled:opacity-40"
              >
                다음
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => void loadCosts()}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-extrabold text-primary"
            >
              <RefreshCcw className="h-4 w-4" />
               내역 새로고침
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
