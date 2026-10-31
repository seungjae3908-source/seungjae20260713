// C-9: 하드코딩 toFixed(6) 제거, Bitget 계약 정보 기반 동적 정밀도
export function calculateGridLevels({ lowerPrice, upperPrice, gridCount, mode = 'arithmetic', pricePlace = 2, priceEndStep = 0 }) {
  if (lowerPrice >= upperPrice) throw new Error('INVALID_PRICE_RANGE');
  if (gridCount < 2) throw new Error('GRID_COUNT_TOO_SMALL');
  const factor = Math.pow(10, pricePlace);
  const round = (p) => Math.round(p * factor) / factor;
  const levels = [];
  if (mode === 'arithmetic') {
    const step = (upperPrice - lowerPrice) / gridCount;
    for (let i = 0; i <= gridCount; i++) levels.push(round(lowerPrice + step * i));
  } else if (mode === 'geometric') {
    const ratio = Math.pow(upperPrice / lowerPrice, 1 / gridCount);
    for (let i = 0; i <= gridCount; i++) levels.push(round(lowerPrice * Math.pow(ratio, i)));
  } else throw new Error('UNKNOWN_GRID_MODE');
  if (priceEndStep > 0) {
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] - levels[i - 1] < priceEndStep - 1e-9) {
        throw new Error(`PRICE_STEP_TOO_SMALL: ${(levels[i] - levels[i-1]).toFixed(8)} < ${priceEndStep}`);
      }
    }
  }
  return levels;
}

export function calculateGridQuantity({ totalInvestmentUsdt, gridCount, currentPrice, leverage = 1, volumePlace = 4, minTradeNum = 0 }) {
  const perGrid = totalInvestmentUsdt / gridCount;
  const rawSize = (perGrid * leverage) / currentPrice;
  const factor = Math.pow(10, volumePlace);
  const rounded = Math.floor(rawSize * factor) / factor;
  if (rounded < minTradeNum) throw new Error(`QUANTITY_BELOW_MIN: ${rounded} < ${minTradeNum}`);
  if (rounded <= 0) throw new Error('QUANTITY_ZERO');
  return rounded;
}

export function calculateDynamicBounds({ currentPrice, atr, multiplier = 3, pricePlace = 2 }) {
  const range = atr * multiplier;
  const factor = Math.pow(10, pricePlace);
  const round = (p) => Math.round(p * factor) / factor;
  return { lowerPrice: round(currentPrice - range), upperPrice: round(currentPrice + range) };
}

// C-1: 수수료 계산
export function calculateFee({ price, quantity, feeRate = 0.0006 }) {
  return price * quantity * feeRate;
}
