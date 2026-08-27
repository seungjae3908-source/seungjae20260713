import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation } from 'wouter';
import { ArrowRight, Bot, Loader2, Send, Square, UserRound, WalletCards } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { InvestmentExplanationButton } from '@/components/investment-explanation-sheet';
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
  cached?: boolean;
};

type CacheableReply = Pick<ChatMessage, 'content' | 'kind' | 'data'>;
type CachedReply = { reply: CacheableReply; cachedAt: number };

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

const QUICK_PROMPTS = [
  '선택 종목을 현재 공개 데이터 기준으로 5줄만 요약해줘',
  '좋은 근거 3개와 반대 근거 3개를 나눠서 설명해줘',
  '뉴스·공시 중 가격에 중요할 수 있는 것만 쉽게 설명해줘',
  '모르는 투자 용어를 초보자도 이해하게 설명해줘',
] as const;

const AI_CHAT_CACHE_TTL_MS = 60_000;

function PortfolioShortcutPanel() {
  const [, navigate] = useLocation();

  return <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
    <section className="rounded-2xl border border-card-border bg-card p-5" data-testid="information-portfolio-ai-shortcut">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <WalletCards className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-extrabold text-primary">내 자산 AI</p>
          <h2 className="mt-1 text-lg font-black">포트폴리오 AI 진단</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            총자산·손익·비중·집중도·상관관계·위험 데이터를 포트폴리오 화면에서 확인하고, 서버가 계산한 사실만 AI가 설명합니다.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-2 text-xs font-bold text-muted-foreground sm:grid-cols-3">
        <span className="rounded-xl bg-muted/50 px-3 py-2">검증된 서버 데이터만 설명</span>
        <span className="rounded-xl bg-muted/50 px-3 py-2">읽기 전용 · 주문 권한 없음</span>
        <span className="rounded-xl bg-muted/50 px-3 py-2">누락 데이터는 추정하지 않음</span>
      </div>
      <button
        type="button"
        onClick={() => navigate('/portfolio?focus=ai')}
        className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground"
      >
        내 포트폴리오 분석 열기
        <ArrowRight className="h-4 w-4" />
      </button>
      <p className="mt-3 text-[11px] font-bold leading-5 text-muted-foreground">
        AI는 포트폴리오 화면에서 계산된 금액·수익률·위험만 설명하며, 없는 값을 새로 만들지 않습니다.
      </p>
    </section>
  </main>;
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

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
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
  const responseCacheRef = useRef<Map<string, CachedReply>>(new Map());
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);
  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    const prompt = new URLSearchParams(window.location.search).get('prompt')?.trim();
    if (prompt) setDraft(prompt.slice(0, 2_000));
  }, []);

  function cacheKey(message: string): string {
    return [selection?.market ?? 'GENERAL', selection?.symbol ?? 'NONE', normalizeQuestion(message)].join('|');
  }

  async function send() {
    const message = draft.trim();
    if (!message || busy || controllerRef.current) return;
    const now = Date.now();
    const userMessage: ChatMessage = { id: `user:${now}`, role: 'user', content: message, at: new Date(now).toISOString() };
    const key = cacheKey(message);
    const cached = responseCacheRef.current.get(key);
    const cacheFresh = Boolean(cached && now - cached.cachedAt <= AI_CHAT_CACHE_TTL_MS);
    setMessages((current) => [...current, userMessage]);
    setDraft('');
    setError('');

    if (cached && cacheFresh) {
      setMessages((current) => [...current, {
        id: `assistant:cache:${now}`,
        role: 'assistant',
        ...cached.reply,
        cached: true,
        at: new Date().toISOString(),
      }]);
      return;
    }
    if (cached) responseCacheRef.current.delete(key);

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
      const reply: CacheableReply = { content: answer, kind: payload.kind, data: payload.data };
      responseCacheRef.current.set(key, { reply, cachedAt: Date.now() });
      setMessages((current) => [...current, {
        id: `assistant:${Date.now()}`,
        role: 'assistant',
        ...reply,
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
      <header className="shrink-0 border-b border-card-border px-4 py-4 text-center">
        <p className="text-[11px] font-extrabold text-primary">정보</p>
        <h1 className="mt-1 text-xl font-black">AI 상담</h1>
        <p className="mt-1 text-xs text-muted-foreground">공개 금융정보와 내 포트폴리오를 읽기 전용으로 확인합니다.</p>
        {selection && <p className="mt-2 text-[11px] font-bold text-muted-foreground">선택 종목: {selection.displayName || selection.symbol} · {selection.market} · {selection.symbol}</p>}
      </header>
      <nav aria-label="AI 정보 탭" className="sticky top-0 z-20 grid shrink-0 grid-cols-2 gap-1 border-b border-card-border bg-background/95 p-2 backdrop-blur">
        {hubTabs.map((tab) => <button
          type="button"
          key={tab.value}
          aria-current={activeTab === tab.value ? 'page' : undefined}
          onClick={() => setActiveTab(tab.value)}
          className={cn('min-h-11 min-w-0 rounded-lg px-2 py-2 text-xs font-extrabold', activeTab === tab.value ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground')}
        >{tab.label}</button>)}
      </nav>
      {activeTab === 'Portfolio' ? <PortfolioShortcutPanel /> : <>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        <section className="mb-4 rounded-2xl border border-primary/20 bg-primary/5 p-3" data-testid="ai-info-efficiency-guide">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-black text-primary">무료 AI 효율 모드</p>
              <p className="mt-1 text-xs font-black">질문할 때만 AI를 호출하고, 같은 종목의 같은 질문은 최근 1분 이내 답변만 재사용합니다.</p>
            </div>
            <InvestmentExplanationButton metric="dataQuality" compact />
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {QUICK_PROMPTS.map((prompt) => <button
              type="button"
              key={prompt}
              onClick={() => setDraft(prompt)}
              className="min-h-10 shrink-0 rounded-full border border-card-border bg-background px-3 text-[11px] font-bold"
            >{prompt}</button>)}
          </div>
        </section>

        <div className="space-y-3">
          {messages.map((message) => <article key={message.id} className={cn('flex gap-2', message.role === 'user' && 'flex-row-reverse')}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">{message.role === 'user' ? <UserRound className="h-4 w-4" /> : <Bot className="h-4 w-4" />}</span>
            <div className={cn('max-w-[85%] rounded-2xl px-3 py-2.5 text-sm leading-6', message.role === 'user' ? 'bg-primary text-primary-foreground' : message.kind === 'refusal' ? 'border border-warning/30 bg-warning/5' : 'bg-card')}>
              {message.cached ? <p className="mb-2 text-[10px] font-black text-emerald-700" data-testid="ai-info-cache-hit">캐시 재사용 · AI 호출 0</p> : null}
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
              {message.role === 'assistant' && message.data && message.data.status !== 'not_requested' && <div className="mt-2 rounded-xl border border-card-border/70 bg-background/60 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-extrabold text-foreground/80">{dataStatusLabel(message.data.status)}{message.data.asOf ? ` · 서버 수집 기준 ${formatBasisTime(message.data.asOf)}` : ''}</p>
                  <InvestmentExplanationButton metric="dataQuality" value={dataStatusLabel(message.data.status)} compact />
                  {message.data.asOf ? <InvestmentExplanationButton metric="freshness" value={formatBasisTime(message.data.asOf)} compact /> : null}
                </div>
                {message.data.sources.length > 0 && <p className="mt-1 break-words">출처: {message.data.sources.join(' · ')}</p>}
                {message.data.missing.length > 0 && <p className="mt-1 break-words">부족: {message.data.missing.join(' · ')}</p>}
              </div>}
              <time className={cn('mt-1 block text-[10px]', message.role === 'user' ? 'text-primary-foreground/70' : 'text-muted-foreground')}>{new Date(message.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time>
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
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">API 키·토큰·계좌번호 등 민감정보를 입력하지 마세요. 답변은 투자 조언이 아니며, 기준시각은 거래소 체결시각이 아니라 서버가 공개 데이터를 수집한 시각입니다.</p>
      </footer>
      </>}
      <BottomNav />
    </div>
  );
}
