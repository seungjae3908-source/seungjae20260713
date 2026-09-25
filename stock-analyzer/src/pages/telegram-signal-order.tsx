import { useEffect, useMemo, useState } from 'react';
import { ScannerApprovalComposer } from '@/components/scanner-approval-composer';
import { useAnalysisSelection, type AnalysisSelection } from '@/lib/analysis-selection';
import {
  fetchSignalScanner,
  type ScannerSignalCard,
  type SignalScannerRequest,
} from '@/lib/signal-scanner';
import {
  getScannerUiProfile,
  type UnifiedScannerStrategyMode,
} from '@/lib/signal-scanner-profile';
import { parseTelegramScannerIntent, type TelegramScannerIntent } from '@/lib/telegram-scanner-intent';
import type { FrontendScannerMarket } from '@/lib/signal-scanner-url';

type VerificationState =
  | { status: 'loading'; message: string; card: null; selection: null }
  | { status: 'blocked'; message: string; card: null; selection: null }
  | { status: 'verified'; message: string; card: ScannerSignalCard; selection: AnalysisSelection };

function scannerMarket(intent: TelegramScannerIntent): FrontendScannerMarket {
  if (intent.market === 'KR') return 'KR_STOCK';
  if (intent.market === 'US') return 'US_STOCK';
  if (intent.market === 'UPBIT') return 'CRYPTO_SPOT';
  return 'CRYPTO_FUTURES';
}

function requestFor(intent: TelegramScannerIntent): SignalScannerRequest {
  const market = scannerMarket(intent);
  const strategy = intent.strategyMode as UnifiedScannerStrategyMode;
  const profile = getScannerUiProfile(market, strategy);
  const stock = intent.market === 'KR' || intent.market === 'US';
  return {
    assetClass: stock ? 'stock' : intent.market === 'UPBIT' ? 'coin_spot' : 'coin_futures',
    market: intent.market,
    strategy,
    timeframe: profile.timeframe,
    conditions: [],
    condition: !stock && strategy === 'scalping' ? 'williams' : 'trend',
    cursor: 0,
    batchSize: stock ? 100 : 24,
    minimumScore: 55,
    maximumRiskScore: 70,
  };
}

function actionMatches(card: ScannerSignalCard, intent: TelegramScannerIntent): boolean {
  return intent.action == null || card.action === intent.action;
}

function currentCandidateIsUsable(card: ScannerSignalCard): boolean {
  if (card.dataState !== 'complete') return false;
  if (!card.pricePlan.entryZone || card.pricePlan.stopLoss == null || card.pricePlan.targets.length < 1) return false;
  const expiresAt = Date.parse(card.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function selectionFromCard(
  card: ScannerSignalCard,
  response: Awaited<ReturnType<typeof fetchSignalScanner>>,
): AnalysisSelection {
  const market = card.assetClass === 'coin_spot'
    ? 'UPBIT'
    : card.assetClass === 'coin_futures'
      ? 'BITGET'
      : card.market === 'US' ? 'US' : 'KR';
  return {
    assetType: card.assetClass,
    market,
    symbol: card.symbol,
    ticker: card.symbol,
    displayName: card.name,
    timeframe: response.timeframe,
    searchRunId: response.requestId,
    signalId: card.signalId,
    signalScore: card.score,
    signalRank: card.candidateRanking?.rank,
    confidence: card.confidence,
    riskLevel: card.riskLevel,
    action: card.action,
    pricePlan: card.pricePlan,
    matchedSignals: card.matched,
    reasons: card.evidence
      .filter((item) => item.status === 'matched')
      .flatMap((item) => item.reasons)
      .slice(0, 20),
    selectedAt: new Date().toISOString(),
  };
}

export default function TelegramSignalOrderPage() {
  const analysisSelection = useAnalysisSelection();
  const intent = useMemo(
    () => typeof window === 'undefined' ? null : parseTelegramScannerIntent(window.location.search),
    [],
  );
  const [state, setState] = useState<VerificationState>(() => intent
    ? { status: 'loading', message: '현재 시장데이터로 Telegram 신호를 다시 검증하고 있습니다.', card: null, selection: null }
    : { status: 'blocked', message: '유효한 Telegram 주문 준비 링크가 아닙니다.', card: null, selection: null });

  useEffect(() => {
    if (!intent) return;
    const controller = new AbortController();
    setState({ status: 'loading', message: '현재 시장데이터로 Telegram 신호를 다시 검증하고 있습니다.', card: null, selection: null });

    void fetchSignalScanner(requestFor(intent), controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        const card = response.cards.find((candidate) =>
          candidate.symbol.trim().toUpperCase() === intent.symbol
          && actionMatches(candidate, intent));
        if (!card) {
          setState({
            status: 'blocked',
            message: '최신 검색 결과에서 같은 종목·방향의 유효 후보를 확인하지 못했습니다. 과거 Telegram 진입가를 재사용하지 않습니다.',
            card: null,
            selection: null,
          });
          return;
        }
        if (!currentCandidateIsUsable(card)) {
          setState({
            status: 'blocked',
            message: '현재 데이터가 불완전하거나 신호가 만료됐거나 가격계획이 무효입니다. 주문 준비를 차단했습니다.',
            card: null,
            selection: null,
          });
          return;
        }
        const selection = selectionFromCard(card, response);
        analysisSelection.select(selection);
        setState({
          status: 'verified',
          message: '현재 시장데이터로 재검증했습니다. 아래 진입·목표·손절은 Telegram 과거 가격이 아니라 최신 Scanner 계획입니다.',
          card,
          selection,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'blocked',
          message: error instanceof Error && error.name === 'AbortError'
            ? '재검증 요청이 취소되었습니다. 주문 준비를 열지 않았습니다.'
            : '현재 시장데이터 재검증에 실패해 주문 준비를 차단했습니다.',
          card: null,
          selection: null,
        });
      });

    return () => controller.abort();
  }, [analysisSelection, intent]);

  return (
    <main className="h-full overflow-y-auto overscroll-contain bg-background pb-24">
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
        <header className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <p className="text-xs font-black text-primary">Telegram → 앱 주문 준비</p>
          <h1 className="mt-1 text-xl font-black">현재가 재검증형 주문 초안</h1>
          <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">
            Telegram 링크의 사용자·계좌 식별자는 신뢰하지 않습니다. 로그인된 앱 세션으로 Scanner를 새로 조회하고, 결정론적 규칙 엔진이 현재 후보를 유지할 때만 주문 초안을 표시합니다. AI는 설명만 하며 주문 허용 여부를 결정하지 않습니다.
          </p>
        </header>

        <section
          role={state.status === 'blocked' ? 'alert' : 'status'}
          data-testid="telegram-order-verification"
          className={`rounded-2xl border p-4 text-sm font-bold leading-6 ${
            state.status === 'verified'
              ? 'border-positive/30 bg-positive/10 text-positive'
              : state.status === 'blocked'
                ? 'border-warning/30 bg-warning/10 text-warning'
                : 'border-card-border bg-card text-muted-foreground'
          }`}
        >
          {state.message}
        </section>

        {state.status === 'verified' ? (
          <>
            <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="telegram-current-signal">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-black">{state.card.name} · {state.card.symbol}</p>
                  <p className="mt-1 text-xs font-bold text-muted-foreground">
                    현재가 {state.card.price.toLocaleString('ko-KR')} · {state.card.market} · {state.card.action}
                  </p>
                </div>
                <span className="rounded-full border border-positive/30 bg-positive/10 px-3 py-1 text-[10px] font-black text-positive">
                  CURRENT VERIFIED
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">현재 진입구간</p><p className="text-xs font-black">{state.card.pricePlan.entryZone ? `${state.card.pricePlan.entryZone.from.toLocaleString('ko-KR')}~${state.card.pricePlan.entryZone.to.toLocaleString('ko-KR')}` : '미확인'}</p></div>
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">손절</p><p className="text-xs font-black">{state.card.pricePlan.stopLoss?.toLocaleString('ko-KR') ?? '미확인'}</p></div>
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">TP1</p><p className="text-xs font-black">{state.card.pricePlan.targets[0]?.toLocaleString('ko-KR') ?? '미확인'}</p></div>
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">TP2</p><p className="text-xs font-black">{state.card.pricePlan.targets[1]?.toLocaleString('ko-KR') ?? '미확인'}</p></div>
              </div>
              <p className="mt-3 text-[10px] font-bold leading-4 text-muted-foreground">
                신호 만료 {new Date(state.card.expiresAt).toLocaleString('ko-KR')} · executionAuthority=NONE · 실제 주문 전송 0
              </p>
            </section>

            <ScannerApprovalComposer selection={state.selection} />
          </>
        ) : null}
      </div>
    </main>
  );
}
