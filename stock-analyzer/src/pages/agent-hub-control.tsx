import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';

const SAFETY = [
  ['Execution authority', 'NONE'],
  ['Live trading', 'OFF'],
  ['Private trading API', 'OFF'],
  ['Paid fallback', 'OFF'],
  ['Force push', 'BLOCKED'],
] as const;

type BridgeStatus = {
  configured: boolean;
  executionState: 'NOT_CONFIGURED' | 'CONFIGURED' | 'QUEUED_FOR_COORDINATOR' | 'FAILED_CLOSED';
  repository?: string;
  hubIssue?: number;
  authority?: string;
  commentId?: number | null;
  currentMainSha?: string;
};

function classifyCommand(value: string) {
  const normalized = value.trim().toLowerCase();
  const resume = /^(이어서|계속|continue|resume)/.test(normalized);
  const worker = /차트|chart/.test(normalized)
    ? 'ai-chart'
    : /스캐너|검색기|scanner/.test(normalized)
      ? 'ai-signal-scanner'
      : /브라우저|ui|playwright/.test(normalized)
        ? 'test-runner'
        : /보안|security/.test(normalized)
          ? 'security-inspector'
          : 'integration-planner';
  return { mode: resume ? 'resume' : 'new', worker };
}

async function bridgeRequest(path: string, token: string, init?: RequestInit) {
  const response = await fetch(`/api/admin/agent-hub${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const reason = typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`;
    throw new Error(reason);
  }
  return payload;
}

export default function AgentHubControlPage() {
  const auth = useAuth();
  const token = auth.session?.access_token ?? '';
  const [command, setCommand] = useState('');
  const [status, setStatus] = useState<BridgeStatus>({ configured: false, executionState: 'NOT_CONFIGURED' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const intent = useMemo(() => classifyCommand(command), [command]);

  useEffect(() => {
    if (!auth.isAdmin || !token) return;
    let cancelled = false;
    void bridgeRequest('/status', token)
      .then((payload) => {
        if (cancelled) return;
        setStatus({
          configured: payload.configured === true,
          executionState: payload.executionState === 'CONFIGURED' ? 'CONFIGURED' : 'NOT_CONFIGURED',
          repository: typeof payload.repository === 'string' ? payload.repository : undefined,
          hubIssue: typeof payload.hubIssue === 'number' ? payload.hubIssue : undefined,
          authority: typeof payload.authority === 'string' ? payload.authority : 'NONE',
        });
      })
      .catch(() => {
        if (!cancelled) setStatus({ configured: false, executionState: 'FAILED_CLOSED' });
      });
    return () => { cancelled = true; };
  }, [auth.isAdmin, token]);

  async function submitCommand() {
    const value = command.trim();
    if (!value || busy || !token) return;
    setBusy(true);
    setMessage('');
    try {
      const payload = await bridgeRequest('/commands', token, {
        method: 'POST',
        body: JSON.stringify({ command: value, workerHint: intent.worker }),
      });
      setStatus((previous) => ({
        ...previous,
        configured: true,
        executionState: 'QUEUED_FOR_COORDINATOR',
        commentId: typeof payload.commentId === 'number' ? payload.commentId : null,
        currentMainSha: typeof payload.currentMainSha === 'string' ? payload.currentMainSha : undefined,
      }));
      setMessage('Canonical Agent Hub에 명령을 전달했습니다. Coordinator 검증 대기 상태입니다.');
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'UNKNOWN';
      const notConfigured = reason === 'AGENT_HUB_BRIDGE_NOT_CONFIGURED';
      setStatus((previous) => ({
        ...previous,
        configured: notConfigured ? false : previous.configured,
        executionState: notConfigured ? 'NOT_CONFIGURED' : 'FAILED_CLOSED',
      }));
      setMessage(notConfigured ? '서버 Agent Hub 연결이 아직 설정되지 않았습니다.' : `명령 전달 실패: ${reason}`);
    } finally {
      setBusy(false);
    }
  }

  if (!auth.isAdmin) {
    return <main className="p-6" data-testid="agent-hub-admin-required"><h1 className="text-xl font-bold">관리자 권한이 필요합니다.</h1></main>;
  }

  return (
    <main className="h-full overflow-y-auto bg-background px-4 py-5 pb-28 sm:px-6" data-testid="agent-hub-control">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <header className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent Hub V5</p>
              <h1 className="text-xl font-bold">자동 작업 제어센터</h1>
            </div>
            <span className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-semibold">ADMIN CONTROL</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            명령은 서버의 fail-closed bridge를 통해 canonical Agent Hub로만 전달됩니다. 이 화면에는 Merge, Deploy, DB/Secret, 실주문 권한이 없습니다.
          </p>
        </header>

        <section className="rounded-2xl border border-border bg-card p-4">
          <label className="text-sm font-semibold" htmlFor="agent-hub-command">명령</label>
          <textarea
            id="agent-hub-command"
            className="mt-2 min-h-28 w-full resize-y rounded-xl border border-border bg-background p-3 text-base outline-none focus:ring-2 focus:ring-ring"
            placeholder="예: AI차트 오류 계속 잡고 CI까지 해"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div className="rounded-xl bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Mode</p><p className="font-semibold">{intent.mode}</p></div>
            <div className="rounded-xl bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Worker hint</p><p className="truncate font-semibold">{intent.worker}</p></div>
            <div className="rounded-xl bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Authority</p><p className="font-semibold">{status.authority ?? 'NONE'}</p></div>
            <div className="rounded-xl bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Execution</p><p className="font-semibold" data-testid="agent-hub-execution-state">{status.executionState}</p></div>
          </div>
          <button
            type="button"
            disabled={!command.trim() || busy || !token || status.executionState === 'NOT_CONFIGURED'}
            className="mt-4 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void submitCommand()}
          >
            {busy ? '전달 중...' : 'Agent Hub에 명령 보내기'}
          </button>
          {message ? <p className="mt-3 rounded-xl border border-border bg-muted/30 p-3 text-sm" role="status">{message}</p> : null}
          {status.commentId ? <p className="mt-2 text-xs text-muted-foreground">Hub comment #{status.commentId}</p> : null}
          <p className="mt-2 break-all text-[11px] text-muted-foreground">
            {status.repository ? `${status.repository} · Issue #${status.hubIssue ?? '?'}` : 'Canonical Hub 상태 확인 중'}
            {status.currentMainSha ? ` · main ${status.currentMainSha.slice(0, 12)}` : ''}
          </p>
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">승인 경계</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button type="button" disabled className="rounded-xl border border-border p-3 text-left opacity-60">
              <span className="block font-semibold">Ready / Merge 승인</span>
              <span className="text-xs text-muted-foreground">별도 사람 승인 경계. 이 bridge는 직접 실행하지 않습니다.</span>
            </button>
            <button type="button" disabled className="rounded-xl border border-border p-3 text-left opacity-60">
              <span className="block font-semibold">Staging 승인</span>
              <span className="text-xs text-muted-foreground">별도 명시 승인 필요. 현재 비활성</span>
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">Safety locks</h2>
          <div className="mt-3 divide-y divide-border rounded-xl border border-border">
            {SAFETY.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="text-muted-foreground">{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
