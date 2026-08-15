import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useAssetMode } from '@/lib/asset-mode';
import { ScannerApprovalComposer } from '@/components/scanner-approval-composer';
import {
  selectionQuery,
  useAnalysisSelection,
  type AnalysisSelection,
  type AnalysisMarket,
} from '@/lib/analysis-selection';
import {
  fetchSignalScanner,
  deriveScannerDisplayOutcome,
  signalScannerDetailPath,
  SignalScannerRequestError,
  type ScannerAlertCandidate,
  type ScannerResponse,
  type ScannerSignalCard,
  type ScannerOutcomeCode,
  type SignalScannerRequest,
} from '@/lib/signal-scanner';
import {
  getScannerUiProfile,
  SCANNER_STRATEGY_OPTIONS,
  toAiChartStrategyMode,
  type UnifiedScannerStrategyMode,
} from '@/lib/signal-scanner-profile';
import type { FrontendScannerMarket } from '@/lib/signal-scanner-url';

export type ScannerView = 'KR' | 'US' | 'SPOT' | 'FUTURES';
type RequestStatus = 'loading' | 'success' | 'empty' | 'partial' | 'cancelled' | 'error';
type MobileDetailTab = 'summary' | 'chart' | 'evidence' | 'performance' | 'risk';

const VIEWS: Array<{ value: ScannerView; market: FrontendScannerMarket; label: string; description: string }> = [
  { value: 'KR', market: 'KR_STOCK', label: '국내주식', description: 'KRX 주식·ETF·ETN' },
  { value: 'US', market: 'US_STOCK', label: '미국주식', description: '미국 주식·ETF' },
  { value: 'SPOT', market: 'CRYPTO_SPOT', label: '코인 현물', description: '현물 Scanner에는 숏·레버리지를 적용하지 않습니다' },
  { value: 'FUTURES', market: 'CRYPTO_FUTURES', label: '코인 선물', description: 'Bitget USDT 선물' },
];

const MOBILE_DETAIL_TABS: ReadonlyArray<{ value: MobileDetailTab; label: string }> = [
  { value: 'summary', label: '요약' },
  { value: 'chart', label: '차트' },
  { value: 'evidence', label: '근거' },
  { value: 'performance', label: '성과' },
  { value: 'risk', label: '위험' },
];

const EMBEDDED_TIMEFRAMES: Readonly<Record<UnifiedScannerStrategyMode, readonly SignalScannerRequest['timeframe'][]>> = Object.freeze({
  scalping: ['1m', '3m', '5m'],
  swing: ['4H', '1D'],
  position: ['1D'],
});

function viewMarket(view: ScannerView): FrontendScannerMarket {
  return VIEWS.find((item) => item.value === view)?.market ?? 'KR_STOCK';
}

function requestErrorMessage(error: unknown): string {
  if (error instanceof SignalScannerRequestError) {
    if (error.status === 401) return '로그인이 만료됐습니다. 다시 로그인한 뒤 재시도해 주세요.';
    if (error.status === 403) return '현재 회원 등급으로 이 시장의 AI 검색기를 사용할 수 없습니다.';
    if (error.status === 409) return '동일 조건 분석이 이미 진행 중입니다. 기존 결과를 유지하며 완료를 기다립니다.';
    if (error.status === 429) {
      const retry = error.retryAfterSeconds == null ? '' : ` ${error.retryAfterSeconds}초 후`;
      return `검색 요청 한도를 보호하고 있습니다.${retry} 다음 갱신을 기다립니다.`;
    }
    if (error.status === 502) return '시장데이터 공급자 응답이 불안정합니다. 마지막 정상 결과가 있으면 유지합니다.';
    if (error.code.includes('STRATEGY_TIMEFRAME_MISMATCH')) return '선택한 투자 스타일의 자동 시간봉 구성을 사용할 수 없습니다.';
    return `검색 요청 실패: ${error.code}`;
  }
  if (error instanceof Error && error.name === 'AbortError') return '이전 검색 요청을 취소했습니다.';
  return error instanceof Error ? error.message : '검색 요청 중 알 수 없는 오류가 발생했습니다.';
}

function formatNumber(value: number | null | undefined, maximumFractionDigits = 2): string {
  if (value == null || !Number.isFinite(value)) return '미확인';
  return value.toLocaleString('ko-KR', { maximumFractionDigits });
}

function formatMetric(value: number | null | undefined, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) return '미확인';
  return `${formatNumber(value)}${suffix}`;
}

function actionLabel(card: ScannerSignalCard): string {
  if (card.action === 'BUY') return '↗ 매수 · BUY';
  if (card.action === 'SELL') return '↘ 매도 · SELL';
  if (card.action === 'LONG') return '↑ 롱 · LONG';
  if (card.action === 'SHORT') return '↓ 숏 · SHORT';
  if (card.action === 'NONE' || card.action === 'NO_TRADE') return '— 거래 안 함 · NO_TRADE';
  return '? 방향 확인 필요 · UNKNOWN';
}

function evidenceGradeLabel(card: ScannerSignalCard): string {
  if (card.signalGrade === 'S') return 'S';
  if (card.signalGrade === 'A') return 'A';
  if (card.signalGrade === 'B') return 'WATCH';
  if (card.signalGrade === 'C' || card.signalGrade === 'D') return 'REJECT';
  return '미확인';
}

function alertTitle(alert: ScannerAlertCandidate): string {
  const action = alert.action && alert.action !== 'NONE' ? alert.action : 'SIGNAL';
  return `${action} 승인 대기 · ${alert.symbol}`;
}

function analysisMarket(card: ScannerSignalCard): AnalysisMarket {
  if (card.assetClass === 'coin_spot') return 'UPBIT';
  if (card.assetClass === 'coin_futures') return 'BITGET';
  return card.market === 'US' ? 'US' : 'KR';
}

function strategyLabel(strategy: UnifiedScannerStrategyMode): string {
  return SCANNER_STRATEGY_OPTIONS.find((item) => item.value === strategy)?.label ?? strategy;
}

function defaultEmbeddedTimeframe(strategy: UnifiedScannerStrategyMode): SignalScannerRequest['timeframe'] {
  return strategy === 'scalping' ? '5m' : '1D';
}

const OUTCOME_COPY: Record<ScannerOutcomeCode, { title: string; description: string }> = {
  CANDIDATES_AVAILABLE: { title: 'CANDIDATES_AVAILABLE', description: '검증 후보를 표시했습니다.' },
  VALID_ZERO_SIGNAL: { title: 'VALID_ZERO_SIGNAL', description: '공급자 데이터와 분석은 정상이며 현재 조건에 맞는 신호만 없습니다.' },
  UNIVERSE_EMPTY: { title: 'UNIVERSE_EMPTY', description: '선택 시장의 스캔 대상 유니버스가 비어 있습니다.' },
  PROVIDER_FAILURE: { title: 'PROVIDER_FAILURE', description: '시장데이터 공급 실패이며 정상적인 신호 0건이 아닙니다.' },
  SYMBOL_MAPPING_FAILURE: { title: 'SYMBOL_MAPPING_FAILURE', description: '공급자 심볼을 표준 자산 코드로 연결하지 못했습니다.' },
  REQUEST_TIMEOUT: { title: 'REQUEST_TIMEOUT', description: '요청 제한시간 안에 검증을 완료하지 못했습니다.' },
  DATA_QUALITY_REJECT: { title: 'DATA_QUALITY_REJECT', description: '응답은 받았지만 데이터 품질 기준을 통과하지 못했습니다.' },
  FILTER_TOO_STRICT: { title: 'FILTER_TOO_STRICT', description: '데이터는 정상이지만 현재 Risk·전략 필터가 모든 후보를 제외했습니다.' },
  FRONTEND_RENDER_FAILURE: { title: 'FRONTEND_RENDER_FAILURE', description: 'API 후보가 있으나 화면에서 안전하게 표시할 수 없습니다.' },
};

function formatObservedAt(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '미확인';
  return new Date(value).toLocaleString('ko-KR');
}

function remainingValidityLabel(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'TTL 미확인';
  const remainingMs = Date.parse(value) - Date.now();
  if (remainingMs <= 0) return 'TTL 만료';
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  if (remainingMinutes < 60) return `TTL ${remainingMinutes}분`;
  const remainingHours = Math.ceil(remainingMinutes / 60);
  if (remainingHours < 24) return `TTL ${remainingHours}시간`;
  return `TTL ${Math.ceil(remainingHours / 24)}일`;
}

function SignalDetailPanel({
  card,
  selection,
  showOrderPreparation,
  onClose,
  onOpenAsset,
  onAiChart,
  onOrderPreparation,
}: {
  card: ScannerSignalCard;
  selection: AnalysisSelection;
  showOrderPreparation: boolean;
  onClose?: () => void;
  onOpenAsset: () => void;
  onAiChart: () => void;
  onOrderPreparation: () => void;
}) {
  const matchedEvidence = card.evidence.filter((item) => item.status === 'matched');
  const why = matchedEvidence.flatMap((item) => item.reasons).filter(Boolean).slice(0, 8);
  const missing = [...new Set([...card.unverified, ...(card.aiValidation?.missingData ?? [])])];
  const risks = [...new Set([...card.warnings, ...(card.aiValidation?.risks ?? [])])];
  const mobile = Boolean(onClose);
  const [mobileTab, setMobileTab] = useState<MobileDetailTab>(() => showOrderPreparation ? 'risk' : 'summary');
  const quality = card.backtestQuality;

  useEffect(() => {
    setMobileTab('summary');
  }, [card.signalId]);

  useEffect(() => {
    if (showOrderPreparation) setMobileTab('risk');
  }, [showOrderPreparation]);

  const summaryContent = (
    <div data-testid="scanner-mobile-summary" className="space-y-3">
      <section aria-label="이 신호인 이유" className="rounded-2xl border border-primary/25 bg-primary/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-black">왜 이 신호인가 · 핵심 판단</h3>
          <span className="rounded-full border border-primary/25 px-2 py-1 text-[10px] font-black text-primary">{actionLabel(card)}</span>
        </div>
        {why.length > 0
          ? <ul className="mt-2 space-y-1 text-xs leading-5">{why.slice(0, 3).map((reason, index) => <li key={`${reason}:${index}`}>• {reason}</li>)}</ul>
          : <p className="mt-2 text-xs text-muted-foreground">검증된 이유 설명이 없습니다. 근거가 없는 설명은 만들지 않습니다.</p>}
        <p className="mt-2 break-words text-[10px] leading-4 text-muted-foreground">근거 소스 {matchedEvidence.length ? [...new Set(matchedEvidence.map((item) => item.source).filter(Boolean))].join(' · ') : '미확인'}</p>
      </section>

      <section className="rounded-2xl border border-card-border p-3" data-testid="scanner-price-plan">
        <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-black">진입 · 손절 · 목표</h3><span className="rounded-full border border-card-border px-2 py-1 text-[9px] font-black">NO SYNTHETIC PRICE</span></div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">진입</p><p className="text-xs font-black">{card.pricePlan.entryZone ? `${formatNumber(card.pricePlan.entryZone.from)}~${formatNumber(card.pricePlan.entryZone.to)}` : '미확인'}</p></div>
          <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">손절</p><p className="text-xs font-black">{formatNumber(card.pricePlan.stopLoss)}</p></div>
          <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">목표1</p><p className="text-xs font-black">{formatNumber(card.pricePlan.targets[0])}</p></div>
          <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">R:R</p><p className="text-xs font-black">{card.pricePlan.riskReward == null ? '미확인' : card.pricePlan.riskReward.toFixed(2)}</p></div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" aria-label="AI 차트 분석기에서 보기" onClick={onAiChart} className="min-h-11 rounded-xl bg-primary px-3 text-xs font-black text-primary-foreground">AI Chart</button>
        <button type="button" aria-label="주문 준비 열기" onClick={onOrderPreparation} className="min-h-11 rounded-xl border border-primary/40 px-3 text-xs font-black">Order Preparation</button>
      </div>
    </div>
  );

  const evidenceContent = (
    <div data-testid={mobile ? 'scanner-mobile-evidence' : 'scanner-desktop-evidence'} className={`${mobile ? '' : 'mt-3 '}space-y-3`}>
      <section aria-label="이 신호인 이유" className="rounded-2xl border border-primary/25 bg-primary/5 p-3">
        <h3 className="text-xs font-black">왜 이 신호인가</h3>
        {why.length > 0
          ? <ul className="mt-2 space-y-1 text-xs leading-5">{why.map((reason, index) => <li key={`${reason}:${index}`}>• {reason}</li>)}</ul>
          : <p className="mt-2 text-xs text-muted-foreground">검증된 이유 설명이 없습니다. 근거가 없는 설명은 만들지 않습니다.</p>}
      </section>
      <div className="grid gap-2 sm:grid-cols-3">
        <section className="rounded-2xl border border-card-border p-3"><h3 className="text-xs font-black">일치 근거</h3><div className="mt-2 flex flex-wrap gap-1">{card.matched.length ? card.matched.map((item) => <span key={item} className="max-w-full break-words rounded-lg bg-positive/10 px-2 py-1 text-[10px] text-positive">{item}</span>) : <span className="text-[10px] text-muted-foreground">없음</span>}</div></section>
        <section className="rounded-2xl border border-card-border p-3"><h3 className="text-xs font-black">불일치 조건</h3><div className="mt-2 flex flex-wrap gap-1">{card.notMatched.length ? card.notMatched.map((item) => <span key={item} className="max-w-full break-words rounded-lg bg-destructive/10 px-2 py-1 text-[10px] text-destructive">{item}</span>) : <span className="text-[10px] text-muted-foreground">없음</span>}</div></section>
        <section className="rounded-2xl border border-card-border p-3"><h3 className="text-xs font-black">누락·미검증</h3><div className="mt-2 flex flex-wrap gap-1">{missing.length ? missing.map((item) => <span key={item} className="max-w-full break-words rounded-lg bg-warning/10 px-2 py-1 text-[10px] text-warning">{item}</span>) : <span className="text-[10px] text-muted-foreground">없음</span>}</div></section>
      </div>
    </div>
  );

  const performanceContent = (
    <section data-testid="scanner-mobile-performance" className="rounded-2xl border border-card-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-black">검증 성과</h3>
        <span className="rounded-full border border-card-border px-2 py-1 text-[9px] font-black">{quality?.status ?? 'missing'}</span>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">검증 이력이 없거나 표본이 부족하면 0%로 만들지 않고 미확인으로 표시합니다.</p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">OOS 승률</p><p className="text-xs font-black">{formatMetric(quality?.oosWinRate, '%')}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">WF 승률</p><p className="text-xs font-black">{formatMetric(quality?.walkForwardWinRate, '%')}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Expectancy</p><p className="text-xs font-black">{formatMetric(quality?.expectancyPercent, '%')}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Profit Factor</p><p className="text-xs font-black">{formatMetric(quality?.profitFactor)}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">MDD</p><p className="text-xs font-black">{formatMetric(quality?.maxDrawdownPercent, '%')}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">표본 거래</p><p className="text-xs font-black">{formatMetric(quality?.tradeCount)}</p></div>
      </div>
      <p className="mt-3 text-[10px] leading-4 text-muted-foreground">비용 반영 {quality?.costsIncluded === true ? '확인' : '미확인'} · 슬리피지 {quality?.slippageIncluded === true ? '확인' : '미확인'} · Regime {quality?.regime ?? '미확인'}</p>
    </section>
  );

  const chartContent = (
    <section data-testid="scanner-mobile-chart" className="rounded-2xl border border-card-border p-3">
      <h3 className="text-xs font-black">AI Chart</h3>
      <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">모바일 상세 안에 차트를 길게 끼워 넣지 않고 전체 차트 화면으로 전환해 세로 스크롤을 줄입니다.</p>
      <button type="button" aria-label="AI 차트 분석기에서 보기" onClick={onAiChart} className="mt-3 min-h-11 w-full rounded-xl bg-primary px-3 text-sm font-black text-primary-foreground">AI Chart 전체화면 열기</button>
    </section>
  );

  const riskContent = (
    <div data-testid="scanner-mobile-risk" className="space-y-3">
      <section className="rounded-2xl border border-card-border p-3">
        <h3 className="text-xs font-black">위험 · 데이터 상태</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Risk</p><p className="text-xs font-black">{card.riskScore ?? '미확인'} · {card.riskLevel}</p></div>
          <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Data</p><p className="text-xs font-black">{card.dataState}</p></div>
        </div>
        <p className="mt-2 break-words text-[11px] leading-5 text-muted-foreground">출처 {card.dataSources.length ? card.dataSources.join(' · ') : '미확인'}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">관측 {formatObservedAt(card.observedAt)} · 만료 {formatObservedAt(card.expiresAt)}</p>
        {risks.length ? <ul className="mt-2 space-y-1 text-[11px] leading-5 text-warning">{risks.map((risk) => <li key={risk}>• {risk}</li>)}</ul> : <p className="mt-2 text-[11px] text-muted-foreground">추가 Risk 경고 없음</p>}
      </section>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" aria-label="주문 준비 열기" onClick={onOrderPreparation} className="min-h-11 rounded-xl border border-primary/40 px-3 text-sm font-black">Order Preparation</button>
        <button type="button" onClick={onOpenAsset} className="min-h-11 rounded-xl border border-card-border px-3 text-sm font-bold">자산 상세</button>
      </div>
      <p className="text-center text-[10px] font-bold text-muted-foreground">두 액션 모두 클릭만으로 주문을 제출하지 않습니다 · real order 0</p>
      {showOrderPreparation ? (
        <div data-testid="order-preparation" className="border-t border-card-border pt-3">
          <div className="mb-3 rounded-2xl border border-warning/30 bg-warning/10 p-3">
            <h3 className="text-xs font-black">Order Preparation · 실행 아님</h3>
            <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">기존 Risk Engine·승인형 Paper 계획만 재사용합니다. 이 화면은 실주문을 전송하지 않습니다.</p>
          </div>
          <ScannerApprovalComposer selection={selection} />
        </div>
      ) : null}
    </div>
  );

  const mobileContent = mobileTab === 'summary'
    ? summaryContent
    : mobileTab === 'chart'
      ? chartContent
      : mobileTab === 'evidence'
        ? evidenceContent
        : mobileTab === 'performance'
          ? performanceContent
          : riskContent;

  return (
    <section data-testid="signal-detail" aria-label="Signal Detail" className="min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-black text-primary">Signal Detail</p>
          <h2 className="mt-1 break-words text-lg font-black">{card.name} · {card.symbol}</h2>
          <p className="mt-1 text-xs font-bold text-muted-foreground">{card.market} · {card.exchange ?? '거래소 미확인'} · {card.assetType}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            <span data-testid="scanner-direction-badge" className="rounded-full border border-primary/30 bg-primary/5 px-2 py-1 text-[10px] font-black">{actionLabel(card)}</span>
            <span data-testid="scanner-evidence-grade" className="rounded-full border border-card-border px-2 py-1 text-[10px] font-black">등급 {evidenceGradeLabel(card)}</span>
            <span data-testid="scanner-ttl-badge" className="rounded-full border border-card-border px-2 py-1 text-[10px] font-black">{remainingValidityLabel(card.expiresAt)}</span>
          </div>
        </div>
        {onClose ? <button type="button" onClick={onClose} aria-label="Signal Detail 닫기" className="min-h-11 shrink-0 rounded-xl border border-card-border px-3 text-xs font-black">닫기</button> : null}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">현재가</p><p className="mt-1 break-words text-sm font-black">{formatNumber(card.price, card.currency === 'KRW' ? 0 : 6)} {card.currency}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Signal Score</p><p className="mt-1 text-sm font-black">{card.score}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Confidence</p><p className="mt-1 text-sm font-black">{card.confidence}</p></div>
        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Risk</p><p className="mt-1 text-sm font-black">{card.riskScore ?? '미확인'} · {card.riskLevel}</p></div>
      </div>

      {mobile ? (
        <>
          <div role="tablist" aria-label="Signal Detail 모바일 탭" data-testid="scanner-mobile-detail-tabs" className="mt-3 flex gap-1 overflow-x-auto overscroll-x-contain pb-1">
            {MOBILE_DETAIL_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={mobileTab === tab.value}
                onClick={() => setMobileTab(tab.value)}
                className={`min-h-11 shrink-0 rounded-xl border px-3 text-xs font-black ${mobileTab === tab.value ? 'border-primary bg-primary/10 text-primary' : 'border-card-border bg-background'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="mt-2" data-testid={`scanner-mobile-detail-panel-${mobileTab}`}>
            {mobileContent}
          </div>
        </>
      ) : (
        <>
          {evidenceContent}
          <section className="mt-3 rounded-2xl border border-card-border p-3" data-testid="scanner-price-plan">
            <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-black">PricePlan · 서버 계산값만 표시</h3><span className="rounded-full border border-card-border px-2 py-1 text-[9px] font-black">NO SYNTHETIC PRICE</span></div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-center sm:grid-cols-5">
              <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">진입</p><p className="text-xs font-black">{card.pricePlan.entryZone ? `${formatNumber(card.pricePlan.entryZone.from)}~${formatNumber(card.pricePlan.entryZone.to)}` : '미확인'}</p></div>
              <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">손절</p><p className="text-xs font-black">{formatNumber(card.pricePlan.stopLoss)}</p></div>
              <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">목표1</p><p className="text-xs font-black">{formatNumber(card.pricePlan.targets[0])}</p></div>
              <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">목표2</p><p className="text-xs font-black">{formatNumber(card.pricePlan.targets[1])}</p></div>
              <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">R:R</p><p className="text-xs font-black">{card.pricePlan.riskReward == null ? '미확인' : card.pricePlan.riskReward.toFixed(2)}</p></div>
            </div>
          </section>
          <section className="mt-3 rounded-2xl border border-card-border p-3">
            <h3 className="text-xs font-black">데이터 근거·Freshness</h3>
            <p className="mt-2 break-words text-[11px] leading-5 text-muted-foreground">출처 {card.dataSources.length ? card.dataSources.join(' · ') : '미확인'}</p>
            <p className="mt-1 break-words text-[11px] leading-5 text-muted-foreground">근거 소스 {matchedEvidence.length ? [...new Set(matchedEvidence.map((item) => item.source).filter(Boolean))].join(' · ') : '미확인'}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">관측 {formatObservedAt(card.observedAt)} · 만료 {formatObservedAt(card.expiresAt)} · {card.dataState}</p>
            {risks.length ? <ul className="mt-2 space-y-1 text-[11px] leading-5 text-warning">{risks.map((risk) => <li key={risk}>• {risk}</li>)}</ul> : <p className="mt-2 text-[11px] text-muted-foreground">추가 Risk 경고 없음</p>}
          </section>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" aria-label="AI 차트 분석기에서 보기" onClick={onAiChart} className="min-h-11 rounded-xl bg-primary px-3 text-sm font-black text-primary-foreground">AI Chart</button>
            <button type="button" aria-label="주문 준비 열기" onClick={onOrderPreparation} className="min-h-11 rounded-xl border border-primary/40 px-3 text-sm font-black">Order Preparation</button>
            <button type="button" onClick={onOpenAsset} className="col-span-2 min-h-11 rounded-xl border border-card-border px-3 text-sm font-bold">기존 자산 상세 열기</button>
          </div>
          <p className="mt-2 text-center text-[10px] font-bold text-muted-foreground">두 액션 모두 클릭만으로 주문을 제출하지 않습니다 · real order 0</p>
          {showOrderPreparation ? (
            <div data-testid="order-preparation" className="mt-4 border-t border-card-border pt-4">
              <div className="mb-3 rounded-2xl border border-warning/30 bg-warning/10 p-3">
                <h3 className="text-xs font-black">Order Preparation · 실행 아님</h3>
                <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">기존 Risk Engine·승인형 Paper 계획만 재사용합니다. 이 화면은 실주문을 전송하지 않습니다.</p>
              </div>
              <ScannerApprovalComposer selection={selection} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default function SignalScannerPage({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const assetMode = useAssetMode();
  const analysisSelection = useAnalysisSelection();
  const initialView: ScannerView = assetMode.asset === 'coin'
    ? assetMode.coinMarket === 'futures' ? 'FUTURES' : 'SPOT'
    : assetMode.stockMarket;
  const initialStrategy: UnifiedScannerStrategyMode = initialView === 'KR' || initialView === 'US' ? 'swing' : 'scalping';
  const [view, setView] = useState<ScannerView>(initialView);
  const [strategy, setStrategy] = useState<UnifiedScannerStrategyMode>(initialStrategy);
  const [embeddedTimeframe, setEmbeddedTimeframe] = useState<SignalScannerRequest['timeframe']>(() => defaultEmbeddedTimeframe(initialStrategy));
  const [cursor, setCursor] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [status, setStatus] = useState<RequestStatus>('loading');
  const [data, setData] = useState<ScannerResponse | null>(null);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [showOrderPreparation, setShowOrderPreparation] = useState(false);
  const dataRef = useRef<ScannerResponse | null>(null);
  dataRef.current = data;
  const [errorMessage, setErrorMessage] = useState('');
  const latestSequence = useRef(0);
  const lastGeneratedAt = useRef<string | null>(null);
  const displayedRequestKey = useRef<string | null>(null);

  const market = viewMarket(view);
  const profile = useMemo(() => getScannerUiProfile(market, strategy), [market, strategy]);
  const effectiveTimeframe = embedded ? embeddedTimeframe : profile.timeframe;
  const stockView = view === 'KR' || view === 'US';
  const batchSize = stockView ? 100 : 24;
  const profileRequest = useMemo<SignalScannerRequest>(() => ({
    assetClass: stockView ? 'stock' : view === 'SPOT' ? 'coin_spot' : 'coin_futures',
    market: view === 'KR' ? 'KR' : view === 'US' ? 'US' : view === 'SPOT' ? 'UPBIT' : 'BITGET',
    strategy,
    timeframe: profile.timeframe,
    conditions: [],
    condition: !stockView && strategy === 'scalping' ? 'williams' : 'trend',
    cursor,
    batchSize,
    minimumScore: 55,
    maximumRiskScore: 70,
  }), [batchSize, cursor, profile.timeframe, stockView, strategy, view]);
  const request = useMemo<SignalScannerRequest>(
    () => embedded ? { ...profileRequest, timeframe: embeddedTimeframe } : profileRequest,
    [embedded, embeddedTimeframe, profileRequest],
  );
  const requestKey = useMemo(() => JSON.stringify(request), [request]);

  const normalizedCards = useMemo(() => {
    if (!data?.cards) return [];
    const map = new Map<string, ScannerSignalCard>();
    for (const card of data.cards) {
      if (!card?.signalId || !card.symbol || !card.name) continue;
      if (!map.has(card.symbol)) map.set(card.symbol, card);
    }
    return Array.from(map.values());
  }, [data?.cards]);
  const selectedCard = useMemo(
    () => normalizedCards.find((card) => card.signalId === selectedSignalId) ?? null,
    [normalizedCards, selectedSignalId],
  );
  const outcome = data ? deriveScannerDisplayOutcome(data, normalizedCards.length) : null;

  useEffect(() => {
    setCursor(0);
    if (view === 'KR' || view === 'US') {
      assetMode.setAsset('stock');
      assetMode.setStockMarket(view);
    } else {
      assetMode.setAsset('coin');
      assetMode.setCoinMarket(view === 'FUTURES' ? 'futures' : 'spot');
    }
  }, [view]);

  useEffect(() => {
    lastGeneratedAt.current = null;
    setSelectedSignalId(null);
    setDetailOpen(false);
    setShowOrderPreparation(false);
  }, [requestKey]);

  useEffect(() => {
    if (selectedSignalId && !normalizedCards.some((card) => card.signalId === selectedSignalId)) {
      setSelectedSignalId(null);
      setDetailOpen(false);
      setShowOrderPreparation(false);
    }
  }, [normalizedCards, selectedSignalId]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = latestSequence.current + 1;
    latestSequence.current = sequence;
    if (displayedRequestKey.current !== requestKey) setStatus('loading');
    setErrorMessage('');
    void fetchSignalScanner(request, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || latestSequence.current !== sequence) return;
        if (lastGeneratedAt.current && new Date(result.generatedAt) < new Date(lastGeneratedAt.current)) return;
        lastGeneratedAt.current = result.generatedAt;
        displayedRequestKey.current = requestKey;
        setData(result);
        setErrorMessage(result.refreshIssue?.message ?? '');
        setStatus(
          result.execution.partial || result.dataState === 'partial' || result.dataState === 'stale' || result.dataState === 'untrusted'
            ? 'partial'
            : result.cards.length === 0 ? 'empty' : 'success',
        );
      })
      .catch((error: unknown) => {
        if (latestSequence.current !== sequence) return;
        if (controller.signal.aborted) {
          if (displayedRequestKey.current !== requestKey) setStatus('cancelled');
          return;
        }
        const message = requestErrorMessage(error);
        setErrorMessage(message);
        if (error instanceof SignalScannerRequestError && [409, 429, 502].includes(error.status) && dataRef.current) {
          setStatus('partial');
          return;
        }
        setStatus('error');
      });
    return () => controller.abort();
  }, [request, requestKey, refreshToken]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') setRefreshToken((value) => value + 1);
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRefreshToken((value) => value + 1);
    }, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, []);

  const selectStrategy = (next: UnifiedScannerStrategyMode) => {
    setCursor(0);
    setStrategy(next);
    if (embedded) setEmbeddedTimeframe(defaultEmbeddedTimeframe(next));
  };

  const selectionFor = (card: ScannerSignalCard): AnalysisSelection => ({
      assetType: card.assetClass,
      market: analysisMarket(card),
      symbol: card.symbol,
      ticker: card.symbol,
      displayName: card.name,
      timeframe: data?.timeframe ?? effectiveTimeframe,
      searchRunId: data?.requestId,
      signalScore: card.score,
      signalRank: card.candidateRanking?.rank,
      confidence: card.confidence,
      riskLevel: card.riskLevel,
      action: card.action,
      pricePlan: card.pricePlan,
      matchedSignals: card.matched,
      reasons: card.evidence.filter((item) => item.status === 'matched').flatMap((item) => item.reasons).slice(0, 20),
      selectedAt: new Date().toISOString(),
  });

  const selectSignal = (card: ScannerSignalCard) => {
    setSelectedSignalId(card.signalId);
    setShowOrderPreparation(false);
    setDetailOpen(true);
    analysisSelection.select(selectionFor(card));
  };

  const openInAiChart = (card: ScannerSignalCard) => {
    const selection = selectionFor(card);
    analysisSelection.select(selection);
    if (!embedded) {
      const params = new URLSearchParams(selectionQuery(selection));
      params.set('signalId', card.signalId);
      const chartStrategyMode = card.strategyMode ?? strategy;
      params.set('strategyMode', toAiChartStrategyMode(chartStrategyMode));
      navigate(`/ai-chart?${params.toString()}`);
    }
  };

  const openOrderPreparation = (card: ScannerSignalCard) => {
    const selection = selectionFor(card);
    analysisSelection.select(selection);
    setSelectedSignalId(card.signalId);
    setShowOrderPreparation(true);
    setDetailOpen(true);
  };

  return (
    <main className={`h-full min-h-0 overflow-y-auto overscroll-contain bg-background ${embedded ? '' : 'pb-24'}`}>
      <div className="mx-auto w-full max-w-6xl space-y-4 p-3 sm:p-5">
        <header className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-primary">공개 시장데이터 전용 · 자동 전략 Profile</p>
              <h1 className="mt-1 text-xl font-black">AI 신호검색기</h1>
              <p className="mt-1 hidden max-w-3xl break-keep text-xs leading-relaxed text-muted-foreground sm:block">
                시장과 투자 스타일만 선택하면 시간봉·기술지표·패턴·변동성·거래량·추세·시장국면·리스크 조건을 내부 엔진이 자동 조합합니다. 계좌·주문·취소 API는 호출하지 않습니다.
              </p>
            </div>
            <button type="button" onClick={() => setRefreshToken((value) => value + 1)} className="min-h-11 shrink-0 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground">
              새로고침
            </button>
          </div>
        </header>

        <section aria-label="검색 시장" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {VIEWS.map((item) => (
            <button key={item.value} type="button" aria-pressed={view === item.value} onClick={() => { setCursor(0); setView(item.value); }}
              className={`min-h-14 rounded-2xl border px-3 py-2 text-left ${view === item.value ? 'border-primary bg-primary/10' : 'border-card-border bg-card'}`}>
              <span className="block break-keep text-sm font-black">{item.label}</span>
              <span className="hidden break-keep text-[11px] text-muted-foreground sm:block">{item.description}</span>
            </button>
          ))}
        </section>

        <section aria-label="검색 전략" className="grid grid-cols-3 gap-2">
          {SCANNER_STRATEGY_OPTIONS.map((item) => (
            <button key={item.value} type="button" aria-label={embedded ? `${item.label} Engine` : undefined} aria-pressed={strategy === item.value} onClick={() => selectStrategy(item.value)}
              className={`min-h-16 rounded-2xl border px-3 py-3 text-left ${strategy === item.value ? 'border-primary bg-primary/10' : 'border-card-border bg-card'}`}>
              <span className="block break-keep text-sm font-black">{item.label}</span>
              <span className="mt-1 hidden break-keep text-[10px] text-muted-foreground sm:block">{item.description}</span>
            </button>
          ))}
        </section>

        <section aria-label="자동 전략 안내" className="rounded-3xl border border-card-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-black">{strategyLabel(strategy)} · 자동 Profile</p>
              <p className="mt-1 break-keep text-xs text-muted-foreground">분석 시간봉 {effectiveTimeframe} · 확인 시간봉과 지표 가중치는 시장별 Profile에서 자동 관리</p>
            </div>
            <span className="rounded-full border border-card-border px-3 py-1 text-[11px] font-bold">{profile.profileVersion}</span>
          </div>
          <p className="mt-2 hidden break-keep text-[11px] text-muted-foreground sm:block">기술지표 직접 선택은 기본 화면에 노출하지 않습니다. 상세 근거는 결과 카드에서 확인할 수 있습니다.</p>
          {embedded && (
            <label className="mt-3 block space-y-1 text-xs font-bold">
              시간봉
              <select
                aria-label="시간봉"
                value={embeddedTimeframe}
                onChange={(event) => { setCursor(0); setEmbeddedTimeframe(event.target.value as SignalScannerRequest['timeframe']); }}
                className="min-h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm"
              >
                {EMBEDDED_TIMEFRAMES[strategy].map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <span className="block text-[10px] font-normal text-muted-foreground">기술 워크스페이스의 회귀·연구 검증에서만 시간봉을 직접 전환합니다. 기본 Scanner 화면은 자동 Profile을 유지합니다.</span>
            </label>
          )}
        </section>

        {status === 'loading' && <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-8 text-center"><p className="font-bold">시장데이터를 분석하고 있습니다.</p></section>}
        {status === 'cancelled' && <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-5 text-sm">이전 요청을 취소하고 최신 선택으로 다시 분석합니다.</section>}
        {errorMessage && status === 'partial' && <section role="alert" className="rounded-3xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm"><p className="font-black">최신 결과 갱신 대기</p><p className="mt-1 text-xs text-muted-foreground">{errorMessage}</p></section>}
        {status === 'error' && <section role="alert" className="rounded-3xl border border-destructive/40 bg-destructive/10 p-5"><p className="font-black text-destructive">검색 실패</p><p className="mt-2 text-sm">{errorMessage}</p><button type="button" onClick={() => setRefreshToken((value) => value + 1)} className="mt-4 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-bold">다시 시도</button></section>}

        {data && status !== 'loading' && status !== 'error' && (
          <>
            <section data-testid={status === 'partial' ? 'scanner-partial' : undefined} className={`rounded-3xl border p-4 ${status === 'partial' ? 'border-amber-500/40 bg-amber-500/10' : 'border-card-border bg-card'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="text-sm font-black">{data.message}</p><p className="mt-1 text-xs text-muted-foreground">{strategyLabel(strategy)} · {data.timeframe} · {new Date(data.generatedAt).toLocaleString('ko-KR')}</p></div>
                <div className="flex flex-wrap justify-end gap-1"><span className="rounded-full border border-card-border px-3 py-1 text-xs font-bold">{data.dataState}</span>{outcome ? <span data-testid="scanner-outcome" className="rounded-full border border-card-border px-3 py-1 text-[10px] font-black">{outcome}</span> : null}</div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">스캔</p><p className="text-sm font-black">{data.execution.requestedCount}</p></div>
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">분석 완료</p><p className="text-sm font-black">{data.execution.dataSuccessCount ?? data.execution.completedCount}</p></div>
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">표시</p><p className="text-sm font-black">{data.execution.finalDisplayedCount ?? normalizedCards.length}</p></div>
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Provider 오류</p><p className="text-sm font-black">{data.execution.providerErrorCount}</p></div>
              </div>
            </section>

            {data.failures.length > 0 && (
              <section className="rounded-3xl border border-amber-500/30 bg-card p-4">
                <h2 className="text-sm font-black">분석하지 못한 종목 {data.failures.length}개</h2>
                <div className="mt-2 space-y-1">
                  {data.failures.map((failure) => (
                    <p key={`${failure.symbol}:${failure.reason}`} className="text-xs text-muted-foreground">{failure.symbol} · {failure.reason}</p>
                  ))}
                </div>
              </section>
            )}

            {data.alerts.length > 0 && (
              <section aria-label="승인 대기 알림" className="rounded-3xl border border-primary/40 bg-primary/10 p-4">
                <h2 className="font-black">승인 대기 알림</h2>
                <p className="mt-1 text-xs text-muted-foreground">상세 정보만 열며 주문을 실행하지 않습니다.</p>
                <div className="mt-3 space-y-2">{data.alerts.map((alert) => (
                  <button key={alert.idempotencyKey} type="button" onClick={() => { const card = normalizedCards.find((item) => item.signalId === alert.signalId); if (card) selectSignal(card); }} className="min-h-11 w-full rounded-xl border border-primary/30 bg-card px-3 py-2 text-left text-sm">
                    <span className="font-black">{alertTitle(alert)}</span>
                  </button>
                ))}</div>
              </section>
            )}

            {normalizedCards.length === 0 ? (
              <section data-testid="scanner-zero-outcome" className="rounded-3xl border border-card-border bg-card p-6 text-center">
                <p className="text-sm font-black">{outcome ? OUTCOME_COPY[outcome].title : 'VALID_ZERO_SIGNAL'}</p>
                <p className="mt-2 break-keep text-xs leading-5 text-muted-foreground">{outcome ? OUTCOME_COPY[outcome].description : '현재 조건에서 표시할 검증 후보가 없습니다.'}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">
                  <span className="rounded-xl bg-background p-2">유니버스 {data.universe.totalCount}</span>
                  <span className="rounded-xl bg-background p-2">완료 {data.execution.completedCount}</span>
                  <span className="rounded-xl bg-background p-2">품질제외 {data.execution.insufficientDataCount ?? 0}</span>
                  <span className="rounded-xl bg-background p-2">필터제외 {data.execution.filteredByStrategyCount ?? 0}</span>
                </div>
              </section>
            ) : (
              <section className={embedded ? 'space-y-3' : 'grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)]'}>
                <div data-testid="scanner-master-list" className="min-w-0 space-y-2">
                  {normalizedCards.map((card) => (
                    <article key={card.signalId} className={`min-w-0 rounded-2xl border bg-card p-3 ${selectedSignalId === card.signalId ? 'border-primary ring-1 ring-primary/20' : 'border-card-border'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <button type="button" aria-label={`${card.name} ${card.symbol} · ${card.market} · ${card.assetType}`} onClick={() => selectSignal(card)} className="min-h-11 min-w-0 flex-1 text-left">
                          <p className="truncate font-black">{card.candidateRanking?.rank ? `${card.candidateRanking.rank}위 · ` : ''}{card.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{card.symbol} · {card.market}</p>
                          <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                            <span data-testid="scanner-card-direction" className="rounded-full border border-primary/30 px-2 py-0.5 text-[10px] font-black">{actionLabel(card)}</span>
                            <span className="rounded-full border border-card-border px-2 py-0.5 text-[10px] font-black">등급 {evidenceGradeLabel(card)}</span>
                            <span className="rounded-full border border-card-border px-2 py-0.5 text-[10px] font-black">{remainingValidityLabel(card.expiresAt)}</span>
                          </div>
                        </button>
                        <div className="shrink-0 text-right"><p className="text-sm font-black">{formatNumber(card.price, card.currency === 'KRW' ? 0 : 6)}</p><p className="text-xs text-muted-foreground">Score {card.score} · Risk {card.riskScore ?? '미확인'}</p></div>
                      </div>
                      <div className="mt-2 flex min-w-0 flex-wrap gap-1">{card.matched.slice(0, 3).map((item) => <span key={item} className="max-w-full truncate rounded-lg bg-background px-2 py-1 text-[10px]">{item}</span>)}{card.unverified.length ? <span className="rounded-lg bg-warning/10 px-2 py-1 text-[10px] text-warning">미검증 {card.unverified.length}</span> : null}</div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <button type="button" aria-label="AI 차트 분석기에서 보기" onClick={() => openInAiChart(card)} className="min-h-11 rounded-xl bg-primary px-2 text-xs font-black text-primary-foreground">AI Chart</button>
                        <button type="button" aria-label={`${card.name} 주문 준비`} onClick={() => openOrderPreparation(card)} className="min-h-11 rounded-xl border border-primary/40 px-2 text-xs font-black">Order Preparation</button>
                      </div>
                    </article>
                  ))}
                  {embedded && selectedCard ? (
                    <div className="hidden pt-2 lg:block">
                      <SignalDetailPanel card={selectedCard} selection={selectionFor(selectedCard)} showOrderPreparation={showOrderPreparation} onOpenAsset={() => navigate(signalScannerDetailPath(selectedCard))} onAiChart={() => openInAiChart(selectedCard)} onOrderPreparation={() => openOrderPreparation(selectedCard)} />
                    </div>
                  ) : null}
                </div>
                {!embedded ? (
                  <aside data-testid="scanner-desktop-detail" className="hidden min-w-0 lg:block">
                    <div className="sticky top-3">
                      {selectedCard ? <SignalDetailPanel card={selectedCard} selection={selectionFor(selectedCard)} showOrderPreparation={showOrderPreparation} onOpenAsset={() => navigate(signalScannerDetailPath(selectedCard))} onAiChart={() => openInAiChart(selectedCard)} onOrderPreparation={() => openOrderPreparation(selectedCard)} /> : <section className="rounded-3xl border border-dashed border-card-border bg-card p-8 text-center"><p className="font-black">Signal Detail</p><p className="mt-2 text-xs text-muted-foreground">왼쪽 후보를 선택하면 근거·누락·PricePlan·Risk와 안전 액션을 표시합니다.</p></section>}
                    </div>
                  </aside>
                ) : null}
              </section>
            )}

            <section className="flex items-center justify-between gap-2">
              <button type="button" disabled={cursor === 0} onClick={() => setCursor((value) => Math.max(0, value - batchSize))} className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold disabled:opacity-40">이전</button>
              <span className="text-xs text-muted-foreground">{cursor + 1}번째부터 · 자동 Profile</span>
              <button type="button" disabled={data.universe.nextCursor == null} onClick={() => setCursor(data.universe.nextCursor ?? cursor)} className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold disabled:opacity-40">다음</button>
            </section>
          </>
        )}
      </div>
      {selectedCard && detailOpen ? (
        <div className="lg:hidden">
          <button type="button" aria-label="Signal Detail 닫기" onClick={() => { setDetailOpen(false); setShowOrderPreparation(false); }} className="fixed inset-0 z-[60] bg-black/45" />
          <div role="dialog" aria-modal="true" aria-label="Signal Detail" data-testid="scanner-mobile-sheet" className="fixed inset-x-0 bottom-0 z-[70] max-h-[calc(100dvh-0.75rem)] overflow-y-auto overscroll-contain rounded-t-3xl bg-background p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shadow-2xl">
            <SignalDetailPanel card={selectedCard} selection={selectionFor(selectedCard)} showOrderPreparation={showOrderPreparation} onClose={() => { setDetailOpen(false); setShowOrderPreparation(false); }} onOpenAsset={() => navigate(signalScannerDetailPath(selectedCard))} onAiChart={() => openInAiChart(selectedCard)} onOrderPreparation={() => openOrderPreparation(selectedCard)} />
          </div>
        </div>
      ) : null}
    </main>
  );
}