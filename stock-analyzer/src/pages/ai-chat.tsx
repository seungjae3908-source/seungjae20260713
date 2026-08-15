import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bot, Loader2, Send, Square, UserRound } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAnalysisSelection } from '@/lib/analysis-selection';
import { cn } from '@/lib/utils';

type AiChatDataDisclosure = {
  status: 'not_requested' | 'complete' | 'partial' | 'unavailable';
  asOf: string | null;
  basis: 'server_collection_time';
  sources: string[];
  missing: string[];
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  kind?: 'answer' | 'refusal';
  data?: AiChatDataDisclosure;
};

type AiChatPayload = {
  answer?: string;
  kind?: 'answer' | 'refusal';
  message?: string;
  error?: string;
  data?: AiChatDataDisclosure;
};

type HubTab = 'Overview' | 'AI' | 'Portfolio' | 'Events' | 'Performance' | 'Journal';
const hubTabs: HubTab[] = ['Overview', 'AI', 'Portfolio', 'Events', 'Performance', 'Journal'];

type PortfolioReply = {
  result?: { ai?: { answer?: string }; assistantContext?: { dataQuality?: string; asOf?: string | null; evidence?: unknown[]; warnings?: string[]; facts?: unknown }; safety?: Record<string, unknown> };
  code?: string;
  message?: string;
};

function PortfolioHubPanel() {
  const [question, setQuestion] = useState('내 포트폴리오를 요약해줘');
  const [reply, setReply] = useState<PortfolioReply | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');

  async function askPortfolio() {
    if (!question.trim() || loading) return;
    setLoading(true); setFailure('');
    try {
      const response = await authorizedFetch('/api/paper-journal/portfolio-advisor/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: question.trim() }) });
      const payload = await response.json().catch(() => null) as PortfolioReply | null;
      if (!response.ok || !payload?.result) throw new Error(payload?.message || payload?.code || '포트폴리오 답변을 받지 못했습니다.');
      setReply(payload);
    } catch (cause) { setFailure(cause instanceof Error ? cause.message : '포트폴리오 요청에 실패했습니다.'); }
    finally { setLoading(false); }
  }

  const context = reply?.result?.assistantContext;
  return <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
    <section className="rounded-2xl border border-card-border bg-card p-4">
      <p className="text-xs font-extrabold text-primary">요약 먼저</p><h2 className="mt-1 text-lg font-black">포트폴리오 Copilot</h2>
      <div className="mt-3 flex gap-2"><input aria-label="포트폴리오 질문" value={question} onChange={(event) => setQuestion(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-card-border bg-background px-3 py-2 text-sm" /><button type="button" onClick={() => void askPortfolio()} disabled={loading || !question.trim()} className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-40">{loading ? '확인 중' : '질문'}</button></div>
      <div className="mt-2 flex flex-wrap gap-2">{['내 포트폴리오를 요약해줘', '가장 위험한 종목은?', 'BTC가 10% 하락하면?'].map((sample) => <button type="button" key={sample} onClick={() => setQuestion(sample)} className="rounded-full border border-card-border px-3 py-1 text-[11px] font-bold">{sample}</button>)}</div>
    </section>
    {failure ? <p role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{failure}</p> : null}
    {reply?.result ? <section className="mt-3 space-y-3 rounded-2xl border border-card-border bg-card p-4"><p className="whitespace-pre-wrap text-sm leading-6">{reply.result.ai?.answer || '설명 응답이 없습니다.'}</p><div className="flex flex-wrap gap-2 text-[11px]"><span className="rounded-full bg-primary/10 px-2 py-1 font-bold">{context?.dataQuality || 'NOT_AVAILABLE'}</span><span className="rounded-full bg-muted px-2 py-1">기준 {context?.asOf ? formatBasisTime(context.asOf) : '미제공'}</span><span className="rounded-full bg-muted px-2 py-1">읽기 전용 · 주문 권한 없음</span></div><details className="rounded-xl border border-card-border p-3 text-xs"><summary className="cursor-pointer font-extrabold">근거 보기</summary><pre className="mt-3 max-w-full overflow-x-auto whitespace-pre-wrap break-words text-[11px]">{JSON.stringify({ provenance: context?.evidence ?? [], warnings: context?.warnings ?? [], facts: context?.facts ?? null, safety: reply.result.safety ?? {} }, null, 2)}</pre></details></section> : null}
  </main>;
}

function PlaceholderPanel({ tab }: { tab: Exclude<HubTab, 'AI' | 'Portfolio'> }) {
  const labels = { Overview: '핵심 요약', Events: '시장 이벤트', Performance: '성과 근거', Journal: '거래 저널' } as const;
  return <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4"><section className="rounded-2xl border border-card-border bg-card p-5"><p className="text-xs font-extrabold text-primary">{tab}</p><h2 className="mt-1 text-lg font-black">{labels[tab]}</h2><p className="mt-2 text-sm text-muted-foreground">이 탭은 요약부터 보여 주고, 상세 데이터는 사용자가 열 때만 불러오는 확장 seam입니다.</p></section></main>;
}

function dataStatusLabel(status: AiChatDataDisclosure['status']): string {
  if (status === 'complete') return '데이터 연결 완료';
  if (status === 'partial') return '일부 데이터만 연결';
  if (status === 'unavailable') return '데이터 부족';
  return '일반 설명';
}

function formatBasisTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function errorMessage(payload: AiChatPayload | null): string {
  if (payload?.error === 'AI_CHAT_RATE_LIMITED') return '무료 AI 사용 한도 또는 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  if (payload?.error === 'AI_CHAT_TIMEOUT') return 'AI 응답 시간이 초과되었습니다. 질문을 짧게 줄여 다시 시도해 주세요.';
  if (payload?.error === 'AI_CHAT_CANCELLED') return 'AI 요청이 취소되었습니다.';
  if (payload?.error === 'AI_CHAT_INVALID_RESPONSE') return 'AI 모델의 응답 형식이 올바르지 않아 차단했습니다. 다시 시도해 주세요.';
  if (payload?.error === 'AI_CHAT_PRIVATE_DATA_FORBIDDEN') return 'API 키·토큰·계좌번호 등 민감정보를 제거한 뒤 다시 질문해 주세요.';
  if (payload?.error === 'AI_CHAT_INVALID_CONTEXT') return '선택된 시장과 종목 정보가 일치하지 않습니다. 종목을 다시 선택해 주세요.';
  if (payload?.error === 'AI_CHAT_UNSAFE_RESPONSE') return '투자 권유·수익 보장·위험한 행동이 포함된 응답을 차단했습니다.';
  if (payload?.error === 'AI_CHAT_NOT_CONFIGURED') return 'AI 채팅 공급자가 아직 서버에 연결되지 않았습니다.';
  return payload?.message || 'AI 채팅 응답을 받지 못했습니다.';
}

export default function AiChatPage() {
  const { selection } = useAnalysisSelection();
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: 'welcome', role: 'assistant', content: '공개 금융정보, 투자 용어, 앱 사용법을 질문해 주세요. AI 채팅은 주문·자동매매·계좌·서버 작업을 실행하지 않습니다.', at: new Date().toISOString() }]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [composing, setComposing] = useState(false);
  const [activeTab, setActiveTab] = useState<HubTab>('AI');
  const controllerRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function send() {
    const message = draft.trim();
    if (!message || busy || controllerRef.current) return;
    const userMessage: ChatMessage = { id: `user:${Date.now()}`, role: 'user', content: message, at: new Date().toISOString() };
    setMessages((current) => [...current, userMessage]);
    setDraft('');
    setError('');
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await authorizedFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ message, context: selection ? { market: selection.market, symbol: selection.symbol, displayName: selection.displayName } : undefined }),
      });
      const payload = await response.json().catch(() => null) as AiChatPayload | null;
      const answer = payload?.answer;
      if (!response.ok || !answer) throw new Error(errorMessage(payload));
      setMessages((current) => [...current, {
        id: `assistant:${Date.now()}`,
        role: 'assistant',
        content: answer,
        kind: payload.kind,
        data: payload.data,
        at: new Date().toISOString(),
      }]);
    } catch (cause) {
      if (controller.signal.aborted) setError('요청을 취소했습니다.');
      else setError(cause instanceof Error ? cause.message : 'AI 채팅 요청에 실패했습니다.');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || composing || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background pb-[calc(5rem+env(safe-area-inset-bottom))]">
      <header className="shrink-0 border-b border-card-border px-4 py-4">
        <p className="text-[11px] font-extrabold text-primary">정보탭</p>
        <h1 className="mt-1 text-xl font-black">Information Hub</h1>
        <p className="mt-1 text-xs text-muted-foreground">요약에서 근거까지, 읽기 전용으로 확인합니다.</p>
        {selection && <p className="mt-2 text-[10px] font-bold text-muted-foreground">선택 종목: {selection.displayName || selection.symbol} · {selection.market} · {selection.symbol}</p>}
      </header>
      <nav aria-label="Information Hub 탭" className="sticky top-0 z-20 grid shrink-0 grid-cols-3 gap-1 border-b border-card-border bg-background/95 p-2 backdrop-blur sm:grid-cols-6">{hubTabs.map((tab) => <button type="button" key={tab} aria-current={activeTab === tab ? 'page' : undefined} onClick={() => setActiveTab(tab)} className={cn('min-w-0 rounded-lg px-2 py-2 text-[11px] font-extrabold', activeTab === tab ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground')}>{tab}</button>)}</nav>
      {activeTab === 'Portfolio' ? <PortfolioHubPanel /> : activeTab !== 'AI' ? <PlaceholderPanel tab={activeTab} /> : <>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        <div className="space-y-3">
          {messages.map((message) => <article key={message.id} className={cn('flex gap-2', message.role === 'user' && 'flex-row-reverse')}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">{message.role === 'user' ? <UserRound className="h-4 w-4" /> : <Bot className="h-4 w-4" />}</span>
            <div className={cn('max-w-[85%] rounded-2xl px-3 py-2.5 text-sm leading-6', message.role === 'user' ? 'bg-primary text-primary-foreground' : message.kind === 'refusal' ? 'border border-warning/30 bg-warning/5' : 'bg-card')}>
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
              {message.role === 'assistant' && message.data && message.data.status !== 'not_requested' && <div className="mt-2 rounded-xl border border-card-border/70 bg-background/60 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
                <p className="font-extrabold text-foreground/80">{dataStatusLabel(message.data.status)}{message.data.asOf ? ` · 서버 수집 기준 ${formatBasisTime(message.data.asOf)}` : ''}</p>
                {message.data.sources.length > 0 && <p className="mt-1 break-words">출처: {message.data.sources.join(' · ')}</p>}
                {message.data.missing.length > 0 && <p className="mt-1 break-words">부족: {message.data.missing.join(' · ')}</p>}
              </div>}
              <time className={cn('mt-1 block text-[9px]', message.role === 'user' ? 'text-primary-foreground/70' : 'text-muted-foreground')}>{new Date(message.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time>
            </div>
          </article>)}
          {busy && <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />답변을 준비하고 있습니다.</div>}
          {error && <p role="alert" className="rounded-2xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{error}</p>}
          <div ref={endRef} />
        </div>
      </main>
      <footer className="shrink-0 border-t border-card-border bg-background px-3 py-3">
        <div className="flex items-end gap-2">
          <textarea value={draft} disabled={busy} rows={1} maxLength={2_000} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} placeholder="질문 입력 · Shift+Enter 줄바꿈" className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border border-card-border bg-card px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary" />
          {busy ? <button type="button" aria-label="요청 취소" onClick={() => controllerRef.current?.abort()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-destructive text-destructive"><Square className="h-4 w-4" /></button> : <button type="button" aria-label="메시지 전송" disabled={!draft.trim()} onClick={() => void send()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"><Send className="h-4 w-4" /></button>}
        </div>
        <p className="mt-2 text-[9px] leading-4 text-muted-foreground">API 키·토큰·계좌번호 등 민감정보를 입력하지 마세요. 답변은 투자 조언이 아니며, 기준시각은 거래소 체결시각이 아니라 서버가 공개 데이터를 수집한 시각입니다.</p>
      </footer>
      </>}
      <BottomNav />
    </div>
  );
}
