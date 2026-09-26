import { Router, type IRouter } from 'express';
import {
  calculateTradingRisk,
  type RiskBlockCode,
  type RiskDataStatus,
  type RiskEngineInput,
  type TradeSide,
} from '../services/trading-risk-engine.service';

const router: IRouter = Router();
const MAX_REQUEST_BYTES = 32 * 1024;
const MARKETS = new Set<RiskEngineInput['market']>(['stock', 'crypto-spot', 'crypto-futures']);
const SIDES = new Set<TradeSide>(['long', 'short']);
const DATA_STATUSES = new Set<RiskDataStatus>([
  'live',
  'delayed',
  'cached',
  'disconnected',
  'error',
  'insufficient',
]);
const FATAL_INPUT_CODES = new Set<RiskBlockCode>([
  'INVALID_ACCOUNT_BALANCE',
  'INVALID_ENTRY_PRICE',
  'INVALID_STOP_LOSS',
  'INVALID_TARGET_PRICE',
  'INVALID_LEVERAGE',
  'INVALID_RISK_PERCENT',
  'INVALID_COST_RATE',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredNumber(body: Record<string, unknown>, key: string) {
  return typeof body[key] === 'number' && Number.isFinite(body[key]);
}

function optionalNumber(body: Record<string, unknown>, key: string) {
  return body[key] == null || (typeof body[key] === 'number' && Number.isFinite(body[key]));
}

function optionalStatus(body: Record<string, unknown>, key: string) {
  return body[key] == null || DATA_STATUSES.has(String(body[key]) as RiskDataStatus);
}

function parseRiskInput(body: unknown): RiskEngineInput | null {
  if (!isObject(body)) return null;
  const requiredNumbers = [
    'accountBalance',
    'entryPrice',
    'stopLossPrice',
    'leverage',
    'riskPercent',
    'entryFeeRate',
    'exitFeeRate',
    'slippageRate',
    'estimatedFundingRate',
  ];
  const optionalNumbers = [
    'targetPrice1',
    'targetPrice2',
    'quantityStep',
    'quantityPrecision',
    'minimumQuantity',
    'minimumNotional',
    'maintenanceMarginRate',
    'maximumLeverage',
    'appMaximumLeverage',
    'dailyRealizedPnl',
    'weeklyRealizedPnl',
    'consecutiveLosses',
    'openExposure',
    'sameDirectionExposure',
  ];
  if (!requiredNumbers.every((key) => requiredNumber(body, key))) return null;
  if (!optionalNumbers.every((key) => optionalNumber(body, key))) return null;
  if (!optionalStatus(body, 'contractRulesStatus')) return null;

  const market = String(body.market ?? '') as RiskEngineInput['market'];
  const side = String(body.side ?? '') as TradeSide;
  const symbol = String(body.symbol ?? '').trim().toUpperCase();
  const dataStatus = String(body.dataStatus ?? 'insufficient') as RiskDataStatus;
  const contractRulesStatus = body.contractRulesStatus == null
    ? undefined
    : String(body.contractRulesStatus) as RiskDataStatus;
  if (!MARKETS.has(market) || !SIDES.has(side) || !DATA_STATUSES.has(dataStatus)) return null;
  if (!/^[A-Z0-9._-]{1,30}$/.test(symbol)) return null;

  return {
    market,
    symbol,
    side,
    accountBalance: body.accountBalance as number,
    entryPrice: body.entryPrice as number,
    stopLossPrice: body.stopLossPrice as number,
    targetPrice1: body.targetPrice1 as number | null | undefined,
    targetPrice2: body.targetPrice2 as number | null | undefined,
    leverage: body.leverage as number,
    riskPercent: body.riskPercent as number,
    entryFeeRate: body.entryFeeRate as number,
    exitFeeRate: body.exitFeeRate as number,
    slippageRate: body.slippageRate as number,
    estimatedFundingRate: body.estimatedFundingRate as number,
    quantityStep: body.quantityStep as number | null | undefined,
    quantityPrecision: body.quantityPrecision as number | null | undefined,
    minimumQuantity: body.minimumQuantity as number | null | undefined,
    minimumNotional: body.minimumNotional as number | null | undefined,
    maintenanceMarginRate: body.maintenanceMarginRate as number | null | undefined,
    maximumLeverage: body.maximumLeverage as number | null | undefined,
    appMaximumLeverage: body.appMaximumLeverage as number | null | undefined,
    contractRulesStatus,
    dailyRealizedPnl: body.dailyRealizedPnl as number | undefined,
    weeklyRealizedPnl: body.weeklyRealizedPnl as number | undefined,
    consecutiveLosses: body.consecutiveLosses as number | undefined,
    openExposure: body.openExposure as number | undefined,
    sameDirectionExposure: body.sameDirectionExposure as number | undefined,
    dataStatus,
  };
}

router.post('/trading/risk/preview', (req, res) => {
  const declaredLength = Number(req.header('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return res.status(413).json({
      ok: false,
      mode: 'preview-only',
      orderSubmitted: false,
      error: 'REQUEST_TOO_LARGE',
      message: '리스크 미리보기 요청 크기가 제한을 초과했습니다.',
    });
  }

  let serializedLength = 0;
  try {
    serializedLength = Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8');
  } catch {
    serializedLength = MAX_REQUEST_BYTES + 1;
  }
  if (serializedLength > MAX_REQUEST_BYTES) {
    return res.status(413).json({
      ok: false,
      mode: 'preview-only',
      orderSubmitted: false,
      error: 'REQUEST_TOO_LARGE',
      message: '리스크 미리보기 요청 크기가 제한을 초과했습니다.',
    });
  }

  const input = parseRiskInput(req.body);
  if (!input) {
    return res.status(400).json({
      ok: false,
      mode: 'preview-only',
      orderSubmitted: false,
      error: 'INVALID_RISK_INPUT',
      message: '시장, 종목, 방향 및 숫자 필드를 JSON 숫자 단위로 확인하세요.',
    });
  }

  try {
    const result = calculateTradingRisk(input);
    if (result.blockCodes.some((code) => FATAL_INPUT_CODES.has(code))) {
      return res.status(400).json({
        ok: false,
        mode: 'preview-only',
        orderSubmitted: false,
        error: 'INVALID_RISK_INPUT',
        result,
      });
    }
    return res.json({
      ok: true,
      mode: 'preview-only',
      orderSubmitted: false,
      result,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      mode: 'preview-only',
      orderSubmitted: false,
      error: 'RISK_PREVIEW_FAILED',
      message: '리스크 미리보기를 계산하지 못했습니다.',
    });
  }
});

export default router;
