import { useMemo, useState } from 'react';

const SAFETY = [
  ['Execution authority', 'NONE'],
  ['Live trading', 'OFF'],
  ['Private trading API', 'OFF'],
  ['Paid fallback', 'OFF'],
  ['Force push', 'BLOCKED'],
] as const;

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

export default function AgentHubControlPage() {
  const [command, setCommand] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const intent = useMemo(() => classifyCommand(command), [command]);

  return (
    <main className="h-full overflow-y-auto bg-background px-4 py-5 pb-28 sm:px-6" data-testid="agent-hub-control">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <header className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent Hub V5</p>
              <h1 className="text-xl font-bold">자동 작업 제어센터</h1>
            </div>
            <span className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-semibold">CONTROL ONLY</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            짧은 자연어 명령을 안전한 intent로 준비합니다. 이 화면 자체에는 Merge, Deploy, DB/Secret, 실주문 권한이 없습니다.
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
            <div className="rounded-xl bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Authority</p><p className="font-semibold">NONE</p></div>
            <div className="rounded-xl bg-muted/50 p-3"><p className="text-xs text-muted-foreground">Execution</p><p className="font-semibold">NOT_CONNECTED</p></div>
          </div>
          <button
            type="button"
            disabled={!command.trim()}
            className="mt-4 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => setSubmitted(command.trim())}
          >
            Intent 준비
          </button>
          {submitted ? (
            <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3 text-sm" role="status">
              <p className="font-semibold">Intent 준비 완료</p>
              <p className="mt-1 break-words text-muted-foreground">{submitted}</p>
              <p className="mt-2 text-xs text-muted-foreground">실제 실행은 기존 Coordinator + Policy Engine 연결이 확인된 경우에만 허용됩니다.</p>
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-bold">승인 경계</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button type="button" disabled className="rounded-xl border border-border p-3 text-left opacity-60">
              <span className="block font-semibold">Ready / Merge 승인</span>
              <span className="text-xs text-muted-foreground">Task가 waiting_approval이고 서버 연결이 검증된 경우에만 활성화</span>
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
