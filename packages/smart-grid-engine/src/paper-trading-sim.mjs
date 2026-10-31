import { calculateGridLevels, calculateGridQuantity } from './grid-math.mjs';

export function simulateGridTrading({ currentPrice, lowerPrice, upperPrice, gridCount, mode, investmentUsdt, leverage }) {
  const levels = calculateGridLevels({ lowerPrice, upperPrice, gridCount, mode });
  const quantity = calculateGridQuantity({ totalInvestmentUsdt: investmentUsdt, gridCount, currentPrice, leverage });

  console.log(`\n[시뮬레이션 시작] 현재가: ${currentPrice}, 그리드 수량: ${quantity}`);

  let activeOrders = [];
  let completedTrades = 0;
  let totalProfitUsdt = 0;

  for (const level of levels) {
    if (level < currentPrice) activeOrders.push({ type: 'BUY', price: level, status: 'PENDING' });
    else if (level > currentPrice) activeOrders.push({ type: 'SELL', price: level, status: 'PENDING' });
  }

  // [수정됨] 현재가 기준 ±5% 변동하는 현실적인 가격 경로 생성
  const simulatedPricePath = [
    currentPrice,
    currentPrice * 0.98, // 2% 하락 (매수 체결)
    currentPrice * 0.95, // 5% 하락 (추가 매수 체결)
    currentPrice * 0.97, // 3% 하락 (반등 시작)
    currentPrice * 1.01, // 1% 상승 (매도 체결)
    currentPrice * 1.03, // 3% 상승 (추가 매도 체결)
    currentPrice * 1.05, // 5% 상승 (상단 매도 체결)
  ];

  for (const price of simulatedPricePath) {
    for (const order of activeOrders) {
      if (order.status !== 'PENDING') continue;

      if (order.type === 'BUY' && price <= order.price) {
        order.status = 'FILLED';
        totalProfitUsdt -= (order.price * quantity);
        const idx = levels.indexOf(order.price);
        if (idx + 1 < levels.length) {
          activeOrders.push({ type: 'SELL', price: levels[idx + 1], status: 'PENDING' });
        }
        console.log(`[체결] 매수 ${order.price.toFixed(2)} (가상 가격: ${price.toFixed(2)})`);
      } else if (order.type === 'SELL' && price >= order.price) {
        order.status = 'FILLED';
        totalProfitUsdt += (order.price * quantity);
        completedTrades++;
        const idx = levels.indexOf(order.price);
        if (idx - 1 >= 0) {
          activeOrders.push({ type: 'BUY', price: levels[idx - 1], status: 'PENDING' });
        }
        console.log(`[체결] 매도 ${order.price.toFixed(2)} (가상 가격: ${price.toFixed(2)})`);
      }
    }
  }

  return {
    completedTrades,
    totalProfitUsdt,
    activeOrdersCount: activeOrders.filter((o) => o.status === 'PENDING').length,
  };
}
