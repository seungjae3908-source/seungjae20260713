import { useState } from 'react';
import { BrainCircuit, ShieldCheck } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';

type PortfolioReply = {
  result?: {
    ai?: { answer?: string };
    assistantContext?: {
      dataQuality?: string;
      asOf?: string | null;
      evidence?: unknown[];
      warnings?: string[];
      facts?: unknown;
    };
    safety?: Record<string, unknown>;
  };
  code?: string;
  message?: string;
};

function formatBasisTime(value: string | null | undefined): string {
  if (!value) return '미제공';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '미제공';
  return date.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function PortfolioAiDiagnosis() {
  const [question, setQuestion] = useState('내 포트폴리오를 요약해줘');
  const [reply, setReply] = useState<PortfolioReply | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');

  async function askPortfolio() {
    if (!question.trim() || loading) return;
    setLoading(true);
    setFailure('');
    try {
      const response = await authorizedFetch('/api/paper-journal/portfolio-advisor/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: question.trim() }),
      });
      const payload = await response.json().catch(() => null) as PortfolioReply | null;
      if (!response.ok || !payload?.result) {
        throw new Error(payload?.message || payload?.code || '포트폴리오 답변을 받지 못했습니다.');
      }
      setReply(payload);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : '포트폴리오 요청에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  const context = reply?.result?.assistantContext;

  return <section
    id="portfolio-ai-diagnosis"
    data-testid="portfolio-ai-diagnosis"
    className="scroll-mt-4 rounded-3xl border border-primary/20 bg-card p-4 shadow-sm"
  >
    <div className="flex items-start gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <BrainCircuit className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-extrabold text-primary">Gemini Free → Groq Free</p>
        <h2 className="mt-1 text-lg font-black">AI 포트폴리오 진단</h2>
        <p className="mt-1 text-xs font-bold leading-5 text-muted-foreground">
          Portfolio Intelligence가 계산한 canonical facts만 AI가 설명합니다. 금액·수익률·위험 수치를 새로 만들거나 주문을 실행하지 않습니다.
        </p>
      </div>
      <span className="hidden items-center gap-1 rounded-full bg-muted/60 px-2 py-1 text-[10px] font-black text-muted-foreground sm:flex">
        <ShieldCheck className="h-3 w-3" /> 읽기 전용
      </span>
    </div>

    <div className="mt-4 flex gap-2">
      <input
        aria-label="포트폴리오 AI 질문"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2.5 text-sm"
        placeholder="내 포트폴리오의 위험을 설명해줘"
      />
      <button
        type="button"
        onClick={() => void askPortfolio()}
        disabled={loading || !question.trim()}
        className="min-h-11 shrink-0 rounded-xl bg-primary px-4 py-2 text-sm font-black text-primary-foreground disabled:opacity-40"
      >
        {loading ? '분석 중' : 'AI 진단'}
      </button>
    </div>

    <div className="mt-2 flex flex-wrap gap-2">
      {['내 포트폴리오를 요약해줘', '가장 큰 집중 위험은?', 'BTC가 10% 하락하면?'].map((sample) => <button
        type="button"
        key={sample}
        onClick={() => setQuestion(sample)}
        className="min-h-9 rounded-full border border-border px-3 py-1.5 text-[11px] font-bold"
      >{sample}</button>)}
    </div>

    {failure ? <p role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-sm font-bold text-destructive">{failure}</p> : null}

    {reply?.result ? <div className="mt-3 space-y-3 rounded-2xl border border-border bg-background/60 p-4" data-testid="portfolio-ai-diagnosis-result">
      <p className="whitespace-pre-wrap text-sm leading-6">{reply.result.ai?.answer || '설명 응답이 없습니다.'}</p>
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="rounded-full bg-primary/10 px-2 py-1 font-bold">{context?.dataQuality || 'NOT_AVAILABLE'}</span>
        <span className="rounded-full bg-muted px-2 py-1">기준 {formatBasisTime(context?.asOf)}</span>
        <span className="rounded-full bg-muted px-2 py-1">읽기 전용 · 주문 권한 없음</span>
      </div>
      <details className="rounded-xl border border-border p-3 text-xs">
        <summary className="cursor-pointer font-extrabold">근거 · 누락 데이터 보기</summary>
        <pre className="mt-3 max-w-full overflow-x-auto whitespace-pre-wrap break-words text-[11px]">{JSON.stringify({
          provenance: context?.evidence ?? [],
          warnings: context?.warnings ?? [],
          facts: context?.facts ?? null,
          safety: reply.result.safety ?? {},
        }, null, 2)}</pre>
      </details>
    </div> : null}
  </section>;
}
