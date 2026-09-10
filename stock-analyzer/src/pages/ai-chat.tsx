import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation } from 'wouter';
import { ArrowRight, Bot, Loader2, Send, Square, UserRound, WalletCards } from 'lucide-react';
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

type HubTab = 'AI' | 'Portfolio';
const hubTabs: Array<{ value: HubTab; label: string }> = [
  { value: 'AI', label: 'AI 상담' },
  { value: 'Portfolio', label: '포트폴리오' },
];

function PortfolioShortcutPanel() {
  const [, navigate] = useLocation();

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4">
      <section className="mx-auto max-w-4xl rounded-2xl border border-card-border bg-card p-4 sm:p-5" data-testid="information-portfolio-ai-shortcut">
        <div className="text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <WalletCards className="h-5 w-5" aria-hidden="true" />
          </span>
          <p className="mt-3 text-xs font-semibold text-primary">내 자산 AI</p>
          <h2 className="mt-1 text-lg font-bold">포트폴리오 AI 진단</h2>
          <p className="mx-auto mt-2 max-w-2xl break-keep text-sm font-normal leading-6 text-muted-foreground">
            서버가 확인한 자산·손익·비중·위험 데이터만 설명합니다.
          </p>
        </div>
        <div className="mt-4 grid gap-2 text-xs font-medium text-muted-foreground sm:grid-cols-3">
          <span className="rounded-xl bg-muted/50 px-3 py-2 text-center">검증된 서버 데이터만 설명</span>
          <span className="rounded-xl bg-muted/50 px-3 py-2 text-center">읽기 전용 · 주문 권한 없음</span>
          <span className="rounded-xl bg-muted/50 px-3 py-2 text-center">누락 데이터는 추정하지 않음</span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/portfolio?focus=ai')}
          className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
        >
          내 포트폴리오 분석 열기
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </section>
    </main>
  );
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
    <div className="flex h-full min-h-0 flex-col bg-background pb-[calc(5rem+env(safe-area-inset-bottom))]" data-testid="ai-information-page">
      <header className="shrink-0 border-b border-card-border px-3 py-3 text-center sm:px-4">
        <p className="text-xs font-semibold text-primary">정보</p>
        <h1 className="mt-1 text-xl font-bold sm:text-2xl">AI 상담</h1>
        <p className="mx-auto mt-1 max-w-2xl break-keep text-sm font-normal text-muted-foreground">공개 금융정보와 내 포트폴리오를 읽기 전용으로 확인합니다.</p>
        {selection && (
          <p className="mt-2 truncate text-xs font-medium text-muted-foreground">
            선택 종목: {selection.displayName || selection.symbol} · {selection.market} · {selection.symbol}
          </p>
        )}
      </header>
      <nav aria-label="AI 정보 탭" className="grid shrink-0 grid-cols-2 gap-1.5 border-b border-card-border bg-background/95 p-2 backdrop-blur">
        {hubTabs.map((tab) => (
          <button
            type="button"
            key={tab.value}
            aria-current={activeTab === tab.value ? 'page' : undefined}
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              'min-h-11 min-w-0 rounded-xl px-2 py-2 text-sm font-semibold',
              activeTab === tab.value ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {activeTab === 'Portfolio' ? <PortfolioShortcutPanel /> : (
        <>
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
        </>
      )}
      <BottomNav />
    </div>
  );
}
