// AI_REPAIR_COST_CONSENT_V1
// AI_REPAIR_LIVE_DIAGNOSTIC_V1
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  DollarSign,
  FileCode2,
  LoaderCircle,
  Play,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
  XCircle,
} from "lucide-react";
import { authorizedFetch } from "@/lib/auth-fetch";
import { cn } from "@/lib/utils";

type JobStatus =
  | "queued"
  | "preparing"
  | "diagnosing"
  | "repairing"
  | "verifying"
  | "awaiting_ai_approval"
  | "awaiting_approval"
  | "applying"
  | "completed"
  | "failed"
  | "cancelled";

type CheckResult = {
  name: string;
  label: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
};


type CurrentCheck = {
  name: string;
  label: string;
  startedAt: string;
};

type DiagnosticError = {
  name: string;
  label: string;
  output: string;
  detectedAt: string;
};

type ChangedFile = {
  path: string;
  explanation: string;
  diff: string;
};

type RepairAttempt = {
  number: number;
  summary?: string;
  findings: string[];
  checks: CheckResult[];
  changes: ChangedFile[];
  error?: string;
};

type RepairJob = {
  id: string;
  kind: "diagnosis" | "improvement";
  title: string;
  request: string;
  status: JobStatus;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  currentAttempt: number;
  maxAttempts: number;
  attempts: RepairAttempt[];
  checks: CheckResult[];
  currentCheck?: CurrentCheck;
  diagnosticErrors?: DiagnosticError[];
  changedFiles: ChangedFile[];
  branch?: string;
  commitSha?: string;
  approvalPhrase?: string;
  costEstimate?: CostEstimate;
  actualCostUsd?: number;
  error?: string;
};

type RepairConfig = {
  enabled: boolean;
  aiConfigured: boolean;
  repositoryReady: boolean;
  deploymentReady: boolean;
  repoPath: string | null;
  baseBranch: string;
  maxAttempts: number;
  checks: Array<{ name: string; label: string }>;
  healthUrl: string | null;
};


type CostEstimate = {
  currency: "USD";
  model: string;
  free: boolean;
  minUsd: number;
  likelyUsd: number;
  maxUsd: number;
  maxAttempts: number;
  note: string;
};

type CostSummary = {
  month: string;
  currency: "USD";
  estimatedCostUsd: number;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  modelRates: {
    model: string;
    inputUsdPerMillion: number;
    cachedInputUsdPerMillion: number;
    outputUsdPerMillion: number;
  };
};

type CostModalState = {
  mode: "create" | "approve-ai";
  kind: "diagnosis" | "improvement";
  request: string;
  jobId?: string;
  estimate: CostEstimate;
};

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  return `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
}

const ACTIVE = new Set<JobStatus>([
  "queued",
  "preparing",
  "diagnosing",
  "repairing",
  "verifying",
  "applying",
]);

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "대기 중",
  preparing: "안전 작업공간 준비",
  diagnosing: "오류 진단 중",
  repairing: "수정 중",
  verifying: "정상 작동 검사 중",
  awaiting_ai_approval: "AI 비용 승인 대기",
  awaiting_approval: "운영 승인 대기",
  applying: "운영 적용 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

function statusTone(status: JobStatus): string {
  if (status === "completed") return "border-positive/40 bg-positive/10 text-positive";
  if (status === "awaiting_ai_approval" || status === "awaiting_approval") {
    return "border-warning/50 bg-warning/10 text-warning";
  }
  if (status === "failed" || status === "cancelled") return "border-destructive/40 bg-destructive/10 text-destructive";
  return "border-primary/40 bg-primary/10 text-primary";
}

function statusIcon(status: JobStatus) {
  if (ACTIVE.has(status)) return <LoaderCircle className="h-4 w-4 animate-spin" />;
  if (status === "completed") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "awaiting_ai_approval" || status === "awaiting_approval") {
    return <ShieldCheck className="h-4 w-4" />;
  }
  if (status === "failed") return <XCircle className="h-4 w-4" />;
  return <CircleAlert className="h-4 w-4" />;
}

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
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
  if (!response.ok) throw new Error(body.message || `요청 실패 (${response.status})`);
  return body;
}

function ConfigBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-extrabold",
        ok
          ? "border-positive/40 bg-positive/10 text-positive"
          : "border-warning/40 bg-warning/10 text-warning",
      )}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}
      {label}
    </span>
  );
}

export function AiRepairCenter() {
  const [config, setConfig] = useState<RepairConfig | null>(null);
  const [jobs, setJobs] = useState<RepairJob[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("aiRepairJob");
  });
  const [request, setRequest] = useState("");
  const [approvalInput, setApprovalInput] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState("서버 연결 확인 중");
  const [costModal, setCostModal] = useState<CostModalState | null>(null);
  const [costOpen, setCostOpen] = useState(false);
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);

  const load = useCallback(async (quiet = false) => {
    try {
      const [configBody, jobsBody] = await Promise.all([
        apiJson<{ ok: true; config: RepairConfig }>("/api/admin/ai-repair/config"),
        apiJson<{ ok: true; jobs: RepairJob[] }>("/api/admin/ai-repair/jobs?limit=20"),
      ]);
      setConfig(configBody.config);
      setJobs(jobsBody.jobs);
      if (!quiet) setNotice("Vultr 작업 서버와 연결되었습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "AI 복구센터 연결에 실패했습니다.");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(true), 5_000);
    return () => window.clearInterval(id);
  }, [load]);

  const activeCount = useMemo(
    () => jobs.filter((job) => ACTIVE.has(job.status)).length,
    [jobs],
  );

  const loadCosts = useCallback(async () => {
    const body = await apiJson<{ ok: true; summary: CostSummary }>(
      "/api/admin/ai-repair/costs",
    );
    setCostSummary(body.summary);
  }, []);

  const openCostEstimate = async (
    kind: "diagnosis" | "improvement",
    job?: RepairJob,
  ) => {
    const selectedRequest =
      kind === "improvement"
        ? request.trim()
        : job?.request ?? "";

    if (kind === "improvement" && selectedRequest.length < 4) {
      setNotice("개선할 내용을 네 글자 이상 입력해 주세요.");
      return;
    }

    const key = `estimate-${job?.id ?? kind}`;
    setBusyAction(key);

    try {
      const body = await apiJson<{
        ok: true;
        estimate: CostEstimate;
      }>("/api/admin/ai-repair/estimate", {
        method: "POST",
        body: JSON.stringify({
          kind,
          request: selectedRequest,
          jobId: job?.id,
        }),
      });

      setCostModal({
        mode: job ? "approve-ai" : "create",
        kind,
        request: selectedRequest,
        jobId: job?.id,
        estimate: body.estimate,
      });
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "예상 비용 계산에 실패했습니다.",
      );
    } finally {
      setBusyAction(null);
    }
  };

  const confirmCostAction = async () => {
    const modal = costModal;

    if (!modal) return;

    setBusyAction("confirm-cost");

    try {
      if (modal.mode === "create") {
        const body = await apiJson<{
          ok: true;
          job: RepairJob;
        }>("/api/admin/ai-repair/jobs", {
          method: "POST",
          body: JSON.stringify({
            kind: modal.kind,
            request: modal.request,
            costConsent: !modal.estimate.free,
          }),
        });

        setJobs((current) => [
          body.job,
          ...current.filter((item) => item.id !== body.job.id),
        ]);
        setExpandedId(body.job.id);

        if (modal.kind === "improvement") {
          setRequest("");
        }

        setNotice(
          modal.estimate.free
            ? "무료 진단이 시작되었습니다. 오류가 발견돼도 AI 수정은 별도 승인 전까지 실행되지 않습니다."
            : "예상 비용 확인 후 AI 개선 작업이 시작되었습니다.",
        );
      } else if (modal.jobId) {
        const body = await apiJson<{
          ok: true;
          job: RepairJob;
        }>(
          `/api/admin/ai-repair/jobs/${encodeURIComponent(modal.jobId)}/approve-ai`,
          {
            method: "POST",
            body: JSON.stringify({ costConsent: true }),
          },
        );

        setJobs((current) =>
          current.map((item) =>
            item.id === body.job.id ? body.job : item,
          ),
        );

        setNotice(
          "예상 비용을 확인했습니다. 유료 AI 수정 작업이 시작되었습니다.",
        );
      }

      setCostModal(null);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "비용 승인 작업에 실패했습니다.",
      );
    } finally {
      setBusyAction(null);
    }
  };

  const toggleCosts = async () => {
    if (!costOpen) {
      setBusyAction("load-costs");

      try {
        await loadCosts();
        setCostOpen(true);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "비용 내역 조회에 실패했습니다.",
        );
      } finally {
        setBusyAction(null);
      }
    } else {
      setCostOpen(false);
    }
  };

  const approve = async (job: RepairJob) => {
    const phrase = approvalInput[job.id]?.trim() ?? "";
    const key = `approve-${job.id}`;
    setBusyAction(key);
    try {
      const body = await apiJson<{ ok: true; job: RepairJob }>(
        `/api/admin/ai-repair/jobs/${encodeURIComponent(job.id)}/approve`,
        { method: "POST", body: JSON.stringify({ approvalPhrase: phrase }) },
      );
      setJobs((current) => current.map((item) => (item.id === job.id ? body.job : item)));
      setNotice("운영 적용 승인이 접수되었습니다. 서버가 배포 후 재검사합니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "승인 요청에 실패했습니다.");
    } finally {
      setBusyAction(null);
    }
  };

  const cancel = async (job: RepairJob) => {
    if (!window.confirm("이 AI 복구 작업을 중단할까요?")) return;
    const key = `cancel-${job.id}`;
    setBusyAction(key);
    try {
      const body = await apiJson<{ ok: true; job: RepairJob }>(
        `/api/admin/ai-repair/jobs/${encodeURIComponent(job.id)}/cancel`,
        { method: "POST", body: "{}" },
      );
      setJobs((current) => current.map((item) => (item.id === job.id ? body.job : item)));
      setNotice("작업 중단을 요청했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "중단 요청에 실패했습니다.");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="rounded-3xl border border-primary/30 bg-card p-4 text-left shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Bot className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-extrabold">AI 진단 · 복구 센터</h2>
            <span className="rounded-full bg-destructive/10 px-2 py-1 text-[9px] font-extrabold text-destructive">
              관리자 전용
            </span>
          </div>
          <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
            별도 작업공간에서 오류를 반복 수정하고 검사를 모두 통과하면 푸시 알림을 보냅니다. 승인 전에는 운영 코드에 적용하지 않습니다.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <ConfigBadge ok={config?.enabled === true} label="복구 엔진" />
        <ConfigBadge ok={config?.aiConfigured === true} label="AI 연결" />
        <ConfigBadge ok={config?.repositoryReady === true} label="Git 작업공간" />
        <ConfigBadge ok={config?.deploymentReady === true} label="승인 배포" />
      </div>

      <div className="mt-3 rounded-2xl border border-card-border bg-background p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-extrabold">전체 오류 진단</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              무료로 TypeScript·빌드·격리 서버만 검사합니다. 오류가 발견돼도 유료 AI 수정은 별도 승인 전까지 실행하지 않습니다.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void openCostEstimate("diagnosis")}
            disabled={!config?.enabled || busyAction !== null}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-extrabold text-primary-foreground disabled:opacity-50"
          >
            {busyAction === "create-diagnosis" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            무료 진단 시작
          </button>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-card-border bg-background p-3">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <p className="text-xs font-extrabold">개선 요청</p>
        </div>
        <textarea
          value={request}
          onChange={(event) => setRequest(event.target.value.slice(0, 4_000))}
          rows={4}
          placeholder="예: PC 차트는 더 크게 보이게 하고 모바일에서는 외부 창 버튼을 숨겨줘."
          className="w-full resize-y rounded-xl border border-card-border bg-card px-3 py-2 text-xs leading-relaxed outline-none focus:border-primary"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold text-muted-foreground">{request.length}/4,000자</span>
          <button
            type="button"
            onClick={() => void openCostEstimate("improvement")}
            disabled={!config?.enabled || request.trim().length < 4 || busyAction !== null}
            className="inline-flex items-center gap-1.5 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-extrabold text-primary disabled:opacity-50"
          >
            {busyAction === "create-improvement" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Wrench className="h-4 w-4" />
            )}
            비용 확인 후 시작
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-secondary/60 px-3 py-2">
        <p className="break-keep text-[11px] font-bold leading-relaxed text-muted-foreground">
          {notice} {activeCount > 0 ? `현재 실행 중 ${activeCount}건` : ""}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="shrink-0 rounded-lg p-1.5 text-primary"
          aria-label="AI 복구 작업 새로고침"
        >
          <RefreshCcw className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 space-y-2">
        {jobs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-card-border p-5 text-center text-xs text-muted-foreground">
            아직 AI 진단 작업이 없습니다.
          </div>
        ) : (
          jobs.map((job) => {
            const expanded = expandedId === job.id;
            return (
              <article key={job.id} className="overflow-hidden rounded-2xl border border-card-border bg-background">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : job.id)}
                  className="flex w-full items-start gap-2 p-3 text-left"
                >
                  <span className={cn("mt-0.5 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-extrabold", statusTone(job.status))}>
                    {statusIcon(job.status)}
                    {STATUS_LABEL[job.status]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-extrabold">{job.title}</span>
                    <span className="mt-1 block break-keep text-[10px] leading-relaxed text-muted-foreground">
                      {job.message} · {formatDate(job.updatedAt)}
                    </span>
                  </span>
                  {expanded ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                </button>

                <div className="h-1.5 bg-secondary">
                  <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(2, job.progress)}%` }} />
                </div>

                {expanded && (
                  <div className="space-y-3 border-t border-card-border p-3">
                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                      <div className="rounded-xl bg-card p-2">
                        <p className="text-muted-foreground">작업 번호</p>
                        <p className="mt-1 break-all font-extrabold">{job.id}</p>
                      </div>
                      <div className="rounded-xl bg-card p-2">
                        <p className="text-muted-foreground">수정 반복</p>
                        <p className="mt-1 font-extrabold">{job.currentAttempt}/{job.maxAttempts}회</p>
                      </div>
                    </div>

                    {job.request && (
                      <div className="rounded-xl bg-card p-2.5">
                        <p className="text-[10px] font-extrabold text-muted-foreground">요청 내용</p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed">{job.request}</p>
                      </div>
                    )}

                    {job.currentCheck && (
                      <div className="rounded-2xl border border-primary/40 bg-primary/10 p-3">
                        <p className="flex items-center gap-2 text-xs font-extrabold text-primary">
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                          현재 진단 중
                        </p>

                        <p className="mt-2 text-sm font-black">
                          {job.currentCheck.label}
                        </p>

                        <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                          시작 시각 {formatDate(job.currentCheck.startedAt)}
                        </p>
                      </div>
                    )}

                    {(job.diagnosticErrors?.length ?? 0) > 0 && (
                      <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-3">
                        <p className="flex items-center gap-2 text-xs font-extrabold text-destructive">
                          <CircleAlert className="h-4 w-4" />
                          현재까지 발견된 오류 {job.diagnosticErrors?.length ?? 0}개
                        </p>

                        <div className="mt-2 space-y-2">
                          {job.diagnosticErrors?.map((error) => (
                            <details
                              key={`${error.name}-${error.detectedAt}`}
                              className="rounded-xl border border-destructive/30 bg-background p-2"
                            >
                              <summary className="cursor-pointer list-none text-[11px] font-extrabold text-destructive">
                                {error.label}
                              </summary>

                              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-card p-2 text-[9px] leading-relaxed">
                                {error.output || "오류 출력 없음"}
                              </pre>
                            </details>
                          ))}
                        </div>
                      </div>
                    )}

                    {job.checks.length > 0 && (
                      <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
                        <div className="rounded-xl bg-card p-2">
                          <p className="text-muted-foreground">전체 점검</p>
                          <p className="mt-1 text-sm font-black">
                            {job.checks.length}
                          </p>
                        </div>

                        <div className="rounded-xl bg-positive/10 p-2">
                          <p className="text-positive">정상</p>
                          <p className="mt-1 text-sm font-black text-positive">
                            {job.checks.filter((check) => check.ok).length}
                          </p>
                        </div>

                        <div className="rounded-xl bg-destructive/10 p-2">
                          <p className="text-destructive">오류</p>
                          <p className="mt-1 text-sm font-black text-destructive">
                            {job.checks.filter((check) => !check.ok).length}
                          </p>
                        </div>
                      </div>
                    )}

                    {job.error && (
                      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                        <p className="font-extrabold">오류</p>
                        <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{job.error}</p>
                      </div>
                    )}

                    {job.checks.length > 0 && (
                      <div>
                        <p className="mb-2 text-xs font-extrabold">최종 검사 결과</p>
                        <div className="space-y-1.5">
                          {job.checks.map((check) => (
                            <details key={check.name} className="rounded-xl border border-card-border bg-card p-2">
                              <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-extrabold">
                                {check.ok ? <CheckCircle2 className="h-4 w-4 text-positive" /> : <XCircle className="h-4 w-4 text-destructive" />}
                                <span className="flex-1">{check.label}</span>
                                <span className="text-muted-foreground">{Math.round(check.durationMs / 1000)}초</span>
                              </summary>
                              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-2 text-[9px] leading-relaxed text-muted-foreground">{check.output || "출력 없음"}</pre>
                            </details>
                          ))}
                        </div>
                      </div>
                    )}

                    {job.changedFiles.length > 0 && (
                      <div>
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-extrabold">
                          <FileCode2 className="h-4 w-4" /> 변경 파일 {job.changedFiles.length}개
                        </p>
                        <div className="space-y-1.5">
                          {job.changedFiles.map((file) => (
                            <details key={file.path} className="rounded-xl border border-card-border bg-card p-2">
                              <summary className="cursor-pointer list-none break-all text-[11px] font-extrabold text-primary">{file.path}</summary>
                              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{file.explanation}</p>
                              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-2 text-[9px] leading-relaxed">{file.diff || "변경 비교 없음"}</pre>
                            </details>
                          ))}
                        </div>
                      </div>
                    )}

                    {job.branch && (
                      <p className="break-all rounded-xl bg-card p-2 text-[10px] font-bold text-muted-foreground">
                        검증 브랜치: {job.branch}{job.commitSha ? ` · ${job.commitSha.slice(0, 12)}` : ""}
                      </p>
                    )}

                    {job.status === "awaiting_ai_approval" && (
                      <div className="rounded-2xl border border-warning/50 bg-warning/10 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-extrabold text-warning">
                          <DollarSign className="h-4 w-4" />
                          무료 진단 완료 · 유료 AI 수정은 별도 승인 필요
                        </p>

                        <p className="mt-1 break-keep text-[10px] leading-relaxed text-muted-foreground">
                          현재 검사 결과만 저장됐습니다. 아래 버튼을 눌러 예상 비용을 확인한 뒤에만 OpenAI 수정 작업이 시작됩니다.
                        </p>

                        {job.costEstimate && (
                          <p className="mt-2 rounded-xl bg-background p-2 text-center text-xs font-extrabold">
                            예상 {formatUsd(job.costEstimate.minUsd)}~{formatUsd(job.costEstimate.maxUsd)}
                          </p>
                        )}

                        <button
                          type="button"
                          onClick={() => void openCostEstimate(job.kind, job)}
                          disabled={busyAction !== null}
                          className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-warning px-3 py-2.5 text-xs font-extrabold text-warning-foreground disabled:opacity-50"
                        >
                          <DollarSign className="h-4 w-4" />
                          예상 비용 확인 후 AI 수정 시작
                        </button>
                      </div>
                    )}

                    {job.status === "awaiting_approval" && (
                      <div className="rounded-2xl border border-warning/50 bg-warning/10 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-extrabold text-warning">
                          <ShieldCheck className="h-4 w-4" /> 정상 작동 확인 완료 · 운영 적용 승인 필요
                        </p>
                        <p className="mt-1 break-keep text-[10px] leading-relaxed text-muted-foreground">
                          변경 파일과 검사 결과를 확인한 뒤 아래 승인 문구를 그대로 입력하세요.
                        </p>
                        <code className="mt-2 block rounded-lg bg-background px-2 py-1.5 text-center text-xs font-extrabold">{job.approvalPhrase}</code>
                        <input
                          value={approvalInput[job.id] ?? ""}
                          onChange={(event) => setApprovalInput((current) => ({ ...current, [job.id]: event.target.value }))}
                          placeholder="승인 문구 입력"
                          className="mt-2 w-full rounded-xl border border-card-border bg-background px-3 py-2 text-xs outline-none focus:border-warning"
                        />
                        <button
                          type="button"
                          onClick={() => void approve(job)}
                          disabled={busyAction !== null || approvalInput[job.id]?.trim() !== job.approvalPhrase}
                          className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-warning px-3 py-2.5 text-xs font-extrabold text-warning-foreground disabled:opacity-50"
                        >
                          {busyAction === `approve-${job.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                          운영 적용 승인
                        </button>
                      </div>
                    )}

                    {ACTIVE.has(job.status) && (
                      <button
                        type="button"
                        onClick={() => void cancel(job)}
                        disabled={busyAction !== null}
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-extrabold text-destructive disabled:opacity-50"
                      >
                        {busyAction === `cancel-${job.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                        작업 중단
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>

      <div className="mt-4 rounded-2xl border border-card-border bg-background p-3">
        <button
          type="button"
          onClick={() => void toggleCosts()}
          disabled={busyAction === "load-costs"}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="flex items-center gap-2 text-xs font-extrabold">
            <DollarSign className="h-4 w-4 text-primary" />
            발생 비용 보기
          </span>

          <span className="text-xs font-extrabold text-primary">
            {costSummary
              ? formatUsd(costSummary.estimatedCostUsd)
              : "월 누적 확인"}
          </span>
        </button>

        {costOpen && costSummary && (
          <div className="mt-3 space-y-2 border-t border-card-border pt-3 text-xs">
            <div className="flex items-center justify-between rounded-xl bg-card p-3">
              <span className="font-bold text-muted-foreground">
                {costSummary.month} 월 누적 예상금액
              </span>
              <span className="text-lg font-black text-primary">
                {formatUsd(costSummary.estimatedCostUsd)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div className="rounded-xl bg-card p-2">
                <p className="text-muted-foreground">OpenAI 호출</p>
                <p className="mt-1 font-extrabold">
                  {costSummary.calls.toLocaleString()}회
                </p>
              </div>

              <div className="rounded-xl bg-card p-2">
                <p className="text-muted-foreground">입력 / 출력 토큰</p>
                <p className="mt-1 font-extrabold">
                  {costSummary.inputTokens.toLocaleString()} /
                  {" "}
                  {costSummary.outputTokens.toLocaleString()}
                </p>
              </div>
            </div>

            <p className="break-keep text-[10px] leading-relaxed text-muted-foreground">
              실제 API 응답의 사용 토큰을 기준으로 계산한 예상금액입니다.
              최종 청구액은 OpenAI 사용내역과 소수점 처리에 따라 조금 다를 수 있습니다.
            </p>

            <button
              type="button"
              onClick={() => void loadCosts()}
              className="w-full rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-extrabold text-primary"
            >
              비용 새로고침
            </button>
          </div>
        )}
      </div>

      {costModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-3xl border border-card-border bg-card p-5 shadow-2xl">
            <div className="flex items-center gap-2">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <DollarSign className="h-5 w-5" />
              </span>

              <div>
                <p className="text-sm font-black">
                  {costModal.estimate.free
                    ? "무료 진단 확인"
                    : "예상 비용 확인"}
                </p>
                <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                  모델: {costModal.estimate.model}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-2xl bg-background p-4 text-center">
              {costModal.estimate.free ? (
                <>
                  <p className="text-2xl font-black text-positive">$0.00</p>
                  <p className="mt-1 text-xs font-bold text-positive">
                    OpenAI 호출 없는 무료 검사
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs font-bold text-muted-foreground">
                    가장 가능성 높은 예상금액
                  </p>
                  <p className="mt-1 text-2xl font-black text-primary">
                    {formatUsd(costModal.estimate.likelyUsd)}
                  </p>
                  <p className="mt-2 text-xs font-extrabold">
                    예상 범위 {formatUsd(costModal.estimate.minUsd)}
                    {" ~ "}
                    {formatUsd(costModal.estimate.maxUsd)}
                  </p>
                </>
              )}
            </div>

            {costModal.request && (
              <div className="mt-3 max-h-28 overflow-y-auto rounded-xl border border-card-border bg-background p-3">
                <p className="text-[10px] font-extrabold text-muted-foreground">
                  요청 내용
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed">
                  {costModal.request}
                </p>
              </div>
            )}

            <p className="mt-3 break-keep text-[11px] leading-relaxed text-muted-foreground">
              {costModal.estimate.note}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCostModal(null)}
                disabled={busyAction === "confirm-cost"}
                className="rounded-xl border border-card-border px-3 py-3 text-xs font-extrabold disabled:opacity-50"
              >
                취소
              </button>

              <button
                type="button"
                onClick={() => void confirmCostAction()}
                disabled={busyAction === "confirm-cost"}
                className="rounded-xl bg-primary px-3 py-3 text-xs font-extrabold text-primary-foreground disabled:opacity-50"
              >
                {busyAction === "confirm-cost"
                  ? "처리 중..."
                  : costModal.estimate.free
                    ? "무료 진단 시작"
                    : "확인 후 시작"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
