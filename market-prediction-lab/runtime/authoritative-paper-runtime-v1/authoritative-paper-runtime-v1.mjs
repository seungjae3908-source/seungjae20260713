// src/services/trading-risk-engine.service.ts
var TRADING_RISK_POLICY = Object.freeze({
  riskWarningPercent: 0.5,
  maximumRiskPercent: 1,
  minimumRiskReward: 1,
  warningRiskReward: 1.5,
  dailyLossLimitPercent: 1,
  weeklyLossLimitPercent: 3,
  consecutiveLossLimit: 3,
  totalExposureMultiple: 3,
  sameDirectionExposureMultiple: 2,
  defaultMaintenanceMarginRate: 5e-3,
  minimumStopLiquidationBufferPercent: 0.5,
  maximumAdjustmentIterations: 1e3,
  cryptoFuturesAppMaximumLeverage: 10
});
var DATA_STATUSES = /* @__PURE__ */ new Set([
  "live",
  "delayed",
  "cached",
  "disconnected",
  "error",
  "insufficient"
]);
var unique = (values) => [...new Set(values)];
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function positiveOptional(value) {
  return value == null || finite(value) && value > 0;
}
function nonNegativeOptional(value) {
  return value == null || finite(value) && value >= 0;
}
function validPrecision(value) {
  return value == null || finite(value) && Number.isInteger(value) && value >= 0 && value <= 12;
}
function decimalPlaces(value) {
  const text = value.toString().toLowerCase();
  if (text.includes("e-")) return Math.min(12, Number(text.split("e-")[1] ?? 0));
  return Math.min(12, text.includes(".") ? text.split(".")[1]?.length ?? 0 : 0);
}
function effectiveQuantityStep(quantityStep, quantityPrecision) {
  const precisionStep = quantityPrecision == null ? null : 10 ** -quantityPrecision;
  const candidates = [quantityStep, precisionStep].filter((value) => finite(value) && value > 0);
  return candidates.length ? Math.max(...candidates) : null;
}
function floorQuantityToRules(value, quantityStep, quantityPrecision) {
  if (!finite(value) || value <= 0) return 0;
  const step = effectiveQuantityStep(quantityStep, quantityPrecision);
  if (step == null) return value;
  const decimals = Math.min(
    12,
    Math.max(decimalPlaces(step), quantityPrecision ?? 0)
  );
  const scale = 10 ** decimals;
  const stepUnits = Math.max(1, Math.round(step * scale));
  const valueUnits = Math.floor(value * scale + 1e-9);
  const flooredUnits = Math.floor(valueUnits / stepUnits) * stepUnits;
  return Number((flooredUnits / scale).toFixed(decimals));
}
function baseResult(calculatedAt) {
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
    calculatedAt
  };
}
function addBlock(blocks, code) {
  if (!blocks.includes(code)) blocks.push(code);
}
function validateRiskEngineInput(input) {
  const blocks = [];
  if (!finite(input.accountBalance) || input.accountBalance <= 0) {
    addBlock(blocks, "INVALID_ACCOUNT_BALANCE");
  }
  if (!finite(input.entryPrice) || input.entryPrice <= 0) {
    addBlock(blocks, "INVALID_ENTRY_PRICE");
  }
  if (!finite(input.leverage) || input.leverage < 1) {
    addBlock(blocks, "INVALID_LEVERAGE");
  }
  if (!finite(input.riskPercent) || input.riskPercent <= 0 || input.riskPercent > TRADING_RISK_POLICY.maximumRiskPercent) {
    addBlock(blocks, "INVALID_RISK_PERCENT");
  }
  if (!finite(input.stopLossPrice) || input.stopLossPrice <= 0) {
    addBlock(blocks, "INVALID_STOP_LOSS");
  } else if (input.side === "long" && input.stopLossPrice >= input.entryPrice || input.side === "short" && input.stopLossPrice <= input.entryPrice) {
    addBlock(blocks, "INVALID_STOP_LOSS");
  }
  for (const target of [input.targetPrice1, input.targetPrice2]) {
    if (target == null) continue;
    if (!finite(target) || target <= 0 || input.side === "long" && target <= input.entryPrice || input.side === "short" && target >= input.entryPrice) {
      addBlock(blocks, "INVALID_TARGET_PRICE");
    }
  }
  const costRates = [
    input.entryFeeRate,
    input.exitFeeRate,
    input.slippageRate,
    input.estimatedFundingRate
  ];
  if (costRates.some((value) => !finite(value)) || costRates.slice(0, 3).some((value) => value < 0)) {
    addBlock(blocks, "INVALID_COST_RATE");
  }
  if (!positiveOptional(input.quantityStep) || !validPrecision(input.quantityPrecision)) {
    addBlock(blocks, "MINIMUM_QUANTITY");
  }
  if (!positiveOptional(input.minimumQuantity)) addBlock(blocks, "MINIMUM_QUANTITY");
  if (!positiveOptional(input.minimumNotional)) addBlock(blocks, "MINIMUM_NOTIONAL");
  if (!positiveOptional(input.maximumLeverage) || !positiveOptional(input.appMaximumLeverage)) {
    addBlock(blocks, "INVALID_LEVERAGE");
  }
  if (input.contractRulesStatus != null && !DATA_STATUSES.has(input.contractRulesStatus)) {
    addBlock(blocks, "CONTRACT_RULES_NOT_LIVE");
  }
  if (!nonNegativeOptional(input.openExposure) || !nonNegativeOptional(input.sameDirectionExposure)) {
    addBlock(blocks, "EXPOSURE_LIMIT");
  }
  if (!nonNegativeOptional(input.consecutiveLosses)) {
    addBlock(blocks, "CONSECUTIVE_LOSS_LIMIT");
  }
  if (input.dailyRealizedPnl != null && !finite(input.dailyRealizedPnl)) {
    addBlock(blocks, "DAILY_LOSS_LIMIT");
  }
  if (input.weeklyRealizedPnl != null && !finite(input.weeklyRealizedPnl)) {
    addBlock(blocks, "WEEKLY_LOSS_LIMIT");
  }
  return blocks;
}
function calculateBreakEven(input) {
  const entryCostRate = input.entryFeeRate + input.slippageRate;
  const exitCostRate = input.exitFeeRate + input.slippageRate;
  if (input.side === "long") {
    const denominator2 = 1 - exitCostRate;
    if (!(denominator2 > 0)) return null;
    const value2 = input.entryPrice * (1 + entryCostRate) / denominator2;
    return Number.isFinite(value2) && value2 > 0 ? value2 : null;
  }
  const denominator = 1 + exitCostRate;
  if (!(denominator > 0)) return null;
  const value = input.entryPrice * (1 - entryCostRate) / denominator;
  return Number.isFinite(value) && value > 0 ? value : null;
}
function calculateTargetProfit(input, quantity, target, entryFee, fundingCost) {
  if (target == null || !finite(target) || !(quantity > 0)) return null;
  const gross = input.side === "long" ? (target - input.entryPrice) * quantity : (input.entryPrice - target) * quantity;
  const exitFee = target * quantity * input.exitFeeRate;
  const slippage = (input.entryPrice + target) * quantity * input.slippageRate;
  const profit = gross - entryFee - exitFee - slippage - fundingCost;
  return Number.isFinite(profit) ? profit : null;
}
function liquidationPreview(input) {
  if (input.market !== "crypto-futures") {
    return { price: null, bufferPercent: null, assumedMaintenance: false };
  }
  const suppliedMaintenance = input.maintenanceMarginRate;
  const maintenanceRate = suppliedMaintenance != null && finite(suppliedMaintenance) && suppliedMaintenance >= 0 && suppliedMaintenance < 1 ? suppliedMaintenance : TRADING_RISK_POLICY.defaultMaintenanceMarginRate;
  const raw = input.side === "long" ? input.entryPrice * (1 - 1 / input.leverage + maintenanceRate) : input.entryPrice * (1 + 1 / input.leverage - maintenanceRate);
  const price = Number.isFinite(raw) ? Math.max(0, raw) : null;
  if (price == null) return { price: null, bufferPercent: null, assumedMaintenance: suppliedMaintenance == null };
  const favorableBuffer = input.side === "long" ? input.stopLossPrice - price : price - input.stopLossPrice;
  const bufferPercent = favorableBuffer / input.entryPrice * 100;
  return {
    price,
    bufferPercent: Number.isFinite(bufferPercent) ? bufferPercent : null,
    assumedMaintenance: suppliedMaintenance == null
  };
}
function calculateTradingRisk(input, now = /* @__PURE__ */ new Date()) {
  const result3 = baseResult(now.toISOString());
  const blocks = validateRiskEngineInput(input);
  const warnings = [];
  const fatalInputBlocks = [
    "INVALID_ACCOUNT_BALANCE",
    "INVALID_ENTRY_PRICE",
    "INVALID_STOP_LOSS",
    "INVALID_TARGET_PRICE",
    "INVALID_LEVERAGE",
    "INVALID_RISK_PERCENT",
    "INVALID_COST_RATE"
  ];
  if (blocks.some((code) => fatalInputBlocks.includes(code))) {
    result3.blockCodes = unique(blocks);
    result3.warnings = ["입력값을 수정한 뒤 다시 계산하세요."];
    return result3;
  }
  const appMaximumLeverage = input.market === "crypto-futures" ? input.appMaximumLeverage ?? TRADING_RISK_POLICY.cryptoFuturesAppMaximumLeverage : input.appMaximumLeverage ?? null;
  result3.appMaximumLeverage = appMaximumLeverage;
  result3.exchangeMaximumLeverage = input.maximumLeverage ?? null;
  if (appMaximumLeverage != null && input.leverage > appMaximumLeverage) {
    addBlock(blocks, "LEVERAGE_EXCEEDS_APP_LIMIT");
  }
  if (input.maximumLeverage != null && input.leverage > input.maximumLeverage) {
    addBlock(blocks, "LEVERAGE_EXCEEDS_EXCHANGE_LIMIT");
  }
  if (input.contractRulesStatus != null && input.contractRulesStatus !== "live") {
    addBlock(blocks, "CONTRACT_RULES_NOT_LIVE");
    warnings.push(
      input.contractRulesStatus === "cached" ? "캐시 계약 규칙은 확인용으로만 사용하며 진입 가능 판정은 차단합니다." : `계약 규칙 상태가 ${input.contractRulesStatus}이므로 진입 가능 판정을 차단합니다.`
    );
  }
  const maximumRiskAmount = input.accountBalance * (input.riskPercent / 100);
  const stopDistance = input.side === "long" ? input.entryPrice - input.stopLossPrice : input.stopLossPrice - input.entryPrice;
  const stopDistancePercent = stopDistance / input.entryPrice * 100;
  const perUnitEntryFee = input.entryPrice * input.entryFeeRate;
  const perUnitExitFee = input.stopLossPrice * input.exitFeeRate;
  const perUnitSlippage = (input.entryPrice + input.stopLossPrice) * input.slippageRate;
  const perUnitFunding = input.entryPrice * Math.abs(input.estimatedFundingRate);
  const perUnitMaximumLoss = stopDistance + perUnitEntryFee + perUnitExitFee + perUnitSlippage + perUnitFunding;
  result3.maximumRiskAmount = maximumRiskAmount;
  result3.stopDistance = stopDistance;
  result3.stopDistancePercent = stopDistancePercent;
  if (!(perUnitMaximumLoss > 0) || !Number.isFinite(perUnitMaximumLoss)) {
    addBlock(blocks, "INVALID_STOP_LOSS");
    result3.blockCodes = unique(blocks);
    result3.warnings = ["수량당 총 손실 비용을 계산할 수 없습니다."];
    return result3;
  }
  const rawQuantity = maximumRiskAmount / perUnitMaximumLoss;
  const step = effectiveQuantityStep(input.quantityStep, input.quantityPrecision);
  result3.effectiveQuantityStep = step;
  let recommendedQuantity = floorQuantityToRules(
    rawQuantity,
    input.quantityStep,
    input.quantityPrecision
  );
  const costsFor = (quantity) => {
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
  while (step != null && recommendedQuantity > 0 && costs.maximumLoss > maximumRiskAmount + tolerance && iterations < TRADING_RISK_POLICY.maximumAdjustmentIterations) {
    recommendedQuantity = floorQuantityToRules(
      recommendedQuantity - step,
      step,
      input.quantityPrecision
    );
    costs = costsFor(recommendedQuantity);
    iterations += 1;
  }
  if (step == null && costs.maximumLoss > maximumRiskAmount + tolerance) {
    recommendedQuantity = rawQuantity * (maximumRiskAmount / costs.maximumLoss) * (1 - 1e-12);
    costs = costsFor(recommendedQuantity);
  }
  result3.rawQuantity = Number.isFinite(rawQuantity) ? rawQuantity : null;
  result3.recommendedQuantity = Number.isFinite(recommendedQuantity) ? recommendedQuantity : null;
  result3.notionalValue = Number.isFinite(costs.notional) ? costs.notional : null;
  result3.requiredMargin = Number.isFinite(costs.notional / input.leverage) ? costs.notional / input.leverage : null;
  result3.estimatedEntryFee = Number.isFinite(costs.entryFee) ? costs.entryFee : null;
  result3.estimatedExitFeeAtStop = Number.isFinite(costs.exitFee) ? costs.exitFee : null;
  result3.estimatedSlippageCost = Number.isFinite(costs.slippage) ? costs.slippage : null;
  result3.estimatedFundingCost = Number.isFinite(costs.funding) ? costs.funding : null;
  result3.estimatedMaximumLoss = Number.isFinite(costs.maximumLoss) ? costs.maximumLoss : null;
  result3.actualRiskPercent = Number.isFinite(costs.maximumLoss / input.accountBalance * 100) ? costs.maximumLoss / input.accountBalance * 100 : null;
  if (input.riskPercent > TRADING_RISK_POLICY.riskWarningPercent) {
    warnings.push(
      `1회 허용 위험률 ${input.riskPercent}%는 권장 경고 기준 ${TRADING_RISK_POLICY.riskWarningPercent}%를 초과합니다.`
    );
  }
  if (input.quantityStep == null || input.minimumQuantity == null || input.minimumNotional == null) {
    warnings.push("거래소 최소 주문 규칙을 확인할 수 없습니다.");
  }
  if (input.minimumQuantity != null && recommendedQuantity < input.minimumQuantity) {
    addBlock(blocks, "MINIMUM_QUANTITY");
  }
  if (input.minimumNotional != null && costs.notional < input.minimumNotional) {
    addBlock(blocks, "MINIMUM_NOTIONAL");
  }
  const dailyPnl = input.dailyRealizedPnl ?? 0;
  const weeklyPnl = input.weeklyRealizedPnl ?? 0;
  const dailyLimitAmount = input.accountBalance * TRADING_RISK_POLICY.dailyLossLimitPercent / 100;
  const weeklyLimitAmount = input.accountBalance * TRADING_RISK_POLICY.weeklyLossLimitPercent / 100;
  if (dailyPnl <= -dailyLimitAmount) addBlock(blocks, "DAILY_LOSS_LIMIT");
  if (weeklyPnl <= -weeklyLimitAmount) addBlock(blocks, "WEEKLY_LOSS_LIMIT");
  if ((input.consecutiveLosses ?? 0) >= TRADING_RISK_POLICY.consecutiveLossLimit) {
    addBlock(blocks, "CONSECUTIVE_LOSS_LIMIT");
  }
  const totalExposure = (input.openExposure ?? 0) + costs.notional;
  const directionExposure = (input.sameDirectionExposure ?? 0) + costs.notional;
  if (totalExposure > input.accountBalance * TRADING_RISK_POLICY.totalExposureMultiple || directionExposure > input.accountBalance * TRADING_RISK_POLICY.sameDirectionExposureMultiple) {
    addBlock(blocks, "EXPOSURE_LIMIT");
  }
  const dataStatus = input.dataStatus ?? "insufficient";
  if (dataStatus !== "live") {
    addBlock(blocks, "DATA_NOT_LIVE");
    warnings.push(
      dataStatus === "cached" ? "캐시 데이터는 확인용으로만 사용하며 진입 가능 판정은 차단합니다." : `데이터 상태가 ${dataStatus}이므로 진입 가능 판정을 차단합니다.`
    );
  }
  if (input.estimatedFundingRate !== 0) {
    const positive5 = input.estimatedFundingRate > 0;
    const likelyPays = positive5 && input.side === "long" || !positive5 && input.side === "short";
    warnings.push(
      `${positive5 ? "양(+)" : "음(-)"} 펀딩 기준으로 ${input.side === "long" ? "롱" : "숏"} 포지션은 ${likelyPays ? "지급 가능성" : "수취 가능성"}이 있으나, 최대 손실 계산에서는 보수적으로 비용으로 반영했습니다.`
    );
  }
  const profit1 = calculateTargetProfit(
    input,
    recommendedQuantity,
    input.targetPrice1,
    costs.entryFee,
    costs.funding
  );
  const profit2 = calculateTargetProfit(
    input,
    recommendedQuantity,
    input.targetPrice2,
    costs.entryFee,
    costs.funding
  );
  result3.estimatedProfit1 = profit1;
  result3.estimatedProfit2 = profit2;
  result3.riskReward1 = profit1 != null && costs.maximumLoss > 0 ? profit1 / costs.maximumLoss : null;
  result3.riskReward2 = profit2 != null && costs.maximumLoss > 0 ? profit2 / costs.maximumLoss : null;
  const primaryRiskReward = result3.riskReward1 ?? result3.riskReward2;
  if (primaryRiskReward == null) {
    warnings.push("목표가가 없어 손익비 기반 진입 판정은 적용하지 않았습니다.");
  } else if (primaryRiskReward < TRADING_RISK_POLICY.minimumRiskReward) {
    addBlock(blocks, "RISK_REWARD_TOO_LOW");
  } else if (primaryRiskReward < TRADING_RISK_POLICY.warningRiskReward) {
    warnings.push(
      `손익비 ${primaryRiskReward.toFixed(2)}는 강한 경고 구간(1.0 이상 1.5 미만)입니다.`
    );
  }
  const breakEvenPrice = calculateBreakEven(input);
  result3.breakEvenPrice = breakEvenPrice;
  if (breakEvenPrice == null) warnings.push("수수료와 슬리피지를 반영한 손익분기 가격을 계산할 수 없습니다.");
  const liquidation = liquidationPreview(input);
  result3.estimatedLiquidationPrice = liquidation.price;
  result3.stopToLiquidationDistancePercent = liquidation.bufferPercent;
  if (input.market === "crypto-futures") {
    warnings.push("실제 청산가격은 거래소 유지증거금, 계정 모드 및 포지션 상태에 따라 달라질 수 있습니다.");
    if (liquidation.assumedMaintenance) {
      warnings.push(
        `유지증거금률 정보가 없어 ${(TRADING_RISK_POLICY.defaultMaintenanceMarginRate * 100).toFixed(2)}%를 적용한 단순 근사입니다.`
      );
    }
    if (liquidation.bufferPercent == null || liquidation.bufferPercent < TRADING_RISK_POLICY.minimumStopLiquidationBufferPercent) {
      addBlock(blocks, "LIQUIDATION_TOO_CLOSE");
    }
  }
  if (result3.estimatedMaximumLoss == null || result3.maximumRiskAmount == null || result3.estimatedMaximumLoss > result3.maximumRiskAmount + tolerance) {
    addBlock(blocks, "INVALID_STOP_LOSS");
    warnings.push("최종 수량의 예상 최대손실이 허용 손실액 이내인지 확인할 수 없습니다.");
  }
  result3.blockCodes = unique(blocks);
  result3.warnings = unique(warnings);
  result3.allowed = result3.blockCodes.length === 0;
  return result3;
}

// src/services/paper-trading-core.service.ts
var PaperTradingError = class extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "PaperTradingError";
  }
};
var MARKET_FRESHNESS_MS = 6e4;
var CONTRACT_FRESHNESS_MS = 20 * 6e4;
var EPSILON = 1e-8;
var finite2 = (value) => typeof value === "number" && Number.isFinite(value);
var positive = (value) => finite2(value) && value > 0;
var nonNegative = (value) => finite2(value) && value >= 0;
function isFresh(updatedAt, now, limitMs) {
  const timestamp2 = Date.parse(updatedAt);
  return Number.isFinite(timestamp2) && now.getTime() >= timestamp2 && now.getTime() - timestamp2 <= limitMs;
}
function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !state.account) {
    throw new PaperTradingError("INVALID_PAPER_STATE", "모의거래 상태 형식이 올바르지 않습니다.");
  }
  const accountNumbers = [
    state.account.initialBalance,
    state.account.cashBalance,
    state.account.realizedPnl,
    state.account.unrealizedPnl,
    state.account.equity,
    state.account.usedMargin,
    state.account.availableMargin
  ];
  if (accountNumbers.some((value) => !finite2(value)) || !(state.account.initialBalance > 0)) {
    throw new PaperTradingError("INVALID_PAPER_STATE", "모의계좌 계산값이 올바르지 않습니다.");
  }
  if (!Array.isArray(state.orders) || !Array.isArray(state.positions) || !Array.isArray(state.fills) || !Array.isArray(state.journal)) {
    throw new PaperTradingError("INVALID_PAPER_STATE", "모의거래 목록 형식이 올바르지 않습니다.");
  }
}
function validateOrderRequest(request) {
  const symbol = String(request.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
    throw new PaperTradingError("INVALID_SYMBOL", "종목 형식이 올바르지 않습니다.");
  }
  if (!["long", "short"].includes(request.side)) {
    throw new PaperTradingError("INVALID_SIDE", "롱·숏 방향이 올바르지 않습니다.");
  }
  if (!["market", "limit", "stop_market"].includes(request.orderType)) {
    throw new PaperTradingError("INVALID_ORDER_TYPE", "모의주문 유형이 올바르지 않습니다.");
  }
  if (!positive(request.leverage) || !positive(request.stopLossPrice)) {
    throw new PaperTradingError("INVALID_ORDER_INPUT", "레버리지와 손절가는 0보다 커야 합니다.");
  }
  if (request.orderType === "limit" && !positive(request.requestedPrice)) {
    throw new PaperTradingError("INVALID_LIMIT_PRICE", "지정가 모의주문에는 지정가가 필요합니다.");
  }
  if (request.orderType === "stop_market" && !positive(request.triggerPrice)) {
    throw new PaperTradingError("INVALID_TRIGGER_PRICE", "스탑 시장가 모의주문에는 트리거 가격이 필요합니다.");
  }
  if (request.quantity != null && !positive(request.quantity)) {
    throw new PaperTradingError("INVALID_QUANTITY", "수량은 0보다 커야 합니다.");
  }
  for (const target of [request.takeProfitPrice1, request.takeProfitPrice2]) {
    if (target != null && !positive(target)) {
      throw new PaperTradingError("INVALID_TARGET_PRICE", "목표가는 0보다 커야 합니다.");
    }
  }
  const percent1 = request.targetClosePercent1 ?? (request.takeProfitPrice2 != null ? 50 : 100);
  const percent2 = request.targetClosePercent2 ?? (request.takeProfitPrice2 != null ? 50 : 0);
  if (!nonNegative(percent1) || !nonNegative(percent2) || percent1 > 100 || percent2 > 100 || percent1 + percent2 > 100 + EPSILON) {
    throw new PaperTradingError("INVALID_TARGET_ALLOCATION", "목표가별 청산 비율 합계는 100%를 넘을 수 없습니다.");
  }
  return {
    ...request,
    symbol,
    targetClosePercent1: percent1,
    targetClosePercent2: percent2
  };
}
function openExposure(state) {
  return state.positions.filter((position) => position.status !== "closed").reduce((sum, position) => sum + position.notionalValue, 0);
}
function sameDirectionExposure(state, side) {
  return state.positions.filter((position) => position.status !== "closed" && position.side === side).reduce((sum, position) => sum + position.notionalValue, 0);
}
function buildRiskInput(state, request, market, rules, supplied, entryPrice, now) {
  const marketStatus = market.status === "live" && isFresh(market.updatedAt, now, MARKET_FRESHNESS_MS) ? "live" : "delayed";
  const rulesStatus = rules.status === "live" && isFresh(rules.updatedAt, now, CONTRACT_FRESHNESS_MS) ? "live" : "delayed";
  return {
    ...supplied,
    market: "crypto-futures",
    symbol: request.symbol,
    side: request.side,
    accountBalance: state.account.equity,
    entryPrice,
    stopLossPrice: request.stopLossPrice,
    targetPrice1: request.takeProfitPrice1,
    targetPrice2: request.takeProfitPrice2,
    leverage: request.leverage,
    quantityStep: rules.quantityStep,
    quantityPrecision: rules.quantityPrecision,
    minimumQuantity: rules.minimumQuantity,
    minimumNotional: rules.minimumNotional,
    maintenanceMarginRate: rules.maintenanceMarginRate,
    maximumLeverage: rules.maximumLeverage,
    appMaximumLeverage: TRADING_RISK_POLICY.cryptoFuturesAppMaximumLeverage,
    contractRulesStatus: rulesStatus,
    dailyRealizedPnl: state.riskState.dailyRealizedPnl,
    weeklyRealizedPnl: state.riskState.weeklyRealizedPnl,
    consecutiveLosses: state.riskState.consecutiveLosses,
    openExposure: openExposure(state),
    sameDirectionExposure: sameDirectionExposure(state, request.side),
    dataStatus: marketStatus,
    estimatedFundingRate: finite2(market.fundingRate) ? market.fundingRate : supplied.estimatedFundingRate
  };
}

// src/services/scanner-paper-admission-evidence-bundle.service.ts
import { createHash } from "node:crypto";

// src/services/trade-paper-market-contract.service.ts
var EXPECTED_PROVIDER = Object.freeze({
  KR_STOCK: "toss",
  US_STOCK: "toss",
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget"
});
var MARKETS = new Set(Object.keys(EXPECTED_PROVIDER));
var DIRECTIONS = /* @__PURE__ */ new Set(["BUY", "SELL", "EXIT", "LONG", "SHORT"]);
var PARTIAL_FILL_MODELS = /* @__PURE__ */ new Set(["NONE", "PRO_RATA", "ORDER_BOOK"]);
var DEFAULT_MAX_EVIDENCE_AGE_MS = 3e4;
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function add(blockers, blocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}
function result(blockers) {
  const frozenBlockers = Object.freeze([...blockers]);
  return Object.freeze({
    ready: frozenBlockers.length === 0,
    status: frozenBlockers.length === 0 ? "READY" : "BLOCKED",
    blockers: frozenBlockers,
    simulatedOnly: true,
    liveOrderAllowed: false,
    orderSubmitted: false,
    privateTradingApiAllowed: false,
    privateProviderRequests: 0,
    liveAuthority: false
  });
}
function validatePaperReadiness(evidence, nowMs = Date.now(), maxEvidenceAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS) {
  const blockers = [];
  if (!isRecord(evidence)) return result(["EVIDENCE_INVALID"]);
  const market = evidence.market;
  if (typeof market !== "string" || !MARKETS.has(market)) {
    add(blockers, "MARKET_UNSUPPORTED");
    return result(blockers);
  }
  const canonicalMarket = market;
  if (evidence.provider !== EXPECTED_PROVIDER[canonicalMarket]) add(blockers, "PROVIDER_MISMATCH");
  if (!nonEmptyString(evidence.providerProvenance)) add(blockers, "PROVIDER_PROVENANCE_REQUIRED");
  const direction = evidence.direction;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction)) {
    add(blockers, "DIRECTION_UNSUPPORTED");
  } else if (canonicalMarket === "CRYPTO_FUTURES") {
    if (direction !== "LONG" && direction !== "SHORT") add(blockers, "DIRECTION_UNSUPPORTED");
  } else if (direction === "LONG" || direction === "SHORT") {
    add(blockers, "DIRECTION_UNSUPPORTED");
  } else if ((direction === "SELL" || direction === "EXIT") && evidence.isReducing !== true) {
    add(blockers, "REDUCING_EXIT_REQUIRED");
  }
  const observedAtMs = evidence.observedAtMs;
  if (!finitePositive(observedAtMs) || !finitePositive(nowMs) || !finitePositive(maxEvidenceAgeMs)) {
    add(blockers, "EVIDENCE_TIMESTAMP_INVALID");
  } else if (observedAtMs > nowMs) {
    add(blockers, "EVIDENCE_FROM_FUTURE");
  } else if (nowMs - observedAtMs > maxEvidenceAgeMs) {
    add(blockers, "EVIDENCE_STALE");
  }
  if (!nonEmptyString(evidence.costPolicyVersion)) add(blockers, "COST_POLICY_VERSION_REQUIRED");
  if (!finiteNonNegative(evidence.feePercent)) add(blockers, "FEE_PERCENT_INVALID");
  if (!finiteNonNegative(evidence.spreadPercent)) add(blockers, "SPREAD_PERCENT_INVALID");
  if (!finiteNonNegative(evidence.slippagePercent)) add(blockers, "SLIPPAGE_PERCENT_INVALID");
  if (!finitePositive(evidence.tickSize)) add(blockers, "TICK_SIZE_INVALID");
  if (!finitePositive(evidence.liquidity)) add(blockers, "LIQUIDITY_INVALID");
  if (typeof evidence.partialFillModel !== "string" || !PARTIAL_FILL_MODELS.has(evidence.partialFillModel)) {
    add(blockers, "PARTIAL_FILL_MODEL_REQUIRED");
  }
  if (canonicalMarket === "KR_STOCK" || canonicalMarket === "US_STOCK") {
    if (!nonEmptyString(evidence.sessionCalendarVersion)) add(blockers, "SESSION_CALENDAR_VERSION_REQUIRED");
    if (evidence.marketStatus !== "OPEN") add(blockers, "MARKET_NOT_OPEN");
    if (!nonEmptyString(evidence.taxPolicyVersion)) add(blockers, "TAX_POLICY_VERSION_REQUIRED");
    if (!finiteNonNegative(evidence.taxPercent)) add(blockers, "TAX_PERCENT_INVALID");
  } else if (canonicalMarket === "CRYPTO_SPOT") {
    if (!finitePositive(evidence.minimumOrderNotional)) add(blockers, "MINIMUM_ORDER_NOTIONAL_INVALID");
  } else {
    if (!finitePositive(evidence.minimumOrderQuantity)) add(blockers, "MINIMUM_ORDER_QUANTITY_INVALID");
    if (!finitePositive(evidence.quantityStep)) add(blockers, "QUANTITY_STEP_INVALID");
    if (!Number.isInteger(evidence.quantityPrecision) || Number(evidence.quantityPrecision) < 0) {
      add(blockers, "QUANTITY_PRECISION_INVALID");
    }
    if (!finitePositive(evidence.markPrice)) add(blockers, "MARK_PRICE_INVALID");
    if (typeof evidence.fundingRate !== "number" || !Number.isFinite(evidence.fundingRate)) {
      add(blockers, "FUNDING_RATE_INVALID");
    }
    if (!finitePositive(evidence.leverage)) add(blockers, "LEVERAGE_INVALID");
    if (evidence.marginMode !== "isolated" && evidence.marginMode !== "cross") add(blockers, "MARGIN_MODE_INVALID");
    if (!finitePositive(evidence.liquidationDistancePercent)) add(blockers, "LIQUIDATION_DISTANCE_INVALID");
  }
  return result(blockers);
}

// src/services/scanner-profit-cost-evidence-adapter.service.ts
var DEFAULT_MAX_EVIDENCE_AGE_MS2 = 3e4;
var QUALITIES = /* @__PURE__ */ new Set(["OBSERVED", "DOCUMENTED", "ESTIMATED", "NOT_APPLICABLE"]);
function nonEmptyString2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function finiteNonNegative2(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function add2(blockers, blocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}
function notApplicable(value, source, observedAtMs) {
  return Object.freeze({ valuePercent: value, quality: "NOT_APPLICABLE", source, observedAtMs });
}
function derived(value, source, observedAtMs, quality = "OBSERVED") {
  return Object.freeze({ valuePercent: value, quality, source, observedAtMs });
}
function validateComponent(component, blockers, requiredBlocker, nowMs, maxEvidenceAgeMs) {
  if (!component) {
    add2(blockers, requiredBlocker);
    return false;
  }
  let valid = true;
  if (!finiteNonNegative2(component.valuePercent) || !QUALITIES.has(component.quality)) {
    add2(blockers, "COST_COMPONENT_INVALID");
    valid = false;
  }
  if (!nonEmptyString2(component.source)) {
    add2(blockers, "COST_COMPONENT_SOURCE_REQUIRED");
    valid = false;
  }
  if (!Number.isFinite(component.observedAtMs) || component.observedAtMs <= 0) {
    add2(blockers, "COST_COMPONENT_TIMESTAMP_INVALID");
    valid = false;
  } else if (component.observedAtMs > nowMs) {
    add2(blockers, "COST_COMPONENT_FROM_FUTURE");
    valid = false;
  } else if (nowMs - component.observedAtMs > maxEvidenceAgeMs) {
    add2(blockers, "COST_COMPONENT_STALE");
    valid = false;
  }
  if (component.quality === "NOT_APPLICABLE" && component.valuePercent !== 0) {
    add2(blockers, "NOT_APPLICABLE_COMPONENT_MUST_BE_ZERO");
    valid = false;
  }
  return valid;
}
function result2(blockers, policy = null, provenance = null) {
  return Object.freeze({
    status: blockers.length === 0 ? "READY" : "NOT_EVIDENCED",
    policy: blockers.length === 0 ? policy : null,
    provenance: blockers.length === 0 ? provenance : null,
    blockers: Object.freeze([...blockers]),
    executionAuthority: "NONE",
    orderSubmitted: false,
    exchangeRequestSent: false,
    privateApiUsed: false,
    liveTrading: false
  });
}
function buildScannerTradingCostPolicy(input) {
  const nowMs = input.nowMs ?? Date.now();
  const maxEvidenceAgeMs = input.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS2;
  const blockers = [];
  const readiness = validatePaperReadiness(input.paperEvidence, nowMs, maxEvidenceAgeMs);
  if (!readiness.ready) add2(blockers, "PAPER_READINESS_BLOCKED");
  const supplemental = input.supplemental;
  if (!nonEmptyString2(supplemental?.costPolicyId)) add2(blockers, "COST_POLICY_ID_REQUIRED");
  if (!Number.isFinite(supplemental?.observedAtMs) || supplemental.observedAtMs <= 0) {
    add2(blockers, "SUPPLEMENTAL_TIMESTAMP_INVALID");
  } else if (supplemental.observedAtMs > nowMs) {
    add2(blockers, "SUPPLEMENTAL_EVIDENCE_FROM_FUTURE");
  } else if (nowMs - supplemental.observedAtMs > maxEvidenceAgeMs) {
    add2(blockers, "SUPPLEMENTAL_EVIDENCE_STALE");
  }
  const latencyOk = validateComponent(
    supplemental?.latency,
    blockers,
    "LATENCY_EVIDENCE_REQUIRED",
    nowMs,
    maxEvidenceAgeMs
  );
  const liquidityOk = validateComponent(
    supplemental?.liquidityImpact,
    blockers,
    "LIQUIDITY_IMPACT_EVIDENCE_REQUIRED",
    nowMs,
    maxEvidenceAgeMs
  );
  const partialFillOk = validateComponent(
    supplemental?.partialFillImpact,
    blockers,
    "PARTIAL_FILL_IMPACT_EVIDENCE_REQUIRED",
    nowMs,
    maxEvidenceAgeMs
  );
  const paper = input.paperEvidence;
  let funding;
  if (paper.market === "CRYPTO_FUTURES") {
    const fundingOk = validateComponent(
      supplemental?.funding,
      blockers,
      "FUNDING_EVIDENCE_REQUIRED",
      nowMs,
      maxEvidenceAgeMs
    );
    if (!fundingOk) {
      funding = derived(0, "missing", nowMs, "ESTIMATED");
    } else {
      funding = supplemental.funding;
      if (funding.quality === "NOT_APPLICABLE" && funding.valuePercent !== 0) {
        add2(blockers, "FUNDING_NOT_APPLICABLE_ONLY_IF_EXPLICIT_ZERO");
      }
    }
  } else {
    funding = notApplicable(0, `market-contract:${paper.market}:funding-not-applicable`, paper.observedAtMs);
  }
  if (blockers.length > 0 || !latencyOk || !liquidityOk || !partialFillOk) return result2(blockers);
  const commission = derived(paper.feePercent, `${paper.providerProvenance}:fee`, paper.observedAtMs);
  const spread = derived(paper.spreadPercent, `${paper.providerProvenance}:spread`, paper.observedAtMs);
  const slippage = derived(paper.slippagePercent, `${paper.providerProvenance}:slippage`, paper.observedAtMs);
  const tax = paper.market === "KR_STOCK" || paper.market === "US_STOCK" ? derived(paper.taxPercent, `tax-policy:${paper.taxPolicyVersion}`, paper.observedAtMs, "DOCUMENTED") : notApplicable(0, `market-contract:${paper.market}:tax-not-applicable`, paper.observedAtMs);
  const policy = Object.freeze({
    id: supplemental.costPolicyId,
    market: paper.market,
    commissionPercent: commission.valuePercent,
    taxPercent: tax.valuePercent,
    spreadPercent: spread.valuePercent,
    slippagePercent: slippage.valuePercent,
    fundingPercent: funding.valuePercent,
    latencyPercent: supplemental.latency.valuePercent,
    liquidityImpactPercent: supplemental.liquidityImpact.valuePercent,
    partialFillImpactPercent: supplemental.partialFillImpact.valuePercent,
    source: "EXPLICIT_RUNTIME_POLICY"
  });
  const provenance = Object.freeze({
    market: paper.market,
    policyId: supplemental.costPolicyId,
    paperCostPolicyVersion: paper.costPolicyVersion,
    providerProvenance: paper.providerProvenance,
    taxPolicyVersion: paper.market === "KR_STOCK" || paper.market === "US_STOCK" ? paper.taxPolicyVersion : null,
    components: Object.freeze({
      commission,
      tax,
      spread,
      slippage,
      funding,
      latency: supplemental.latency,
      liquidityImpact: supplemental.liquidityImpact,
      partialFillImpact: supplemental.partialFillImpact
    })
  });
  return result2(blockers, policy, provenance);
}

// src/services/scanner-paper-admission-evidence-bundle.service.ts
var SCANNER_PAPER_ADMISSION_BUNDLE_VERSION = "scanner-paper-admission-evidence-bundle-v1";
var SCANNER_PAPER_ADMISSION_EXECUTION_AUTHORITY = "NONE";
var DEFAULT_MAX_EVIDENCE_AGE_MS3 = 3e4;
var MARKET_PROVIDER = Object.freeze({
  KR_STOCK: "toss",
  US_STOCK: "toss",
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget"
});
var RISK_MARKET = Object.freeze({
  KR_STOCK: "stock",
  US_STOCK: "stock",
  CRYPTO_SPOT: "crypto-spot",
  CRYPTO_FUTURES: "crypto-futures"
});
var LEARNING_HORIZON = Object.freeze({
  SCALPING: "SCALP",
  SWING: "SWING",
  MID_LONG: "POSITION"
});
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function finite3(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function positive2(value) {
  return finite3(value) && value > 0;
}
function nonNegative2(value) {
  return finite3(value) && value >= 0;
}
function add3(blockers, blocker, condition = true) {
  if (condition && !blockers.includes(blocker)) blockers.push(blocker);
}
function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function digest(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
function clone(value) {
  return structuredClone(value);
}
function safetyEnvelope() {
  return Object.freeze({
    executionAuthority: SCANNER_PAPER_ADMISSION_EXECUTION_AUTHORITY,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false
  });
}
function blocked(blockers) {
  return Object.freeze({
    status: "BLOCKED",
    bundle: null,
    blockers: Object.freeze([...new Set(blockers)]),
    ...safetyEnvelope()
  });
}
function parseIso(value) {
  if (!nonEmpty(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function expectedRiskSide(direction) {
  if (direction === "BUY" || direction === "LONG") return "long";
  if (direction === "SHORT") return "short";
  return null;
}
function validateCandidate(candidate, blockers) {
  const signal = candidate?.signal;
  if (!signal || !nonEmpty(signal.signalId) || !nonEmpty(signal.symbol)) add3(blockers, "CANONICAL_PAPER_IDENTITY_REQUIRED");
  if (!signal?.strategyIdentity || !nonEmpty(signal.strategyIdentity.costPolicyVersion)) add3(blockers, "CANONICAL_COST_POLICY_VERSION_REQUIRED");
  if (candidate?.executionAuthority !== "NONE" || candidate?.liveOrderAllowed !== false || candidate?.privateTradingApiAllowed !== false || candidate?.orderSubmitted !== false || candidate?.exchangeRequestSent !== false) add3(blockers, "CANONICAL_PAPER_SAFETY_ENVELOPE_INVALID");
  if (signal?.direction === "SELL") add3(blockers, "PAPER_ENTRY_DIRECTION_UNSUPPORTED");
}
function validateLearning(candidate, learning, blockers) {
  const signal = candidate.signal;
  if (learning?.immutable !== true || learning?.executionAuthority !== "NONE") add3(blockers, "LEARNING_SNAPSHOT_NOT_IMMUTABLE");
  if (learning?.signalId !== signal.signalId) add3(blockers, "LEARNING_SIGNAL_ID_MISMATCH");
  if (learning?.market !== signal.market) add3(blockers, "LEARNING_MARKET_MISMATCH");
  if (learning?.symbol !== signal.symbol) add3(blockers, "LEARNING_SYMBOL_MISMATCH");
  if (learning?.strategyProfileVersion !== signal.strategyIdentity.strategyVersion) add3(blockers, "LEARNING_STRATEGY_VERSION_MISMATCH");
  if (learning?.direction !== signal.direction) add3(blockers, "LEARNING_DIRECTION_MISMATCH");
  if (learning?.strategyHorizon !== LEARNING_HORIZON[signal.style]) add3(blockers, "LEARNING_HORIZON_MISMATCH");
  if (!Array.isArray(learning?.timeframes) || !learning.timeframes.includes(signal.timeframe)) add3(blockers, "LEARNING_TIMEFRAME_MISMATCH");
  const timestampMs = parseIso(learning?.timestamp);
  if (timestampMs !== signal.timestampMs) add3(blockers, "LEARNING_TIMESTAMP_MISMATCH");
  const dataTimestampMs = parseIso(learning?.dataTimestamp);
  if (dataTimestampMs == null || timestampMs != null && dataTimestampMs > timestampMs) add3(blockers, "LEARNING_DATA_TIMESTAMP_INVALID");
  if (!Array.isArray(learning?.dataProvenance) || learning.dataProvenance.length === 0 || learning.dataProvenance.some((source) => !nonEmpty(source))) add3(blockers, "LEARNING_DATA_PROVENANCE_REQUIRED");
}
function validateRisk(candidate, riskInput, riskResult, nowMs, maxEvidenceAgeMs, blockers) {
  const expectedSide = expectedRiskSide(candidate.signal.direction);
  if (!expectedSide) add3(blockers, "PAPER_ENTRY_DIRECTION_UNSUPPORTED");
  if (riskInput?.market !== RISK_MARKET[candidate.signal.market]) add3(blockers, "RISK_MARKET_MISMATCH");
  if (riskInput?.symbol !== candidate.signal.symbol) add3(blockers, "RISK_SYMBOL_MISMATCH");
  if (expectedSide && riskInput?.side !== expectedSide) add3(blockers, "RISK_SIDE_MISMATCH");
  if (riskInput?.dataStatus !== "live") add3(blockers, "RISK_DATA_NOT_LIVE");
  if (candidate.signal.market === "CRYPTO_FUTURES" && riskInput?.contractRulesStatus !== "live") add3(blockers, "RISK_CONTRACT_RULES_NOT_LIVE");
  if (riskResult?.allowed !== true || !Array.isArray(riskResult?.blockCodes) || riskResult.blockCodes.length !== 0) add3(blockers, "RISK_ENGINE_NOT_APPROVED");
  const evaluatedAtMs = parseIso(riskResult?.calculatedAt);
  if (evaluatedAtMs == null) add3(blockers, "RISK_TIMESTAMP_INVALID");
  else if (evaluatedAtMs > nowMs) add3(blockers, "RISK_EVIDENCE_FROM_FUTURE");
  else if (nowMs - evaluatedAtMs > maxEvidenceAgeMs) add3(blockers, "RISK_EVIDENCE_STALE");
  if (!positive2(riskResult?.recommendedQuantity)) add3(blockers, "RISK_RECOMMENDED_QUANTITY_REQUIRED");
  if (!finite3(riskResult?.actualRiskPercent) && riskResult?.actualRiskPercent != null) add3(blockers, "RISK_PERCENT_INVALID");
  if (finite3(riskResult?.actualRiskPercent) && positive2(riskInput?.riskPercent) && riskResult.actualRiskPercent > riskInput.riskPercent + 1e-9) add3(blockers, "RISK_PERCENT_EXCEEDS_REQUEST");
  if (blockers.length > 0 || evaluatedAtMs == null || !positive2(riskResult.recommendedQuantity)) return null;
  return Object.freeze({
    status: "APPROVED",
    source: "TRADING_RISK_ENGINE",
    evaluatedAtMs,
    simulatedOnly: true,
    allowed: true,
    blockCodes: Object.freeze([]),
    recommendedQuantity: riskResult.recommendedQuantity,
    actualRiskPercent: riskResult.actualRiskPercent,
    riskReward1: riskResult.riskReward1,
    riskReward2: riskResult.riskReward2,
    executionAuthority: "NONE"
  });
}
function validQuoteEvidence(value, nowMs) {
  if (!isRecord2(value) || value.available !== true || !positive2(value.bid) || !positive2(value.ask) || value.bid > value.ask) return false;
  if (!finite3(value.asOfMs) || !positive2(value.maxAgeMs)) return false;
  return value.asOfMs <= nowMs && nowMs - value.asOfMs <= value.maxAgeMs;
}
function normalizedQuoteEvidence(value) {
  if (!isRecord2(value)) return void 0;
  return Object.freeze({
    available: value.available === true,
    bid: finite3(value.bid) ? value.bid : null,
    ask: finite3(value.ask) ? value.ask : null,
    last: finite3(value.last) ? value.last : null,
    asOfMs: finite3(value.asOfMs) ? value.asOfMs : null,
    maxAgeMs: finite3(value.maxAgeMs) ? value.maxAgeMs : null
  });
}
function normalizeExecutionEvidence(candidate, paper, raw, nowMs, blockers) {
  if (!isRecord2(raw)) {
    add3(blockers, "EXECUTION_DATA_EVIDENCE_REQUIRED");
    return null;
  }
  const signal = candidate.signal;
  const lifetimeValid = positive2(signal.timestampMs) && positive2(signal.ttlMs) && positive2(signal.expiresAtMs) && signal.expiresAtMs === signal.timestampMs + signal.ttlMs;
  if (!lifetimeValid) add3(blockers, "PAPER_CANDIDATE_LIFETIME_INVALID");
  else {
    if (signal.timestampMs > nowMs) add3(blockers, "PAPER_CANDIDATE_FROM_FUTURE");
    if (nowMs >= signal.expiresAtMs) add3(blockers, "PAPER_CANDIDATE_EXPIRED");
  }
  const market = signal.market;
  const expectedProvider = MARKET_PROVIDER[market];
  if (raw.provider !== expectedProvider || paper.provider !== expectedProvider) add3(blockers, "EXECUTION_PROVIDER_MISMATCH");
  if (raw.publicOnly !== true || raw.dataQuality !== "READY") add3(blockers, "EXECUTION_PUBLIC_READY_EVIDENCE_REQUIRED");
  if (!nonEmpty(raw.provenance) || raw.provenance !== paper.providerProvenance) add3(blockers, "EXECUTION_PROVENANCE_MISMATCH");
  if (!finite3(raw.asOfMs) || raw.asOfMs !== paper.observedAtMs) add3(blockers, "EXECUTION_TIMESTAMP_MISMATCH");
  if (!positive2(raw.maxAgeMs) || finite3(raw.asOfMs) && (raw.asOfMs > nowMs || nowMs - raw.asOfMs > raw.maxAgeMs)) add3(blockers, "EXECUTION_EVIDENCE_STALE_OR_FUTURE");
  if (!positive2(raw.tickSize) || raw.tickSize !== paper.tickSize) add3(blockers, "EXECUTION_TICK_SIZE_MISMATCH");
  if (raw.privateApiUsed === true || raw.privateTradingApiAllowed === true || raw.liveOrderAllowed === true || raw.orderSubmitted === true || raw.exchangeRequestSent === true) add3(blockers, "EXECUTION_SAFETY_VIOLATION");
  const realtimeBarReady = raw.barProxyRealtimeAllowed === true;
  const quoteReady = validQuoteEvidence(raw.quoteEvidence, nowMs);
  if (!realtimeBarReady && !quoteReady) add3(blockers, "EXECUTION_FILL_FIDELITY_EVIDENCE_REQUIRED");
  const common = {
    provider: expectedProvider,
    provenance: paper.providerProvenance,
    publicOnly: true,
    dataQuality: "READY",
    asOfMs: paper.observedAtMs,
    maxAgeMs: raw.maxAgeMs,
    tickSize: paper.tickSize,
    barProxyRealtimeAllowed: realtimeBarReady
  };
  const quote = normalizedQuoteEvidence(raw.quoteEvidence);
  if (quote) common.quoteEvidence = quote;
  if (market === "KR_STOCK" || market === "US_STOCK") {
    const stock = paper;
    const session = isRecord2(raw.session) ? raw.session : null;
    if (raw.taxPolicyKnown !== true || raw.taxPolicyVersion !== stock.taxPolicyVersion) add3(blockers, "EXECUTION_TAX_POLICY_MISMATCH");
    if (!session || session.version !== stock.sessionCalendarVersion || session.status !== stock.marketStatus) add3(blockers, "EXECUTION_SESSION_MISMATCH");
    if (market === "KR_STOCK") {
      if (typeof raw.volatilityInterruptionKnown !== "boolean") add3(blockers, "EXECUTION_KR_VOLATILITY_INTERRUPTION_REQUIRED");
      if (candidate.signal.style === "SCALPING" && raw.volatilityInterruptionKnown === true && raw.volatilityInterruptionActive === true) add3(blockers, "EXECUTION_KR_VOLATILITY_INTERRUPTION_ACTIVE");
    }
    if (market === "US_STOCK") {
      const kind = session?.kind;
      if (kind !== "REGULAR" && kind !== "PREMARKET" && kind !== "AFTER_HOURS") add3(blockers, "EXECUTION_US_SESSION_KIND_REQUIRED");
      if ((kind === "PREMARKET" || kind === "AFTER_HOURS") && raw.extendedHoursEvidenceReady !== true) add3(blockers, "EXECUTION_US_EXTENDED_HOURS_EVIDENCE_REQUIRED");
    }
    common.taxPolicyKnown = true;
    common.taxPolicyVersion = stock.taxPolicyVersion;
    common.session = Object.freeze({ version: stock.sessionCalendarVersion, status: stock.marketStatus, ...nonEmpty(session?.kind) ? { kind: session.kind } : {} });
    if (market === "KR_STOCK") {
      common.volatilityInterruptionKnown = raw.volatilityInterruptionKnown;
      common.volatilityInterruptionActive = raw.volatilityInterruptionActive === true;
    }
    if (market === "US_STOCK" && raw.extendedHoursEvidenceReady != null) common.extendedHoursEvidenceReady = raw.extendedHoursEvidenceReady === true;
  } else if (market === "CRYPTO_SPOT") {
    const spot = paper;
    if (raw.marketStatus !== "TRADABLE") add3(blockers, "EXECUTION_SPOT_MARKET_NOT_TRADABLE");
    if (!positive2(raw.minOrderNotional) || raw.minOrderNotional !== spot.minimumOrderNotional) add3(blockers, "EXECUTION_MIN_ORDER_NOTIONAL_MISMATCH");
    common.marketStatus = "TRADABLE";
    common.minOrderNotional = spot.minimumOrderNotional;
  } else {
    const futures = paper;
    if (raw.contractStatus !== "TRADABLE") add3(blockers, "EXECUTION_FUTURES_CONTRACT_NOT_TRADABLE");
    if (raw.minQty !== futures.minimumOrderQuantity) add3(blockers, "EXECUTION_MIN_QTY_MISMATCH");
    if (raw.qtyStep !== futures.quantityStep) add3(blockers, "EXECUTION_QTY_STEP_MISMATCH");
    if (raw.quantityPrecision !== futures.quantityPrecision) add3(blockers, "EXECUTION_QTY_PRECISION_MISMATCH");
    if (raw.markPrice !== futures.markPrice) add3(blockers, "EXECUTION_MARK_PRICE_MISMATCH");
    if (raw.fundingRate !== futures.fundingRate) add3(blockers, "EXECUTION_FUNDING_RATE_MISMATCH");
    if (raw.leverage !== futures.leverage) add3(blockers, "EXECUTION_LEVERAGE_MISMATCH");
    if (raw.marginMode !== futures.marginMode.toUpperCase()) add3(blockers, "EXECUTION_MARGIN_MODE_MISMATCH");
    if (raw.liquidationDistancePct !== futures.liquidationDistancePercent) add3(blockers, "EXECUTION_LIQUIDATION_DISTANCE_MISMATCH");
    if (!positive2(raw.indexPrice)) add3(blockers, "EXECUTION_INDEX_PRICE_REQUIRED");
    if (!nonNegative2(raw.openInterest)) add3(blockers, "EXECUTION_OPEN_INTEREST_REQUIRED");
    if (!positive2(raw.maxLeverage) || futures.leverage > raw.maxLeverage) add3(blockers, "EXECUTION_MAX_LEVERAGE_REQUIRED");
    Object.assign(common, {
      contractStatus: "TRADABLE",
      minQty: futures.minimumOrderQuantity,
      qtyStep: futures.quantityStep,
      quantityPrecision: futures.quantityPrecision,
      markPrice: futures.markPrice,
      indexPrice: raw.indexPrice,
      fundingRate: futures.fundingRate,
      openInterest: raw.openInterest,
      leverage: futures.leverage,
      maxLeverage: raw.maxLeverage,
      marginMode: futures.marginMode.toUpperCase(),
      liquidationDistancePct: futures.liquidationDistancePercent
    });
  }
  return deepFreeze(common);
}
function executionCostPolicy(provenance) {
  const c = provenance.components;
  const rate = (valuePercent) => valuePercent / 100;
  return Object.freeze({
    version: provenance.policyId,
    commissionRate: rate(c.commission.valuePercent),
    taxRate: rate(c.tax.valuePercent),
    spreadRate: rate(c.spread.valuePercent),
    slippageRate: rate(c.slippage.valuePercent),
    fundingRate: rate(c.funding.valuePercent),
    latencyRate: rate(c.latency.valuePercent),
    liquidityImpactRate: rate(c.liquidityImpact.valuePercent),
    partialFillImpactRate: rate(c.partialFillImpact.valuePercent),
    source: "SCANNER_COST_EVIDENCE_PERCENT_DIV_100",
    unitConversion: "PERCENT_DIV_100"
  });
}
function buildScannerCanonicalPaperAdmissionEvidence(input) {
  const nowMs = input.nowMs ?? Date.now();
  const maxEvidenceAgeMs = input.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS3;
  const blockers = [];
  if (!positive2(nowMs) || !positive2(maxEvidenceAgeMs)) return blocked(["ADMISSION_EVIDENCE_CLOCK_INVALID"]);
  validateCandidate(input.paperCandidate, blockers);
  validateLearning(input.paperCandidate, input.learningSnapshot, blockers);
  const signal = input.paperCandidate.signal;
  if (input.paperEvidence?.market !== signal.market) add3(blockers, "PAPER_READINESS_MARKET_MISMATCH");
  if (input.paperEvidence?.direction !== signal.direction) add3(blockers, "PAPER_READINESS_DIRECTION_MISMATCH");
  const canonicalCostPolicyVersion = signal.strategyIdentity.costPolicyVersion;
  if (input.paperEvidence?.costPolicyVersion !== canonicalCostPolicyVersion) add3(blockers, "PAPER_COST_POLICY_VERSION_MISMATCH");
  if (input.supplementalCostEvidence?.costPolicyId !== canonicalCostPolicyVersion) add3(blockers, "SUPPLEMENTAL_COST_POLICY_VERSION_MISMATCH");
  const readiness = validatePaperReadiness(input.paperEvidence, nowMs, maxEvidenceAgeMs);
  if (!readiness.ready) add3(blockers, "PAPER_READINESS_BLOCKED");
  const cost = buildScannerTradingCostPolicy({
    paperEvidence: input.paperEvidence,
    supplemental: input.supplementalCostEvidence,
    nowMs,
    maxEvidenceAgeMs
  });
  if (cost.status !== "READY" || !cost.policy || !cost.provenance) add3(blockers, "SCANNER_COST_EVIDENCE_NOT_READY");
  if (cost.provenance && (cost.provenance.policyId !== canonicalCostPolicyVersion || cost.provenance.paperCostPolicyVersion !== canonicalCostPolicyVersion)) add3(blockers, "COST_PROVENANCE_POLICY_VERSION_MISMATCH");
  const riskEvidence = validateRisk(input.paperCandidate, input.riskInput, input.riskResult, nowMs, maxEvidenceAgeMs, blockers);
  const executionDataEvidence = normalizeExecutionEvidence(input.paperCandidate, input.paperEvidence, input.executionDataEvidence, nowMs, blockers);
  if (blockers.length > 0 || !riskEvidence || !executionDataEvidence || !cost.provenance) return blocked(blockers);
  const bundleWithoutDigest = {
    schemaVersion: SCANNER_PAPER_ADMISSION_BUNDLE_VERSION,
    paperCandidate: clone(input.paperCandidate),
    learningSnapshot: clone(input.learningSnapshot),
    riskEvidence,
    executionEvidence: {
      dataEvidence: executionDataEvidence,
      costPolicy: executionCostPolicy(cost.provenance),
      costProvenance: clone(cost.provenance)
    },
    ...safetyEnvelope()
  };
  const bundle = deepFreeze({ ...bundleWithoutDigest, evidenceDigest: digest(bundleWithoutDigest) });
  return Object.freeze({ status: "READY", bundle, blockers: Object.freeze([]), ...safetyEnvelope() });
}

// src/services/scanner-crypto-futures-paper-admission-composer.service.ts
var SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_COMPOSER_VERSION = "scanner-crypto-futures-paper-admission-composer-v1";
var DEFAULT_MAX_EVIDENCE_AGE_MS4 = 3e4;
function finite4(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function positive3(value) {
  return finite4(value) && value > 0;
}
function nonNegative3(value) {
  return finite4(value) && value >= 0;
}
function nonEmpty2(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function add4(blockers, code, condition = true) {
  if (condition && !blockers.includes(code)) blockers.push(code);
}
function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function fresh(value, nowMs, maxAgeMs) {
  return positive3(value) && value <= nowMs && nowMs - value <= maxAgeMs;
}
function safetyEnvelope2() {
  return Object.freeze({
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false
  });
}
function blocked2(blockers, partial = {}) {
  return Object.freeze({
    status: "BLOCKED",
    composerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_COMPOSER_VERSION,
    admissionResult: partial.admissionResult ?? null,
    riskInput: partial.riskInput ?? null,
    riskResult: partial.riskResult ?? null,
    paperEvidence: partial.paperEvidence ?? null,
    executionDataEvidence: partial.executionDataEvidence ?? null,
    blockers: Object.freeze([...new Set(blockers)]),
    ...safetyEnvelope2()
  });
}
function spreadPercent(bid, ask) {
  if (!positive3(bid) || !positive3(ask) || bid > ask) return null;
  const midpoint = (bid + ask) / 2;
  if (!(midpoint > 0)) return null;
  const value = (ask - bid) / midpoint * 100;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function canonicalSide(direction) {
  if (direction === "LONG") return "long";
  if (direction === "SHORT") return "short";
  return null;
}
function sameNumber(left, right) {
  return finite4(left) && finite4(right) && Math.abs(left - right) <= 1e-12;
}
function validateObservedCost(value, nowMs, maxEvidenceAgeMs, blockers) {
  add4(blockers, "P0_C5_SLIPPAGE_EVIDENCE_INVALID", !nonNegative3(value?.valuePercent));
  add4(blockers, "P0_C5_SLIPPAGE_SOURCE_REQUIRED", !nonEmpty2(value?.source));
  add4(blockers, "P0_C5_SLIPPAGE_EVIDENCE_STALE_OR_FUTURE", !fresh(value?.observedAtMs, nowMs, maxEvidenceAgeMs));
}
function composeScannerCryptoFuturesPaperAdmission(input) {
  const nowMs = input.nowMs ?? Date.now();
  const maxEvidenceAgeMs = input.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS4;
  const blockers = [];
  if (!positive3(nowMs) || !positive3(maxEvidenceAgeMs)) return blocked2(["P0_C5_EVIDENCE_CLOCK_INVALID"]);
  const signal = input.paperCandidate?.signal;
  add4(blockers, "P0_C5_CRYPTO_FUTURES_CANDIDATE_REQUIRED", signal?.market !== "CRYPTO_FUTURES");
  const side = signal ? canonicalSide(signal.direction) : null;
  add4(blockers, "P0_C5_FUTURES_DIRECTION_REQUIRED", side == null);
  add4(blockers, "P0_C5_LEARNING_SNAPSHOT_REQUIRED", !input.learningSnapshot);
  try {
    validateState(input.paperState);
  } catch {
    add4(blockers, "P0_C5_PAPER_STATE_INVALID");
  }
  add4(blockers, "P0_C5_PAPER_EQUITY_REQUIRED", !positive3(input.paperState?.account?.equity));
  const publicEvidence = input.publicEvidence;
  add4(blockers, "P0_C5_BITGET_PUBLIC_EVIDENCE_REQUIRED", publicEvidence?.provider !== "bitget" || publicEvidence?.dataQuality !== "ready");
  add4(blockers, "P0_C5_PUBLIC_SYMBOL_MISMATCH", Boolean(signal) && publicEvidence?.symbol !== signal.symbol);
  add4(blockers, "P0_C5_PUBLIC_TICKER_STALE_OR_FUTURE", !fresh(publicEvidence?.tickerTimestampMs, nowMs, maxEvidenceAgeMs));
  add4(blockers, "P0_C5_PUBLIC_OI_STALE_OR_FUTURE", !fresh(publicEvidence?.openInterestTimestampMs, nowMs, maxEvidenceAgeMs));
  add4(blockers, "P0_C5_PUBLIC_QUOTE_INVALID", !positive3(publicEvidence?.bidPrice) || !positive3(publicEvidence?.askPrice) || publicEvidence.bidPrice > publicEvidence.askPrice);
  add4(blockers, "P0_C5_PUBLIC_TAKER_FEE_INVALID", !nonNegative3(publicEvidence?.takerFeeRate));
  add4(blockers, "P0_C5_PUBLIC_CONTRACT_INVALID", !positive3(publicEvidence?.priceStep) || !positive3(publicEvidence?.minTradeNum) || !positive3(publicEvidence?.sizeMultiplier) || !positive3(publicEvidence?.minTradeUsdt) || !positive3(publicEvidence?.maxLeverage));
  const rules = input.contractRules;
  const rulesAtMs = timestamp(rules?.updatedAt ?? "");
  add4(blockers, "P0_C5_PAPER_CONTRACT_RULES_REQUIRED", rules?.status !== "live" || rules?.symbol !== signal?.symbol);
  add4(blockers, "P0_C5_PAPER_CONTRACT_RULES_STALE_OR_FUTURE", rulesAtMs == null || rulesAtMs > nowMs || nowMs - rulesAtMs > CONTRACT_FRESHNESS_MS);
  add4(blockers, "P0_C5_PAPER_CONTRACT_PRECISION_REQUIRED", !positive3(rules?.quantityStep) || !Number.isInteger(rules?.quantityPrecision) || Number(rules.quantityPrecision) < 0 || !positive3(rules?.minimumQuantity) || !positive3(rules?.minimumNotional) || !nonNegative3(rules?.maintenanceMarginRate) || Number(rules.maintenanceMarginRate) >= 1 || !positive3(rules?.maximumLeverage));
  add4(blockers, "P0_C5_PUBLIC_PAPER_CONTRACT_MISMATCH", !sameNumber(rules?.quantityStep, publicEvidence?.sizeMultiplier) || !sameNumber(rules?.minimumQuantity, publicEvidence?.minTradeNum) || !sameNumber(rules?.minimumNotional, publicEvidence?.minTradeUsdt) || !sameNumber(rules?.maximumLeverage, publicEvidence?.maxLeverage));
  const observation = input.executionObservation;
  add4(blockers, "P0_C5_PROVIDER_PROVENANCE_REQUIRED", !nonEmpty2(observation?.providerProvenance));
  validateObservedCost(observation?.slippage, nowMs, maxEvidenceAgeMs, blockers);
  add4(blockers, "P0_C5_LIQUIDITY_EVIDENCE_INVALID", !positive3(observation?.liquidity?.value));
  add4(blockers, "P0_C5_LIQUIDITY_SOURCE_REQUIRED", !nonEmpty2(observation?.liquidity?.source));
  add4(blockers, "P0_C5_LIQUIDITY_EVIDENCE_STALE_OR_FUTURE", !fresh(observation?.liquidity?.observedAtMs, nowMs, maxEvidenceAgeMs));
  add4(blockers, "P0_C5_PARTIAL_FILL_EVIDENCE_INVALID", !["NONE", "PRO_RATA", "ORDER_BOOK"].includes(observation?.partialFill?.model));
  add4(blockers, "P0_C5_PARTIAL_FILL_SOURCE_REQUIRED", !nonEmpty2(observation?.partialFill?.source));
  add4(blockers, "P0_C5_PARTIAL_FILL_EVIDENCE_STALE_OR_FUTURE", !fresh(observation?.partialFill?.observedAtMs, nowMs, maxEvidenceAgeMs));
  add4(blockers, "P0_C5_LEVERAGE_INVALID", !positive3(observation?.leverage) || positive3(rules?.maximumLeverage) && observation.leverage > rules.maximumLeverage);
  add4(blockers, "P0_C5_RISK_PERCENT_INVALID", !positive3(observation?.riskPercent) || observation.riskPercent > 1);
  add4(blockers, "P0_C5_MARGIN_MODE_REQUIRED", observation?.marginMode !== "isolated" && observation?.marginMode !== "cross");
  add4(blockers, "P0_C5_COST_POLICY_ID_MISMATCH", input.supplementalCostEvidence?.costPolicyId !== signal?.strategyIdentity?.costPolicyVersion);
  const entryPrice = input.learningSnapshot?.entryPrice;
  const stopLoss = input.learningSnapshot?.stopLoss;
  add4(blockers, "P0_C5_LEARNING_ENTRY_PRICE_REQUIRED", !positive3(entryPrice));
  add4(blockers, "P0_C5_LEARNING_STOP_LOSS_REQUIRED", !positive3(stopLoss));
  if (side === "long" && positive3(entryPrice) && positive3(stopLoss)) add4(blockers, "P0_C5_LEARNING_STOP_DIRECTION_INVALID", stopLoss >= entryPrice);
  if (side === "short" && positive3(entryPrice) && positive3(stopLoss)) add4(blockers, "P0_C5_LEARNING_STOP_DIRECTION_INVALID", stopLoss <= entryPrice);
  const spread = spreadPercent(publicEvidence?.bidPrice, publicEvidence?.askPrice);
  add4(blockers, "P0_C5_SPREAD_EVIDENCE_INVALID", spread == null);
  if (blockers.length > 0 || !signal || !side || !positive3(entryPrice) || !positive3(stopLoss) || spread == null) {
    return blocked2(blockers);
  }
  const marketData = Object.freeze({
    symbol: signal.symbol,
    price: publicEvidence.lastPrice,
    lastPrice: publicEvidence.lastPrice,
    markPrice: publicEvidence.markPrice,
    bidPrice: publicEvidence.bidPrice,
    askPrice: publicEvidence.askPrice,
    fundingRate: publicEvidence.fundingRate,
    status: "live",
    updatedAt: new Date(publicEvidence.tickerTimestampMs).toISOString(),
    warnings: []
  });
  const request = validateOrderRequest({
    symbol: signal.symbol,
    side,
    orderType: "market",
    leverage: observation.leverage,
    stopLossPrice: stopLoss,
    takeProfitPrice1: input.learningSnapshot.target1,
    takeProfitPrice2: input.learningSnapshot.target2,
    strategyName: signal.strategyIdentity.strategyId
  });
  const suppliedRisk = {
    market: "crypto-futures",
    symbol: signal.symbol,
    side,
    accountBalance: input.paperState.account.equity,
    entryPrice,
    stopLossPrice: stopLoss,
    targetPrice1: input.learningSnapshot.target1,
    targetPrice2: input.learningSnapshot.target2,
    leverage: observation.leverage,
    riskPercent: observation.riskPercent,
    entryFeeRate: publicEvidence.takerFeeRate,
    exitFeeRate: publicEvidence.takerFeeRate,
    slippageRate: observation.slippage.valuePercent / 100,
    estimatedFundingRate: publicEvidence.fundingRate,
    dataStatus: "live"
  };
  const now = new Date(nowMs);
  const riskInput = buildRiskInput(
    input.paperState,
    request,
    marketData,
    rules,
    suppliedRisk,
    entryPrice,
    now
  );
  const riskResult = calculateTradingRisk(riskInput, now);
  if (!riskResult.allowed || !positive3(riskResult.recommendedQuantity)) {
    return blocked2(["P0_C5_RISK_ENGINE_NOT_APPROVED", ...riskResult.blockCodes], { riskInput, riskResult });
  }
  const liquidationPrice = riskResult.estimatedLiquidationPrice;
  const liquidationDistancePercent = positive3(liquidationPrice) ? Math.abs(entryPrice - liquidationPrice) / entryPrice * 100 : null;
  if (!positive3(liquidationDistancePercent)) {
    return blocked2(["P0_C5_LIQUIDATION_DISTANCE_NOT_EVIDENCED"], { riskInput, riskResult });
  }
  const paperEvidence = Object.freeze({
    market: "CRYPTO_FUTURES",
    provider: "bitget",
    providerProvenance: observation.providerProvenance,
    direction: signal.direction,
    observedAtMs: publicEvidence.tickerTimestampMs,
    costPolicyVersion: signal.strategyIdentity.costPolicyVersion,
    feePercent: publicEvidence.takerFeeRate * 100,
    spreadPercent: spread,
    slippagePercent: observation.slippage.valuePercent,
    tickSize: publicEvidence.priceStep,
    liquidity: observation.liquidity.value,
    partialFillModel: observation.partialFill.model,
    minimumOrderQuantity: rules.minimumQuantity,
    quantityStep: rules.quantityStep,
    quantityPrecision: rules.quantityPrecision,
    markPrice: publicEvidence.markPrice,
    fundingRate: publicEvidence.fundingRate,
    leverage: observation.leverage,
    marginMode: observation.marginMode,
    liquidationDistancePercent
  });
  const executionDataEvidence = Object.freeze({
    provider: "bitget",
    provenance: observation.providerProvenance,
    publicOnly: true,
    dataQuality: "READY",
    asOfMs: publicEvidence.tickerTimestampMs,
    maxAgeMs: maxEvidenceAgeMs,
    tickSize: publicEvidence.priceStep,
    barProxyRealtimeAllowed: false,
    quoteEvidence: Object.freeze({
      available: true,
      bid: publicEvidence.bidPrice,
      ask: publicEvidence.askPrice,
      last: publicEvidence.lastPrice,
      asOfMs: publicEvidence.tickerTimestampMs,
      maxAgeMs: maxEvidenceAgeMs
    }),
    contractStatus: "TRADABLE",
    minQty: rules.minimumQuantity,
    qtyStep: rules.quantityStep,
    quantityPrecision: rules.quantityPrecision,
    markPrice: publicEvidence.markPrice,
    indexPrice: publicEvidence.indexPrice,
    fundingRate: publicEvidence.fundingRate,
    openInterest: publicEvidence.openInterest,
    leverage: observation.leverage,
    maxLeverage: rules.maximumLeverage,
    marginMode: observation.marginMode.toUpperCase(),
    liquidationDistancePct: liquidationDistancePercent,
    privateApiUsed: false,
    privateTradingApiAllowed: false,
    liveOrderAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false
  });
  const admissionResult = buildScannerCanonicalPaperAdmissionEvidence({
    paperCandidate: input.paperCandidate,
    learningSnapshot: input.learningSnapshot,
    riskInput,
    riskResult,
    paperEvidence,
    supplementalCostEvidence: input.supplementalCostEvidence,
    executionDataEvidence,
    nowMs,
    maxEvidenceAgeMs
  });
  if (admissionResult.status !== "READY") {
    return blocked2([...admissionResult.blockers], {
      admissionResult,
      riskInput,
      riskResult,
      paperEvidence,
      executionDataEvidence
    });
  }
  return Object.freeze({
    status: "READY",
    composerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_COMPOSER_VERSION,
    admissionResult,
    riskInput,
    riskResult,
    paperEvidence,
    executionDataEvidence,
    blockers: Object.freeze([]),
    ...safetyEnvelope2()
  });
}

// src/services/scanner-crypto-futures-paper-admission-evidence-producer.service.ts
var SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION = "scanner-crypto-futures-paper-admission-evidence-producer-v1";
var SOURCE_KEYS = Object.freeze([
  "paperCandidate",
  "learningSnapshot",
  "paperState",
  "contractRules",
  "publicEvidence",
  "executionObservation",
  "supplementalCostEvidence"
]);
function finite5(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function positive4(value) {
  return finite5(value) && value > 0;
}
function nonNegative4(value) {
  return finite5(value) && value >= 0;
}
function safetyEnvelope3() {
  return Object.freeze({
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false
  });
}
function blocked3(blockers, composerStatus = null) {
  return Object.freeze({
    status: "BLOCKED",
    producerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
    bundle: null,
    blockers: Object.freeze([...new Set(blockers)]),
    composerStatus,
    ...safetyEnvelope3()
  });
}
function validBundleSafety(bundle) {
  return bundle.schemaVersion === SCANNER_PAPER_ADMISSION_BUNDLE_VERSION && bundle.executionAuthority === "NONE" && bundle.simulatedOnly === true && bundle.liveOrderAllowed === false && bundle.privateTradingApiAllowed === false && bundle.orderSubmitted === false && bundle.exchangeRequestSent === false && bundle.productionMutationAllowed === false;
}
function riskCostParityBlockers(composition, nowMs, recalculateRisk) {
  const bundle = composition.admissionResult?.bundle;
  const riskInput = composition.riskInput;
  const originalQuantity = composition.riskResult?.recommendedQuantity;
  const costPolicy = bundle?.executionEvidence?.costPolicy;
  if (!riskInput || !positive4(originalQuantity) || !costPolicy) {
    return ["P0_C9_RISK_COST_PARITY_EVIDENCE_REQUIRED"];
  }
  const executionRates = [
    costPolicy.spreadRate,
    costPolicy.slippageRate,
    costPolicy.latencyRate,
    costPolicy.liquidityImpactRate,
    costPolicy.partialFillImpactRate
  ];
  if (!executionRates.every(nonNegative4)) {
    return ["P0_C9_RISK_COST_PARITY_EVIDENCE_INVALID"];
  }
  const conservativeExecutionRate = executionRates.reduce((sum, value) => sum + value, 0);
  const parityInput = Object.freeze({ ...riskInput, slippageRate: conservativeExecutionRate });
  const parityResult = recalculateRisk(parityInput, new Date(nowMs));
  if (!parityResult.allowed || !positive4(parityResult.recommendedQuantity)) {
    return [
      "P0_C9_RISK_COST_PARITY_BLOCKED",
      ...Array.isArray(parityResult.blockCodes) ? parityResult.blockCodes : []
    ];
  }
  const tolerance = Math.max(1e-12, originalQuantity * 1e-12);
  if (parityResult.recommendedQuantity + tolerance < originalQuantity) {
    return ["P0_C9_RISK_COST_PARITY_MISMATCH"];
  }
  return [];
}
function assertSources(sources) {
  if (!sources || typeof sources !== "object") {
    throw new TypeError("authoritative Crypto Futures Paper evidence sources are required");
  }
  for (const key of SOURCE_KEYS) {
    if (typeof sources[key] !== "function") {
      throw new TypeError(`authoritative Paper evidence source is required: ${key}`);
    }
  }
}
function createScannerCryptoFuturesPaperAdmissionEvidenceProducer({
  sources,
  compose = composeScannerCryptoFuturesPaperAdmission,
  recalculateRisk = calculateTradingRisk,
  now = Date.now,
  maxEvidenceAgeMs
}) {
  assertSources(sources);
  if (typeof compose !== "function") throw new TypeError("Paper admission composer is required");
  if (typeof recalculateRisk !== "function") throw new TypeError("Trading Risk Engine parity recalculator is required");
  if (typeof now !== "function") throw new TypeError("Paper admission evidence clock is required");
  if (maxEvidenceAgeMs != null && (!finite5(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0)) {
    throw new TypeError("positive maxEvidenceAgeMs is required when provided");
  }
  return async function produceScannerCryptoFuturesPaperAdmissionEvidence({
    card,
    market,
    cycle,
    signal
  }) {
    if (market !== "CRYPTO_FUTURES") {
      return blocked3(["P0_C9_MARKET_NOT_OWNED"]);
    }
    const nowMs = now();
    if (!finite5(nowMs) || nowMs <= 0) return blocked3(["P0_C9_EVIDENCE_CLOCK_INVALID"]);
    const context = Object.freeze({
      card,
      market,
      cycle,
      signal
    });
    let input;
    try {
      const paperCandidate = await sources.paperCandidate(context);
      const learningSnapshot = await sources.learningSnapshot(context);
      const paperState = await sources.paperState(context);
      const contractRules = await sources.contractRules(context);
      const publicEvidence = await sources.publicEvidence(context);
      const executionObservation = await sources.executionObservation(context);
      const supplementalCostEvidence = await sources.supplementalCostEvidence(context);
      if ([
        paperCandidate,
        learningSnapshot,
        paperState,
        contractRules,
        publicEvidence,
        executionObservation,
        supplementalCostEvidence
      ].some((value) => value == null)) {
        return blocked3(["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING"]);
      }
      input = {
        paperCandidate,
        learningSnapshot,
        paperState,
        contractRules,
        publicEvidence,
        executionObservation,
        supplementalCostEvidence,
        nowMs,
        ...maxEvidenceAgeMs == null ? {} : { maxEvidenceAgeMs }
      };
    } catch {
      return blocked3(["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED"]);
    }
    let composition;
    try {
      composition = compose(input);
    } catch {
      return blocked3(["P0_C9_ADMISSION_COMPOSER_FAILED"]);
    }
    if (composition.status !== "READY" || composition.admissionResult?.status !== "READY" || !composition.admissionResult.bundle) {
      return blocked3([
        "P0_C9_ADMISSION_COMPOSER_BLOCKED",
        ...composition.blockers ?? [],
        ...composition.admissionResult?.blockers ?? []
      ], composition.status);
    }
    const bundle = composition.admissionResult.bundle;
    if (!validBundleSafety(bundle)) {
      return blocked3(["P0_C9_CANONICAL_ADMISSION_BUNDLE_INVALID"], composition.status);
    }
    const parityBlockers = riskCostParityBlockers(composition, nowMs, recalculateRisk);
    if (parityBlockers.length > 0) return blocked3(parityBlockers, composition.status);
    return Object.freeze({
      status: "READY",
      producerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
      bundle,
      blockers: Object.freeze([]),
      composerStatus: composition.status,
      ...safetyEnvelope3()
    });
  };
}

// src/services/paper-trading-state-snapshot.service.ts
import { createHash as createHash2 } from "node:crypto";
var PAPER_TRADING_STATE_SNAPSHOT_VERSION = "paper-trading-state-snapshot-v1";
function finite6(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function nonEmpty3(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function deepFreeze2(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze2(nested);
  }
  return value;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function stateDigest(state) {
  return createHash2("sha256").update(canonicalJson(state)).digest("hex");
}
function assertSnapshotState(state, nowMs, maximumAgeMs) {
  validateState(state);
  if (!nonEmpty3(state.account.id)) throw new Error("PAPER_STATE_ACCOUNT_ID_REQUIRED");
  if (!finite6(state.account.equity) || state.account.equity <= 0) {
    throw new Error("PAPER_STATE_EQUITY_REQUIRED");
  }
  if (!state.riskState || [
    state.riskState.dailyRealizedPnl,
    state.riskState.weeklyRealizedPnl,
    state.riskState.consecutiveLosses
  ].some((value) => !finite6(value))) {
    throw new Error("PAPER_STATE_RISK_STATE_REQUIRED");
  }
  if (!Array.isArray(state.processedEventIds)) throw new Error("PAPER_STATE_EVENT_IDS_REQUIRED");
  for (const position of state.positions) {
    if (!finite6(position.notionalValue) || position.notionalValue < 0) {
      throw new Error("PAPER_STATE_POSITION_EXPOSURE_REQUIRED");
    }
  }
  const stateUpdatedAtMs = Date.parse(state.updatedAt);
  if (!finite6(stateUpdatedAtMs) || stateUpdatedAtMs <= 0 || stateUpdatedAtMs > nowMs) {
    throw new Error("PAPER_STATE_TIMESTAMP_INVALID");
  }
  if (nowMs - stateUpdatedAtMs > maximumAgeMs) throw new Error("PAPER_STATE_STALE");
  return stateUpdatedAtMs;
}
function createImmutablePaperTradingStateSnapshot({
  state,
  sourceOwner,
  provenance,
  observedAtMs = Date.now(),
  maximumAgeMs = 3e4
}) {
  if (!finite6(observedAtMs) || observedAtMs <= 0) throw new Error("PAPER_STATE_OBSERVED_AT_INVALID");
  if (!finite6(maximumAgeMs) || maximumAgeMs <= 0) throw new Error("PAPER_STATE_MAXIMUM_AGE_INVALID");
  if (!nonEmpty3(sourceOwner)) throw new Error("PAPER_STATE_SOURCE_OWNER_REQUIRED");
  if (!Array.isArray(provenance) || provenance.length === 0 || provenance.some((value) => !nonEmpty3(value))) {
    throw new Error("PAPER_STATE_PROVENANCE_REQUIRED");
  }
  const clonedState = cloneJson(state);
  const stateUpdatedAtMs = assertSnapshotState(clonedState, observedAtMs, maximumAgeMs);
  const openPositionCount = clonedState.positions.filter((position) => position.status !== "closed").length;
  return deepFreeze2({
    schemaVersion: PAPER_TRADING_STATE_SNAPSHOT_VERSION,
    paperStateSchemaVersion: clonedState.schemaVersion,
    sourceOwner: sourceOwner.trim(),
    provenance: [...provenance],
    observedAtMs,
    stateUpdatedAtMs,
    maximumAgeMs,
    accountId: clonedState.account.id,
    equity: clonedState.account.equity,
    openPositionCount,
    stateDigestSha256: stateDigest(clonedState),
    state: clonedState,
    immutable: true,
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false
  });
}
function validateImmutablePaperTradingStateSnapshot(value, nowMs = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PAPER_STATE_SNAPSHOT_REQUIRED");
  }
  const snapshot = cloneJson(value);
  if (snapshot.schemaVersion !== PAPER_TRADING_STATE_SNAPSHOT_VERSION || snapshot.paperStateSchemaVersion !== 1 || snapshot.immutable !== true || snapshot.executionAuthority !== "NONE" || snapshot.privateApiAllowed !== false || snapshot.liveTrading !== false || snapshot.financialMutationAllowed !== false) {
    throw new Error("PAPER_STATE_SNAPSHOT_CONTRACT_INVALID");
  }
  const rebuilt = createImmutablePaperTradingStateSnapshot({
    state: snapshot.state,
    sourceOwner: snapshot.sourceOwner,
    provenance: snapshot.provenance,
    observedAtMs: snapshot.observedAtMs,
    maximumAgeMs: snapshot.maximumAgeMs
  });
  if (!finite6(nowMs) || nowMs < rebuilt.observedAtMs || nowMs - rebuilt.stateUpdatedAtMs > rebuilt.maximumAgeMs) {
    throw new Error("PAPER_STATE_SNAPSHOT_STALE_OR_FUTURE");
  }
  if (snapshot.stateUpdatedAtMs !== rebuilt.stateUpdatedAtMs || snapshot.accountId !== rebuilt.accountId || snapshot.equity !== rebuilt.equity || snapshot.openPositionCount !== rebuilt.openPositionCount || snapshot.stateDigestSha256 !== rebuilt.stateDigestSha256) {
    throw new Error("PAPER_STATE_SNAPSHOT_DIGEST_MISMATCH");
  }
  return rebuilt;
}

// src/services/authoritative-paper-runtime-package.entry.ts
var AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_SAFETY = Object.freeze({
  schemaVersion: "authoritative-paper-runtime-package-safety-v1",
  executionAuthority: "NONE",
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false
});
export {
  AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_SAFETY,
  PAPER_TRADING_STATE_SNAPSHOT_VERSION,
  SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
  createImmutablePaperTradingStateSnapshot,
  createScannerCryptoFuturesPaperAdmissionEvidenceProducer,
  validateImmutablePaperTradingStateSnapshot
};
