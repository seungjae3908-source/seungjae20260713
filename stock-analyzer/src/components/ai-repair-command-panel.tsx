// AI_REPAIR_COMMAND_PANEL_V2
import {
  Bot,
  CheckCircle2,
  Clipboard,
  LoaderCircle,
  Wrench,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { authorizedFetch } from "@/lib/auth-fetch";

type RepairJob = {
  id: string;
  request: string;
  status: string;
  diagnosticErrors?: Array<{
    name: string;
    label: string;
    output: string;
  }>;
  checks: Array<{
    name: string;
    label: string;
    ok: boolean;
    output: string;
  }>;
};

type CommandResult = {
  ok: true;
  mode: "diagnosis" | "repair";
  command: string;
  jobId: string | null;
  aiApiCalled: false;
  estimatedCostUsd: 0;
};

const ACTIVE_STATUSES = new Set([
  "queued",
  "preparing",
  "diagnosing",
  "repairing",
  "verifying",
  "applying",
]);

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

function errorCount(job: RepairJob): number {
  const diagnosticCount = job.diagnosticErrors?.length ?? 0;

  if (diagnosticCount > 0) {
    return diagnosticCount;
  }

  return job.checks.filter((check) => !check.ok).length;
}

export function AiRepairCommandPanel() {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState<
    "diagnosis" | "repair" | "copy" | null
  >(null);
  const [notice, setNotice] = useState(
    "AI API 호출 없이 무료로 명령어를 생성합니다.",
  );
  const [modal, setModal] = useState<{
    title: string;
    command: string;
    automatic: boolean;
  } | null>(null);

  const processedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(
          "ai-repair-auto-command-jobs",
        ) || "[]",
      ) as unknown;

      if (Array.isArray(saved)) {
        processedRef.current = new Set(
          saved.map(String).slice(-100),
        );
      }
    } catch {
      processedRef.current = new Set();
    }
  }, []);

  const rememberProcessed = useCallback((jobId: string) => {
    processedRef.current.add(jobId);

    try {
      window.localStorage.setItem(
        "ai-repair-auto-command-jobs",
        JSON.stringify(
          Array.from(processedRef.current).slice(-100),
        ),
      );
    } catch {
      // 브라우저 저장 실패는 명령어 생성을 막지 않습니다.
    }
  }, []);

  const generateCommand = useCallback(
    async (
      mode: "diagnosis" | "repair",
      job?: RepairJob,
      automatic = false,
    ) => {
      setBusy(mode);

      try {
        const body = await apiJson<CommandResult>(
          "/api/admin/ai-repair/command",
          {
            method: "POST",
            body: JSON.stringify({
              mode,
              request: request.trim(),
              jobId: job?.id,
            }),
          },
        );

        const count = job ? errorCount(job) : 0;

        setModal({
          title:
            mode === "diagnosis"
              ? "진단 명령어"
              : automatic
                ? `오류 ${count}개 복구 명령어`
                : "복구 명령어",
          command: body.command,
          automatic,
        });

        setNotice(
          automatic
            ? `오류 ${count}개가 발견되어 복구 명령어를 자동 생성했습니다.`
            : "명령어가 생성되었습니다. 비용은 발생하지 않았습니다.",
        );
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "명령어 생성에 실패했습니다.",
        );
      } finally {
        setBusy(null);
      }
    },
    [request],
  );

  useEffect(() => {
    let stopped = false;

    const scan = async () => {
      try {
        const body = await apiJson<{
          ok: true;
          jobs: RepairJob[];
        }>(
          "/api/admin/ai-repair/jobs?page=1&pageSize=10",
        );

        if (stopped || modal || busy) {
          return;
        }

        const target = body.jobs.find(
          (job) =>
            !ACTIVE_STATUSES.has(job.status) &&
            errorCount(job) > 0 &&
            !processedRef.current.has(job.id),
        );

        if (!target) {
          return;
        }

        rememberProcessed(target.id);
        await generateCommand("repair", target, true);
      } catch {
        // 자동 확인 실패는 기존 진단 기능에 영향을 주지 않습니다.
      }
    };

    void scan();
    const timer = window.setInterval(
      () => void scan(),
      5_000,
    );

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    busy,
    generateCommand,
    modal,
    rememberProcessed,
  ]);

  const copyCommand = async () => {
    if (!modal) {
      return;
    }

    setBusy("copy");

    try {
      await navigator.clipboard.writeText(modal.command);
      setNotice(
        "명령어를 복사했습니다. ChatGPT에 붙여넣으세요.",
      );
    } catch {
      setNotice(
        "자동 복사가 차단됐습니다. 명령어를 직접 선택해 복사하세요.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section className="mt-3 rounded-2xl border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-start gap-2">
          <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />

          <div className="min-w-0 flex-1">
            <p className="text-xs font-extrabold">
              무료 ChatGPT 명령어
            </p>

            <p className="mt-1 break-keep text-[10px] leading-relaxed text-muted-foreground">
              앱에서 AI API를 호출하지 않습니다. 생성 비용은
              0원이며 오류가 발견되면 복구 명령어가 자동으로
              생성됩니다.
            </p>
          </div>
        </div>

        <textarea
          value={request}
          onChange={(event) =>
            setRequest(event.target.value.slice(0, 4_000))
          }
          rows={3}
          placeholder="추가로 진단하거나 수정할 내용을 입력하세요."
          className="mt-3 w-full resize-y rounded-xl border border-card-border bg-background px-3 py-2 text-xs leading-relaxed outline-none focus:border-primary"
        />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() =>
              void generateCommand("diagnosis")
            }
            disabled={busy !== null}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-primary/40 bg-background px-3 py-2.5 text-xs font-extrabold text-primary disabled:opacity-50"
          >
            {busy === "diagnosis" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Bot className="h-4 w-4" />
            )}
            진단 명령어 만들기
          </button>

          <button
            type="button"
            onClick={() =>
              void generateCommand("repair")
            }
            disabled={busy !== null}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2.5 text-xs font-extrabold text-primary-foreground disabled:opacity-50"
          >
            {busy === "repair" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Wrench className="h-4 w-4" />
            )}
            복구 명령어 만들기
          </button>
        </div>

        <p className="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-positive" />
          {notice}
        </p>
      </section>

      {modal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-3xl border border-card-border bg-card p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-black">
                  {modal.title}
                </p>

                <p className="mt-1 text-[10px] font-bold text-positive">
                  AI API 호출 없음 · 발생 비용 없음
                </p>
              </div>

              <button
                type="button"
                onClick={() => setModal(null)}
                className="rounded-xl border border-card-border p-2"
                aria-label="명령어 창 닫기"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {modal.automatic && (
              <p className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs font-extrabold text-warning">
                오류가 발견되어 수정 요청 명령어를 자동
                생성했습니다.
              </p>
            )}

            <textarea
              readOnly
              value={modal.command}
              rows={18}
              className="mt-3 w-full resize-y rounded-2xl border border-card-border bg-background p-3 text-xs leading-relaxed outline-none"
            />

            <button
              type="button"
              onClick={() => void copyCommand()}
              disabled={busy !== null}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-3 text-xs font-extrabold text-primary-foreground disabled:opacity-50"
            >
              {busy === "copy" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Clipboard className="h-4 w-4" />
              )}
              ChatGPT 명령어 복사하기
            </button>
          </div>
        </div>
      )}
    </>
  );
}
