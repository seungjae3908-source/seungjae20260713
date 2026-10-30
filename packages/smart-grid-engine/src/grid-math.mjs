// Smart Grid Calculation Engine (순수 수학 로직, 주문 기능 없음)
export function calculateGridLevels({ lowerPrice, upperPrice, gridCount, mode = 'arithmetic' }) {
  if (lowerPrice >= upperPrice) throw new Error('INVALID_PRICE_RANGE');
  const levels = [];
  
  if (mode === 'arithmetic') {
    const step = (upperPrice - lowerPrice) / gridCount;
    for (let i = 0; i <= gridCount; i++) {
      levels.push(Number((lowerPrice + step * i).toFixed(6)));
    }
  } else if (mode === 'geometric') {
    const ratio = Math.pow(upperPrice / lowerPrice, 1 / gridCount);
    for (let i = 0; i <= gridCount; i++) {
      levels.push(Number((lowerPrice * Math.pow(ratio, i)).toFixed(6)));
    }
  } else {
    throw new Error('UNKNOWN_GRID_MODE');
  }
  return levels;
}

export function calculateGridQuantity({ totalInvestmentUsdt, gridCount, currentPrice, leverage = 1 }) {
  // 각 그리드당 투자할 USDT 금액
  const investmentPerGrid = totalInvestmentUsdt / gridCount;
  // 레버리지를 고려한 실제 포지션 크기 (수량)
  const positionSize = (investmentPerGrid * leverage) / currentPrice;
  return Number(positionSize.toFixed(6));
}

export function calculateDynamicBounds({ currentPrice, atr, multiplier = 3 }) {
  // ATR(변동성)을 기반으로 상단/하단 범위 동적 계산
  const range = atr * multiplier;
  return {
    lowerPrice: Number((currentPrice - range).toFixed(6)),
    upperPrice: Number((currentPrice + range).toFixed(6)),
  };
}
