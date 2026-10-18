import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { describeErrorText, looksLikeDeveloperCode } from '@/lib/error-reason';
import { Bot, Loader2, Send, Square, UserRound } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAnalysisSelection, type AnalysisSelection } from '@/lib/analysis-selection';
import { acceptAiChatSelectionReply, aiChatSelectionContext, aiChatSelectionKey } from '@/lib/ai-chat-selection';
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
  model?: string | null;
  provider?: 'google-gemini' | 'groq' | 'openai-compatible' | null;
  fallbackUsed?: boolean;
  providerLatencyMs?: number | null;
};

type AiChatPayload = {
  answer?: string;
  kind?: 'answer' | 'refusal';
  message?: string;
  error?: string;
  data?: AiChatDataDisclosure;
  selection?: unknown;
  model?: string | null;
  provider?: 'google-gemini' | 'groq' | 'openai-compatible' | null;
  fallbackUsed?: boolean;
  providerLatencyMs?: number | null;
};

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

function providerLabel(provider: ChatMessage['provider']): string {
  if (provider === 'google-gemini') return 'Gemini';
  if (provider === 'groq') return 'Groq';
  if (provider === 'openai-compatible') return 'OpenAI 호환';
  return 'AI 공급자 미사용';
}

function latencyLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}초`;
}

function errorMessage(payload: AiChatPayload | null): string {
  if (payload?.error === 'AI_CHAT_RATE_LIMITED') return '무료 AI 사용 한도 또는 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  if (payload?.error === 'AI_CHAT_TIMEOUT') return 'AI 응답 시간이 초과되었습니다. 질문을 짧게 줄여 다시 시도해 주세요.';
  if (payload?.error === 'AI_CHAT_CANCELLED') return 'AI 요청이 취소되었습니다.';
  if (payload?.error === 'AI_CHAT_INVALID_RESPONSE') return 'AI 모델의 응답 형식이 올바르지 않아 차단했습니다. 다시 시도해 주세요.';
  if (payload?.error === 'AI_CHAT_PRIVATE_DATA_FORBIDDEN') return 'API 키·토큰·계좌번호 등 민감정보를 제거한 뒤 다시 질문해 주세요.';
  if (payload?.error === 'AI_CHAT_INVALID_CONTEXT') return '선택된 시장과 종목 정보가 일치하지 않습니다. 종목을 다시 선택해 주세요.';
  if (payload?.error === 'AI_CHAT_UNSAFE_RESPONSE') return '투자 권유·수익 보장·위험한 행동이 포함된 응답을 차단했습니다.';
  if (payload?.error === 'AI_CHAT_NOT_CONFIGURED' || payload?.error === 'AI_CHAT_PROVIDER_ERROR') return describeErrorText(payload.error, { message: payload.message });
  if (payload?.message && !looksLikeDeveloperCode(payload.message)) return payload.message;
  return describeErrorText(payload?.error ?? null, { fallbackTitle: 'AI 상담 응답을 받지 못했습니다' });
}

export default function AiChatPage() {
  const { selection } = useAnalysisSelection();
  return <AiChatConversation key={aiChatSelectionKey(selection)} selection={selection} />;
}

function AiChatConversation({ selection }: { selection: AnalysisSelection | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([{
    id: 'welcome',
    role: 'assistant',
    content: '공개 금융정보와 앱 사용법을 질문해 주세요. 주문·자동매매·계좌·서버 작업은 실행하지 않습니다.',
    at: new Date().toISOString(),
  }]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [composing, setComposing] = useState(false);
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
    const context = aiChatSelectionContext(selection);
    try {
      const response = await authorizedFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ message, context }),
      });
      const payload = await response.json().catch(() => null) as AiChatPayload | null;
      const answer = payload?.answer;
      if (!response.ok || !answer) throw new Error(errorMessage(payload));
      if (controller.signal.aborted) return;
      if (!acceptAiChatSelectionReply(payload.selection, context, controller.signal)) {
        throw new Error('응답의 종목·시장·시간봉·방향이 현재 선택과 일치하지 않아 차단했습니다.');
      }
      setMessages((current) => [...current, {
        id: `assistant:${Date.now()}`,
        role: 'assistant',
        content: answer,
        kind: payload.kind,
        data: payload.data,
        model: payload.model,
        provider: payload.provider,
        fallbackUsed: payload.fallbackUsed,
        providerLatencyMs: payload.providerLatencyMs,
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
    <div className="flex h-full min-h-0 flex-col bg-background pb-[calc(5rem+env(safe-area-inset-bottom))]" data-testid="ai-information-page">
      <header className="shrink-0 border-b border-card-border px-3 py-3 text-center sm:px-4">
        <p className="text-xs font-semibold text-primary">정보</p>
        <h1 className="mt-1 text-xl font-bold sm:text-2xl">AI 상담</h1>
        <p className="mx-auto mt-1 max-w-2xl break-keep text-sm font-normal text-muted-foreground">공개 금융정보를 읽기 전용으로 확인합니다.</p>
        {selection && (
          <p className="mt-2 truncate text-xs font-medium text-muted-foreground">
            선택 종목: {selection.displayName || selection.symbol} · {selection.market} · {selection.symbol} · {selection.timeframe} · {selection.action ?? 'MISSING'}
          </p>
        )}
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4" aria-live="polite">
        <div className="mx-auto max-w-4xl space-y-3">
          {messages.map((message) => (
            <article key={message.id} className={cn('flex gap-2', message.role === 'user' && 'flex-row-reverse')}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
                {message.role === 'user' ? <UserRound className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
              </span>
              <div className={cn(
                'max-w-[88%] rounded-2xl px-3 py-2.5 text-sm font-normal leading-6 sm:max-w-[78%]',
                message.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : message.kind === 'refusal'
                    ? 'border border-warning/30 bg-warning/5'
                    : 'bg-card',
              )}>
                <p className="whitespace-pre-wrap break-words">{message.content}</p>
                {message.role === 'assistant' && message.provider ? (
                  <div data-testid="ai-chat-provider-meta" className="mt-2 flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <span className="rounded-full border border-card-border bg-background/70 px-2 py-1">{providerLabel(message.provider)}</span>
                    {message.fallbackUsed ? <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-warning">Fallback 사용</span> : <span className="rounded-full border border-positive/30 bg-positive/10 px-2 py-1 text-positive">Primary 응답</span>}
                    {latencyLabel(message.providerLatencyMs) ? <span className="rounded-full border border-card-border bg-background/70 px-2 py-1">{latencyLabel(message.providerLatencyMs)}</span> : null}
                    {message.model ? <span className="max-w-full truncate rounded-full border border-card-border bg-background/70 px-2 py-1">{message.model}</span> : null}
                  </div>
                ) : null}
                {message.role === 'assistant' && message.data && message.data.status !== 'not_requested' && (
                  <details className="mt-2 rounded-xl border border-card-border/70 bg-background/60">
                    <summary className="cursor-pointer list-none px-2.5 py-2 text-xs font-semibold text-foreground/80 [&::-webkit-details-marker]:hidden">
                      {dataStatusLabel(message.data.status)}{message.data.asOf ? ` · ${formatBasisTime(message.data.asOf)}` : ''}
                    </summary>
                    <div className="border-t border-card-border/70 px-2.5 py-2 text-xs font-normal leading-5 text-muted-foreground">
                      {message.data.sources.length > 0 && <p className="break-words">출처: {message.data.sources.join(' · ')}</p>}
                      {message.data.missing.length > 0 && <p className="mt-1 break-words">부족: {message.data.missing.join(' · ')}</p>}
                    </div>
                  </details>
                )}
                <time className={cn('mt-1 block text-xs', message.role === 'user' ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                  {new Date(message.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                </time>
              </div>
            </article>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />답변을 준비하고 있습니다.
            </div>
          )}
          {error && <p role="alert" className="rounded-2xl bg-destructive/10 p-3 text-sm font-medium text-destructive">{error}</p>}
          <div ref={endRef} />
        </div>
      </main>
      <footer className="shrink-0 border-t border-card-border bg-background px-3 py-3 sm:px-4">
        <div className="mx-auto max-w-4xl">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              disabled={busy}
              rows={1}
              maxLength={2_000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              placeholder="질문 입력 · Shift+Enter 줄바꿈"
              className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border border-card-border bg-card px-3 py-2.5 text-sm leading-5 outline-none focus:border-primary"
            />
            {busy ? (
              <button type="button" aria-label="요청 취소" onClick={() => controllerRef.current?.abort()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-destructive text-destructive">
                <Square className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : (
              <button type="button" aria-label="메시지 전송" disabled={!draft.trim()} onClick={() => void send()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40">
                <Send className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          <p className="mt-2 break-keep text-xs font-normal leading-5 text-muted-foreground">
            민감정보 입력 금지 · 답변은 투자 조언이 아닙니다 · 데이터 시각은 서버 수집 기준입니다.
          </p>
        </div>
      </footer>
      <BottomNav />
    </div>
  );
}
