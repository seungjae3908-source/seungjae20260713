import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
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
  changedFiles: ChangedFile[];
  branch?: string;
  commitSha?: string;
  approvalPhrase?: string;
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
  awaiting_approval: "승인 대기",
  applying: "운영 적용 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

function statusTone(status: JobStatus): string {
  if (status === "completed") return "border-positive/40 bg-positive/10 text-positive";
  if (status === "awaiting_approval") return "border-warning/50 bg-warning/10 text-warning";
  if (status === "failed" || status === "cancelled") return "border-destructive/40 bg-destructive/10 text-destructive";
  return "border-primary/40 bg-primary/10 text-primary";
}

function statusIcon(status: JobStatus) {
  if (ACTIVE.has(status)) return <LoaderCircle className="h-4 w-4 animate-spin" />;
  if (status === "completed") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "awaiting_approval") return <ShieldCheck className="h-4 w-4" />;
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

  const submit = async (kind: "diagnosis" | "improvement") => {
    if (kind === "improvement" && request.trim().length < 4) {
      setNotice("개선할 내용을 네 글자 이상 입력해 주세요.");
      return;
    }
    const key = `create-${kind}`;
    setBusyAction(key);
    try {
      const body = await apiJson<{ ok: true; job: RepairJob }>("/api/admin/ai-repair/jobs", {
        method: "POST",
        body: JSON.stringify({ kind, request: kind === "improvement" ? request.trim() : "" }),
      });
      setJobs((current) => [body.job, ...current.filter((item) => item.id !== body.job.id)]);
      setExpandedId(body.job.id);
      if (kind === "improvement") setRequest("");
      setNotice("작업이 Vultr 대기열에 접수되었습니다. 휴대폰을 꺼도 계속 실행됩니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "작업 접수에 실패했습니다.");
    } finally {
      setBusyAction(null);
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
              TypeScript와 프로덕션 빌드를 검사하고, 실패하면 최대 {config?.maxAttempts ?? 5}회까지 안전 수정합니다.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void submit("diagnosis")}
            disabled={!config?.enabled || busyAction !== null}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-extrabold text-primary-foreground disabled:opacity-50"
          >
            {busyAction === "create-diagnosis" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            진단 시작
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
            onClick={() => void submit("improvement")}
            disabled={!config?.enabled || request.trim().length < 4 || busyAction !== null}
            className="inline-flex items-center gap-1.5 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-extrabold text-primary disabled:opacity-50"
          >
            {busyAction === "create-improvement" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Wrench className="h-4 w-4" />
            )}
            개선 작업 시작
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
    </section>
  );
}
