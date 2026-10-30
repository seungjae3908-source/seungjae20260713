// Risk Manager & AI Strategy Selector (안전 검사 및 전략 선택)
export function checkRiskLimits({ 
  totalInvestmentUsdt, 
  exchangeRateKrw, 
  maxLimitKrw = 500000,
  currentPrice,
  lowerPrice,
  leverage 
}) {
  const investmentKrw = totalInvestmentUsdt * exchangeRateKrw;
  
  // 1. 50만 원 한도 검사
  if (investmentKrw > maxLimitKrw) {
    return { approved: false, reason: `EXCEEDS_KRW_LIMIT: ${investmentKrw} KRW > ${maxLimitKrw} KRW` };
  }
  
  // 2. 청산 거리 계산 (롱 포지션 기준, 유지증거금률 0.5% 가정)
  const maintenanceMargin = 0.005;
  const liquidationPrice = currentPrice * (1 - (1 / leverage) + maintenanceMargin);
  
  if (liquidationPrice >= lowerPrice) {
    return { approved: false, reason: `LIQUIDATION_RISK: Liq Price ${liquidationPrice} is inside grid range` };
  }

  return { approved: true, liquidationPrice, investmentKrw };
}

export function selectStrategy({ rsi, macdHistogram, adx, currentPrice, atr }) {
  // AI가 아닌, 사전에 정의된 규칙 기반의 스마트 전략 선택 (추후 AI 모델로 교체 가능)
  let direction = 'NEUTRAL';
  let gridMode = 'arithmetic';
  
  // 추세 판단 (ADX > 25는 강한 추세)
  if (adx > 25) {
    direction = rsi > 50 ? 'LONG' : 'SHORT';
    gridMode = 'geometric'; // 추세장에서는 기하 그리드가 유리
  } else {
    direction = 'NEUTRAL'; // 횡보장
    gridMode = 'arithmetic';
  }
  
  return {
    direction,
    gridMode,
    confidence: adx > 25 ? 'HIGH' : 'MEDIUM',
    reason: `ADX: ${adx}, RSI: ${rsi} 기반 ${direction} 전략 선택`
  };
}
