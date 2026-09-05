import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, Eye, EyeOff, RefreshCw, ShieldAlert, WalletCards } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import type { AnalysisMarket, AnalysisPricePlan } from '@/lib/analysis-selection';
import {
  buildPositionGuidance,
  feeInclusiveBreakEvenPrice,
  projectPartialExit,
  projectPriceOutcome,
  projectedAverageEntry,
  type FeeEvidence,
} from '@/lib/ai-chart-position-analytics';

export type AiChartAccountPosition = {
  market: string;
  symbol: string;
  quantity: number | null;
  availableQuantity: number | null;
  averageEntryPrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  leverage: number | null;
  liquidationPrice: number | null;
  marginMode: string | null;
  side: string | null;
};

export type AiChartPositionOverlay = {
  provider: 'toss' | 'upbit' | 'bitget';
  position: AiChartAccountPosition;
  stale: boolean;
  checkedAt: string | null;
};

type Snapshot = {
  provider: 'toss' | 'upbit' | 'bitget';
  readOnly: true;
  connected: boolean;
  status: string;
  positions: AiChartAccountPosition[];
  checkedAt: string;
  lastGoodAt: string | null;
  stale: boolean;
  errorCode: string | null;
  orderRequests: 0;
  cancelRequests: 0;
  amendRequests: 0;
  transferRequests: 0;
  withdrawalRequests: 0;
  liveTradingEnabled: false;
  autoTradingEnabled: false;
};

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: Snapshot; position: AiChartAccountPosition | null }
  | { kind: 'unavailable'; code: string };

type Props = {
  market: AnalysisMarket;
  symbol: string;
  chartPrice: number | null;
  pricePlan?: AnalysisPricePlan;
  onOverlayChange: (overlay: AiChartPositionOverlay | null) => void;
};

function providerForMarket(market: AnalysisMarket): Snapshot['provider'] {
  if (market === 'UPBIT') return 'upbit';
  if (market === 'BITGET') return 'bitget';
  return 'toss';
}

function normalizedSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function upbitBaseSymbol(value: string): string {
  const upper = value.trim().toUpperCase();
  if (upper.startsWith('KRW-')) return normalizedSymbol(upper.slice(4));
  if (upper.startsWith('KRW/')) return normalizedSymbol(upper.slice(4));
  return normalizedSymbol(upper);
}

function symbolMatches(market: AnalysisMarket, chartSymbol: string, positionSymbol: string): boolean {
  if (!chartSymbol.trim() || !positionSymbol.trim()) return false;
  if (market === 'UPBIT') return upbitBaseSymbol(chartSymbol) === upbitBaseSymbol(positionSymbol);
  return normalizedSymbol(chartSymbol) === normalizedSymbol(positionSymbol);
}

function positionMarketMatches(market: AnalysisMarket, positionMarket: string): boolean {
  return positionMarket.trim().toUpperCase() === market;
}

function activePosition(position: AiChartAccountPosition): boolean {
  return position.quantity != null && Number.isFinite(position.quantity) && Math.abs(position.quantity) > 0;
}

function selectPosition(
  market: AnalysisMarket,
  symbol: string,
  positions: AiChartAccountPosition[],
): { position: AiChartAccountPosition | null; ambiguous: boolean } {
  const matches = positions.filter((position) => (
    activePosition(position)
    && positionMarketMatches(market, position.market)
    && symbolMatches(market, symbol, position.symbol)
  ));
  if (matches.length > 1) return { position: null, ambiguous: true };
  return { position: matches[0] ?? null, ambiguous: false };
}

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function positiveText(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeText(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 100 ? parsed : null;
}

function formatPrice(value: number | null | undefined, market: AnalysisMarket): string {
  const parsed = finite(value);
  if (parsed == null) return '미제공';
  if (market === 'US') return `$${parsed.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}`;
  if (market === 'BITGET') return `${parsed.toLocaleString('ko-KR', { maximumFractionDigits: parsed >= 1000 ? 2 : 8 })} USDT`;
  return `${parsed.toLocaleString('ko-KR', { maximumFractionDigits: parsed >= 1000 ? 0 : 8 })}원`;
}

function formatQuantity(value: number | null | undefined): string {
  const parsed = finite(value);
  return parsed == null ? '미제공' : parsed.toLocaleString('ko-KR', { maximumFractionDigits: 8 });
}

function formatPnl(value: number | null | undefined, market: AnalysisMarket): string {
  const parsed = finite(value);
  if (parsed == null) return '미제공';
  const sign = parsed > 0 ? '+' : '';
  if (market === 'US') return `${sign}$${parsed.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`;
  if (market === 'BITGET') return `${sign}${parsed.toLocaleString('ko-KR', { maximumFractionDigits: 4 })} USDT`;
  return `${sign}${parsed.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원`;
}

function formatPercent(value: number | null | undefined): string {
  const parsed = finite(value);
  return parsed == null ? '미제공' : `${parsed > 0 ? '+' : ''}${parsed.toFixed(2)}%`;
}

function priceDistance(position: AiChartAccountPosition, chartPrice: number | null): number | null {
  const average = finite(position.averageEntryPrice);
  const current = finite(position.currentPrice) ?? finite(chartPrice);
  if (average == null || current == null || average <= 0) return null;
  const raw = ((current - average) / average) * 100;
  const side = String(position.side ?? '').toLowerCase();
  return side === 'short' ? -raw : raw;
}

function providerLabel(provider: Snapshot['provider']): string {
  return provider === 'toss' ? 'Toss' : provider === 'upbit' ? 'Upbit' : 'Bitget';
}

function checkedAtLabel(value: string | null | undefined): string {
  if (!value) return '미확인';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '미확인';
  return new Date(timestamp).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function pnlSourceLabel(source: 'POSITION_QUANTITY' | 'PROVIDER_IMPLIED' | null): string {
  if (source === 'POSITION_QUANTITY') return '보유수량×가격차';
  if (source === 'PROVIDER_IMPLIED') return 'provider 미실현손익 비례';
  return '금액 근거 없음';
}

export function AiChartPositionPanel({ market, symbol, chartPrice, pricePlan, onOverlayChange }: Props) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [linesVisible, setLinesVisible] = useState(true);
  const [additionalValueText, setAdditionalValueText] = useState('');
  const [additionalPriceText, setAdditionalPriceText] = useState('');
  const [entryFeeText, setEntryFeeText] = useState('');
  const [exitFeeText, setExitFeeText] = useState('');
  const [targetPercents, setTargetPercents] = useState<Record<number, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    requestSequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ kind: 'idle' });
    setLinesVisible(true);
    setAdditionalValueText('');
    setAdditionalPriceText('');
    setEntryFeeText('');
    setExitFeeText('');
    setTargetPercents({});
    onOverlayChange(null);
  }, [market, onOverlayChange, symbol]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const loadPosition = useCallback(async () => {
    const provider = providerForMarket(market);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const sequence = ++requestSequenceRef.current;
    setState({ kind: 'loading' });
    onOverlayChange(null);

    try {
      const response = await authorizedFetch(`/api/accounts/read-only/${provider}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as Snapshot | { errorCode?: string } | null;
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      if (!response.ok) {
        setState({ kind: 'unavailable', code: payload && 'errorCode' in payload && payload.errorCode ? payload.errorCode : `HTTP_${response.status}` });
        return;
      }
      const candidate = payload as Partial<Snapshot> | null;
      if (!candidate || candidate.readOnly !== true || !Array.isArray(candidate.positions)) {
        setState({ kind: 'unavailable', code: 'ACCOUNT_SNAPSHOT_INVALID' });
        return;
      }
      if (candidate.provider !== provider) {
        setState({ kind: 'unavailable', code: 'ACCOUNT_SNAPSHOT_PROVIDER_MISMATCH' });
        return;
      }
      if (candidate.connected !== true) {
        setState({ kind: 'unavailable', code: candidate.errorCode || candidate.status || 'ACCOUNT_NOT_CONNECTED' });
        return;
      }
      const snapshot = candidate as Snapshot;
      if (
        snapshot.orderRequests !== 0
        || snapshot.cancelRequests !== 0
        || snapshot.amendRequests !== 0
        || snapshot.transferRequests !== 0
        || snapshot.withdrawalRequests !== 0
        || snapshot.liveTradingEnabled !== false
        || snapshot.autoTradingEnabled !== false
      ) {
        setState({ kind: 'unavailable', code: 'ACCOUNT_SNAPSHOT_SAFETY_MISMATCH' });
        return;
      }
      const selected = selectPosition(market, symbol, snapshot.positions);
      if (selected.ambiguous) {
        setState({ kind: 'unavailable', code: 'MULTIPLE_MATCHING_POSITIONS' });
        return;
      }
      setState({ kind: 'ready', snapshot, position: selected.position });
      if (selected.position && linesVisible) {
        onOverlayChange({ provider, position: selected.position, stale: snapshot.stale, checkedAt: snapshot.checkedAt ?? null });
      }
    } catch (error) {
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      setState({ kind: 'unavailable', code: error instanceof Error ? error.name : 'ACCOUNT_READ_FAILED' });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [linesVisible, market, onOverlayChange, symbol]);

  const toggleLines = useCallback(() => {
    if (state.kind !== 'ready' || !state.position) return;
    const position = state.position;
    const snapshot = state.snapshot;
    setLinesVisible((current) => {
      const next = !current;
      onOverlayChange(next ? {
        provider: snapshot.provider,
        position,
        stale: snapshot.stale,
        checkedAt: snapshot.checkedAt ?? null,
      } : null);
      return next;
    });
  }, [onOverlayChange, state]);

  const provider = providerForMarket(market);
  const position = state.kind === 'ready' ? state.position : null;
  const distance = position ? priceDistance(position, chartPrice) : null;
  const additionalValue = positiveText(additionalValueText);
  const additionalPrice = positiveText(additionalPriceText);
  const additionalProjection = useMemo(() => position ? projectedAverageEntry({
    market,
    position,
    chartPrice,
    additionalValue,
    additionalPrice,
  }) : null, [additionalPrice, additionalValue, chartPrice, market, position]);
  const guidance = useMemo(() => position ? buildPositionGuidance({ position, chartPrice, pricePlan }) : null, [chartPrice, position, pricePlan]);
  const targetOutcomes = useMemo(() => position
    ? (pricePlan?.targets ?? []).slice(0, 4).map((target) => projectPriceOutcome({ market, position, chartPrice, price: target }))
    : [], [chartPrice, market, position, pricePlan]);
  const riskPrice = pricePlan?.stopLoss ?? pricePlan?.invalidation ?? null;
  const riskOutcome = useMemo(() => position
    ? projectPriceOutcome({ market, position, chartPrice, price: riskPrice })
    : null, [chartPrice, market, position, riskPrice]);
  const entryFee = nonNegativeText(entryFeeText);
  const exitFee = nonNegativeText(exitFeeText);
  const feeInputsPresent = Boolean(entryFeeText.trim() && exitFeeText.trim());
  const feeEvidence: FeeEvidence | null = feeInputsPresent && entryFee != null && exitFee != null
    ? { entryFeePercent: entryFee, exitFeePercent: exitFee, source: 'USER_INPUT' }
    : null;
  const breakEven = useMemo(() => position ? feeInclusiveBreakEvenPrice(position, feeEvidence) : null, [feeEvidence, position]);
  const allocationRows = useMemo(() => (pricePlan?.targets ?? []).slice(0, 4).map((target, index) => {
    const raw = targetPercents[index] ?? '';
    const percent = raw.trim() ? Number(raw) : 0;
    const projection = position && Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? projectPartialExit({ market, position, chartPrice, price: target, percent })
      : null;
    return { target, index, raw, percent, projection };
  }), [chartPrice, market, position, pricePlan, targetPercents]);
  const allocationTotal = allocationRows.reduce((sum, row) => Number.isFinite(row.percent) ? sum + row.percent : sum, 0);
  const allocationValid = allocationTotal <= 100;

  return (
    <section data-testid="ai-chart-position-panel" className="rounded-2xl border border-card-border bg-background/85 p-3 text-left shadow-sm">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <WalletCards className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[11px] font-black text-primary">내 포지션 · READ-ONLY</p>
            <p className="truncate text-[10px] font-bold text-muted-foreground">{providerLabel(provider)} · {symbol}</p>
          </div>
        </div>
        {state.kind === 'idle' || state.kind === 'unavailable' ? (
          <button
            type="button"
            data-testid="ai-chart-load-position"
            onClick={() => void loadPosition()}
            className="flex min-h-10 items-center gap-1.5 rounded-xl border border-card-border px-3 py-2 text-[11px] font-black"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            내 포지션 확인
          </button>
        ) : state.kind === 'loading' ? (
          <span role="status" className="flex min-h-10 items-center gap-1.5 rounded-xl bg-secondary px-3 py-2 text-[11px] font-black text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> 확인 중
          </span>
        ) : position ? (
          <button
            type="button"
            data-testid="ai-chart-toggle-position-lines"
            onClick={toggleLines}
            className="flex min-h-10 items-center gap-1.5 rounded-xl border border-card-border px-3 py-2 text-[11px] font-black"
          >
            {linesVisible ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
            {linesVisible ? '평단선 숨기기' : '평단선 표시'}
          </button>
        ) : null}
      </div>

      {state.kind === 'idle' && (
        <p className="mt-2 text-[10px] font-bold leading-4 text-muted-foreground">차트를 열기만 해서는 계좌를 조회하지 않습니다. 버튼을 눌렀을 때 현재 시장의 조회 전용 스냅샷만 확인합니다.</p>
      )}
      {state.kind === 'unavailable' && (
        <p role="alert" className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-[10px] font-bold text-warning">포지션을 표시할 수 없습니다 · {state.code}</p>
      )}
      {state.kind === 'ready' && !position && (
        <div className="mt-2 rounded-xl bg-secondary/60 px-3 py-2">
          <p className="text-[10px] font-black">현재 선택 종목의 보유/포지션 없음</p>
          <p className="mt-1 text-[9px] font-bold text-muted-foreground">조회 시각 {checkedAtLabel(state.snapshot.checkedAt)}{state.snapshot.stale ? ' · 이전 정상값' : ''}</p>
        </div>
      )}
      {state.kind === 'ready' && position && (
        <div className="mt-2 space-y-2.5">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-6">
            <Metric label="내 평단" value={formatPrice(position.averageEntryPrice, market)} />
            <Metric label="보유수량" value={formatQuantity(position.quantity)} />
            <Metric label="미실현손익" value={formatPnl(position.unrealizedPnl, market)} />
            <Metric label="계좌 수익률" value={formatPercent(position.unrealizedPnlPercent)} />
            <Metric label="평단 대비 가격" value={formatPercent(distance)} />
            {market === 'BITGET' ? <Metric label="청산가" value={formatPrice(position.liquidationPrice, market)} /> : <Metric label="계좌 현재가" value={formatPrice(position.currentPrice, market)} />}
          </div>

          {market === 'BITGET' && (
            <div className="flex flex-wrap gap-1.5 text-[9px] font-black text-muted-foreground">
              <span className="rounded-full bg-secondary px-2 py-1">방향 {position.side ?? '미제공'}</span>
              <span className="rounded-full bg-secondary px-2 py-1">레버리지 {finite(position.leverage) == null ? '미제공' : `${position.leverage}x`}</span>
              <span className="rounded-full bg-secondary px-2 py-1">마진 {position.marginMode ?? '미제공'}</span>
            </div>
          )}

          {guidance && (
            <div data-testid="ai-chart-position-guidance" className="rounded-xl border border-card-border bg-secondary/35 p-3">
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                <p className="text-[10px] font-black">AI 포지션 보조 판단 · 결정론적</p>
              </div>
              <p className="mt-1 text-[12px] font-black">{guidance.headline}</p>
              <p className="mt-1 text-[9px] font-bold leading-4 text-muted-foreground">{guidance.detail}</p>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] font-black text-muted-foreground">
                <span className="rounded-full bg-background px-2 py-1">평단대비 {formatPercent(guidance.averageDistancePercent)}</span>
                <span className="rounded-full bg-background px-2 py-1">손절까지 {guidance.stopGapPercent == null ? '미제공' : `${guidance.stopGapPercent.toFixed(2)}%`}</span>
                <span className="rounded-full bg-background px-2 py-1">다음 목표까지 {guidance.targetGapPercent == null ? '미제공' : `${guidance.targetGapPercent.toFixed(2)}%`}</span>
                {market === 'BITGET' && <span className="rounded-full bg-background px-2 py-1">청산가까지 {guidance.liquidationGapPercent == null ? '미제공' : `${guidance.liquidationGapPercent.toFixed(2)}%`}</span>}
              </div>
              <p className="mt-1.5 text-[8px] font-bold text-muted-foreground">실행 신호가 아니며 주문 권한이 없습니다. 실제 계좌값·차트 가격·Scanner PricePlan이 있는 범위만 사용합니다.</p>
            </div>
          )}

          <div data-testid="ai-chart-price-scenarios" className="rounded-xl border border-card-border p-3">
            <div className="flex items-center gap-1.5">
              <Calculator className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              <p className="text-[10px] font-black">목표/손절 예상손익 · 수수료 전</p>
            </div>
            {(pricePlan?.targets?.length ?? 0) === 0 && riskPrice == null ? (
              <p className="mt-2 text-[9px] font-bold text-muted-foreground">Scanner PricePlan이 없어 목표/손절 금액을 임의 생성하지 않습니다.</p>
            ) : (
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {targetOutcomes.map((outcome, index) => outcome ? (
                  <ScenarioRow
                    key={`target-${index}`}
                    label={`목표 ${index + 1}`}
                    price={formatPrice(outcome.price, market)}
                    percent={formatPercent(outcome.priceReturnPercent)}
                    pnl={formatPnl(outcome.pnlAmount, market)}
                    source={pnlSourceLabel(outcome.pnlSource)}
                  />
                ) : null)}
                {riskOutcome && (
                  <ScenarioRow
                    label={pricePlan?.stopLoss != null ? '손절' : '무효화'}
                    price={formatPrice(riskOutcome.price, market)}
                    percent={formatPercent(riskOutcome.priceReturnPercent)}
                    pnl={formatPnl(riskOutcome.pnlAmount, market)}
                    source={pnlSourceLabel(riskOutcome.pnlSource)}
                  />
                )}
              </div>
            )}
          </div>

          <div data-testid="ai-chart-additional-entry" className="rounded-xl border border-card-border p-3">
            <p className="text-[10px] font-black">추가 진입 후 예상평단</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <label className="text-[9px] font-bold text-muted-foreground">
                {market === 'BITGET' ? '추가 수량' : `추가 금액 (${market === 'US' ? 'USD' : 'KRW'})`}
                <input
                  data-testid="ai-chart-additional-value"
                  inputMode="decimal"
                  value={additionalValueText}
                  onChange={(event) => setAdditionalValueText(event.target.value)}
                  placeholder={market === 'BITGET' ? '예: 0.01' : '예: 300000'}
                  className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-3 text-[11px] font-black text-foreground"
                />
              </label>
              <label className="text-[9px] font-bold text-muted-foreground">
                추가 진입가 · 비우면 현재가
                <input
                  data-testid="ai-chart-additional-price"
                  inputMode="decimal"
                  value={additionalPriceText}
                  onChange={(event) => setAdditionalPriceText(event.target.value)}
                  placeholder={formatPrice(finite(position.currentPrice) ?? chartPrice, market)}
                  className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-3 text-[11px] font-black text-foreground"
                />
              </label>
              <Metric label="예상 새 평단" value={formatPrice(additionalProjection?.projectedAverageEntryPrice, market)} />
            </div>
            <p className="mt-1.5 text-[8px] font-bold text-muted-foreground">
              {market === 'BITGET' ? '선물은 provider 포지션 수량과 동일한 단위의 추가 수량만 입력합니다.' : '추가 금액 ÷ 추가 진입가로 수량을 계산한 단순 가중평단입니다.'} 수수료·세금·슬리피지는 포함하지 않습니다.
            </p>
          </div>

          <div data-testid="ai-chart-partial-exit" className="rounded-xl border border-card-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-black">목표가별 분할청산 계산</p>
              <span className={`text-[9px] font-black ${allocationValid ? 'text-muted-foreground' : 'text-destructive'}`}>합계 {allocationTotal.toFixed(0)}%</span>
            </div>
            {allocationRows.length === 0 ? (
              <p className="mt-2 text-[9px] font-bold text-muted-foreground">Scanner 목표가가 없어 분할청산 수치를 만들지 않습니다.</p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {allocationRows.map((row) => (
                  <div key={`allocation-${row.index}`} className="grid grid-cols-[minmax(0,1fr)_86px] gap-2 rounded-xl bg-secondary/45 p-2 sm:grid-cols-[minmax(0,1fr)_100px]">
                    <div className="min-w-0">
                      <p className="text-[10px] font-black">TP{row.index + 1} · {formatPrice(row.target, market)}</p>
                      <p className="mt-0.5 text-[9px] font-bold text-muted-foreground">
                        수량 {allocationValid ? formatQuantity(row.projection?.quantity) : '미제공'}
                        {' · '}{market === 'BITGET' ? '부분 예상손익' : '예상 매도금액'} {allocationValid ? (market === 'BITGET' ? formatPnl(row.projection?.pnlAmount, market) : formatPrice(row.projection?.grossValue, market)) : '미제공'}
                      </p>
                    </div>
                    <label className="text-[8px] font-bold text-muted-foreground">
                      비중 %
                      <input
                        data-testid={`ai-chart-target-percent-${row.index}`}
                        inputMode="decimal"
                        value={row.raw}
                        onChange={(event) => setTargetPercents((current) => ({ ...current, [row.index]: event.target.value }))}
                        placeholder="0"
                        className="mt-1 min-h-10 w-full rounded-lg border border-card-border bg-background px-2 text-right text-[10px] font-black text-foreground"
                      />
                    </label>
                  </div>
                ))}
              </div>
            )}
            {!allocationValid && <p role="alert" className="mt-1.5 text-[9px] font-black text-destructive">분할청산 비중 합계는 100%를 넘길 수 없습니다.</p>}
          </div>

          <details data-testid="ai-chart-fee-break-even" className="rounded-xl border border-card-border p-3">
            <summary className="cursor-pointer text-[10px] font-black">수수료 포함 손익분기점 · 근거 입력 시만</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <label className="text-[9px] font-bold text-muted-foreground">
                진입 수수료/비용률 %
                <input
                  inputMode="decimal"
                  value={entryFeeText}
                  onChange={(event) => setEntryFeeText(event.target.value)}
                  placeholder="예: 0.05"
                  className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-3 text-[11px] font-black text-foreground"
                />
              </label>
              <label className="text-[9px] font-bold text-muted-foreground">
                청산 수수료/비용률 %
                <input
                  inputMode="decimal"
                  value={exitFeeText}
                  onChange={(event) => setExitFeeText(event.target.value)}
                  placeholder="예: 0.05"
                  className="mt-1 min-h-11 w-full rounded-xl border border-card-border bg-background px-3 text-[11px] font-black text-foreground"
                />
              </label>
              <Metric label="수수료 포함 본전가" value={formatPrice(breakEven, market)} />
            </div>
            {!feeInputsPresent && <p className="mt-1.5 text-[8px] font-bold text-muted-foreground">Provider 수수료 근거가 계좌 스냅샷에 없으므로 자동으로 추정하지 않습니다. 알고 있는 실제 비용률을 직접 입력한 경우에만 계산합니다.</p>}
            {feeInputsPresent && !feeEvidence && <p role="alert" className="mt-1.5 text-[8px] font-black text-destructive">비용률은 각각 0 이상 100 미만 숫자로 입력해야 합니다.</p>}
            {feeEvidence && <p className="mt-1.5 text-[8px] font-bold text-muted-foreground">사용자 입력 비용률 기준 단순 손익분기점입니다. funding·슬리피지·기타 세금/비용은 입력률에 포함되지 않았다면 별도입니다.</p>}
          </details>

          <p className="text-[9px] font-bold text-muted-foreground">
            {providerLabel(state.snapshot.provider)} 조회 {checkedAtLabel(state.snapshot.checkedAt)}
            {state.snapshot.stale ? ' · 오래된 마지막 정상값' : ' · 최신 조회'}
            {' · '}누락된 가격·수량·수수료 근거는 0으로 바꾸지 않고 미제공으로 유지합니다.
          </p>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-secondary/60 px-2.5 py-2">
      <p className="truncate text-[9px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-[11px] font-black tabular-nums">{value}</p>
    </div>
  );
}

function ScenarioRow({ label, price, percent, pnl, source }: {
  label: string;
  price: string;
  percent: string;
  pnl: string;
  source: string;
}) {
  return (
    <div className="rounded-xl bg-secondary/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-black">{label} · {price}</p>
        <span className="text-[10px] font-black tabular-nums">{percent}</span>
      </div>
      <p className="mt-1 text-[11px] font-black tabular-nums">예상손익 {pnl}</p>
      <p className="mt-0.5 text-[8px] font-bold text-muted-foreground">{source}</p>
    </div>
  );
}
