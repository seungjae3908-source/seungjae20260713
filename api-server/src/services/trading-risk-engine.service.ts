export type TradeSide = 'long' | 'short';

export type RiskDataStatus =
  | 'live'
  | 'delayed'
  | 'cached'
  | 'disconnected'
  | 'error'
  | 'insufficient';

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
  quantityPrecision?: number | null;
  minimumQuantity?: number | null;
  minimumNotional?: number | null;
  maintenanceMarginRate?: number | null;
  maximumLeverage?: number | null;
  appMaximumLeverage?: number | null;
  contractRulesStatus?: RiskDataStatus;

  dailyRealizedPnl?: number;
  weeklyRealizedPnl?: number;
  consecutiveLosses?: number;
  openExposure?: number;
  sameDirectionExposure?: number;

  dataStatus?: RiskDataStatus;
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
  | 'CONTRACT_RULES_NOT_LIVE'
  | 'LEVERAGE_EXCEEDS_EXCHANGE_LIMIT'
  | 'LEVERAGE_EXCEEDS_APP_LIMIT'
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

  effectiveQuantityStep: number | null;
  appMaximumLeverage: number | null;
  exchangeMaximumLeverage: number | null;

  calculatedAt: string;
};

export const TRADING_RISK_POLICY = Object.freeze({
  riskWarningPercent: 0.5,
  maximumRiskPercent: 1,
  minimumRiskReward: 1,
  warningRiskReward: 1.5,
  dailyLossLimitPercent: 1,
  weeklyLossLimitPercent: 3,
  consecutiveLossLimit: 3,
  totalExposureMultiple: 3,
  sameDirectionExposureMultiple: 2,
  defaultMaintenanceMarginRate: 0.005,
  minimumStopLiquidationBufferPercent: 0.5,
  maximumAdjustmentIterations: 1_000,
  cryptoFuturesAppMaximumLeverage: 10,
});

const DATA_STATUSES = new Set<RiskDataStatus>([
  'live',
  'delayed',
  'cached',
  'disconnected',
  'error',
  'insufficient',
]);

const unique = <T>(values: T[]) => [...new Set(values)];

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveOptional(value: number | null | undefined) {
  return value == null || (finite(value) && value > 0);
}

function nonNegativeOptional(value: number | undefined) {
  return value == null || (finite(value) && value >= 0);
}

function validPrecision(value: number | null | undefined) {
  return value == null || (finite(value) && Number.isInteger(value) && value >= 0 && value <= 12);
}

function decimalPlaces(value: number) {
  const text = value.toString().toLowerCase();
  if (text.includes('e-')) return Math.min(12, Number(text.split('e-')[1] ?? 0));
  return Math.min(12, text.includes('.') ? text.split('.')[1]?.length ?? 0 : 0);
}

export function effectiveQuantityStep(
  quantityStep: number | null | undefined,
  quantityPrecision: number | null | undefined,
): number | null {
  const precisionStep = quantityPrecision == null ? null : 10 ** -quantityPrecision;
  const candidates = [quantityStep, precisionStep]
    .filter((value): value is number => finite(value) && value > 0);
  return candidates.length ? Math.max(...candidates) : null;
}

export function floorQuantityToRules(
  value: number,
  quantityStep: number | null | undefined,
  quantityPrecision: number | null | undefined,
) {
  if (!finite(value) || value <= 0) return 0;
  const step = effectiveQuantityStep(quantityStep, quantityPrecision);
  if (step == null) return value;

  const decimals = Math.min(
    12,
    Math.max(decimalPlaces(step), quantityPrecision ?? 0),
  );
  const scale = 10 ** decimals;
  const stepUnits = Math.max(1, Math.round(step * scale));
  const valueUnits = Math.floor(value * scale + 1e-9);
  const flooredUnits = Math.floor(valueUnits / stepUnits) * stepUnits;
  return Number((flooredUnits / scale).toFixed(decimals));
}

/** Phase 3 compatibility export. */
export function floorQuantityToStep(value: number, step: number | null | undefined) {
  return floorQuantityToRules(value, step, null);
}

function baseResult(calculatedAt: string): RiskEngineResult {
  return {
    allowed: false,
    blockCodes: [],
    warnings: [],
    maximumRiskAmount: null,
    stopDistance: null,
    stopDistancePercent: null,
    rawQuantity: null,
    recommendedQuantity: null,
    notionalValue: null,
    requiredMargin: null,
    estimatedEntryFee: null,
    estimatedExitFeeAtStop: null,
    estimatedSlippageCost: null,
    estimatedFundingCost: null,
    estimatedMaximumLoss: null,
    actualRiskPercent: null,
    estimatedProfit1: null,
    estimatedProfit2: null,
    riskReward1: null,
    riskReward2: null,
    breakEvenPrice: null,
    estimatedLiquidationPrice: null,
    stopToLiquidationDistancePercent: null,
    effectiveQuantityStep: null,
    appMaximumLeverage: null,
    exchangeMaximumLeverage: null,
    calculatedAt,
  };
}

function addBlock(blocks: RiskBlockCode[], code: RiskBlockCode) {
  if (!blocks.includes(code)) blocks.push(code);
}

export function validateRiskEngineInput(input: RiskEngineInput): RiskBlockCode[] {
  const blocks: RiskBlockCode[] = [];

  if (!finite(input.accountBalance) || input.accountBalance <= 0) {
    addBlock(blocks, 'INVALID_ACCOUNT_BALANCE');
  }
  if (!finite(input.entryPrice) || input.entryPrice <= 0) {
    addBlock(blocks, 'INVALID_ENTRY_PRICE');
  }
  if (!finite(input.leverage) || input.leverage < 1) {
    addBlock(blocks, 'INVALID_LEVERAGE');
  }
  if (
    !finite(input.riskPercent) ||
    input.riskPercent <= 0 ||
    input.riskPercent > TRADING_RISK_POLICY.maximumRiskPercent
  ) {
    addBlock(blocks, 'INVALID_RISK_PERCENT');
  }

  if (!finite(input.stopLossPrice) || input.stopLossPrice <= 0) {
    addBlock(blocks, 'INVALID_STOP_LOSS');
  } else if (
    (input.side === 'long' && input.stopLossPrice >= input.entryPrice) ||
    (input.side === 'short' && input.stopLossPrice <= input.entryPrice)
  ) {
    addBlock(blocks, 'INVALID_STOP_LOSS');
  }

  for (const target of [input.targetPrice1, input.targetPrice2]) {
    if (target == null) continue;
    if (
      !finite(target) ||
      target <= 0 ||
      (input.side === 'long' && target <= input.entryPrice) ||
      (input.side === 'short' && target >= input.entryPrice)
    ) {
      addBlock(blocks, 'INVALID_TARGET_PRICE');
    }
  }

  const costRates = [
    input.entryFeeRate,
    input.exitFeeRate,
    input.slippageRate,
    input.estimatedFundingRate,
  ];
  if (costRates.some((value) => !finite(value)) || costRates.slice(0, 3).some((value) => value < 0)) {
    addBlock(blocks, 'INVALID_COST_RATE');
  }

  if (!positiveOptional(input.quantityStep) || !validPrecision(input.quantityPrecision)) {
    addBlock(blocks, 'MINIMUM_QUANTITY');
  }
  if (!positiveOptional(input.minimumQuantity)) addBlock(blocks, 'MINIMUM_QUANTITY');
  if (!positiveOptional(input.minimumNotional)) addBlock(blocks, 'MINIMUM_NOTIONAL');
  if (!positiveOptional(input.maximumLeverage) || !positiveOptional(input.appMaximumLeverage)) {
    addBlock(blocks, 'INVALID_LEVERAGE');
  }
  if (input.contractRulesStatus != null && !DATA_STATUSES.has(input.contractRulesStatus)) {
    addBlock(blocks, 'CONTRACT_RULES_NOT_LIVE');
  }
  if (
    !nonNegativeOptional(input.openExposure) ||
    !nonNegativeOptional(input.sameDirectionExposure)
  ) {
    addBlock(blocks, 'EXPOSURE_LIMIT');
  }
  if (!nonNegativeOptional(input.consecutiveLosses)) {
    addBlock(blocks, 'CONSECUTIVE_LOSS_LIMIT');
  }
  if (input.dailyRealizedPnl != null && !finite(input.dailyRealizedPnl)) {
    addBlock(blocks, 'DAILY_LOSS_LIMIT');
  }
  if (input.weeklyRealizedPnl != null && !finite(input.weeklyRealizedPnl)) {
    addBlock(blocks, 'WEEKLY_LOSS_LIMIT');
  }

  return blocks;
}

function calculateBreakEven(input: RiskEngineInput) {
  const entryCostRate = input.entryFeeRate + input.slippageRate;
  const exitCostRate = input.exitFeeRate + input.slippageRate;
  if (input.side === 'long') {
    const denominator = 1 - exitCostRate;
    if (!(denominator > 0)) return null;
    const value = input.entryPrice * (1 + entryCostRate) / denominator;
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const denominator = 1 + exitCostRate;
  if (!(denominator > 0)) return null;
  const value = input.entryPrice * (1 - entryCostRate) / denominator;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function calculateTargetProfit(
  input: RiskEngineInput,
  quantity: number,
  target: number | null | undefined,
  entryFee: number,
  fundingCost: number,
) {
  if (target == null || !finite(target) || !(quantity > 0)) return null;
  const gross = input.side === 'long'
    ? (target - input.entryPrice) * quantity
    : (input.entryPrice - target) * quantity;
  const exitFee = target * quantity * input.exitFeeRate;
  const slippage = (input.entryPrice + target) * quantity * input.slippageRate;
  const profit = gross - entryFee - exitFee - slippage - fundingCost;
  return Number.isFinite(profit) ? profit : null;
}

function liquidationPreview(input: RiskEngineInput) {
  if (input.market !== 'crypto-futures') {
    return { price: null, bufferPercent: null, assumedMaintenance: false };
  }
  const suppliedMaintenance = input.maintenanceMarginRate;
  const maintenanceRate =
    suppliedMaintenance != null && finite(suppliedMaintenance) && suppliedMaintenance >= 0 && suppliedMaintenance < 1
      ? suppliedMaintenance
      : TRADING_RISK_POLICY.defaultMaintenanceMarginRate;
  const raw = input.side === 'long'
    ? input.entryPrice * (1 - 1 / input.leverage + maintenanceRate)
    : input.entryPrice * (1 + 1 / input.leverage - maintenanceRate);
  const price = Number.isFinite(raw) ? Math.max(0, raw) : null;
  if (price == null) return { price: null, bufferPercent: null, assumedMaintenance: suppliedMaintenance == null };
  const favorableBuffer = input.side === 'long'
    ? input.stopLossPrice - price
    : price - input.stopLossPrice;
  const bufferPercent = favorableBuffer / input.entryPrice * 100;
  return {
    price,
    bufferPercent: Number.isFinite(bufferPercent) ? bufferPercent : null,
    assumedMaintenance: suppliedMaintenance == null,
  };
}

export function calculateTradingRisk(
  input: RiskEngineInput,
  now = new Date(),
): RiskEngineResult {
  const result = baseResult(now.toISOString());
  const blocks = validateRiskEngineInput(input);
  const warnings: string[] = [];

  const fatalInputBlocks: RiskBlockCode[] = [
    'INVALID_ACCOUNT_BALANCE',
    'INVALID_ENTRY_PRICE',
    'INVALID_STOP_LOSS',
    'INVALID_TARGET_PRICE',
    'INVALID_LEVERAGE',
    'INVALID_RISK_PERCENT',
    'INVALID_COST_RATE',
  ];
  if (blocks.some((code) => fatalInputBlocks.includes(code))) {
    result.blockCodes = unique(blocks);
    result.warnings = ['입력값을 수정한 뒤 다시 계산하세요.'];
    return result;
  }

  const appMaximumLeverage = input.market === 'crypto-futures'
    ? input.appMaximumLeverage ?? TRADING_RISK_POLICY.cryptoFuturesAppMaximumLeverage
    : input.appMaximumLeverage ?? null;
  result.appMaximumLeverage = appMaximumLeverage;
  result.exchangeMaximumLeverage = input.maximumLeverage ?? null;
  if (appMaximumLeverage != null && input.leverage > appMaximumLeverage) {
    addBlock(blocks, 'LEVERAGE_EXCEEDS_APP_LIMIT');
  }
  if (input.maximumLeverage != null && input.leverage > input.maximumLeverage) {
    addBlock(blocks, 'LEVERAGE_EXCEEDS_EXCHANGE_LIMIT');
  }

  if (input.contractRulesStatus != null && input.contractRulesStatus !== 'live') {
    addBlock(blocks, 'CONTRACT_RULES_NOT_LIVE');
    warnings.push(
      input.contractRulesStatus === 'cached'
        ? '캐시 계약 규칙은 확인용으로만 사용하며 진입 가능 판정은 차단합니다.'
        : `계약 규칙 상태가 ${input.contractRulesStatus}이므로 진입 가능 판정을 차단합니다.`,
    );
  }

  const maximumRiskAmount = input.accountBalance * (input.riskPercent / 100);
  const stopDistance = input.side === 'long'
    ? input.entryPrice - input.stopLossPrice
    : input.stopLossPrice - input.entryPrice;
  const stopDistancePercent = stopDistance / input.entryPrice * 100;
  const perUnitEntryFee = input.entryPrice * input.entryFeeRate;
  const perUnitExitFee = input.stopLossPrice * input.exitFeeRate;
  const perUnitSlippage = (input.entryPrice + input.stopLossPrice) * input.slippageRate;
  const perUnitFunding = input.entryPrice * Math.abs(input.estimatedFundingRate);
  const perUnitMaximumLoss =
    stopDistance +
    perUnitEntryFee +
    perUnitExitFee +
    perUnitSlippage +
    perUnitFunding;

  result.maximumRiskAmount = maximumRiskAmount;
  result.stopDistance = stopDistance;
  result.stopDistancePercent = stopDistancePercent;

  if (!(perUnitMaximumLoss > 0) || !Number.isFinite(perUnitMaximumLoss)) {
    addBlock(blocks, 'INVALID_STOP_LOSS');
    result.blockCodes = unique(blocks);
    result.warnings = ['수량당 총 손실 비용을 계산할 수 없습니다.'];
    return result;
  }

  const rawQuantity = maximumRiskAmount / perUnitMaximumLoss;
  const step = effectiveQuantityStep(input.quantityStep, input.quantityPrecision);
  result.effectiveQuantityStep = step;
  let recommendedQuantity = floorQuantityToRules(
    rawQuantity,
    input.quantityStep,
    input.quantityPrecision,
  );

  const costsFor = (quantity: number) => {
    const notional = input.entryPrice * quantity;
    const entryFee = notional * input.entryFeeRate;
    const exitFee = input.stopLossPrice * quantity * input.exitFeeRate;
    const slippage = (input.entryPrice + input.stopLossPrice) * quantity * input.slippageRate;
    const funding = notional * Math.abs(input.estimatedFundingRate);
    const maximumLoss = stopDistance * quantity + entryFee + exitFee + slippage + funding;
    return { notional, entryFee, exitFee, slippage, funding, maximumLoss };
  };

  let costs = costsFor(recommendedQuantity);
  const tolerance = Math.max(1e-10, maximumRiskAmount * 1e-12);
  let iterations = 0;
  while (
    step != null &&
    recommendedQuantity > 0 &&
    costs.maximumLoss > maximumRiskAmount + tolerance &&
    iterations < TRADING_RISK_POLICY.maximumAdjustmentIterations
  ) {
    recommendedQuantity = floorQuantityToRules(
      recommendedQuantity - step,
      step,
      input.quantityPrecision,
    );
    costs = costsFor(recommendedQuantity);
    iterations += 1;
  }
  if (step == null && costs.maximumLoss > maximumRiskAmount + tolerance) {
    recommendedQuantity = rawQuantity * (maximumRiskAmount / costs.maximumLoss) * (1 - 1e-12);
    costs = costsFor(recommendedQuantity);
  }

  result.rawQuantity = Number.isFinite(rawQuantity) ? rawQuantity : null;
  result.recommendedQuantity = Number.isFinite(recommendedQuantity) ? recommendedQuantity : null;
  result.notionalValue = Number.isFinite(costs.notional) ? costs.notional : null;
  result.requiredMargin = Number.isFinite(costs.notional / input.leverage)
    ? costs.notional / input.leverage
    : null;
  result.estimatedEntryFee = Number.isFinite(costs.entryFee) ? costs.entryFee : null;
  result.estimatedExitFeeAtStop = Number.isFinite(costs.exitFee) ? costs.exitFee : null;
  result.estimatedSlippageCost = Number.isFinite(costs.slippage) ? costs.slippage : null;
  result.estimatedFundingCost = Number.isFinite(costs.funding) ? costs.funding : null;
  result.estimatedMaximumLoss = Number.isFinite(costs.maximumLoss) ? costs.maximumLoss : null;
  result.actualRiskPercent = Number.isFinite(costs.maximumLoss / input.accountBalance * 100)
    ? costs.maximumLoss / input.accountBalance * 100
    : null;

  if (input.riskPercent > TRADING_RISK_POLICY.riskWarningPercent) {
    warnings.push(
      `1회 허용 위험률 ${input.riskPercent}%는 권장 경고 기준 ${TRADING_RISK_POLICY.riskWarningPercent}%를 초과합니다.`,
    );
  }

  if (input.quantityStep == null || input.minimumQuantity == null || input.minimumNotional == null) {
    warnings.push('거래소 최소 주문 규칙을 확인할 수 없습니다.');
  }
  if (input.minimumQuantity != null && recommendedQuantity < input.minimumQuantity) {
    addBlock(blocks, 'MINIMUM_QUANTITY');
  }
  if (input.minimumNotional != null && costs.notional < input.minimumNotional) {
    addBlock(blocks, 'MINIMUM_NOTIONAL');
  }

  const dailyPnl = input.dailyRealizedPnl ?? 0;
  const weeklyPnl = input.weeklyRealizedPnl ?? 0;
  const dailyLimitAmount = input.accountBalance * TRADING_RISK_POLICY.dailyLossLimitPercent / 100;
  const weeklyLimitAmount = input.accountBalance * TRADING_RISK_POLICY.weeklyLossLimitPercent / 100;
  if (dailyPnl <= -dailyLimitAmount) addBlock(blocks, 'DAILY_LOSS_LIMIT');
  if (weeklyPnl <= -weeklyLimitAmount) addBlock(blocks, 'WEEKLY_LOSS_LIMIT');
  if ((input.consecutiveLosses ?? 0) >= TRADING_RISK_POLICY.consecutiveLossLimit) {
    addBlock(blocks, 'CONSECUTIVE_LOSS_LIMIT');
  }

  const totalExposure = (input.openExposure ?? 0) + costs.notional;
  const directionExposure = (input.sameDirectionExposure ?? 0) + costs.notional;
  if (
    totalExposure > input.accountBalance * TRADING_RISK_POLICY.totalExposureMultiple ||
    directionExposure > input.accountBalance * TRADING_RISK_POLICY.sameDirectionExposureMultiple
  ) {
    addBlock(blocks, 'EXPOSURE_LIMIT');
  }

  const dataStatus = input.dataStatus ?? 'insufficient';
  if (dataStatus !== 'live') {
    addBlock(blocks, 'DATA_NOT_LIVE');
    warnings.push(
      dataStatus === 'cached'
        ? '캐시 데이터는 확인용으로만 사용하며 진입 가능 판정은 차단합니다.'
        : `데이터 상태가 ${dataStatus}이므로 진입 가능 판정을 차단합니다.`,
    );
  }

  if (input.estimatedFundingRate !== 0) {
    const positive = input.estimatedFundingRate > 0;
    const likelyPays = (positive && input.side === 'long') || (!positive && input.side === 'short');
    warnings.push(
      `${positive ? '양(+)' : '음(-)'} 펀딩 기준으로 ${input.side === 'long' ? '롱' : '숏'} 포지션은 ${likelyPays ? '지급 가능성' : '수취 가능성'}이 있으나, 최대 손실 계산에서는 보수적으로 비용으로 반영했습니다.`,
    );
  }

  const profit1 = calculateTargetProfit(
    input,
    recommendedQuantity,
    input.targetPrice1,
    costs.entryFee,
    costs.funding,
  );
  const profit2 = calculateTargetProfit(
    input,
    recommendedQuantity,
    input.targetPrice2,
    costs.entryFee,
    costs.funding,
  );
  result.estimatedProfit1 = profit1;
  result.estimatedProfit2 = profit2;
  result.riskReward1 = profit1 != null && costs.maximumLoss > 0 ? profit1 / costs.maximumLoss : null;
  result.riskReward2 = profit2 != null && costs.maximumLoss > 0 ? profit2 / costs.maximumLoss : null;

  const primaryRiskReward = result.riskReward1 ?? result.riskReward2;
  if (primaryRiskReward == null) {
    warnings.push('목표가가 없어 손익비 기반 진입 판정은 적용하지 않았습니다.');
  } else if (primaryRiskReward < TRADING_RISK_POLICY.minimumRiskReward) {
    addBlock(blocks, 'RISK_REWARD_TOO_LOW');
  } else if (primaryRiskReward < TRADING_RISK_POLICY.warningRiskReward) {
    warnings.push(
      `손익비 ${primaryRiskReward.toFixed(2)}는 강한 경고 구간(1.0 이상 1.5 미만)입니다.`,
    );
  }

  const breakEvenPrice = calculateBreakEven(input);
  result.breakEvenPrice = breakEvenPrice;
  if (breakEvenPrice == null) warnings.push('수수료와 슬리피지를 반영한 손익분기 가격을 계산할 수 없습니다.');

  const liquidation = liquidationPreview(input);
  result.estimatedLiquidationPrice = liquidation.price;
  result.stopToLiquidationDistancePercent = liquidation.bufferPercent;
  if (input.market === 'crypto-futures') {
    warnings.push('실제 청산가격은 거래소 유지증거금, 계정 모드 및 포지션 상태에 따라 달라질 수 있습니다.');
    if (liquidation.assumedMaintenance) {
      warnings.push(
        `유지증거금률 정보가 없어 ${(TRADING_RISK_POLICY.defaultMaintenanceMarginRate * 100).toFixed(2)}%를 적용한 단순 근사입니다.`,
      );
    }
    if (
      liquidation.bufferPercent == null ||
      liquidation.bufferPercent < TRADING_RISK_POLICY.minimumStopLiquidationBufferPercent
    ) {
      addBlock(blocks, 'LIQUIDATION_TOO_CLOSE');
    }
  }

  if (
    result.estimatedMaximumLoss == null ||
    result.maximumRiskAmount == null ||
    result.estimatedMaximumLoss > result.maximumRiskAmount + tolerance
  ) {
    addBlock(blocks, 'INVALID_STOP_LOSS');
    warnings.push('최종 수량의 예상 최대손실이 허용 손실액 이내인지 확인할 수 없습니다.');
  }

  result.blockCodes = unique(blocks);
  result.warnings = unique(warnings);
  result.allowed = result.blockCodes.length === 0;
  return result;
}
