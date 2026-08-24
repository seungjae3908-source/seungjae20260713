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
  const text3 = value.toString().toLowerCase();
  if (text3.includes("e-")) return Math.min(12, Number(text3.split("e-")[1] ?? 0));
  return Math.min(12, text3.includes(".") ? text3.split(".")[1]?.length ?? 0 : 0);
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
    const positive7 = input.estimatedFundingRate > 0;
    const likelyPays = positive7 && input.side === "long" || !positive7 && input.side === "short";
    warnings.push(
      `${positive7 ? "양(+)" : "음(-)"} 펀딩 기준으로 ${input.side === "long" ? "롱" : "숏"} 포지션은 ${likelyPays ? "지급 가능성" : "수취 가능성"}이 있으나, 최대 손실 계산에서는 보수적으로 비용으로 반영했습니다.`
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
  const timestamp4 = Date.parse(updatedAt);
  return Number.isFinite(timestamp4) && now.getTime() >= timestamp4 && now.getTime() - timestamp4 <= limitMs;
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
  const canonicalMarket2 = market;
  if (evidence.provider !== EXPECTED_PROVIDER[canonicalMarket2]) add(blockers, "PROVIDER_MISMATCH");
  if (!nonEmptyString(evidence.providerProvenance)) add(blockers, "PROVIDER_PROVENANCE_REQUIRED");
  const direction = evidence.direction;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction)) {
    add(blockers, "DIRECTION_UNSUPPORTED");
  } else if (canonicalMarket2 === "CRYPTO_FUTURES") {
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
  if (canonicalMarket2 === "KR_STOCK" || canonicalMarket2 === "US_STOCK") {
    if (!nonEmptyString(evidence.sessionCalendarVersion)) add(blockers, "SESSION_CALENDAR_VERSION_REQUIRED");
    if (evidence.marketStatus !== "OPEN") add(blockers, "MARKET_NOT_OPEN");
    if (!nonEmptyString(evidence.taxPolicyVersion)) add(blockers, "TAX_POLICY_VERSION_REQUIRED");
    if (!finiteNonNegative(evidence.taxPercent)) add(blockers, "TAX_PERCENT_INVALID");
  } else if (canonicalMarket2 === "CRYPTO_SPOT") {
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
function observationId(card, signal) {
  const values = [
    signal?.signalId,
    card?.signalId,
    card?.id,
    card?.paperCandidate?.signal?.signalId
  ];
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  return typeof value === "string" ? value.trim() : null;
}
function gateObservation({
  status = "UNKNOWN",
  evaluated = false,
  passed = null,
  decision: decision2 = "UNKNOWN",
  provenance,
  observedAt = null,
  observationId: id = null,
  sourceCodes = []
}) {
  const measured = status === "MEASURED";
  return Object.freeze({
    status: measured ? "MEASURED" : "UNKNOWN",
    evaluated: measured && evaluated,
    passed: measured && typeof passed === "boolean" ? passed : null,
    decision: measured ? decision2 : "UNKNOWN",
    provenance,
    observedAt: finite5(observedAt) && observedAt > 0 ? observedAt : null,
    observationId: typeof id === "string" && id.length > 0 ? id : null,
    sourceCodes: Object.freeze([...new Set(sourceCodes.filter((code) => typeof code === "string" && code.length > 0))])
  });
}
function reasonObservations({
  sourceStage,
  sourceCodes,
  canonicalReason,
  lossless,
  provenance,
  observedAt,
  observationId: id
}) {
  return Object.freeze([...new Set(sourceCodes)].map((sourceCode) => Object.freeze({
    sourceStage,
    sourceCode,
    sourceReason: sourceCode,
    canonicalReason,
    lossless,
    provenance,
    observedAt: finite5(observedAt) && observedAt > 0 ? observedAt : null,
    identity: Object.freeze({ observationId: id }),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0
  })));
}
function gateObservability({
  qualityGate,
  riskGate,
  reasonObservations: reasons = []
}) {
  return Object.freeze({
    schemaVersion: "scanner-crypto-futures-paper-gate-observability-v1",
    qualityGate,
    riskGate,
    reasonObservations: Object.freeze([...reasons])
  });
}
function unknownGateObservability(sourceCodes = [], observedAt = null, id = null, sourceStage = "EVIDENCE_SOURCE", canonicalReason = "UNKNOWN", lossless = false) {
  return gateObservability({
    qualityGate: gateObservation({ provenance: "scanner admission Quality gate was not evaluated", observedAt, observationId: id }),
    riskGate: gateObservation({ provenance: "Trading Risk Engine was not evaluated", observedAt, observationId: id }),
    reasonObservations: reasonObservations({
      sourceStage,
      sourceCodes,
      canonicalReason,
      lossless,
      provenance: "scanner-crypto-futures-paper-admission-evidence-producer-v1",
      observedAt,
      observationId: id
    })
  });
}
function compositionGateObservability(composition, observedAt, id) {
  const qualityPassed = Boolean(composition.riskInput && composition.riskResult);
  const riskEvaluated = Boolean(composition.riskResult);
  const riskPassed = Boolean(composition.riskResult?.allowed && positive4(composition.riskResult?.recommendedQuantity));
  const qualityCodes = qualityPassed ? [] : [...composition.blockers ?? []];
  const riskCodes = riskEvaluated && !riskPassed ? [...composition.riskResult?.blockCodes ?? [], ...composition.blockers ?? []] : [];
  return gateObservability({
    qualityGate: gateObservation({
      status: "MEASURED",
      evaluated: true,
      passed: qualityPassed,
      decision: qualityPassed ? "PASS" : "BLOCKED",
      provenance: "scanner-crypto-futures-paper-admission-composer.service.ts pre-risk validation outcome",
      observedAt,
      observationId: id,
      sourceCodes: qualityCodes
    }),
    riskGate: gateObservation({
      status: "MEASURED",
      evaluated: riskEvaluated,
      passed: riskPassed,
      decision: riskEvaluated ? riskPassed ? "PASS" : "BLOCKED" : "NOT_REACHED",
      provenance: riskEvaluated ? "scanner-crypto-futures-paper-admission-composer.service.ts riskResult" : "Trading Risk Engine not reached after measured Quality block",
      observedAt,
      observationId: id,
      sourceCodes: riskCodes
    }),
    reasonObservations: [
      ...reasonObservations({
        sourceStage: "QUALITY_GATE",
        sourceCodes: qualityCodes,
        canonicalReason: "QUALITY_GATE",
        lossless: true,
        provenance: "scanner-crypto-futures-paper-admission-composer.service.ts pre-risk blockers",
        observedAt,
        observationId: id
      }),
      ...reasonObservations({
        sourceStage: "RISK_GATE",
        sourceCodes: riskCodes,
        canonicalReason: "RISK_GATE",
        lossless: true,
        provenance: "scanner-crypto-futures-paper-admission-composer.service.ts riskResult.blockCodes",
        observedAt,
        observationId: id
      })
    ]
  });
}
function withFinalRiskBlock(observability, blockers) {
  const risk = observability.riskGate;
  return gateObservability({
    qualityGate: observability.qualityGate,
    riskGate: gateObservation({
      status: "MEASURED",
      evaluated: true,
      passed: false,
      decision: "BLOCKED",
      provenance: "scanner-crypto-futures-paper-admission-evidence-producer-v1 final risk-cost parity decision",
      observedAt: risk.observedAt,
      observationId: risk.observationId,
      sourceCodes: blockers
    }),
    reasonObservations: [
      ...observability.reasonObservations,
      ...reasonObservations({
        sourceStage: "RISK_GATE",
        sourceCodes: blockers,
        canonicalReason: "RISK_GATE",
        lossless: true,
        provenance: "scanner-crypto-futures-paper-admission-evidence-producer-v1 final risk-cost parity decision",
        observedAt: risk.observedAt,
        observationId: risk.observationId
      })
    ]
  });
}
function blocked3(blockers, composerStatus = null, observability = unknownGateObservability(blockers)) {
  return Object.freeze({
    status: "BLOCKED",
    producerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
    bundle: null,
    blockers: Object.freeze([...new Set(blockers)]),
    composerStatus,
    gateObservability: observability,
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
    const id = observationId(card, signal);
    if (market !== "CRYPTO_FUTURES") {
      return blocked3(["P0_C9_MARKET_NOT_OWNED"], null, unknownGateObservability(
        ["P0_C9_MARKET_NOT_OWNED"],
        null,
        id,
        "EVIDENCE_SOURCE",
        "UNKNOWN",
        false
      ));
    }
    const nowMs = now();
    if (!finite5(nowMs) || nowMs <= 0) return blocked3(["P0_C9_EVIDENCE_CLOCK_INVALID"], null, unknownGateObservability(
      ["P0_C9_EVIDENCE_CLOCK_INVALID"],
      null,
      id,
      "EVIDENCE_SOURCE",
      "UNKNOWN",
      false
    ));
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
        return blocked3(["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING"], null, unknownGateObservability(
          ["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING"],
          nowMs,
          id,
          "EVIDENCE_SOURCE",
          "DATA_MISSING",
          true
        ));
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
      return blocked3(["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED"], null, unknownGateObservability(
        ["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED"],
        nowMs,
        id,
        "EVIDENCE_SOURCE",
        "UNKNOWN",
        false
      ));
    }
    let composition;
    try {
      composition = compose(input);
    } catch {
      return blocked3(["P0_C9_ADMISSION_COMPOSER_FAILED"], null, unknownGateObservability(
        ["P0_C9_ADMISSION_COMPOSER_FAILED"],
        nowMs,
        id,
        "PAPER_ADMISSION",
        "UNKNOWN",
        false
      ));
    }
    const observedGates = compositionGateObservability(composition, nowMs, id);
    if (composition.status !== "READY" || composition.admissionResult?.status !== "READY" || !composition.admissionResult.bundle) {
      return blocked3([
        "P0_C9_ADMISSION_COMPOSER_BLOCKED",
        ...composition.blockers ?? [],
        ...composition.admissionResult?.blockers ?? []
      ], composition.status, observedGates);
    }
    const bundle = composition.admissionResult.bundle;
    if (!validBundleSafety(bundle)) {
      return blocked3(["P0_C9_CANONICAL_ADMISSION_BUNDLE_INVALID"], composition.status, observedGates);
    }
    const parityBlockers = riskCostParityBlockers(composition, nowMs, recalculateRisk);
    if (parityBlockers.length > 0) {
      return blocked3(parityBlockers, composition.status, withFinalRiskBlock(observedGates, parityBlockers));
    }
    return Object.freeze({
      status: "READY",
      producerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
      bundle,
      blockers: Object.freeze([]),
      composerStatus: composition.status,
      gateObservability: observedGates,
      ...safetyEnvelope3()
    });
  };
}

// src/services/paper-trading-state-snapshot.service.ts
import { createHash as createHash2 } from "node:crypto";
var PAPER_TRADING_STATE_SNAPSHOT_VERSION = "paper-trading-state-snapshot-v2";
function finite6(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function nonEmpty3(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}
function sha256Digest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
function canonicalMarket(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,39}$/u.test(value);
}
function canonicalCurrency(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9]{1,11}$/u.test(value);
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
  sourceSha,
  market,
  currency,
  provenance,
  publisherAccountIdSha256,
  observedAtMs = Date.now(),
  maximumAgeMs = 3e4
}) {
  if (!finite6(observedAtMs) || observedAtMs <= 0) throw new Error("PAPER_STATE_OBSERVED_AT_INVALID");
  if (!finite6(maximumAgeMs) || maximumAgeMs <= 0) throw new Error("PAPER_STATE_MAXIMUM_AGE_INVALID");
  if (!nonEmpty3(sourceOwner)) throw new Error("PAPER_STATE_SOURCE_OWNER_REQUIRED");
  if (!immutableSha(sourceSha)) throw new Error("PAPER_STATE_SOURCE_SHA_REQUIRED");
  if (!canonicalMarket(market)) throw new Error("PAPER_STATE_MARKET_REQUIRED");
  if (!canonicalCurrency(currency)) throw new Error("PAPER_STATE_CURRENCY_REQUIRED");
  if (!sha256Digest(publisherAccountIdSha256)) {
    throw new Error("PAPER_STATE_PUBLISHER_ACCOUNT_BINDING_REQUIRED");
  }
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
    sourceSha,
    market,
    currency,
    provenance: [...provenance],
    publisherAccountIdSha256,
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
    sourceSha: snapshot.sourceSha,
    market: snapshot.market,
    currency: snapshot.currency,
    provenance: snapshot.provenance,
    publisherAccountIdSha256: snapshot.publisherAccountIdSha256,
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

// src/services/crypto-signal-scanner.service.ts
import { createHash as createHash4, randomUUID } from "node:crypto";

// src/lib/bounded-work-pool.ts
var BoundedWorkTimeoutError = class extends Error {
  constructor(timeoutMs) {
    super(`Bounded work item exceeded ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
    this.name = "BoundedWorkTimeoutError";
  }
};
function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
async function runWithTimeout(task, controller, timeoutMs) {
  let timer;
  let removeAbortListener;
  const aborted = new Promise((_resolve, reject) => {
    const onAbort = () => reject(
      controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Bounded work item aborted")
    );
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([
      task,
      aborted,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new BoundedWorkTimeoutError(timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}
async function runBoundedWorkPool(items, worker, options) {
  const concurrency = Math.min(
    positiveInteger(options.concurrency, "concurrency"),
    Math.max(items.length, 1)
  );
  const deadlineMs = positiveInteger(options.deadlineMs, "deadlineMs");
  const itemTimeoutMs = positiveInteger(options.itemTimeoutMs, "itemTimeoutMs");
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  const outcomes = [];
  const activeControllers = /* @__PURE__ */ new Set();
  let nextIndex = 0;
  let activeCount = 0;
  let maxConcurrency = 0;
  let deadlineExhausted = false;
  const abortActive = () => {
    for (const controller of activeControllers) {
      if (!controller.signal.aborted) controller.abort(options.signal?.reason);
    }
  };
  options.signal?.addEventListener("abort", abortActive, { once: true });
  const takeNext = () => {
    if (deadlineExhausted || options.signal?.aborted || nextIndex >= items.length || now() >= deadlineAt) {
      return null;
    }
    const index = nextIndex;
    nextIndex += 1;
    return index;
  };
  const runWorker = async () => {
    while (true) {
      const index = takeNext();
      if (index == null) return;
      const itemStartedAt = now();
      const remainingMs = Math.max(1, deadlineAt - itemStartedAt);
      const timeoutMs = Math.min(itemTimeoutMs, remainingMs);
      const controller = new AbortController();
      let retireLane = false;
      activeControllers.add(controller);
      activeCount += 1;
      maxConcurrency = Math.max(maxConcurrency, activeCount);
      try {
        const value = await runWithTimeout(
          worker(items[index], index, controller.signal),
          controller,
          timeoutMs
        );
        outcomes.push({
          index,
          status: "fulfilled",
          value,
          elapsedMs: Math.max(0, now() - itemStartedAt)
        });
      } catch (reason) {
        const timedOut = reason instanceof BoundedWorkTimeoutError;
        if (timedOut) {
          retireLane = true;
          if (timeoutMs === remainingMs) deadlineExhausted = true;
        }
        outcomes.push({
          index,
          status: timedOut ? "timed_out" : "rejected",
          reason,
          elapsedMs: Math.max(0, now() - itemStartedAt)
        });
      } finally {
        activeCount -= 1;
        activeControllers.delete(controller);
      }
      if (retireLane) return;
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  } finally {
    options.signal?.removeEventListener("abort", abortActive);
    abortActive();
  }
  outcomes.sort((left, right) => left.index - right.index);
  const elapsedMs = Math.max(0, now() - startedAt);
  const fulfilledCount = outcomes.filter((item) => item.status === "fulfilled").length;
  const rejectedCount = outcomes.filter((item) => item.status === "rejected").length;
  const timedOutCount = outcomes.filter((item) => item.status === "timed_out").length;
  return {
    outcomes,
    startedCount: outcomes.length,
    fulfilledCount,
    rejectedCount,
    timedOutCount,
    deadlineReached: deadlineExhausted || nextIndex < items.length || elapsedMs >= deadlineMs,
    aborted: options.signal?.aborted === true,
    elapsedMs,
    maxConcurrency
  };
}

// src/services/scanner-signal-lifecycle.service.ts
import { createHash as createHash3 } from "node:crypto";
var records = /* @__PURE__ */ new Map();
var RECORD_TTL_MS = 7 * 24 * 60 * 6e4;
var SCANNER_TERMINAL_STATES = /* @__PURE__ */ new Set([
  "INVALIDATED",
  "EXPIRED",
  "REJECTED",
  "CANCELLED",
  "CLOSED"
]);
var ORDER_OWNED_STATES = /* @__PURE__ */ new Set([
  "APPROVED",
  "EXECUTING",
  "PARTIALLY_FILLED",
  "FILLED",
  "MANAGING",
  "CLOSED",
  "REJECTED",
  "CANCELLED"
]);
function alertKey(signalId2, expiresAt) {
  return `scanner-alert:${createHash3("sha256").update(`${signalId2}:APPROVAL_PENDING:${expiresAt}`).digest("hex").slice(0, 32)}`;
}
function lifecycleKey(memberId, baseSignalId) {
  return `${memberId}:${baseSignalId}`;
}
function invalid(card) {
  return card.dataState === "unavailable" || card.dataState === "untrusted" || card.dataQuality?.state === "DATA_UNTRUSTED" || card.dataQuality?.strongSignalAllowed === false || card.riskScore != null && card.riskScore >= 80 || card.listingStatus === "UNKNOWN" && card.dataState !== "complete";
}
function insideEntryZone(card) {
  const zone = card.pricePlan.entryZone;
  if (!zone || !Number.isFinite(card.price)) return false;
  const low = Math.min(zone.from, zone.to);
  const high = Math.max(zone.from, zone.to);
  return card.price >= low && card.price <= high;
}
function normalizedPrevious(previous) {
  if (previous === "DETECTED") return "CANDIDATE";
  if (previous === "WATCHING") return "CONFIRMED";
  if (previous === "READY_FOR_APPROVAL") return "APPROVAL_PENDING";
  if (previous === "WEAKENED") return "INVALIDATED";
  return previous;
}
function nextState(previousState, card, now) {
  const previous = normalizedPrevious(previousState);
  if (Date.parse(card.expiresAt) <= now) return "EXPIRED";
  if (previous && ORDER_OWNED_STATES.has(previous)) return previous;
  if (invalid(card)) return "INVALIDATED";
  if (!card.strongSignalEligible) {
    return previous && ["CONFIRMED", "ARMED", "ENTRY_ZONE", "APPROVAL_PENDING"].includes(previous) ? "INVALIDATED" : "CANDIDATE";
  }
  if (previous == null || previous === "INVALIDATED" || previous === "EXPIRED") return "CANDIDATE";
  if (previous === "CANDIDATE") return "CONFIRMED";
  if (previous === "CONFIRMED") return "ARMED";
  if (previous === "ARMED") return insideEntryZone(card) ? "ENTRY_ZONE" : "ARMED";
  if (previous === "ENTRY_ZONE") return insideEntryZone(card) ? "APPROVAL_PENDING" : "ARMED";
  if (previous === "APPROVAL_PENDING") return insideEntryZone(card) ? "APPROVAL_PENDING" : "ARMED";
  return "CANDIDATE";
}
function alertFrom(card, idempotencyKey) {
  return {
    idempotencyKey,
    signalId: card.signalId,
    assetClass: card.assetClass,
    market: card.market,
    symbol: card.symbol,
    direction: card.direction,
    state: "APPROVAL_PENDING",
    entryZone: card.pricePlan.entryZone,
    stopLoss: card.pricePlan.stopLoss,
    targets: card.pricePlan.targets,
    expiresAt: card.expiresAt,
    evidence: card.evidence.filter((item) => item.status === "matched").flatMap((item) => item.reasons).slice(0, 8),
    orderSubmitted: false,
    exchangeRequestSent: false
  };
}
function splitSignalId(signalId2) {
  const cycleMarker = ":cycle:";
  const markerIndex = signalId2.lastIndexOf(cycleMarker);
  return {
    baseSignalId: markerIndex >= 0 ? signalId2.slice(0, markerIndex) : signalId2,
    cycle: markerIndex >= 0 ? Number(signalId2.slice(markerIndex + cycleMarker.length)) : 1
  };
}
function strategyScopedBaseSignalId(card) {
  const baseSignalId = splitSignalId(card.signalId).baseSignalId;
  if (!card.strategyMode || baseSignalId.includes(":strategy:")) return baseSignalId;
  return `${baseSignalId}:strategy:${card.strategyMode}`;
}
function applyScannerSignalLifecycle(memberId, cards, now = Date.now()) {
  for (const [key, record] of records) {
    if (now - record.lastSeenAt > RECORD_TTL_MS) records.delete(key);
  }
  const alerts = [];
  const updated = cards.map((card) => {
    const baseSignalId = strategyScopedBaseSignalId(card);
    const key = lifecycleKey(memberId, baseSignalId);
    const existing = records.get(key);
    let cycle = existing?.cycle ?? 1;
    const existingState = normalizedPrevious(existing?.state ?? null);
    if (existing && existingState != null && SCANNER_TERMINAL_STATES.has(existingState) && card.strongSignalEligible && !["APPROVED", "EXECUTING", "PARTIALLY_FILLED", "FILLED", "MANAGING"].includes(existingState)) {
      cycle += 1;
    }
    const resetCycle = !existing || cycle !== existing.cycle;
    const previous = resetCycle ? null : existingState;
    const state = nextState(previous, card, now);
    const confirmationStreak = card.strongSignalEligible ? resetCycle ? 1 : (existing?.confirmationStreak ?? 0) + 1 : 0;
    const signalId2 = cycle === 1 ? baseSignalId : `${baseSignalId}:cycle:${cycle}`;
    const nextCard = { ...card, signalId: signalId2, signalState: state };
    const idempotencyKey = alertKey(signalId2, card.expiresAt);
    let lastAlertKey = resetCycle ? null : existing?.lastAlertKey ?? null;
    if (state === "APPROVAL_PENDING" && lastAlertKey !== idempotencyKey) {
      alerts.push(alertFrom(nextCard, idempotencyKey));
      lastAlertKey = idempotencyKey;
    }
    records.set(key, {
      baseSignalId,
      cycle,
      state,
      confirmationStreak,
      firstSeenAt: resetCycle ? now : existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastAlertKey
    });
    return nextCard;
  });
  return { cards: updated, alerts };
}

// src/services/scanner-data-quality.service.ts
var TIMEFRAME_MS = {
  "1m": 6e4,
  "3m": 3 * 6e4,
  "5m": 5 * 6e4,
  "15m": 15 * 6e4,
  "30m": 30 * 6e4,
  "60m": 60 * 6e4,
  "1H": 60 * 6e4,
  "4H": 4 * 60 * 6e4,
  "1D": 24 * 60 * 6e4,
  "1W": 7 * 24 * 60 * 6e4
};
var SESSION_AWARE_RECENT_STALE_MS = 4 * 24 * 60 * 6e4;
function compactKoreaTimestamp(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8 && digits.length !== 14) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  const hour = digits.length === 14 ? digits.slice(8, 10) : "00";
  const minute = digits.length === 14 ? digits.slice(10, 12) : "00";
  const second = digits.length === 14 ? digits.slice(12, 14) : "00";
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
  return Number.isFinite(parsed) ? parsed : null;
}
function timestamp2(value) {
  if (typeof value === "number") {
    const parsed2 = value < 1e10 ? value * 1e3 : value;
    return Number.isFinite(parsed2) && parsed2 > 0 ? parsed2 : null;
  }
  const compact = compactKoreaTimestamp(value);
  if (compact != null) return compact;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}
function pushIssue(issues, code, severity, message) {
  if (issues.some((issue) => issue.code === code && issue.severity === severity)) return;
  issues.push({ code, severity, message });
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function shouldInspectGap(gap, expectedIntervalMs, timeframe, sessionAware) {
  if (gap <= expectedIntervalMs * 1.8) return false;
  if (!sessionAware) return true;
  if (timeframe === "1D" || timeframe === "1W") return false;
  if (gap >= 6 * 60 * 6e4) return false;
  return true;
}
function inspectCandles(input, issues, expectedIntervalMs, now) {
  const seen = /* @__PURE__ */ new Set();
  const ordered = [];
  for (const candle of input.candles) {
    const at = timestamp2(candle.time);
    if (at == null) {
      pushIssue(issues, "INVALID_OHLC", "blocking", "캔들 timestamp가 유효하지 않습니다.");
      continue;
    }
    if (seen.has(at)) {
      pushIssue(issues, "DUPLICATE_CANDLE", "blocking", "동일 timestamp 캔들이 중복되었습니다.");
    }
    seen.add(at);
    ordered.push({ at, candle });
    const { open, high, low, close, volume } = candle;
    const prices = [open, high, low, close];
    const validPrices = prices.every((price) => Number.isFinite(price) && price > 0);
    if (!validPrices || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      pushIssue(issues, "INVALID_OHLC", "blocking", "OHLC 가격 관계가 유효하지 않습니다.");
    }
    if (!Number.isFinite(volume) || volume < 0) {
      pushIssue(issues, "INVALID_VOLUME", "blocking", "거래량이 음수이거나 유효한 숫자가 아닙니다.");
    }
  }
  ordered.sort((left, right) => left.at - right.at);
  if (!ordered.length) {
    pushIssue(issues, "MISSING_CANDLE", "blocking", "검증 가능한 캔들이 없습니다.");
    return null;
  }
  if (expectedIntervalMs != null && ordered.length >= 2) {
    const largeGaps = ordered.slice(1).filter((row, index) => shouldInspectGap(
      row.at - ordered[index].at,
      expectedIntervalMs,
      input.timeframe,
      input.sessionAware === true
    ));
    if (largeGaps.length) {
      const ratio = largeGaps.length / Math.max(1, ordered.length - 1);
      pushIssue(
        issues,
        "MISSING_CANDLE",
        ratio >= 0.08 ? "blocking" : "warning",
        `예상 간격보다 큰 거래 구간 내 캔들 공백 ${largeGaps.length}개가 발견되었습니다.`
      );
    }
  }
  const last = ordered.at(-1);
  if (expectedIntervalMs != null) {
    const staleMultiplier = Math.max(1.5, input.staleMultiplier ?? 3);
    const age = now - last.at;
    if (age > expectedIntervalMs * staleMultiplier) {
      const recentClosedSession = input.sessionAware === true && age >= 0 && age <= SESSION_AWARE_RECENT_STALE_MS;
      pushIssue(
        issues,
        "STALE_TIMESTAMP",
        recentClosedSession ? "warning" : "blocking",
        recentClosedSession ? "최근 거래세션 이후 주말·휴장·미완성 세션 가능성이 있어 최신성은 보수적으로 제한합니다." : "최신 캔들 timestamp가 허용 범위를 벗어났습니다."
      );
    }
  }
  if (ordered.length >= 8) {
    const returns = [];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1].candle.close;
      const current = ordered[index].candle.close;
      if (previous > 0 && current > 0) returns.push(Math.abs(current / previous - 1));
    }
    const baseline = median(returns.slice(0, -1));
    const latestMove = returns.at(-1) ?? 0;
    const dynamicLimit = Math.max(0.12, (baseline ?? 0) * 12);
    if (latestMove > dynamicLimit) {
      pushIssue(
        issues,
        "ABNORMAL_SPIKE",
        latestMove >= 0.45 ? "blocking" : "warning",
        `직전 캔들 대비 ${(latestMove * 100).toFixed(2)}% 급변이 감지되었습니다.`
      );
    }
  }
  return new Date(last.at).toISOString();
}
function inspectProviders(input, issues) {
  const observations = (input.providerObservations ?? []).filter((row) => row.provider.trim() && Number.isFinite(row.price) && row.price > 0);
  for (const row of observations) {
    if (row.symbol.trim().toUpperCase() !== input.symbol.trim().toUpperCase()) {
      pushIssue(
        issues,
        "SYMBOL_MISMATCH",
        "blocking",
        `provider ${row.provider}의 심볼이 요청 심볼과 일치하지 않습니다.`
      );
    }
  }
  if (observations.length < 2) return;
  const prices = observations.map((row) => row.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const midpoint = (low + high) / 2;
  const disagreement = midpoint > 0 ? (high - low) / midpoint * 100 : Number.POSITIVE_INFINITY;
  const threshold = Math.max(0.1, input.providerDisagreementPercent ?? 2);
  if (disagreement > threshold) {
    pushIssue(
      issues,
      "PROVIDER_DISAGREEMENT",
      disagreement >= threshold * 2 ? "blocking" : "warning",
      `provider 가격 차이가 ${disagreement.toFixed(2)}%로 허용 범위를 넘었습니다.`
    );
  }
}
function evaluateScannerDataQuality(input) {
  const issues = [];
  const now = input.now ?? Date.now();
  const expectedIntervalMs = TIMEFRAME_MS[input.timeframe] ?? null;
  const lastTimestamp = inspectCandles(input, issues, expectedIntervalMs, now);
  inspectProviders(input, issues);
  if (input.marketClosed) {
    pushIssue(issues, "MARKET_CLOSED", "blocking", "현재 시장이 거래 가능 상태가 아닙니다.");
  }
  if (input.tradingHalt) {
    pushIssue(issues, "TRADING_HALT", "blocking", "거래 정지 상태가 감지되었습니다.");
  }
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const blockingCount = issues.filter((issue) => issue.severity === "blocking").length;
  const score = Math.round(clamp(100 - warningCount * 10 - blockingCount * 35));
  const state = blockingCount > 0 ? "DATA_UNTRUSTED" : warningCount > 0 ? "DEGRADED" : "TRUSTED";
  const freshnessRestricted = issues.some((issue) => issue.code === "STALE_TIMESTAMP" || issue.code === "MARKET_CLOSED");
  return {
    state,
    score,
    strongSignalAllowed: state !== "DATA_UNTRUSTED" && score >= 80 && !freshnessRestricted,
    issues,
    observedCandleCount: input.candles.length,
    expectedIntervalMs,
    lastTimestamp
  };
}

// src/services/scanner-indicator-library.service.ts
function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function scannerSma(values, period) {
  if (period <= 0 || values.length < period) return null;
  return average(values.slice(-period));
}
function emaSeries(values, period) {
  if (period <= 0 || values.length < period) return values.map(() => null);
  const output = values.map(() => null);
  const seed = average(values.slice(0, period));
  if (seed == null) return output;
  output[period - 1] = seed;
  const multiplier = 2 / (period + 1);
  let previous = seed;
  for (let index = period; index < values.length; index += 1) {
    previous = (values[index] - previous) * multiplier + previous;
    output[index] = previous;
  }
  return output;
}
function scannerEma(values, period) {
  return emaSeries(values, period).at(-1) ?? null;
}
function scannerRsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let index = start; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  if (losses === 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}
function scannerAtr(candles, period = 14) {
  if (candles.length < 2) return null;
  const rows = candles.slice(-Math.min(candles.length, period + 1));
  const ranges = [];
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  return average(ranges);
}
function scannerMacd(values) {
  if (values.length < 26) return { macd: null, signal: null, histogram: null };
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const macdSeries = values.map((_, index) => fast[index] != null && slow[index] != null ? fast[index] - slow[index] : null);
  const compact = macdSeries.filter((value) => value != null);
  if (compact.length < 9) {
    return { macd: macdSeries.at(-1) ?? null, signal: null, histogram: null };
  }
  const signalSeries = emaSeries(compact, 9);
  const macd = compact.at(-1) ?? null;
  const signal = signalSeries.at(-1) ?? null;
  return {
    macd,
    signal,
    histogram: macd != null && signal != null ? macd - signal : null
  };
}
function scannerAdx(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const rows = candles.slice(-(period + 1));
  let trTotal = 0;
  let plusTotal = 0;
  let minusTotal = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );
    trTotal += trueRange;
    if (upMove > downMove && upMove > 0) plusTotal += upMove;
    if (downMove > upMove && downMove > 0) minusTotal += downMove;
  }
  if (!(trTotal > 0)) return null;
  const plusDi = plusTotal / trTotal * 100;
  const minusDi = minusTotal / trTotal * 100;
  const denominator = plusDi + minusDi;
  if (!(denominator > 0)) return 0;
  return Math.abs(plusDi - minusDi) / denominator * 100;
}
function scannerVwap(candles) {
  let weighted = 0;
  let volume = 0;
  for (const candle of candles) {
    if (!(candle.volume >= 0) || !Number.isFinite(candle.volume)) continue;
    const typical = (candle.high + candle.low + candle.close) / 3;
    weighted += typical * candle.volume;
    volume += candle.volume;
  }
  return volume > 0 ? weighted / volume : null;
}
function scannerRelativeVolume(candles, lookback = 20) {
  if (candles.length < 2) return null;
  const latest = candles.at(-1);
  const baseline = candles.slice(-(lookback + 1), -1).map((row) => row.volume).filter(Number.isFinite);
  const mean = average(baseline);
  return mean != null && mean > 0 ? latest.volume / mean : null;
}
function scannerTradeIntensityProxy(candles, lookback = 20) {
  const latest = candles.at(-1);
  if (!latest) return null;
  const range = latest.high - latest.low;
  const relativeVolume = scannerRelativeVolume(candles, lookback);
  if (!(range > 0) || relativeVolume == null) return null;
  const pressure = Math.max(-1, Math.min(1, (latest.close - latest.open) / range));
  return pressure * relativeVolume;
}
function buildScannerIndicatorSnapshot(candles) {
  const closes = candles.map((row) => row.close).filter(Number.isFinite);
  const recent20 = candles.slice(-20);
  const latest = candles.at(-1) ?? null;
  const firstVolumeWindow = candles.slice(-20, -10).map((row) => row.volume).filter(Number.isFinite);
  const lastVolumeWindow = candles.slice(-10).map((row) => row.volume).filter(Number.isFinite);
  const earlyVolume = average(firstVolumeWindow);
  const lateVolume = average(lastVolumeWindow);
  const volumeTrend20 = earlyVolume != null && earlyVolume > 0 && lateVolume != null ? lateVolume / earlyVolume - 1 : null;
  const momentum5 = closes.length >= 6 && closes.at(-6) > 0 ? closes.at(-1) / closes.at(-6) - 1 : null;
  return {
    close: latest?.close ?? null,
    ema12: scannerEma(closes, 12),
    ema20: scannerEma(closes, 20),
    ema26: scannerEma(closes, 26),
    ema60: scannerEma(closes, 60),
    sma20: scannerSma(closes, 20),
    sma60: scannerSma(closes, 60),
    sma120: scannerSma(closes, 120),
    rsi14: scannerRsi(closes, 14),
    atr14: scannerAtr(candles, 14),
    adx14: scannerAdx(candles, 14),
    vwap: scannerVwap(candles),
    relativeVolume20: scannerRelativeVolume(candles, 20),
    tradeIntensityProxy: scannerTradeIntensityProxy(candles, 20),
    macd: scannerMacd(closes),
    support20: recent20.length ? Math.min(...recent20.map((row) => row.low)) : null,
    resistance20: recent20.length ? Math.max(...recent20.map((row) => row.high)) : null,
    volumeTrend20,
    momentum5
  };
}

// src/services/scanner-market-profile-overlay.service.ts
var PROFILE_KEY = "market-profile-v1";
function finite7(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function clamp2(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}
function demoteStrongGrade(grade) {
  return grade === "S" || grade === "A" ? "B" : grade;
}
function timestamp3(value) {
  if (typeof value === "number") {
    const normalized = value < 1e10 ? value * 1e3 : value;
    return Number.isFinite(normalized) ? normalized : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function wallClock(value, timeZone) {
  const at = timestamp3(value);
  if (at == null) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(at));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.get("hour"));
  const minute = Number(values.get("minute"));
  const weekday = values.get("weekday") ?? "";
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { minuteOfDay: hour * 60 + minute, weekday };
}
function krSession(candle) {
  if (!candle) return "unknown";
  const wall = wallClock(candle.time, "Asia/Seoul");
  if (!wall) return "unknown";
  if (wall.weekday === "Sat" || wall.weekday === "Sun") return "outside";
  return wall.minuteOfDay >= 9 * 60 && wall.minuteOfDay < 15 * 60 + 30 ? "regular" : "outside";
}
function usSession(candle) {
  if (!candle) return "unknown";
  const wall = wallClock(candle.time, "America/New_York");
  if (!wall) return "unknown";
  if (wall.weekday === "Sat" || wall.weekday === "Sun") return "outside";
  if (wall.minuteOfDay >= 4 * 60 && wall.minuteOfDay < 9 * 60 + 30) return "premarket";
  if (wall.minuteOfDay >= 9 * 60 + 30 && wall.minuteOfDay < 16 * 60) return "regular";
  if (wall.minuteOfDay >= 16 * 60 && wall.minuteOfDay < 20 * 60) return "after-hours";
  return "outside";
}
function discontinuityPercent(candles) {
  if (candles.length < 2) return null;
  const current = candles.at(-1);
  const previous = candles.at(-2);
  if (!(previous.close > 0)) return null;
  return Math.abs(current.open / previous.close - 1) * 100;
}
function stockEvaluation(input, market) {
  const { card, candles, strategyMode } = input;
  const indicator = buildScannerIndicatorSnapshot(candles);
  const quant = card.quantScore;
  const intraday = strategyMode === "scalping";
  const liquidityFloor = market === "KR" ? intraday ? 62 : 52 : intraday ? 68 : 56;
  const volumeFloor = intraday ? 58 : 48;
  const trendFloor = intraday ? 52 : 58;
  const momentumFloor = intraday ? 55 : 48;
  const volatilityFloor = intraday ? 52 : 42;
  const change = Math.abs(card.changePercent ?? 0);
  const gap = discontinuityPercent(candles);
  const session = market === "KR" ? krSession(candles.at(-1)) : usSession(candles.at(-1));
  const sessionVerified = !intraday || session !== "unknown";
  const regularSession = !intraday || session === "regular";
  const relativeVolume = indicator.relativeVolume20;
  const relativeVolumePass = relativeVolume == null ? false : relativeVolume >= (intraday ? 1.05 : 0.8);
  const trendPass = quant != null && quant.trend >= trendFloor;
  const momentumPass = quant != null && quant.momentum >= momentumFloor;
  const liquidityPass = quant != null && quant.liquidity >= liquidityFloor;
  const volatilityPass = quant != null && quant.volatility >= volatilityFloor;
  const riskPass = card.riskScore != null && card.riskScore <= (market === "KR" ? 48 : 45);
  const gapPass = gap == null || gap <= (market === "KR" ? 5 : 7);
  const chasePass = change <= (market === "KR" ? 15 : 18);
  const confirmations = [trendPass, momentumPass, liquidityPass, volatilityPass, relativeVolumePass, riskPass, gapPass].filter(Boolean).length;
  const hardBlocked = (card.riskScore ?? 101) > 65 || quant != null && quant.liquidity < 30 || change > (market === "KR" ? 25 : 30) || gap != null && gap > (market === "KR" ? 10 : 12) || intraday && session === "outside";
  const sessionStrongPass = market === "KR" ? regularSession : !intraday || session === "regular";
  const confirmed = !hardBlocked && confirmations >= (intraday ? 5 : 4) && liquidityPass && riskPass && sessionStrongPass;
  const unverified = quant == null || card.riskScore == null || !sessionVerified || intraday && relativeVolume == null;
  const reasons = [
    `시장 ${market} · ${intraday ? "단타" : "스윙"} profile`,
    `추세 ${quant?.trend == null ? "미확인" : Math.round(quant.trend)} / 기준 ${trendFloor}`,
    `모멘텀 ${quant?.momentum == null ? "미확인" : Math.round(quant.momentum)} / 기준 ${momentumFloor}`,
    `유동성 ${quant?.liquidity == null ? "미확인" : Math.round(quant.liquidity)} / 기준 ${liquidityFloor}`,
    `변동성 적합도 ${quant?.volatility == null ? "미확인" : Math.round(quant.volatility)} / 기준 ${volatilityFloor}`,
    `상대거래량 ${relativeVolume == null ? "미확인" : `${relativeVolume.toFixed(2)}배`}`,
    `연속봉 갭 ${gap == null ? "미확인" : `${gap.toFixed(2)}%`}`,
    `등락 추격위험 ${change.toFixed(2)}%`,
    `세션 ${session}`,
    `확인항목 ${confirmations}/7`,
    "시장 profile은 기존 Quant 신호를 승격하지 않고 확인/강등만 합니다."
  ];
  const warnings = [];
  if (market === "US" && intraday && (session === "premarket" || session === "after-hours")) {
    warnings.push("미국 프리/애프터마켓은 V1에서 호가 깊이 검증이 없어 강한 신호로 승격하지 않습니다.");
  }
  if (!gapPass) warnings.push("갭/가격 불연속 위험이 시장별 허용 범위를 초과했습니다.");
  if (!chasePass) warnings.push("급등락 추격 위험이 시장별 허용 범위를 초과했습니다.");
  return {
    label: market === "KR" ? "국내주식 시장최적화 확인" : "미국주식 시장최적화 확인",
    source: market === "KR" ? "kr-stock-market-profile-v1" : "us-stock-market-profile-v1",
    confirmed: confirmed && chasePass,
    hardBlocked,
    unverified,
    reasons,
    warnings
  };
}
function cryptoEvaluation(input, futures) {
  const { card, candles, strategyMode } = input;
  const indicator = buildScannerIndicatorSnapshot(candles);
  const quant = card.quantScore;
  const intraday = strategyMode === "scalping";
  const spreadLimit = futures ? 0.25 : 0.35;
  const riskLimit = futures ? 45 : 50;
  const liquidityFloor = futures ? 65 : 58;
  const volatilityFloor = intraday ? 55 : 45;
  const relativeVolume = indicator.relativeVolume20;
  const spreadPass = card.spreadPercent != null && card.spreadPercent <= spreadLimit;
  const liquidityPass = quant != null && quant.liquidity >= liquidityFloor;
  const volatilityPass = quant != null && quant.volatility >= volatilityFloor;
  const riskPass = card.riskScore != null && card.riskScore <= riskLimit;
  const volumePass = relativeVolume != null && relativeVolume >= (intraday ? 1 : 0.75);
  const directionPass = futures ? card.direction !== "NEUTRAL" : card.direction === "LONG";
  const trendPass = quant != null && (card.direction === "SHORT" ? quant.trend < 50 : quant.trend > 50);
  const momentumPass = quant != null && (card.direction === "SHORT" ? quant.momentum < 50 : quant.momentum > 50);
  const funding = finite7(input.fundingRate);
  const openInterest = finite7(input.openInterest);
  const derivativesVerified = !futures || funding != null && openInterest != null && openInterest > 0;
  const crowdedFunding = futures && funding != null && (card.direction === "LONG" && funding > 8e-4 || card.direction === "SHORT" && funding < -8e-4 || Math.abs(funding) > 15e-4);
  const confirmations = [spreadPass, liquidityPass, volatilityPass, riskPass, volumePass, directionPass, trendPass, momentumPass].filter(Boolean).length;
  const hardBlocked = !directionPass || (card.riskScore ?? 101) > 65 || card.spreadPercent != null && card.spreadPercent > (futures ? 0.65 : 0.8) || Math.abs(card.changePercent ?? 0) > 30 || crowdedFunding;
  const confirmed = !hardBlocked && confirmations >= (intraday ? 6 : 5) && spreadPass && liquidityPass && riskPass && derivativesVerified;
  const unverified = quant == null || card.spreadPercent == null || card.riskScore == null || relativeVolume == null || !derivativesVerified;
  const reasons = [
    `시장 ${futures ? "코인선물" : "코인현물"} · ${intraday ? "단타" : "스윙"} profile`,
    `방향 ${card.direction}${futures ? " (LONG/SHORT)" : " (현물 LONG only)"}`,
    `스프레드 ${card.spreadPercent == null ? "미확인" : `${card.spreadPercent.toFixed(3)}%`} / 기준 ${spreadLimit}%`,
    `유동성 ${quant?.liquidity == null ? "미확인" : Math.round(quant.liquidity)} / 기준 ${liquidityFloor}`,
    `변동성 적합도 ${quant?.volatility == null ? "미확인" : Math.round(quant.volatility)} / 기준 ${volatilityFloor}`,
    `상대거래량 ${relativeVolume == null ? "미확인" : `${relativeVolume.toFixed(2)}배`}`,
    `리스크 ${card.riskScore == null ? "미확인" : card.riskScore} / 기준 ${riskLimit}`,
    ...futures ? [
      `펀딩비 ${funding == null ? "미확인" : `${(funding * 100).toFixed(4)}%`}`,
      `미결제약정 ${openInterest == null ? "미확인" : openInterest.toFixed(2)}`
    ] : [],
    `확인항목 ${confirmations}/8`,
    "24시간 시장 profile은 세션 가정 없이 공개 시세·캔들·호가만 사용합니다.",
    "시장 profile은 기존 Quant 신호를 승격하지 않고 확인/강등만 합니다."
  ];
  const warnings = [];
  if (!futures && card.direction === "SHORT") warnings.push("코인 현물 SHORT는 금지됩니다.");
  if (crowdedFunding) warnings.push("펀딩 쏠림이 포지션 방향과 겹쳐 추격 위험이 큽니다.");
  if (futures && !derivativesVerified) warnings.push("펀딩비·미결제약정 확인 전에는 선물 강한 신호를 허용하지 않습니다.");
  if (futures) warnings.push("Shadow 승격에는 별도 사용자 레버리지·청산가 검증이 추가로 필요합니다.");
  return {
    label: futures ? "코인선물 시장최적화 확인" : "코인현물 시장최적화 확인",
    source: futures ? "crypto-futures-market-profile-v1" : "crypto-spot-market-profile-v1",
    confirmed,
    hardBlocked,
    unverified,
    reasons,
    warnings
  };
}
function evaluate(input) {
  if (input.profile === "KR_STOCK") return stockEvaluation(input, "KR");
  if (input.profile === "US_STOCK") return stockEvaluation(input, "US");
  if (input.profile === "CRYPTO_SPOT") return cryptoEvaluation(input, false);
  return cryptoEvaluation(input, true);
}
function evidenceLists(evidence) {
  return {
    matched: [...new Set(evidence.filter((item) => item.status === "matched").map((item) => item.label))],
    notMatched: [...new Set(evidence.filter((item) => item.status === "not_matched").map((item) => item.label))],
    unverified: [...new Set(evidence.filter((item) => item.status === "unverified").map((item) => item.label))]
  };
}
function applyScannerMarketProfile(input) {
  const evaluation = evaluate(input);
  const profileEvidence = {
    key: `${PROFILE_KEY}:${input.profile}`,
    label: evaluation.label,
    status: evaluation.unverified ? "unverified" : evaluation.confirmed ? "matched" : "not_matched",
    source: evaluation.source,
    observedAt: input.card.observedAt,
    reasons: evaluation.reasons
  };
  const evidence = [
    ...input.card.evidence.filter((item) => !item.key.startsWith(`${PROFILE_KEY}:`)),
    profileEvidence
  ];
  const lists = evidenceLists(evidence);
  const keepStrong = input.card.strongSignalEligible && evaluation.confirmed && !evaluation.hardBlocked;
  const demote = !evaluation.confirmed || evaluation.hardBlocked || evaluation.unverified;
  const scoreCap = evaluation.hardBlocked ? 64 : demote ? 74 : 100;
  const score = Math.round(clamp2(Math.min(input.card.score, scoreCap)));
  const warnings = [
    ...input.card.warnings,
    ...evaluation.warnings,
    ...demote ? [`${evaluation.label}: 강한 신호 보존 조건 미충족`] : [],
    "시장별 최적화 V1은 수익률 최적값이 아니라 fail-closed 확인 게이트입니다."
  ];
  return {
    ...input.card,
    score,
    strongSignalEligible: keepStrong,
    signalGrade: demote ? demoteStrongGrade(input.card.signalGrade) : input.card.signalGrade,
    signalState: demote && input.card.signalState !== "INVALIDATED" ? "CANDIDATE" : input.card.signalState,
    evidence,
    matched: lists.matched,
    notMatched: lists.notMatched,
    unverified: lists.unverified,
    dataSources: [.../* @__PURE__ */ new Set([...input.card.dataSources, evaluation.source])],
    warnings: [...new Set(warnings)]
  };
}

// src/services/scanner-quant-strategy.service.ts
var SCALPING_LIMITS = Object.freeze({
  strongScore: 78,
  maxRiskScore: 40,
  minLiquidityFactor: 65,
  minVolatilityFactor: 55,
  minDataQualityScore: 85,
  sGradeScore: 90,
  sGradeMaxRiskScore: 30
});
var SWING_LIMITS = Object.freeze({
  strongScore: 74,
  maxRiskScore: 50,
  minLiquidityFactor: 50,
  minVolatilityFactor: 40,
  minDataQualityScore: 80,
  sGradeScore: 88,
  sGradeMaxRiskScore: 35
});
var POSITION_LIMITS = Object.freeze({
  strongScore: 76,
  maxRiskScore: 45,
  minLiquidityFactor: 45,
  minVolatilityFactor: 35,
  minDataQualityScore: 85,
  sGradeScore: 89,
  sGradeMaxRiskScore: 32
});
var SCALPING_WEIGHTS = {
  technical: 16,
  trend: 14,
  momentum: 16,
  volume: 16,
  liquidity: 14,
  volatility: 8,
  marketRegime: 10,
  risk: 6
};
var SWING_WEIGHTS = {
  technical: 14,
  trend: 22,
  momentum: 14,
  volume: 10,
  liquidity: 8,
  volatility: 8,
  marketRegime: 16,
  risk: 8
};
var POSITION_WEIGHTS = {
  technical: 12,
  trend: 28,
  momentum: 10,
  volume: 8,
  liquidity: 6,
  volatility: 7,
  marketRegime: 20,
  risk: 9
};
var DEFAULT_AI_VALIDATION = {
  status: "NOT_RUN",
  provider: null,
  counterEvidence: [],
  missingData: [],
  risks: [],
  explanation: null
};
var NORMALIZED_FACTOR_MIDPOINT = 50;
function clamp3(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}
function scoreRelativeVolume(value) {
  if (value == null || !Number.isFinite(value)) return 25;
  if (value < 0.5) return 20;
  if (value < 0.8) return 35;
  if (value < 1.1) return 50;
  if (value < 1.5) return 65;
  if (value < 2) return 78;
  if (value < 3) return 90;
  return 100;
}
function scoreLiquidity(spreadPercent2, tradingValue) {
  let score = tradingValue != null && tradingValue > 0 ? 65 : 30;
  if (spreadPercent2 == null) return score;
  if (spreadPercent2 <= 0.05) score += 35;
  else if (spreadPercent2 <= 0.1) score += 28;
  else if (spreadPercent2 <= 0.2) score += 18;
  else if (spreadPercent2 <= 0.4) score += 4;
  else if (spreadPercent2 <= 0.8) score -= 20;
  else score -= 40;
  return clamp3(score);
}
function scoreRisk(riskScore) {
  return riskScore == null ? 35 : clamp3(100 - riskScore);
}
function atrPercent(snapshot, price) {
  return snapshot.atr14 != null && price > 0 ? snapshot.atr14 / price * 100 : null;
}
function scoreScalpingVolatility(snapshot, price) {
  const value = atrPercent(snapshot, price);
  if (value == null) return 30;
  if (value < 0.15) return 45;
  if (value <= 0.4) return 70;
  if (value <= 2.5) return 90;
  if (value <= 4.5) return 75;
  if (value <= 7) return 50;
  return 20;
}
function scoreSwingVolatility(snapshot, price) {
  const value = atrPercent(snapshot, price);
  if (value == null) return 30;
  if (value < 0.5) return 55;
  if (value <= 4) return 90;
  if (value <= 7) return 72;
  if (value <= 12) return 48;
  return 20;
}
function scorePositionVolatility(snapshot, price) {
  const value = atrPercent(snapshot, price);
  if (value == null) return 30;
  if (value < 0.35) return 48;
  if (value <= 3.5) return 90;
  if (value <= 6.5) return 75;
  if (value <= 10) return 50;
  return 20;
}
function trendDirection(snapshot) {
  const fast = snapshot.ema20 ?? snapshot.ema12;
  const slow = snapshot.ema60 ?? snapshot.ema26;
  if (fast == null || slow == null || fast === slow) return 0;
  return fast > slow ? 1 : -1;
}
function scalpingFactors(primary, context, input) {
  const close = primary.close ?? input.price;
  let technical = 45;
  if (primary.vwap != null) technical += close >= primary.vwap ? 22 : -18;
  if (primary.support20 != null && close >= primary.support20) technical += 8;
  if (primary.resistance20 != null && close >= primary.resistance20) technical += 15;
  let trend = 45;
  if (primary.ema12 != null && primary.ema26 != null) trend += primary.ema12 > primary.ema26 ? 25 : -20;
  const contextTrend = trendDirection(context);
  if (contextTrend > 0) trend += 20;
  if (contextTrend < 0) trend -= 20;
  let momentum = 45;
  if (primary.macd.histogram != null) momentum += primary.macd.histogram > 0 ? 20 : -18;
  if (primary.rsi14 != null) {
    if (primary.rsi14 >= 45 && primary.rsi14 <= 68) momentum += 20;
    else if (primary.rsi14 > 78) momentum -= 25;
    else if (primary.rsi14 < 30) momentum -= 10;
  }
  if (primary.momentum5 != null) momentum += clamp3(primary.momentum5 * 700, -15, 15);
  let volume = scoreRelativeVolume(primary.relativeVolume20);
  if (primary.tradeIntensityProxy != null) {
    momentum += clamp3(primary.tradeIntensityProxy * 10, -12, 12);
    technical += clamp3(primary.tradeIntensityProxy * 5, -8, 8);
    volume += clamp3(primary.tradeIntensityProxy * 8, -12, 12);
  }
  let marketRegime = 50;
  if (contextTrend > 0) marketRegime += 30;
  if (contextTrend < 0) marketRegime -= 30;
  if (context.adx14 != null && context.adx14 >= 20) marketRegime += 12;
  return { technical: clamp3(technical), trend: clamp3(trend), momentum: clamp3(momentum), volume: clamp3(volume), liquidity: scoreLiquidity(input.spreadPercent, input.tradingValue), volatility: scoreScalpingVolatility(primary, input.price), marketRegime: clamp3(marketRegime), risk: scoreRisk(input.riskScore) };
}
function swingFactors(primary, context, input) {
  const close = primary.close ?? input.price;
  let trend = 40;
  if (primary.ema20 != null && primary.ema60 != null) trend += primary.ema20 > primary.ema60 ? 22 : -20;
  if (primary.sma20 != null && primary.sma60 != null) trend += primary.sma20 > primary.sma60 ? 14 : -12;
  if (primary.sma60 != null && primary.sma120 != null) trend += primary.sma60 > primary.sma120 ? 12 : -10;
  if (primary.adx14 != null) trend += primary.adx14 >= 25 ? 12 : primary.adx14 < 15 ? -8 : 0;
  let technical = 45;
  if (primary.resistance20 != null && close > primary.resistance20) technical += 28;
  if (primary.ema20 != null && close >= primary.ema20 * 0.98 && close <= primary.ema20 * 1.04) technical += 14;
  if (primary.support20 != null && close < primary.support20) technical -= 28;
  let momentum = 45;
  if (primary.macd.histogram != null) momentum += primary.macd.histogram > 0 ? 22 : -18;
  if (primary.rsi14 != null) {
    if (primary.rsi14 >= 45 && primary.rsi14 <= 70) momentum += 18;
    else if (primary.rsi14 > 80) momentum -= 22;
    else if (primary.rsi14 < 32) momentum -= 10;
  }
  let volume = scoreRelativeVolume(primary.relativeVolume20) * 0.65 + 35;
  if (primary.volumeTrend20 != null) volume += clamp3(primary.volumeTrend20 * 80, -20, 20);
  let marketRegime = 50;
  const contextTrend = trendDirection(context);
  if (contextTrend > 0) marketRegime += 28;
  if (contextTrend < 0) marketRegime -= 28;
  if (context.adx14 != null && context.adx14 >= 20) marketRegime += 15;
  return { technical: clamp3(technical), trend: clamp3(trend), momentum: clamp3(momentum), volume: clamp3(volume), liquidity: scoreLiquidity(input.spreadPercent, input.tradingValue), volatility: scoreSwingVolatility(primary, input.price), marketRegime: clamp3(marketRegime), risk: scoreRisk(input.riskScore) };
}
function positionFactors(primary, context, input) {
  const base = swingFactors(primary, context, input);
  let trend = base.trend;
  if (primary.sma60 != null && primary.sma120 != null) trend += primary.sma60 > primary.sma120 ? 10 : -12;
  const contextTrend = trendDirection(context);
  let marketRegime = base.marketRegime + (contextTrend > 0 ? 8 : contextTrend < 0 ? -8 : 0);
  return {
    ...base,
    trend: clamp3(trend),
    momentum: clamp3(base.momentum * 0.9 + 5),
    volume: clamp3(base.volume * 0.9 + 5),
    volatility: scorePositionVolatility(primary, input.price),
    marketRegime: clamp3(marketRegime)
  };
}
function weightedScore(factors, weights) {
  return Math.round(clamp3(Object.keys(weights).reduce((sum, key) => sum + factors[key] * weights[key] / 100, 0)));
}
function inferDirection(factors, primary, context, allowShort) {
  const longBias = (factors.trend + factors.momentum + factors.marketRegime + factors.technical) / 4;
  const primaryTrend = trendDirection(primary);
  const contextTrend = trendDirection(context);
  if (longBias >= 62 && primaryTrend >= 0 && contextTrend >= 0) return "LONG";
  if (allowShort && longBias <= 42 && primaryTrend <= 0 && contextTrend <= 0) return "SHORT";
  return "NEUTRAL";
}
function limitsFor(mode) {
  if (mode === "scalping") return SCALPING_LIMITS;
  if (mode === "position") return POSITION_LIMITS;
  return SWING_LIMITS;
}
function weightsFor(mode) {
  if (mode === "scalping") return SCALPING_WEIGHTS;
  if (mode === "position") return POSITION_WEIGHTS;
  return SWING_WEIGHTS;
}
function directionAlignedFactor(value, direction) {
  if (direction === "LONG") return value > NORMALIZED_FACTOR_MIDPOINT;
  if (direction === "SHORT") return value < NORMALIZED_FACTOR_MIDPOINT;
  return false;
}
function hasIndependentSignalEvidence(factors, direction) {
  if (direction === "NEUTRAL") return false;
  return directionAlignedFactor(factors.technical, direction) && directionAlignedFactor(factors.trend, direction) && directionAlignedFactor(factors.momentum, direction) && directionAlignedFactor(factors.marketRegime, direction) && factors.volume > NORMALIZED_FACTOR_MIDPOINT;
}
function gradeFor(score, factors, input, aiValidation, direction) {
  const limits = limitsFor(input.mode);
  const sEligible = score >= limits.sGradeScore && hasIndependentSignalEvidence(factors, direction) && input.dataQuality.state === "TRUSTED" && input.dataQuality.strongSignalAllowed && input.dataQuality.score >= 90 && (input.riskScore ?? 101) <= limits.sGradeMaxRiskScore && factors.liquidity >= 70 && factors.volatility >= 60 && factors.marketRegime >= 70 && aiValidation.status === "PASS";
  if (sEligible) return "S";
  if (score >= 78) return "A";
  if (score >= 68) return "B";
  if (score >= 55) return "C";
  return "D";
}
function runScannerQuantStrategy(input) {
  const primary = buildScannerIndicatorSnapshot(input.candles);
  const context = buildScannerIndicatorSnapshot(input.contextCandles.length ? input.contextCandles : input.candles);
  const aiValidation = input.aiValidation ?? DEFAULT_AI_VALIDATION;
  const factors = input.mode === "scalping" ? scalpingFactors(primary, context, input) : input.mode === "position" ? positionFactors(primary, context, input) : swingFactors(primary, context, input);
  const limits = limitsFor(input.mode);
  let score = weightedScore(factors, weightsFor(input.mode));
  if (input.dataQuality.state === "DEGRADED") score = Math.min(score, 74);
  if (input.dataQuality.state === "DATA_UNTRUSTED") score = Math.min(score, 49);
  if (aiValidation.status === "VETO") score = Math.min(score, 49);
  if (aiValidation.status === "PARTIAL") score = Math.min(score, 79);
  const direction = inferDirection(factors, primary, context, input.allowShort);
  const independentSignalEvidence = hasIndependentSignalEvidence(factors, direction);
  const strongSignalEligible = direction !== "NEUTRAL" && independentSignalEvidence && score >= limits.strongScore && input.dataQuality.state !== "DATA_UNTRUSTED" && input.dataQuality.strongSignalAllowed && input.dataQuality.score >= limits.minDataQualityScore && (input.riskScore ?? 101) <= limits.maxRiskScore && factors.liquidity >= limits.minLiquidityFactor && factors.volatility >= limits.minVolatilityFactor && aiValidation.status !== "VETO";
  const grade = gradeFor(score, factors, input, aiValidation, direction);
  const reasons = [
    `전략 ${input.mode}`,
    `기술 ${Math.round(factors.technical)}`,
    `추세 ${Math.round(factors.trend)}`,
    `모멘텀 ${Math.round(factors.momentum)}`,
    `거래량 ${Math.round(factors.volume)}`,
    `유동성 ${Math.round(factors.liquidity)}`,
    `변동성 ${Math.round(factors.volatility)}`,
    `시장국면 ${Math.round(factors.marketRegime)}`,
    `리스크 ${Math.round(factors.risk)}`,
    `독립근거 ${independentSignalEvidence ? "충족" : "부족"}`,
    ...input.mode === "scalping" && primary.tradeIntensityProxy != null ? [`체결강도 대용지표 ${primary.tradeIntensityProxy.toFixed(2)}`] : []
  ];
  const warnings = [
    ...input.dataQuality.issues.map((issue) => `${issue.code}: ${issue.message}`),
    ...aiValidation.counterEvidence.map((reason) => `AI 반대근거: ${reason}`),
    ...aiValidation.missingData.map((reason) => `AI 데이터부족: ${reason}`),
    ...aiValidation.risks.map((reason) => `AI 위험: ${reason}`)
  ];
  return { mode: input.mode, score, grade, direction, factors, primary, context, strongSignalEligible, reasons, warnings, aiValidation };
}
function scannerContextTimeframe(mode) {
  if (mode === "scalping") return "15m";
  if (mode === "position") return "4H";
  return "60m";
}
function scannerStrategyForTimeframe(timeframe) {
  if (["1m", "3m", "5m", "15m"].includes(timeframe)) return "scalping";
  if (timeframe === "1D") return "position";
  return "swing";
}

// src/services/scanner-quant-hardening.service.ts
var EMPTY_PRICE_PLAN = {
  entryZone: null,
  invalidation: null,
  stopLoss: null,
  targets: [],
  riskReward: null
};
var LIVE_QUALITY_WINDOW = {
  scalping: 240,
  swing: 320,
  position: 400
};
function recentQualityCandles(candles, mode) {
  const limit = LIVE_QUALITY_WINDOW[mode];
  return candles.length > limit ? candles.slice(-limit) : candles;
}
function completenessFromMarketData(card, candleCount, dataQualityScore) {
  let value = dataQualityScore * 0.65;
  value += candleCount >= 60 ? 15 : candleCount >= 30 ? 10 : candleCount >= 20 ? 6 : 0;
  value += card.riskScore != null ? 8 : 0;
  value += card.tradingValue != null && card.tradingValue > 0 ? 7 : 0;
  value += card.listingStatus === "LISTED" ? 5 : 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}
function evidenceLabels(evidence, status) {
  return [...new Set(evidence.filter((item) => item.status === status).map((item) => item.label))];
}
function marketProfileFor(card) {
  if (card.assetClass === "coin_spot") return "CRYPTO_SPOT";
  if (card.assetClass === "coin_futures") return "CRYPTO_FUTURES";
  return card.market === "US" ? "US_STOCK" : "KR_STOCK";
}
function numberFromReason(reason) {
  if (!reason) return null;
  const match = reason.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}
function futuresPublicContext(card) {
  if (card.assetClass !== "coin_futures") return { fundingRate: null, openInterest: null };
  const evidence = card.evidence.find((item) => item.key === "funding-open-interest");
  const fundingPercent = numberFromReason(evidence?.reasons.find((reason) => reason.startsWith("펀딩비 ")));
  const openInterest = numberFromReason(evidence?.reasons.find((reason) => reason.startsWith("미결제약정 ")));
  return {
    fundingRate: fundingPercent == null ? null : fundingPercent / 100,
    openInterest
  };
}
function applyScannerQuantHardening(input) {
  const strategyMode = input.strategyMode ?? scannerStrategyForTimeframe(input.timeframe);
  const qualityCandles = recentQualityCandles(input.candles, strategyMode);
  const quality = evaluateScannerDataQuality({
    symbol: input.card.symbol,
    timeframe: input.timeframe,
    candles: qualityCandles,
    now: input.now,
    marketClosed: input.marketClosed,
    tradingHalt: input.tradingHalt,
    sessionAware: input.sessionAware
  });
  const contextCandles = input.contextCandles?.length ? input.contextCandles : input.candles;
  const quant = runScannerQuantStrategy({
    mode: strategyMode,
    timeframe: input.timeframe,
    candles: input.candles,
    contextCandles,
    price: input.card.price,
    tradingValue: input.card.tradingValue,
    spreadPercent: input.card.spreadPercent,
    riskScore: input.card.riskScore,
    dataQuality: quality,
    allowShort: input.allowShort ?? input.card.assetClass === "coin_futures"
  });
  const dataCompleteness = completenessFromMarketData(input.card, qualityCandles.length, quality.score);
  const directionChanged = quant.direction !== input.card.direction;
  const dataTrustedForPlan = quality.state !== "DATA_UNTRUSTED" && quality.strongSignalAllowed;
  const pricePlan2 = directionChanged || !dataTrustedForPlan ? EMPTY_PRICE_PLAN : input.card.pricePlan;
  const planEligible = dataTrustedForPlan && !directionChanged && pricePlan2.riskReward != null && pricePlan2.riskReward >= 1.5;
  const strongSignalEligible = quality.state !== "DATA_UNTRUSTED" && quant.strongSignalEligible && planEligible && input.card.listingStatus === "LISTED" && dataCompleteness >= 75;
  const dataState = quality.state === "DATA_UNTRUSTED" ? "untrusted" : quality.state === "DEGRADED" ? input.card.dataState === "complete" ? "partial" : input.card.dataState : input.card.dataState;
  const confidence = Math.round(Math.min(
    100,
    Math.max(0, quant.score),
    quality.score,
    dataCompleteness
  ));
  const warnings = [
    ...input.card.warnings,
    ...quant.warnings,
    ...directionChanged ? ["Quant 방향이 기존 후보 방향과 달라 기존 진입·손절·목표 가격을 폐기했습니다."] : [],
    ...quality.state === "DATA_UNTRUSTED" ? ["DATA_UNTRUSTED: 승인·실행 호환 가격정보를 폐기했습니다."] : []
  ];
  const evidence = [
    ...input.card.evidence,
    {
      key: `quant-${strategyMode}`,
      label: strategyMode === "scalping" ? "단타 Quant 종합" : strategyMode === "position" ? "중장기 Quant 종합" : "스윙 Quant 종합",
      status: strongSignalEligible ? "matched" : quality.state === "DATA_UNTRUSTED" ? "unverified" : "not_matched",
      source: `scanner-${strategyMode}-engine`,
      observedAt: input.card.observedAt,
      reasons: quant.reasons
    },
    {
      key: "data-quality",
      label: "Data Quality Gate",
      status: quality.state === "TRUSTED" ? "matched" : quality.state === "DEGRADED" ? "not_matched" : "unverified",
      source: "scanner-data-quality-gate",
      observedAt: quality.lastTimestamp,
      reasons: quality.issues.length ? quality.issues.map((issue) => `${issue.code}: ${issue.message}`) : [`최근 ${qualityCandles.length}개 전략 관련 캔들의 timestamp·OHLC·volume·gap·duplicate 검증을 통과했습니다.`]
    }
  ];
  const hardened = {
    ...input.card,
    direction: quant.direction,
    pricePlan: pricePlan2,
    score: quant.score,
    confidence,
    dataCompleteness,
    dataState,
    strongSignalEligible,
    strategyMode,
    signalGrade: quant.grade,
    dataQuality: {
      state: quality.state,
      score: quality.score,
      strongSignalAllowed: quality.strongSignalAllowed,
      issues: quality.issues
    },
    quantScore: quant.factors,
    aiValidation: quant.aiValidation,
    warnings: [...new Set(warnings)],
    evidence,
    matched: evidenceLabels(evidence, "matched"),
    notMatched: evidenceLabels(evidence, "not_matched"),
    unverified: evidenceLabels(evidence, "unverified")
  };
  const futuresContext = futuresPublicContext(hardened);
  return applyScannerMarketProfile({
    card: hardened,
    profile: marketProfileFor(hardened),
    candles: input.candles,
    strategyMode,
    fundingRate: futuresContext.fundingRate,
    openInterest: futuresContext.openInterest
  });
}

// src/services/crypto-signal-scanner.service.ts
var UPBIT_BASE = "https://api.upbit.com";
var BITGET_BASE = "https://api.bitget.com";
var BITGET_PRODUCT_TYPE = "USDT-FUTURES";
var DEADLINE_MS = 12e3;
var ITEM_TIMEOUT_MS = 3500;
var CONCURRENCY = 5;
var MAX_BATCH_SIZE = 40;
var CACHE_TTL_MS = 5 * 6e4;
var CryptoScannerProviderError = class extends Error {
  code = "CRYPTO_SCAN_PROVIDER_ERROR";
  constructor(message) {
    super(message);
    this.name = "CryptoScannerProviderError";
  }
};
function clamp4(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}
function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function finite8(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function average2(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function linkedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("CRYPTO_PROVIDER_TIMEOUT")),
    timeoutMs
  );
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    }
  };
}
async function fetchJson(url, signal, timeoutMs = ITEM_TIMEOUT_MS) {
  const linked = linkedSignal(signal, timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "seungjae-signal-scanner/1.0" },
      signal: linked.signal
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    linked.clear();
  }
}
function normalizeCandles(rows, now) {
  const futureLimit = now + 6e4;
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.time) || row.time <= 0 || row.time > futureLimit) continue;
    if (![row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value) && value > 0)) continue;
    if (!Number.isFinite(row.volume) || row.volume < 0) continue;
    map.set(row.time, {
      ...row,
      high: Math.max(row.high, row.open, row.close),
      low: Math.min(row.low, row.open, row.close),
      quoteVolume: row.quoteVolume != null && Number.isFinite(row.quoteVolume) && row.quoteVolume >= 0 ? row.quoteVolume : null
    });
  }
  return [...map.values()].sort((left, right) => left.time - right.time);
}
function spotCandlePath(symbol, timeframe) {
  const market = encodeURIComponent(`KRW-${symbol}`);
  if (timeframe === "1D") return `/v1/candles/days?market=${market}&count=200`;
  const unit = timeframe === "4H" ? 240 : timeframe === "60m" ? 60 : timeframe === "15m" ? 15 : timeframe === "5m" ? 5 : timeframe === "3m" ? 3 : 1;
  return `/v1/candles/minutes/${unit}?market=${market}&count=200`;
}
function bitgetGranularity(timeframe) {
  return timeframe === "60m" ? "1H" : timeframe;
}
async function defaultSpotUniverse(signal) {
  const markets = await fetchJson(`${UPBIT_BASE}/v1/market/all?isDetails=true`, signal, 8e3);
  const listed = markets.map((row) => ({
    market: text(row.market),
    name: text(row.korean_name),
    warning: text(row.market_warning || "NONE") !== "NONE"
  })).filter((row) => row.market.startsWith("KRW-")).map((row) => ({ ...row, symbol: row.market.replace(/^KRW-/, "") }));
  const chunks = [];
  for (let index = 0; index < listed.length; index += 100) chunks.push(listed.slice(index, index + 100));
  const tickerRows = [];
  let providerErrorCount = 0;
  for (const chunk of chunks) {
    try {
      const rows2 = await fetchJson(
        `${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(chunk.map((row) => row.market).join(","))}`,
        signal,
        8e3
      );
      tickerRows.push(...rows2);
    } catch (error) {
      if (signal?.aborted) throw error;
      providerErrorCount += 1;
    }
  }
  const names = new Map(listed.map((row) => [row.market, row]));
  const rows = tickerRows.map((row) => {
    const market = text(row.market);
    const meta = names.get(market);
    const price = finite8(row.trade_price);
    if (!meta || price == null || price <= 0) return null;
    return {
      symbol: meta.symbol,
      name: meta.name || meta.symbol,
      price,
      changePercent: (finite8(row.signed_change_rate) ?? 0) * 100,
      volume: finite8(row.acc_trade_volume_24h) ?? 0,
      tradingValue: finite8(row.acc_trade_price_24h) ?? 0,
      bid: null,
      ask: null,
      fundingRate: null,
      openInterest: null,
      timestamp: finite8(row.timestamp),
      warning: meta.warning
    };
  }).filter((row) => row != null).sort((left, right) => right.tradingValue - left.tradingValue || left.symbol.localeCompare(right.symbol));
  if (!rows.length) throw new CryptoScannerProviderError("UPBIT_TICKERS_UNAVAILABLE");
  return { rows, source: "upbit-public", providerErrorCount };
}
async function defaultFuturesUniverse(signal) {
  const payload = await fetchJson(
    `${BITGET_BASE}/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}`,
    signal,
    8e3
  );
  if (text(payload.code) !== "00000" || !Array.isArray(payload.data)) {
    throw new CryptoScannerProviderError(`BITGET_${text(payload.code) || "INVALID"}`);
  }
  const newest = /* @__PURE__ */ new Map();
  for (const row of payload.data) {
    const symbol = text(row.symbol).toUpperCase();
    const price = finite8(row.markPrice ?? row.lastPr);
    if (!symbol || price == null || price <= 0) continue;
    const timestamp4 = finite8(row.ts);
    const item = {
      symbol,
      name: symbol,
      price,
      changePercent: (finite8(row.change24h) ?? 0) * 100,
      volume: finite8(row.baseVolume) ?? 0,
      tradingValue: finite8(row.usdtVolume) ?? 0,
      bid: finite8(row.bidPr),
      ask: finite8(row.askPr),
      fundingRate: finite8(row.fundingRate),
      openInterest: finite8(row.holdingAmount),
      timestamp: timestamp4,
      warning: false
    };
    const previous = newest.get(symbol);
    if (!previous || (timestamp4 ?? 0) >= (previous.timestamp ?? 0)) newest.set(symbol, item);
  }
  const rows = [...newest.values()].sort((left, right) => right.tradingValue - left.tradingValue || left.symbol.localeCompare(right.symbol));
  if (!rows.length) throw new CryptoScannerProviderError("BITGET_TICKERS_UNAVAILABLE");
  return { rows, source: "bitget-public", providerErrorCount: 0 };
}
var defaultProviders = {
  async getUniverse(market, signal) {
    return market === "spot" ? defaultSpotUniverse(signal) : defaultFuturesUniverse(signal);
  },
  async getCandles(market, symbol, timeframe, signal) {
    if (market === "spot") {
      const rows = await fetchJson(`${UPBIT_BASE}${spotCandlePath(symbol, timeframe)}`, signal);
      return normalizeCandles(rows.map((row) => ({
        time: finite8(row.timestamp) ?? Date.parse(text(row.candle_date_time_utc)),
        open: finite8(row.opening_price) ?? Number.NaN,
        high: finite8(row.high_price) ?? Number.NaN,
        low: finite8(row.low_price) ?? Number.NaN,
        close: finite8(row.trade_price) ?? Number.NaN,
        volume: finite8(row.candle_acc_trade_volume) ?? Number.NaN,
        quoteVolume: finite8(row.candle_acc_trade_price)
      })), Date.now());
    }
    const payload = await fetchJson(
      `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&granularity=${encodeURIComponent(bitgetGranularity(timeframe))}&limit=200`,
      signal
    );
    if (text(payload.code) !== "00000" || !Array.isArray(payload.data)) {
      throw new Error(`BITGET_${text(payload.code) || "INVALID"}`);
    }
    const candles = [];
    for (const raw of payload.data) {
      if (!Array.isArray(raw)) continue;
      candles.push({
        time: finite8(raw[0]) ?? Number.NaN,
        open: finite8(raw[1]) ?? Number.NaN,
        high: finite8(raw[2]) ?? Number.NaN,
        low: finite8(raw[3]) ?? Number.NaN,
        close: finite8(raw[4]) ?? Number.NaN,
        volume: finite8(raw[5]) ?? Number.NaN,
        quoteVolume: finite8(raw[6])
      });
    }
    return normalizeCandles(candles, Date.now());
  },
  async getSpread(market, ticker, signal) {
    if (market === "futures") return { bid: ticker.bid, ask: ticker.ask };
    const rows = await fetchJson(
      `${UPBIT_BASE}/v1/orderbook?markets=${encodeURIComponent(`KRW-${ticker.symbol}`)}&level=0`,
      signal
    );
    const unit = rows[0]?.orderbook_units?.[0];
    return { bid: finite8(unit?.bid_price), ask: finite8(unit?.ask_price) };
  },
  now: Date.now
};
function sma(values, period) {
  return values.length >= period ? average2(values.slice(-period)) : null;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const difference = values[index] - values[index - 1];
    if (difference >= 0) gain += difference;
    else loss += Math.abs(difference);
  }
  if (loss === 0) return 100;
  const ratio = gain / loss;
  return 100 - 100 / (1 + ratio);
}
function atr(candles, period = 14) {
  if (candles.length < 2) return null;
  const rows = candles.slice(-Math.min(period + 1, candles.length));
  const ranges = [];
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  return average2(ranges);
}
function staleAfter(timeframe) {
  if (timeframe === "1m") return 5 * 6e4;
  if (timeframe === "3m") return 12 * 6e4;
  if (timeframe === "5m") return 20 * 6e4;
  if (timeframe === "15m") return 45 * 6e4;
  if (timeframe === "60m") return 3 * 60 * 6e4;
  if (timeframe === "4H") return 12 * 60 * 6e4;
  return 3 * 24 * 60 * 6e4;
}
function expiry(timeframe, now) {
  const ttl = timeframe === "1m" ? 3 * 6e4 : timeframe === "3m" ? 9 * 6e4 : timeframe === "5m" ? 15 * 6e4 : timeframe === "15m" ? 45 * 6e4 : timeframe === "60m" ? 3 * 60 * 6e4 : timeframe === "4H" ? 12 * 60 * 6e4 : 3 * 24 * 60 * 6e4;
  return new Date(now + ttl).toISOString();
}
function pricePlan(ticker, candles, direction, market) {
  const currentAtr = atr(candles);
  const empty = {
    pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
    volatilityPercent: currentAtr != null && ticker.price > 0 ? round(currentAtr / ticker.price * 100) : null
  };
  if (currentAtr == null || currentAtr <= 0 || candles.length < 20 || direction === "NEUTRAL") return empty;
  const recent = candles.slice(-20);
  const support = Math.min(...recent.map((row) => row.low));
  const resistance = Math.max(...recent.map((row) => row.high));
  const digits = market === "spot" ? ticker.price >= 1e3 ? 0 : ticker.price >= 1 ? 4 : 8 : ticker.price >= 1 ? 4 : 8;
  const format = (value) => round(Math.max(0, value), digits);
  if (direction === "LONG") {
    const stop2 = Math.min(support - currentAtr * 0.1, ticker.price - Math.max(currentAtr * 1.25, ticker.price * 8e-3));
    const risk2 = ticker.price - stop2;
    if (!(risk2 > 0)) return empty;
    const target12 = Math.max(resistance, ticker.price + risk2 * 1.5);
    return {
      pricePlan: {
        entryZone: { from: format(Math.max(support, ticker.price - currentAtr * 0.35)), to: format(ticker.price) },
        invalidation: format(stop2),
        stopLoss: format(stop2),
        targets: [format(target12), format(ticker.price + risk2 * 2.2)],
        riskReward: round((target12 - ticker.price) / risk2)
      },
      volatilityPercent: round(currentAtr / ticker.price * 100)
    };
  }
  const stop = Math.max(resistance + currentAtr * 0.1, ticker.price + Math.max(currentAtr * 1.25, ticker.price * 8e-3));
  const risk = stop - ticker.price;
  if (!(risk > 0)) return empty;
  const target1 = Math.min(support, ticker.price - risk * 1.5);
  return {
    pricePlan: {
      entryZone: { from: format(ticker.price), to: format(Math.min(resistance, ticker.price + currentAtr * 0.35)) },
      invalidation: format(stop),
      stopLoss: format(stop),
      targets: [format(target1), format(Math.max(0, ticker.price - risk * 2.2))],
      riskReward: round((ticker.price - target1) / risk)
    },
    volatilityPercent: round(currentAtr / ticker.price * 100)
  };
}
function signalId(request, ticker, direction) {
  const digest2 = createHash4("sha256").update([
    request.memberId,
    request.market,
    ticker.symbol,
    direction,
    request.strategyMode ?? scannerStrategyForTimeframe(request.timeframe),
    request.timeframe,
    request.condition
  ].join(":")).digest("hex").slice(0, 24);
  return `signal:${digest2}`;
}
function analyze(request, ticker, candles, spread, now) {
  const closes = candles.map((row) => row.close);
  const latest = candles.at(-1);
  if (!latest || closes.length < 5) return null;
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const currentRsi = rsi(closes);
  const currentAtr = atr(candles);
  const baselineVolume = average2(candles.slice(-21, -1).map((row) => row.volume));
  const volumeRatio = baselineVolume != null && baselineVolume > 0 ? latest.volume / baselineVolume : null;
  const prior = candles.slice(-21, -1);
  const resistance = prior.length ? Math.max(...prior.map((row) => row.high)) : null;
  const support = prior.length ? Math.min(...prior.map((row) => row.low)) : null;
  const breakout = resistance != null && ticker.price >= resistance;
  const supportBreak = support != null && ticker.price <= support;
  const pullbackLong = ma20 != null && ma5 != null && ma5 > ma20 && ticker.price >= ma20 * 0.98 && ticker.price <= ma20 * 1.03;
  const pullbackShort = ma20 != null && ma5 != null && ma5 < ma20 && ticker.price <= ma20 * 1.02 && ticker.price >= ma20 * 0.97;
  const mid = spread.bid != null && spread.ask != null && spread.bid > 0 && spread.ask >= spread.bid ? (spread.bid + spread.ask) / 2 : null;
  const spreadPercent2 = mid != null && spread.ask != null && spread.bid != null ? (spread.ask - spread.bid) / mid * 100 : null;
  const volatilityPercent = currentAtr != null ? currentAtr / ticker.price * 100 : null;
  const stale = now - latest.time > staleAfter(request.timeframe) || ticker.timestamp != null && now - ticker.timestamp > 10 * 6e4;
  let longScore = 35;
  let shortScore = 35;
  const longReasons = [];
  const shortReasons = [];
  if (ma20 != null) {
    if (ticker.price > ma20) {
      longScore += 15;
      longReasons.push("현재가가 20기간 평균 위");
    } else {
      shortScore += 15;
      shortReasons.push("현재가가 20기간 평균 아래");
    }
  }
  if (ma5 != null && ma20 != null) {
    if (ma5 > ma20) {
      longScore += 12;
      longReasons.push("단기 평균이 중기 평균 위");
    } else if (ma5 < ma20) {
      shortScore += 12;
      shortReasons.push("단기 평균이 중기 평균 아래");
    }
  }
  if (currentRsi != null) {
    if (currentRsi >= 45 && currentRsi <= 68) {
      longScore += 8;
      longReasons.push(`RSI ${currentRsi.toFixed(1)} 상승 여유`);
    }
    if (currentRsi <= 35) {
      longScore += 6;
      longReasons.push(`RSI ${currentRsi.toFixed(1)} 과매도 반등 관찰`);
    }
    if (currentRsi >= 72) {
      shortScore += 7;
      shortReasons.push(`RSI ${currentRsi.toFixed(1)} 과열`);
    }
  }
  if (volumeRatio != null && volumeRatio >= 1.3) {
    if (latest.close >= latest.open) {
      longScore += 10;
      longReasons.push(`거래량 ${volumeRatio.toFixed(2)}배 양봉`);
    } else {
      shortScore += 10;
      shortReasons.push(`거래량 ${volumeRatio.toFixed(2)}배 음봉`);
    }
  }
  if (breakout) {
    longScore += 12;
    longReasons.push("20기간 고가 돌파");
  }
  if (supportBreak) {
    shortScore += 12;
    shortReasons.push("20기간 저가 이탈");
  }
  if (ticker.changePercent > 0) longScore += Math.min(6, ticker.changePercent / 2);
  if (ticker.changePercent < 0) shortScore += Math.min(6, Math.abs(ticker.changePercent) / 2);
  if (request.market === "futures" && ticker.fundingRate != null) {
    if (ticker.fundingRate > 6e-4) {
      shortScore += 4;
      shortReasons.push("양(+) 펀딩 과열");
    }
    if (ticker.fundingRate < -6e-4) {
      longScore += 4;
      longReasons.push("음(-) 펀딩 과열");
    }
  }
  longScore = Math.round(clamp4(longScore));
  shortScore = Math.round(clamp4(shortScore));
  const conditionMatched = request.condition === "volume" ? volumeRatio != null && volumeRatio >= 1.3 : request.condition === "breakout" ? breakout || request.market === "futures" && supportBreak : request.condition === "pullback" ? pullbackLong || request.market === "futures" && pullbackShort : ma5 != null && ma20 != null && ma5 !== ma20;
  let direction = "NEUTRAL";
  if (request.market === "spot") {
    if (longScore >= 70 && conditionMatched) direction = "LONG";
  } else if (conditionMatched) {
    if (longScore >= 70 && longScore - shortScore >= 10) direction = "LONG";
    else if (shortScore >= 70 && shortScore - longScore >= 10) direction = "SHORT";
  }
  let dataCompleteness = 0;
  if (request.market === "spot") {
    dataCompleteness += ticker.price > 0 ? 15 : 0;
    dataCompleteness += candles.length >= 30 ? 30 : Math.min(20, candles.length / 30 * 20);
    dataCompleteness += ticker.volume > 0 && ticker.tradingValue > 0 ? 15 : 0;
    dataCompleteness += !stale ? 15 : 0;
    dataCompleteness += spreadPercent2 != null ? 15 : 0;
    dataCompleteness += conditionMatched ? 10 : 0;
  } else {
    dataCompleteness += ticker.price > 0 ? 10 : 0;
    dataCompleteness += candles.length >= 30 ? 25 : Math.min(18, candles.length / 30 * 18);
    dataCompleteness += ticker.volume > 0 && ticker.tradingValue > 0 ? 10 : 0;
    dataCompleteness += !stale ? 15 : 0;
    dataCompleteness += spreadPercent2 != null ? 10 : 0;
    dataCompleteness += ticker.fundingRate != null ? 10 : 0;
    dataCompleteness += ticker.openInterest != null && ticker.openInterest > 0 ? 10 : 0;
    dataCompleteness += conditionMatched ? 10 : 0;
  }
  dataCompleteness = Math.round(clamp4(dataCompleteness));
  let riskScore = 0;
  if (spreadPercent2 == null) riskScore += 20;
  else if (spreadPercent2 > 0.6) riskScore += 35;
  else if (spreadPercent2 > 0.25) riskScore += 18;
  if (volatilityPercent == null) riskScore += 15;
  else if (volatilityPercent > 6) riskScore += 30;
  else if (volatilityPercent > 3) riskScore += 15;
  if (Math.abs(ticker.changePercent) > 25) riskScore += 30;
  else if (Math.abs(ticker.changePercent) > 12) riskScore += 15;
  if (ticker.warning) riskScore += 45;
  if (stale) riskScore += 30;
  const liquidityFloor = request.market === "spot" ? 1e9 : 5e6;
  if (ticker.tradingValue < liquidityFloor) riskScore += 20;
  if (request.market === "futures" && ticker.fundingRate != null && Math.abs(ticker.fundingRate) > 1e-3) riskScore += 15;
  riskScore = Math.round(clamp4(riskScore));
  const strongest = Math.max(longScore, shortScore);
  let scoreCap = 100;
  if (dataCompleteness < 50) scoreCap = 49;
  else if (dataCompleteness < 65) scoreCap = 59;
  else if (dataCompleteness < 80) scoreCap = 69;
  if (stale) scoreCap = Math.min(scoreCap, 49);
  if (riskScore > 60) scoreCap = Math.min(scoreCap, 64);
  const score = Math.round(Math.min(strongest, scoreCap));
  const scoreGap = Math.abs(longScore - shortScore);
  const confidence = Math.round(Math.min(
    dataCompleteness,
    scoreGap >= 20 ? 90 : scoreGap >= 10 ? 75 : 55,
    stale ? 49 : 100
  ));
  const dataState = stale ? "stale" : candles.length < 20 ? "insufficient" : dataCompleteness < 80 ? "partial" : "complete";
  const observedTimestamp = Math.max(latest.time, ticker.timestamp ?? 0);
  const observedAt = new Date(observedTimestamp).toISOString();
  const conditionLabel = request.condition === "volume" ? "거래량 증가" : request.condition === "breakout" ? "돌파·이탈" : request.condition === "pullback" ? "눌림·반등 실패" : "추세 일치";
  const evidence = [
    {
      key: request.condition,
      label: conditionLabel,
      status: conditionMatched ? "matched" : "not_matched",
      source: "public-candles",
      observedAt,
      reasons: conditionMatched ? ["선택한 기술 조건을 실제 캔들로 확인했습니다."] : ["선택한 기술 조건을 충족하지 않았습니다."]
    },
    {
      key: "volume",
      label: "거래량",
      status: volumeRatio == null ? "unverified" : volumeRatio >= 1.3 ? "matched" : "not_matched",
      source: "public-candles",
      observedAt,
      reasons: [volumeRatio == null ? "평균 거래량을 계산할 봉이 부족합니다." : `최근 평균 대비 ${volumeRatio.toFixed(2)}배`]
    },
    {
      key: "liquidity",
      label: "유동성·거래대금",
      status: ticker.tradingValue > 0 ? "matched" : "unverified",
      source: request.market === "spot" ? "upbit-public-ticker" : "bitget-public-ticker",
      observedAt,
      reasons: [ticker.tradingValue > 0 ? `24시간 거래대금 ${round(ticker.tradingValue, 2)}` : "거래대금 데이터가 없습니다."]
    },
    {
      key: "spread",
      label: "스프레드",
      status: spreadPercent2 == null ? "unverified" : spreadPercent2 <= 0.25 ? "matched" : "not_matched",
      source: request.market === "spot" ? "upbit-public-orderbook" : "bitget-public-ticker",
      observedAt,
      reasons: [spreadPercent2 == null ? "호가 스프레드를 확인하지 못했습니다." : `스프레드 ${spreadPercent2.toFixed(3)}%`]
    },
    {
      key: "risk",
      label: "변동성·추격 위험",
      status: riskScore <= 45 ? "matched" : "not_matched",
      source: "deterministic-risk-policy",
      observedAt,
      reasons: [`위험 점수 ${riskScore}`, volatilityPercent == null ? "ATR 미확인" : `ATR 변동성 ${volatilityPercent.toFixed(2)}%`]
    }
  ];
  if (request.market === "futures") {
    evidence.push({
      key: "funding-open-interest",
      label: "펀딩비·미결제약정",
      status: ticker.fundingRate != null && ticker.openInterest != null ? "matched" : "unverified",
      source: "bitget-public-ticker",
      observedAt,
      reasons: [
        ticker.fundingRate == null ? "펀딩비 미확인" : `펀딩비 ${(ticker.fundingRate * 100).toFixed(4)}%`,
        ticker.openInterest == null ? "미결제약정 미확인" : `미결제약정 ${round(ticker.openInterest, 2)}`
      ]
    });
  }
  const technicalPlan = pricePlan(ticker, candles, direction, request.market);
  const strongSignalEligible = direction !== "NEUTRAL" && conditionMatched && score >= 75 && confidence >= 70 && dataCompleteness >= 80 && riskScore <= 45 && dataState === "complete" && technicalPlan.pricePlan.riskReward != null && technicalPlan.pricePlan.riskReward >= 1.5;
  const warnings = [];
  if (stale) warnings.push("시세 또는 캔들이 오래됐습니다.");
  if (ticker.warning) warnings.push("업비트 유의 종목입니다.");
  if (Math.abs(ticker.changePercent) > 12) warnings.push("24시간 급변으로 추격 위험이 큽니다.");
  if (spreadPercent2 == null) warnings.push("스프레드 미확인");
  if (request.market === "spot") warnings.push("현물 Scanner에는 숏·레버리지를 적용하지 않습니다.");
  const selectedReasons = direction === "SHORT" ? shortReasons : longReasons;
  return {
    signalId: signalId(request, ticker, direction),
    assetClass: request.market === "spot" ? "coin_spot" : "coin_futures",
    market: request.market === "spot" ? "UPBIT_KRW" : "BITGET_USDT_FUTURES",
    exchange: request.market === "spot" ? "UPBIT" : "BITGET",
    symbol: ticker.symbol,
    name: ticker.name,
    currency: request.market === "spot" ? "KRW" : "USDT",
    assetType: request.market === "spot" ? "CRYPTO_SPOT" : "CRYPTO_FUTURES",
    listingStatus: "LISTED",
    price: ticker.price,
    changePercent: ticker.changePercent,
    direction,
    signalState: strongSignalEligible ? "WATCHING" : "DETECTED",
    score,
    confidence,
    dataCompleteness,
    riskScore,
    riskLevel: riskScore >= 60 ? "HIGH" : riskScore >= 30 ? "MEDIUM" : "LOW",
    liquidity: ticker.tradingValue,
    volume: ticker.volume,
    tradingValue: ticker.tradingValue,
    spreadPercent: spreadPercent2 == null ? null : round(spreadPercent2, 4),
    volatilityPercent: technicalPlan.volatilityPercent,
    matched: evidence.filter((item) => item.status === "matched").map((item) => item.label),
    notMatched: evidence.filter((item) => item.status === "not_matched").map((item) => item.label),
    unverified: evidence.filter((item) => item.status === "unverified").map((item) => item.label),
    evidence: evidence.map((item) => item.key === request.condition && selectedReasons.length ? { ...item, reasons: selectedReasons.slice(0, 6) } : item),
    pricePlan: technicalPlan.pricePlan,
    dataState,
    dataSources: request.market === "spot" ? ["upbit-public-market", "upbit-public-ticker", "upbit-public-candles", "upbit-public-orderbook"] : ["bitget-public-ticker", "bitget-public-candles"],
    observedAt,
    expiresAt: expiry(request.timeframe, now),
    strongSignalEligible,
    warnings
  };
}
function cacheKey(request) {
  return [
    request.memberId,
    request.market,
    request.strategyMode ?? scannerStrategyForTimeframe(request.timeframe),
    request.timeframe,
    request.condition,
    request.cursor,
    request.batchSize
  ].join(":");
}
function staleFallback(response, message, now) {
  return {
    ...response,
    requestId: randomUUID(),
    cards: response.cards.map((card) => ({
      ...card,
      score: Math.min(card.score, 49),
      confidence: Math.min(card.confidence, 49),
      dataState: "stale",
      signalState: "INVALIDATED",
      strongSignalEligible: false,
      dataQuality: card.dataQuality ? {
        ...card.dataQuality,
        state: "DATA_UNTRUSTED",
        score: Math.min(card.dataQuality.score, 49),
        strongSignalAllowed: false,
        issues: [
          ...card.dataQuality.issues,
          {
            code: "STALE_TIMESTAMP",
            severity: "blocking",
            message: "공급자 장애로 마지막 정상 결과를 stale fallback으로 사용합니다."
          }
        ]
      } : card.dataQuality,
      warnings: [.../* @__PURE__ */ new Set([...card.warnings, "마지막 정상 결과 fallback"])]
    })),
    alerts: [],
    failures: [{ symbol: "*", reason: "provider_error", message }],
    execution: {
      ...response.execution,
      providerErrorCount: response.execution.providerErrorCount + 1,
      partial: true,
      timedOut: false,
      cancelled: false
    },
    universe: { ...response.universe, partial: true, stale: true, source: "last-good-cache" },
    dataState: "stale",
    message,
    generatedAt: new Date(now).toISOString(),
    orderSubmitted: false,
    exchangeRequestSent: false
  };
}
function createCryptoSignalScannerService(providers = defaultProviders) {
  const lastGood = /* @__PURE__ */ new Map();
  return {
    clearCache() {
      lastGood.clear();
    },
    async scan(request) {
      const startedAt = providers.now();
      const strategyMode = request.strategyMode ?? scannerStrategyForTimeframe(request.timeframe);
      const contextTimeframe = scannerContextTimeframe(strategyMode);
      const key = cacheKey({ ...request, strategyMode });
      let universe;
      try {
        universe = await providers.getUniverse(request.market, request.signal);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const cached = lastGood.get(key);
        if (cached && providers.now() - cached.at <= CACHE_TTL_MS) {
          return staleFallback(cached.response, "공급자 오류로 마지막 정상 Scanner 결과를 stale 상태로 표시합니다.", providers.now());
        }
        throw error instanceof CryptoScannerProviderError ? error : new CryptoScannerProviderError(error instanceof Error ? error.message : "CRYPTO_UNIVERSE_UNAVAILABLE");
      }
      const batchSize = Math.max(5, Math.min(MAX_BATCH_SIZE, Math.floor(request.batchSize) || 24));
      const cursor = Math.max(0, Math.min(universe.rows.length, Math.floor(request.cursor) || 0));
      const batch = universe.rows.slice(cursor, cursor + batchSize);
      const nextCursor = cursor + batch.length < universe.rows.length ? cursor + batch.length : null;
      const work = await runBoundedWorkPool(
        batch,
        async (ticker, _index, signal) => {
          const [candles, contextCandles, spread] = await Promise.all([
            providers.getCandles(request.market, ticker.symbol, request.timeframe, signal),
            request.timeframe === contextTimeframe ? Promise.resolve(null) : providers.getCandles(request.market, ticker.symbol, contextTimeframe, signal).catch(() => []),
            providers.getSpread(request.market, ticker, signal)
          ]);
          const candidate = analyze(
            { ...request, strategyMode },
            { ...ticker, ...spread },
            candles,
            spread,
            providers.now()
          );
          if (!candidate) return null;
          return applyScannerQuantHardening({
            card: candidate,
            timeframe: request.timeframe,
            candles,
            contextCandles: contextCandles ?? candles,
            strategyMode,
            allowShort: request.market === "futures",
            now: providers.now()
          });
        },
        {
          concurrency: CONCURRENCY,
          deadlineMs: DEADLINE_MS,
          itemTimeoutMs: ITEM_TIMEOUT_MS,
          signal: request.signal,
          now: providers.now
        }
      );
      if (request.signal?.aborted || work.aborted) throw request.signal?.reason ?? new Error("CRYPTO_SCAN_ABORTED");
      const failures = work.outcomes.filter((outcome) => outcome.status !== "fulfilled" || outcome.value == null).map((outcome) => ({
        symbol: batch[outcome.index]?.symbol ?? "UNKNOWN",
        reason: outcome.status === "timed_out" ? "timeout" : outcome.status === "rejected" ? "provider_error" : "invalid_data",
        message: outcome.status === "timed_out" ? `종목별 ${ITEM_TIMEOUT_MS}ms timeout` : outcome.reason instanceof Error ? outcome.reason.message.slice(0, 180) : "유효한 캔들·시세를 만들지 못했습니다."
      }));
      const cards = work.outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value != null).map((outcome) => outcome.value).filter((card) => request.minimumScore == null || card.score >= request.minimumScore).filter((card) => request.maximumRiskScore == null || card.riskScore != null && card.riskScore <= request.maximumRiskScore).sort((left, right) => right.score - left.score || right.confidence - left.confidence || right.dataCompleteness - left.dataCompleteness || (right.tradingValue ?? -1) - (left.tradingValue ?? -1) || left.symbol.localeCompare(right.symbol));
      const lifecycle = applyScannerSignalLifecycle(request.memberId, cards, providers.now());
      const partial = work.deadlineReached || work.startedCount < batch.length || work.rejectedCount > 0 || work.timedOutCount > 0 || universe.providerErrorCount > 0;
      const timedOut = work.deadlineReached || work.timedOutCount > 0;
      if (batch.length > 0 && work.fulfilledCount === 0) {
        const cached = lastGood.get(key);
        if (cached && providers.now() - cached.at <= CACHE_TTL_MS) {
          return staleFallback(cached.response, "모든 종목 분석이 실패해 마지막 정상 결과를 stale 상태로 표시합니다.", providers.now());
        }
        throw new CryptoScannerProviderError("CRYPTO_BATCH_UNAVAILABLE");
      }
      const hasUntrusted = lifecycle.cards.some((card) => card.dataQuality?.state === "DATA_UNTRUSTED");
      const response = {
        ok: true,
        requestId: randomUUID(),
        assetClass: request.market === "spot" ? "coin_spot" : "coin_futures",
        market: request.market === "spot" ? "UPBIT_KRW" : "BITGET_USDT_FUTURES",
        timeframe: request.timeframe,
        cards: lifecycle.cards,
        alerts: lifecycle.alerts,
        failures,
        execution: {
          requestedCount: batch.length,
          startedCount: work.startedCount,
          completedCount: work.fulfilledCount,
          excludedCount: Math.max(0, work.fulfilledCount - lifecycle.cards.length),
          providerErrorCount: work.rejectedCount + universe.providerErrorCount,
          timeoutCount: work.timedOutCount,
          partial,
          timedOut,
          cancelled: false,
          duplicate: false,
          elapsedMs: Math.max(work.elapsedMs, providers.now() - startedAt),
          deadlineMs: DEADLINE_MS,
          itemTimeoutMs: ITEM_TIMEOUT_MS,
          maxConcurrency: work.maxConcurrency
        },
        universe: {
          totalCount: universe.rows.length,
          cursor,
          nextCursor,
          source: universe.source,
          partial: universe.providerErrorCount > 0,
          stale: false,
          listingStatusCoverage: "listed-or-unknown"
        },
        dataState: hasUntrusted ? "untrusted" : partial ? "partial" : "complete",
        message: hasUntrusted ? "Data Quality Gate가 신뢰할 수 없는 코인 데이터를 강한 신호에서 제외했습니다." : partial ? `공개 공급자 일부 지연으로 ${work.fulfilledCount}/${batch.length}종목의 확인된 결과를 표시합니다.` : lifecycle.cards.length ? `${work.fulfilledCount}종목 ${strategyMode === "scalping" ? "단타" : "스윙"} 공개 데이터 분석을 완료했습니다.` : "현재 묶음에서 선택 조건을 충족한 결과가 없습니다.",
        generatedAt: new Date(providers.now()).toISOString(),
        orderSubmitted: false,
        exchangeRequestSent: false
      };
      if (work.fulfilledCount > 0) lastGood.set(key, { at: providers.now(), response });
      return response;
    }
  };
}
var CryptoSignalScannerService = createCryptoSignalScannerService();

// src/services/market-price-precision.service.ts
var US_RULE_612_NEW_TICK_COMPLIANCE_AT = Date.UTC(2026, 10, 2);
function bitgetContractPriceTick(pricePlace, priceEndStep) {
  const places = Number(pricePlace);
  const endStep = Number(priceEndStep);
  if (!Number.isInteger(places) || places < 0 || places > 12) return null;
  if (!Number.isFinite(endStep) || endStep <= 0) return null;
  const tick = endStep * 10 ** -places;
  return Number.isFinite(tick) && tick > 0 ? tick : null;
}
function roundPriceToTick(value, tick) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(tick) || tick <= 0) return null;
  const rounded = Math.round(value / tick) * tick;
  const decimals = tick >= 1 ? 0 : Math.min(12, Math.max(0, Math.ceil(-Math.log10(tick)) + 2));
  const normalized = Number(rounded.toFixed(decimals));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

// src/services/scanner-crypto-price-precision.service.ts
var UPBIT_BASE2 = "https://api.upbit.com";
var BITGET_BASE2 = "https://api.bitget.com";
var BITGET_PRODUCT_TYPE2 = "USDT-FUTURES";
var PRECISION_TIMEOUT_MS = 2500;
var PRECISION_CACHE_TTL_MS = 5 * 6e4;
function emptyPricePlan() {
  return { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null };
}
function finite9(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function text2(value) {
  return typeof value === "string" ? value.trim() : "";
}
function linkedSignal2(parent) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("CRYPTO_PRECISION_TIMEOUT")),
    PRECISION_TIMEOUT_MS
  );
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    }
  };
}
async function fetchJson2(fetcher, url, signal) {
  const linked = linkedSignal2(signal);
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "seungjae-signal-scanner/1.0" },
      signal: linked.signal
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    linked.clear();
  }
}
function hasPricePlan(card) {
  return card.pricePlan.entryZone != null && card.pricePlan.stopLoss != null && card.pricePlan.invalidation != null && card.pricePlan.targets.length > 0 && card.pricePlan.riskReward != null;
}
function recomputeRiskReward(card, plan) {
  const stop = plan.stopLoss;
  const target = plan.targets[0] ?? null;
  if (stop == null || target == null || !(card.price > 0)) return null;
  if (card.direction === "LONG") {
    const risk = card.price - stop;
    const reward = target - card.price;
    return risk > 0 && reward > 0 ? Math.round(reward / risk * 100) / 100 : null;
  }
  if (card.direction === "SHORT") {
    const risk = stop - card.price;
    const reward = card.price - target;
    return risk > 0 && reward > 0 ? Math.round(reward / risk * 100) / 100 : null;
  }
  return null;
}
function snapPricePlan(card, tick) {
  const plan = card.pricePlan;
  if (!plan.entryZone || plan.stopLoss == null || plan.invalidation == null || plan.targets.length === 0) return null;
  const from = roundPriceToTick(plan.entryZone.from, tick);
  const to = roundPriceToTick(plan.entryZone.to, tick);
  const invalidation = roundPriceToTick(plan.invalidation, tick);
  const stopLoss = roundPriceToTick(plan.stopLoss, tick);
  const targets = plan.targets.map((value) => roundPriceToTick(value, tick)).filter((value) => value != null);
  if (from == null || to == null || invalidation == null || stopLoss == null || targets.length !== plan.targets.length) return null;
  const snapped = {
    entryZone: { from: Math.min(from, to), to: Math.max(from, to) },
    invalidation,
    stopLoss,
    targets,
    riskReward: null
  };
  snapped.riskReward = recomputeRiskReward(card, snapped);
  return snapped.riskReward != null ? snapped : null;
}
function cardWithPrecision(card, tick, source) {
  if (!hasPricePlan(card)) return { card, precisionMissing: false };
  const snapped = tick == null ? null : snapPricePlan(card, tick);
  if (!snapped) {
    return {
      precisionMissing: true,
      card: {
        ...card,
        pricePlan: emptyPricePlan(),
        strongSignalEligible: false,
        signalState: card.signalState === "WATCHING" ? "DETECTED" : card.signalState,
        warnings: [.../* @__PURE__ */ new Set([...card.warnings, "시장 가격 단위 데이터 부족"])]
      }
    };
  }
  return {
    precisionMissing: false,
    card: {
      ...card,
      pricePlan: snapped,
      dataSources: [.../* @__PURE__ */ new Set([...card.dataSources, source])]
    }
  };
}
function symbolKey(market, symbol) {
  return `${market}:${symbol.trim().toUpperCase()}`;
}
function uniqueSymbols(cards) {
  return [...new Set(cards.map((card) => card.symbol.trim().toUpperCase()).filter(Boolean))];
}
function createCryptoPricePrecisionService(fetcher = fetch) {
  const cache = /* @__PURE__ */ new Map();
  let upbitRefreshPromise = null;
  let bitgetRefreshPromise = null;
  const cachedTick = (market, symbol) => {
    const key = symbolKey(market, symbol);
    const row = cache.get(key);
    if (!row) return null;
    if (row.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return row.tick;
  };
  const cacheTick = (market, symbol, tick) => {
    cache.set(symbolKey(market, symbol), { tick, expiresAt: Date.now() + PRECISION_CACHE_TTL_MS });
  };
  const upbitTicks = async (cards, signal) => {
    const symbols = uniqueSymbols(cards);
    let missing = symbols.filter((symbol) => cachedTick("spot", symbol) == null);
    if (missing.length && upbitRefreshPromise) {
      await upbitRefreshPromise;
      missing = symbols.filter((symbol) => cachedTick("spot", symbol) == null);
    }
    if (missing.length) {
      const markets = missing.map((symbol) => `KRW-${symbol}`);
      upbitRefreshPromise = (async () => {
        const rows = await fetchJson2(
          fetcher,
          `${UPBIT_BASE2}/v1/orderbook/instruments?markets=${encodeURIComponent(markets.join(","))}`,
          signal
        );
        for (const row of rows) {
          const market = text2(row.market).toUpperCase();
          const tick = finite9(row.tick_size);
          if (market.startsWith("KRW-") && tick != null) cacheTick("spot", market.replace(/^KRW-/, ""), tick);
        }
      })();
      try {
        await upbitRefreshPromise;
      } finally {
        upbitRefreshPromise = null;
      }
    }
    const ticks = /* @__PURE__ */ new Map();
    for (const symbol of symbols) {
      const tick = cachedTick("spot", symbol);
      if (tick != null) ticks.set(symbol, tick);
    }
    return ticks;
  };
  const bitgetTicks = async (cards, signal) => {
    const symbols = uniqueSymbols(cards);
    let missing = symbols.filter((symbol) => cachedTick("futures", symbol) == null);
    if (missing.length && bitgetRefreshPromise) {
      await bitgetRefreshPromise;
      missing = symbols.filter((symbol) => cachedTick("futures", symbol) == null);
    }
    if (missing.length) {
      bitgetRefreshPromise = (async () => {
        const payload = await fetchJson2(
          fetcher,
          `${BITGET_BASE2}/api/v2/mix/market/contracts?productType=${BITGET_PRODUCT_TYPE2}`,
          signal
        );
        if (text2(payload.code) !== "00000" || !Array.isArray(payload.data)) {
          throw new Error(`BITGET_${text2(payload.code) || "INVALID"}`);
        }
        for (const row of payload.data) {
          const symbol = text2(row.symbol).toUpperCase();
          if (!symbol) continue;
          const tick = bitgetContractPriceTick(row.pricePlace, row.priceEndStep);
          if (tick != null) cacheTick("futures", symbol, tick);
        }
      })();
      try {
        await bitgetRefreshPromise;
      } finally {
        bitgetRefreshPromise = null;
      }
    }
    const ticks = /* @__PURE__ */ new Map();
    for (const symbol of symbols) {
      const tick = cachedTick("futures", symbol);
      if (tick != null) ticks.set(symbol, tick);
    }
    return ticks;
  };
  return {
    async align(market, response, signal) {
      const cardsRequiringPrecision = response.cards.filter(hasPricePlan);
      if (!cardsRequiringPrecision.length) return response;
      let ticks = /* @__PURE__ */ new Map();
      let precisionProviderError = false;
      try {
        ticks = market === "spot" ? await upbitTicks(cardsRequiringPrecision, signal) : await bitgetTicks(cardsRequiringPrecision, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        precisionProviderError = true;
      }
      const source = market === "spot" ? "upbit-public-orderbook-instruments" : "bitget-public-contracts";
      const alignedCards = response.cards.map((card) => cardWithPrecision(
        card,
        ticks.get(card.symbol.trim().toUpperCase()) ?? null,
        source
      ));
      const cards = alignedCards.map((item) => item.card);
      const missingPrecisionCount = alignedCards.filter((item) => item.precisionMissing).length;
      const precisionIncomplete = precisionProviderError || missingPrecisionCount > 0;
      return {
        ...response,
        cards,
        alerts: precisionIncomplete ? [] : response.alerts,
        execution: {
          ...response.execution,
          providerErrorCount: response.execution.providerErrorCount + (precisionProviderError ? 1 : 0),
          partial: response.execution.partial || precisionIncomplete
        },
        dataState: response.dataState === "complete" && precisionIncomplete ? "partial" : response.dataState,
        message: precisionProviderError ? "시장 가격 단위 공급자 응답이 없어 가격 계획을 비운 상태로 후보를 표시합니다." : missingPrecisionCount > 0 ? `${missingPrecisionCount}개 후보의 시장 가격 단위를 확인하지 못해 해당 가격 계획을 비웠습니다.` : response.message,
        orderSubmitted: false,
        exchangeRequestSent: false
      };
    }
  };
}
var CryptoPricePrecisionService = createCryptoPricePrecisionService();

// src/services/scanner-candidate-ranking.service.ts
var DEFAULT_SCANNER_RANKING_WEIGHTS = Object.freeze({
  oosWalkForwardWinRate: 25,
  expectancy: 25,
  profitFactor: 15,
  drawdown: 10,
  regime: 10,
  oosStability: 5,
  sampleConfidence: 5,
  liveSignal: 5
});
var GRADE_ORDER = { S: 5, A: 4, B: 3, C: 2, D: 1 };
function clamp5(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}
function round2(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function finite10(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function percentile(values, value) {
  if (!finite10(value) || !values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const belowOrEqual = ordered.filter((item) => item <= value).length;
  return round2(belowOrEqual / ordered.length * 100);
}
function scannerCandidateHardFilterReasons(card) {
  const reasons = [];
  if (!Number.isFinite(card.price) || card.price <= 0) reasons.push("비정상 가격");
  if (card.listingStatus !== "LISTED") reasons.push("거래가능 상장 상태 미확인");
  if (["stale", "insufficient", "unavailable", "untrusted"].includes(card.dataState)) reasons.push(`데이터 상태 ${card.dataState}`);
  if (card.dataQuality?.state === "DATA_UNTRUSTED") reasons.push("Data Quality Gate 차단");
  if (card.dataQuality?.issues.some((issue) => issue.severity === "blocking")) reasons.push("차단형 데이터 품질 이슈");
  if (finite10(card.spreadPercent) && card.spreadPercent > (card.assetClass === "stock" ? 1 : 0.8)) reasons.push("과도한 spread");
  if (finite10(card.tradingValue) && card.tradingValue <= 0) reasons.push("거래대금 부족");
  if (finite10(card.volume) && card.volume < 0) reasons.push("비정상 거래량");
  return [...new Set(reasons)];
}
function metricScore(backtest, weights) {
  const winRate = clamp5(((backtest.oosWinRate ?? 0) + (backtest.walkForwardWinRate ?? backtest.oosWinRate ?? 0)) / 2);
  const expectancy = clamp5(((backtest.expectancyPercent ?? -2) + 2) / 4 * 100);
  const pf = clamp5(((backtest.profitFactor ?? 0) - 0.8) / 1.2 * 100);
  const drawdown = clamp5(100 - Math.abs(backtest.maxDrawdownPercent ?? 100) * 4);
  const regime = clamp5(backtest.regimeScore ?? 0);
  const stability = clamp5(backtest.oosStabilityScore ?? 0);
  const sample = clamp5((backtest.tradeCount ?? 0) / Math.max(1, backtest.minimumTradeCount ?? 40) * 100);
  return round2(
    winRate * weights.oosWalkForwardWinRate / 100 + expectancy * weights.expectancy / 100 + pf * weights.profitFactor / 100 + drawdown * weights.drawdown / 100 + regime * weights.regime / 100 + stability * weights.oosStability / 100 + sample * weights.sampleConfidence / 100
  );
}
function passesMinimumBacktestQuality(summary) {
  if (summary.status !== "verified") return false;
  const minTrades = summary.minimumTradeCount ?? 40;
  return (summary.tradeCount ?? 0) >= minTrades && finite10(summary.expectancyPercent) && summary.expectancyPercent > 0 && finite10(summary.profitFactor) && summary.profitFactor >= 1.05 && finite10(summary.maxDrawdownPercent) && Math.abs(summary.maxDrawdownPercent) <= 25 && finite10(summary.netReturnPercent) && summary.netReturnPercent > 0 && summary.costsIncluded === true && summary.slippageIncluded === true && summary.lookaheadGuarded === true && summary.survivorshipGuarded === true && summary.oos === true && summary.walkForward === true;
}
function gradeCandidate(card, backtest) {
  if (!backtest || !passesMinimumBacktestQuality(backtest)) return "B";
  const risk = card.riskScore ?? 101;
  const trusted = card.dataQuality?.state === "TRUSTED" && card.dataQuality.strongSignalAllowed;
  const actionable = card.direction !== "NEUTRAL" && card.pricePlan.riskReward != null && card.pricePlan.riskReward >= 1.5;
  if (card.strongSignalEligible && trusted && actionable && card.score >= 88 && risk <= 35) return "S";
  if (trusted && actionable && card.score >= 72 && risk <= 50) return "A";
  return "B";
}
function watchReasons(card, backtest) {
  const reasons = [];
  if (!backtest || backtest.status !== "verified") reasons.push("OOS/Walk-forward 검증 데이터 필요");
  else if (!passesMinimumBacktestQuality(backtest)) reasons.push("최소 전략 품질 Gate 미충족");
  if (card.direction === "NEUTRAL") reasons.push("현재 방향성 진입 신호 확인 필요");
  if (card.notMatched.length) reasons.push(...card.notMatched.slice(0, 3));
  if (card.unverified.length) reasons.push(...card.unverified.slice(0, 2).map((item) => `${item} 확인 필요`));
  if (card.pricePlan.entryZone == null) reasons.push("진입 후보가 형성 필요");
  return [...new Set(reasons)].slice(0, 5);
}
function rankScannerCandidates(input) {
  const limit = Math.max(1, Math.min(10, input.limit ?? 10));
  const weights = input.weights ?? DEFAULT_SCANNER_RANKING_WEIGHTS;
  const softMinimumScore = finite10(input.softMinimumScore) ? clamp5(input.softMinimumScore) : null;
  const tradingValues = input.cards.map((card) => card.tradingValue).filter(finite10);
  const momentumValues = input.cards.map((card) => card.quantScore?.momentum).filter(finite10);
  const trendValues = input.cards.map((card) => card.quantScore?.trend).filter(finite10);
  const volumeValues = input.cards.map((card) => card.quantScore?.volume).filter(finite10);
  const volatilityValues = input.cards.map((card) => card.quantScore?.volatility).filter(finite10);
  let hardFilterRejectedCount = 0;
  let backtestMissingCount = 0;
  const ranked = input.cards.flatMap((card) => {
    const hardReasons = scannerCandidateHardFilterReasons(card);
    if (hardReasons.length) {
      hardFilterRejectedCount += 1;
      return [];
    }
    const backtest = input.backtests?.[card.symbol];
    if (!backtest || backtest.status !== "verified") backtestMissingCount += 1;
    const relative = {
      tradingValuePercentile: percentile(tradingValues, card.tradingValue),
      momentumPercentile: percentile(momentumValues, card.quantScore?.momentum),
      trendPercentile: percentile(trendValues, card.quantScore?.trend),
      volumePercentile: percentile(volumeValues, card.quantScore?.volume),
      volatilityPercentile: percentile(volatilityValues, card.quantScore?.volatility)
    };
    const relativeScore = round2(Object.values(relative).reduce((sum, value) => sum + value, 0) / 5);
    const backtestScore = backtest?.status === "verified" ? metricScore(backtest, weights) : null;
    const belowPreferencePenalty = softMinimumScore != null && card.score < softMinimumScore ? Math.min(25, (softMinimumScore - card.score) * 0.5) : 0;
    const liveSignalScore = clamp5(card.score - belowPreferencePenalty);
    const rankingScore = round2(
      (backtestScore ?? 0) * (100 - weights.liveSignal) / 100 + liveSignalScore * weights.liveSignal / 100 + relativeScore * 0.05
    );
    const signalGrade = gradeCandidate(card, backtest);
    const completion = Math.round(clamp5(card.matched.length / Math.max(1, card.matched.length + card.notMatched.length + card.unverified.length) * 100));
    const ranking = {
      rank: 0,
      score: rankingScore,
      relativeScore,
      relative,
      watchCompletionPercent: signalGrade === "B" ? completion : 100,
      watchReasons: signalGrade === "B" ? watchReasons(card, backtest) : [],
      hardFilterPassed: true,
      hardFilterReasons: []
    };
    return [{ ...card, signalGrade, backtestQuality: backtest ?? { status: "missing" }, candidateRanking: ranking }];
  });
  const cards = ranked.filter((card) => card.signalGrade === "S" || card.signalGrade === "A" || card.signalGrade === "B").sort((left, right) => GRADE_ORDER[right.signalGrade ?? "B"] - GRADE_ORDER[left.signalGrade ?? "B"] || (right.candidateRanking?.score ?? 0) - (left.candidateRanking?.score ?? 0) || right.score - left.score || right.confidence - left.confidence || left.symbol.localeCompare(right.symbol)).slice(0, limit).map((card, index) => ({
    ...card,
    candidateRanking: card.candidateRanking ? { ...card.candidateRanking, rank: index + 1 } : void 0
  }));
  return {
    cards,
    diagnostics: {
      inputCount: input.cards.length,
      hardFilterPassCount: input.cards.length - hardFilterRejectedCount,
      hardFilterRejectedCount,
      softCandidateCount: ranked.length,
      finalDisplayedCount: cards.length,
      sGradeCount: cards.filter((card) => card.signalGrade === "S").length,
      aGradeCount: cards.filter((card) => card.signalGrade === "A").length,
      bGradeCount: cards.filter((card) => card.signalGrade === "B").length,
      backtestMissingCount
    }
  };
}

// src/services/scanner-market-action.service.ts
function resolveScannerTradeAction(assetClass2, direction) {
  if (direction === "NEUTRAL") return "NONE";
  if (assetClass2 === "coin_futures") return direction === "LONG" ? "LONG" : "SHORT";
  return direction === "LONG" ? "BUY" : "SELL";
}
function isScannerRecommendationDirectionAllowed(assetClass2, direction) {
  if (direction === "NEUTRAL") return false;
  if (assetClass2 === "coin_futures") return direction === "LONG" || direction === "SHORT";
  return direction === "LONG";
}
function withScannerCanonicalActions(response) {
  const cards = response.cards.filter((card) => isScannerRecommendationDirectionAllowed(card.assetClass, card.direction)).map((card) => ({
    ...card,
    action: resolveScannerTradeAction(card.assetClass, card.direction)
  }));
  const alerts = response.alerts.filter((alert) => isScannerRecommendationDirectionAllowed(alert.assetClass, alert.direction)).map((alert) => ({
    ...alert,
    action: resolveScannerTradeAction(alert.assetClass, alert.direction)
  }));
  const removedCardCount = response.cards.length - cards.length;
  return {
    ...response,
    cards,
    alerts,
    execution: {
      ...response.execution,
      excludedCount: response.execution.excludedCount + removedCardCount,
      ...response.execution.finalDisplayedCount === void 0 ? {} : { finalDisplayedCount: cards.length },
      ...response.execution.sGradeCount === void 0 ? {} : { sGradeCount: cards.filter((card) => card.signalGrade === "S").length },
      ...response.execution.aGradeCount === void 0 ? {} : { aGradeCount: cards.filter((card) => card.signalGrade === "A").length },
      ...response.execution.bGradeCount === void 0 ? {} : { bGradeCount: cards.filter((card) => card.signalGrade === "B").length }
    }
  };
}

// src/services/scanner-strategy-profile.service.ts
function freezeProfile(profile) {
  Object.freeze(profile.indicators);
  Object.freeze(profile.indicatorWeights);
  Object.freeze(profile.candlePatterns);
  Object.freeze(profile.chartPatterns);
  Object.freeze(profile.confirmationTimeframes);
  Object.freeze(profile.scannerConditions);
  return Object.freeze(profile);
}
var VERSION = "signal-profile-v1";
var BASE = {
  SCALP: {
    indicators: ["EMA12", "EMA26", "VWAP", "RSI14", "MACD", "ATR14", "REL_VOLUME_20"],
    indicatorWeights: { trend: 18, momentum: 20, volume: 18, liquidity: 16, volatility: 12, regime: 10, risk: 6 },
    candlePatterns: ["momentum_breakout", "rejection"],
    chartPatterns: ["range_breakout", "pullback"],
    volatilityPolicy: "ATR-normalized intraday expansion with extreme-volatility guard",
    volumePolicy: "relative-volume and trading-value confirmation",
    trendPolicy: "fast EMA/VWAP alignment with higher-timeframe confirmation",
    marketRegimePolicy: "prefer aligned trend; permit mean reversion only in bounded sideways regime",
    liquidityPolicy: "strict spread and trading-value filter",
    riskPolicy: "tight risk budget; Risk Engine remains authoritative",
    scannerConditions: ["trend_alignment", "volume_spike", "breakout", "pullback"]
  },
  SWING: {
    indicators: ["EMA20", "EMA60", "SMA60", "RSI14", "MACD", "ADX14", "ATR14", "REL_VOLUME_20"],
    indicatorWeights: { trend: 25, momentum: 16, volume: 12, liquidity: 8, volatility: 10, regime: 19, risk: 10 },
    candlePatterns: ["breakout_confirmation", "pullback_reversal"],
    chartPatterns: ["trend_continuation", "support_resistance_break"],
    volatilityPolicy: "ATR-normalized swing range with volatility-regime guard",
    volumePolicy: "breakout/pullback volume confirmation",
    trendPolicy: "multi-timeframe medium-trend alignment",
    marketRegimePolicy: "trend/regime agreement required for strong signals",
    liquidityPolicy: "minimum tradability and spread quality",
    riskPolicy: "moderate risk budget; Risk Engine remains authoritative",
    scannerConditions: ["trend_alignment", "volume_spike", "breakout", "pullback"]
  },
  POSITION: {
    indicators: ["EMA20", "EMA60", "SMA60", "SMA120", "RSI14", "MACD", "ADX14", "ATR14", "OBV"],
    indicatorWeights: { trend: 31, momentum: 11, volume: 9, liquidity: 6, volatility: 8, regime: 23, risk: 12 },
    candlePatterns: ["weekly_structure_confirmation", "long_horizon_reversal"],
    chartPatterns: ["major_trend", "base_breakout", "support_resistance_structure"],
    volatilityPolicy: "long-horizon ATR regime; reject unstable volatility transitions",
    volumePolicy: "sustained accumulation/distribution confirmation",
    trendPolicy: "slow-trend and structure alignment across multiple timeframes",
    marketRegimePolicy: "regime stability is required; sideways signals are down-weighted",
    liquidityPolicy: "minimum durable liquidity filter",
    riskPolicy: "position risk budget; Risk Engine remains authoritative",
    scannerConditions: ["trend_alignment", "breakout", "pullback"]
  }
};
var TIMEFRAMES = {
  KR_STOCK: {
    SCALP: { primary: "5m", confirm: ["15m", "60m"] },
    SWING: { primary: "60m", confirm: ["4H", "1D"] },
    POSITION: { primary: "1D", confirm: ["4H", "1D"] }
  },
  US_STOCK: {
    SCALP: { primary: "5m", confirm: ["15m", "60m"] },
    SWING: { primary: "60m", confirm: ["4H", "1D"] },
    POSITION: { primary: "1D", confirm: ["4H", "1D"] }
  },
  CRYPTO_SPOT: {
    SCALP: { primary: "15m", confirm: ["60m"] },
    SWING: { primary: "4H", confirm: ["60m", "1D"] },
    POSITION: { primary: "4H", confirm: ["1D"] }
  },
  CRYPTO_FUTURES: {
    SCALP: { primary: "5m", confirm: ["15m", "60m"] },
    SWING: { primary: "60m", confirm: ["4H"] },
    POSITION: { primary: "4H", confirm: ["1D"] }
  }
};
function marketOverrides(market, horizon) {
  if (market === "KR_STOCK") {
    return {
      liquidityPolicy: horizon === "SCALP" ? "KR trading-value and spread gate with session liquidity awareness" : "KR trading-value and tradability gate",
      scannerConditions: horizon === "SCALP" ? ["volume_spike", "transaction_value", "ma_breakout", "rsi", "macd"] : ["ma_breakout", "volume_spike", "ai_score"]
    };
  }
  if (market === "US_STOCK") {
    return {
      liquidityPolicy: horizon === "SCALP" ? "US spread, dollar-volume and session liquidity gate" : "US dollar-volume and tradability gate",
      scannerConditions: horizon === "SCALP" ? ["volume_spike", "transaction_value", "ma_breakout", "rsi", "macd"] : ["ma_breakout", "volume_spike", "ai_score"]
    };
  }
  if (market === "CRYPTO_FUTURES") {
    return {
      riskPolicy: "futures leverage-aware risk budget; liquidation and Risk Engine guards remain authoritative",
      scannerConditions: horizon === "SCALP" ? ["trend_alignment", "volume_spike", "breakout", "pullback", "williams_atr"] : ["trend_alignment", "volume_spike", "breakout", "pullback"]
    };
  }
  return {
    riskPolicy: "spot no-leverage risk budget; Risk Engine remains authoritative",
    scannerConditions: horizon === "SCALP" ? ["trend_alignment", "volume_spike", "breakout", "pullback", "williams_atr"] : ["trend_alignment", "volume_spike", "breakout", "pullback"]
  };
}
function buildProfile(market, horizon) {
  const tf = TIMEFRAMES[market][horizon];
  const base = BASE[horizon];
  const override = marketOverrides(market, horizon);
  return freezeProfile({
    id: `${market}_${horizon}_V1`,
    version: VERSION,
    market,
    horizon,
    primaryTimeframe: tf.primary,
    confirmationTimeframes: [...tf.confirm],
    indicators: [...base.indicators],
    indicatorWeights: { ...base.indicatorWeights },
    candlePatterns: [...base.candlePatterns],
    chartPatterns: [...base.chartPatterns],
    volatilityPolicy: base.volatilityPolicy,
    volumePolicy: base.volumePolicy,
    trendPolicy: base.trendPolicy,
    marketRegimePolicy: base.marketRegimePolicy,
    liquidityPolicy: override.liquidityPolicy ?? base.liquidityPolicy,
    riskPolicy: override.riskPolicy ?? base.riskPolicy,
    scannerConditions: override.scannerConditions ? [...override.scannerConditions] : [...base.scannerConditions],
    executionAuthority: "NONE"
  });
}
var MARKETS2 = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"];
var HORIZONS = ["SCALP", "SWING", "POSITION"];
var PROFILES = /* @__PURE__ */ new Map();
for (const market of MARKETS2) {
  for (const horizon of HORIZONS) {
    const profile = buildProfile(market, horizon);
    PROFILES.set(`${market}:${horizon}`, profile);
  }
}
function getScannerStrategyProfile(market, horizon) {
  const profile = PROFILES.get(`${market}:${horizon}`);
  if (!profile) throw new Error(`Unknown scanner strategy profile: ${market}/${horizon}`);
  return profile;
}
function listScannerStrategyProfiles() {
  return Object.freeze([...PROFILES.values()]);
}
function scannerModeToHorizon(mode) {
  if (mode === "scalping") return "SCALP";
  if (mode === "swing") return "SWING";
  return "POSITION";
}

// src/services/strategy-promotion.service.ts
import { createHash as createHash5 } from "node:crypto";

// src/services/signal-performance-learning.service.ts
var SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY = "NONE";
var DEFAULT_MINIMUM_SAMPLE_SIZE = 30;
function parseTime(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ISO timestamp: ${value}`);
  return parsed;
}
function validPrice(value) {
  return Number.isFinite(value) && value > 0;
}
function cloneJson2(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}
function deepFreeze3(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze3(child);
  return value;
}
function createImmutableSignalSnapshot(input) {
  if (!input.signalId.trim()) throw new Error("signalId is required");
  if (!input.symbol.trim()) throw new Error("symbol is required");
  if (!validPrice(input.referencePrice) || !validPrice(input.entryPrice)) throw new Error("referencePrice and entryPrice must be positive");
  if (input.stopLoss != null && !validPrice(input.stopLoss)) throw new Error("stopLoss must be positive");
  if (input.target1 != null && !validPrice(input.target1)) throw new Error("target1 must be positive");
  if (input.target2 != null && !validPrice(input.target2)) throw new Error("target2 must be positive");
  const timestamp4 = parseTime(input.timestamp);
  const dataTimestamp = parseTime(input.dataTimestamp);
  if (dataTimestamp > timestamp4) throw new Error("dataTimestamp cannot be later than signal timestamp (look-ahead guard)");
  const snapshot = {
    ...cloneJson2(input),
    immutable: true,
    executionAuthority: SIGNAL_PERFORMANCE_EXECUTION_AUTHORITY
  };
  return deepFreeze3(snapshot);
}

// src/services/strategy-promotion.service.ts
var STRATEGY_PROMOTION_EXECUTION_AUTHORITY = "NONE";
var COST_STRESS_MULTIPLIERS = [1, 1.25, 1.5, 2];
var STAGE_ORDER = [
  "RESEARCH_DESIGN",
  "HISTORICAL_BACKTEST",
  "OUT_OF_SAMPLE",
  "PURGED_WALK_FORWARD",
  "COST_STRESS",
  "REGIME",
  "FINAL_HOLDOUT",
  "PAPER",
  "SHADOW",
  "RECOMMENDATION_OUTCOMES"
];
var RESEARCH_GATES = STAGE_ORDER.slice(0, 7);
var VALID_SHA = /^[0-9a-f]{40}$/i;
var STRATEGY_PROMOTION_POLICY = Object.freeze({
  version: "STRATEGY_PROMOTION_POLICY_V1",
  stageOrder: STAGE_ORDER,
  researchGates: RESEARCH_GATES,
  costStressMultipliers: COST_STRESS_MULTIPLIERS,
  minimumObservedOutcomeSamples: DEFAULT_MINIMUM_SAMPLE_SIZE,
  thresholdAuthority: "CANONICAL_UPSTREAM_GATE_RESULTS"
});
var REQUIRED_EVIDENCE = Object.freeze({
  RESEARCH_DESIGN: ["immutable identity", "parameter hash", "exact research code SHA"],
  HISTORICAL_BACKTEST: ["lookahead control", "survivorship and delisted-asset handling", "corporate actions", "missing and stale candles", "spread", "commission", "tax", "slippage", "latency", "funding where applicable", "liquidity"],
  OUT_OF_SAMPLE: ["isolated dataset", "trades", "net return after costs", "win rate", "profit factor", "expectancy", "MDD", "Sharpe where valid", "average win/loss", "MFE/MAE"],
  PURGED_WALK_FORWARD: ["purge", "embargo where applicable", "no future leakage", "rolling stability", "positive-window ratio", "worst and median windows", "parameter stability"],
  COST_STRESS: ["baseline", "1.25x", "1.5x", "2x", "commission", "spread", "slippage", "funding where applicable", "latency impact"],
  REGIME: ["bull", "bear", "sideways", "high/low volatility", "high/low liquidity"],
  FINAL_HOLDOUT: ["selection isolation", "no parameter retuning", "no threshold retuning", "no strategy-family retuning"],
  PAPER: ["canonical Paper engine", "trade count", "net return", "expectancy", "profit factor", "MDD", "win rate", "holding time", "MFE/MAE", "cost difference"],
  SHADOW: ["SIMULATED_ONLY", "LIVE_ORDER_ALLOWED=false", "ORDER_SUBMITTED=false", "PRIVATE_TRADING_REQUEST_ALLOWED=false", "paper-shadow fill/price/latency/spread/outcome gaps"],
  RECOMMENDATION_OUTCOMES: ["immutable signal and evidence snapshot", "TP-before-SL or SL-before-TP outcome", "expiry/invalidation", "MFE/MAE", "net hypothetical return"]
});
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)])
  );
}
function strategyParameterHash(profile) {
  return createHash5("sha256").update(JSON.stringify(stableValue(profile))).digest("hex");
}
function assetClass(market) {
  if (market === "CRYPTO_FUTURES") return "CRYPTO_FUTURES";
  if (market === "CRYPTO_SPOT") return "CRYPTO_SPOT";
  return "STOCK";
}
function directions(market) {
  return market === "CRYPTO_FUTURES" ? ["LONG", "SHORT"] : ["BUY", "SELL"];
}
function identity(profile, direction, sourceSha) {
  return Object.freeze({
    strategyFamily: "CANONICAL_SCANNER_PROFILE",
    strategyId: `${profile.id}_${direction}`,
    strategyVersion: profile.version,
    version: profile.version,
    parameterHash: strategyParameterHash(profile),
    market: profile.market,
    assetClass: assetClass(profile.market),
    symbol: null,
    universe: `${profile.market}_CANONICAL_UNIVERSE`,
    timeframe: profile.primaryTimeframe,
    strategyHorizon: profile.horizon,
    horizon: profile.horizon,
    direction,
    researchCodeSha: sourceSha,
    costPolicyVersion: "BACKTEST_FEES_SLIPPAGE_FUNDING_V1",
    riskPolicyVersion: "CANONICAL_RISK_ENGINE_V1"
  });
}
function emptyStage(stage, observedAt) {
  return {
    stage,
    status: "NOT_STARTED",
    startedAt: null,
    completedAt: null,
    observedAt,
    source: "UNLINKED",
    provider: null,
    sourceSha: null,
    datasetId: null,
    dataRange: null,
    sampleSize: null,
    sampleCount: null,
    tradeCount: null,
    metrics: null,
    gate: `${stage}_EVIDENCE_REQUIRED`,
    gateResult: "EVIDENCE_REQUIRED",
    failureReason: null,
    failureReasons: [],
    provenance: [],
    costAssumptions: stage === "COST_STRESS" ? { requiredMultipliers: COST_STRESS_MULTIPLIERS.join(",") } : null,
    costPolicy: stage === "COST_STRESS" ? { version: "BACKTEST_FEES_SLIPPAGE_FUNDING_V1", requiredMultipliers: COST_STRESS_MULTIPLIERS.join(",") } : null,
    dataQuality: "UNLINKED",
    fetchedAt: null,
    validatedAt: null,
    corporateActionAdjusted: null,
    survivorshipSafe: null,
    pointInTimeSafe: null,
    requiredEvidence: REQUIRED_EVIDENCE[stage]
  };
}
function researchStage(profile, sourceSha, observedAt) {
  const sourceAvailable = VALID_SHA.test(sourceSha);
  return {
    stage: "RESEARCH_DESIGN",
    status: sourceAvailable ? "PASS" : "BLOCKED",
    startedAt: observedAt,
    completedAt: observedAt,
    observedAt,
    source: "scanner-strategy-profile.service.ts",
    provider: "INTERNAL_CANONICAL_REGISTRY",
    sourceSha: sourceAvailable ? sourceSha : null,
    datasetId: null,
    dataRange: null,
    sampleSize: null,
    sampleCount: null,
    tradeCount: null,
    metrics: { profileId: profile.id, profileVersion: profile.version, executionAuthority: "NONE" },
    gate: "IMMUTABLE_PROFILE_AND_EXACT_CODE_SHA",
    gateResult: sourceAvailable ? "PASS" : "BLOCKED",
    failureReason: sourceAvailable ? null : "EXACT_RESEARCH_CODE_SHA_UNAVAILABLE",
    failureReasons: sourceAvailable ? [] : ["EXACT_RESEARCH_CODE_SHA_UNAVAILABLE"],
    provenance: ["canonical scanner strategy profile registry"],
    costAssumptions: null,
    costPolicy: null,
    dataQuality: sourceAvailable ? "VERIFIED" : "INSUFFICIENT",
    fetchedAt: null,
    validatedAt: observedAt,
    corporateActionAdjusted: null,
    survivorshipSafe: null,
    pointInTimeSafe: null,
    requiredEvidence: REQUIRED_EVIDENCE.RESEARCH_DESIGN
  };
}
function mergeEvidence(base, override, observedAt, expectedSourceSha) {
  if (!override) return base;
  const merged = {
    ...base,
    ...override,
    stage: base.stage,
    observedAt: override.observedAt ?? observedAt,
    sampleCount: override.sampleCount ?? override.sampleSize ?? base.sampleCount,
    sampleSize: override.sampleSize ?? override.sampleCount ?? base.sampleSize,
    gateResult: override.gateResult ?? override.status ?? base.gateResult,
    failureReasons: override.failureReasons ? [...override.failureReasons] : override.failureReason ? [override.failureReason] : base.failureReasons,
    provenance: override.provenance ? [...override.provenance] : base.provenance
  };
  return validateLinkedEvidence({
    ...merged,
    completedAt: override.completedAt ?? (merged.status === "RUNNING" || merged.status === "NOT_STARTED" ? null : merged.observedAt),
    validatedAt: override.validatedAt ?? merged.observedAt
  }, expectedSourceSha);
}
function validateLinkedEvidence(stage, expectedSourceSha) {
  if (stage.stage === "RESEARCH_DESIGN" || stage.status !== "PASS") return stage;
  const missing = [
    !VALID_SHA.test(stage.sourceSha ?? "") || stage.sourceSha !== expectedSourceSha ? "EXACT_SOURCE_SHA_REQUIRED" : null,
    !stage.datasetId ? "DATASET_ID_REQUIRED" : null,
    !stage.dataRange ? "DATA_RANGE_REQUIRED" : null,
    !stage.provenance.length ? "PROVENANCE_REQUIRED" : null,
    stage.dataQuality !== "VERIFIED" ? "VERIFIED_DATA_QUALITY_REQUIRED" : null,
    !stage.metrics ? "METRICS_REQUIRED" : null,
    !stage.provider ? "PROVIDER_REQUIRED" : null,
    !stage.startedAt ? "STARTED_AT_REQUIRED" : null,
    !stage.completedAt ? "COMPLETED_AT_REQUIRED" : null,
    !stage.fetchedAt ? "FETCHED_AT_REQUIRED" : null,
    !stage.validatedAt ? "VALIDATED_AT_REQUIRED" : null,
    stage.stage === "HISTORICAL_BACKTEST" && stage.corporateActionAdjusted !== true ? "CORPORATE_ACTION_ADJUSTMENT_REQUIRED" : null,
    stage.stage === "HISTORICAL_BACKTEST" && stage.survivorshipSafe !== true ? "SURVIVORSHIP_SAFETY_REQUIRED" : null,
    ["HISTORICAL_BACKTEST", "OUT_OF_SAMPLE", "PURGED_WALK_FORWARD", "FINAL_HOLDOUT"].includes(stage.stage) && stage.pointInTimeSafe !== true ? "POINT_IN_TIME_SAFETY_REQUIRED" : null,
    stage.stage === "COST_STRESS" && !stage.costPolicy ? "COST_POLICY_REQUIRED" : null
  ].filter((value) => Boolean(value));
  if (!missing.length) return stage;
  return {
    ...stage,
    status: "BLOCKED",
    gateResult: "BLOCKED",
    failureReason: missing.join(","),
    failureReasons: missing
  };
}
function stageMap(stages) {
  return new Map(stages.map((stage) => [stage.stage, stage]));
}
function blockingReason(stage) {
  if (stage.status === "PASS") return null;
  if (stage.status === "NOT_STARTED" || stage.status === "RUNNING") return `${stage.stage}_${stage.status}`;
  return `${stage.stage}_${stage.status}${stage.failureReason ? `:${stage.failureReason}` : ""}`;
}
function costStressComplete(stage) {
  if (stage.status !== "PASS" || !stage.metrics) return false;
  return COST_STRESS_MULTIPLIERS.every((multiplier) => stage.metrics?.[`cost_${multiplier}x`] === true);
}
function promotionState(stages, drift, killState) {
  if (killState === "KILLED") return "KILLED";
  if (killState === "SUSPEND_RECOMMENDED" || drift.classification === "DEGRADED" || drift.classification === "CRITICAL") return "SUSPENDED";
  const byStage = stageMap(stages);
  const research = RESEARCH_GATES.map((key) => byStage.get(key));
  if (research.some((stage) => stage.status === "BLOCKED" || stage.status === "INVALIDATED")) return "BLOCKED_DATA";
  if (research.some((stage) => ["FAIL", "INSUFFICIENT_SAMPLE", "STALE"].includes(stage.status))) return "RESEARCH_HOLD";
  if (!research.every((stage) => stage.status === "PASS") || !costStressComplete(byStage.get("COST_STRESS"))) return "RESEARCH";
  const paper = byStage.get("PAPER");
  const shadow = byStage.get("SHADOW");
  const outcomes = byStage.get("RECOMMENDATION_OUTCOMES");
  if (paper.status !== "PASS") return paper.status === "NOT_STARTED" || paper.status === "RUNNING" ? "PAPER_CANDIDATE" : "RESEARCH_HOLD";
  if (shadow.status === "BLOCKED" || shadow.status === "FAIL" || shadow.status === "INSUFFICIENT_SAMPLE" || shadow.status === "STALE" || shadow.status === "INVALIDATED") return "PAPER_VALIDATED";
  if (shadow.status !== "PASS") return "SHADOW_CANDIDATE";
  if (outcomes.status !== "PASS") return "SHADOW_VALIDATED";
  if (!promotionCandidateEvidenceComplete(outcomes, drift)) return "SHADOW_VALIDATED";
  return "PROMOTION_CANDIDATE";
}
function promotionCandidateEvidenceComplete(outcomes, drift) {
  return drift.status === "MEASURED" && (drift.classification === "HEALTHY" || drift.classification === "WATCH") && outcomes.metrics?.riskGatePassed === true && outcomes.metrics?.dataQualityGatePassed === true && outcomes.metrics?.costStressMaintained === true;
}
function classifyPromotionDrift(stages) {
  const byStage = stageMap(stages);
  const baseline = byStage.get("HISTORICAL_BACKTEST");
  const observed = byStage.get("RECOMMENDATION_OUTCOMES");
  const baselineSamples = baseline?.sampleCount ?? baseline?.sampleSize ?? baseline?.tradeCount ?? null;
  const observedSamples = observed?.sampleCount ?? observed?.sampleSize ?? observed?.tradeCount ?? null;
  const upstreamClassification = observed?.metrics?.driftClassification;
  const driftPolicyVersion = observed?.metrics?.driftPolicyVersion;
  const classification = typeof upstreamClassification === "string" && ["HEALTHY", "WATCH", "DEGRADED", "CRITICAL"].includes(upstreamClassification) ? upstreamClassification : null;
  if (baselineSamples == null || observedSamples == null || observedSamples < STRATEGY_PROMOTION_POLICY.minimumObservedOutcomeSamples || !classification || typeof driftPolicyVersion !== "string" || !driftPolicyVersion.trim()) {
    return {
      classification: null,
      status: "INSUFFICIENT_SAMPLE",
      reason: "LINKED_BASELINE_AND_AT_LEAST_30_OBSERVED_OUTCOMES_REQUIRED",
      baselineSampleSize: baselineSamples,
      observedSampleSize: observedSamples,
      hitRateGap: null,
      expectedValueGap: null,
      autoPromotionAllowed: false
    };
  }
  const baselineHitRate = typeof baseline?.metrics?.hitRate === "number" ? baseline.metrics.hitRate : null;
  const observedHitRate = typeof observed?.metrics?.hitRate === "number" ? observed.metrics.hitRate : null;
  const baselineEv = typeof baseline?.metrics?.expectedValue === "number" ? baseline.metrics.expectedValue : null;
  const observedEv = typeof observed?.metrics?.expectedValue === "number" ? observed.metrics.expectedValue : null;
  const hitRateGap = baselineHitRate == null || observedHitRate == null ? null : observedHitRate - baselineHitRate;
  const expectedValueGap = baselineEv == null || observedEv == null ? null : observedEv - baselineEv;
  return {
    classification,
    status: "MEASURED",
    reason: `UPSTREAM_VERSIONED_DRIFT_POLICY:${driftPolicyVersion}`,
    baselineSampleSize: baselineSamples,
    observedSampleSize: observedSamples,
    hitRateGap,
    expectedValueGap,
    autoPromotionAllowed: false
  };
}
function sourceRegistry() {
  return Object.freeze([
    { id: "CANONICAL_SCANNER_PROFILE", owner: "scanner-strategy-profile.service.ts", status: "AVAILABLE", use: "immutable strategy identity and research design", executionAuthority: "NONE" },
    { id: "BACKTEST_ENGINE", owner: "backtest-engine.service.ts", status: "AVAILABLE", use: "historical, cost-aware and regime evidence after exact identity linkage", executionAuthority: "NONE" },
    { id: "PREDICTION_LAB", owner: "market-prediction-lab", status: "UNLINKED", use: "purged walk-forward and final-holdout artifacts require parameter-hash linkage", executionAuthority: "NONE" },
    { id: "PAPER_JOURNAL", owner: "paper-journal", status: "AVAILABLE", use: "paper evidence after strategy identity linkage", executionAuthority: "NONE" },
    { id: "SIGNAL_PERFORMANCE", owner: "signal-performance-learning.service.ts", status: "AVAILABLE", use: "shadow and recommendation outcomes after strategy identity linkage", executionAuthority: "NONE" },
    { id: "PROFIT_FIRST_SCANNER", owner: "PR #210 clean-port candidate", status: "NOT_ON_MAIN", use: "future scanner evidence source; no evidence accepted until clean-port and exact-head gates pass", executionAuthority: "NONE" }
  ]);
}
function stateCounts(items) {
  const counts = {
    RESEARCH: 0,
    BLOCKED_DATA: 0,
    RESEARCH_HOLD: 0,
    PAPER_CANDIDATE: 0,
    PAPER_VALIDATED: 0,
    SHADOW_CANDIDATE: 0,
    SHADOW_VALIDATED: 0,
    PROMOTION_CANDIDATE: 0,
    SUSPENDED: 0,
    KILLED: 0
  };
  for (const item of items) counts[item.promotionState] += 1;
  return counts;
}
var StrategyPromotionService = class {
  sourceSha;
  now;
  evidence;
  killStates;
  constructor(options = {}) {
    this.sourceSha = String(options.sourceSha ?? process.env.DEPLOY_SHA ?? process.env.GITHUB_SHA ?? "").trim();
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.evidence = options.evidence ?? {};
    this.killStates = options.killStates ?? {};
  }
  list(filters = {}) {
    const generatedAt = this.now().toISOString();
    const items = listScannerStrategyProfiles().flatMap((profile) => directions(profile.market).map((direction) => {
      const itemIdentity = identity(profile, direction, this.sourceSha || "UNAVAILABLE");
      const overrides = new Map((this.evidence?.[itemIdentity.strategyId] ?? []).map((item) => [item.stage, item]));
      const stages = STAGE_ORDER.map((stage) => mergeEvidence(
        stage === "RESEARCH_DESIGN" ? researchStage(profile, this.sourceSha, generatedAt) : emptyStage(stage, generatedAt),
        overrides.get(stage),
        generatedAt,
        this.sourceSha
      ));
      const drift = classifyPromotionDrift(stages);
      const killState = this.killStates?.[itemIdentity.strategyId] ?? "NONE";
      const currentState = promotionState(stages, drift, killState);
      const blockers = stages.map(blockingReason).filter((item) => Boolean(item));
      if (byCostStressNeedsDetails(stages)) blockers.push("COST_STRESS_1X_1_25X_1_5X_2X_REQUIRED");
      return Object.freeze({
        identity: itemIdentity,
        promotionState: currentState,
        stages: Object.freeze(stages),
        drift,
        killState,
        blockers: Object.freeze(blockers),
        promotionEligible: currentState === "PROMOTION_CANDIDATE",
        executionAuthority: STRATEGY_PROMOTION_EXECUTION_AUTHORITY,
        liveTradingAuthority: false,
        privateTradingApiCount: 0
      });
    })).filter((item) => (!filters.market || item.identity.market === filters.market) && (!filters.strategyHorizon || item.identity.strategyHorizon === filters.strategyHorizon) && (!filters.direction || item.identity.direction === filters.direction) && (!filters.status || item.promotionState === filters.status));
    const counts = stateCounts(items);
    return {
      generatedAt,
      sourceSha: this.sourceSha || "UNAVAILABLE",
      policyVersion: STRATEGY_PROMOTION_POLICY.version,
      items,
      counts,
      evidenceSources: sourceRegistry(),
      promotionCandidates: counts.PROMOTION_CANDIDATE,
      executionAuthority: STRATEGY_PROMOTION_EXECUTION_AUTHORITY,
      liveTradingAuthority: false,
      privateTradingApiCount: 0
    };
  }
  get(strategyId) {
    return this.list().items.find((item) => item.identity.strategyId === strategyId) ?? null;
  }
  history(strategyId) {
    const record = this.get(strategyId);
    if (!record) return null;
    const events = record.stages.filter((stage) => stage.status !== "NOT_STARTED").map((stage) => ({ at: stage.validatedAt ?? stage.observedAt, type: "STAGE_EVALUATED", stage: stage.stage, status: stage.status, source: stage.source, sourceSha: stage.sourceSha }));
    events.push({ at: this.now().toISOString(), type: "PROMOTION_STATE_EVALUATED", stage: "PROMOTION", status: record.promotionState, source: "strategy-promotion.service.ts", sourceSha: VALID_SHA.test(this.sourceSha) ? this.sourceSha : null });
    return { strategyId, events, executionAuthority: STRATEGY_PROMOTION_EXECUTION_AUTHORITY };
  }
  evidenceFor(strategyId) {
    const record = this.get(strategyId);
    if (!record) return null;
    return {
      strategyId,
      parameterHash: record.identity.parameterHash,
      stages: record.stages,
      sources: sourceRegistry(),
      exactIdentityRequired: true,
      inventedMetricsAllowed: false,
      executionAuthority: STRATEGY_PROMOTION_EXECUTION_AUTHORITY
    };
  }
};
function byCostStressNeedsDetails(stages) {
  const cost = stages.find((stage) => stage.stage === "COST_STRESS");
  return cost?.status === "PASS" && !costStressComplete(cost);
}

// src/services/scanner-canonical-paper-identity.service.ts
var MARKET_ALIASES = Object.freeze({
  KR_STOCK: Object.freeze(["KR", "KR_STOCK"]),
  US_STOCK: Object.freeze(["US", "US_STOCK"]),
  CRYPTO_SPOT: Object.freeze(["SPOT", "CRYPTO_SPOT", "UPBIT_KRW"]),
  CRYPTO_FUTURES: Object.freeze(["FUTURES", "CRYPTO_FUTURES", "BITGET_USDT_FUTURES"])
});
var ASSET_CLASSES = Object.freeze({
  KR_STOCK: "stock",
  US_STOCK: "stock",
  CRYPTO_SPOT: "coin_spot",
  CRYPTO_FUTURES: "coin_futures"
});
var STYLE_BY_MODE = Object.freeze({
  scalping: "SCALPING",
  swing: "SWING",
  position: "MID_LONG"
});
function exactSha(value) {
  return /^[0-9a-f]{40}$/u.test(value);
}
function nonEmpty4(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function explicitDirection(action, market) {
  if (market === "CRYPTO_FUTURES") return action === "LONG" || action === "SHORT" ? action : null;
  return action === "BUY" || action === "SELL" ? action : null;
}
function canonicalMode(card) {
  const mode = card.strategyMode;
  if (mode !== "scalping" && mode !== "swing" && mode !== "position") return null;
  return Object.freeze({ mode, horizon: scannerModeToHorizon(mode), style: STYLE_BY_MODE[mode] });
}
function timeframeMs(timeframe) {
  const match = /^(\d+)(m|H|D)$/u.exec(timeframe);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count <= 0) return null;
  const unitMs = match[2] === "m" ? 6e4 : match[2] === "H" ? 60 * 6e4 : 24 * 60 * 6e4;
  return count * unitMs;
}
function canonicalHorizonBars(card, timeframe) {
  const timestampMs = Date.parse(card.observedAt);
  const expiresAtMs = Date.parse(card.expiresAt);
  const barMs = timeframeMs(timeframe);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(expiresAtMs) || !barMs || expiresAtMs <= timestampMs) return null;
  const ttlMs = expiresAtMs - timestampMs;
  if (ttlMs % barMs !== 0) return null;
  const bars = ttlMs / barMs;
  if (!Number.isInteger(bars) || bars <= 0) return null;
  return Object.freeze({ timestampMs, expiresAtMs, ttlMs, bars });
}
function exactPromotionIdentity(input) {
  const profile = getScannerStrategyProfile(input.market, input.profileHorizon);
  const matches = input.records.filter((record2) => record2.identity.market === input.market && record2.identity.strategyHorizon === input.profileHorizon && record2.identity.direction === input.direction);
  const blockers = [];
  if (matches.length !== 1) {
    blockers.push(matches.length === 0 ? "CANONICAL_PROMOTION_IDENTITY_REQUIRED" : "CANONICAL_PROMOTION_IDENTITY_AMBIGUOUS");
    return { record: null, blockers };
  }
  const record = matches[0];
  const identity2 = record.identity;
  if (record.executionAuthority !== "NONE" || record.liveTradingAuthority !== false || record.privateTradingApiCount !== 0) {
    blockers.push("CANONICAL_PROMOTION_SAFETY_ENVELOPE_INVALID");
  }
  if (identity2.strategyFamily !== "CANONICAL_SCANNER_PROFILE") blockers.push("PROMOTION_STRATEGY_FAMILY_MISMATCH");
  if (identity2.strategyId !== `${profile.id}_${input.direction}`) blockers.push("PROMOTION_STRATEGY_ID_MISMATCH");
  if (identity2.strategyVersion !== profile.version) blockers.push("PROMOTION_STRATEGY_VERSION_MISMATCH");
  if (identity2.parameterHash !== strategyParameterHash(profile)) blockers.push("PROMOTION_PARAMETER_HASH_MISMATCH");
  if (identity2.timeframe !== profile.primaryTimeframe) blockers.push("PROMOTION_TIMEFRAME_MISMATCH");
  if (!exactSha(identity2.researchCodeSha) || identity2.researchCodeSha !== input.researchCodeSha) {
    blockers.push("PROMOTION_RESEARCH_SHA_MISMATCH");
  }
  if (!nonEmpty4(identity2.costPolicyVersion)) blockers.push("PROMOTION_COST_POLICY_VERSION_REQUIRED");
  return { record: blockers.length === 0 ? record : null, blockers };
}
function resolveScannerCanonicalPaperIdentity(input) {
  const researchCodeSha = input.researchCodeSha.trim().toLowerCase();
  if (!exactSha(researchCodeSha)) {
    return Object.freeze({ paperCandidate: null, blockers: Object.freeze(["IMMUTABLE_RESEARCH_SHA_REQUIRED"]) });
  }
  const blockers = [];
  const marketToken = String(input.card.market ?? "").trim().toUpperCase();
  if (!MARKET_ALIASES[input.market].includes(marketToken)) blockers.push("SCANNER_MARKET_MISMATCH");
  if (input.card.assetClass !== ASSET_CLASSES[input.market]) blockers.push("SCANNER_ASSET_CLASS_MISMATCH");
  if (!nonEmpty4(input.card.signalId) || !nonEmpty4(input.card.symbol)) blockers.push("SCANNER_SIGNAL_IDENTITY_REQUIRED");
  const mode = canonicalMode(input.card);
  if (!mode) blockers.push("SCANNER_STRATEGY_MODE_REQUIRED");
  const direction = explicitDirection(input.card.action, input.market);
  if (!direction) blockers.push("SCANNER_EXPLICIT_ACTION_REQUIRED");
  if (!mode || !direction || blockers.length > 0) {
    return Object.freeze({ paperCandidate: null, blockers: Object.freeze([...new Set(blockers)]) });
  }
  const profile = getScannerStrategyProfile(input.market, mode.horizon);
  const horizon = canonicalHorizonBars(input.card, profile.primaryTimeframe);
  if (!horizon) blockers.push("SCANNER_CANONICAL_HORIZON_REQUIRED");
  const records2 = input.promotionRecords ?? new StrategyPromotionService({ sourceSha: researchCodeSha }).list({ market: input.market, strategyHorizon: mode.horizon, direction }).items;
  const promotion = exactPromotionIdentity({
    records: records2,
    market: input.market,
    profileHorizon: mode.horizon,
    direction,
    researchCodeSha
  });
  blockers.push(...promotion.blockers);
  if (!horizon || !promotion.record || blockers.length > 0) {
    return Object.freeze({ paperCandidate: null, blockers: Object.freeze([...new Set(blockers)]) });
  }
  const identity2 = promotion.record.identity;
  const paperCandidate = Object.freeze({
    signal: Object.freeze({
      signalId: input.card.signalId,
      market: input.market,
      symbol: input.card.symbol,
      timestampMs: horizon.timestampMs,
      ttlMs: horizon.ttlMs,
      expiresAtMs: horizon.expiresAtMs,
      style: mode.style,
      timeframe: identity2.timeframe,
      horizon: horizon.bars,
      direction,
      signalDirection: direction,
      strategyIdentity: Object.freeze({
        strategyId: identity2.strategyId,
        strategyVersion: identity2.strategyVersion,
        parameterHash: identity2.parameterHash,
        researchCodeSha: identity2.researchCodeSha,
        costPolicyVersion: identity2.costPolicyVersion
      })
    }),
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false
  });
  return Object.freeze({ paperCandidate, blockers: Object.freeze([]) });
}
function attachScannerCanonicalPaperIdentity(input) {
  const researchCodeSha = input.researchCodeSha.trim().toLowerCase();
  if (!exactSha(researchCodeSha)) return input.response;
  const service = new StrategyPromotionService({ sourceSha: researchCodeSha });
  const promotionRecords = service.list({ market: input.market }).items;
  const cards = input.response.cards.map((card) => {
    const resolution = resolveScannerCanonicalPaperIdentity({
      card,
      market: input.market,
      researchCodeSha,
      promotionRecords
    });
    if (!resolution.paperCandidate) return card;
    const enriched = { ...card, paperCandidate: resolution.paperCandidate };
    return enriched;
  });
  return { ...input.response, cards };
}

// src/services/forward-recommendation-observer.service.ts
import { createHash as createHash6 } from "node:crypto";
var FORWARD_OBSERVATION_SOURCE = "LIVE_RECOMMENDATION";
var TERMINAL_SIGNAL_STATES = /* @__PURE__ */ new Set([
  "CLOSED",
  "INVALIDATED",
  "EXPIRED",
  "REJECTED",
  "CANCELLED"
]);
function nonEmpty5(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function positive5(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function positiveInteger2(value) {
  return Number.isInteger(value) && Number(value) > 0;
}
function immutableSha2(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function parseTimeOrNull(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function marketFromCard(card) {
  const market = String(card.market ?? "").toUpperCase();
  if (card.assetClass === "coin_spot") return "CRYPTO_SPOT";
  if (card.assetClass === "coin_futures") return "CRYPTO_FUTURES";
  if (card.assetClass !== "stock") return null;
  if (market === "KR" || market === "KR_STOCK") return "KR_STOCK";
  if (market === "US" || market === "US_STOCK") return "US_STOCK";
  return null;
}
function directionFromCard(card, market) {
  const action = card.action;
  if (market === "CRYPTO_FUTURES") return action === "LONG" || action === "SHORT" ? action : null;
  return action === "BUY" || action === "SELL" ? action : null;
}
function horizonFromMode(mode) {
  if (mode === "scalping") return "SCALP";
  if (mode === "swing") return "SWING";
  if (mode === "position") return "POSITION";
  return null;
}
function regimeFromCard(card) {
  switch (card.backtestQuality?.regime) {
    case "Strong Bull":
    case "Bull":
      return "UPTREND";
    case "Bear":
      return "DOWNTREND";
    case "Sideways":
      return "SIDEWAYS";
    case "High Volatility":
      return "HIGH_VOL";
    case "Low Volatility":
      return "LOW_VOL";
    default:
      return "UNKNOWN";
  }
}
function directionSign(direction) {
  return direction === "BUY" || direction === "LONG" ? 1 : -1;
}
function priceStructureValid(entry, stop, target1, target2, direction) {
  const sign = directionSign(direction);
  if ((target1 - entry) * sign <= 0 || (stop - entry) * sign >= 0) return false;
  if (target2 != null && (target2 - target1) * sign <= 0) return false;
  return true;
}
function decision(status, blockers, observation = null) {
  return Object.freeze({
    schemaVersion: "forward-recommendation-observer-decision-v2",
    status,
    blockers: Object.freeze([...new Set(blockers)]),
    observation,
    executionAuthority: "NONE",
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false
  });
}
function forwardObservationIdentityKey(identity2) {
  return [
    identity2.strategyId,
    identity2.strategyVersion,
    identity2.parameterHash,
    identity2.researchCodeSha.toLowerCase(),
    identity2.market,
    identity2.symbol,
    identity2.timeframe,
    String(identity2.horizon),
    identity2.direction
  ].join("|");
}
function observationId2(snapshot, identity2) {
  return createHash6("sha256").update([
    FORWARD_OBSERVATION_SOURCE,
    snapshot.signalId,
    snapshot.timestamp,
    forwardObservationIdentityKey(identity2)
  ].join("|")).digest("hex");
}
function prepareForwardRecommendationObservation(input) {
  const { card } = input;
  if (card.signalGrade !== "S" && card.signalGrade !== "A") {
    return decision("NO_TRADE", ["SCANNER_GRADE_NOT_FORWARD_OBSERVABLE"]);
  }
  if (card.strongSignalEligible !== true || TERMINAL_SIGNAL_STATES.has(card.signalState)) {
    return decision("NO_TRADE", ["SCANNER_SIGNAL_NOT_ACTIVE_STRONG"]);
  }
  const blockers = [];
  const market = marketFromCard(card);
  if (!market) blockers.push("MARKET_UNSUPPORTED");
  const direction = market ? directionFromCard(card, market) : null;
  if (!direction) blockers.push("EXPLICIT_ACTION_REQUIRED");
  const performanceHorizon = horizonFromMode(card.strategyMode);
  if (!performanceHorizon) blockers.push("STRATEGY_HORIZON_REQUIRED");
  const identity2 = input.strategyIdentity;
  if (!identity2 || typeof identity2 !== "object") blockers.push("CANONICAL_STRATEGY_IDENTITY_REQUIRED");
  if (!nonEmpty5(identity2?.strategyId)) blockers.push("STRATEGY_ID_REQUIRED");
  if (!nonEmpty5(identity2?.strategyVersion)) blockers.push("STRATEGY_VERSION_REQUIRED");
  if (!nonEmpty5(identity2?.parameterHash)) blockers.push("PARAMETER_HASH_REQUIRED");
  if (!immutableSha2(identity2?.researchCodeSha)) blockers.push("IMMUTABLE_RESEARCH_SHA_REQUIRED");
  if (!nonEmpty5(identity2?.symbol)) blockers.push("IDENTITY_SYMBOL_REQUIRED");
  if (!nonEmpty5(identity2?.timeframe)) blockers.push("TIMEFRAME_REQUIRED");
  if (!positiveInteger2(identity2?.horizon)) blockers.push("CANONICAL_HORIZON_REQUIRED");
  if (market && identity2?.market !== market) blockers.push("MARKET_MISMATCH");
  if (nonEmpty5(card.symbol) && identity2?.symbol !== card.symbol) blockers.push("SYMBOL_MISMATCH");
  if (direction && identity2?.direction !== direction) blockers.push("DIRECTION_MISMATCH");
  if (!positiveInteger2(input.dataMaxAgeMs)) blockers.push("DATA_MAX_AGE_REQUIRED");
  if (input.publicDataOnly !== true) blockers.push("PUBLIC_DATA_AUTHORITY_REQUIRED");
  if (!nonEmpty5(card.signalId) || !nonEmpty5(card.symbol)) blockers.push("SIGNAL_IDENTITY_REQUIRED");
  if (!Array.isArray(card.dataSources) || card.dataSources.length === 0 || card.dataSources.some((source) => !nonEmpty5(source))) blockers.push("DATA_PROVENANCE_REQUIRED");
  if (card.dataState !== "complete") blockers.push("DATA_STATE_NOT_COMPLETE");
  if (card.dataQuality?.state === "DATA_UNTRUSTED" || card.dataQuality?.strongSignalAllowed === false) blockers.push("DATA_QUALITY_BLOCKED");
  const observedAtMs = parseTimeOrNull(card.observedAt);
  const dataTimestampMs = parseTimeOrNull(input.dataTimestamp);
  const expiresAtMs = parseTimeOrNull(card.expiresAt);
  if (observedAtMs == null) blockers.push("SIGNAL_OBSERVED_AT_REQUIRED");
  if (dataTimestampMs == null) blockers.push("DATA_TIMESTAMP_REQUIRED");
  if (expiresAtMs == null) blockers.push("SIGNAL_EXPIRY_REQUIRED");
  if (observedAtMs != null && dataTimestampMs != null) {
    if (dataTimestampMs > observedAtMs) blockers.push("LOOKAHEAD_DATA_TIMESTAMP");
    else if (positiveInteger2(input.dataMaxAgeMs) && observedAtMs - dataTimestampMs > input.dataMaxAgeMs) blockers.push("DATA_EVIDENCE_STALE");
  }
  if (observedAtMs != null && expiresAtMs != null && expiresAtMs <= observedAtMs) blockers.push("INVALID_SIGNAL_EXPIRY");
  const entry = card.price;
  const stop = card.pricePlan?.stopLoss;
  const target1 = card.pricePlan?.targets?.[0];
  const target2 = card.pricePlan?.targets?.[1] ?? null;
  if (!positive5(entry)) blockers.push("REFERENCE_PRICE_REQUIRED");
  if (!positive5(stop)) blockers.push("STOP_LOSS_REQUIRED");
  if (!positive5(target1)) blockers.push("TARGET1_REQUIRED");
  if (target2 != null && !positive5(target2)) blockers.push("TARGET2_INVALID");
  if (positive5(entry) && positive5(stop) && positive5(target1) && direction && !priceStructureValid(entry, stop, target1, positive5(target2) ? target2 : null, direction)) {
    blockers.push("PRICE_PLAN_DIRECTION_MISMATCH");
  }
  if (blockers.length > 0 || !market || !direction || !performanceHorizon || !positive5(entry) || !positive5(stop) || !positive5(target1)) {
    return decision("BLOCKED", blockers);
  }
  const canonicalIdentity = Object.freeze({
    strategyId: identity2.strategyId,
    strategyVersion: identity2.strategyVersion,
    parameterHash: identity2.parameterHash,
    researchCodeSha: identity2.researchCodeSha.toLowerCase(),
    market: identity2.market,
    symbol: identity2.symbol,
    timeframe: identity2.timeframe,
    horizon: identity2.horizon,
    direction: identity2.direction
  });
  const snapshot = createImmutableSignalSnapshot({
    signalId: card.signalId,
    timestamp: card.observedAt,
    market,
    symbol: card.symbol,
    symbolName: nonEmpty5(card.name) ? card.name : null,
    strategyHorizon: performanceHorizon,
    direction,
    signalScore: card.score,
    displayConfidence: finiteOrNull(card.confidence),
    referencePrice: entry,
    entryPrice: entry,
    stopLoss: stop,
    target1,
    target2: positive5(target2) ? target2 : null,
    riskReward: finiteOrNull(card.pricePlan.riskReward),
    timeframes: [canonicalIdentity.timeframe],
    strategyProfileVersion: canonicalIdentity.strategyVersion,
    indicatorSnapshot: {
      matched: [...card.matched],
      notMatched: [...card.notMatched],
      unverified: [...card.unverified]
    },
    indicatorScores: card.quantScore ? { ...card.quantScore } : {},
    patternSnapshot: {},
    volumeContext: { volume: finiteOrNull(card.volume), tradingValue: finiteOrNull(card.tradingValue) },
    volatilityContext: { volatilityPercent: finiteOrNull(card.volatilityPercent) },
    trendContext: { direction: card.direction, action: card.action ?? null },
    marketRegime: regimeFromCard(card),
    liquidityContext: { liquidity: finiteOrNull(card.liquidity), spreadPercent: finiteOrNull(card.spreadPercent) },
    aiValidatorResult: card.aiValidation ? { ...card.aiValidation } : null,
    riskEngineResult: { riskScore: finiteOrNull(card.riskScore), riskLevel: card.riskLevel },
    dataProvenance: [...card.dataSources],
    dataTimestamp: input.dataTimestamp
  });
  const observation = Object.freeze({
    schemaVersion: "forward-recommendation-observation-v2",
    observationId: observationId2(snapshot, canonicalIdentity),
    source: FORWARD_OBSERVATION_SOURCE,
    status: "PENDING",
    identity: canonicalIdentity,
    signalGrade: card.signalGrade,
    expiresAt: card.expiresAt,
    dataTimestamp: input.dataTimestamp,
    dataMaxAgeMs: input.dataMaxAgeMs,
    publicDataOnly: true,
    snapshot,
    outcome: null,
    settledAt: null,
    executionAuthority: "NONE",
    simulatedOnly: true,
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false
  });
  return decision("OBSERVATION_READY", [], observation);
}

// src/services/forward-recommendation-observer-runtime.service.ts
var FORWARD_OBSERVER_TIMEFRAME = "60m";
var FORWARD_OBSERVER_DATA_MAX_AGE_MS = 90 * 60 * 1e3;
var FORWARD_OBSERVER_LANES = Object.freeze([
  { id: "KR_SWING_60M", market: "KR_STOCK", scannerMarket: "KR", batchSize: 20, timeframe: FORWARD_OBSERVER_TIMEFRAME },
  { id: "US_SWING_60M", market: "US_STOCK", scannerMarket: "US", batchSize: 20, timeframe: FORWARD_OBSERVER_TIMEFRAME },
  { id: "SPOT_SWING_60M", market: "CRYPTO_SPOT", scannerMarket: "spot", batchSize: 20, timeframe: FORWARD_OBSERVER_TIMEFRAME },
  { id: "FUTURES_SWING_60M", market: "CRYPTO_FUTURES", scannerMarket: "futures", batchSize: 20, timeframe: FORWARD_OBSERVER_TIMEFRAME }
]);
var SAFETY = Object.freeze({
  publicDataOnly: true,
  artifactOnly: true,
  executionAuthority: "NONE",
  financialMutationAllowed: false,
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
  profitabilityClaimAllowed: false
});
function iso(value) {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
function latestCardEvidenceTimestamp(card) {
  const signalAt = Date.parse(card.observedAt);
  if (!Number.isFinite(signalAt)) return null;
  const matched = card.evidence.filter((item) => item.status === "matched");
  if (matched.length === 0) return null;
  const values = matched.map((item) => iso(item.observedAt));
  if (values.some((value) => value == null)) return null;
  const timestamps = values;
  if (timestamps.some((value) => Date.parse(value) > signalAt)) return null;
  timestamps.sort((left, right) => Date.parse(left) - Date.parse(right));
  return timestamps[0] ?? null;
}

// src/services/bitget-futures-public-evidence.service.ts
var PRODUCT_TYPE = "USDT-FUTURES";
var GRANULARITY_MS = {
  "5m": 5 * 6e4,
  "1H": 60 * 6e4,
  "1D": 24 * 60 * 6e4
};
function finiteNumber(value, code) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}
function positiveNumber(value, code) {
  const parsed = finiteNumber(value, code);
  if (parsed <= 0) throw new Error(code);
  return parsed;
}
function objectValue(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
}
function successData(envelope, code) {
  const value = objectValue(envelope, code);
  if (value.code !== "00000") throw new Error(`${code}_PROVIDER_ERROR`);
  return value.data;
}
function singleDataObject(envelope, code) {
  const data = successData(envelope, code);
  if (!Array.isArray(data) || data.length !== 1) throw new Error(`${code}_DATA`);
  return objectValue(data[0], `${code}_DATA`);
}
function normalizeBitgetFuturesSymbol(symbol) {
  const normalized = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalized || !normalized.endsWith("USDT")) throw new Error("BITGET_SYMBOL_INVALID");
  return normalized;
}
function query(params) {
  return new URLSearchParams(params).toString();
}
function buildBitgetFuturesPublicRequests(symbol) {
  const normalized = normalizeBitgetFuturesSymbol(symbol);
  const candle = (target, granularity, limit) => ({
    method: "GET",
    path: "/api/v2/mix/market/candles",
    query: query({ symbol: target, productType: PRODUCT_TYPE, granularity, limit })
  });
  return {
    symbol5m: candle(normalized, "5m", "300"),
    symbol1h: candle(normalized, "1H", "240"),
    benchmarkBtc1h: candle("BTCUSDT", "1H", "240"),
    benchmarkBtc1d: candle("BTCUSDT", "1D", "120"),
    ticker: { method: "GET", path: "/api/v2/mix/market/ticker", query: query({ symbol: normalized, productType: PRODUCT_TYPE }) },
    funding: { method: "GET", path: "/api/v2/mix/market/current-fund-rate", query: query({ symbol: normalized, productType: PRODUCT_TYPE }) },
    openInterest: { method: "GET", path: "/api/v2/mix/market/open-interest", query: query({ symbol: normalized, productType: PRODUCT_TYPE }) },
    contract: { method: "GET", path: "/api/v2/mix/market/contracts", query: query({ symbol: normalized, productType: PRODUCT_TYPE }) }
  };
}
function normalizeBitgetCandles(envelope, granularity, nowMs) {
  const data = successData(envelope, "BITGET_CANDLES");
  if (!Array.isArray(data)) throw new Error("BITGET_CANDLES_DATA");
  const unique3 = /* @__PURE__ */ new Map();
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 7) throw new Error("BITGET_CANDLE_ROW");
    const candle = {
      timestampMs: positiveNumber(row[0], "BITGET_CANDLE_TIMESTAMP"),
      open: positiveNumber(row[1], "BITGET_CANDLE_OPEN"),
      high: positiveNumber(row[2], "BITGET_CANDLE_HIGH"),
      low: positiveNumber(row[3], "BITGET_CANDLE_LOW"),
      close: positiveNumber(row[4], "BITGET_CANDLE_CLOSE"),
      baseVolume: finiteNumber(row[5], "BITGET_CANDLE_BASE_VOLUME"),
      quoteVolume: finiteNumber(row[6], "BITGET_CANDLE_QUOTE_VOLUME")
    };
    if (candle.baseVolume < 0 || candle.quoteVolume < 0) throw new Error("BITGET_CANDLE_VOLUME_NEGATIVE");
    if (candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close) || candle.high < candle.low) {
      throw new Error("BITGET_CANDLE_OHLC_INVALID");
    }
    if (unique3.has(candle.timestampMs)) throw new Error("BITGET_CANDLE_DUPLICATE_TIMESTAMP");
    unique3.set(candle.timestampMs, candle);
  }
  const durationMs = GRANULARITY_MS[granularity];
  return [...unique3.values()].filter((candle) => candle.timestampMs + durationMs <= nowMs).sort((a, b) => a.timestampMs - b.timestampMs);
}
function buildBitgetFuturesPublicEvidence(input) {
  const symbol = normalizeBitgetFuturesSymbol(input.symbol);
  const ticker = singleDataObject(input.ticker, "BITGET_TICKER");
  if (normalizeBitgetFuturesSymbol(String(ticker.symbol ?? "")) !== symbol) throw new Error("BITGET_TICKER_SYMBOL_MISMATCH");
  const lastPrice = positiveNumber(ticker.lastPr, "BITGET_TICKER_LAST");
  const bidPrice = positiveNumber(ticker.bidPr, "BITGET_TICKER_BID");
  const askPrice = positiveNumber(ticker.askPr, "BITGET_TICKER_ASK");
  if (bidPrice > askPrice) throw new Error("BITGET_TICKER_CROSSED");
  const tickerTimestampMs = positiveNumber(ticker.ts, "BITGET_TICKER_TIMESTAMP");
  const funding = singleDataObject(input.funding, "BITGET_FUNDING");
  if (normalizeBitgetFuturesSymbol(String(funding.symbol ?? "")) !== symbol) throw new Error("BITGET_FUNDING_SYMBOL_MISMATCH");
  const oiData = objectValue(successData(input.openInterest, "BITGET_OPEN_INTEREST"), "BITGET_OPEN_INTEREST_DATA");
  if (!Array.isArray(oiData.openInterestList) || oiData.openInterestList.length !== 1) throw new Error("BITGET_OPEN_INTEREST_LIST");
  const oi = objectValue(oiData.openInterestList[0], "BITGET_OPEN_INTEREST_ROW");
  if (normalizeBitgetFuturesSymbol(String(oi.symbol ?? "")) !== symbol) throw new Error("BITGET_OPEN_INTEREST_SYMBOL_MISMATCH");
  const openInterest = finiteNumber(oi.size, "BITGET_OPEN_INTEREST_SIZE");
  if (openInterest < 0) throw new Error("BITGET_OPEN_INTEREST_SIZE");
  const openInterestTimestampMs = positiveNumber(oiData.ts, "BITGET_OPEN_INTEREST_TIMESTAMP");
  const contract = singleDataObject(input.contract, "BITGET_CONTRACT");
  if (normalizeBitgetFuturesSymbol(String(contract.symbol ?? "")) !== symbol) throw new Error("BITGET_CONTRACT_SYMBOL_MISMATCH");
  if (String(contract.symbolStatus ?? "") !== "normal") throw new Error("BITGET_CONTRACT_NOT_TRADABLE");
  const pricePlace = finiteNumber(contract.pricePlace, "BITGET_CONTRACT_PRICE_PLACE");
  const priceEndStep = positiveNumber(contract.priceEndStep, "BITGET_CONTRACT_PRICE_END_STEP");
  const minLeverage = positiveNumber(contract.minLever, "BITGET_CONTRACT_MIN_LEVERAGE");
  const maxLeverage = positiveNumber(contract.maxLever, "BITGET_CONTRACT_MAX_LEVERAGE");
  if (maxLeverage < minLeverage) throw new Error("BITGET_CONTRACT_LEVERAGE_RANGE");
  const maxRealtimeAgeMs = input.maxRealtimeAgeMs ?? 3e4;
  if (input.nowMs < tickerTimestampMs || input.nowMs - tickerTimestampMs > maxRealtimeAgeMs) throw new Error("BITGET_TICKER_STALE");
  if (input.nowMs < openInterestTimestampMs || input.nowMs - openInterestTimestampMs > maxRealtimeAgeMs) throw new Error("BITGET_OPEN_INTEREST_STALE");
  const candles5m = normalizeBitgetCandles(input.candles5m, "5m", input.nowMs);
  const candles1h = normalizeBitgetCandles(input.candles1h, "1H", input.nowMs);
  const benchmarkBtc1h = normalizeBitgetCandles(input.benchmarkBtc1h, "1H", input.nowMs);
  const benchmarkBtc1d = normalizeBitgetCandles(input.benchmarkBtc1d, "1D", input.nowMs);
  if (!candles5m.length || !candles1h.length || !benchmarkBtc1h.length || !benchmarkBtc1d.length) throw new Error("BITGET_CLOSED_CANDLE_EVIDENCE_MISSING");
  return {
    provider: "bitget",
    productType: PRODUCT_TYPE,
    symbol,
    lastPrice,
    bidPrice,
    askPrice,
    markPrice: positiveNumber(ticker.markPrice, "BITGET_TICKER_MARK"),
    indexPrice: positiveNumber(ticker.indexPrice, "BITGET_TICKER_INDEX"),
    tickerTimestampMs,
    fundingRate: finiteNumber(funding.fundingRate, "BITGET_FUNDING_RATE"),
    fundingIntervalHours: positiveNumber(funding.fundingRateInterval, "BITGET_FUNDING_INTERVAL"),
    nextFundingUpdateMs: positiveNumber(funding.nextUpdate, "BITGET_FUNDING_NEXT_UPDATE"),
    openInterest,
    openInterestTimestampMs,
    minTradeNum: positiveNumber(contract.minTradeNum, "BITGET_CONTRACT_MIN_TRADE_NUM"),
    sizeMultiplier: positiveNumber(contract.sizeMultiplier, "BITGET_CONTRACT_SIZE_MULTIPLIER"),
    minTradeUsdt: positiveNumber(contract.minTradeUSDT, "BITGET_CONTRACT_MIN_TRADE_USDT"),
    priceStep: priceEndStep * 10 ** -pricePlace,
    makerFeeRate: finiteNumber(contract.makerFeeRate, "BITGET_CONTRACT_MAKER_FEE"),
    takerFeeRate: finiteNumber(contract.takerFeeRate, "BITGET_CONTRACT_TAKER_FEE"),
    minLeverage,
    maxLeverage,
    candles5m,
    candles1h,
    benchmarkBtc1h,
    benchmarkBtc1d,
    observedAtMs: input.nowMs,
    dataQuality: "ready"
  };
}

// src/services/public-market-http.ts
var UPBIT_BASE3 = "https://api.upbit.com";
var BITGET_BASE3 = "https://api.bitget.com";
var MarketInformationError = class extends Error {
  constructor(code, statusCode, retryable, message) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.name = "MarketInformationError";
  }
};
function abortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}
var defaultSleep = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError());
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  const onAbort = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    reject(abortError());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
});
function validatePublicMarketUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  const upbitAllowed = url.origin === UPBIT_BASE3 && (url.pathname === "/v1/market/all" || url.pathname === "/v1/ticker");
  const bitgetAllowed = url.origin === BITGET_BASE3 && (url.pathname.startsWith("/api/v2/mix/market/") || url.pathname.startsWith("/api/v3/market/"));
  if (!upbitAllowed && !bitgetAllowed) {
    throw new MarketInformationError(
      "PUBLIC_MARKET_URL_BLOCKED",
      500,
      false,
      "허용되지 않은 외부 시장정보 URL입니다."
    );
  }
  return url;
}
function retryDelay(response, attempt) {
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5e3, seconds * 1e3);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(5e3, Math.max(0, date - Date.now()));
  }
  return Math.min(2e3, 250 * 2 ** attempt + Math.floor(Math.random() * 150));
}
async function fetchPublicMarketJson(value, options) {
  const url = validatePublicMarketUrl(value);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 8e3;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason ?? abortError());
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response = null;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "seungjae-market-information/1.0"
        },
        signal: controller.signal
      });
      const retryableStatus = response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504;
      if (!response.ok) {
        if (retryableStatus && attempt === 0) {
          await sleepImpl(retryDelay(response, attempt), options.signal);
          continue;
        }
        throw new MarketInformationError(
          response.status === 429 ? "UPSTREAM_RATE_LIMITED" : `UPSTREAM_HTTP_${response.status}`,
          response.status,
          retryableStatus,
          response.status === 429 ? `${options.provider} 호출 한도에 도달했습니다.` : `${options.provider} 응답 오류입니다.`
        );
      }
      const text3 = await response.text();
      if (!text3.trim()) {
        throw new MarketInformationError("UPSTREAM_EMPTY_BODY", 502, true, `${options.provider} 응답 본문이 비어 있습니다.`);
      }
      let payload;
      try {
        payload = JSON.parse(text3);
      } catch {
        throw new MarketInformationError("UPSTREAM_INVALID_JSON", 502, true, `${options.provider} JSON 응답을 해석할 수 없습니다.`);
      }
      const objectPayload = payload && typeof payload === "object";
      if (!objectPayload) {
        throw new MarketInformationError("UPSTREAM_PRIMITIVE_PAYLOAD", 502, false, `${options.provider} 응답 형식이 객체 또는 배열이 아닙니다.`);
      }
      if (!Array.isArray(payload) && Object.keys(payload).length === 0) {
        throw new MarketInformationError("UPSTREAM_EMPTY_OBJECT", 502, false, `${options.provider} 응답 객체가 비어 있습니다.`);
      }
      return payload;
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      if (error instanceof MarketInformationError) {
        if (error.retryable && attempt === 0) {
          await sleepImpl(retryDelay(response, attempt), options.signal);
          continue;
        }
        throw error;
      }
      const timedOut = controller.signal.aborted;
      if (attempt === 0) {
        await sleepImpl(retryDelay(response, attempt), options.signal);
        continue;
      }
      throw new MarketInformationError(
        timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK_ERROR",
        timedOut ? 504 : 502,
        true,
        timedOut ? `${options.provider} 응답 시간이 초과되었습니다.` : `${options.provider} 네트워크 연결에 실패했습니다.`
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new MarketInformationError(
    "UPSTREAM_RETRY_EXHAUSTED",
    502,
    true,
    `${options.provider} 재시도 후에도 응답하지 않았습니다.`
  );
}

// ../market-prediction-lab/src/bitget-position-tier-v1.js
var BITGET_POSITION_TIER_CONTRACT = Object.freeze({
  schemaVersion: "bitget-position-tier-v1",
  source: "bitget-public-v2-query-position-lever",
  sizedNotionalRequired: true,
  scalarDefaultAllowed: false,
  unknownIsZero: false
});
function finite11(value, code) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}
function selectBitgetPositionTier(tiers, sizedNotional) {
  if (!Number.isFinite(sizedNotional) || sizedNotional <= 0) {
    throw new Error("BITGET_POSITION_TIER_SIZED_NOTIONAL_REQUIRED");
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error("BITGET_POSITION_TIER_SCHEDULE_REQUIRED");
  }
  const normalized = tiers.map((tier, index) => {
    const startUnit = finite11(tier?.startUnit ?? 0, "BITGET_POSITION_TIER_START_INVALID");
    const maintenanceMarginRate = finite11(tier?.keepMarginRate, "BITGET_POSITION_TIER_MMR_INVALID");
    if (startUnit < 0 || maintenanceMarginRate < 0 || maintenanceMarginRate >= 1) {
      throw new Error("BITGET_POSITION_TIER_INVALID");
    }
    return Object.freeze({ index, startUnit, maintenanceMarginRate });
  }).sort((left, right) => left.startUnit - right.startUnit);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].startUnit === normalized[index].startUnit) {
      throw new Error("BITGET_POSITION_TIER_DUPLICATE_START");
    }
  }
  const selected = normalized.filter((tier) => tier.startUnit <= sizedNotional).at(-1);
  if (!selected) throw new Error("BITGET_POSITION_TIER_NOT_FOUND_FOR_NOTIONAL");
  return Object.freeze({
    ...selected,
    sizedNotional,
    source: BITGET_POSITION_TIER_CONTRACT.source,
    schemaVersion: BITGET_POSITION_TIER_CONTRACT.schemaVersion
  });
}

// ../market-intelligence-sidecar/src/execution-quality.mjs
var ENFORCEMENT_MODES = /* @__PURE__ */ new Set(["OBSERVE_ONLY", "REQUIRED_FOR_PARENT_GATE"]);
var BUY_DIRECTIONS = /* @__PURE__ */ new Set(["BUY", "LONG"]);
var SELL_DIRECTIONS = /* @__PURE__ */ new Set(["SELL", "SHORT"]);
var DEFAULT_EXECUTION_QUALITY_POLICY = Object.freeze({
  version: "MIS_EXECUTION_QUALITY_V1",
  enforcement: "OBSERVE_ONLY",
  minBookCoverageRatio: 1,
  maxBookWalkSlippageBps: 30,
  minFillModelSamples: 500,
  minFillProbability: 0.65,
  maxFillModelBrierScore: 0.25,
  maxFillModelCalibrationError: 0.1,
  maxFillModelAgeMs: 7 * 24 * 60 * 60 * 1e3,
  maxObservedImplementationShortfallBps: 50
});
function finite12(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp6(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function resolvePolicy(policy = {}) {
  const merged = { ...DEFAULT_EXECUTION_QUALITY_POLICY, ...policy ?? {} };
  if (typeof merged.version !== "string" || !merged.version.trim()) throw new Error("EXECUTION_POLICY_VERSION_REQUIRED");
  merged.enforcement = String(merged.enforcement ?? "").toUpperCase();
  if (!ENFORCEMENT_MODES.has(merged.enforcement)) throw new Error("EXECUTION_POLICY_ENFORCEMENT_INVALID");
  for (const key of Object.keys(DEFAULT_EXECUTION_QUALITY_POLICY).filter((key2) => key2 !== "version" && key2 !== "enforcement")) {
    const value = Number(merged[key]);
    if (!Number.isFinite(value)) throw new Error(`EXECUTION_POLICY_FIELD_INVALID:${key}`);
    merged[key] = value;
  }
  if (!(merged.minBookCoverageRatio > 0 && merged.minBookCoverageRatio <= 1)) throw new Error("BOOK_COVERAGE_POLICY_INVALID");
  if (!(merged.minFillProbability >= 0 && merged.minFillProbability <= 1)) throw new Error("FILL_PROBABILITY_POLICY_INVALID");
  return merged;
}
function normalizeDirection(direction) {
  const normalized = String(direction ?? "").toUpperCase();
  if (BUY_DIRECTIONS.has(normalized)) return "BUY";
  if (SELL_DIRECTIONS.has(normalized)) return "SELL";
  throw new Error("EXECUTION_DIRECTION_INVALID");
}
function normalizeLevels(levels, ascending) {
  return (Array.isArray(levels) ? levels : []).map((level) => Array.isArray(level) ? { price: finite12(level[0]), size: finite12(level[1]) } : { price: finite12(level?.price), size: finite12(level?.size ?? level?.qty ?? level?.quantity) }).filter((level) => level.price > 0 && level.size > 0).sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
}
function walkOrderBook(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const direction = String(raw.direction ?? "").trim();
  if (!direction) return { status: "NOT_AVAILABLE", reason: "EXECUTION_DIRECTION_REQUIRED" };
  const side = normalizeDirection(direction);
  const targetQty = finite12(raw.targetQty);
  if (!(targetQty > 0)) return { status: "NOT_AVAILABLE", reason: "TARGET_QTY_REQUIRED" };
  const levels = side === "BUY" ? normalizeLevels(raw.asks, true) : normalizeLevels(raw.bids, false);
  if (!levels.length) return { status: "NOT_AVAILABLE", reason: "EXECUTABLE_BOOK_NOT_AVAILABLE" };
  const arrivalPrice = finite12(raw.arrivalPrice, levels[0].price);
  if (!(arrivalPrice > 0)) return { status: "NOT_AVAILABLE", reason: "ARRIVAL_PRICE_INVALID" };
  let remaining = targetQty;
  let filledQty = 0;
  let notional = 0;
  let levelsConsumed = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    remaining -= take;
    filledQty += take;
    notional += take * level.price;
    levelsConsumed += 1;
  }
  const coverageRatio = clamp6(filledQty / targetQty, 0, 1);
  const vwap = filledQty > 0 ? notional / filledQty : null;
  const rawSlippageBps = vwap == null ? null : side === "BUY" ? (vwap - arrivalPrice) / arrivalPrice * 1e4 : (arrivalPrice - vwap) / arrivalPrice * 1e4;
  const slippageBps = rawSlippageBps == null ? null : Math.max(0, rawSlippageBps);
  const reasons = [];
  if (coverageRatio < policy.minBookCoverageRatio) reasons.push("INSUFFICIENT_VISIBLE_DEPTH");
  if (slippageBps != null && slippageBps > policy.maxBookWalkSlippageBps) reasons.push("BOOK_WALK_SLIPPAGE_TOO_HIGH");
  return {
    status: reasons.length ? "VETO" : "PASS",
    reasons,
    side,
    targetQty,
    filledQty,
    unfilledQty: Math.max(0, remaining),
    coverageRatio,
    vwap,
    arrivalPrice,
    slippageBps,
    levelsConsumed,
    model: "VISIBLE_L2_BOOK_WALK_ONLY",
    permanentMarketImpactEstimated: false
  };
}
function evaluateCalibratedFillModel(raw = {}, policyInput = {}, nowInput = Date.now()) {
  const policy = resolvePolicy(policyInput);
  const modelId = String(raw.modelId ?? "").trim();
  const fillProbability = finite12(raw.fillProbability);
  const evaluationSamples = Math.max(0, finite12(raw.evaluationSamples, 0));
  const brierScore = finite12(raw.brierScore);
  const calibrationError = finite12(raw.calibrationError);
  const evaluatedAt = finite12(raw.evaluatedAt);
  const now = finite12(nowInput, Date.now());
  const ageMs = evaluatedAt == null ? null : Math.max(0, now - evaluatedAt);
  if (!modelId || fillProbability == null || brierScore == null || calibrationError == null || evaluatedAt == null) return { status: "NOT_AVAILABLE", reason: "CALIBRATED_FILL_MODEL_EVIDENCE_MISSING" };
  if (!(fillProbability >= 0 && fillProbability <= 1)) return { status: "NOT_AVAILABLE", reason: "FILL_PROBABILITY_INVALID" };
  if (evaluationSamples < policy.minFillModelSamples) return { status: "NOT_AVAILABLE", reason: "FILL_MODEL_SAMPLE_INSUFFICIENT", evaluationSamples, minimumSamples: policy.minFillModelSamples };
  if (ageMs > policy.maxFillModelAgeMs) return { status: "NOT_AVAILABLE", reason: "FILL_MODEL_EVIDENCE_STALE", ageMs };
  if (brierScore > policy.maxFillModelBrierScore || calibrationError > policy.maxFillModelCalibrationError) return { status: "NOT_AVAILABLE", reason: "FILL_MODEL_CALIBRATION_QUALITY_INSUFFICIENT", brierScore, calibrationError };
  return {
    status: fillProbability >= policy.minFillProbability ? "PASS" : "VETO",
    reason: fillProbability >= policy.minFillProbability ? null : "FILL_PROBABILITY_TOO_LOW",
    modelId,
    fillProbability,
    threshold: policy.minFillProbability,
    evaluationSamples,
    brierScore,
    calibrationError,
    evaluatedAt,
    ageMs
  };
}

// src/services/paper-simulated-execution-evidence.service.ts
var PAPER_SIMULATED_EXECUTION_EVIDENCE_VERSION = "paper-simulated-execution-evidence-v1";
var PAPER_SIMULATED_EXECUTION_EVIDENCE_SAFETY = Object.freeze({
  schemaVersion: "paper-simulated-execution-evidence-safety-v1",
  executionMode: "SIMULATED_EXECUTION_ONLY",
  executionAuthority: "NONE",
  privateApiAllowed: false,
  liveTrading: false,
  realFillClaimAllowed: false,
  currentPriceFillAssumptionAllowed: false,
  financialMutationAllowed: false
});
function finite13(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function nonEmpty6(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function levelPrice(level) {
  if (Array.isArray(level)) return finite13(level[0]);
  return finite13(level.price);
}
function bestPrice(levels, side) {
  const prices = levels.map(levelPrice).filter((value) => value != null && value > 0);
  if (prices.length === 0) return null;
  return side === "BID" ? Math.max(...prices) : Math.min(...prices);
}
function cloneLevel(level) {
  if (Array.isArray(level)) return [level[0], level[1]];
  return { ...level };
}
function unique2(values) {
  return Object.freeze([...new Set(values)]);
}
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function buildPaperSimulatedExecutionEvidence(input) {
  const nowMs = finite13(input?.nowMs) ?? Date.now();
  const observedAtMs = finite13(input?.observedAtMs);
  const maximumAgeMs = finite13(input?.maximumAgeMs);
  const targetQuantity = finite13(input?.targetQuantity);
  const blockers = [];
  if (!nonEmpty6(input?.source)) blockers.push("PUBLIC_DEPTH_SOURCE_REQUIRED");
  if (!nonEmpty6(input?.market)) blockers.push("MARKET_REQUIRED");
  if (!nonEmpty6(input?.symbol)) blockers.push("SYMBOL_REQUIRED");
  if (!nonEmpty6(input?.direction)) blockers.push("EXECUTION_DIRECTION_REQUIRED");
  if (!(targetQuantity != null && targetQuantity > 0)) blockers.push("TARGET_QUANTITY_REQUIRED");
  if (!(observedAtMs != null && observedAtMs > 0)) blockers.push("PUBLIC_DEPTH_TIMESTAMP_REQUIRED");
  if (!(maximumAgeMs != null && maximumAgeMs > 0)) blockers.push("PUBLIC_DEPTH_FRESHNESS_CONTRACT_REQUIRED");
  if (observedAtMs != null && maximumAgeMs != null && nowMs - observedAtMs > maximumAgeMs) {
    blockers.push("PUBLIC_DEPTH_STALE");
  }
  if (!Array.isArray(input?.provenance) || input.provenance.length === 0 || !input.provenance.every(nonEmpty6)) {
    blockers.push("PUBLIC_DEPTH_PROVENANCE_REQUIRED");
  }
  const bids = Array.isArray(input?.bids) ? input.bids.map(cloneLevel) : [];
  const asks = Array.isArray(input?.asks) ? input.asks.map(cloneLevel) : [];
  const bid = bestPrice(bids, "BID");
  const ask = bestPrice(asks, "ASK");
  if (bid == null || ask == null || ask < bid) blockers.push("PUBLIC_DEPTH_BOOK_INVALID");
  const bookWalk = walkOrderBook({
    direction: input?.direction,
    targetQty: input?.targetQuantity,
    bids,
    asks
  }, input?.policy ?? {});
  if (bookWalk?.status === "NOT_AVAILABLE") blockers.push(String(bookWalk.reason ?? "BOOK_WALK_NOT_AVAILABLE"));
  const fillModel = evaluateCalibratedFillModel(
    input?.calibratedFillModel ?? {},
    input?.policy ?? {},
    nowMs
  );
  if (fillModel?.status === "NOT_AVAILABLE") blockers.push(String(fillModel.reason ?? "CALIBRATED_FILL_MODEL_EVIDENCE_MISSING"));
  const requestStartedAtMs = finite13(input?.requestStartedAtMs);
  const requestCompletedAtMs = finite13(input?.requestCompletedAtMs);
  const observedRoundTripMs = requestStartedAtMs != null && requestCompletedAtMs != null && requestCompletedAtMs >= requestStartedAtMs ? requestCompletedAtMs - requestStartedAtMs : null;
  if (observedRoundTripMs == null) blockers.push("OBSERVED_LATENCY_DURATION_MISSING");
  blockers.push(
    "LATENCY_COST_EVIDENCE_UNAVAILABLE",
    "LIQUIDITY_IMPACT_COST_EVIDENCE_UNAVAILABLE",
    "PARTIAL_FILL_COST_EVIDENCE_UNAVAILABLE"
  );
  const spreadAbsolute = bid != null && ask != null && ask >= bid ? ask - bid : null;
  const spreadPercent2 = spreadAbsolute != null && bid != null && ask != null ? spreadAbsolute / ((bid + ask) / 2) * 100 : null;
  return freeze({
    schemaVersion: PAPER_SIMULATED_EXECUTION_EVIDENCE_VERSION,
    status: "BLOCKED_DATA",
    modelStatus: bookWalk?.status === "NOT_AVAILABLE" ? "BLOCKED_DATA" : "SIMULATION_AVAILABLE",
    blockers: unique2(blockers),
    source: nonEmpty6(input?.source) ? input.source.trim() : null,
    timestamp: observedAtMs,
    market: nonEmpty6(input?.market) ? input.market.trim() : null,
    symbol: nonEmpty6(input?.symbol) ? input.symbol.trim() : null,
    observed: {
      bid,
      ask,
      spread: { absolute: spreadAbsolute, percent: spreadPercent2, quality: "OBSERVED_PUBLIC_DEPTH" },
      depth: { bids, asks, quality: "OBSERVED_PUBLIC_DEPTH" },
      latencyEvidence: {
        observedRoundTripMs,
        costPercent: null,
        quality: observedRoundTripMs == null ? "NOT_AVAILABLE" : "OBSERVED_DURATION_ONLY"
      }
    },
    estimated: {
      slippageEstimate: {
        percent: finite13(bookWalk?.slippageBps) == null ? null : Number(bookWalk.slippageBps) / 100,
        quality: bookWalk?.status === "NOT_AVAILABLE" ? "NOT_AVAILABLE" : "ESTIMATED",
        model: bookWalk?.model ?? null
      },
      liquidityEvidence: {
        targetQuantity: targetQuantity != null && targetQuantity > 0 ? targetQuantity : null,
        visibleExecutableQuantity: finite13(bookWalk?.filledQty),
        visibleCoverageRatio: finite13(bookWalk?.coverageRatio),
        permanentMarketImpactEstimated: false
      },
      partialFillEstimate: {
        visibleDepthFillFraction: finite13(bookWalk?.coverageRatio),
        calibratedFillProbability: finite13(fillModel?.fillProbability),
        quality: fillModel?.status === "NOT_AVAILABLE" ? "UNCALIBRATED_MODEL_ONLY" : "CALIBRATED_ESTIMATE"
      }
    },
    confidence: {
      classification: fillModel?.status === "NOT_AVAILABLE" ? "UNCALIBRATED" : "CALIBRATED",
      numericConfidence: null,
      fillModel
    },
    provenance: Array.isArray(input?.provenance) ? [...input.provenance] : [],
    executionMode: "SIMULATED_EXECUTION_ONLY",
    publicDepthIsFillProof: false,
    realFillClaim: false,
    currentPriceIsFillPrice: false,
    costEvidenceReady: false,
    safety: PAPER_SIMULATED_EXECUTION_EVIDENCE_SAFETY
  });
}

// src/services/authoritative-paper-callback-owners.service.ts
var AUTHORITATIVE_PAPER_CALLBACK_OWNERS_VERSION = "authoritative-paper-callback-owners-v1";
var QUALITIES2 = /* @__PURE__ */ new Set(["OBSERVED", "DOCUMENTED", "ESTIMATED", "NOT_APPLICABLE"]);
function finite14(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function positive6(value) {
  return finite14(value) && value > 0;
}
function nonNegative5(value) {
  return finite14(value) && value >= 0;
}
function nonEmpty7(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function fresh2(observedAtMs, maximumAgeMs, nowMs) {
  return positive6(observedAtMs) && positive6(maximumAgeMs) && observedAtMs <= nowMs && nowMs - observedAtMs <= maximumAgeMs;
}
function freeze2(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze2(child);
  return Object.freeze(value);
}
function riskPolicy(value, nowMs) {
  if (value?.schemaVersion !== "authoritative-paper-risk-policy-evidence-v1" || !positive6(value.leverage) || !positive6(value.riskPercent) || value.riskPercent > 1 || value.marginMode !== "isolated" && value.marginMode !== "cross" || !nonEmpty7(value.source) || !fresh2(value.observedAtMs, value.maximumAgeMs, nowMs)) {
    throw new Error("AUTHORITATIVE_PAPER_RISK_POLICY_EVIDENCE_INVALID");
  }
  return freeze2({ ...value, source: value.source.trim() });
}
function paperStateFromAuthoritativeSnapshot(snapshot, nowMs = Date.now()) {
  return validateImmutablePaperTradingStateSnapshot(snapshot, nowMs).state;
}
function buildAuthoritativeSizedContractRules(input) {
  const nowMs = input.nowMs ?? Date.now();
  const maximumAgeMs = input.maximumAgeMs ?? 3e4;
  const evidence = input.publicEvidence;
  if (evidence?.provider !== "bitget" || evidence.dataQuality !== "ready" || !positive6(input.sizedNotional) || !fresh2(input.observedAtMs, maximumAgeMs, nowMs) || !positive6(evidence.sizeMultiplier) || !Number.isInteger(input.quantityPrecision) || input.quantityPrecision < 0 || !positive6(evidence.minTradeNum) || !positive6(evidence.minTradeUsdt) || !positive6(evidence.maxLeverage)) {
    throw new Error("AUTHORITATIVE_SIZED_CONTRACT_INPUT_INVALID");
  }
  const policy = riskPolicy(input.riskPolicy, nowMs);
  if (policy.leverage > evidence.maxLeverage) throw new Error("AUTHORITATIVE_RISK_POLICY_LEVERAGE_EXCEEDS_CONTRACT");
  const selectedTier = selectBitgetPositionTier(input.positionTiers, input.sizedNotional);
  const contractRules = freeze2({
    symbol: evidence.symbol,
    quantityStep: evidence.sizeMultiplier,
    quantityPrecision: input.quantityPrecision,
    minimumQuantity: evidence.minTradeNum,
    minimumNotional: evidence.minTradeUsdt,
    maximumLeverage: evidence.maxLeverage,
    maintenanceMarginRate: selectedTier.maintenanceMarginRate,
    status: "live",
    updatedAt: new Date(input.observedAtMs).toISOString(),
    warnings: []
  });
  return freeze2({
    schemaVersion: "sized-bitget-paper-contract-rules-v1",
    contractRules,
    riskPolicy: policy,
    sizedNotional: input.sizedNotional,
    selectedTier,
    provenance: [
      "bitget-public-v2-contracts",
      "bitget-public-v2-query-position-lever",
      policy.source
    ],
    executionAuthority: "NONE",
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false
  });
}
function buildAuthoritativePaperExecutionObservation(input) {
  const nowMs = input.nowMs ?? Date.now();
  const policy = riskPolicy(input.riskPolicy, nowMs);
  const evidence = buildPaperSimulatedExecutionEvidence({
    ...input.executionEvidenceInput,
    nowMs
  });
  const estimated = evidence.estimated;
  const slippage = estimated?.slippageEstimate;
  const liquidity = estimated?.liquidityEvidence;
  const partialFill = estimated?.partialFillEstimate;
  const confidence = evidence.confidence;
  const fillModel = confidence?.fillModel;
  if (evidence.modelStatus !== "SIMULATION_AVAILABLE" || slippage?.quality !== "ESTIMATED" || !nonNegative5(slippage.percent) || !positive6(liquidity?.visibleExecutableQuantity) || !positive6(liquidity?.visibleCoverageRatio) || Number(liquidity.visibleCoverageRatio) < 1 || partialFill?.quality !== "CALIBRATED_ESTIMATE" || fillModel?.status !== "PASS") {
    throw new Error("AUTHORITATIVE_EXECUTION_OBSERVATION_DATA_UNAVAILABLE");
  }
  const observedAtMs = input.executionEvidenceInput.observedAtMs;
  return freeze2({
    providerProvenance: input.executionEvidenceInput.provenance.join("+"),
    slippage: {
      valuePercent: Number(slippage.percent),
      quality: "ESTIMATED",
      source: String(slippage.model ?? "VISIBLE_L2_BOOK_WALK_ONLY"),
      observedAtMs
    },
    liquidity: {
      value: Number(liquidity.visibleExecutableQuantity),
      source: "BITGET_PUBLIC_VISIBLE_L2_EXECUTABLE_QUANTITY",
      observedAtMs
    },
    partialFill: {
      model: "ORDER_BOOK",
      source: String(fillModel.modelId ?? "CALIBRATED_FILL_MODEL"),
      observedAtMs
    },
    leverage: policy.leverage,
    riskPercent: policy.riskPercent,
    marginMode: policy.marginMode
  });
}
function validatedComponent(value, nowMs, maximumAgeMs, code) {
  if (!value || !nonNegative5(value.valuePercent) || !QUALITIES2.has(value.quality) || !nonEmpty7(value.source) || !fresh2(value.observedAtMs, maximumAgeMs, nowMs) || value.quality === "NOT_APPLICABLE" && value.valuePercent !== 0) {
    throw new Error(code);
  }
  return freeze2({ ...value, source: value.source.trim() });
}
function buildAuthoritativeSupplementalCostEvidence(input) {
  const nowMs = input.nowMs ?? Date.now();
  const maximumAgeMs = input.maximumAgeMs ?? 3e4;
  if (!nonEmpty7(input.costPolicyId) || !fresh2(input.observedAtMs, maximumAgeMs, nowMs)) {
    throw new Error("AUTHORITATIVE_COST_POLICY_EVIDENCE_INVALID");
  }
  return freeze2({
    costPolicyId: input.costPolicyId.trim(),
    observedAtMs: input.observedAtMs,
    latency: validatedComponent(input.latency, nowMs, maximumAgeMs, "AUTHORITATIVE_LATENCY_COST_EVIDENCE_REQUIRED"),
    liquidityImpact: validatedComponent(input.liquidityImpact, nowMs, maximumAgeMs, "AUTHORITATIVE_LIQUIDITY_COST_EVIDENCE_REQUIRED"),
    partialFillImpact: validatedComponent(input.partialFillImpact, nowMs, maximumAgeMs, "AUTHORITATIVE_PARTIAL_FILL_COST_EVIDENCE_REQUIRED"),
    funding: validatedComponent(input.funding, nowMs, maximumAgeMs, "AUTHORITATIVE_FUNDING_COST_EVIDENCE_REQUIRED")
  });
}
var AUTHORITATIVE_PAPER_CALLBACK_OWNERS_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_CALLBACK_OWNERS_VERSION,
  owners: Object.freeze([
    "paperStateForCard",
    "contractRulesForCard",
    "executionObservationForCard",
    "supplementalCostEvidenceForCard"
  ]),
  ownerMissingCount: 0,
  dataReadiness: "RUNTIME_VALIDATED_BLOCKED_DATA",
  recurringLedgerDerivationAllowed: false,
  scalarMaintenanceMarginDefaultAllowed: false,
  uncalibratedFillClaimAllowed: false,
  unknownCostIsZero: false,
  executionAuthority: "NONE",
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false
});

// src/services/authoritative-paper-evidence-sources.service.ts
var AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_VERSION = "authoritative-paper-evidence-sources-v1";
var AUTHORITATIVE_PAPER_BLOCKED_DATA_SOURCE_CONTRACT_VERSION = "authoritative-paper-blocked-data-source-contract-v1";
var AUTHORITATIVE_PAPER_CALLBACK_OWNER_CONTRACT_VERSION = "authoritative-paper-callback-owner-contract-v1";
var BITGET_BASE_URL = "https://api.bitget.com";
var FUTURES_LANE = FORWARD_OBSERVER_LANES.find((lane) => lane.market === "CRYPTO_FUTURES");
function exactSha2(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}
function scannerCard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = value;
  return typeof card.signalId === "string" && typeof card.symbol === "string" ? value : null;
}
function abortSignal(value) {
  return value instanceof AbortSignal ? value : void 0;
}
function publicUrl(request) {
  if (request.method !== "GET") throw new Error("AUTHORITATIVE_PUBLIC_MARKET_GET_REQUIRED");
  const url = new URL(request.path, BITGET_BASE_URL);
  url.search = request.query;
  return url;
}
function ownedSource({
  callback,
  implementation,
  requiredData,
  source
}) {
  return Object.freeze(Object.assign(source, {
    authoritativeOwner: Object.freeze({
      schemaVersion: AUTHORITATIVE_PAPER_CALLBACK_OWNER_CONTRACT_VERSION,
      callback,
      ownerStatus: "OWNER_EXISTS",
      dataReadiness: "RUNTIME_VALIDATED_BLOCKED_DATA",
      implementation,
      requiredData: Object.freeze([...requiredData]),
      missingDataBehavior: "BLOCKED_DATA",
      unknownIsZero: false
    })
  }));
}
function defaultDependencies() {
  return Object.freeze({
    scan: CryptoSignalScannerService.scan.bind(CryptoSignalScannerService),
    align: CryptoPricePrecisionService.align.bind(CryptoPricePrecisionService),
    rank: rankScannerCandidates,
    withCanonicalActions: withScannerCanonicalActions,
    attachCanonicalIdentity: attachScannerCanonicalPaperIdentity,
    resolveCanonicalIdentity: resolveScannerCanonicalPaperIdentity,
    prepareObservation: prepareForwardRecommendationObservation,
    latestEvidenceTimestamp: latestCardEvidenceTimestamp,
    buildPublicRequests: buildBitgetFuturesPublicRequests,
    buildPublicEvidence: buildBitgetFuturesPublicEvidence,
    fetchPublicJson: (url, input) => fetchPublicMarketJson(url, input),
    paperStateSnapshotForCard: async () => null,
    sizedContractInputForCard: async () => null,
    executionObservationInputForCard: async () => null,
    supplementalCostInputForCard: async () => null,
    now: Date.now
  });
}
function normalizeRankedScannerResponse(response, researchCodeSha, dependencies) {
  const ranking = dependencies.rank({
    cards: response.cards,
    market: response.market,
    strategy: "swing",
    limit: 10
  });
  const directionalCards = ranking.cards.filter((card) => card.direction === "LONG" || card.direction === "SHORT");
  const actioned = dependencies.withCanonicalActions({
    ...response,
    cards: directionalCards,
    execution: {
      ...response.execution,
      hardFilterPassCount: ranking.diagnostics.hardFilterPassCount,
      hardFilterRejectedCount: ranking.diagnostics.hardFilterRejectedCount,
      softCandidateCount: ranking.diagnostics.softCandidateCount,
      finalDisplayedCount: directionalCards.length,
      sGradeCount: directionalCards.filter((card) => card.signalGrade === "S").length,
      aGradeCount: directionalCards.filter((card) => card.signalGrade === "A").length,
      bGradeCount: directionalCards.filter((card) => card.signalGrade === "B").length,
      backtestMissingCount: ranking.diagnostics.backtestMissingCount
    }
  });
  return dependencies.attachCanonicalIdentity({
    response: actioned,
    market: "CRYPTO_FUTURES",
    researchCodeSha
  });
}
function createAuthoritativePaperEvidenceSourceWiring({
  researchCodeSha,
  dependencies: overrides = {}
}) {
  const normalizedSha = String(researchCodeSha ?? "").trim().toLowerCase();
  if (!exactSha2(normalizedSha)) throw new TypeError("authoritative Paper evidence sources require an exact research SHA");
  if (!FUTURES_LANE) throw new Error("FORWARD_OBSERVER_FUTURES_LANE_REQUIRED");
  const dependencies = Object.freeze({ ...defaultDependencies(), ...overrides });
  const callbackOwnerSources = Object.freeze({
    paperStateForCard: ownedSource({
      callback: "paperStateForCard",
      implementation: "paperStateFromAuthoritativeSnapshot/validateImmutablePaperTradingStateSnapshot",
      requiredData: ["lossless immutable PaperTradingState snapshot from the canonical Paper state writer"],
      source: async (context) => {
        const snapshot = await dependencies.paperStateSnapshotForCard(context);
        return snapshot == null ? null : paperStateFromAuthoritativeSnapshot(snapshot, dependencies.now());
      }
    }),
    contractRulesForCard: ownedSource({
      callback: "contractRulesForCard",
      implementation: "buildAuthoritativeSizedContractRules/selectBitgetPositionTier",
      requiredData: ["public contracts", "public position tier schedule", "sized notional", "immutable risk policy evidence"],
      source: async (context) => {
        const input = await dependencies.sizedContractInputForCard(context);
        return input == null ? null : buildAuthoritativeSizedContractRules(input).contractRules;
      }
    }),
    executionObservationForCard: ownedSource({
      callback: "executionObservationForCard",
      implementation: "buildAuthoritativePaperExecutionObservation/buildPaperSimulatedExecutionEvidence",
      requiredData: ["public L2 depth", "target quantity", "request timing", "calibrated fill model", "immutable risk policy evidence"],
      source: async (context) => {
        const input = await dependencies.executionObservationInputForCard(context);
        return input == null ? null : buildAuthoritativePaperExecutionObservation(input);
      }
    }),
    supplementalCostEvidenceForCard: ownedSource({
      callback: "supplementalCostEvidenceForCard",
      implementation: "buildAuthoritativeSupplementalCostEvidence",
      requiredData: ["latency cost evidence", "liquidity impact cost evidence", "partial-fill cost evidence", "funding evidence"],
      source: async (context) => {
        const input = await dependencies.supplementalCostInputForCard(context);
        return input == null ? null : buildAuthoritativeSupplementalCostEvidence(input);
      }
    })
  });
  return Object.freeze({
    async scanBatchForMarket({ market, signal }) {
      if (market !== "CRYPTO_FUTURES") throw new Error("AUTHORITATIVE_SCANNER_MARKET_NOT_OWNED");
      const outerSignal = abortSignal(signal);
      return async function scanBatch({ market: selectedMarket, cursor }) {
        if (selectedMarket !== "CRYPTO_FUTURES") throw new Error("AUTHORITATIVE_SCANNER_MARKET_MISMATCH");
        const scanned = await dependencies.scan({
          memberId: "forward-observer-public-only",
          market: "futures",
          strategyMode: "swing",
          timeframe: FUTURES_LANE.timeframe,
          condition: "trend",
          cursor,
          batchSize: FUTURES_LANE.batchSize,
          signal: outerSignal
        });
        const aligned = await dependencies.align("futures", scanned, outerSignal);
        return normalizeRankedScannerResponse(aligned, normalizedSha, dependencies);
      };
    },
    paperCandidateForCard({ card, market }) {
      const value = scannerCard(card);
      if (!value || market !== "CRYPTO_FUTURES") return null;
      return dependencies.resolveCanonicalIdentity({
        card: value,
        market,
        researchCodeSha: normalizedSha
      }).paperCandidate;
    },
    learningSnapshotForCard({ card, market }) {
      const value = scannerCard(card);
      if (!value || market !== "CRYPTO_FUTURES") return null;
      const candidate = dependencies.resolveCanonicalIdentity({
        card: value,
        market,
        researchCodeSha: normalizedSha
      }).paperCandidate;
      const dataTimestamp = dependencies.latestEvidenceTimestamp(value);
      if (!candidate || !dataTimestamp) return null;
      const decision2 = dependencies.prepareObservation({
        card: value,
        strategyIdentity: {
          strategyId: candidate.signal.strategyIdentity.strategyId,
          strategyVersion: candidate.signal.strategyIdentity.strategyVersion,
          parameterHash: candidate.signal.strategyIdentity.parameterHash,
          researchCodeSha: candidate.signal.strategyIdentity.researchCodeSha,
          market: candidate.signal.market,
          symbol: candidate.signal.symbol,
          timeframe: candidate.signal.timeframe,
          horizon: candidate.signal.horizon,
          direction: candidate.signal.direction
        },
        dataTimestamp,
        dataMaxAgeMs: FORWARD_OBSERVER_DATA_MAX_AGE_MS,
        publicDataOnly: true
      });
      return decision2.status === "OBSERVATION_READY" ? decision2.observation?.snapshot ?? null : null;
    },
    ...callbackOwnerSources,
    async publicEvidenceForCard({ card, market, signal }) {
      const value = scannerCard(card);
      if (!value || market !== "CRYPTO_FUTURES") return null;
      const requests = dependencies.buildPublicRequests(value.symbol);
      const requestSignal = abortSignal(signal);
      const entries = await Promise.all(Object.entries(requests).map(async ([key, request]) => [
        key,
        await dependencies.fetchPublicJson(publicUrl(request), { provider: "bitget", signal: requestSignal })
      ]));
      const payloads = Object.fromEntries(entries);
      const nowMs = dependencies.now();
      if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("AUTHORITATIVE_PUBLIC_EVIDENCE_CLOCK_INVALID");
      return dependencies.buildPublicEvidence({
        symbol: value.symbol,
        nowMs,
        ticker: payloads.ticker,
        funding: payloads.funding,
        openInterest: payloads.openInterest,
        contract: payloads.contract,
        candles5m: payloads.symbol5m,
        candles1h: payloads.symbol1h,
        benchmarkBtc1h: payloads.benchmarkBtc1h,
        benchmarkBtc1d: payloads.benchmarkBtc1d
      });
    }
  });
}
var AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_VERSION,
  ownersConnected: Object.freeze([
    "scanBatchForMarket",
    "paperCandidateForCard",
    "learningSnapshotForCard",
    "paperStateForCard",
    "contractRulesForCard",
    "publicEvidenceForCard",
    "executionObservationForCard",
    "supplementalCostEvidenceForCard"
  ]),
  callbackContractsConnected: Object.freeze([
    "scanBatchForMarket",
    "paperCandidateForCard",
    "learningSnapshotForCard",
    "paperStateForCard",
    "contractRulesForCard",
    "publicEvidenceForCard",
    "executionObservationForCard",
    "supplementalCostEvidenceForCard"
  ]),
  ownerMissingCallbacks: Object.freeze([]),
  ownerMissingCount: 0,
  ownerDataReadiness: AUTHORITATIVE_PAPER_CALLBACK_OWNERS_SAFETY.dataReadiness,
  executionAuthority: "NONE",
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false
});

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
  AUTHORITATIVE_PAPER_BLOCKED_DATA_SOURCE_CONTRACT_VERSION,
  AUTHORITATIVE_PAPER_CALLBACK_OWNERS_SAFETY,
  AUTHORITATIVE_PAPER_CALLBACK_OWNERS_VERSION,
  AUTHORITATIVE_PAPER_CALLBACK_OWNER_CONTRACT_VERSION,
  AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_SAFETY,
  AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_VERSION,
  AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_SAFETY,
  PAPER_SIMULATED_EXECUTION_EVIDENCE_SAFETY,
  PAPER_SIMULATED_EXECUTION_EVIDENCE_VERSION,
  PAPER_TRADING_STATE_SNAPSHOT_VERSION,
  SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION,
  buildAuthoritativePaperExecutionObservation,
  buildAuthoritativeSizedContractRules,
  buildAuthoritativeSupplementalCostEvidence,
  buildPaperSimulatedExecutionEvidence,
  createAuthoritativePaperEvidenceSourceWiring,
  createImmutablePaperTradingStateSnapshot,
  createScannerCryptoFuturesPaperAdmissionEvidenceProducer,
  paperStateFromAuthoritativeSnapshot,
  validateImmutablePaperTradingStateSnapshot
};
