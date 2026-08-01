import { authorizedFetch } from '@/lib/auth-fetch';
import type { DataStatus } from '@/lib/futures-market-data';

export type TradeSide = 'long' | 'short';

export type RiskEngineInput = {
  market: 'stock' | 'crypto-spot' | 'crypto-futures';
  symbol: string;
  side: TradeSide;

  accountBalance: number;
  entryPrice: number;
  stopLossPrice: number;
  targetPrice1?: number | null;
  targetPrice2?: number | null;

  leverage: number;
  riskPercent: number;

  entryFeeRate: number;
  exitFeeRate: number;
  slippageRate: number;
  estimatedFundingRate: number;

  quantityStep?: number | null;
  minimumQuantity?: number | null;
  minimumNotional?: number | null;
  maintenanceMarginRate?: number | null;

  dailyRealizedPnl?: number;
  weeklyRealizedPnl?: number;
  consecutiveLosses?: number;
  openExposure?: number;
  sameDirectionExposure?: number;

  dataStatus?: DataStatus;
};

export type RiskBlockCode =
  | 'INVALID_ACCOUNT_BALANCE'
  | 'INVALID_ENTRY_PRICE'
  | 'INVALID_STOP_LOSS'
  | 'INVALID_TARGET_PRICE'
  | 'INVALID_LEVERAGE'
  | 'INVALID_RISK_PERCENT'
  | 'INVALID_COST_RATE'
  | 'DATA_NOT_LIVE'
  | 'RISK_REWARD_TOO_LOW'
  | 'DAILY_LOSS_LIMIT'
  | 'WEEKLY_LOSS_LIMIT'
  | 'CONSECUTIVE_LOSS_LIMIT'
  | 'MINIMUM_QUANTITY'
  | 'MINIMUM_NOTIONAL'
  | 'EXPOSURE_LIMIT'
  | 'LIQUIDATION_TOO_CLOSE';

export type RiskEngineResult = {
  allowed: boolean;
  blockCodes: RiskBlockCode[];
  warnings: string[];
  maximumRiskAmount: number | null;
  stopDistance: number | null;
  stopDistancePercent: number | null;
  rawQuantity: number | null;
  recommendedQuantity: number | null;
  notionalValue: number | null;
  requiredMargin: number | null;
  estimatedEntryFee: number | null;
  estimatedExitFeeAtStop: number | null;
  estimatedSlippageCost: number | null;
  estimatedFundingCost: number | null;
  estimatedMaximumLoss: number | null;
  actualRiskPercent: number | null;
  estimatedProfit1: number | null;
  estimatedProfit2: number | null;
  riskReward1: number | null;
  riskReward2: number | null;
  breakEvenPrice: number | null;
  estimatedLiquidationPrice: number | null;
  stopToLiquidationDistancePercent: number | null;
  calculatedAt: string;
};

export type RiskPreviewResponse = {
  ok: boolean;
  mode: 'preview-only';
  orderSubmitted: false;
  result?: RiskEngineResult;
  error?: string;
  message?: string;
};

export async function previewTradingRisk(input: RiskEngineInput): Promise<RiskPreviewResponse> {
  const response = await authorizedFetch('/api/trading/risk/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => null) as RiskPreviewResponse | null;
  if (!payload || typeof payload !== 'object') {
    throw new Error(`리스크 미리보기 응답을 확인할 수 없습니다. HTTP ${response.status}`);
  }
  if (!response.ok && !payload.result) {
    throw new Error(payload.message ?? payload.error ?? `HTTP_${response.status}`);
  }
  return payload;
}
