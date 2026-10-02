import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, Eye, EyeOff, RefreshCw, ShieldAlert, WalletCards } from 'lucide-react';
import { ScannerApprovalComposer } from '@/components/scanner-approval-composer';
import { TradeApprovalQueue } from '@/components/trade-approval-queue';
import { authorizedFetch } from '@/lib/auth-fetch';
import { safeTradeErrorMessage } from '@/lib/trade-approval-ui';
import type { AnalysisMarket, AnalysisPricePlan, AnalysisSelection } from '@/lib/analysis-selection';
import {
  buildPositionGuidance,
  feeInclusiveBreakEvenPrice,
  positionDirection,
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
  provider: 'toss' | 'kiwoom' | 'upbit' | 'bitget';
  position: AiChartAccountPosition;
  stale: boolean;
  checkedAt: string | null;
};

type AiChartAccount = {
  market: 'KR' | 'US' | 'UPBIT' | 'BITGET';
  accountRef: string | null;
  currency: string | null;
  buyingPower: number | null;
};

type AiChartBalance = {
  currency: string;
  available: number | null;
  locked: number | null;
  total: number | null;
  estimatedKrwValue: number | null;
};

type AiChartReadonlyOrder = {
  id: string | null;
  market: string | null;
  symbol: string | null;
  side: string | null;
  price: number | null;
  quantity: number | null;
  remainingQuantity: number | null;
  status: string | null;
};

type Snapshot = {
  provider: 'toss' | 'kiwoom' | 'upbit' | 'bitget';
  readOnly: true;
  connected: boolean;
  status: string;
  accounts: AiChartAccount[] | null;
  balances: AiChartBalance[] | null;
  positions: AiChartAccountPosition[];
  openOrders: AiChartReadonlyOrder[] | null;
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
  selection: AnalysisSelection;
  market: AnalysisMarket;
  symbol: string;
  chartPrice: number | null;
  pricePlan?: AnalysisPricePlan;
  onOverlayChange: (overlay: AiChartPositionOverlay | null) => void;
};

type OrderDashboardItem = {
  id: string;
  planId: string;
  exchange: 'toss' | 'kiwoom' | 'upbit' | 'bitget';
  symbol: string | null;
  market: string | null;
  side: 'buy' | 'sell' | 'long' | 'short' | null;
  accountMode: 'paper' | 'mock' | 'live' | null;
  orderType: 'market' | 'limit' | null;
  reduceOnly: boolean;
  state: string;
  clientOrderId: string;
  exchangeOrderId: string | null;
  requestedQuantity: number | null;
  remainingQuantity: number | null;
  filledQuantity: number;
  currentLimitPrice: number | null;
  averageFillPrice: number | null;
  cancelable: boolean | null;
  lastErrorCode: string | null;
  updatedAt: string;
};

type OrderDashboardResponse = {
  ok?: boolean;
  dashboardItems?: OrderDashboardItem[];
  error?: string;
  orderSubmitted?: boolean;
  orderCanceled?: boolean;
  orderAmended?: boolean;
  privateTradingRequestSent?: boolean;
};

type OrderDashboardState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; items: OrderDashboardItem[] }
  | { kind: 'unavailable'; code: string };

type ExitPreview = {
  schemaVersion: 'manual-exit-draft-v1';
  state: 'SERVER_VERIFIED_DRAFT';
  draftId: string;
  issuedAt: string;
  expiresAt: string;
  provider: 'toss' | 'kiwoom' | 'upbit' | 'bitget';
  market: string;
  symbol: string;
  percent: number;
  positionSide: string | null;
  positionQuantity: number | null;
  availableQuantity: number;
  exitQuantity: number;
  quantityRule: 'INTEGER_ONLY' | 'FRACTIONAL_ALLOWED';
  side: 'buy' | 'sell';
  reduceOnly: true;
  checkedAt: string;
  stale: false;
  requiresFinalRiskRecheck: true;
  requiresExplicitApproval: true;
  executionAuthority: 'NONE';
  executionReadiness?: {
    connectionConfigured: boolean;
    providerVerified: boolean;
    manualServerGateEnabled: boolean;
    readyForManualExitEvaluation: boolean;
    blockers: string[];
    orderSubmissionPerformedByPreview: boolean;
    executionAuthorityGrantedByPreview: boolean;
  };
};

type ExitPreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; preview: ExitPreview }
  | { kind: 'unavailable'; code: string };

type CanonicalExitPlan = {
  schemaVersion: 'ai-chart-canonical-exit-plan-v2';
  state: 'SERVER_VERIFIED_PLAN';
  planId: string;
  exitDraftId: string;
  provider: ExitPreview['provider'];
  market: string;
  symbol: string;
  accountMode: 'live';
  orderType: 'market';
  side: 'buy' | 'sell';
  quantity: number;
  percent: number;
  positionQuantity: number | null;
  availableQuantity: number;
  quantityRule: 'INTEGER_ONLY' | 'FRACTIONAL_ALLOWED';
  reduceOnly: true;
  sourceCheckedAt: string;
  issuedAt: string;
  expiresAt: string;
  approvalEligible: boolean;
  blockers: string[];
  requiresFreshAccountRecheckAtApproval: true;
  requiresOrderTimeRiskRecheck: true;
  requiresExplicitApproval: true;
  nextOwner: 'CANONICAL_EXIT_APPROVAL_OWNER';
  executionAuthority: 'NONE';
  orderSubmissionPerformed: false;
  financialMutationPerformed: false;
};

type ExitPlanState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; plan: CanonicalExitPlan }
  | { kind: 'unavailable'; code: string };

type CanonicalExitApproval = {
  schemaVersion: 'ai-chart-exit-approval-intent-v1';
  state: 'EXPLICITLY_CONFIRMED_NON_EXECUTING_INTENT';
  approvalIntentId: string;
  planId: string;
  exitDraftId: string;
  provider: ExitPreview['provider'];
  market: string;
  symbol: string;
  accountMode: 'live';
  orderType: 'market';
  side: 'buy' | 'sell';
  quantity: number;
  percent: number;
  positionQuantity: number | null;
  availableQuantity: number;
  quantityRule: 'INTEGER_ONLY' | 'FRACTIONAL_ALLOWED';
  reduceOnly: true;
  sourcePlanCheckedAt: string;
  approvalCheckedAt: string;
  approvedAt: string;
  expiresAt: string;
  explicitApprovalConfirmed: true;
  orderTimeRiskRecheckRequired: true;
  nextOwner: 'CANONICAL_EXIT_ORDER_TIME_RISK_OWNER';
  executionAuthority: 'NONE';
  executable: false;
  orderSubmissionPerformed: false;
  financialMutationPerformed: false;
};

type ExitApprovalState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; approval: CanonicalExitApproval }
  | { kind: 'unavailable'; code: string };

type CanonicalExitRisk = {
  schemaVersion: 'ai-chart-exit-order-time-risk-v1';
  state: 'PASSED_NON_EXECUTING' | 'BLOCKED_NON_EXECUTING';
  riskIntentId: string;
  approvalIntentId: string;
  planId: string;
  exitDraftId: string;
  provider: ExitPreview['provider'];
  market: string;
  symbol: string;
  accountMode: 'live';
  orderType: 'market';
  side: 'buy' | 'sell';
  quantity: number;
  percent: number;
  positionQuantity: number | null;
  availableQuantity: number;
  reduceOnly: true;
  approvalCheckedAt: string;
  riskCheckedAt: string;
  evaluatedAt: string;
  expiresAt: string;
  providerOpenOrdersChecked: boolean;
  conflictingOpenOrderCount: number | null;
  blockers: string[];
  riskPassed: boolean;
  marketExecutionPreflightRequired: true;
  nextOwner: 'CANONICAL_EXIT_EXECUTION_PREFLIGHT_OWNER';
  executionAuthority: 'NONE';
  executable: false;
  orderSubmissionPerformed: false;
  financialMutationPerformed: false;
};

type ExitRiskState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; risk: CanonicalExitRisk }
  | { kind: 'unavailable'; code: string };

type CanonicalExitPreflight = {
  schemaVersion: 'ai-chart-exit-execution-preflight-v1';
  state: 'PASSED_NON_EXECUTING' | 'BLOCKED_NON_EXECUTING';
  preflightIntentId: string;
  riskIntentId: string;
  approvalIntentId: string;
  planId: string;
  exitDraftId: string;
  provider: ExitPreview['provider'];
  market: string;
  symbol: string;
  accountMode: 'live';
  orderType: 'market';
  side: 'buy' | 'sell';
  quantity: number;
  percent: number;
  positionQuantity: number | null;
  availableQuantity: number;
  reduceOnly: true;
  referencePrice: number | null;
  riskCheckedAt: string;
  preflightCheckedAt: string;
  evaluatedAt: string;
  expiresAt: string;
  providerOpenOrdersChecked: boolean;
  conflictingOpenOrderCount: number | null;
  blockers: string[];
  preflightPassed: boolean;
  finalProviderOrderbookRiskRequired: true;
  nextOwner: 'CANONICAL_EXIT_EXECUTION_OWNER';
  executionAuthority: 'NONE';
  executable: false;
  orderSubmissionPerformed: false;
  financialMutationPerformed: false;
};

type ExitPreflightState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; preflight: CanonicalExitPreflight }
  | { kind: 'unavailable'; code: string };

type CanonicalExitExecutionPackage = {
  schemaVersion: 'ai-chart-exit-execution-package-v1';
  state: 'BOUND_NON_EXECUTING_PACKAGE' | 'BLOCKED_NON_EXECUTING';
  executionPackageId: string;
  preflightIntentId: string;
  riskIntentId: string;
  approvalIntentId: string;
  planId: string;
  exitDraftId: string;
  provider: ExitPreview['provider'];
  market: string;
  symbol: string;
  accountMode: 'live';
  orderType: 'market';
  side: 'buy' | 'sell';
  quantity: number;
  percent: number;
  positionQuantity: number | null;
  availableQuantity: number;
  reduceOnly: true;
  preflightReferencePrice: number;
  packageReferencePrice: number | null;
  referencePriceDriftPercent: number | null;
  preflightCheckedAt: string;
  packageCheckedAt: string;
  issuedAt: string;
  expiresAt: string;
  providerOpenOrdersChecked: boolean;
  conflictingOpenOrderCount: number | null;
  blockers: string[];
  packageReady: boolean;
  finalProviderOrderbookRiskRequired: true;
  providerSubmissionRequired: true;
  nextOwner: 'CANONICAL_EXIT_PROVIDER_SUBMISSION_OWNER';
  executionAuthority: 'NONE';
  executable: false;
  providerRequestPrepared: false;
  orderSubmissionPerformed: false;
  financialMutationPerformed: false;
};

type ExitExecutionPackageState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; executionPackage: CanonicalExitExecutionPackage }
  | { kind: 'unavailable'; code: string };

type CanonicalExitSubmissionGate = {
  schemaVersion: 'ai-chart-exit-provider-submission-gate-v1';
  state: 'LOCKED_DRAFT_ONLY';
  gateId: string;
  executionPackageId: string;
  provider: ExitPreview['provider'];
  market: string;
  symbol: string;
  accountMode: 'live';
  orderType: 'market';
  side: 'buy' | 'sell';
  quantity: number;
  percent: number;
  reduceOnly: true;
  evaluatedAt: string;
  expiresAt: string;
  blockers: string[];
  packageValidated: true;
  connectionReadinessChecked: true;
  finalProviderOrderbookRiskRequired: true;
  separateLiveExecutionAuthorizationRequired: true;
  providerMutationAllowed: false;
  providerRequestPrepared: false;
  orderSubmissionPerformed: false;
  financialMutationPerformed: false;
  executionAuthority: 'NONE';
  nextOwner: 'CANONICAL_EXIT_PROVIDER_SUBMISSION_OWNER';
};

type ExitSubmissionGateState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; gate: CanonicalExitSubmissionGate }
  | { kind: 'unavailable'; code: string };

type ExecutionReadiness = {
  connectionConfigured: boolean;
  providerVerified: boolean;
  manualServerGateEnabled: boolean;
  automaticServerGateEnabled: boolean;
  readyForManualOrderEvaluation: boolean;
  readyForAutomaticOrderEvaluation: boolean;
  blockers: string[];
  orderTimeRiskRecheckRequired: boolean;
  orderSubmissionPerformedByStatusRequest: false;
};

type EntryReadinessState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; provider: Snapshot['provider']; value: ExecutionReadiness }
  | { kind: 'unavailable'; code: string };

type LiveEntryDraft = {
  schemaVersion: 'scanner-live-entry-draft-v1';
  state: 'SERVER_VERIFIED_DRAFT';
  draftId: string;
  market: string;
  symbol: string;
  timeframe: string;
  side: string;
  signalId: string;
  observedAt: string;
  expiresAt: string;
  entryZone: { from: number; to: number };
  invalidation: number | null;
  stopLoss: number;
  targets: number[];
  riskReward: number | null;
  evidenceStrength: number;
  strategy: {
    candidateId: string;
    strategyId: string;
    parameterHash: string;
    researchCodeSha: string;
    costPolicyVersion: string;
  };
  requiresFinalRiskRecheck: true;
  requiresExplicitApproval: true;
  executionAuthority: 'NONE';
};

type LiveEntryDraftState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; draft: LiveEntryDraft }
  | { kind: 'unavailable'; code: string };

type StockReadOnlyProvider = 'toss' | 'kiwoom';
type CockpitTab = 'entry' | 'orders' | 'exit';

function providerForMarket(market: AnalysisMarket, stockProvider: StockReadOnlyProvider): Snapshot['provider'] {
  if (market === 'UPBIT') return 'upbit';
  if (market === 'BITGET') return 'bitget';
  return stockProvider;
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

function providerOrderMatches(market: AnalysisMarket, chartSymbol: string, order: AiChartReadonlyOrder): boolean {
  if (!order.market || !order.symbol) return false;
  if (order.market.trim().toUpperCase() !== market) return false;
  return symbolMatches(market, chartSymbol, order.symbol);
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
  const direction = positionDirection(position);
  if (average == null || current == null || average <= 0 || direction == null) return null;
  const raw = ((current - average) / average) * 100;
  return direction * raw;
}

function exitReadinessBlockerLabel(code: string): string {
  const labels: Record<string, string> = {
    CREDENTIAL_VAULT_NOT_READY: '거래키 암호화 저장소가 준비되지 않음',
    LIVE_CONNECTION_NOT_CONFIGURED: '실전 거래키가 연결되지 않음',
    LIVE_CONNECTION_NOT_VERIFIED: '실계좌 Provider 검증이 필요함',
    MANUAL_LIVE_SERVER_GATE_OFF: '실주문 서버게이트가 꺼져 있음',
    EXIT_RISK_EMERGENCY_STOP_ACTIVE: '긴급정지 활성화',
    EXIT_RISK_ACCOUNT_EVIDENCE_STALE: '실계좌 근거가 오래됨',
    EXIT_RISK_PROVIDER_OPEN_ORDERS_UNAVAILABLE: 'Provider 미체결 주문 조회 불가',
    EXIT_RISK_PROVIDER_OPEN_ORDER_PRESENT: '같은 종목 미체결 주문 존재',
    EXIT_PREFLIGHT_ACCOUNT_SNAPSHOT_NOT_FRESH: '실행 직전 실계좌 상태 확인 실패',
    EXIT_PREFLIGHT_POSITION_AMBIGUOUS: '동일 종목 포지션이 여러 개라 식별 불가',
    EXIT_PREFLIGHT_POSITION_NOT_FOUND: '실행 직전 보유 포지션 없음',
    EXIT_PREFLIGHT_POSITION_CHANGED: '보유수량 또는 방향 변경',
    EXIT_PREFLIGHT_CURRENT_PRICE_UNAVAILABLE: '현재가격 확인 불가',
    EXIT_PREFLIGHT_EMERGENCY_STOP_ACTIVE: '긴급정지 활성화',
    EXIT_PREFLIGHT_ACCOUNT_EVIDENCE_STALE: '실행 직전 실계좌 근거가 오래됨',
    EXIT_PREFLIGHT_PROVIDER_OPEN_ORDERS_UNAVAILABLE: 'Provider 미체결 주문 조회 불가',
    EXIT_PREFLIGHT_PROVIDER_OPEN_ORDER_PRESENT: '같은 종목 미체결 주문 존재',
    EXIT_EXECUTION_PACKAGE_ACCOUNT_SNAPSHOT_NOT_FRESH: '최종 실행 패키지 계좌 상태 확인 실패',
    EXIT_EXECUTION_PACKAGE_POSITION_AMBIGUOUS: '동일 종목 포지션이 여러 개라 최종 식별 불가',
    EXIT_EXECUTION_PACKAGE_POSITION_NOT_FOUND: '최종 실행 패키지 시점 보유 포지션 없음',
    EXIT_EXECUTION_PACKAGE_POSITION_CHANGED: '최종 패키지 시점 보유수량 또는 방향 변경',
    EXIT_EXECUTION_PACKAGE_CURRENT_PRICE_UNAVAILABLE: '최종 패키지 현재가격 확인 불가',
    EXIT_EXECUTION_PACKAGE_EMERGENCY_STOP_ACTIVE: '최종 패키지 시점 긴급정지 활성화',
    EXIT_EXECUTION_PACKAGE_ACCOUNT_EVIDENCE_STALE: '최종 패키지 실계좌 근거가 오래됨',
    EXIT_EXECUTION_PACKAGE_PROVIDER_OPEN_ORDERS_UNAVAILABLE: '최종 패키지 Provider 미체결 조회 불가',
    EXIT_EXECUTION_PACKAGE_PROVIDER_OPEN_ORDER_PRESENT: '최종 패키지에 같은 종목 미체결 주문 존재',
  };
  return labels[code] ?? code;
}

type CockpitStageTone = 'done' | 'active' | 'blocked' | 'idle';

function cockpitStageClass(tone: CockpitStageTone): string {
  if (tone === 'done') return 'border-positive/30 bg-positive/10 text-positive';
  if (tone === 'active') return 'border-primary/30 bg-primary/10 text-primary';
  if (tone === 'blocked') return 'border-warning/30 bg-warning/10 text-warning';
  return 'border-card-border bg-background text-muted-foreground';
}

function stageTone(
  state: { kind: string },
  passed?: boolean,
): CockpitStageTone {
  if (state.kind === 'loading') return 'active';
  if (state.kind === 'unavailable') return 'blocked';
  if (state.kind === 'ready') return passed === false ? 'blocked' : 'done';
  return 'idle';
}

function orderStateLabel(state: string): string {
  const labels: Record<string, string> = {
    SUBMITTED: '제출 대기',
    ACCEPTED: '거래소 접수',
    PARTIALLY_FILLED: '부분체결',
    FILLED: '체결완료',
    CANCEL_REQUESTED: '취소 요청',
    CANCELED: '취소완료',
    REJECTED: '거절',
    EXPIRED: '만료',
    RECOVERY_REQUIRED: '재조정 필요',
  };
  return labels[state] ?? state;
}

function canonicalProviderOrderStatus(
  item: OrderDashboardItem,
  providerOrders: AiChartReadonlyOrder[] | null,
): 'MATCHED' | 'PROVIDER_NOT_READ' | 'EXCHANGE_ID_MISSING' | 'NOT_IN_OPEN_ORDERS' {
  if (providerOrders == null) return 'PROVIDER_NOT_READ';
  const exchangeId = String(item.exchangeOrderId ?? '').trim();
  if (!exchangeId) return 'EXCHANGE_ID_MISSING';
  return providerOrders.some((order) => String(order.id ?? '').trim() === exchangeId)
    ? 'MATCHED'
    : 'NOT_IN_OPEN_ORDERS';
}

function providerOrderStatusLabel(status: ReturnType<typeof canonicalProviderOrderStatus>): string {
  if (status === 'MATCHED') return 'Provider 원장 일치';
  if (status === 'PROVIDER_NOT_READ') return 'Provider 원장 미조회';
  if (status === 'EXCHANGE_ID_MISSING') return '거래소 주문 ID 미확인';
  return '현재 미체결 원장에서 미확인';
}

function canCancelOrder(item: OrderDashboardItem): boolean {
  return ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'RECOVERY_REQUIRED'].includes(item.state)
    && item.cancelable !== false;
}

function isUsStockPriceOnlyAmend(item: OrderDashboardItem): boolean {
  return item.market?.trim().toUpperCase() === 'US'
    && (item.exchange === 'toss' || item.exchange === 'kiwoom');
}

function canAmendOrder(item: OrderDashboardItem): boolean {
  return item.orderType === 'limit'
    && item.state === 'ACCEPTED'
    && item.filledQuantity === 0
    && item.cancelable !== false
    && finite(item.currentLimitPrice) != null;
}

function exitPreviewQuantity(
  position: AiChartAccountPosition,
  percent: number,
  market: AnalysisMarket,
  provider: Snapshot['provider'],
): number | null {
  const available = finite(position.availableQuantity) ?? finite(position.quantity);
  if (available == null || available <= 0 || !Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
  const raw = available * percent / 100;
  const integerOnly = market === 'KR' || (market === 'US' && provider === 'kiwoom');
  const quantity = integerOnly
    ? Math.floor(raw)
    : Math.round(raw * 100_000_000) / 100_000_000;
  return quantity > 0 ? quantity : null;
}

function providerLabel(provider: Snapshot['provider']): string {
  if (provider === 'toss') return 'Toss';
  if (provider === 'kiwoom') return 'Kiwoom';
  if (provider === 'upbit') return 'Upbit';
  return 'Bitget';
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

export function AiChartPositionPanel({ selection, market, symbol, chartPrice, pricePlan, onOverlayChange }: Props) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [stockProvider, setStockProvider] = useState<StockReadOnlyProvider>('toss');
  const [linesVisible, setLinesVisible] = useState(true);
  const [additionalValueText, setAdditionalValueText] = useState('');
  const [additionalPriceText, setAdditionalPriceText] = useState('');
  const [entryFeeText, setEntryFeeText] = useState('');
  const [exitFeeText, setExitFeeText] = useState('');
  const [targetPercents, setTargetPercents] = useState<Record<number, string>>({});
  const [cockpitOpen, setCockpitOpen] = useState(false);
  const [cockpitTab, setCockpitTab] = useState<CockpitTab>('entry');
  const [orderDashboard, setOrderDashboard] = useState<OrderDashboardState>({ kind: 'idle' });
  const [orderMessage, setOrderMessage] = useState('');
  const [orderActionId, setOrderActionId] = useState<string | null>(null);
  const [amendDrafts, setAmendDrafts] = useState<Record<string, { price: string; quantity: string }>>({});
  const [exitPercent, setExitPercent] = useState(100);
  const [exitPreviewState, setExitPreviewState] = useState<ExitPreviewState>({ kind: 'idle' });
  const [exitPlanState, setExitPlanState] = useState<ExitPlanState>({ kind: 'idle' });
  const [exitApprovalState, setExitApprovalState] = useState<ExitApprovalState>({ kind: 'idle' });
  const [exitRiskState, setExitRiskState] = useState<ExitRiskState>({ kind: 'idle' });
  const [exitPreflightState, setExitPreflightState] = useState<ExitPreflightState>({ kind: 'idle' });
  const [exitExecutionPackageState, setExitExecutionPackageState] = useState<ExitExecutionPackageState>({ kind: 'idle' });
  const [exitSubmissionGateState, setExitSubmissionGateState] = useState<ExitSubmissionGateState>({ kind: 'idle' });
  const [entryReadiness, setEntryReadiness] = useState<EntryReadinessState>({ kind: 'idle' });
  const [liveEntryDraft, setLiveEntryDraft] = useState<LiveEntryDraftState>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const orderAbortRef = useRef<AbortController | null>(null);
  const orderSequenceRef = useRef(0);
  const exitAbortRef = useRef<AbortController | null>(null);
  const exitSequenceRef = useRef(0);
  const exitPlanAbortRef = useRef<AbortController | null>(null);
  const exitPlanSequenceRef = useRef(0);
  const exitApprovalAbortRef = useRef<AbortController | null>(null);
  const exitApprovalSequenceRef = useRef(0);
  const exitRiskAbortRef = useRef<AbortController | null>(null);
  const exitRiskSequenceRef = useRef(0);
  const exitPreflightAbortRef = useRef<AbortController | null>(null);
  const exitPreflightSequenceRef = useRef(0);
  const exitExecutionPackageAbortRef = useRef<AbortController | null>(null);
  const exitExecutionPackageSequenceRef = useRef(0);
  const exitSubmissionGateAbortRef = useRef<AbortController | null>(null);
  const exitSubmissionGateSequenceRef = useRef(0);
  const entryReadinessAbortRef = useRef<AbortController | null>(null);
  const entryReadinessSequenceRef = useRef(0);
  const liveDraftAbortRef = useRef<AbortController | null>(null);
  const liveDraftSequenceRef = useRef(0);

  useEffect(() => {
    requestSequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    orderSequenceRef.current += 1;
    orderAbortRef.current?.abort();
    orderAbortRef.current = null;
    exitSequenceRef.current += 1;
    exitAbortRef.current?.abort();
    exitAbortRef.current = null;
    exitPlanSequenceRef.current += 1;
    exitPlanAbortRef.current?.abort();
    exitPlanAbortRef.current = null;
    exitApprovalSequenceRef.current += 1;
    exitApprovalAbortRef.current?.abort();
    exitApprovalAbortRef.current = null;
    exitRiskSequenceRef.current += 1;
    exitRiskAbortRef.current?.abort();
    exitRiskAbortRef.current = null;
    exitPreflightSequenceRef.current += 1;
    exitPreflightAbortRef.current?.abort();
    exitPreflightAbortRef.current = null;
    exitExecutionPackageSequenceRef.current += 1;
    exitExecutionPackageAbortRef.current?.abort();
    exitExecutionPackageAbortRef.current = null;
    exitSubmissionGateSequenceRef.current += 1;
    exitSubmissionGateAbortRef.current?.abort();
    exitSubmissionGateAbortRef.current = null;
    entryReadinessSequenceRef.current += 1;
    entryReadinessAbortRef.current?.abort();
    entryReadinessAbortRef.current = null;
    liveDraftSequenceRef.current += 1;
    liveDraftAbortRef.current?.abort();
    liveDraftAbortRef.current = null;
    setState({ kind: 'idle' });
    setLinesVisible(true);
    setAdditionalValueText('');
    setAdditionalPriceText('');
    setEntryFeeText('');
    setExitFeeText('');
    setTargetPercents({});
    setCockpitOpen(false);
    setCockpitTab('entry');
    setOrderDashboard({ kind: 'idle' });
    setOrderMessage('');
    setOrderActionId(null);
    setAmendDrafts({});
    setExitPercent(100);
    setExitPreviewState({ kind: 'idle' });
    setExitPlanState({ kind: 'idle' });
    setExitApprovalState({ kind: 'idle' });
    setExitRiskState({ kind: 'idle' });
    setExitPreflightState({ kind: 'idle' });
    setExitExecutionPackageState({ kind: 'idle' });
    setExitSubmissionGateState({ kind: 'idle' });
    setEntryReadiness({ kind: 'idle' });
    setLiveEntryDraft({ kind: 'idle' });
    onOverlayChange(null);
  }, [market, onOverlayChange, symbol]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      orderAbortRef.current?.abort();
      exitAbortRef.current?.abort();
      exitPlanAbortRef.current?.abort();
      exitApprovalAbortRef.current?.abort();
      exitRiskAbortRef.current?.abort();
      exitPreflightAbortRef.current?.abort();
      exitExecutionPackageAbortRef.current?.abort();
      exitSubmissionGateAbortRef.current?.abort();
      entryReadinessAbortRef.current?.abort();
      liveDraftAbortRef.current?.abort();
    };
  }, []);

  const loadPosition = useCallback(async () => {
    const provider = providerForMarket(market, stockProvider);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const sequence = ++requestSequenceRef.current;
    setState({ kind: 'loading' });
    setOrderDashboard({ kind: 'idle' });
    setOrderMessage('');
    setOrderActionId(null);
    setAmendDrafts({});
    setExitPreviewState({ kind: 'idle' });
    setExitPlanState({ kind: 'idle' });
    setExitApprovalState({ kind: 'idle' });
    setExitRiskState({ kind: 'idle' });
    setExitPreflightState({ kind: 'idle' });
    setExitExecutionPackageState({ kind: 'idle' });
    setExitSubmissionGateState({ kind: 'idle' });
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
  }, [linesVisible, market, onOverlayChange, stockProvider, symbol]);

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

  const changeStockProvider = useCallback((next: StockReadOnlyProvider) => {
    if (next === stockProvider) return;
    requestSequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    orderSequenceRef.current += 1;
    orderAbortRef.current?.abort();
    orderAbortRef.current = null;
    exitSequenceRef.current += 1;
    exitAbortRef.current?.abort();
    exitAbortRef.current = null;
    exitPlanSequenceRef.current += 1;
    exitPlanAbortRef.current?.abort();
    exitPlanAbortRef.current = null;
    exitApprovalSequenceRef.current += 1;
    exitApprovalAbortRef.current?.abort();
    exitApprovalAbortRef.current = null;
    exitRiskSequenceRef.current += 1;
    exitRiskAbortRef.current?.abort();
    exitRiskAbortRef.current = null;
    exitPreflightSequenceRef.current += 1;
    exitPreflightAbortRef.current?.abort();
    exitPreflightAbortRef.current = null;
    exitExecutionPackageSequenceRef.current += 1;
    exitExecutionPackageAbortRef.current?.abort();
    exitExecutionPackageAbortRef.current = null;
    entryReadinessSequenceRef.current += 1;
    entryReadinessAbortRef.current?.abort();
    entryReadinessAbortRef.current = null;
    setStockProvider(next);
    setState({ kind: 'idle' });
    setLinesVisible(true);
    setOrderDashboard({ kind: 'idle' });
    setOrderMessage('');
    setOrderActionId(null);
    setAmendDrafts({});
    setExitPreviewState({ kind: 'idle' });
    setExitPlanState({ kind: 'idle' });
    setExitApprovalState({ kind: 'idle' });
    setExitRiskState({ kind: 'idle' });
    setExitPreflightState({ kind: 'idle' });
    setExitExecutionPackageState({ kind: 'idle' });
    setExitSubmissionGateState({ kind: 'idle' });
    setEntryReadiness({ kind: 'idle' });
    onOverlayChange(null);
  }, [onOverlayChange, stockProvider]);

  const provider = providerForMarket(market, stockProvider);
  const position = state.kind === 'ready' ? state.position : null;
  const matchingAccount = state.kind === 'ready'
    ? (state.snapshot.accounts ?? []).find((account) => account.market === market) ?? null
    : null;
  const cashCurrency = market === 'US' ? 'USD' : market === 'BITGET' ? 'USDT' : 'KRW';
  const cashBalance = state.kind === 'ready'
    ? (state.snapshot.balances ?? []).find((balance) => balance.currency.trim().toUpperCase() === cashCurrency) ?? null
    : null;
  const availableFunds = finite(matchingAccount?.buyingPower) ?? finite(cashBalance?.available);
  const providerOpenOrders = state.kind === 'ready' && Array.isArray(state.snapshot.openOrders)
    ? state.snapshot.openOrders.filter((order) => providerOrderMatches(market, symbol, order))
    : null;
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
  const exitQuantity = position ? exitPreviewQuantity(position, exitPercent, market, provider) : null;
  const entryContextReady = Boolean(
    selection.searchRunId
    && selection.signalId
    && selection.action
    && (selection.matchedSignals?.length ?? 0) > 0,
  );
  const canonicalOrderStatus = orderDashboard.kind === 'ready'
    ? `${orderDashboard.items.length}건`
    : orderDashboard.kind === 'loading' ? '조회 중' : orderDashboard.kind === 'unavailable' ? '조회 실패' : '미조회';
  const exitStatus = !position
    ? '해당 없음'
    : exitPreviewState.kind === 'ready' ? '재검증됨'
      : exitPreviewState.kind === 'loading' ? '재검증 중'
        : exitPreviewState.kind === 'unavailable' ? '재검증 실패'
          : '재검증 필요';

  const loadOrderDashboard = useCallback(async (preserveMessage = false) => {
    const controller = new AbortController();
    orderAbortRef.current?.abort();
    orderAbortRef.current = controller;
    const sequence = ++orderSequenceRef.current;
    setOrderDashboard({ kind: 'loading' });
    if (!preserveMessage) setOrderMessage('');
    try {
      const query = new URLSearchParams({
        dashboard: '1',
        market,
        symbol,
      });
      if (market !== 'KR' && market !== 'US') query.set('exchange', provider);
      const response = await authorizedFetch(`/api/trade-automation/orders?${query.toString()}`, {
        method: 'GET',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as OrderDashboardResponse | null;
      if (controller.signal.aborted || sequence !== orderSequenceRef.current) return;
      if (!response.ok || payload?.ok !== true || !Array.isArray(payload.dashboardItems)) {
        setOrderDashboard({ kind: 'unavailable', code: payload?.error ?? `HTTP_${response.status}` });
        return;
      }
      if (payload.orderSubmitted !== false
        || payload.orderCanceled !== false
        || payload.orderAmended !== false
        || payload.privateTradingRequestSent !== false) {
        setOrderDashboard({ kind: 'unavailable', code: 'ORDER_DASHBOARD_READ_SAFETY_MISMATCH' });
        return;
      }
      const items = payload.dashboardItems.filter((item) => (
        typeof item.symbol === 'string'
        && item.market?.trim().toUpperCase() === market
        && symbolMatches(market, symbol, item.symbol)
        && ((market === 'KR' || market === 'US') || item.exchange === provider)
      ));
      setOrderDashboard({ kind: 'ready', items });
      setAmendDrafts(Object.fromEntries(items.map((item) => [
        item.id,
        {
          price: finite(item.currentLimitPrice)?.toString() ?? '',
          quantity: finite(item.remainingQuantity ?? item.requestedQuantity)?.toString() ?? '',
        },
      ])));
    } catch (error) {
      if (controller.signal.aborted || sequence !== orderSequenceRef.current) return;
      setOrderDashboard({ kind: 'unavailable', code: error instanceof Error ? error.name : 'ORDER_DASHBOARD_LOAD_FAILED' });
    } finally {
      if (orderAbortRef.current === controller) orderAbortRef.current = null;
    }
  }, [market, provider, symbol]);

  const cancelOrder = useCallback(async (item: OrderDashboardItem) => {
    if (!canCancelOrder(item) || orderActionId) return;
    const confirmed = window.confirm(`${symbol} 주문을 취소하시겠습니까? 이미 체결된 수량은 취소되지 않습니다.`);
    if (!confirmed) return;
    setOrderActionId(item.id);
    setOrderMessage('취소 요청을 처리하고 있습니다.');
    try {
      const response = await authorizedFetch(`/api/trade-automation/orders/${encodeURIComponent(item.id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? 'ORDER_CANCEL_FAILED');
      setOrderMessage('취소 요청이 canonical 주문엔진에 반영되었습니다.');
      await loadOrderDashboard(true);
    } catch (error) {
      setOrderMessage(safeTradeErrorMessage(
        error instanceof Error ? error.message : null,
        '주문 취소에 실패했습니다. 최신 주문상태를 다시 확인해 주세요.',
      ));
    } finally {
      setOrderActionId(null);
    }
  }, [loadOrderDashboard, orderActionId, symbol]);

  const amendOrder = useCallback(async (item: OrderDashboardItem) => {
    if (!canAmendOrder(item) || orderActionId) return;
    const draft = amendDrafts[item.id];
    const price = positiveText(draft?.price ?? '');
    const priceOnly = isUsStockPriceOnlyAmend(item);
    const quantity = priceOnly ? null : positiveText(draft?.quantity ?? '');
    if (price == null || (!priceOnly && quantity == null)) {
      setOrderMessage(priceOnly ? '정정 가격을 양수로 입력해야 합니다.' : '정정 가격과 수량을 양수로 입력해야 합니다.');
      return;
    }
    const confirmed = window.confirm(priceOnly
      ? `${symbol} 미국주식 주문 가격을 ${price}로 정정하시겠습니까? 수량은 기존 잔량을 유지합니다.`
      : `${symbol} 주문을 가격 ${price}, 수량 ${quantity}로 정정하시겠습니까?`);
    if (!confirmed) return;
    setOrderActionId(item.id);
    setOrderMessage('정정 요청을 처리하고 있습니다.');
    try {
      const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `amend-${Date.now()}-${item.id}`;
      const response = await authorizedFetch(`/api/trade-automation/orders/${encodeURIComponent(item.id)}/amend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, requestId, price, quantity }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? 'ORDER_AMEND_FAILED');
      setOrderMessage('정정 요청이 canonical 주문엔진에 반영되었습니다.');
      await loadOrderDashboard(true);
    } catch (error) {
      setOrderMessage(safeTradeErrorMessage(
        error instanceof Error ? error.message : null,
        '주문 정정에 실패했습니다. 최신 주문상태를 다시 확인해 주세요.',
      ));
    } finally {
      setOrderActionId(null);
    }
  }, [amendDrafts, loadOrderDashboard, orderActionId, symbol]);

  const verifyExitPreview = useCallback(async () => {
    if (!position || exitPreviewState.kind === 'loading') return;
    const controller = new AbortController();
    exitAbortRef.current?.abort();
    exitAbortRef.current = controller;
    const sequence = ++exitSequenceRef.current;
    setExitPreviewState({ kind: 'loading' });
    try {
      const response = await authorizedFetch('/api/trade-automation/positions/exit-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          provider,
          market,
          symbol,
          percent: exitPercent,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        preview?: ExitPreview;
        orderSubmitted?: boolean;
        orderCanceled?: boolean;
        orderAmended?: boolean;
        privateTradingMutationSent?: boolean;
        executionAuthority?: string;
        executionReadiness?: ExitPreview['executionReadiness'];
      } | null;
      if (controller.signal.aborted || sequence !== exitSequenceRef.current) return;
      if (!response.ok || payload?.ok !== true || !payload.preview) {
        setExitPreviewState({ kind: 'unavailable', code: payload?.error ?? `HTTP_${response.status}` });
        return;
      }
      if (payload.orderSubmitted !== false
        || payload.orderCanceled !== false
        || payload.orderAmended !== false
        || payload.privateTradingMutationSent !== false
        || payload.executionAuthority !== 'NONE'
        || payload.preview.reduceOnly !== true
        || payload.preview.stale !== false
        || payload.preview.executionAuthority !== 'NONE'
        || payload.preview.state !== 'SERVER_VERIFIED_DRAFT'
        || payload.preview.requiresFinalRiskRecheck !== true
        || payload.preview.requiresExplicitApproval !== true
        || !/^[0-9a-f]{64}$/u.test(payload.preview.draftId)) {
        setExitPreviewState({ kind: 'unavailable', code: 'EXIT_PREVIEW_SAFETY_CONTRACT_MISMATCH' });
        return;
      }
      setExitPreviewState({
        kind: 'ready',
        preview: { ...payload.preview, executionReadiness: payload.executionReadiness },
      });
    } catch (error) {
      if (controller.signal.aborted || sequence !== exitSequenceRef.current) return;
      setExitPreviewState({ kind: 'unavailable', code: error instanceof Error ? error.name : 'EXIT_PREVIEW_FAILED' });
    } finally {
      if (exitAbortRef.current === controller) exitAbortRef.current = null;
    }
  }, [exitPercent, exitPreviewState.kind, market, position, provider, symbol]);

  const prepareCanonicalExitPlan = useCallback(async () => {
    if (exitPreviewState.kind !== 'ready' || exitPlanState.kind === 'loading') return;
    const preview = exitPreviewState.preview;
    const controller = new AbortController();
    exitPlanAbortRef.current?.abort();
    exitPlanAbortRef.current = controller;
    const sequence = ++exitPlanSequenceRef.current;
    setExitApprovalState({ kind: 'idle' });
    setExitRiskState({ kind: 'idle' });
    setExitPreflightState({ kind: 'idle' });
    setExitExecutionPackageState({ kind: 'idle' });
    setExitPlanState({ kind: 'loading' });
    try {
      const response = await authorizedFetch('/api/trade-automation/positions/exit-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          provider: preview.provider,
          market: preview.market,
          symbol: preview.symbol,
          percent: preview.percent,
          draftId: preview.draftId,
          draftIssuedAt: preview.issuedAt,
          draftExpiresAt: preview.expiresAt,
          positionQuantity: preview.positionQuantity,
          availableQuantity: preview.availableQuantity,
          exitQuantity: preview.exitQuantity,
          side: preview.side,
          sourceCheckedAt: preview.checkedAt,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        canonicalExitPlan?: CanonicalExitPlan;
        planPrepared?: boolean;
        financialMutationPerformed?: boolean;
        orderSubmitted?: boolean;
        orderCanceled?: boolean;
        orderAmended?: boolean;
        privateTradingMutationSent?: boolean;
        executionAuthority?: string;
      } | null;
      if (controller.signal.aborted || sequence !== exitPlanSequenceRef.current) return;
      const plan = payload?.canonicalExitPlan;
      if (!response.ok || payload?.ok !== true || !plan) {
        setExitPlanState({ kind: 'unavailable', code: payload?.error ?? `HTTP_${response.status}` });
        return;
      }
      if (payload.planPrepared !== true
        || payload.financialMutationPerformed !== false
        || payload.orderSubmitted !== false
        || payload.orderCanceled !== false
        || payload.orderAmended !== false
        || payload.privateTradingMutationSent !== false
        || payload.executionAuthority !== 'NONE'
        || plan.schemaVersion !== 'ai-chart-canonical-exit-plan-v2'
        || plan.state !== 'SERVER_VERIFIED_PLAN'
        || !/^[0-9a-f]{64}$/u.test(plan.planId)
        || plan.exitDraftId !== preview.draftId
        || plan.reduceOnly !== true
        || plan.requiresFreshAccountRecheckAtApproval !== true
        || plan.requiresOrderTimeRiskRecheck !== true
        || plan.requiresExplicitApproval !== true
        || plan.executionAuthority !== 'NONE'
        || plan.orderSubmissionPerformed !== false
        || plan.financialMutationPerformed !== false) {
        setExitPlanState({ kind: 'unavailable', code: 'EXIT_PLAN_SAFETY_CONTRACT_MISMATCH' });
        return;
      }
      setExitPlanState({ kind: 'ready', plan });
    } catch (error) {
      if (controller.signal.aborted || sequence !== exitPlanSequenceRef.current) return;
      setExitPlanState({ kind: 'unavailable', code: error instanceof Error ? error.name : 'EXIT_PLAN_PREPARE_FAILED' });
    } finally {
      if (exitPlanAbortRef.current === controller) exitPlanAbortRef.current = null;
    }
  }, [exitPlanState.kind, exitPreviewState]);

  const confirmCanonicalExitApproval = useCallback(async () => {
    if (exitPlanState.kind !== 'ready' || exitApprovalState.kind === 'loading') return;
    const plan = exitPlanState.plan;
    const controller = new AbortController();
    exitApprovalAbortRef.current?.abort();
    exitApprovalAbortRef.current = controller;
    const sequence = ++exitApprovalSequenceRef.current;
    setExitRiskState({ kind: 'idle' });
    setExitPreflightState({ kind: 'idle' });
    setExitExecutionPackageState({ kind: 'idle' });
    setExitApprovalState({ kind: 'loading' });
    try {
      const response = await authorizedFetch('/api/trade-automation/positions/exit-approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          planId: plan.planId,
          exitDraftId: plan.exitDraftId,
          provider: plan.provider,
          market: plan.market,
          symbol: plan.symbol,
          percent: plan.percent,
          positionQuantity: plan.positionQuantity,
          availableQuantity: plan.availableQuantity,
          quantity: plan.quantity,
          side: plan.side,
          sourceCheckedAt: plan.sourceCheckedAt,
          planIssuedAt: plan.issuedAt,
          planExpiresAt: plan.expiresAt,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        canonicalExitApproval?: CanonicalExitApproval;
        explicitApprovalConfirmed?: boolean;
        privateAccountReadPerformed?: boolean;
        financialMutationPerformed?: boolean;
        orderSubmitted?: boolean;
        orderCanceled?: boolean;
        orderAmended?: boolean;
        privateTradingMutationSent?: boolean;
        executionAuthority?: string;
      } | null;
      if (controller.signal.aborted || sequence !== exitApprovalSequenceRef.current) return;
      const approval = payload?.canonicalExitApproval;
      if (!response.ok || payload?.ok !== true || !approval) {
        setExitApprovalState({ kind: 'unavailable', code: payload?.error ?? `HTTP_${response.status}` });
        return;
      }
      if (payload.explicitApprovalConfirmed !== true
        || payload.privateAccountReadPerformed !== true
        || payload.financialMutationPerformed !== false
        || payload.orderSubmitted !== false
        || payload.orderCanceled !== false
        || payload.orderAmended !== false
        || payload.privateTradingMutationSent !== false
        || payload.executionAuthority !== 'NONE'
        || approval.schemaVersion !== 'ai-chart-exit-approval-intent-v1'
        || approval.state !== 'EXPLICITLY_CONFIRMED_NON_EXECUTING_INTENT'
        || !/^[0-9a-f]{64}$/u.test(approval.approvalIntentId)
        || approval.planId !== plan.planId
        || approval.exitDraftId !== plan.exitDraftId
        || approval.reduceOnly !== true
        || approval.explicitApprovalConfirmed !== true
        || approval.orderTimeRiskRecheckRequired !== true
        || approval.nextOwner !== 'CANONICAL_EXIT_ORDER_TIME_RISK_OWNER'
        || approval.executionAuthority !== 'NONE'
        || approval.executable !== false
        || approval.orderSubmissionPerformed !== false
        || approval.financialMutationPerformed !== false) {
        setExitApprovalState({ kind: 'unavailable', code: 'EXIT_APPROVAL_SAFETY_CONTRACT_MISMATCH' });
        return;
      }
      setExitApprovalState({ kind: 'ready', approval });
    } catch (error) {
      if (controller.signal.aborted || sequence !== exitApprovalSequenceRef.current) return;
      setExitApprovalState({ kind: 'unavailable', code: error instanceof Error ? error.name : 'EXIT_APPROVAL_FAILED' });
    } finally {
      if (exitApprovalAbortRef.current === controller) exitApprovalAbortRef.current = null;
    }
  }, [exitApprovalState.kind, exitPlanState]);

  const recheckCanonicalExitRisk = useCallback(async () => {
    if (exitApprovalState.kind !== 'ready' || exitRiskState.kind === 'loading') return;
    const approval = exitApprovalState.approval;
    const controller = new AbortController();
    exitRiskAbortRef.current?.abort();
    exitRiskAbortRef.current = controller;
    const sequence = ++exitRiskSequenceRef.current;
    setExitPreflightState({ kind: 'idle' });
    setExitExecutionPackageState({ kind: 'idle' });
    setExitRiskState({ kind: 'loading' });
    try {
      const response = await authorizedFetch('/api/trade-automation/positions/exit-risk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          approvalIntentId: approval.approvalIntentId,
          planId: approval.planId,
          exitDraftId: approval.exitDraftId,
          provider: approval.provider,
          market: approval.market,
          symbol: approval.symbol,
          percent: approval.percent,
          positionQuantity: approval.positionQuantity,
          availableQuantity: approval.availableQuantity,
          quantity: approval.quantity,
          side: approval.side,
          planSourceCheckedAt: approval.sourcePlanCheckedAt,
          approvalCheckedAt: approval.approvalCheckedAt,
          approvedAt: approval.approvedAt,
          approvalExpiresAt: approval.expiresAt,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        canonicalExitRisk?: CanonicalExitRisk;
        riskChecked?: boolean;
        privateAccountReadPerformed?: boolean;
        financialMutationPerformed?: boolean;
        orderSubmitted?: boolean;
        orderCanceled?: boolean;
        orderAmended?: boolean;
        privateTradingMutationSent?: boolean;
        executionAuthority?: string;
      } | null;
      if (controller.signal.aborted || sequence !== exitRiskSequenceRef.current) return;
      const risk = payload?.canonicalExitRisk;
      if (!response.ok || payload?.ok !== true || !risk) {
        setExitRiskState({ kind: 'unavailable', code: payload?.error ?? `HTTP_${response.status}` });
        return;
      }
      if (payload.riskChecked !== true
        || payload.privateAccountReadPerformed !== true
        || payload.financialMutationPerformed !== false
        || payload.orderSubmitted !== false
        || payload.orderCanceled !== false
        || payload.orderAmended !== false
        || payload.privateTradingMutationSent !== false
        || payload.executionAuthority !== 'NONE'
        || risk.schemaVersion !== 'ai-chart-exit-order-time-risk-v1'
        || !/^[0-9a-f]{64}$/u.test(risk.riskIntentId)
        || risk.approvalIntentId !== approval.approvalIntentId
        || risk.planId !== approval.planId
        || risk.exitDraftId !== approval.exitDraftId
        || risk.reduceOnly !== true
        || risk.marketExecutionPreflightRequired !== true
        || risk.nextOwner !== 'CANONICAL_EXIT_EXECUTION_PREFLIGHT_OWNER'
        || risk.executionAuthority !== 'NONE'
        || risk.executable !== false
        || risk.orderSubmissionPerformed !== false
        || risk.financialMutationPerformed !== false) {
        setExitRiskState({ kind: 'unavailable', code: 'EXIT_RISK_SAFETY_CONTRACT_MISMATCH' });
        return;
      }
      setExitRiskState({ kind: 'ready', risk });
    } catch (error) {
      if (controller.signal.aborted || sequence !== exitRiskSequenceRef.current) return;
      setExitRiskState({ kind: 'unavailable', code: error instanceof Error ? error.name : 'EXIT_RISK_RECHECK_FAILED' });
    } finally {
      if (exitRiskAbortRef.current === controller) exitRiskAbortRef.current = null;
    }
  }, [exitApprovalState, exitRiskState.kind]);

  const prepareCanonicalExitPreflight = useCallback(async () => {
    if (exitRiskState.kind !== 'ready'
      || exitRiskState.risk.riskPassed !== true
      || exitPreflightState.kind === 'loading') return;
    const risk = exitRiskState.risk;
    const controller = new AbortController();
    exitPreflightAbortRef.current?.abort();
    exitPreflightAbortRef.current = controller;
    const sequence = ++exitPreflightSequenceRef.current;
    setExitPreflightState({ kind: 'loading' });
    try {
      const response = await authorizedFetch('/api/trade-automation/positions/exit-preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          riskIntentId: risk.riskIntentId,
          approvalIntentId: risk.approvalIntentId,
          planId: risk.planId,
          exitDraftId: risk.exitDraftId,
          provider: risk.provider,
          market: risk.market,
          symbol: risk.symbol,
          percent: risk.percent,
          positionQuantity: risk.positionQuantity,
          availableQuantity: risk.availableQuantity,
          quantity: risk.quantity,
          side: risk.side,
          approvalCheckedAt: risk.approvalCheckedAt,
          riskCheckedAt: risk.riskCheckedAt,
          riskEvaluatedAt: risk.evaluatedAt,
          riskExpiresAt: risk.expiresAt,
          riskBlockers: risk.blockers,
          riskPassed: risk.riskPassed,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        canonicalExitPreflight?: CanonicalExitPreflight;
        preflightChecked?: boolean;
        privateAccountReadPerformed?: boolean;
        financialMutationPerformed?: boolean;
        orderSubmitted?: boolean;
        orderCanceled?: boolean;
        orderAmended?: boolean;
        privateTradingMutationSent?: boolean;
        executionAuthority?: string;
      } | null;
      if (controller.signal.aborted || sequence !== exitPreflightSequenceRef.current) return;
      const preflight = payload?.canonicalExitPreflight;
      if (!response.ok || payload?.ok !== true || !preflight) {
        setExitPreflightState({ kind: 'unavailable', code: payload?.error ?? `HTTP_${response.status}` });
        return;
      }
      if (payload.preflightChecked !== true
        || payload.privateAccountReadPerformed !== true
        || payload.financialMutationPerformed !== false
        || payload.orderSubmitted !== false
        || payload.orderCanceled !== false
        || payload.orderAmended !== false
        || payload.privateTradingMutationSent !== false
        || payload.executionAuthority !== 'NONE'
        || preflight.schemaVersion !== 'ai-chart-exit-execution-preflight-v1'
        || !/^[0-9a-f]{64}$/u.test(preflight.preflightIntentId)
        || preflight.riskIntentId !== risk.riskIntentId
        || preflight.approvalIntentId !== risk.approvalIntentId
        || preflight.planId !== risk.planId
        || preflight.exitDraftId !== risk.exitDraftId
        || preflight.reduceOnly !== true
        || preflight.finalProviderOrderbookRiskRequired !== true
        || preflight.nextOwner !== 'CANONICAL_EXIT_EXECUTION_OWNER'
        || preflight.executionAuthority !== 'NONE'
        || preflight.executable !== false
        || preflight.orderSubmissionPerformed !== false
        || preflight.financialMutationPerformed !== false) {
        setExitPreflightState({ kind: 'unavailable', code: 'EXIT_PREFLIGHT_SAFETY_CONTRACT_MISMATCH' });
        return;
      }
      setExitPreflightState({ kind: 'ready', preflight });
    } catch (error) {
      if (controller.signal.aborted || sequence !== exitPreflightSequenceRef.current) return;
      setExitPreflightState({ kind: 'unavailable', code: error instanceof Error ? error.name : 'EXIT_PREFLIGHT_FAILED' });
    } finally {
      if (exitPreflightAbortRef.current === controller) exitPreflightAbortRef.current = null;
    }
  }, [exitPreflightState.kind, exitRiskState]);

  const prepareCanonicalExitExecutionPackage = useCallback(async () => {
    if (exitPreflightState.kind !== 'ready'
      || exitPreflightState.preflight.preflightPassed !== true
      || exitExecutionPackageState.kind === 'loading') return;
    const preflight = exitPreflightState.preflight;
    const controller = new AbortController();
    exitExecutionPackageAbortRef.current?.abort();
    exitExecutionPackageAbortRef.current = controller;
    const sequence = ++exitExecutionPackageSequenceRef.current;
    setExitExecutionPackageState({ kind: 'loading' });
    exitSubmissionGateSequenceRef.current += 1;
    exitSubmissionGateAbortRef.current?.abort();
    exitSubmissionGateAbortRef.current = null;
    setExitSubmissionGateState({ kind: 'idle' });
    try {
      const response = await authorizedFetch('/api/trade-automation/positions/exit-execution-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          preflightIntentId: preflight.preflightIntentId,
          riskIntentId: preflight.riskIntentId,
          approvalIntentId: preflight.approvalIntentId,
          planId: preflight.planId,
          exitDraftId: preflight.exitDraftId,
          provider: preflight.provider,
          market: preflight.market,
          symbol: preflight.symbol,
          percent: preflight.percent,
          positionQuantity: preflight.positionQuantity,
          availableQuantity: preflight.availableQuantity,
          quantity: preflight.quantity,
          side: preflight.side,
          riskCheckedAt: preflight.riskCheckedAt,
          preflightCheckedAt: preflight.preflightCheckedAt,
          preflightReferencePrice: preflight.referencePrice,
          preflightEvaluatedAt: preflight.evaluatedAt,
          preflightExpiresAt: preflight.expiresAt,
          preflightBlockers: preflight.blockers,
          preflightPassed: preflight.preflightPassed,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        canonicalExitExecutionPackage?: CanonicalExitExecutionPackage;
        packagePrepared?: boolean;
        privateAccountReadPerformed?: boolean;
        financialMutationPerformed?: boolean;
        orderSubmitted?: boolean;
        orderCanceled?: boolean;
        orderAmended?: boolean;
        privateTradingMutationSent?: boolean;
        executionAuthority?: string;
      } | null;
      if (controller.signal.aborted || sequence !== exitExecutionPackageSequenceRef.current) return;
      const executionPackage = payload?.canonicalExitExecutionPackage;
      if (!response.ok || payload?.ok !== true || !executionPackage) {
        setExitExecutionPackageState({ kind: 'unavailable', code: payload?.error ?? `HTTP_${response.status}` });
        return;
      }
      if (payload.packagePrepared !== true
        || payload.privateAccountReadPerformed !== true
        || payload.financialMutationPerformed !== false
        || payload.orderSubmitted !== false
        || payload.orderCanceled !== false
        || payload.orderAmended !== false
        || payload.privateTradingMutationSent !== false
        || payload.executionAuthority !== 'NONE'
        || executionPackage.schemaVersion !== 'ai-chart-exit-execution-package-v1'
        || !/^[0-9a-f]{64}$/u.test(executionPackage.executionPackageId)
        || executionPackage.preflightIntentId !== preflight.preflightIntentId
        || executionPackage.riskIntentId !== preflight.riskIntentId
        || executionPackage.approvalIntentId !== preflight.approvalIntentId
        || executionPackage.planId !== preflight.planId
        || executionPackage.exitDraftId !== preflight.exitDraftId
        || executionPackage.reduceOnly !== true
        || executionPackage.finalProviderOrderbookRiskRequired !== true
        || executionPackage.providerSubmissionRequired !== true
        || executionPackage.nextOwner !== 'CANONICAL_EXIT_PROVIDER_SUBMISSION_OWNER'
        || executionPackage.executionAuthority !== 'NONE'
        || executionPackage.executable !== false
        || executionPackage.providerRequestPrepared !== false
        || executionPackage.orderSubmissionPerformed !== false
        || executionPackage.financialMutationPerformed !== false) {
        setExitExecutionPackageState({ kind: 'unavailable', code: 'EXIT_EXECUTION_PACKAGE_SAFETY_CONTRACT_MISMATCH' });
        return;
      }
      setExitExecutionPackageState({ kind: 'ready', executionPackage });
    } catch (error) {
      if (controller.signal.aborted || sequence !== exitExecutionPackageSequenceRef.current) return;
      setExitExecutionPackageState({ kind: 'unavailable', code: error instanceof Error ? error.name : 'EXIT_EXECUTION_PACKAGE_FAILED' });
    } finally {
      if (exitExecutionPackageAbortRef.current === controller) exitExecutionPackageAbortRef.current = null;
    }
  }, [exitExecutionPackageState.kind, exitPreflightState]);

  const evaluateCanonicalExitSubmissionGate = useCallback(async () => {
    if (exitExecutionPackageState.kind !== 'ready'
      || exitExecutionPackageState.executionPackage.packageReady !== true
      || exitSubmissionGateState.kind === 'loading') return;
    const executionPackage = exitExecutionPackageState.executionPackage;
    const controller = new AbortController();
    exitSubmissionGateAbortRef.current?.abort();
    exitSubmissionGateAbortRef.current = controller;
    const sequence = ++exitSubmissionGateSequenceRef.current;
    setExitSubmissionGateState({ kind: 'loading' });
    try {
      const response = await authorizedFetch('/api/trade-automation/positions/exit-submission-gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          executionPackageId: executionPackage.executionPackageId,
          preflightIntentId: executionPackage.preflightIntentId,
          riskIntentId: executionPackage.riskIntentId,
          approvalIntentId: executionPackage.approvalIntentId,
          planId: executionPackage.planId,
          exitDraftId: executionPackage.exitDraftId,
          provider: executionPackage.provider,
          market: executionPackage.market,
          symbol: executionPackage.symbol,
          percent: executionPackage.percent,
          positionQuantity: executionPackage.positionQuantity,
          availableQuantity: executionPackage.availableQuantity,
          quantity: executionPackage.quantity,
          side: executionPackage.side,
          preflightCheckedAt: executionPackage.preflightCheckedAt,
          packageCheckedAt: executionPackage.packageCheckedAt,
          preflightReferencePrice: executionPackage.preflightReferencePrice,
          packageReferencePrice: executionPackage.packageReferencePrice,
          issuedAt: executionPackage.issuedAt,
          expiresAt: executionPackage.expiresAt,
          blockers: executionPackage.blockers,
          packageReady: executionPackage.packageReady,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        canonicalExitSubmissionGate?: CanonicalExitSubmissionGate;
        gateEvaluated?: boolean;
        providerMutationAllowed?: boolean;
        providerRequestPrepared?: boolean;
        financialMutationPerformed?: boolean;
        orderSubmitted?: boolean;
        orderCanceled?: boolean;
        orderAmended?: boolean;
        privateTradingMutationSent?: boolean;
        executionAuthority?: string;
      } | null;
      if (controller.signal.aborted || sequence !== exitSubmissionGateSequenceRef.current) return;
      const gate = payload?.canonicalExitSubmissionGate;
      if (!response.ok || payload?.ok !== true || !gate) {
        setExitSubmissionGateState({ kind: 'unavailable', code: payload?.error ?? `HTTP_${response.status}` });
        return;
      }
      if (payload.gateEvaluated !== true
        || payload.providerMutationAllowed !== false
        || payload.providerRequestPrepared !== false
        || payload.financialMutationPerformed !== false
        || payload.orderSubmitted !== false
        || payload.orderCanceled !== false
        || payload.orderAmended !== false
        || payload.privateTradingMutationSent !== false
        || payload.executionAuthority !== 'NONE'
        || gate.schemaVersion !== 'ai-chart-exit-provider-submission-gate-v1'
        || gate.state !== 'LOCKED_DRAFT_ONLY'
        || !/^[0-9a-f]{64}$/u.test(gate.gateId)
        || gate.executionPackageId !== executionPackage.executionPackageId
        || gate.reduceOnly !== true
        || gate.packageValidated !== true
        || gate.connectionReadinessChecked !== true
        || gate.finalProviderOrderbookRiskRequired !== true
        || gate.separateLiveExecutionAuthorizationRequired !== true
        || gate.providerMutationAllowed !== false
        || gate.providerRequestPrepared !== false
        || gate.orderSubmissionPerformed !== false
        || gate.financialMutationPerformed !== false
        || gate.executionAuthority !== 'NONE'
        || gate.nextOwner !== 'CANONICAL_EXIT_PROVIDER_SUBMISSION_OWNER'
        || !gate.blockers.includes('DRAFT_PROVIDER_SUBMISSION_NOT_AUTHORIZED')) {
        setExitSubmissionGateState({ kind: 'unavailable', code: 'EXIT_SUBMISSION_GATE_SAFETY_CONTRACT_MISMATCH' });
        return;
      }
      setExitSubmissionGateState({ kind: 'ready', gate });
    } catch (error) {
      if (controller.signal.aborted || sequence !== exitSubmissionGateSequenceRef.current) return;
      setExitSubmissionGateState({ kind: 'unavailable', code: error instanceof Error ? error.name : 'EXIT_SUBMISSION_GATE_FAILED' });
    } finally {
      if (exitSubmissionGateAbortRef.current === controller) exitSubmissionGateAbortRef.current = null;
    }
  }, [exitExecutionPackageState, exitSubmissionGateState.kind]);

  const loadEntryReadiness = useCallback(async () => {
    const controller = new AbortController();
    entryReadinessAbortRef.current?.abort();
    entryReadinessAbortRef.current = controller;
    const sequence = ++entryReadinessSequenceRef.current;
    setEntryReadiness({ kind: 'loading' });
    try {
      const response = await authorizedFetch('/api/trade-automation/status', {
        method: 'GET',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        policy?: {
          stockBrokerByMarket?: {
            domestic_stock?: 'toss' | 'kiwoom';
            us_stock?: 'toss' | 'kiwoom';
          };
        };
        liveExecutionReadiness?: Partial<Record<Snapshot['provider'], ExecutionReadiness>>;
        actualOrderSubmittedByStatusRequest?: boolean;
      } | null;
      if (controller.signal.aborted || sequence !== entryReadinessSequenceRef.current) return;
      if (!response.ok || payload?.ok !== true || payload.actualOrderSubmittedByStatusRequest !== false) {
        setEntryReadiness({ kind: 'unavailable', code: payload?.error ?? 'ENTRY_READINESS_STATUS_INVALID' });
        return;
      }
      const executionProvider: Snapshot['provider'] = market === 'KR'
        ? payload.policy?.stockBrokerByMarket?.domestic_stock ?? provider
        : market === 'US'
          ? payload.policy?.stockBrokerByMarket?.us_stock ?? provider
          : provider;
      const value = payload.liveExecutionReadiness?.[executionProvider];
      if (!value || value.orderSubmissionPerformedByStatusRequest !== false || value.orderTimeRiskRecheckRequired !== true) {
        setEntryReadiness({ kind: 'unavailable', code: 'ENTRY_READINESS_CONTRACT_MISMATCH' });
        return;
      }
      setEntryReadiness({ kind: 'ready', provider: executionProvider, value });
    } catch (error) {
      if (controller.signal.aborted || sequence !== entryReadinessSequenceRef.current) return;
      setEntryReadiness({ kind: 'unavailable', code: error instanceof Error ? error.name : 'ENTRY_READINESS_FAILED' });
    } finally {
      if (entryReadinessAbortRef.current === controller) entryReadinessAbortRef.current = null;
    }
  }, [market, provider]);

  const prepareLiveEntryDraft = useCallback(async () => {
    if (!entryContextReady || liveEntryDraft.kind === 'loading') return;
    const controller = new AbortController();
    liveDraftAbortRef.current?.abort();
    liveDraftAbortRef.current = controller;
    const sequence = ++liveDraftSequenceRef.current;
    setLiveEntryDraft({ kind: 'loading' });
    try {
      const response = await authorizedFetch('/api/trade-automation/scanner/live-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'approval',
          accountMode: 'live',
          adapter: 'canonical-live',
          market: selection.market,
          symbol: selection.ticker,
          timeframe: selection.timeframe,
          side: selection.action,
          searchRunId: selection.searchRunId,
          signalId: selection.signalId,
          selectedConditions: [...new Set((selection.matchedSignals ?? []).map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 20),
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        draft?: LiveEntryDraft;
        executionAuthority?: string;
        liveOrderAllowed?: boolean;
        privateTradingApiAllowed?: boolean;
        orderSubmitted?: boolean;
        exchangeRequestSent?: boolean;
        providerMutationRequests?: number;
        livePlanCreated?: boolean;
      } | null;
      if (controller.signal.aborted || sequence !== liveDraftSequenceRef.current) return;
      if (!response.ok || payload?.ok !== true || !payload.draft) {
        setLiveEntryDraft({ kind: 'unavailable', code: payload?.error ?? `HTTP_${response.status}` });
        return;
      }
      if (payload.executionAuthority !== 'NONE'
        || payload.liveOrderAllowed !== false
        || payload.privateTradingApiAllowed !== false
        || payload.orderSubmitted !== false
        || payload.exchangeRequestSent !== false
        || payload.providerMutationRequests !== 0
        || payload.livePlanCreated !== false
        || !/^[0-9a-f]{64}$/u.test(payload.draft.draftId)
        || payload.draft.executionAuthority !== 'NONE'
        || payload.draft.requiresFinalRiskRecheck !== true
        || payload.draft.requiresExplicitApproval !== true) {
        setLiveEntryDraft({ kind: 'unavailable', code: 'LIVE_ENTRY_DRAFT_SAFETY_CONTRACT_MISMATCH' });
        return;
      }
      setLiveEntryDraft({ kind: 'ready', draft: payload.draft });
    } catch (error) {
      if (controller.signal.aborted || sequence !== liveDraftSequenceRef.current) return;
      setLiveEntryDraft({ kind: 'unavailable', code: error instanceof Error ? error.name : 'LIVE_ENTRY_DRAFT_FAILED' });
    } finally {
      if (liveDraftAbortRef.current === controller) liveDraftAbortRef.current = null;
    }
  }, [entryContextReady, liveEntryDraft.kind, selection]);

  const tradingCockpit = (
    <details
            open={cockpitOpen}
            onToggle={(event) => setCockpitOpen(event.currentTarget.open)}
            data-testid="ai-chart-trading-cockpit"
            className="rounded-xl border border-primary/25 bg-primary/5 p-3"
          >
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-black">진입 · 주문관리 · 종료 대시보드</p>
                  <p className="mt-0.5 truncate text-[8px] font-bold text-muted-foreground">
                    현재 종목 한 화면 트레이딩 콕핏 · {cockpitOpen ? '접기' : '펼치기'}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-card-border bg-background px-2 py-1 text-[8px] font-black text-muted-foreground">
                  {cockpitOpen ? '열림' : '요약'}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1" data-testid="ai-chart-cockpit-summary-strip">
                <span className={`min-w-0 truncate rounded-lg border px-1.5 py-1 text-center text-[8px] font-black ${entryContextReady ? 'border-positive/30 bg-positive/10 text-positive' : 'border-card-border bg-background text-muted-foreground'}`}>
                  진입 {entryContextReady ? '근거' : '대기'}
                </span>
                <span className={`min-w-0 truncate rounded-lg border px-1.5 py-1 text-center text-[8px] font-black ${position ? 'border-positive/30 bg-positive/10 text-positive' : 'border-card-border bg-background text-muted-foreground'}`}>
                  보유 {position ? '있음' : '없음'}
                </span>
                <span className={`min-w-0 truncate rounded-lg border px-1.5 py-1 text-center text-[8px] font-black ${orderDashboard.kind === 'ready' ? 'border-primary/30 bg-primary/10 text-primary' : orderDashboard.kind === 'unavailable' ? 'border-warning/30 bg-warning/10 text-warning' : 'border-card-border bg-background text-muted-foreground'}`}>
                  주문 {canonicalOrderStatus}
                </span>
                <span className={`min-w-0 truncate rounded-lg border px-1.5 py-1 text-center text-[8px] font-black ${exitPreviewState.kind === 'ready' ? 'border-positive/30 bg-positive/10 text-positive' : exitPreviewState.kind === 'unavailable' ? 'border-warning/30 bg-warning/10 text-warning' : 'border-card-border bg-background text-muted-foreground'}`}>
                  종료 {exitStatus}
                </span>
              </div>
            </summary>
            {cockpitOpen ? (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" data-testid="ai-chart-cockpit-lifecycle">
                  <Metric label="진입" value={entryContextReady ? 'Scanner 근거 있음' : '신호 필요'} />
                  <Metric label="보유" value={position ? '포지션 있음' : '없음'} />
                  <Metric label="앱 주문" value={canonicalOrderStatus} />
                  <Metric label="종료" value={exitStatus} />
                </div>
                <div role="tablist" aria-label="트레이딩 콕핏" data-testid="ai-chart-cockpit-tabs" className="grid grid-cols-3 gap-1 rounded-xl border border-card-border bg-background p-1">
                  {([
                    ['entry', '진입'],
                    ['orders', '주문'],
                    ['exit', '종료'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={cockpitTab === value}
                      onClick={() => setCockpitTab(value)}
                      className={`min-h-10 min-w-0 rounded-lg px-2 text-[10px] font-black ${cockpitTab === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {cockpitTab === 'entry' ? (
                  <>
                <section className="rounded-2xl border border-card-border bg-background p-3" data-testid="ai-chart-entry-planning">
                  <p className="text-[10px] font-black">새 진입 계획</p>
                  <p className="mt-0.5 text-[8px] font-bold leading-4 text-muted-foreground">
                    Scanner 근거가 있는 경우에만 기존 canonical Paper owner를 재사용합니다. 이 화면에서 새로 만드는 진입은 현재 Paper 전용입니다.
                    실전 신규진입은 브라우저에서 임의 생성하지 않으며, 서버가 이미 만든 live 승인계획이 있을 때만 아래 승인 큐에서 서버 live gate를 거쳐 처리합니다.
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-1.5 text-[8px] font-black">
                    <span className="rounded-lg bg-positive/10 px-2 py-1.5 text-positive">Paper 신규진입 · 연결됨</span>
                    <span className="rounded-lg bg-primary/10 px-2 py-1.5 text-primary">Live 진입초안 · 서버검증 연결</span>
                  </div>
                  {entryContextReady ? (
                    <div className="mt-2 [&_[data-testid=scanner-approval-composer]]:rounded-2xl [&_[data-testid=scanner-approval-composer]]:shadow-none">
                      <ScannerApprovalComposer selection={selection} />
                    </div>
                  ) : (
                    <p className="mt-2 rounded-xl bg-secondary/50 px-3 py-2 text-[9px] font-bold text-muted-foreground">
                      신호검색기에서 현재 종목을 선택하면 검증된 신호 identity를 사용해 Paper 진입계획을 만들 수 있습니다.
                    </p>
                  )}
                  <div className="mt-2 rounded-xl border border-card-border p-2.5" data-testid="ai-chart-entry-readiness">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[9px] font-black">실전 진입 준비상태</p>
                        <p className="mt-0.5 text-[8px] font-bold text-muted-foreground">조회만 수행 · 주문 제출 없음</p>
                      </div>
                      <button
                        type="button"
                        data-testid="ai-chart-load-entry-readiness"
                        disabled={entryReadiness.kind === 'loading'}
                        onClick={() => void loadEntryReadiness()}
                        className="min-h-10 rounded-lg border border-card-border px-2.5 text-[9px] font-black disabled:opacity-50"
                      >
                        {entryReadiness.kind === 'loading' ? '확인 중' : '준비상태 확인'}
                      </button>
                    </div>
                    {entryReadiness.kind === 'ready' ? (
                      <div className="mt-2 rounded-lg bg-secondary/50 p-2 text-[8px] font-bold text-muted-foreground">
                        <p className="font-black text-foreground">
                          수동 실전 진입 · {entryReadiness.value.readyForManualOrderEvaluation ? '게이트 준비' : '차단'}
                        </p>
                        <p className="mt-1">
                          실행 경로 {providerLabel(entryReadiness.provider)}
                          {' · '}거래키 {entryReadiness.value.connectionConfigured ? '연결' : '미연결'}
                          {' · '}provider {entryReadiness.value.providerVerified ? '검증됨' : '미검증'}
                          {' · '}서버게이트 {entryReadiness.value.manualServerGateEnabled ? 'ON' : 'OFF'}
                        </p>
                        {entryReadiness.value.blockers.length ? (
                          <p className="mt-1 break-words">차단 사유 · {entryReadiness.value.blockers.join(' · ')}</p>
                        ) : (
                          <p className="mt-1">실제 제출 시에도 주문 직전 Risk 재검증이 별도로 필요합니다.</p>
                        )}
                      </div>
                    ) : null}
                    {entryReadiness.kind === 'unavailable' ? (
                      <p role="alert" className="mt-2 rounded-lg bg-warning/10 p-2 text-[8px] font-bold text-warning">
                        진입 준비상태 확인 실패 · {entryReadiness.code}
                      </p>
                    ) : null}
                  </div>

                  <div className="mt-2 rounded-xl border border-card-border p-2.5" data-testid="ai-chart-live-entry-draft">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[9px] font-black">서버 검증 실전 진입초안</p>
                        <p className="mt-0.5 text-[8px] font-bold text-muted-foreground">Scanner 원본 identity·가격계획만 사용 · 주문 0건</p>
                      </div>
                      <button
                        type="button"
                        data-testid="ai-chart-prepare-live-entry-draft"
                        disabled={!entryContextReady || liveEntryDraft.kind === 'loading'}
                        onClick={() => void prepareLiveEntryDraft()}
                        className="min-h-10 rounded-lg border border-card-border px-2.5 text-[9px] font-black disabled:opacity-50"
                      >
                        {liveEntryDraft.kind === 'loading' ? '서버 검증 중...' : 'Live 초안 만들기'}
                      </button>
                    </div>
                    {liveEntryDraft.kind === 'ready' ? (
                      <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-2.5" data-testid="ai-chart-live-entry-draft-ready">
                        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                          <Metric label="방향" value={liveEntryDraft.draft.side} />
                          <Metric
                            label="진입구간"
                            value={`${formatPrice(liveEntryDraft.draft.entryZone.from, market)} ~ ${formatPrice(liveEntryDraft.draft.entryZone.to, market)}`}
                          />
                          <Metric label="Stop" value={formatPrice(liveEntryDraft.draft.stopLoss, market)} />
                          <Metric label="근거 강도" value={String(liveEntryDraft.draft.evidenceStrength)} />
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {liveEntryDraft.draft.targets.slice(0, 3).map((target, index) => (
                            <span key={`live-draft-target-${index}`} className="rounded-full bg-background px-2 py-1 text-[8px] font-black">
                              TP{index + 1} {formatPrice(target, market)}
                            </span>
                          ))}
                        </div>
                        <p className="mt-2 break-words text-[8px] font-bold text-muted-foreground">
                          전략 {liveEntryDraft.draft.strategy.strategyId}
                          {' · '}만료 {checkedAtLabel(liveEntryDraft.draft.expiresAt)}
                          {' · '}Draft {liveEntryDraft.draft.draftId.slice(0, 12)}…
                          {' · '}최종 Risk 재검증 필요
                          {' · '}명시적 승인 필요
                        </p>
                        <p className="mt-1 text-[8px] font-black text-warning">
                          이 단계는 실전 주문계획 초안만 검증합니다. 수량·레버리지·잔고·실제 주문은 생성하거나 전송하지 않습니다.
                        </p>
                      </div>
                    ) : null}
                    {liveEntryDraft.kind === 'unavailable' ? (
                      <p role="alert" className="mt-2 rounded-lg bg-warning/10 p-2 text-[8px] font-bold text-warning">
                        Live 진입초안 생성 실패 · {safeTradeErrorMessage(liveEntryDraft.code, liveEntryDraft.code)}
                      </p>
                    ) : null}
                  </div>
                </section>

                <TradeApprovalQueue
                  symbolFilter={symbol}
                  exchangeFilter={market === 'KR' || market === 'US' ? undefined : provider}
                  compact
                />
                  </>
                ) : null}

                {cockpitTab === 'orders' ? (
                  <>
                <section className="rounded-2xl border border-card-border bg-background p-3" data-testid="ai-chart-provider-open-orders">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-black">Provider 실제 미체결 · 조회 전용</p>
                      <p className="mt-0.5 text-[8px] font-bold text-muted-foreground">
                        {providerLabel(provider)} 계좌 스냅샷 · 앱 밖에서 낸 주문도 식별
                      </p>
                    </div>
                    <span className="rounded-full bg-secondary px-2 py-1 text-[8px] font-black">
                      {providerOpenOrders == null ? '조회 근거 없음' : `${providerOpenOrders.length}건`}
                    </span>
                  </div>
                  {providerOpenOrders == null ? (
                    <p className="mt-2 rounded-xl bg-warning/5 px-3 py-2 text-[9px] font-bold text-muted-foreground">
                      Provider 미체결 주문 응답이 없어 0건으로 단정하지 않습니다.
                      {state.kind === 'ready' && state.snapshot.errorCode ? ` · ${state.snapshot.errorCode}` : ''}
                    </p>
                  ) : providerOpenOrders.length === 0 ? (
                    <p className="mt-2 rounded-xl bg-secondary/50 px-3 py-2 text-[9px] font-bold text-muted-foreground">
                      현재 선택 종목의 Provider 미체결 주문이 없습니다.
                    </p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {providerOpenOrders.map((order, index) => (
                        <div key={order.id ?? `provider-order-${index}`} className="rounded-xl border border-card-border p-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-[10px] font-black">
                              {order.side ?? '방향 미확인'} · {order.status ?? '상태 미확인'}
                            </p>
                            <span className="text-[8px] font-bold text-muted-foreground">Provider 원장</span>
                          </div>
                          <p className="mt-1 text-[8px] font-bold text-muted-foreground">
                            가격 {formatPrice(order.price, market)}
                            {' · '}주문 {formatQuantity(order.quantity)}
                            {' · '}잔량 {formatQuantity(order.remainingQuantity)}
                          </p>
                          <p className="mt-1 text-[8px] font-bold text-muted-foreground">
                            앱 canonical ID와 확인되지 않은 Provider 주문에는 여기서 취소·정정 권한을 만들지 않습니다.
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-card-border bg-background p-3" data-testid="ai-chart-order-management">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-black">현재 종목 주문 상태</p>
                      <p className="mt-0.5 text-[8px] font-bold text-muted-foreground">자동 조회·자동 취소·자동 정정 없음</p>
                    </div>
                    <button
                      type="button"
                      data-testid="ai-chart-load-orders"
                      onClick={() => void loadOrderDashboard()}
                      disabled={orderDashboard.kind === 'loading' || orderActionId !== null}
                      className="min-h-10 rounded-xl border border-card-border px-3 text-[10px] font-black disabled:opacity-50"
                    >
                      {orderDashboard.kind === 'loading' ? '조회 중' : '주문상태 불러오기'}
                    </button>
                  </div>

                  {orderMessage ? <p role="status" className="mt-2 rounded-xl bg-secondary px-3 py-2 text-[9px] font-bold">{orderMessage}</p> : null}
                  {orderDashboard.kind === 'unavailable' ? (
                    <p role="alert" className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-[9px] font-bold text-warning">주문상태 조회 실패 · {orderDashboard.code}</p>
                  ) : null}
                  {orderDashboard.kind === 'ready' && orderDashboard.items.length === 0 ? (
                    <p className="mt-2 rounded-xl bg-secondary/50 px-3 py-3 text-[9px] font-bold text-muted-foreground">현재 종목의 canonical 주문 기록이 없습니다.</p>
                  ) : null}
                  {orderDashboard.kind === 'ready' && orderDashboard.items.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {orderDashboard.items.map((item) => {
                        const draft = amendDrafts[item.id] ?? { price: '', quantity: '' };
                        return (
                          <article key={item.id} className="rounded-xl border border-card-border p-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <p className="text-[10px] font-black">{item.side?.toUpperCase() ?? '-'} · {orderStateLabel(item.state)}</p>
                                <p className="mt-0.5 text-[8px] font-bold text-muted-foreground">
                                  {providerLabel(item.exchange)} · 요청 {formatQuantity(item.requestedQuantity)} · 체결 {formatQuantity(item.filledQuantity)} · 잔량 {formatQuantity(item.remainingQuantity)}
                                </p>
                              </div>
                              <div className="flex flex-wrap justify-end gap-1">
                                <span className="rounded-full bg-secondary px-2 py-1 text-[8px] font-black">{item.accountMode ?? '미확인'}</span>
                                <span
                                  data-testid={`ai-chart-order-provider-match-${item.id}`}
                                  className="rounded-full border border-card-border px-2 py-1 text-[8px] font-black text-muted-foreground"
                                >
                                  {providerOrderStatusLabel(canonicalProviderOrderStatus(item, providerOpenOrders))}
                                </span>
                              </div>
                            </div>
                            {canAmendOrder(item) ? (
                              <div className={`mt-2 grid gap-2 ${isUsStockPriceOnlyAmend(item) ? 'grid-cols-1' : 'grid-cols-2'}`}>
                                <input
                                  aria-label="정정 가격"
                                  inputMode="decimal"
                                  value={draft.price}
                                  onChange={(event) => setAmendDrafts((current) => ({
                                    ...current,
                                    [item.id]: { ...draft, price: event.target.value },
                                  }))}
                                  className="min-h-10 rounded-lg border border-card-border bg-background px-2 text-[10px] font-black"
                                  placeholder="정정 가격"
                                />
                                {isUsStockPriceOnlyAmend(item) ? (
                                  <p className="rounded-lg bg-secondary/50 px-2 py-2 text-[8px] font-bold text-muted-foreground">
                                    미국주식은 가격만 정정 · 수량은 기존 잔량 유지
                                  </p>
                                ) : (
                                  <input
                                    aria-label="정정 수량"
                                    inputMode="decimal"
                                    value={draft.quantity}
                                    onChange={(event) => setAmendDrafts((current) => ({
                                      ...current,
                                      [item.id]: { ...draft, quantity: event.target.value },
                                    }))}
                                    className="min-h-10 rounded-lg border border-card-border bg-background px-2 text-[10px] font-black"
                                    placeholder="정정 수량"
                                  />
                                )}
                              </div>
                            ) : item.state === 'PARTIALLY_FILLED' || item.filledQuantity > 0 ? (
                              <p className="mt-2 text-[8px] font-bold text-muted-foreground">
                                부분체결된 주문은 정정하지 않고 미체결 잔량 취소 후 새 계획으로 다시 검증합니다.
                              </p>
                            ) : null}
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                disabled={!canAmendOrder(item) || orderActionId !== null}
                                onClick={() => void amendOrder(item)}
                                className="min-h-10 rounded-lg border border-card-border px-2 text-[9px] font-black disabled:opacity-40"
                              >
                                정정
                              </button>
                              <button
                                type="button"
                                disabled={!canCancelOrder(item) || orderActionId !== null}
                                onClick={() => void cancelOrder(item)}
                                className="min-h-10 rounded-lg border border-destructive/30 bg-destructive/5 px-2 text-[9px] font-black text-destructive disabled:opacity-40"
                              >
                                미체결 취소
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </section>

                  </>
                ) : null}

                {cockpitTab === 'exit' ? (
                  position ? (
                <section className="rounded-2xl border border-card-border bg-background p-3" data-testid="ai-chart-exit-dashboard">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-black">부분청산 · 전량종료 준비</p>
                      <p className="mt-0.5 text-[8px] font-bold text-muted-foreground">실제 보유수량 기준 · 주문 미제출</p>
                    </div>
                    <span className="rounded-full border border-warning/30 bg-warning/5 px-2 py-1 text-[8px] font-black text-warning">종료 계획 미리보기</span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4" data-testid="ai-chart-exit-progress">
                    {[
                      ['Draft', stageTone(exitPreviewState)],
                      ['Plan', stageTone(exitPlanState)],
                      ['승인', stageTone(exitApprovalState)],
                      ['Risk', stageTone(exitRiskState, exitRiskState.kind === 'ready' ? exitRiskState.risk.riskPassed : undefined)],
                      ['Preflight', stageTone(exitPreflightState, exitPreflightState.kind === 'ready' ? exitPreflightState.preflight.preflightPassed : undefined)],
                      ['Package', stageTone(exitExecutionPackageState, exitExecutionPackageState.kind === 'ready' ? exitExecutionPackageState.executionPackage.packageReady : undefined)],
                      ['Submit', stageTone(exitSubmissionGateState, false)],
                    ].map(([label, tone]) => (
                      <span
                        key={String(label)}
                        className={`min-w-0 truncate rounded-lg border px-2 py-1.5 text-center text-[8px] font-black ${cockpitStageClass(tone as CockpitStageTone)}`}
                      >
                        {label}
                      </span>
                    ))}
                    <span className="min-w-0 truncate rounded-lg border border-warning/30 bg-warning/5 px-2 py-1.5 text-center text-[8px] font-black text-warning">
                      Draft Lock
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-1.5">
                    {[25, 50, 75, 100].map((percent) => (
                      <button
                        key={percent}
                        type="button"
                        aria-pressed={exitPercent === percent}
                        onClick={() => {
                          setExitPercent(percent);
                          setExitPreviewState({ kind: 'idle' });
                          setExitPlanState({ kind: 'idle' });
                          setExitApprovalState({ kind: 'idle' });
                          setExitRiskState({ kind: 'idle' });
                          setExitPreflightState({ kind: 'idle' });
    setExitExecutionPackageState({ kind: 'idle' });
                        }}
                        className={`min-h-10 rounded-lg border text-[9px] font-black ${exitPercent === percent ? 'border-primary bg-primary/10 text-primary' : 'border-card-border'}`}
                      >
                        {percent}%
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Metric label="종료 예정 비중" value={`${exitPercent}%`} />
                    <Metric label="종료 예정 수량" value={formatQuantity(exitQuantity)} />
                  </div>
                  <button
                    type="button"
                    data-testid="ai-chart-verify-exit-preview"
                    onClick={() => void verifyExitPreview()}
                    disabled={exitPreviewState.kind === 'loading'}
                    className="mt-2 min-h-11 w-full rounded-xl border border-primary/30 bg-primary/5 px-3 text-[10px] font-black text-primary disabled:opacity-50"
                  >
                    {exitPreviewState.kind === 'loading' ? '실계좌 수량 재확인 중...' : '서버에서 종료계획 재검증'}
                  </button>
                  {exitPreviewState.kind === 'ready' ? (
                    <div className="mt-2 rounded-xl border border-positive/30 bg-positive/5 p-2.5" data-testid="ai-chart-exit-preview-verified">
                      <p className="text-[9px] font-black text-positive">실계좌 read-only 재검증 완료 · reduce-only</p>
                      <p className="mt-1 text-[9px] font-bold text-muted-foreground">
                        서버 확인 수량 {formatQuantity(exitPreviewState.preview.exitQuantity)}
                        {' · '}방향 {exitPreviewState.preview.side.toUpperCase()}
                        {' · '}수량규칙 {exitPreviewState.preview.quantityRule === 'INTEGER_ONLY' ? '정수' : '소수 허용'}
                        {' · '}조회 {checkedAtLabel(exitPreviewState.preview.checkedAt)}
                      </p>
                      <p className="mt-1 break-all text-[8px] font-bold text-muted-foreground">
                        종료 Draft {exitPreviewState.preview.draftId.slice(0, 12)}…
                        {' · '}만료 {checkedAtLabel(exitPreviewState.preview.expiresAt)}
                        {' · '}최종 Risk 재검증 필요
                        {' · '}명시적 승인 필요
                      </p>
                      <p className="mt-1 text-[8px] font-bold text-muted-foreground">executionAuthority=NONE · 주문 제출 0 · 취소/정정 0</p>
                      {exitPreviewState.preview.executionReadiness ? (
                        <div className="mt-2 rounded-lg bg-background/80 p-2 text-[8px] font-bold text-muted-foreground" data-testid="ai-chart-exit-readiness">
                          <p className="font-black text-foreground">
                            실전 종료 준비 · {exitPreviewState.preview.executionReadiness.readyForManualExitEvaluation ? '게이트 준비' : '차단'}
                          </p>
                          <p className="mt-1">
                            거래키 {exitPreviewState.preview.executionReadiness.connectionConfigured ? '연결' : '미연결'}
                            {' · '}provider {exitPreviewState.preview.executionReadiness.providerVerified ? '검증됨' : '미검증'}
                            {' · '}서버게이트 {exitPreviewState.preview.executionReadiness.manualServerGateEnabled ? 'ON' : 'OFF'}
                          </p>
                          {!exitPreviewState.preview.executionReadiness.readyForManualExitEvaluation ? (
                            <p className="mt-1 break-words">차단 사유 · {exitPreviewState.preview.executionReadiness.blockers.map(exitReadinessBlockerLabel).join(' · ') || '확인 필요'}</p>
                          ) : (
                            <p className="mt-1">이 표시는 실행 준비조건만 뜻하며, 종료 주문 승인이나 실행 권한을 부여하지 않습니다.</p>
                          )}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        data-testid="ai-chart-prepare-exit-plan"
                        onClick={() => void prepareCanonicalExitPlan()}
                        disabled={exitPlanState.kind === 'loading'}
                        className="mt-2 min-h-10 w-full rounded-lg border border-primary/30 bg-background px-3 text-[9px] font-black text-primary disabled:opacity-50"
                      >
                        {exitPlanState.kind === 'loading' ? '실계좌 연속성 재확인 중...' : 'Canonical 종료 승인계획 준비'}
                      </button>
                      {exitPlanState.kind === 'ready' ? (
                        <div
                          className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-2 text-[8px] font-bold text-muted-foreground"
                          data-testid="ai-chart-canonical-exit-plan"
                          data-exit-plan-id={exitPlanState.plan.planId}
                        >
                          <p className="font-black text-foreground">
                            종료 승인계획 준비됨 · {exitPlanState.plan.approvalEligible ? '승인 게이트 준비' : '현재 승인 차단'}
                          </p>
                          <p className="mt-1">
                            {exitPlanState.plan.percent}% · {formatQuantity(exitPlanState.plan.quantity)}
                            {' · '}reduce-only · 만료 {checkedAtLabel(exitPlanState.plan.expiresAt)}
                          </p>
                          <p className="mt-1 break-all">
                            Plan {exitPlanState.plan.planId.slice(0, 12)}…
                            {' · '}Draft {exitPlanState.plan.exitDraftId.slice(0, 12)}…
                          </p>
                          {!exitPlanState.plan.approvalEligible && exitPlanState.plan.blockers.length ? (
                            <p className="mt-1 break-words">
                              차단 사유 · {exitPlanState.plan.blockers.map(exitReadinessBlockerLabel).join(' · ')}
                            </p>
                          ) : null}
                          <p className="mt-1">최종 승인 시 실계좌 재확인 + 주문시점 Risk 재검증이 다시 필요합니다. 이 단계에서는 주문을 제출하지 않습니다.</p>
                          <button
                            type="button"
                            data-testid="ai-chart-confirm-exit-approval"
                            onClick={() => void confirmCanonicalExitApproval()}
                            disabled={exitApprovalState.kind === 'loading'}
                            className="mt-2 min-h-10 w-full rounded-lg border border-warning/30 bg-background px-3 text-[9px] font-black text-warning disabled:opacity-50"
                          >
                            {exitApprovalState.kind === 'loading' ? '종료 승인·실계좌 재확인 중...' : '종료 승인 확인 · 아직 주문 전송 안 함'}
                          </button>
                          {exitApprovalState.kind === 'ready' ? (
                            <div
                              className="mt-2 rounded-lg border border-positive/30 bg-positive/5 p-2 text-[8px] font-bold text-muted-foreground"
                              data-testid="ai-chart-exit-approval-intent"
                              data-exit-approval-intent-id={exitApprovalState.approval.approvalIntentId}
                            >
                              <p className="font-black text-positive">명시적 종료 승인 확인됨 · 주문 미전송</p>
                              <p className="mt-1">
                                {exitApprovalState.approval.percent}% · {formatQuantity(exitApprovalState.approval.quantity)}
                                {' · '}reduce-only · 만료 {checkedAtLabel(exitApprovalState.approval.expiresAt)}
                              </p>
                              <p className="mt-1 break-all">
                                Approval {exitApprovalState.approval.approvalIntentId.slice(0, 12)}…
                                {' · '}Plan {exitApprovalState.approval.planId.slice(0, 12)}…
                              </p>
                              <p className="mt-1">다음 단계는 주문시점 Risk 재검증입니다. executionAuthority=NONE · executable=false.</p>
                              <button
                                type="button"
                                data-testid="ai-chart-recheck-exit-risk"
                                onClick={() => void recheckCanonicalExitRisk()}
                                disabled={exitRiskState.kind === 'loading'}
                                className="mt-2 min-h-10 w-full rounded-lg border border-primary/30 bg-background px-3 text-[9px] font-black text-primary disabled:opacity-50"
                              >
                                {exitRiskState.kind === 'loading' ? '주문시점 Risk 재검증 중...' : '주문시점 Risk 재검증 · 아직 실행 안 함'}
                              </button>
                              {exitRiskState.kind === 'ready' ? (
                                <div
                                  className={`mt-2 rounded-lg border p-2 ${exitRiskState.risk.riskPassed ? 'border-positive/30 bg-positive/5' : 'border-warning/30 bg-warning/5'}`}
                                  data-testid="ai-chart-exit-risk-intent"
                                  data-exit-risk-intent-id={exitRiskState.risk.riskIntentId}
                                >
                                  <p className={`font-black ${exitRiskState.risk.riskPassed ? 'text-positive' : 'text-warning'}`}>
                                    {exitRiskState.risk.riskPassed ? '주문시점 Risk 통과 · 아직 주문 미전송' : '주문시점 Risk 차단 · 주문 미전송'}
                                  </p>
                                  <p className="mt-1">
                                    Provider 미체결 확인 {exitRiskState.risk.providerOpenOrdersChecked ? '완료' : '불가'}
                                    {' · '}충돌 주문 {exitRiskState.risk.conflictingOpenOrderCount ?? '미확인'}
                                    {' · '}만료 {checkedAtLabel(exitRiskState.risk.expiresAt)}
                                  </p>
                                  <p className="mt-1 break-all">
                                    Risk {exitRiskState.risk.riskIntentId.slice(0, 12)}…
                                    {' · '}Approval {exitRiskState.risk.approvalIntentId.slice(0, 12)}…
                                  </p>
                                  {exitRiskState.risk.blockers.length ? (
                                    <p className="mt-1 break-words">
                                      차단 사유 · {exitRiskState.risk.blockers.map(exitReadinessBlockerLabel).join(' · ')}
                                    </p>
                                  ) : null}
                                  <p className="mt-1">
                                    다음 단계는 실행 직전 market preflight입니다. executionAuthority=NONE · executable=false.
                                  </p>
                                  {exitRiskState.risk.riskPassed ? (
                                    <button
                                      type="button"
                                      data-testid="ai-chart-prepare-exit-preflight"
                                      onClick={() => void prepareCanonicalExitPreflight()}
                                      disabled={exitPreflightState.kind === 'loading'}
                                      className="mt-2 min-h-10 w-full rounded-lg border border-primary/30 bg-background px-3 text-[9px] font-black text-primary disabled:opacity-50"
                                    >
                                      {exitPreflightState.kind === 'loading' ? '실행 직전 Preflight 재검증 중...' : '실행 직전 Preflight · 아직 주문 안 함'}
                                    </button>
                                  ) : null}
                                  {exitPreflightState.kind === 'ready' ? (
                                    <div
                                      className={`mt-2 rounded-lg border p-2 ${exitPreflightState.preflight.preflightPassed ? 'border-positive/30 bg-positive/5' : 'border-warning/30 bg-warning/5'}`}
                                      data-testid="ai-chart-exit-preflight-intent"
                                      data-exit-preflight-intent-id={exitPreflightState.preflight.preflightIntentId}
                                    >
                                      <p className={`font-black ${exitPreflightState.preflight.preflightPassed ? 'text-positive' : 'text-warning'}`}>
                                        {exitPreflightState.preflight.preflightPassed ? '실행 직전 Preflight 통과 · 주문 미전송' : '실행 직전 Preflight 차단 · 주문 미전송'}
                                      </p>
                                      <p className="mt-1">
                                        기준가 {formatPrice(exitPreflightState.preflight.referencePrice, market)}
                                        {' · '}수량 {formatQuantity(exitPreflightState.preflight.quantity)}
                                        {' · '}만료 {checkedAtLabel(exitPreflightState.preflight.expiresAt)}
                                      </p>
                                      <p className="mt-1 break-all">
                                        Preflight {exitPreflightState.preflight.preflightIntentId.slice(0, 12)}…
                                        {' · '}Risk {exitPreflightState.preflight.riskIntentId.slice(0, 12)}…
                                      </p>
                                      {exitPreflightState.preflight.blockers.length ? (
                                        <p className="mt-1 break-words">
                                          차단 사유 · {exitPreflightState.preflight.blockers.map(exitReadinessBlockerLabel).join(' · ')}
                                        </p>
                                      ) : null}
                                      <p className="mt-1">
                                        실제 전송 전 provider orderbook·slippage 최종검사가 추가로 필요합니다. executionAuthority=NONE · executable=false.
                                      </p>
                                      {exitPreflightState.preflight.preflightPassed ? (
                                        <button
                                          type="button"
                                          data-testid="ai-chart-prepare-exit-execution-package"
                                          onClick={() => void prepareCanonicalExitExecutionPackage()}
                                          disabled={exitExecutionPackageState.kind === 'loading'}
                                          className="mt-2 min-h-10 w-full rounded-lg border border-primary/30 bg-background px-3 text-[9px] font-black text-primary disabled:opacity-50"
                                        >
                                          {exitExecutionPackageState.kind === 'loading' ? '최종 실행 패키지 확인 중...' : '최종 실행 패키지 묶기 · 주문 안 함'}
                                        </button>
                                      ) : null}
                                      {exitExecutionPackageState.kind === 'ready' ? (
                                        <div
                                          className={`mt-2 rounded-lg border p-2 ${exitExecutionPackageState.executionPackage.packageReady ? 'border-positive/30 bg-positive/5' : 'border-warning/30 bg-warning/5'}`}
                                          data-testid="ai-chart-exit-execution-package"
                                          data-exit-execution-package-id={exitExecutionPackageState.executionPackage.executionPackageId}
                                        >
                                          <p className={`font-black ${exitExecutionPackageState.executionPackage.packageReady ? 'text-positive' : 'text-warning'}`}>
                                            {exitExecutionPackageState.executionPackage.packageReady ? '최종 실행 패키지 준비 · 아직 주문 미전송' : '최종 실행 패키지 차단 · 주문 미전송'}
                                          </p>
                                          <p className="mt-1">
                                            현재 기준가 {formatPrice(exitExecutionPackageState.executionPackage.packageReferencePrice, market)}
                                            {' · '}Preflight 기준가 {formatPrice(exitExecutionPackageState.executionPackage.preflightReferencePrice, market)}
                                            {' · '}괴리 {exitExecutionPackageState.executionPackage.referencePriceDriftPercent == null ? '미확인' : `${exitExecutionPackageState.executionPackage.referencePriceDriftPercent.toFixed(3)}%`}
                                          </p>
                                          <p className="mt-1 break-all">
                                            Package {exitExecutionPackageState.executionPackage.executionPackageId.slice(0, 12)}…
                                            {' · '}Preflight {exitExecutionPackageState.executionPackage.preflightIntentId.slice(0, 12)}…
                                          </p>
                                          {exitExecutionPackageState.executionPackage.blockers.length ? (
                                            <p className="mt-1 break-words">
                                              차단 사유 · {exitExecutionPackageState.executionPackage.blockers.map(exitReadinessBlockerLabel).join(' · ')}
                                            </p>
                                          ) : null}
                                          <p className="mt-1">
                                            다음 단계는 provider orderbook/slippage 최종검사 + 별도 제출 owner입니다. providerRequestPrepared=false · executionAuthority=NONE · executable=false.
                                          </p>
                                          {exitExecutionPackageState.executionPackage.packageReady ? (
                                            <button
                                              type="button"
                                              data-testid="ai-chart-check-exit-submission-gate"
                                              onClick={() => void evaluateCanonicalExitSubmissionGate()}
                                              disabled={exitSubmissionGateState.kind === 'loading'}
                                              className="mt-2 min-h-10 w-full rounded-lg border border-warning/30 bg-background px-3 text-[9px] font-black text-warning disabled:opacity-50"
                                            >
                                              {exitSubmissionGateState.kind === 'loading' ? '최종 제출 게이트 확인 중...' : '최종 제출 게이트 확인 · 실주문 잠금'}
                                            </button>
                                          ) : null}
                                          {exitSubmissionGateState.kind === 'ready' ? (
                                            <div
                                              className="mt-2 rounded-lg border border-warning/30 bg-warning/5 p-2"
                                              data-testid="ai-chart-exit-submission-gate"
                                              data-exit-submission-gate-id={exitSubmissionGateState.gate.gateId}
                                            >
                                              <p className="font-black text-warning">Draft 범위 · 실주문 제출 잠김</p>
                                              <p className="mt-1">
                                                패키지 검증 완료 · 연결 게이트 확인 완료 · reduce-only {exitSubmissionGateState.gate.percent}% / {formatQuantity(exitSubmissionGateState.gate.quantity)}
                                              </p>
                                              <p className="mt-1 break-words">
                                                차단 사유 · {exitSubmissionGateState.gate.blockers.map(exitReadinessBlockerLabel).join(' · ')}
                                              </p>
                                              <p className="mt-1">
                                                providerMutationAllowed=false · providerRequestPrepared=false · executionAuthority=NONE · 주문전송 0
                                              </p>
                                              <p className="mt-1">
                                                실제 제출 owner는 별도 실주문 활성화 승인이 있어야 개발·활성화할 수 있습니다.
                                              </p>
                                            </div>
                                          ) : null}
                                          {exitSubmissionGateState.kind === 'unavailable' ? (
                                            <p role="alert" className="mt-2 rounded-lg bg-warning/10 p-2 text-[8px] font-black text-warning">
                                              최종 제출 게이트 확인 실패 · {safeTradeErrorMessage(exitSubmissionGateState.code, exitSubmissionGateState.code)}
                                            </p>
                                          ) : null}
                                        </div>
                                      ) : null}
                                      {exitExecutionPackageState.kind === 'unavailable' ? (
                                        <p role="alert" className="mt-2 rounded-lg bg-warning/10 p-2 text-[8px] font-black text-warning">
                                          최종 실행 패키지 실패 · {safeTradeErrorMessage(exitExecutionPackageState.code, exitExecutionPackageState.code)}
                                        </p>
                                      ) : null}
                                    </div>
                                  ) : null}
                                  {exitPreflightState.kind === 'unavailable' ? (
                                    <p role="alert" className="mt-2 rounded-lg bg-warning/10 p-2 text-[8px] font-black text-warning">
                                      실행 직전 Preflight 실패 · {safeTradeErrorMessage(exitPreflightState.code, exitPreflightState.code)}
                                    </p>
                                  ) : null}
                                </div>
                              ) : null}
                              {exitRiskState.kind === 'unavailable' ? (
                                <p role="alert" className="mt-2 rounded-lg bg-warning/10 p-2 text-[8px] font-black text-warning">
                                  주문시점 Risk 재검증 실패 · {safeTradeErrorMessage(exitRiskState.code, exitRiskState.code)}
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                          {exitApprovalState.kind === 'unavailable' ? (
                            <p role="alert" className="mt-2 rounded-lg bg-warning/10 p-2 text-[8px] font-black text-warning">
                              종료 승인 확인 실패 · {safeTradeErrorMessage(exitApprovalState.code, exitApprovalState.code)}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      {exitPlanState.kind === 'unavailable' ? (
                        <p role="alert" className="mt-2 rounded-lg bg-warning/10 p-2 text-[8px] font-black text-warning">
                          종료 승인계획 준비 실패 · {safeTradeErrorMessage(exitPlanState.code, exitPlanState.code)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {exitPreviewState.kind === 'unavailable' ? (
                    <p role="alert" className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-[9px] font-bold text-warning">종료계획 재검증 실패 · {exitPreviewState.code}</p>
                  ) : null}
                  <p className="mt-2 text-[8px] font-bold leading-4 text-muted-foreground">
                    종료 Draft는 실계좌를 read-only로 재확인하고, Canonical 종료 승인계획은 같은 보유수량·방향이 유지되는지 다시 검증합니다. 둘 다 주문을 제출하지 않으며 실제 청산은 별도 명시적 승인 + 주문시점 Risk 재검증 이후 단계입니다.
                  </p>
                </section>
              ) : (
                <section className="rounded-2xl border border-card-border bg-background p-3" data-testid="ai-chart-exit-dashboard-unavailable">
                  <p className="text-[10px] font-black">부분청산 · 전량종료</p>
                  <p className="mt-1 text-[9px] font-bold leading-4 text-muted-foreground">
                    현재 종목 보유 포지션이 없어 종료계획을 만들지 않습니다. 진입 승인과 미체결 주문관리는 위에서 계속 사용할 수 있습니다.
                  </p>
                </section>
              )
                ) : null}
              </div>
            ) : null}
          </details>
  );

  return (
    <section data-testid="ai-chart-position-panel" className="rounded-2xl border border-card-border bg-background/85 p-3 text-left shadow-sm">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <WalletCards className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[11px] font-black text-primary">내 포지션 · 조회 전용</p>
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

      {(market === 'KR' || market === 'US') && (
        <div data-testid="ai-chart-stock-provider-picker" className="mt-2 grid grid-cols-2 gap-1.5">
          {(['toss', 'kiwoom'] as const).map((item) => (
            <button
              key={item}
              type="button"
              data-testid={`ai-chart-stock-provider-${item}`}
              aria-pressed={stockProvider === item}
              onClick={() => changeStockProvider(item)}
              className={`min-h-10 rounded-xl border px-3 text-[10px] font-black ${stockProvider === item ? 'border-primary bg-primary/10 text-primary' : 'border-card-border text-muted-foreground'}`}
            >
              {providerLabel(item)} 조회
            </button>
          ))}
        </div>
      )}

      {state.kind === 'idle' && (
        <p className="mt-2 text-[10px] font-bold leading-4 text-muted-foreground">차트를 열기만 해서는 계좌를 조회하지 않습니다. 버튼을 눌렀을 때 현재 시장의 조회 전용 스냅샷만 확인합니다.</p>
      )}
      {state.kind === 'unavailable' && (
        <p role="alert" className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-[10px] font-bold text-warning">포지션을 표시할 수 없습니다 · {state.code}</p>
      )}

      <div className="mt-2">
        {tradingCockpit}
      </div>

      {state.kind === 'ready' && !position && (
        <div className="mt-2 space-y-2.5">
          <div className="rounded-xl bg-secondary/60 px-3 py-2">
            <p className="text-[10px] font-black">현재 선택 종목의 보유/포지션 없음</p>
            <p className="mt-1 text-[9px] font-bold text-muted-foreground">조회 시각 {checkedAtLabel(state.snapshot.checkedAt)}{state.snapshot.stale ? ' · 이전 정상값' : ''}</p>
          </div>
          <div className="grid grid-cols-2 gap-1.5" data-testid="ai-chart-account-capacity">
            <Metric label="주문가능/가용" value={formatPrice(availableFunds, market)} />
            <Metric label="Provider 미체결" value={providerOpenOrders == null ? '미확인' : `${providerOpenOrders.length}건`} />
          </div>
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
          <div className="grid grid-cols-2 gap-1.5" data-testid="ai-chart-account-capacity">
            <Metric label="주문가능/가용" value={formatPrice(availableFunds, market)} />
            <Metric label="Provider 미체결" value={providerOpenOrders == null ? '미확인' : `${providerOpenOrders.length}건`} />
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