import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Square } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import type { Currency } from '@/lib/api';
import {
  parseStockAnalysisReply,
  type StockAnalysisReply,
  type StockAnalysisTarget,
} from '@/lib/stock-ai-analysis-reply';

const STOCK_DETAIL_AI_QUESTION =
  '선택한 종목에 대해 제공된 공개 시세·기업정보·재무·뉴스만 사용해서 확인된 사실, 긍정·부정 근거, 자료 기준시각과 누락 내용을 한국어로 설명해 주세요. 선택 시간봉 OHLCV가 없으면 기술지표를 분석했다고 주장하지 마세요. 적중 확률·목표가·손절가·주문 추천을 추정하거나 만들지 마세요.';

type AiStockError = { error?: string; message?: string };
function responseError(response: AiStockError | null): string {
  const code = response?.error ?? '';
  if (code === 'AI_CHAT_RATE_LIMITED') return 'AI 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'AI_CHAT_TIMEOUT') return 'AI 분석 응답 시간이 초과되었습니다. 다시 시도해 주세요.';
  if (code === 'AI_CHAT_NOT_CONFIGURED') return 'AI 공급자가 아직 서버에 연결되지 않았습니다.';
  if (code === 'AI_CHAT_INVALID_CONTEXT') return '시장 또는 종목 정보가 일치하지 않아 분석을 차단했습니다.';
  return response?.message || 'AI 분석 자료를 확인할 수 없습니다.';
}
function sourceTime(value: string | null): string {
  if (!value) return '수집 시각 미확인';
  return new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}
function providerName(provider: StockAnalysisReply['provider']): string {
  if (provider === 'google-gemini') return 'Gemini';
  if (provider === 'groq') return 'Groq';
  return 'OpenAI 호환';
}

/** Only reads public evidence through the existing server-owned AI Chat route. */
export function AiTab({ ticker, currency, active }: { ticker: string; currency: Currency; active: boolean }) {
  const market: StockAnalysisTarget['market'] = currency === 'KRW' ? 'KR' : 'US';
  const symbol = ticker.trim().toUpperCase();
  const [result, setResult] = useState<StockAnalysisReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setResult(null);
    setError('');
    setBusy(false);
    return () => {
      generation.current += 1;
      controllerRef.current?.abort();
    };
  }, [symbol, market, active]);

  async function requestAnalysis() {
    if (!active || !symbol || busy || controllerRef.current) return;
    if ((market === 'KR' && !/^\d{6}$/.test(symbol))
      || (market === 'US' && !/^[A-Z][A-Z0-9.-]{0,23}$/.test(symbol))) {
      setError('지원하지 않는 종목 코드입니다.');
      return;
    }
    const owner = ++generation.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setResult(null);
    setError('');
    setBusy(true);
    const context: StockAnalysisTarget = { market, ticker: symbol, timeframe: '1D' };
    try {
      const response = await authorizedFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: STOCK_DETAIL_AI_QUESTION,
          context: { ...context, symbol, action: null },
        }),
        signal: controller.signal,
      }, { timeoutMs: 25_000 });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) throw new Error(responseError(body && typeof body === 'object' ? body as AiStockError : null));
      const parsed = parseStockAnalysisReply(body, context);
      if (controller.signal.aborted || generation.current !== owner) return;
      setResult(parsed);
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== owner) return;
      setError(cause instanceof Error ? cause.message : 'AI 분석에 실패했습니다.');
    } finally {
      if (generation.current === owner) {
        controllerRef.current = null;
        setBusy(false);
      }
    }
  }

  function cancel() {
    generation.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setBusy(false);
    setError('분석 요청을 취소했습니다.');
  }

  return (
    <section className="space-y-3" data-testid="stock-ai-analysis-readonly" data-market={market} data-symbol={symbol}>
      <div className="rounded-2xl border border-card-border bg-card p-4">
        <h3 className="text-base font-bold">AI 공개자료 분석 · {symbol}</h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          기존 서버 AI 상담 공급자를 재사용하며, 실제 확보한 공개자료만 설명합니다.
          시세 수집시각은 거래소 틱 시각이 아닙니다. 주문·매매 추천을 실행하지 않습니다.
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy || !active || !symbol}
            onClick={() => void requestAnalysis()}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-3 text-sm font-bold text-primary-foreground disabled:opacity-40"
            data-testid="stock-ai-request-analysis"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {busy ? '확인된 자료 분석 중' : result ? '새 자료로 다시 분석' : 'AI 분석 요청'}
          </button>
          {busy ? <button type="button" onClick={cancel} aria-label="AI 분석 요청 취소" className="min-h-11 rounded-xl border border-card-border px-3"><Square className="h-4 w-4" /></button> : null}
        </div>
      </div>
      {error ? <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive">{error}</div> : null}
      {result ? (
        <div className="space-y-3" data-testid="stock-ai-evidence-result">
          <div className="rounded-2xl border border-card-border bg-card p-3 text-xs leading-6">
            <p>데이터 상태: {result.data.status === 'complete' ? '확인됨' : result.data.status === 'partial' ? '일부 미연결' : '이용 불가'}</p>
            <p>수집 기준: {sourceTime(result.data.asOf)} · {providerName(result.provider)} · {result.model}</p>
            {result.fallbackUsed ? <p>기본 공급자 응답 실패로 예비 AI 공급자 사용</p> : null}
            {result.data.sources.length ? <p>출처: {result.data.sources.join(' · ')}</p> : null}
            {result.data.missing.length ? <p className="text-amber-700">누락 자료: {result.data.missing.join(' · ')}</p> : null}
          </div>
          {result.data.status === 'unavailable' ? (
            <div role="status" className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
              선택 종목의 검증된 최신 공개자료가 없어 AI 의견을 표시하지 않습니다.
            </div>
          ) : (
            <article className="whitespace-pre-wrap break-words rounded-2xl border border-card-border bg-card p-4 text-sm leading-7" data-testid="stock-ai-grounded-answer">
              {result.answer}
            </article>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            AI의 설명은 확률 검증이나 투자성과 증거가 아닙니다. 목표가·손절가·진입가격은 별도 검증 근거가 없는 한 제공하지 않습니다.
          </p>
        </div>
      ) : null}
    </section>
  );
}
