import { useState } from 'react';
import { BrainCircuit, ShieldAlert, ShieldCheck } from 'lucide-react';
import { InvestmentExplanationButton } from '@/components/investment-explanation-sheet';
import { authorizedFetch } from '@/lib/auth-fetch';

type PortfolioReply = {
  result?: {
    intent?: string;
    ai?: {
      answer?: string;
      kind?: 'answer' | 'refusal';
      model?: string | null;
      generatedAt?: string;
      data?: {
        status?: string;
        asOf?: string | null;
        basis?: string;
        sources?: string[];
        missing?: string[];
      };
    };
    assistantContext?: {
      dataQuality?: string;
      asOf?: string | null;
      evidence?: unknown[];
      warnings?: string[];
      facts?: unknown;
    };
    safety?: Record<string, unknown>;
  };
  sourceOfTruth?: string;
  providerBridgeStatus?: string;
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

function evidenceLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    for (const key of ['source', 'provider', 'kind', 'type', 'code']) {
      if (typeof row[key] === 'string' && row[key]) return row[key] as string;
    }
  }
  try {
    const encoded = JSON.stringify(value) ?? String(value);
    return encoded.length > 160 ? `${encoded.slice(0, 157)}...` : encoded;
  } catch {
    return '근거 항목';
  }
}

function dataBasisLabel(value: string | undefined): string {
  return value === 'server_collection_time' ? '서버 수집 시각' : value || '기준 미제공';
}

function qualityLabel(value: string | undefined): string {
  if (value === 'READY' || value === 'LIVE' || value === 'OK') return '확인된 데이터 기준';
  if (value === 'PARTIAL') return '일부 데이터 부족';
  if (value === 'NOT_AVAILABLE' || value === 'UNAVAILABLE') return '판단 근거 부족';
  return value || '상태 미제공';
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
      setReply(null);
      setFailure(cause instanceof Error ? cause.message : '포트폴리오 요청에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  const context = reply?.result?.assistantContext;
  const aiData = reply?.result?.ai?.data;
  const warnings = [...new Set([...(context?.warnings ?? []), ...(aiData?.missing ?? [])])];
  const evidence = context?.evidence ?? [];
  const partial = context?.dataQuality === 'PARTIAL' || context?.dataQuality === 'NOT_AVAILABLE' || warnings.length > 0;
  const actionChecks = warnings.slice(0, 3);

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
        <p className="text-xs font-extrabold text-primary">Portfolio Copilot · 기존 AI provider seam</p>
        <h2 className="mt-1 text-lg font-black">AI Portfolio Mentor</h2>
        <p className="mt-1 text-xs font-bold leading-5 text-muted-foreground">
          Portfolio Intelligence의 canonical facts만 설명합니다. AI가 금액·수익률·위험 수치를 새로 계산하거나 누락값을 보정하지 않으며 주문도 실행하지 않습니다.
        </p>
      </div>
      <span className="hidden items-center gap-1 rounded-full bg-muted/60 px-2 py-1 text-[10px] font-black text-muted-foreground sm:flex">
        <ShieldCheck className="h-3 w-3" /> 읽기 전용
      </span>
    </div>

    <div className="mt-4 rounded-2xl border border-card-border bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-black text-primary">먼저 확인</p>
          <p className="mt-1 text-xs font-black">AI 답변보다 원본 데이터 품질과 누락 근거를 먼저 봅니다.</p>
        </div>
        <InvestmentExplanationButton metric="dataQuality" compact />
      </div>
      <p className="mt-2 text-[11px] font-bold leading-5 text-muted-foreground">
        질문할 때만 AI를 호출합니다. 같은 화면을 보는 것만으로 AI 요청이 발생하지 않습니다.
      </p>
    </div>

    <div className="mt-4 flex gap-2">
      <input
        aria-label="포트폴리오 AI 질문"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void askPortfolio();
        }}
        className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2.5 text-sm"
        placeholder="예: 내 포트폴리오에서 지금 가장 먼저 확인할 위험은?"
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
      {[
        '내 포트폴리오를 요약해줘',
        '가장 큰 집중 위험은?',
        '오늘 확인할 것 3개만 알려줘',
        '현재 누락 데이터가 판단에 어떤 영향을 줘?',
      ].map((sample) => <button
        type="button"
        key={sample}
        onClick={() => setQuestion(sample)}
        className="min-h-11 rounded-full border border-border px-3 py-1.5 text-[11px] font-bold"
      >{sample}</button>)}
    </div>

    {failure ? <p role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-sm font-bold text-destructive">{failure}</p> : null}

    {reply?.result ? <div className="mt-3 space-y-3 rounded-2xl border border-border bg-background/60 p-4" data-testid="portfolio-ai-diagnosis-result">
      <section className="rounded-xl border border-card-border bg-card p-3" data-testid="portfolio-evidence-summary">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[10px] font-black text-primary">현재 판단 기반</p>
            <p className="mt-1 text-sm font-black">{qualityLabel(context?.dataQuality)}</p>
          </div>
          <InvestmentExplanationButton metric="dataQuality" value={context?.dataQuality || 'NOT_AVAILABLE'} compact />
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
          <div className="rounded-lg bg-muted/50 p-2"><dt className="text-muted-foreground">근거</dt><dd className="mt-1 font-black tabular-nums">{evidence.length}개</dd></div>
          <div className="rounded-lg bg-muted/50 p-2"><dt className="text-muted-foreground">누락/주의</dt><dd className="mt-1 font-black tabular-nums">{warnings.length}개</dd></div>
          <div className="rounded-lg bg-muted/50 p-2"><dt className="text-muted-foreground">기준 시각</dt><dd className="mt-1 font-black">{formatBasisTime(context?.asOf)}</dd></div>
        </dl>
      </section>

      {partial ? <div data-testid="portfolio-ai-warnings" className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs font-bold text-muted-foreground">
        <div className="flex items-center gap-2 font-black text-foreground"><ShieldAlert className="h-4 w-4" />일부 데이터 제한이 있습니다.</div>
        <p className="mt-1">AI는 누락된 현금·계좌·시장 데이터를 0으로 바꾸거나 추정해서 채우지 않습니다.</p>
        {warnings.length ? <ul className="mt-2 space-y-1">{warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul> : null}
      </div> : null}

      <section className="rounded-xl border border-card-border p-3" data-testid="portfolio-action-checks">
        <p className="text-xs font-black">오늘 먼저 확인할 것</p>
        {actionChecks.length ? (
          <ol className="mt-2 space-y-2 text-xs leading-5 text-muted-foreground">
            {actionChecks.map((warning, index) => <li key={warning} className="rounded-lg bg-muted/40 p-2"><strong className="mr-1 text-foreground">{index + 1}.</strong>{warning}</li>)}
          </ol>
        ) : (
          <p className="mt-2 text-xs font-bold leading-5 text-muted-foreground">현재 AI 응답에서 추가 Missing Evidence 경고가 확인되지 않았습니다. 이것만으로 전체 계좌 데이터가 완전하다는 뜻은 아닙니다.</p>
        )}
      </section>

      <p className="whitespace-pre-wrap text-sm leading-6">{reply.result.ai?.answer || '설명 응답이 없습니다.'}</p>

      <div className="flex flex-wrap gap-2 text-[11px]" data-testid="portfolio-ai-source">
        <span className="rounded-full bg-primary/10 px-2 py-1 font-bold">{context?.dataQuality || 'NOT_AVAILABLE'}</span>
        <span className="rounded-full bg-muted px-2 py-1">기준 {formatBasisTime(context?.asOf)}</span>
        <span className="rounded-full bg-muted px-2 py-1">{dataBasisLabel(aiData?.basis)}</span>
        {reply.result.intent ? <span className="rounded-full bg-muted px-2 py-1">{reply.result.intent}</span> : null}
        {reply.result.ai?.model ? <span className="rounded-full bg-muted px-2 py-1">model {reply.result.ai.model}</span> : null}
        <span className="rounded-full bg-muted px-2 py-1">읽기 전용 · 주문 권한 없음</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-border p-3 text-xs" data-testid="portfolio-ai-evidence">
          <p className="font-black">사용한 근거</p>
          {evidence.length ? <ul className="mt-2 space-y-1 text-muted-foreground">{evidence.map((item, index) => <li key={`${index}-${evidenceLabel(item)}`}>• {evidenceLabel(item)}</li>)}</ul> : <p className="mt-2 font-bold text-muted-foreground">명시된 근거가 없습니다.</p>}
          {aiData?.sources?.length ? <><p className="mt-3 font-black">AI 데이터 출처</p><ul className="mt-2 space-y-1 text-muted-foreground">{aiData.sources.map((source) => <li key={source}>• {source}</li>)}</ul></> : null}
        </div>
        <div className="rounded-xl border border-border p-3 text-xs">
          <p className="font-black">응답 계약</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-muted-foreground">
            <dt>Source of truth</dt><dd className="break-all font-bold text-foreground">{reply.sourceOfTruth || 'NOT_AVAILABLE'}</dd>
            <dt>AI bridge</dt><dd className="break-all font-bold text-foreground">{reply.providerBridgeStatus || 'NOT_AVAILABLE'}</dd>
            <dt>AI data</dt><dd className="font-bold text-foreground">{aiData?.status || 'NOT_AVAILABLE'}</dd>
            <dt>Generated</dt><dd className="font-bold text-foreground">{formatBasisTime(reply.result.ai?.generatedAt)}</dd>
          </dl>
        </div>
      </div>

      <details className="rounded-xl border border-border p-3 text-xs">
        <summary className="cursor-pointer font-extrabold">고급 근거 원문 보기</summary>
        <pre className="mt-3 max-w-full overflow-x-auto whitespace-pre-wrap break-words text-[11px]">{JSON.stringify({
          facts: context?.facts ?? null,
          safety: reply.result.safety ?? {},
        }, null, 2)}</pre>
      </details>
    </div> : null}
  </section>;
}
